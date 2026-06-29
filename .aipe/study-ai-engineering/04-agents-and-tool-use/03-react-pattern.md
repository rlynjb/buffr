# The ReAct Pattern — Gather, then Synthesize
### *Reason + Act as a loop, and the forced turn that ends it*
**Type label:** agent reasoning pattern (interleaved action/observation)

## Zoom out

ReAct is a *shape the loop takes*, not a layer of its own. So locate it inside the loop you already know.

```
The agent loop, and the shape ReAct gives it
┌──────────────────────────────────────────────────────────┐
│  RagQueryAgent.answer    sets budget + synthesis text       │
├──────────────────────────────────────────────────────────┤
│  ★ runAgentLoop          the loop — ReAct is its RHYTHM     │  ← this file
│     turn N:  act (tool)  → observe (result)                │
│     turn N+1: act again, OR synthesize (answer)            │
├──────────────────────────────────────────────────────────┤
│  search_knowledge_base   the "act" — retrieve chunks        │
└──────────────────────────────────────────────────────────┘
```

ReAct (★) isn't a function you can point to. It's the *rhythm* the loop produces: act, observe, act, observe, then answer. buffr's variant collapses to two beats — **gather** (act on the tool, observe results) then **synthesize** (answer over what was gathered) — and the transition between them is forced by code.

Conversational version. The classic ReAct pattern interleaves three things the model writes out loud: *Thought* ("I should search for X"), *Action* (the tool call), *Observation* (the result), repeating until the model decides it has enough and answers. You can think of it as a state machine you already know — `idle → fetching → resolved → render` — except the model drives the transitions. buffr runs this, with one honest caveat we'll hit head-on: `gemma2:9b` does not reliably write "Thought:" traces. The *prose reasoning* is mostly absent. What survives — and what actually matters — is the loop *structure*: gather, then a forced synthesize. The skeleton is ReAct even when the narration isn't.

## Structure pass

The axis: **who ends the reasoning — the model, or the code?** Classic ReAct lets the model decide it's done. buffr lets the model decide *up to a point*, then code forces the ending.

```
The "who ends it" axis
   MODEL ENDS                                        CODE ENDS
   (answers when ready)                              (budget forces it)
   ├─────────────────────────────────────────────────────────────┤
   classic ReAct                  buffr                  rigid chain
   thought/act/obs until done   gather, then FORCED synth   step→step→done
                                         ▲
                                         │
                                  forceFinal is the lever
```

The seam where the model's control ends and the code's control takes over is `forceFinal`. Up to that point, the model is in classic-ReAct mode: it may act again or answer. At `forceFinal`, the tools vanish and the model *must* synthesize. That's the gather→synthesize gate.

```
The two beats and the gate between them
  GATHER (model may loop)              GATE              SYNTHESIZE (forced)
  ┌──────────────────────────┐   forceFinal flips   ┌────────────────────┐
  │ act: search_knowledge_base│  ───────────────►   │ tools: undefined    │
  │ observe: chunks back      │  budget spent /     │ system += synthInstr│
  │ act again? (model decides)│  last turn          │ → MUST answer       │
  └──────────────────────────┘                      └────────────────────┘
```

## How it works

### Move 1 — the mental model

ReAct = the loop body, where "Action" is a tool call and "Observation" is the result you feed back. The reasoning isn't a separate phase; it's whatever the model does between reading the observation and emitting the next action.

```
One ReAct cycle in buffr
  [Reason]   model reads messages, decides            (implicit, often silent)
  [Act]      emits tool_use → search_knowledge_base    (the JSON call)
  [Observe]  tool_result pushed back into messages     (chunks as next input)
       │
       └── loop: enough? → answer (Reason→Synthesize) | not enough? → Act again
```

### Move 2 — step by step

#### Gather: the act/observe beat (`callTool` → `tool_result`)

Bridge from what you know: this is a render-fetch cycle. The component renders (model decides), fires a fetch (tool call), the response lands in state (observation pushed to `messages`), and the next render reads that new state. The model's "next render" sees the chunks it just retrieved.

```
Gather: action produces an observation, which becomes the next input
  model.complete(messages, tools)
     │ emits tool_use
     ▼
  callTool → search_knowledge_base → chunks
     │ JSON.stringify(result), truncate 16k
     ▼
  messages.push({ role: user, content: [tool_result] })   ← observation IS the next prompt
     │
     ▼  next turn: model sees the chunks, reasons over them
```

Real code, the act/observe portion of `runAgentLoop`, `aptkit packages/runtime/src/run-agent-loop.ts:139`:

```ts
for (const toolUse of toolUses) {
  trace?.emit({ type: 'tool_call_start', toolName: toolUse.name, args: toolUse.input, ... });
  try {
    const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
    resultContent = truncate(JSON.stringify(result));     // ← OBSERVATION, capped at 16k chars
  } catch (error) {
    isError = true;
    resultContent = truncate(JSON.stringify({ error: ... }));   // ← errors are observations too (see 06)
  }
  toolResults.push({ type: 'tool_result', toolUseId: toolUse.id, content: resultContent,
                     ...(isError ? { isError: true } : {}) });
}
messages.push({ role: 'user', content: toolResults });    // ← feed the observation back, loop again
```

