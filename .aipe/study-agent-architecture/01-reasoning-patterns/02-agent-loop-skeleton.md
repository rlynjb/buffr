# The Agent Loop Skeleton

*Industry names: **agent loop** / **the ReAct kernel** / **the control loop**. Type label: Industry standard (the kernel is universal; buffr's bounds are Project-specific). IMPLEMENTED in buffr.*

## Zoom out, then zoom in

This is the box at the dead center of buffr. Everything else in the repo exists to feed it
or record it. Here is where the kernel sits.

```
  buffr's stack — the kernel is the ★ box

  ┌─ Session (chain) — src/session.ts ─────────────────────────┐
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ RagQueryAgent — sets the bounds ─▼────────────────────────┐
  │   maxTurns:6 · maxToolCalls:4 · synthesisInstruction       │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ ★ runAgentLoop — THE KERNEL ★ ───▼────────────────────────┐
  │   for turn in 0..maxTurns:                                 │
  │     step → execute → accumulate → terminate                │
  │   run-agent-loop.ts:98-190                                 │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ GemmaModelProvider · search_knowledge_base ──▼────────────┐
  └────────────────────────────────────────────────────────────┘
```

This file isolates the four-part kernel and names each part by **what breaks if you delete
it**. The single most important thing to take away: termination is not one exit, it is
*two* — and the second one (the budget exit) is what makes this a shipped agent instead of
a demo. That is the load-bearing insight of the whole sub-section.

## Structure pass

Four parts, one axis: **failure** — what goes wrong if this part is missing?

```
  Axis = FAILURE · trace it across the four kernel parts, find the seam

  step       missing → no thinking at all              (no agent)
  execute    missing → model hallucinates tool results (ungrounded)
  accumulate missing → model forgets last turn          (amnesiac loop)
  ───────────────── ★ SEAM: the failure mode flips ★ ─────────────────
  terminate  missing → loop runs FOREVER                (never ships)
```

The first three parts fail *softly* — you get a worse answer. `terminate` fails *hard* —
you get no answer, ever, and a runaway token bill. That seam is why this file spends most
of its length on termination. The seam line is `run-agent-loop.ts:132` (where the success
exit lives) versus `:101-102` (where the budget exit lives).

## How it works

### Move 1 — mental model

The kernel is a `while` loop with four statements in its body, and two ways out. Bridge
from frontend: it is exactly a multi-step form's state machine — `idle → submitting →
validating → done` — except the *model* emits the next state, and there's a hard cap on how
many transitions you'll allow before forcing `done`.

```
  THE SHAPE — the four-part kernel as a loop

         ┌──────────────────────────────────────────────┐
         │                                              │
         ▼                                              │
   ┌──────────┐   ┌──────────┐   ┌────────────┐         │
   │ 1 STEP   │──▶│ 2 EXECUTE│──▶│3 ACCUMULATE│─────────┘
   │ ask model│   │ run tool │   │ push result│   (loop back)
   └──────────┘   └────┬─────┘   └────────────┘
        │              │
        │ no tool use  │ (4 TERMINATE checked at top of every pass)
        ▼              ▼
   ┌──────────────────────────┐
   │ 4 TERMINATE → finalText  │   two exits: success OR budget
   └──────────────────────────┘
```

### STEP — ask the model what to do (delete it → no agent)

`step` is one call to the model. It hands the model the conversation so far plus the tool
schemas, and gets back content blocks — either a tool-use intent or final text. Without it,
there is no reasoning; the loop is empty.

```ts
// run-agent-loop.ts:103-109 — STEP. One model call per turn.
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,                              // the whole transcript so far (accumulate feeds this)
  tools: forceFinal ? undefined : toolSchemas,  // ← tools STRIPPED on the budget exit. Remember this.
  maxTokens,
  signal,
});
```

Annotation: the `forceFinal ? undefined` on the tools line is the budget exit's teeth —
we'll come back to it under TERMINATE. For a normal turn, the model sees the tools and may
emit a call.

### EXECUTE — run the tool the model asked for (delete it → hallucinated results)

The model only emits *intent* — a JSON object saying "call search_knowledge_base with these
args." The harness, not the model, actually runs it via `tools.callTool` and feeds the real
result back. Without execute, the model would invent search results.

```ts
// run-agent-loop.ts:139-189 — EXECUTE (condensed). Harness runs the tool, not the model.
for (const toolUse of toolUses) {
  try {
    const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
    toolCall.result = result;
    resultContent = truncate(JSON.stringify(result));   // real data, capped at 16k chars
  } catch (error) {
    resultContent = truncate(JSON.stringify({ error: ... }));  // errors feed back too — the model can recover
  }
  toolResults.push({ type: 'tool_result', toolUseId: toolUse.id, content: resultContent });
}
messages.push({ role: 'user', content: toolResults });   // ← result re-enters as a USER message (this is ACCUMULATE)
```

```
  STEP emits intent · EXECUTE runs it · result loops back

  model ──{"tool":"search_knowledge_base","arguments":{...}}──▶ STEP captures intent
                                                                   │
   tools.callTool(name, args)  ◀────────────────────────────────── EXECUTE
        │ real pgvector hit
        ▼
   {role:'user', content:[tool_result]}  ──────▶ appended to messages (ACCUMULATE)
