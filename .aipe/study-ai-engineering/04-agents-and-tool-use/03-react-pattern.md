# ReAct — Thought → Action → Observation

*Industry standard (the ReAct paper). buffr's `runAgentLoop` is a minimal bounded ReAct executor; the reasoning trace is captured in `agents.messages`.*

## Zoom out, then zoom in

ReAct isn't a separate machine bolted onto buffr — it *is* the agent loop you already met in `01-agents-vs-chains.md`, viewed through a different lens. That file asked "who decides control?" This one asks "what's the *shape* of one iteration?" and the answer is the ReAct triple: the model reasons in text (Thought), maybe emits a tool-call (Action), the tool result comes back as the next message (Observation), repeat.

```
  Zoom out — where ReAct's three beats live in buffr

  ┌─ Session ───────────────────────────────────────────────────┐
  │  src/session.ts — persist → agent.answer → flush → remember  │  ← CODE decides
  └───────────────────────────┬─────────────────────────────────┘
                              │  agent.answer(question)
  ┌─ Agent loop (aptkit) ─────▼─────────────────────────────────┐
  │  ★ runAgentLoop — one turn = Thought · Action · Observation ★│  ← we are here
  │    Thought      = response text                              │
  │    Action       = tool_use block in the response            │
  │    Observation  = tool_result fed back as the next message   │
  └───────────────────────────┬─────────────────────────────────┘
                              │  callTool(name, args)
  ┌─ Tool ────────────────────▼─────────────────────────────────┐
  │  search_knowledge_base — produces the Observation            │  ← TOOL runs
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the name "ReAct" is "Reason + Act" — the insight from the original paper is that letting a model *interleave* reasoning and tool use beats doing all reasoning first then all acting. buffr does exactly this, bounded. And here's the buffr-specific kicker worth caring about: because the trace sink persists every `step` (Thought) and `tool_call_start` (Action) and `tool_call_end` (Observation) into `agents.messages`, **buffr's database row sequence IS a readable ReAct trace.** You can replay the model's reasoning after the fact.

## Structure pass

**Layers:** the conversation (the growing `messages` array) → one ReAct turn (Thought/Action/Observation) → the model + tool that produce each beat.

**Axis — "what produces this beat, and where does it get stored?" — traced across the triple:**

```
  trace "who produces each beat" across one ReAct turn

  ┌─ Thought ───────┐  ┌─ Action ──────────┐  ┌─ Observation ─────┐
  │ MODEL writes    │→ │ MODEL emits        │→ │ TOOL produces      │
  │ free text       │  │ tool_use block     │  │ result            │
  │ → 'step' event  │  │ → 'tool_call_start'│  │ → 'tool_call_end' │
  │ → messages row  │  │ → messages row     │  │ → messages row    │
  └─────────────────┘  └────────────────────┘  └───────────────────┘
       (assistant)          (model's call)          (tool's answer)

  the PRODUCER flips: model · model · tool — and each beat lands as a row
```

**The seam:** between Action and Observation, control flips from model to tool and back. The model emits a `tool_use`; the loop runs the tool; the result re-enters the conversation as a `user`-role message containing a `tool_result` block (run-agent-loop.ts:181-189). That re-entry is the load-bearing joint — it's how the model "sees" what its action did and reasons about it next turn.

## How it works

### Move 1 — the mental model

You know how a debugger REPL works? You evaluate an expression (your "action"), it prints a result (your "observation"), you read it, think, and type the next expression. ReAct is the model running its own REPL: it "types" a tool-call, reads the result that comes back, and decides the next move — except the loop, not a human, drives it, and a hard turn budget stops it.

```
  the ReAct loop kernel — one beat feeds the next

  ┌──────────┐  reason in text   ┌──────────┐
  │ Thought  │ ────────────────► │ Action?  │
  └──────────┘                   └────┬─────┘
       ▲                    tool_use? │ yes
       │                              ▼
       │                       run search_kb
       │  feed result back     ┌────────────┐
       └────────────────────── │ Observation│
                               └────────────┘
                  no tool_use │
                              ▼
                         final answer (Thought with no Action)

  the loop ends when a Thought carries NO Action