The consequence of the observation being a `user` message: the model literally re-reads its own retrieved chunks as if the user handed them over. That's the Act→Observe→Reason handoff, made concrete by pushing onto an array.

#### The gate: `forceFinal` strips the tools

Bridge: a state machine guard. You've written `if (retries >= max) state = 'giveUp'`. `forceFinal` is exactly that guard, and "giveUp" here means "stop searching, answer now."

```
The gate: when to stop gathering
  forceFinal = (turn === maxTurns - 1)  OR  (toolCalls.length >= maxToolCalls)
     │ true
     ▼
  model.complete({
    system: system + synthesisInstruction,   ← tell it to answer
    tools: undefined,                          ← REMOVE the tools — can't act
  })
```

Real code, `aptkit packages/runtime/src/run-agent-loop.ts:101`:

```ts
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;       // ← THE GATE
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,                  // ← strip tools when forced
  maxTokens,
  signal,
});
```

The consequence is the whole reason this works on a weak model: a small model left to its own devices keeps searching, never deciding it has enough. `forceFinal` doesn't *ask* it to stop — it *removes the ability to act*. With `tools: undefined`, there are no schemas in the prompt and nothing to emit a call against. Synthesis is the only move left.

#### Synthesize: the forced final turn (`buildSynthesisInstruction`)

Bridge: a final-state reducer. The machine has gathered all its data; the last transition renders the result. Here the "render" is the model writing the answer, nudged by an instruction that forbids stalling.

```
Synthesize: the forced answer
  system + "You have NO more tool calls available. Now answer the question
            directly and concisely, citing the sources you retrieved.
            Do not say you need more queries."
     │  model.complete, tools: undefined
     ▼
  prose answer → no tool_use → finalText, BREAK
```

Real code, the instruction builder, `aptkit packages/runtime/src/run-agent-loop.ts:72`:

```ts
export function buildSynthesisInstruction(middle: string): string {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}
```

And how `RagQueryAgent` fills the middle, `aptkit packages/agents/rag-query/src/rag-query-agent.ts:77`:

```ts
synthesisInstruction: buildSynthesisInstruction(
  'Now answer the question directly and concisely, citing the sources you retrieved.',
),
```

The two clamps in that string are doing real work. "You have NO more tool calls available" is *true* (the tools are gone) and stating it stops the model from emitting a doomed call. "Do not say you need more queries" pre-empts the small-model failure of answering "I should search for more" *instead of* answering. Both are there because `gemma2:9b` will, unprompted, stall at exactly this moment.

### Move 2.5 — current vs future

```
Explicit reasoning traces (current ✗ / possible ✓)
  ✗ current:  model rarely writes "Thought: ..." — gemma narrates inconsistently
              the loop STRUCTURE carries ReAct; the prose doesn't
  ✓ possible: a scratchpad prompt + a parser that extracts Thought/Action
              → visible reasoning in the trace, gradeable in evals
```

Classic ReAct papers lean on the model narrating its reasoning, which lets you read and grade the chain of thought. buffr doesn't get that for free — `gemma2:9b` doesn't reliably emit "Thought:" lines, so the trace shows *actions and observations* but rarely the reasoning between them. The structure is ReAct; the narration is missing. If you wanted gradeable reasoning, you'd prompt for an explicit scratchpad and parse it — but that's added scaffolding, not present today.

### Move 3 — the principle

ReAct's power is the feedback loop — act, observe, *let the observation change the next decision*. Its danger on a weak model is non-termination — the model never decides it has enough. buffr keeps the power and kills the danger by making termination a *code* decision, not a model decision. The forced synthesis turn is the load-bearing part: it guarantees that every question, no matter how the gathering went, ends in an answer.

## Primary diagram

The full gather→synthesize arc for one question.

```
ReAct in buffr: gather, gate, synthesize
  question → messages = [user]
     │
  ┌─ GATHER (turns 0..k, model in control) ────────────────────┐
  │  Reason (implicit) → Act (search) → Observe (chunks back)    │
  │  push observation → loop                                     │
  │  model may act again, or it may answer early                 │
  └──────────────────────────────────────────────────────────────┘
     │  forceFinal = last turn OR toolCalls >= 4
     ▼  ░░░ THE GATE: tools stripped, synthesis instr added ░░░
  ┌─ SYNTHESIZE (forced, code in control) ─────────────────────┐
  │  "No more tool calls. Answer, cite, don't stall."           │
  │  model writes prose → no tool_use → BREAK                   │
  └──────────────────────────────────────────────────────────────┘
     │
     ▼  finalText (the answer)
```