```

Annotation: note the result re-enters as a `role:'user'` message at line 189 — the model
sees its own tool output as if the user handed it back. That's the Observation half of
ReAct. The intent/execute split is also the security boundary: the model can *ask* but only
the harness can *act*, and it can only act through `search_knowledge_base` (see
`07-routing.md` and the capability-scoping note below).

### ACCUMULATE — keep the transcript growing (delete it → amnesiac loop)

Every turn appends to one shared `messages` array: the assistant's content, then the tool
results. Next turn's `step` reads that array. Without accumulate, each turn would start
blind and the model would re-search forever, never seeing what it already found.

```ts
// run-agent-loop.ts:94, 124, 189 — ACCUMULATE. One growing array, three append sites.
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];  // :94  seed
...
messages.push({ role: 'assistant', content: response.content });            // :124 what the model said
...
messages.push({ role: 'user', content: toolResults });                      // :189 what the tools returned
```

Bridge from frontend: this is `useState` for the conversation — but append-only. Each turn
is a `setMessages(prev => [...prev, newTurn])`. The loop's "memory" within a single
`answer()` call is just this array growing. (Cross-session memory is a different mechanism —
the vector store — covered in Section D.)

### TERMINATE — the TWO exits (delete it → the loop runs forever)

This is the load-bearing part. There are **two** ways the loop ends, and they answer
different failure modes.

**Exit 1 — the success exit.** The model emits text and *no* tool use. It decided it's
done. The loop breaks and returns that text.

```ts
// run-agent-loop.ts:131-135 — SUCCESS EXIT. Model chose to answer.
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) {     // no tool intent → the model is answering
  finalText = text;
  break;                          // clean exit, the model decided it had enough
}
```

**Exit 2 — the budget exit (the one that matters).** A model on a local 9B will happily say
"let me search once more" forever. The success exit alone would never fire on a stubborn
model. So the loop *forces* an exit when the budget is spent: it strips the tools and
prepends a "you have NO more tool calls" instruction, leaving the model no option but to
synthesize.

```ts
// run-agent-loop.ts:101-109 — BUDGET EXIT. The loop forces synthesis.
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;  // 4 searches spent?
const forceFinal = turn === maxTurns - 1 || budgetSpent;                             // last turn OR budget gone
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  tools: forceFinal ? undefined : toolSchemas,   // ← NO tools offered. The model CANNOT search now.
  ...
});
```

```ts
// run-agent-loop.ts:72-74 — the synthesis instruction the budget exit prepends
export function buildSynthesisInstruction(middle: string): string {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}
// RagQueryAgent fills <middle> = "Now answer the question directly and concisely,
// citing the sources you retrieved."  (rag-query-agent.ts:77-79)
```

```
  TWO exits — different failure each one answers

  ┌─ top of every turn ─────────────────────────────────────────┐
  │ budgetSpent = toolCalls.length >= 4        (:101)           │
  │ forceFinal  = turn == maxTurns-1 OR budgetSpent  (:102)     │
  └───────────┬───────────────────────────────┬─────────────────┘
              │ forceFinal? strip tools (:106) │ normal turn: offer tools
              ▼                                ▼
   ┌───────────────────────┐        ┌────────────────────────┐
   │ model MUST answer      │        │ model emits tool_use?  │
   │ → finalText            │        │   yes → execute, loop  │
   │  ═ BUDGET EXIT ═       │        │   no  → finalText      │
   │  (answers: runaway)    │        │        ═ SUCCESS EXIT ═│
   └───────────────────────┘        └────────────────────────┘
