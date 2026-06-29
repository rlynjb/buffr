# Prompt Chaining

**Industry name(s):** prompt chaining · sequential prompting · LLM pipeline · prompt decomposition.
**Type:** Industry standard.

---

## Zoom out, then zoom in

Some tasks are too big for one prompt to do well. The fix is to break the work into a fixed line of small prompts, each doing one job and feeding the next. buffr doesn't do this — and seeing *why* it doesn't is the whole lesson.

```
  Zoom out — where a chain would sit (and where buffr's loop sits instead)

  ┌─ Session layer (buffr) ──────────────────────────────────┐
  │ ask(question) → RagQueryAgent.answer(question)           │
  │                                                          │
  │   ★ what buffr HAS: one agent loop ★                     │
  │     [ model decides: search? answer? ] ↺ up to 6 turns  │
  │                                                          │
  │     what a CHAIN would be (buffr does NOT do this):      │
  │     [rewrite] → [retrieve] → [answer]  (CODE fixes order)│
  └───────────────────────────────┬──────────────────────────┘
                                  │
  ┌─ Model layer (Ollama) ────────▼──────────────────────────┐
  │ gemma2:9b — called once per loop turn                    │
  └───────────────────────────────────────────────────────────┘
```

The `★` box is the truth of buffr: a single agent loop, not a chain. The concept itself: **prompt chaining is decomposing a task into an ordered sequence of separate LLM calls, where YOUR code fixes the order and each call has exactly one job.** The question it answers: **when do you split a task into steps you control, versus let one call (or one model-driven loop) do everything?**

You know this shape from frontend data flow: a **multi-step form wizard**. Step 1 collects, validates, hands a clean object to step 2; step 2 can't run before step 1; the *app* owns the sequence. That's a chain. Contrast a chat box where the user (or here, the model) decides what happens next — that's a loop, not a chain.

---

## The structure pass

The skeleton is the difference between two ways of sequencing LLM calls. One axis separates them cleanly:

```
  One axis distinguishes chain from loop

  axis = "who decides what the next step is?"

  ┌─ a CHAIN (buffr does NOT do this) ─┐  → CODE decides
  │ step1 → step2 → step3              │    order is fixed,
  │ (fixed, you wrote the order)       │    written by you
  └────────────────┬───────────────────┘
       seam: control flips from code to model
  ┌────────────────▼───────────────────┐  → MODEL decides
  │ an AGENT LOOP (buffr DOES this)     │    order emerges,
  │ [model: tool? answer?] ↺            │    chosen per turn
  └─────────────────────────────────────┘
```

**One axis — who decides what the next step is?** In a chain, *your code* does: you literally write `step1` then `step2`. In buffr's loop, *the model* does: each turn it chooses whether to call `search_knowledge_base` or to answer. That control flip is the seam, and it's the seam this whole file hangs on — it's also why the deep treatment of the loop lives next door in `04-agents-and-tool-use/01-agents-vs-chains.md`. Here we only need: **buffr has a loop, a loop is not a chain, and buffr has no chain.**

The other seam is one buffr explicitly notes it doesn't cross: **turn-to-turn state.** `src/session.ts:25-27` says each `answer()` call treats its question independently — no prior turns are threaded into the prompt. So buffr has neither a deliberate chain *within* a turn nor a chain of context *across* turns.

---

## How it works

#### Move 1 — the mental model

A chain is a Unix pipe of model calls: `rewrite | retrieve | answer`. Each stage takes the previous stage's output, does one transformation, passes it on. The strategy in one sentence: **when a task has natural stages with different jobs, run a separate, single-purpose prompt per stage and let code carry the output forward — so each prompt stays small, testable, and replaceable.**

```
  Pattern — a prompt chain (the thing buffr does NOT have)

  question
     │
     ▼
  ┌─ step 1: REWRITE ─┐   one job: clean/expand the query
  │ LLM call          │
  └────────┬──────────┘
           │ rewritten query  (code passes it)
           ▼
  ┌─ step 2: RETRIEVE ┐   one job: fetch chunks
  │ (not an LLM call) │
  └────────┬──────────┘
           │ chunks
           ▼
  ┌─ step 3: ANSWER ──┐   one job: synthesize grounded answer
  │ LLM call          │
  └────────┬──────────┘
           ▼
        answer
```