## Elaborate

The honest reframe worth keeping: buffr's ReAct is really *bounded* ReAct, and the bound is what makes it shippable. Frontier-model ReAct can afford to trust the model to stop; the model is good at knowing when it's done. `gemma2:9b` is not, so buffr replaces "trust the model to stop" with "let the model stop early if it wants, but force it to stop at the budget." The early-exit path (model answers before the budget, `toolUses.length === 0 → break`) is the model deciding; the forced-exit path (`forceFinal`) is the code deciding. Both end in the same place: a `finalText`. The agent has two ways to finish and exactly zero ways to not finish.

Notice also that the observation is *truncated to 16k chars* before it re-enters the prompt. That's a context-budget defense — retrieval can return a lot, and dumping it all back would blow the window. It also means the model synthesizes over a *capped* view of what it retrieved. For buffr's `minTopK: 4` searches that's plenty, but it's a real boundary: the synthesis sees at most 16k chars of each observation.

## Project exercises

### Add an explicit reasoning scratchpad to the gather turns

- **Exercise ID:** [B4.5], Phase 4.
- **What to build:** Extend the system prompt to ask the model to prefix each turn with a short `Thought:` line before its action, and add a parser that pulls those lines into the trace as a `reasoning` event. Keep them out of the final answer.
- **Why it earns its place:** Right now the trace shows *what* the agent did (actions, observations) but not *why*. Surfacing the reasoning makes the loop debuggable and gives evals (`05-evals-and-observability/`) something to grade beyond the final answer. It also teaches you how fragile small-model narration is.
- **Files to touch:** `aptkit packages/agents/rag-query/src/rag-query-agent.ts` (system template), `aptkit packages/runtime/src/run-agent-loop.ts` (parse + emit a `reasoning` trace event), `buffr src/supabase-trace-sink.ts` (persist it).
- **Done when:** A multi-turn answer records at least one `reasoning` event per gather turn, the final answer is unchanged, and a turn where the model omits `Thought:` degrades gracefully (no crash, empty reasoning).
- **Estimated effort:** 2–4 hours.

### Make the synthesis instruction adaptive to whether anything was retrieved

- **Exercise ID:** [B4.6], Phase 4.
- **What to build:** Branch the synthesis instruction: if the gather phase returned zero usable chunks, instruct the model to say plainly that the knowledge base lacks the answer (matching `FALLBACK_ANSWER` intent) instead of citing nonexistent sources.
- **Why it earns its place:** Today the forced synthesis always says "cite the sources you retrieved" — even when nothing was retrieved, which pushes a weak model to fabricate citations. Making the instruction aware of empty retrieval closes a hallucination path at the exact moment the model is most pressured to produce *something*.
- **Files to touch:** `aptkit packages/agents/rag-query/src/rag-query-agent.ts`, `aptkit packages/runtime/src/run-agent-loop.ts` (expose whether any tool result was non-empty to the synthesis branch).
- **Done when:** A question with no matching corpus produces a plain "not found" answer rather than fabricated citations, verified by an eval case with an empty index.
- **Estimated effort:** 3–4 hours.

## Interview defense

**Q: "Does buffr implement ReAct? It doesn't print Thought/Action/Observation."**

It implements the ReAct *structure*, not the narration. The loop interleaves action (the `search_knowledge_base` call) and observation (the result pushed back into `messages`), and reasons over each observation before the next action. `gemma2:9b` just doesn't reliably write "Thought:" lines out loud — the prose reasoning is mostly silent, but the act/observe/reason cycle is exactly ReAct.

```
  Act (search) → Observe (chunks) → Reason (silent) → Act or Answer
```

*Anchor: the loop structure is the ReAct skeleton even when the model doesn't narrate it.*

**Q: "How does the agent decide to stop gathering and answer?"** — the part people forget.

Two ways, and the forced one is what people miss. The model can stop on its own by emitting prose with no tool call (`toolUses.length === 0 → break`). But if it doesn't, `forceFinal` (last turn, or `maxToolCalls` reached) takes over: it strips the tools (`tools: undefined`) and appends a synthesis instruction that says there are no more tool calls and not to ask for more. The model can't act, so it must synthesize. The load-bearing part is that the forced synthesis turn *removes* the ability to call a tool — it doesn't merely ask the model to stop.

```
  budget spent → forceFinal → tools removed + "no more queries" → MUST answer
```

*Anchor: termination is a code decision via forceFinal, not a model decision — that's what makes it work on a weak model.*

## See also

- **`01-agents-vs-chains.md`** — the load-bearing skeleton this file's gate lives inside.
- **`02-tool-calling.md`** — what the "Act" beat actually emits and parses (the emulated JSON path).
- **`04-tool-routing.md`** — why gather-vs-synthesize is the *real* routing decision in a one-tool agent.
- **`06-error-recovery.md`** — what happens when the "Observe" beat is an error instead of chunks.
