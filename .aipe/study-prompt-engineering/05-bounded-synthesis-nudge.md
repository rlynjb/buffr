# Bounded synthesis nudge (force the final answer)

**Industry name(s):** Synthesis turn / forced-answer prompt / budget-exhaustion nudge · *Industry standard for agent loops*

---

## Zoom out, then zoom in

Weak models, stuck in an agent loop, keep asking for one more tool call.
"Let me search again to be sure." "I need more data." They'll do this
forever if you let them, burning your turn budget and never producing an
answer. The fix is a prompt that fires on the last allowed turn: drop
the tools entirely, and append "You have NO more tool calls available.
Now answer, cite your sources. Do not say you need more queries." It's a
hard stop that *also* tells the model what to do with the stop.

```
  Zoom out — the nudge sits at the end of the loop

  ┌─ Agent loop (run-agent-loop.js) ─────────────────────────────┐
  │  turn 1..N-1: tools available, model may search              │
  │  turn N (or budget spent): ★ DROP tools + SYNTHESIS NUDGE ★   │
  │                              (this guide)                    │
  └───────────────────────────┬──────────────────────────────────┘
                              │ system + nudge, NO tools
  ┌─ Provider (Gemma) ────────▼──────────────────────────────────┐
  │  no tools in request → no JSON demand → forced to prose       │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **two coupled moves on the final turn** — remove
the tools from the request *and* append a synthesis instruction. The tool
removal makes a tool call structurally impossible; the instruction makes
the model answer instead of stalling. Either alone is incomplete.

---

## Structure pass

**Layers.** Loop (decides when the final turn is) → request assembly
(strips tools, appends nudge) → provider (no tools → no JSON demand →
prose).

**Axis — *can the model call a tool at this layer?*** Trace it across
turns:

```
  axis: is a tool call possible right now?

  ┌─ turns 1..N-1 ──────┐  tools: toolSchemas    → YES (model may search)
  └─────────┬───────────┘
  ┌─ final turn ────────┐  tools: undefined       → NO (structurally removed)
  └─────────┬───────────┘
  ┌─ provider ──────────┐  no tools → no "respond → prose only (the JSON
  └─────────────────────┘  with JSON" line             demand never appears)
```

**The seam — the `forceFinal` boundary.** On one side, a normal turn
where the model can search. On the other, a turn where the tool array is
`undefined` and the synthesis nudge is glued to the system prompt. The
loop owns the flip (`run-agent-loop.js:28`). The interesting consequence:
removing the tools also removes the Gemma provider's "respond with ONLY
JSON" line (because `buildSystemText` only adds it when
`request.tools?.length`, `gemma-provider.js:86`). So the final turn's
prompt is *cleaner* — no tool catalog, no JSON demand, just "answer and
cite." The two mechanisms compose without either knowing about the other.

---

## How it works

### Move 1 — the mental model

You know how a retry loop needs a max-attempts cap or it spins forever?
The synthesis nudge is the cap *plus a graceful finish* — instead of
just throwing when the budget's gone, it tells the model "budget's gone,
here's your job now: answer." It converts a hard limit into a useful
final action.

```
  The pattern — force-final on the last turn

  for turn in 0..maxTurns:
    forceFinal = (turn == maxTurns-1) OR (toolCalls >= maxToolCalls)
                          │
              ┌───────────┴───────────┐
        not final                   final
              │                        │
   system + tools          system + SYNTHESIS_NUDGE, tools=undefined
   (model may search)      (model MUST answer in prose)
```

### Move 2 — the load-bearing skeleton

The kernel is small but every part is load-bearing.

**1. Isolate the kernel.** Three parts:

```
  the synthesis kernel

  a budget check   +   tool removal on final turn   +   a synthesis instruction
  (when is it over?)   (make a call impossible)         (say what to do instead)
```

**2. Name each part by what breaks without it.**

**The budget check** — `run-agent-loop.js:27-28`:

```
  forceFinal — two ways the loop ends (lines 27-28)

  budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls
  forceFinal  = turn === maxTurns - 1 || budgetSpent
       │
       └─ RagQueryAgent sets maxTurns: 6, maxToolCalls: 4 (rag-query-agent.js:47-48)
          so the loop forces a finish at turn 5 OR after 4 tool calls,
          whichever comes first