Each box is independent: you can swap the rewrite prompt without touching the answer prompt, and you can unit-test each in isolation. That's the payoff a chain buys — and what buffr forgoes by using one loop.

#### Move 2 — the step-by-step walkthrough

**What buffr actually runs: one agent loop, one prompt template.** `answer()` doesn't sequence multiple distinct prompts. It runs a single bounded loop with one system prompt, and the model decides each turn whether to call the tool or answer.

```ts
// packages/agents/rag-query/src/rag-query-agent.ts:62-83
async answer(question: string, runOptions = {}): Promise<string> {
  const { finalText } = await runAgentLoop({
    capabilityId: RAG_QUERY_CAPABILITY_ID,
    model: this.options.model,
    tools: this.options.tools,
    system: this.system,        // ← ONE system prompt, built once
    userPrompt: question,
    toolSchemas,
    maxTurns: 6, maxToolCalls: 4,   // ← bounded loop, not a fixed chain
    synthesisInstruction: buildSynthesisInstruction(
      'Now answer the question directly and concisely, citing the sources you retrieved.'),
  });
  return finalText.trim() || FALLBACK_ANSWER;
}
```

```
  buffr's loop — model picks the step, not your code

   ┌──────────────────────────────────────┐
   │  turn: send (system + question + hist)│
   │        to gemma2:9b                    │
   └───────────────┬───────────────────────┘
                   ▼
          model output: tool call OR answer?
            ┌────────┴────────┐
       tool call            answer
            │                  │
   run search_kb        return finalText
   feed result back ↺
   (up to maxTurns:6 / maxToolCalls:4)
```

The boundary the model owns: it might search zero times, once, or up to four. That's the loop being a loop — the *number and order* of steps emerge from the model. A chain would have fixed that in code.

**Why the loop is not a chain.** In a chain, step 2 *cannot* decide to skip step 3 — your code runs them in order regardless. In buffr's loop, the model can answer on turn 1 with no search, or search three times first. The control sits on opposite sides of the seam. This is the exact distinction `04-agents-and-tool-use/01-agents-vs-chains.md` exists to draw — cross-link there for the full agent treatment; don't re-derive it here.

```
  The seam, made concrete

  CHAIN:  code: "do step1, then step2, then step3"  — model has no say
  LOOP:   code: "loop until model answers"          — model picks each step
              ▲
        buffr lives here
```

**What buffr doesn't carry: turn history.** Even across turns there's no chain of context. Each `answer()` builds from the same `this.system` and the new question only — prior exchanges aren't threaded in. The session JSDoc says it outright:

```ts
// src/session.ts:25-27
// - Still missing: sequential in-prompt turn history (RagQueryAgent.answer()
//   treats each question independently). That's an aptkit-side change;
//   retrieval-based recall above gives relevance-based memory without it.
```

```
  No in-prompt turn history

  turn 1: [system + Q1] → A1
  turn 2: [system + Q2] → A2     ← Q1/A1 NOT in this prompt
  turn 3: [system + Q3] → A3     ← Q2/A2 NOT in this prompt

  continuity comes from RETRIEVAL (memory chunks), not a prompt chain
```

The boundary condition: ask a follow-up like "and what about the second one?" and buffr has no in-prompt record of what "the second one" was — unless retrieval happens to surface the earlier exchange as a memory chunk. That's the gap buffr fills with **retrieval-based episodic memory** instead of a chain — see `04-agents-and-tool-use/05-agent-memory.md`.

#### Move 2.5 — current state vs future state

This concept is **not implemented as a deliberate chain**, so the comparison is the point.

