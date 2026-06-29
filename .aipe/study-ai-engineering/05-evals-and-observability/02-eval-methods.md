# Eval methods — precision@k wired, faithfulness not

*Industry standard. buffr wires retrieval metrics; the faithfulness judge ships in aptkit but is unconnected.*

## Zoom out, then zoom in

There are two questions any RAG eval must answer: "did we retrieve the right chunks?" and "did the answer actually use them?" buffr answers the first and ignores the second.

```
  Zoom out — where eval sits

  ┌─ Offline harness (npm run eval) ────────────────────────────┐
  │  src/cli/eval-cmd.ts                                         │
  │   ★ precision@k / recall@k over the retrieval pipeline ★     │ ← we are here (wired)
  └───────────────────────────┬─────────────────────────────────┘
                              │ pipeline.query(q, k) — bypasses the agent
  ┌─ Retrieval pipeline ──────▼─────────────────────────────────┐
  │  embed → ANN → ranked chunks                                │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Faithfulness (NOT wired) ──────────────────────────────────┐
  │  aptkit RubricJudge — would score answer-vs-chunks           │  ✗ connected to nothing
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: buffr's eval is an *information-retrieval* eval — it scores the ranked list against a labeled set of relevant documents. It does not run the model, so it cannot tell you whether the model hallucinated. That second eval — faithfulness, via LLM-as-judge — is the named gap.

## Structure pass

**Layers:** eval CLI → retrieval pipeline → scorers. The agent and the model are *not* in this path.

**Axis — "what does each metric actually measure?"**

```
  trace "what is being scored?"

  ┌─ precision@1 ───────────┐   of the top-1 doc, is it relevant?   (retrieval)
  ├─ recall@3 ──────────────┤   of the relevant docs, how many in top-3? (retrieval)
  ├─ faithfulness ──────────┤   did the ANSWER use the chunks?       ← NOT MEASURED
  └─ task correctness ──────┘   is the final answer right?           ← NOT MEASURED
```

**The seam:** `eval-cmd.ts` calls `pipeline.query()` directly, **not** `agent.answer()`. So the eval bypasses the agent loop, the Gemma tool-call emulation, and the generation step entirely. It measures the retrieval substrate in isolation — clean signal for retrieval, blind to everything the agent layer can break.

## How it works

### Move 1 — the mental model

Precision and recall are the same pair you'd compute over any classifier's predictions, applied to a ranked retrieval. Precision@k: of what you returned, how much was right. Recall@k: of what was right, how much did you return. The eval set is your ground truth — three labeled query→doc pairs.

```
  precision vs recall at k=3, one query

  relevant docs: {coffee.md}        retrieved top-3: [coffee.md, work.md, stack.md]
  precision@1 = is rank-1 relevant?  → coffee.md ∈ relevant → 1.0
  recall@3    = relevant found / all relevant → 1/1 → 1.0
```

### Move 2 — the step-by-step walkthrough

**Step 1 — the labeled eval set is three query→doc pairs.** Small, high-signal, hand-curated — a golden set.

```json
// eval/queries.json
[
  { "query": "what does the author do for work",        "relevant": ["work.md"] },
  { "query": "what programming stack and tools are used", "relevant": ["stack.md"] },
  { "query": "how does the author take their coffee",     "relevant": ["coffee.md"] }
]
```

**Step 2 — the harness queries the pipeline and scores each.** It runs retrieval, dedupes to document ids, and scores P@1 and R@3.

```ts
// src/cli/eval-cmd.ts:22-33
const K = 3;
for (const { query, relevant } of queries) {
  const hits = await pipeline.query(query, K);
  const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];   // chunk hits → doc ids
  const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;       // P@1
  const r = scoreRecallAtK(docs, new Set(relevant), K).score;          // R@3
  p1 += p; rk += r;
}
// mean P@1, mean R@3 printed at the end
```

Note the dedupe: retrieval returns *chunk* hits (`docId#index`), but relevance is labeled at the *document* level, so the harness collapses chunks to their parent `docId` before scoring. That's the right granularity match — a query is satisfied if the right document surfaces, regardless of which chunk.

**Step 3 — the scorers are simple ratios.** aptkit's `scorePrecisionAtK` and `scoreRecallAtK` are exactly the textbook formulas, with an `ok: false` guard for degenerate inputs.

```ts
// aptkit packages/evals/src/precision-at-k.ts
// precision@k = matched / min(k, retrieved.length)
export function scorePrecisionAtK(retrievedIds, relevantIds, k) {
  if (k <= 0) return NOT_WELL_FORMED;
  const total = Math.min(k, retrievedIds.length);
  if (total === 0) return NOT_WELL_FORMED;
  const matched = countDistinctHits(retrievedIds, relevantIds, k);
  return { ok: true, score: matched / total, matched, total };
}
// recall@k = matched / |relevantIds|
export function scoreRecallAtK(retrievedIds, relevantIds, k) {
  if (k <= 0) return NOT_WELL_FORMED;
  const total = relevantIds.size;
  if (total === 0) return NOT_WELL_FORMED;
  const matched = countDistinctHits(retrievedIds, relevantIds, k);
  return { ok: true, score: matched / total, matched, total };
}
```