```

The part people forget: **the termination signal is "a Thought with no Action."** The model doesn't say "I'm done" — it just answers in plain text instead of emitting a tool-call, and the loop reads the *absence* of a tool_use as "stop" (run-agent-loop.ts:131-135).

### Move 2 — the step-by-step walkthrough

This loop is reached every time the TUI calls `agent.answer(question)` — every question runs at least one ReAct turn (the first Thought), and a question that needs retrieval runs at least two (Thought → Action → Observation → Thought-that-answers).

**Step 1 — the conversation starts as a one-element array, and the model produces the first Thought.** The loop seeds `messages` with the user's question, then calls `model.complete`. Whatever text comes back is the Thought.

```ts
// aptkit packages/runtime/src/run-agent-loop.ts:94, 103-129 (condensed)
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];
// ...
const response = await model.complete({ system, messages, tools, maxTokens, signal });
// ...
messages.push({ role: 'assistant', content: response.content });   // ← the Thought joins the conversation
const text = textFromContent(response.content);
if (text) {
  trace?.emit({ type: 'step', capabilityId, role: 'assistant', content: text, timestamp: timestamp() });
}                                                                  // ← Thought → 'step' event → messages row
```

The Thought is appended to `messages` *and* emitted as a `step` trace event. So the reasoning is in two places: the live conversation (so the next turn sees it) and the durable trace (so you can read it later). That dual-write is what makes buffr's trace a ReAct transcript.

```
  Step 1 — the first Thought, two destinations

  model.complete ──► response.content
                       │
            ┌──────────┴───────────┐
            ▼                      ▼
      messages.push          trace.emit('step')
      (live conversation)    (durable, → agents.messages row)
```

**Step 2 — the Action: a `tool_use` block extracted from the response.** ReAct's "Act" is the model choosing to call a tool. The loop scans the response content for `tool_use` blocks. None → the Thought was the final answer; stop. One or more → that's the Action.

```ts
// aptkit packages/runtime/src/run-agent-loop.ts:131-135
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) {
  finalText = text;          // ← a Thought with NO Action = done
  break;
}
```

Remember from `02-tool-calling.md`: on Gemma there's no native `tool_use` block — the provider *parses* one out of the model's JSON-shaped text. So the "Action" here is reconstructed from free text. ReAct doesn't care how the Action is represented; it only needs "is there an action or not."

```
  Step 2 — Action present or absent

  response.content ──► toolUsesFromContent()
                          │
              ┌───────────┴────────────┐
              ▼                        ▼
        [] (no tool_use)          [tool_use, ...]
        → finalText, break        → run the Action(s)
        (this Thought answered)   (Step 3)
```

**Step 3 — run the Action, capture the Observation, feed it back.** For each tool_use, the loop emits `tool_call_start` (the Action, with args), runs `callTool`, emits `tool_call_end` (the Observation, with result/error/duration), then pushes the result into `messages` as a fresh message.

```ts
// aptkit packages/runtime/src/run-agent-loop.ts:147-189 (condensed)
trace?.emit({ type: 'tool_call_start', capabilityId, toolName: toolUse.name, args: toolUse.input, ... });
try {
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  resultContent = truncate(JSON.stringify(result));
} catch (error) {
  isError = true;
  resultContent = truncate(JSON.stringify({ error: message }));   // ← even a failure becomes an Observation
}
trace?.emit({ type: 'tool_call_end', capabilityId, toolName: toolUse.name, result, error, durationMs, ... });
toolResults.push({ type: 'tool_result', toolUseId: toolUse.id, content: resultContent, ...(isError && { isError: true }) });
// after the loop over tool uses:
messages.push({ role: 'user', content: toolResults });            // ← Observation re-enters as the next message
```

That last line is the heart of ReAct. The Observation comes back as a `role: 'user'` message holding `tool_result` blocks — from the model's point of view, the environment "spoke" the tool output back to it. Next turn, `model.complete` sees the question, its own Thought, its Action, and now the Observation, and reasons forward. **Note the `catch`: even a thrown error becomes an Observation** (`{ error: message }` with `isError: true`) — the model gets to see its action failed and react. That's error-recovery built into the ReAct substrate (`06-error-recovery.md`).

```
  Layers-and-hops — one Action/Observation round trip

  ┌─ Loop ───────────┐ hop1: callTool(name,args)  ┌─ Tool registry ─┐
  │ for each tool_use │ ──────────────────────────►│ run handler     │
  │  emit start       │ hop3: {result | error} ◄── └──────┬──────────┘
  │  emit end         │                            hop2 │ embed+ANN
  │  push tool_result │                                 ▼
  └────────┬──────────┘                          ┌─ Pipeline ───────┐
           │ hop4: messages.push(role:user)      │ search_kb        │
           ▼                                      └──────────────────┘
   next turn: model sees the Observation and reasons again
