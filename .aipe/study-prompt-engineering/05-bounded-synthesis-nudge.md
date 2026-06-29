# Bounded synthesis nudge

*Forced-synthesis turn / agent-loop termination prompt — Industry standard (the
"you're out of tool calls, now answer" final-turn instruction).*

## Zoom out, then zoom in

An agent loop's nightmare failure is the model that keeps saying "let me search one
more time" and never answers. The fix isn't smarter prompting — it's a hard budget
plus a prompt that *changes* on the last turn to forbid more tools and demand an
answer. buffr inherits exactly that from aptkit, and it's the most important
control mechanic in the loop.

```
  Zoom out — where the synthesis nudge sits

  ┌─ aptkit agent ───────────────────────────────────────────┐
  │  runAgentLoop: turn 0 … turn N                            │
  │    each turn: model may call a tool                       │
  │    ★ final turn: append synthesis nudge, drop tools ★     │ ← we are here
  └───────────────────────────┬──────────────────────────────┘
                             │ forced final answer
  ┌─ buffr session ─────────────▼────────────────────────────┐
  │  agent.answer(q) returns one string                       │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the concept is the **bounded synthesis nudge** — on the last allowed turn,
swap the system prompt to one that says *"no more tools, answer now, cite what you
found"* and stop offering tools at all. The question it answers: *what stops the
agent from looping forever?*

## Structure pass

One axis — **can the model call a tool on this turn?** — flips exactly once, and
that flip is the whole pattern.

```
  Axis: "are tools available this turn?"

  ┌─ turns 0 … N-1 (normal) ──┐  tools: YES (toolSchemas passed)
  │  model may search          │  system: BASE_SYSTEM as-is
  └─────────┬──────────────────┘
          ══╪══ seam: forceFinal flips  (budget spent OR last turn)
  ┌─ final turn (synthesis) ──▼┐ tools: NONE (toolSchemas = undefined)
  │  model MUST answer         │  system: BASE_SYSTEM + synthesis nudge
  └────────────────────────────┘
```

The seam is `forceFinal`. On one side the model is an agent that can act; on the
other it's a summarizer that must conclude. Two things flip together at that seam:
tools vanish *and* the system prompt gains a "no more queries" instruction. Removing
either alone leaves a hole — drop tools but keep the old prompt and the model asks
for tools it doesn't have; keep the nudge but leave tools available and it ignores
the nudge.

## How it works — load-bearing skeleton

Kernel, smallest form that's still the pattern:

```
  Kernel — bounded synthesis

  budget = maxTurns OR maxToolCalls
  each turn:
    forceFinal = (last turn) OR (tool budget spent)
    call model with:
      tools  = forceFinal ? NONE : toolSchemas        ← remove the option
      system = forceFinal ? system + NUDGE : system   ← demand the answer
    if model returned no tool call → that's the final answer, break
```

Named by what breaks when removed:

### Part 1 — the budget (remove it: infinite loop)

The loop runs at most `maxTurns` turns, and separately caps tool calls at
`maxToolCalls`. buffr's `RagQueryAgent` sets these tight: 6 turns, 4 tool calls.

```ts
// rag-query-agent.js:44-50
const { finalText } = await runAgentLoop({
  /* … */ maxTurns: 6, maxToolCalls: 4,
  synthesisInstruction: buildSynthesisInstruction(
    'Now answer the question directly and concisely, citing the sources you retrieved.'),
});
```

Without the budget there's no last turn to force synthesis on — the loop could run
until a token limit or forever. The budget is what *creates* the seam.

### Part 2 — the forceFinal flip (remove it: the model keeps reaching for tools)

On the final turn the loop withholds the tool schemas entirely.

```ts
// run-agent-loop.js:27-35
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,   // ← no tools offered on the final turn
  maxTokens, signal,
});
```

The `tools: forceFinal ? undefined` line is doing real work with the emulated
provider: recall from [file 02](02-tool-call-emulation.md) that the Gemma provider
only renders the tool catalog text `if (request.tools?.length)`. So
`tools: undefined` means the final-turn prompt has **no tool-catalog text at all** —
the model physically can't see a tool to call, on top of being told not to.

### Part 3 — the nudge text (remove it: the model stalls instead of answering)

The appended instruction is blunt and closes the two escape hatches a stalling
model reaches for.

```ts
// run-agent-loop.js:17-19
export function buildSynthesisInstruction(middle) {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}
// composed by RagQueryAgent into:
// "You have NO more tool calls available. Now answer the question directly and
//  concisely, citing the sources you retrieved. Do not say you need more queries."
```

Three clauses, each shutting a door: *NO more tool calls* (don't try), *answer
directly, citing sources* (do this instead — and note it re-asserts the citation
contract from [file 04](04-grounding-and-citation-instruction.md)), *do not say you
need more queries* (don't stall with "I should search again"). That last clause
exists because models, told they're out of tools, will often respond by *narrating
that they wish they had more* instead of answering. The nudge pre-empts that exact
behavior.

```
  Execution trace — a 2-search question, budget = 4 tool calls

  turn 0: forceFinal=false, tools=YES  → model calls search("work")     [calls=1]
  turn 1: forceFinal=false, tools=YES  → model calls search("coffee")   [calls=2]
  turn 2: forceFinal=false, tools=YES  → model answers (no tool call)   → DONE
          (synthesis nudge never needed — model concluded on its own)

  worst case, model keeps searching:
  turn …: calls reach 4 → budgetSpent=true → forceFinal flips
          tools=undefined, system += NUDGE → model is FORCED to answer