**Step 4 — the gap: faithfulness is never scored.** Here's the move that's missing. aptkit ships a `RubricJudge` — an LLM-as-judge that scores an answer against a rubric (dimensions, checks, a verdict, and one suggested fix). It's a fully-built class. buffr instantiates it *nowhere*.

```ts
// aptkit packages/evals/src/rubric-judge.ts:72-104 (the class buffr never calls)
export class RubricJudge {
  judge(input, options = {}): Promise<StructuredGenerationResult<RubricJudgment>> {
    return generateStructured({
      model: this.model,
      system: buildRubricJudgeSystemPrompt(this.rubric),
      userPrompt: buildRubricJudgeUserPrompt(input),
      validate: createRubricJudgmentValidator(this.rubric),
      ...
    });
  }
}
// returns { dimensions, checks?, verdict, fix, reasoning? }
```

Concretely: a question comes in, retrieval surfaces the perfect chunk, and the model answers with something it made up that ignores the chunk. buffr's eval run is green — P@1 = 1.0, R@3 = 1.0 — because retrieval *was* perfect. The hallucination is invisible. **A hallucinated answer over perfect chunks scores 1.0.** That's the precise meaning of "faithfulness is unwired."

```
  the blind spot, concretely

  query ─► retrieval: PERFECT (coffee.md, rank 1)   → P@1 = 1.0 ✓
       ─► agent answer: "the author drinks tea"     → WRONG, ignores the chunk
                                                       └─ no eval scores this ✗
```

### Move 3 — the principle

Retrieval metrics and faithfulness metrics measure different failures, and you need both. Precision@k catches "we fetched the wrong thing." Faithfulness catches "we fetched the right thing and the model ignored it." A RAG system green on the first and unmeasured on the second has a known-unknown the size of the whole generation step. buffr is exactly there — and the judge to close it is already in the box.

## Primary diagram

```
  buffr eval — what runs vs what's available

  RUNS (npm run eval)                         AVAILABLE, UNWIRED
  ───────────────────                         ──────────────────
  queries.json ─► pipeline.query(q,3)         RubricJudge (aptkit)
                    │                            judge(answer, chunks)
                    ▼ chunk hits → doc ids       → {verdict, fix, dimensions}
              scorePrecisionAtK(.,.,1)          │
              scoreRecallAtK(.,.,3)             └─► connected to NOTHING in buffr
                    │
                    ▼
              mean P@1, mean R@3   ◄── retrieval only; agent + model not in path
```

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Wire RubricJudge as a faithfulness eval

- **Exercise ID:** EVAL-1 (Case B — faithfulness not yet exercised). **The highest-leverage eval exercise.**
- **What to build:** a `npm run eval:faithfulness` that, for each query, runs the full `agent.answer()`, captures the retrieved chunks from the trace, and calls aptkit's `RubricJudge` to score whether the answer is grounded in those chunks.
- **Why it earns its place:** closes buffr's biggest measurement gap and produces the "I caught my agent hallucinating over good retrieval" story; uses a different model family than the generator to avoid self-preference bias (`03-llm-as-judge-bias.md`).
- **Files to touch:** new `src/cli/eval-faithfulness-cmd.ts`, reuse `src/session.ts`'s agent build, instantiate `RubricJudge` with a faithfulness rubric, read chunks from `agents.messages.tool_results`.
- **Done when:** a deliberately hallucinated answer scores a `fail` verdict while a grounded answer scores `pass`.
- **Estimated effort:** 1–2 days.

### Eval the agent path, not just the pipeline

- **Exercise ID:** EVAL-2 (Case A — extend the retrieval eval).
- **What to build:** a variant of `eval-cmd.ts` that scores precision@k over the chunks the *agent actually retrieved* (via the tool), catching the Gemma emulation failures the pipeline-direct eval misses.
- **Why it earns its place:** the current eval bypasses the agent, so it can't see the empty-query tool failure — this exercise makes the eval cover the real path.
- **Files to touch:** `src/cli/eval-cmd.ts` (run `agent.answer`, pull retrieved ids from the trace).
- **Done when:** a forced wrong-key tool-call shows up as a precision drop in the eval.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: How does buffr know its RAG works?**
Answer: it scores precision@1 and recall@3 over a labeled golden set (`eval/queries.json`) by running the retrieval pipeline directly. That validates retrieval quality. What it deliberately doesn't validate yet is faithfulness — whether the generated answer used the retrieved chunks.

**Q: What's the most important eval buffr is missing?**
Answer: faithfulness, via LLM-as-judge. aptkit already ships a `RubricJudge`, but it's wired into nothing here — so a hallucinated answer over perfect chunks still scores 1.0, because the eval only measures retrieval and never runs the model. **The part people forget is that retrieval precision and answer faithfulness are different metrics catching different failures.** The fix is wiring `RubricJudge` into an eval that runs the full agent and scores answer-vs-chunks, using a different model family as the judge to dodge self-preference bias.

```
  the sketch:  P@k = "fetched right?"   ·   faithfulness = "used what we fetched?"   ← unmeasured
```

## See also

- `01-eval-set-types.md` — the golden set buffr has, the adversarial/regression sets it lacks.
- `03-llm-as-judge-bias.md` — the biases to design around when wiring RubricJudge.
- `04-llm-observability.md` — the trace that an agent-path eval would read from.
- `../04-agents-and-tool-use/02-tool-calling.md` — the failure the pipeline-direct eval can't see.