```

**Step 4 — repeat until a Thought has no Action, or the budget forces a stop.** The `for turn` loop runs the triple again. Each pass grows `messages` by a Thought (assistant) and possibly an Observation (user). It ends one of two ways: the model emits a Thought with no Action (natural stop), or the budget hits and `forceFinal` strips the tools so the next Thought *can't* carry an Action (`01-agents-vs-chains.md`).

```
  the growing conversation = the ReAct transcript

  [user: question]
  [assistant: Thought 1]          ← turn 0 Thought
  [user: tool_result (Obs 1)]     ← turn 0 Observation
  [assistant: Thought 2 = answer] ← turn 1 Thought, no Action → break
```

### Move 2 variant — the load-bearing skeleton

The irreducible ReAct kernel: **append Thought to the conversation → detect Action (tool_use present?) → if Action, run it and append the Observation as a message → loop → stop when a Thought carries no Action.**

- Drop **"append the Observation back into `messages`"** → the model can't see what its action did; it re-reasons with no new information and either loops or hallucinates the result. This is the part that makes it ReAct and not "call a tool once."
- Drop **"stop when no Action"** → the loop can't recognize the answer; it runs forever or until the budget.
- Drop the **trace emits** → ReAct still *works*, but you lose the transcript. (This is hardening, not kernel — buffr adds it on top so the reasoning is replayable.)

Optional hardening layered on: the 16k-char truncation of tool results (run-agent-loop.ts:52-57, keeps one giant Observation from blowing the context), the `forceFinal` budget, the `recoveryPrompt`/`runRecoveryTurn` path for structured outputs (run-agent-loop.ts:204-228, which buffr's `RagQueryAgent` doesn't use).

### Move 3 — the principle

ReAct's whole bet is that a model reasons *better* when it can act between thoughts and see the consequences — versus planning everything blind up front. The mechanism that delivers that is dead simple: **feed each Observation back into the conversation so the next Thought is informed by it.** Everything else (the budget, the trace, the parsing) is plumbing around that one move. If you can name "the Observation re-enters as a message," you understand ReAct.

## Primary diagram

```
  buffr's bounded ReAct loop — one full answer()

  question ─► messages = [user: question]
                │
  ┌─ for turn 0..5 ──────────────────────────────────────────────┐
  │  forceFinal = (turn==5) || toolCalls>=4                        │
  │                                                                │
  │  ── THOUGHT ──────────────────────────────────────────────    │
  │  response = model.complete(system, messages, tools?)          │
  │  messages.push(assistant: response)                           │
  │  trace.emit('step')               ── Thought → messages row    │
  │                                                                │
  │  ── ACTION? ──────────────────────────────────────────────    │
  │  toolUses = tool_use blocks in response                       │
  │  if none → finalText = text ; break   (Thought = answer)      │
  │  else:                                                          │
  │    trace.emit('tool_call_start')   ── Action → messages row    │
  │                                                                │
  │  ── OBSERVATION ──────────────────────────────────────────    │
  │    result = callTool(name, args)  (error → {error}, isError)  │
  │    trace.emit('tool_call_end')     ── Obs → messages row       │
  │    messages.push(user: tool_result)  ◄── fed back to model     │
  └────────────────────────────────────────────────────────────────┘
                │
                ▼
            finalText ─► (session: trace.flush → readable ReAct transcript in agents.messages)