```

The budget exit answers the runaway-loop failure; the success exit answers the
normal-completion case. **A demo agent has only the success exit and hangs on a stubborn
model. A shipped agent has the budget exit.** buffr sets the bounds in
`rag-query-agent.ts:75-76` — `maxTurns:6, maxToolCalls:4` — which means at most four
searches, and on turn 5 (or as soon as the fourth search returns) the tools vanish and the
model is made to answer.

There's a third backstop below the loop: if `finalText` comes back empty, `answer()`
returns `FALLBACK_ANSWER` (`rag-query-agent.ts:31,82`) so the user always gets a string.

### Move 3 — the principle

**An agent loop is a bounded `while` with two exits, and the bound is the engineering.** The
model supplies the cleverness; the harness supplies the guarantee that it *stops*. Name the
four parts by their failure mode and you can audit any agent framework in thirty seconds:
where's step, where's execute, where's accumulate, and — the one juniors miss — where is the
*budget* exit, not just the success exit?

## Primary diagram

Full recap: the kernel, both exits, the bounds, anchored to lines.

```
  runAgentLoop — the complete kernel (run-agent-loop.ts:98-190)

  for turn in 0 .. maxTurns(=6):
    ┌─ TERMINATE check (top) ────────────────────────────────────┐
    │ budgetSpent = toolCalls >= maxToolCalls(=4)         :101    │
    │ forceFinal  = turn==maxTurns-1 OR budgetSpent        :102    │
    └───────────────┬────────────────────────────────────────────┘
    ┌─ 1 STEP ──────▼─────────────────────────────────────────────┐
    │ model.complete(messages, tools: forceFinal?none:schemas)   │
    │                                                  :103-109    │
    └───────────────┬────────────────────────────────────────────┘
                    │ tool_use? ──no──▶ finalText = text  ═SUCCESS═ :132-135
                    │ yes
    ┌─ 2 EXECUTE ───▼─────────────────────────────────────────────┐
    │ tools.callTool(name, args) → real result          :139-189   │
    └───────────────┬────────────────────────────────────────────┘
    ┌─ 3 ACCUMULATE ▼─────────────────────────────────────────────┐
    │ messages.push(assistant, then tool_result)    :124,:189      │
    └───────────────┬────────────────────────────────────────────┘
                    └────── loop back ──────┘
  ────────────────────────────────────────────────────────────────
  forceFinal path: tools stripped + synthesisInstruction  ═BUDGET═ :101-109,:72-74
  empty finalText → FALLBACK_ANSWER                                rag-query:31,82
```

The kernel is small on purpose — four statements and two exits. Memorize the two exits and
you understand the most important thing about buffr.

## Elaborate

The four-part kernel is the distilled ReAct loop (Yao et al., 2022): Reason (step), Act
(execute), Observe (accumulate), repeat. Production frameworks (LangGraph, the OpenAI
Agents SDK, Anthropic's loop) all reduce to this plus a bound. The thing that varies between
frameworks is *how forced termination is done* — some count turns, some count tokens, some
let a supervisor kill the run. buffr counts both turns *and* tool calls and additionally
removes the tools on the final pass, which is stronger than counting alone: even if the
model wanted to call a tool it physically cannot, because the schemas aren't offered.

The emulated tool-calling path (`gemma-provider.ts:133-165` renders tools as JSON into the
system text, `:168-182` parses the model's JSON back into a tool-use block) is why "strip
the tools" works so cleanly: with no tools in the system text, there is simply no tool
contract for the model to fulfill.

Read next: `03-react.md` — now that you have the kernel, ReAct is just *the naming of the
step's two halves* (reason then act), plus buffr's choice to run plain ReAct with these
measured bounds.

## Interview defense

**Q: "How does your agent loop avoid running forever?"**

Model answer: "Two exits. The success exit is the model emitting text with no tool call —
it decided it's done (`run-agent-loop.ts:132-135`). But a 9B model will happily say 'one
more search' forever, so the success exit isn't enough. The budget exit
(`:101-109`) is the real guarantee: once `toolCalls.length >= maxToolCalls` — I set that to
4 — or it's the last of 6 turns, the loop sets `forceFinal`, *strips the tool schemas* so
the model literally can't call a tool, and prepends 'You have NO more tool calls available'
(`:72-74`). The model has no choice but to synthesize. That budget exit is what makes this a
shippable agent and not a demo."

```
  The defense in one picture

  success exit:  model says "done"        → ships (when model cooperates)
  budget exit:   harness strips tools,     → ships ALWAYS (the guarantee)
                 forces synthesis @ 4 calls
```

Anchor: *Four parts — step, execute, accumulate, terminate — and terminate is two exits;
the budget exit is the load-bearing one.*

## See also

- `01-chains-vs-agents.md` — why this loop is the "agent" half of the hybrid.
- `03-react.md` — ReAct as the naming of this kernel's step.
- `04-plan-and-execute.md`, `05-reflexion-self-critique.md`, `06-tree-of-thoughts.md` —
  patterns that wrap *additional* loops around this kernel (none implemented yet).
- `07-routing.md` — the model's per-turn tool-or-answer choice (the step's decision).
- `study-prompt-engineering` → the emulated-JSON tool-call prompt (`gemma-provider.ts`).
- `../00-overview.md` — finding #1 calls forced synthesis the load-bearing mechanic.