```
  Phase A (now)              vs    Phase B (a real chain)
  ┌────────────────────┐           ┌──────────────────────────┐
  │ one loop, one      │           │ step 1: query-rewrite LLM │
  │ system prompt;     │           │   ↓ rewritten query       │
  │ model picks steps; │  ──────►  │ step 2: retrieve          │
  │ each turn          │           │   ↓ chunks                │
  │ independent        │           │ step 3: answer LLM        │
  └────────────────────┘           └──────────────────────────┘
  model-driven, no chain           code-driven, fixed 3-step chain
```

A concrete Phase B: insert a **query-rewrite step before retrieval** (clean up "and the second one?" into a standalone query), or a **summarize-then-answer step** for long retrievals. Either is a code-owned sequence wrapped around the existing loop — buffr's loop becomes step 3 of a chain rather than the whole thing. What doesn't change: the retrieval pipeline and the model provider stay exactly as they are; you're adding stages around them, not rebuilding them.

#### Move 3 — the principle

**A chain is for steps YOU can name in advance; a loop is for steps the MODEL must discover.** If the sequence is known — rewrite, then retrieve, then answer — fixing it in code makes each stage small, testable, and swappable, and stops the model from skipping a step you needed. buffr's single loop is the right call for an open-ended "answer from the knowledge base" task where the model genuinely should decide how many searches to run. The skill is knowing which tasks deserve a chain's fixed rails and which deserve a loop's freedom — and not confusing the two because they both make multiple model calls.

---

## Primary diagram

The full contrast in one frame — what buffr runs, what a chain would be, and the seam between them.

```
  Chain vs buffr's loop — the control seam

  ── A PROMPT CHAIN (buffr does NOT do this) ─────────────
  ┌─ code owns order ───────────────────────────────────┐
  │ [rewrite LLM] → [retrieve] → [answer LLM]           │
  │   fixed sequence · each step one job · each testable │
  └──────────────────────────────────────────────────────┘
            ▲ CODE decides the next step

  ════════ the control seam flips here ════════

            ▼ MODEL decides the next step
  ── buffr's AGENT LOOP (what it DOES) ───────────────────
  ┌─ model owns order ──────────────────────────────────┐
  │ [model: search_kb? or answer?] ↺ maxTurns:6         │
  │   one system prompt · steps emerge · bounded         │
  └──────────────────────────────────────────────────────┘

  across turns: NO in-prompt history (src/session.ts:25-27)
                continuity = retrieval-based memory instead
```

---

## Elaborate

**Where this comes from.** Prompt chaining predates agent loops — it was the early answer to "one prompt can't do this reliably." Frameworks like LangChain were literally named for it: chains of prompts with code carrying intermediate state. The insight is decomposition — a model is more reliable at three narrow tasks in sequence than one wide task in a single shot, and you can test/swap each link.

**Chain vs loop, the durable distinction.** Both make multiple LLM calls, which is why they get conflated. The dividing line is *who owns the control flow*. A chain's order is in your source code (deterministic, you can read it). A loop's order is in the model's outputs (emergent, you can't predict the step count). buffr is squarely a loop — `runAgentLoop` with `maxTurns`/`maxToolCalls` bounds — and that's covered in depth in `04-agents-and-tool-use/01-agents-vs-chains.md`. This file's job is just to make sure you don't mistake the loop for a chain.