```

Remove the budget check and the loop runs to `maxTurns` every time even
when the model already has what it needs — wasteful — or, with no cap at
all, never terminates on a model that keeps asking. The `maxToolCalls`
half is the tighter bound: 4 searches is plenty for buffr's single-hop
RAG, so it usually fires before `maxTurns`.

**The tool removal** — `run-agent-loop.js:32`: `tools: forceFinal ?
undefined : toolSchemas`. This is the structural enforcement. With
`tools: undefined`, the Gemma provider's `wantsTool` is false
(`gemma-provider.js:18`), so it never renders the tool catalog and never
adds the JSON demand. The model *cannot* emit a tool call the loop would
act on — there are no tools to call. Remove this line and the nudge is a
polite request the model can ignore by calling a tool anyway.

**The synthesis instruction** — `buildSynthesisInstruction`
(`run-agent-loop.js:17-19`) + its application (`:30`):

```
  the nudge — buildSynthesisInstruction (lines 17-19)

  `You have NO more tool calls available. ${middle} Do not say you need
   more queries.`
       │
       └─ RagQueryAgent's middle (rag-query-agent.js:49):
          "Now answer the question directly and concisely, citing the
           sources you retrieved."

  applied at :30 — system = forceFinal && nudge
    ? `${system}\n\n${nudge}` : system
```

Remove the instruction and the model, handed no tools and no guidance,
might apologize ("I couldn't complete my research") instead of answering
from what it already retrieved. The three clauses each do a job:
**"NO more tool calls available"** (state the constraint), **"Now answer…
citing the sources"** (the actual job, which re-asserts grounding from
[`02`](02-grounding-and-citation-instruction.md)), **"Do not say you need
more queries"** (pre-empt the specific weak-model stall). That last
clause is scar tissue — it exists because models *do* say exactly that.

**3. Skeleton vs hardening.** The kernel is budget-check + tool-removal +
instruction. The **hardening** is the "Do not say you need more queries"
clause and the dual bound (`maxTurns` *and* `maxToolCalls`) — pre-empting
the specific ways a weak model wastes the final turn. The fallback answer
(`rag-query-agent.js:21,51`, `"I couldn't find anything…"`) is the last
hardening layer: if even the forced turn yields empty text, return a
clean message rather than blank.

### Move 3 — the principle

Every agent loop needs a **forced terminal turn** — a point where you
take the tools away and tell the model to synthesize what it has. A weak
model won't stop on its own; it'll always want one more search. The
discipline is to make stopping *structural* (remove the tools) and
*directed* (say "answer now, cite"), not merely requested. The
load-bearing insight people forget: removing the tools is what gives the
instruction teeth — without it, "no more tool calls" is a suggestion the
model overrides by calling a tool.

---

## Primary diagram

```
  Bounded synthesis — the forced final turn

  ┌─ runAgentLoop (run-agent-loop.js:25-35) ─────────────────────┐
  │  for turn in 0..maxTurns(6):                                 │
  │    budgetSpent = toolCalls.length >= maxToolCalls(4)   :27   │
  │    forceFinal  = turn==maxTurns-1 || budgetSpent       :28   │
  │                                                              │
  │    model.complete({                                          │
  │      system: forceFinal                                      │
  │        ? system + "NO more tool calls… Now answer, cite…     │
  │                    Do not say you need more queries"  :30    │
  │        : system,                                             │
  │      tools: forceFinal ? undefined : toolSchemas        :32  │
  │    })                                                        │
  │       │                                                      │
  │       └─ no tools → Gemma drops JSON demand → prose answer   │
  └───────────────────────────┬──────────────────────────────────┘
                              │ finalText (or FALLBACK_ANSWER if empty)
  ┌─ RagQueryAgent.answer ────▼──────────────────────────────────┐
  │  return finalText.trim() || "I couldn't find anything…"  :51 │
  └───────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use case.** You ask buffr a question whose answer isn't cleanly in the
corpus. Gemma searches, gets weak hits, and wants to search again… and
again. After 4 tool calls (`maxToolCalls`, `rag-query-agent.js:48`) the
loop forces the final turn: tools gone, nudge appended. Gemma is made to
answer from the 4 searches it already did, citing what it found —
instead of looping until `maxTurns` apologizing.

**The synthesis instruction builder — `run-agent-loop.js:17-19`:**

```
  buildSynthesisInstruction  (lines 17-19)

  return `You have NO more tool calls available. ${middle}            ← constraint
          Do not say you need more queries.`                           ← anti-stall clause
       │
       └─ middle is supplied per-agent; RagQueryAgent passes
          "Now answer the question directly and concisely,
           citing the sources you retrieved." (rag-query-agent.js:49)
```

**The forced-turn assembly — `run-agent-loop.js:27-35`:**