```

## Elaborate

ReAct comes from Yao et al. (2022), "ReAct: Synergizing Reasoning and Acting in Language Models." The original framing had the model emit literal `Thought:` / `Action:` / `Observation:` strings in a single completion, parsed by regex. Modern tool-calling APIs formalized the "Action" as a structured `tool_use` block and the "Observation" as a `tool_result`, which is what aptkit's loop uses — Gemma just reconstructs those blocks from text because it has no native API (`02-tool-calling.md`). buffr is the smallest interesting ReAct instance: one tool, so each Action is "search or don't," and the reasoning rarely runs past two or three turns. The richer cousins — multi-tool ReAct, Plan-and-Execute, reflexion loops — live in `.aipe/study-agent-architecture/`. The thing buffr does that many ReAct demos don't: it *persists the whole transcript*, which is exactly the corpus you'd fine-tune on later (`../05-evals-and-observability/04-llm-observability.md`).

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Render a stored conversation as a ReAct transcript

- **Exercise ID:** REACT-1 (Case A — ReAct loop runs and is traced; reading it is the next step).
- **What to build:** a small CLI that reads one `agents.conversations` row's `messages` ordered by `created_at` and prints them as a `Thought: / Action: / Observation:` transcript, mapping `step`→Thought, `tool_call`→Action, `tool`→Observation.
- **Why it earns its place:** proves the trace IS a ReAct trace, and gives you a "here's my agent reasoning, step by step" artifact to show — the strongest possible evidence you understand the pattern, not just the term.
- **Files to touch:** new `src/cli/trace-cmd.ts`, reading from `agents.messages` via `src/db.ts`; reuse the role conventions in `src/supabase-trace-sink.ts:57-83`.
- **Done when:** one real question's conversation prints as an ordered Thought/Action/Observation transcript matching the order the model produced.
- **Estimated effort:** 1–4hr.

### Make the Thought visible live in the TUI

- **Exercise ID:** REACT-2 (Case A — surfacing the reasoning beat).
- **What to build:** stream or print the assistant `step` text (the Thought between Action and Observation) to the TUI so the user sees "searching for X…" reasoning, not just a spinner then an answer.
- **Why it earns its place:** demonstrates you understand which beat is the Thought and can wire it to a UI — turns the invisible loop into a visible one.
- **Files to touch:** `src/session.ts` (surface intermediate `step` events from the trace sink), the TUI render path; the trace sink already emits `step` per Thought.
- **Done when:** a multi-turn question shows its intermediate reasoning before the final answer lands.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: Is buffr a ReAct agent? Walk me through one turn.**
Answer: yes — `runAgentLoop` is a bounded ReAct executor. One turn is the triple: the model produces a Thought (free text), maybe an Action (a `tool_use` for `search_knowledge_base`), and if it acts, the loop runs the tool and feeds the result back as an Observation — a `role:user` message carrying a `tool_result` block. The next turn reasons over that Observation. It stops when a Thought carries no Action, or the budget forces a final synthesis turn.

```
  one turn:  Thought (text) ─► Action? (tool_use) ─► Observation (tool_result fed back) ─► next Thought
```

**Q: What's the one mechanism that makes it ReAct and not just "call a tool once"?**
Answer: **the Observation re-enters the conversation as a message** (`messages.push({role:'user', content: toolResults})`, run-agent-loop.ts:189), so the next Thought is informed by what the last Action did. That feedback is the whole pattern — and the part people forget. Without it the model can't react to its own actions. buffr also persists every beat (`step`/`tool_call_start`/`tool_call_end`) to `agents.messages`, so the row sequence is a replayable ReAct transcript.

```
  the anchor:  Observation → messages.push(role:user) → informs next Thought
```

## See also

- `01-agents-vs-chains.md` — the same loop, viewed as control flow and the budget.
- `02-tool-calling.md` — how the Action (`tool_use`) is reconstructed from Gemma's text.
- `06-error-recovery.md` — how a failed Action becomes an Observation the model can recover from.
- `../05-evals-and-observability/04-llm-observability.md` — the trace that makes the ReAct transcript durable.
- `.aipe/study-agent-architecture/` — richer ReAct variants (multi-tool, plan-execute, reflexion).
