# 09 — Chain-of-thought (CoT)

**Industry term:** chain-of-thought / step-by-step reasoning · *Language-agnostic* · **not yet exercised in buffr**

buffr does the opposite of CoT, and on purpose. The synthesis instruction asks for a *direct, concise* answer — no "think step by step." This file teaches the pattern and the judgment call of when buffr would want it (and when adding it would just burn tokens).

## Zoom out, then zoom in

You've debugged a hard problem by writing out the steps instead of jumping to the answer — the writing-it-out is what got you there. CoT is that for a model: prompt it to reason before answering and multi-step accuracy goes up. buffr's chain currently forbids the reasoning.

```
  Zoom out — where CoT would (and wouldn't) live

  ┌─ RagQueryAgent synthesis turn ─────────────────────────┐
  │  current: "answer the question directly and concisely" │ ← anti-CoT
  │  CoT would replace/augment this with:                  │
  │     "reason step by step, THEN answer"                 │ ← not present
  └────────────────────────────────────────────────────────┘
```

Zoom in: CoT means asking the model to externalize its reasoning before committing to an answer. It helps on multi-step problems and *hurts* on simple lookups — and buffr's job is mostly simple lookups.

## Structure pass

**Layers:** the synthesis instruction (direct) vs a CoT instruction (reason-then-answer). **Axis — "does this task need multi-step reasoning?":**

```
  axis: "does the task need reasoning before the answer?"

  ┌─ KB lookup ("what's the author's job") ─┐ NO  → direct (buffr's choice ✓)
  └─ multi-hop ("compare X and Y across     ─┘ YES → CoT would help
     three retrieved docs")
```

**Seam:** the synthesis turn. That's the one place a CoT instruction would go — and where buffr deliberately chose "direct" instead.

## How it works

### Move 1 — the mental model

The kernel: insert a reasoning step before the answer step. Optionally, capture the reasoning in a dedicated field so it doesn't pollute the final output.

```
  CoT — reason, then commit

  question ─► [ reasoning: step 1 … step 2 … step 3 ] ─► [ answer ]
                       (externalized)                    (the commit)
```

### Move 2 — buffr's stance and where CoT would fit

**buffr currently forbids it.** The synthesis instruction is explicitly direct: *"Now answer the question directly and concisely, citing the sources you retrieved"* (`rag-query-agent.js:49`), with *"Do not say you need more queries"* (`run-agent-loop.js:17`). For buffr's typical job — "what does the author do for work" against a small personal KB — that's the right call. CoT on a one-hop lookup wastes tokens and adds latency for no accuracy gain. On Gemma 2 9B served locally, latency is already the felt cost.

**Where CoT would earn its place.** A multi-hop question — "compare the author's stated stack against what the coffee notes imply about their schedule" — needs the model to combine several retrieved chunks. That's where step-by-step reasoning lifts accuracy. buffr doesn't have such questions in its eval set ([05](05-eval-driven-iteration.md)) today, so the need hasn't surfaced.

**The structured-output interaction — the important caveat.** If buffr ever wanted *both* reasoning and a parseable answer, the reasoning goes in a `thinking` field of a structured output, **not** in free-form prose ahead of the answer. Otherwise the [02](02-structured-outputs.md) parser would have to skip past paragraphs of reasoning to find the JSON — exactly the kind of drift `parseAgentJson`'s substring-scan fallback was built to survive, but you shouldn't lean on that. Put reasoning in a field; keep the answer clean.

**The modern caveat.** Frontier models now do CoT internally, so asking for it explicitly is less necessary than it was — but Gemma 2 9B is a cheaper model, and explicit CoT still helps cheaper models on multi-step tasks. So buffr's model is exactly the class where explicit CoT would still pay, *if* the tasks demanded it.

### Move 3 — the principle

Reason step-by-step on multi-step problems; answer directly on lookups. CoT is a token-and-latency trade for accuracy — worth it when the task has steps, wasteful when it doesn't. And when you want reasoning alongside a structured answer, isolate the reasoning in a field so it never fights the parser.

## Primary diagram

```
  buffr's stance vs CoT — task-dependent

  LOOKUP (buffr's job)          MULTI-HOP (CoT's job)
  ┌─ "answer directly,    ┐     ┌─ "reason step by step,      ┐
  │   concisely"          │     │   then answer"               │
  │  → fast, cheap        │     │  + reasoning in `thinking`   │
  │  ✓ buffr's choice     │     │    field (not free prose)    │
  └───────────────────────┘     └──────────────────────────────┘
```

## Project exercises

### EX-09-A — Add a CoT path gated on question complexity

- **Exercise ID:** EX-09-A
- **What to build:** A branch in the synthesis instruction that switches to "reason step by step, then answer" only for multi-hop questions (detected by, e.g., a cheap classifier or a multi-chunk retrieval signal).
- **Why it earns its place:** Buys accuracy on the hard questions without paying the token/latency tax on the easy lookups that are buffr's bulk.
- **Files to touch:** conceptually the synthesis-instruction assembly in aptkit; an answer-level eval ([05](05-eval-driven-iteration.md)) with multi-hop cases.
- **Done when:** multi-hop eval accuracy rises while single-hop latency is unchanged.
- **Estimated effort:** M.

## Interview defense

**Q: Should this system use chain-of-thought?**

Mostly no, and it's right not to — its job is one-hop KB lookups, and CoT on a lookup just burns tokens and latency. The synthesis prompt deliberately asks for a direct, concise answer. CoT would earn its place only on multi-hop questions, which aren't in the eval set yet.

```
  lookup → answer direct (buffr)   |   multi-hop → reason then answer (CoT)
```

Anchor: *"The caveat I'd flag: if you ever want reasoning AND a parseable answer, the reasoning goes in a `thinking` field of the structured output — never as free prose ahead of the JSON, or the parser has to skip past it. And Gemma 2 9B is exactly the cheaper-model class where explicit CoT still helps, since frontier models do it internally now."*

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — why reasoning goes in a field, not ahead of the JSON
- [06-single-purpose-chains.md](06-single-purpose-chains.md) — the synthesis turn CoT would modify
- [10-self-critique.md](10-self-critique.md) — the other "spend more tokens for reliability" technique