```
  the final-turn flip  (lines 28-32)

  const forceFinal = turn === maxTurns - 1 || budgetSpent;     ← when to stop
  const response = await model.complete({
    system: forceFinal && synthesisInstruction                 ← glue nudge to system
      ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
    tools: forceFinal ? undefined : toolSchemas,               ← REMOVE tools (the teeth)
    maxTokens, signal,
  });
       │
       └─ tools:undefined makes Gemma's buildSystemText skip the JSON
          demand entirely (gemma-provider.js:86) — the model is left
          with only "answer and cite", no way to call a tool
```

**The bounds and fallback — `rag-query-agent.js:47-51`:** `maxTurns: 6`,
`maxToolCalls: 4`, and `finalText.trim() || FALLBACK_ANSWER` — the
forced turn plus a clean empty-answer fallback (`:21`).

---

## Elaborate

The forced synthesis turn is standard in production agent loops — the
ReAct pattern's "if budget exhausted, answer from observations" step. The
reason it's prominent in buffr specifically is, again, **model strength**:
GPT-4 in a loop usually decides to answer on its own; Gemma 2 9B needs to
be *made* to. The "Do not say you need more queries" clause is the
fingerprint of having watched a weak model stall — you don't write that
clause until you've seen the model write "I need to search more" on its
final turn.

The coupling of tool-removal and instruction is the elegant part. They
live in different concerns — `tools: undefined` is loop control,
the nudge is prompt text — but they compose: removing the tools cleans
the prompt (no catalog, no JSON demand, per
[`03`](03-tool-call-emulation-prompt.md)), and the instruction fills the
space with "answer, cite." The synthesis turn re-asserts the grounding
contract from [`02`](02-grounding-and-citation-instruction.md) ("citing
the sources you retrieved") so the forced answer is still grounded, not a
free-for-all.

Where it connects: this is the termination half of the bounded ReAct
loop the agent-architecture guide walks. Prompt engineering owns *the
text of the nudge*; agent architecture owns *the loop control that fires
it*. The seam between them is `run-agent-loop.js:28-32`.

---

## Interview defense

**Q: A weak model in your agent loop keeps asking for more tool calls and
never answers. How do you make it stop?**

A forced terminal turn: on the last allowed turn (or when the tool budget
is spent — `run-agent-loop.js:28`), set `tools: undefined` *and* append a
synthesis nudge. The tool removal is the teeth — with no tools, a tool
call is structurally impossible and the provider even drops its JSON
demand. The nudge directs the freed turn: "Now answer, cite the sources,
do not say you need more queries" (`:17-19`, `rag-query-agent.js:49`). The
load-bearing part people forget: **removing the tools, not just asking** —
"no more tool calls" as pure instruction is a suggestion the model
overrides by calling a tool anyway.

```
  remove tools  ×  synthesis nudge
  ┌────────────┐    ┌──────────────┐
  │ call is    │ ×  │ "answer now, │  = forced, grounded, final answer
  │ impossible │    │  cite"       │
  └────────────┘    └──────────────┘
  instruction alone = model ignores it and searches again
```

**Anchor:** "Forced synthesis = remove the tools (the teeth) + nudge to
answer (the direction), at `run-agent-loop.js:28-32`."

---

## Validate

- **Reconstruct.** Write the `forceFinal` condition from memory
  (`run-agent-loop.js:27-28`). What are the two ways it becomes true, and
  what values does `RagQueryAgent` set (`:47-48`)?
- **Explain.** Why does `tools: forceFinal ? undefined : toolSchemas`
  (`:32`) make the nudge enforceable rather than ignorable? Trace what
  `gemma-provider.js:86` does when `tools` is undefined.
- **Apply.** A user asks something fully outside buffr's corpus. Walk the
  loop: 4 searches with weak hits, then the forced turn. What does the
  model produce, and what does `rag-query-agent.js:51` return if it's
  empty?
- **Defend.** Argue why the "Do not say you need more queries" clause
  (`run-agent-loop.js:18`) earns its place on a 9B model but would be
  noise on GPT-4.

---

## See also

- [`03-tool-call-emulation-prompt.md`](03-tool-call-emulation-prompt.md)
  — why dropping the tools also drops the JSON demand
- [`02-grounding-and-citation-instruction.md`](02-grounding-and-citation-instruction.md)
  — the grounding the nudge re-asserts on the final turn
- [`study-agent-architecture/03-agentic-retrieval.md`](../study-agent-architecture/03-agentic-retrieval.md)
  — the loop this nudge terminates
