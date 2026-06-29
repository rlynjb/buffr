# 06 — Single-purpose chains

**Industry term:** single-purpose chains / one-job pipelines · the RAG query agent (`RagQueryAgent`) + the bounded synthesis nudge · *Language-agnostic*

## Zoom out, then zoom in

You'd never write one React component that fetches, validates, renders, and handles routing — you'd split it, because when it breaks you want to know *which* part broke. Chains are the same. One chain, one job, composed into longer flows. buffr runs exactly one chain, and it's correctly single-purpose — but there's no pipeline of composed chains yet.

```
  Zoom out — buffr's single chain

  ┌─ App ──────────────────────────────────────────────────┐
  │  session.ask(question)                                  │
  └─────────────────────────┬───────────────────────────────┘
                            │
  ┌─ The one chain ─────────▼───────────────────────────────┐
  │  ★ RagQueryAgent — one job: answer, grounded in KB ★    │ ← we are here
  │  search → (maybe search again) → synthesize             │
  └─────────────────────────┬───────────────────────────────┘
                            │  one prose answer
  ┌─ UI ────────────────────▼───────────────────────────────┐
  │  Ink renders the turn                                   │
  └────────────────────────────────────────────────────────┘
```

Zoom in: a single-purpose chain does exactly one job, so failures are localizable and models are right-sized per job. buffr's chain holds the one-job discipline; the composition story (classifier → router → handler) is the part not yet built.

## Structure pass

**Layers:** the agent (one job) → the bounded loop inside it → the forced synthesis. **Axis — "how many jobs does this chain do?":**

```
  axis: "jobs per chain"

  ┌─ RagQueryAgent ─┐ ONE job: grounded Q&A          ✓ single-purpose
  └─────────────────┘ NOT: classify + route + answer  (no pipeline yet)
```

**Seam:** the synthesis turn. The loop searches freely, then a hard boundary forces it to stop searching and answer — that seam is what keeps the one job bounded.

## How it works

### Move 1 — the mental model

The kernel: a chain is a single job with a bounded loop and a forced exit. What breaks without the bound — the chain searches forever; without the forced synthesis — it never commits to an answer.

```
  Single-purpose chain — search · bound · synthesize

  ┌─ one job: answer grounded in KB ──────────────────┐
  │   search_knowledge_base  (≤ maxToolCalls: 4)      │
  │        │ repeat while budget remains              │
  │        ▼                                          │
  │   budget spent OR maxTurns hit → FORCE SYNTHESIS  │  ← the exit
  │        "no more tool calls; answer directly"      │
  └───────────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**One job, declared in the bounds.** `RagQueryAgent.answer` runs the loop with hard limits: `maxTurns: 6`, `maxToolCalls: 4` (`rag-query-agent.js:38`). That's the one-job discipline expressed as a budget — this chain searches and answers, and it's not allowed to wander.

**The forced synthesis — the bounded exit.** When the tool budget is spent or the turn limit hits, the loop appends a synthesis instruction and *drops the tools* so the model can't keep searching:

```js
// run-agent-loop.js:27
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  tools: forceFinal ? undefined : toolSchemas,   // tools removed on the final turn
  ... });
```

The synthesis instruction itself (`buildSynthesisInstruction`, `:17`) is blunt: *"You have NO more tool calls available. Now answer the question directly and concisely, citing the sources you retrieved. Do not say you need more queries."* (`rag-query-agent.js:49`). That last clause exists because weak models, cornered, love to stall with "I'd need to search more." The prompt forbids the stall. This is the most load-bearing mechanic in the chain — without the forced-synthesis turn, the chain has no guaranteed exit into an answer.

**Debugging benefit — failures are localizable.** Because the chain does one job, a bad answer has a small suspect list: retrieval missed (measurable, [05](05-eval-driven-iteration.md)), or synthesis drifted. There's no "which of five sub-tasks failed" ambiguity, because there's one task.

**The composition gap.** The multi-chain pattern — a small classifier model routing to specialized handlers, big models only where generation is needed — isn't here. buffr has one chain and one model (Gemma 2 9B for everything). The model-routing benefit (cheap model for classification, expensive for generation) is unrealized because there's only one model and one job.

### Move 3 — the principle

One chain, one job. The payoff is debuggability and right-sized models: when something fails you know which chain failed, and you can run a 2B classifier where you don't need a 9B generator. A multi-purpose chain trades that away for brittleness — every added responsibility is another failure mode sharing one prompt.

## Primary diagram

```
  buffr's single-purpose chain — bounded, with a forced exit

  question ─► RagQueryAgent (one job: grounded Q&A)
                │
                ├─ search_knowledge_base ──┐ ≤ 4 calls, ≤ 6 turns
                │   ◄── ranked chunks ──────┘
                │
                ▼  budget spent / turn limit
              FORCE SYNTHESIS  (tools dropped, nudge appended)
              "answer directly, cite, don't ask for more"
                │
                ▼
              one prose answer
```

## Elaborate

The single-purpose-chain pattern is LangChain's and every pipeline framework's core unit, and the loopd project in this portfolio is the canonical multi-chain example (5 chains, each one job, composed). buffr is the *single*-chain case — correct as far as it goes. The forced-synthesis turn is the part that generalizes: any agent loop needs a hard budget and a forced exit, or a weak model stalls forever. The agent loop's full control flow (the ReAct pattern, tool dispatch) is `study-agent-architecture`'s subject; here it matters only as the thing that keeps the one job bounded.

## Interview defense

**Q: Is this one chain or a pipeline, and how is it kept from running forever?**

One chain, single-purpose: grounded Q&A, no classifier-router-handler pipeline. It's bounded by a hard budget — `maxToolCalls: 4`, `maxTurns: 6` — and a forced synthesis turn that drops the tools and instructs the model to answer directly and not ask for more queries.

```
  search (≤4) → budget spent → FORCE SYNTHESIS (tools off, nudge on) → answer
```

Anchor: *"The load-bearing mechanic is the forced-synthesis turn — without it a 9B model corners itself and stalls with 'I need more searches.' The prompt explicitly forbids that. What's missing is composition: one model does every job, so there's no model-routing — a cheap classifier where you don't need the big generator."*

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — the tool calls the loop emulates between search and synthesis
- [07-output-mode-mismatch.md](07-output-mode-mismatch.md) — the chain's single output mode and the in-loop mode flip
- `study-agent-architecture` — the ReAct loop and tool dispatch in full