```

Note the trace's happy path: most turns, the model just answers and the loop breaks
at `toolUses.length === 0` (`run-agent-loop.js:54-57`). The synthesis nudge is the
*safety net*, not the common path — but it's the part that guarantees termination.

### Skeleton vs. hardening

Kernel: budget + forceFinal flip + nudge. Hardening on top: the `FALLBACK_ANSWER`
if even the forced turn returns empty (`rag-query-agent.js:21,51`), and the trace
emissions per turn. Strip the hardening and it still terminates with an answer;
strip the kernel and it can loop forever.

## Primary diagram

```
  Bounded synthesis — the loop and its forced exit

  ┌─ runAgentLoop ──────────────────────────────────────────────┐
  │  turn 0..N-1                            final turn / budget   │
  │  ┌──────────────┐  no tool call?        spent                │
  │  │ model+tools  │ ───── yes ──► answer ──► break              │
  │  │ BASE_SYSTEM  │                                            │
  │  └──────┬───────┘  tool call → run tool → loop               │
  │         │                                                    │
  │   forceFinal ═══════════════════════════════════════►       │
  │  ┌──────▼───────────────────────────────────────────┐       │
  │  │ model, tools=NONE, system + "NO more tools,       │       │
  │  │ answer now, cite, don't ask for more"             │ ──► answer (guaranteed)
  │  └───────────────────────────────────────────────────┘       │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Every agentic framework needs a termination guarantee, and "swap to a synthesis
prompt on the last turn" is the common shape (the ReAct literature, Anthropic's
agent guidance on iteration limits). The buffr/aptkit refinement is doing it at
*two* levels at once — removing the tool affordance AND changing the instruction —
so the guarantee doesn't depend on the model obeying prose alone. With a frontier
model the nudge might suffice on its own; with Gemma 2 9B you want the belt *and*
the suspenders, because a 9B model told "don't use tools" in prose will still try
if the tool catalog is sitting right there in its context. The control-flow side of
this — the loop, the turn budget, the message accumulation — is `study-agent-
architecture`'s territory; this file covers only the *prompt* that the final turn
swaps in.

## Interview defense

**Q: "What stops the agent from looping forever asking for more searches?"**
A budget plus a prompt swap. The loop caps turns and tool calls (6 and 4 here); on
the last allowed turn it flips `forceFinal`, which does two things at once — it
stops offering tools (so with the emulated provider there's literally no tool text
in the prompt) and it appends a synthesis nudge: *"you have no more tool calls,
answer now and cite, don't say you need more queries."* That last clause is the
one people forget — it pre-empts the model stalling by narrating that it wishes it
could search again.

```
  budget spent → forceFinal → tools removed + nudge appended → forced answer
```

Anchor: *"Belt and suspenders — remove the tool affordance AND change the
instruction; don't trust prose alone on a 9B model."*

## See also

- [`02-tool-call-emulation.md`](02-tool-call-emulation.md) — why removing tools means removing the catalog text
- [`04-grounding-and-citation-instruction.md`](04-grounding-and-citation-instruction.md) — the citation contract the nudge re-asserts
- [`06-structured-output-reprompt.md`](06-structured-output-reprompt.md) — the other "retry with a stricter prompt" mechanic
- `study-agent-architecture` — the loop's control flow, turn budget, and message accumulation