**Why buffr has no chain (and that's fine).** buffr's task — "answer this from the knowledge base" — doesn't have a fixed pipeline that's better than letting the model decide how many searches to run. A chain would help most where there's a known pre-step the model keeps skipping: query rewriting for follow-ups, or summarizing before answering on huge retrievals. Those are real Phase-B opportunities, not current behavior.

**What it connects to.** This file leans on `01-context-window.md` (a chain keeps each prompt small, dodging the budget) and `02-lost-in-the-middle.md` (short prompts have shallow middles). And it hands the cross-turn continuity problem to `04-agents-and-tool-use/05-agent-memory.md`, which solves it by retrieval rather than by chaining prompts.

---

## Project exercises

> **No curriculum file exists in this repo** (`/Users/rein/Public/buffr/.aipe/`), so these carry no `[Bx.y]` IDs. buffr has **no deliberate prompt chain**, so these are **Case B**: build a chain that doesn't exist yet.

### Exercise — Add a query-rewrite step before retrieval

- **Exercise ID:** PC-B1 (local id; no curriculum)
- **What to build:** A one-job LLM call that rewrites the incoming question into a standalone, retrieval-friendly query (resolving "the second one" against recent context) *before* the agent loop runs — making buffr's loop step 2 of a 2-step chain.
- **Why it earns its place:** It's the canonical first chain link and it directly fixes buffr's follow-up weakness (no in-prompt turn history). Forces you to own the sequence in code, the defining move of chaining.
- **Files to touch:** `src/session.ts` (call a rewrite before `agent.answer()`); the rewrite prompt can live in a small new buffr-side helper, since `@rlynjb/aptkit-core` is never edited.
- **Done when:** a follow-up question is rewritten to a standalone query, you can log the before/after, and retrieval quality on follow-ups measurably improves.
- **Estimated effort:** 1-4hr

### Exercise — Summarize-then-answer for large retrievals

- **Exercise ID:** PC-B2 (local id; no curriculum)
- **What to build:** When retrieval returns long chunks, insert a summarize step (one LLM call that condenses the chunks) before the answer step — a 2-link chain that keeps the answer prompt small.
- **Why it earns its place:** Ties chaining to the context-window file: a chain shrinks each prompt so you never approach the 8192 ceiling, and a shorter answer prompt has a shallower lost-in-the-middle sag.
- **Files to touch:** `src/session.ts` and the chunk-handling path; keep the summarize prompt buffr-side.
- **Done when:** large retrievals get summarized first, the answer-stage prompt is demonstrably smaller, and no `ContextWindowExceededError` fires on big queries.
- **Estimated effort:** 1-2 days

---

## Interview defense

**Q: buffr makes multiple model calls per question. Isn't that a prompt chain?**

No — it's an agent loop, and the difference is who owns control flow. A chain's order is fixed in code (`rewrite → retrieve → answer`). buffr's loop lets the *model* decide each turn whether to search or answer, up to `maxTurns:6`. Both make multiple calls; only the chain has a sequence you wrote.

```
  chain: CODE picks order      loop: MODEL picks order
  step1→step2→step3            [tool? answer?] ↺
                                    ▲ buffr
```

**Anchor:** `rag-query-agent.ts:62-83` — `runAgentLoop` with one system prompt, model-chosen steps.

---

**Q: A user asks a follow-up — "what about the second one?" Does buffr handle it?**

Not via a chain or in-prompt history — `answer()` treats each question independently, so prior turns aren't threaded into the prompt. Continuity comes from *retrieval*: past exchanges are embedded as memory chunks and may surface through the same search tool. A query-rewrite chain step would be the deliberate fix.

```
  no in-prompt history → relies on retrieval-based memory
  (a rewrite step would make it explicit)
```

**Anchor:** `src/session.ts:25-27` — "treats each question independently"; cross-link `04-agents-and-tool-use/05-agent-memory.md`.

---

**Q: When would you actually add a chain to buffr?**

When there's a known pre-step the model keeps skipping or doing poorly inline — query rewriting for follow-ups, or summarize-before-answer on huge retrievals. Those are fixed-order, single-job stages: exactly what code-owned chaining is for. The open-ended "how many searches" decision rightly stays a loop.

```
  fixed, nameable steps → chain
  open-ended discovery   → loop (keep as-is)
```

**Anchor:** Phase B in this file — wrap the existing loop as the final stage of a short chain.

---

## See also

- `04-agents-and-tool-use/01-agents-vs-chains.md` — the full agent-vs-chain distinction this file points at.
- `04-agents-and-tool-use/05-agent-memory.md` — retrieval-based episodic memory, buffr's substitute for in-prompt turn history.
- `01-context-window.md` — a chain keeps each prompt under the 8192 budget.
- `02-lost-in-the-middle.md` — shorter per-step prompts have shallower middles.
