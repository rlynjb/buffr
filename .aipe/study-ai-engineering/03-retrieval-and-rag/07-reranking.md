# Reranking — the second stage buffr doesn't run

*Industry standard (NOT yet exercised). Two-stage retrieval: cheap recall, then precise reorder.*

## Zoom out, then zoom in

Pull up the retrieval layer and look at what happens after the ANN search returns top-k. In buffr: nothing. The cosine top-k *is* the final answer. Reranking is a second stage that would take those candidates and reorder them with a slower, more accurate model before they reach the LLM. buffr is single-stage — there's no reorder box.

```
  Zoom out — the second stage buffr is missing

  ┌─ Retrieval layer ──────────────────────────────────────────┐
  │  STAGE 1: cosine ANN → top-k   (buffr HAS this)             │
  │                │                                            │
  │                ▼                                            │
  │  STAGE 2: ★ cross-encoder rerank (MISSING) ★ → reordered   │ ← here
  │           (buffr passes top-k straight through, unranked)  │
  └─────────────────────────────────────────────────────────────┘
  ┌─ Provider ──────────────────────────────────────────────────┐
  │  nomic-embed (bi-encoder, fast)  ·  NO cross-encoder model   │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. You know how a search result page does a cheap match to get 1000 candidates, then a heavier model reorders the top 50 it'll actually show? That two-stage shape — **bi-encoder for recall, cross-encoder for precision** — is reranking. buffr only runs stage one (the bi-encoder cosine search) and ships its order as-is. This file builds the two-stage pattern and the Case-B move: add a cross-encoder rerank over the top-50, and *measure precision@k before and after* so the second stage earns its latency.

## Structure pass

Read the skeleton: retrieval as two stages with opposite cost/quality profiles.

**Layers:** stage 1 (recall) → stage 2 (precision) — buffr stops at stage 1.

**Axis traced — "how is query↔chunk relevance scored?"**

```
  one axis: how is relevance computed?

  ┌─ stage 1 (buffr has) ───┐   SEPARATELY — query and chunk embedded
  │  bi-encoder (cosine ANN) │   independently, then compared by angle.
  └────────────┬────────────┘   Cheap (precompute chunk vectors), fuzzy.
               │ seam: independent embeddings → joint scoring
  ┌─ stage 2 (missing) ─────┐   JOINTLY — query AND chunk fed together
  │  cross-encoder           │   into one model that reads them as a pair.
  └─────────────────────────┘   Slow (no precompute), precise.
```

**The seam that matters:** the boundary between *scoring apart* and *scoring together*. A bi-encoder embeds query and chunk separately (so chunk vectors precompute once — fast, scalable), but it never lets the model see the two *together*. A cross-encoder reads the query-chunk pair jointly and catches relevance a bi-encoder's geometry misses — at the cost of running the model per candidate, so you can only afford it on a small top-k. Hold that: stage 1 buys recall cheaply, stage 2 buys precision expensively, and you run stage 2 only on stage 1's survivors.

## How it works

### Move 1 — the mental model

You know how a hiring funnel does a cheap résumé screen to get 50 candidates, then expensive interviews to rank the final 5? Reranking is that funnel. Stage 1 (cosine ANN) is the cheap screen — fast, casts a wide net, slightly noisy. Stage 2 (cross-encoder) is the interview — slow, precise, applied only to the survivors.

```
  the rerank kernel — wide cheap net, then narrow precise reorder

  query
    │ STAGE 1: bi-encoder cosine ANN  (cheap, high recall)
    ▼
  top-50 candidates  [c12 c4 c30 c7 ... ]   ← order is "good enough"
    │ STAGE 2: cross-encoder scores (query, chunk) pairs jointly
    ▼  (expensive — runs the model 50 times)
  reordered top-5    [c7 c12 c4 ... ]        ← order is now PRECISE
                      └ feed these to the LLM
```

The kernel: a cheap recall stage producing many candidates + an expensive precision stage reordering a few. Lose stage 1 and stage 2 can't scale (cross-encoding the whole corpus is infeasible). Lose stage 2 and you keep stage 1's fuzzy order — which is exactly where buffr is.

### Move 2 — the step-by-step walkthrough

**Step 1 — what buffr does today: stage 1 only.** The cosine top-k is returned directly; its order is final:

```ts
// src/pg-vector-store.ts:70-78
order by embedding <=> $1::vector    -- bi-encoder cosine order
limit $3                             -- top-k; THIS order reaches the LLM as-is
```

```ts
// aptkit packages/retrieval/src/pipeline.ts:55-58
return wiring.store.search(vector, topK);   // no reorder after this
```

The `search_knowledge_base` tool hands these chunks to the agent in cosine order. Whatever the bi-encoder thought was closest is what the model sees first. There's no second model, no joint scoring.

**Step 2 — why stage-1 order is fuzzy.** A bi-encoder compresses each chunk into one 768-vector *before ever seeing the query*. That compression is lossy: two chunks can sit at nearly the same cosine distance from a query yet differ a lot in actual relevance, and the bi-encoder can't tell them apart because it never read them *against* the query. The classic failure: a chunk that shares topic-words but doesn't actually answer the question scores high on cosine.

```
  Comparison — bi-encoder vs cross-encoder scoring

  ┌─ bi-encoder (buffr) ─────┐    ┌─ cross-encoder (rerank) ───┐
  │ embed(query) · embed(chk)│    │ model(query + chunk) →     │
  │ → cosine                 │    │ relevance score            │
  │ chunk vec precomputed ✓   │    │ no precompute; per-pair ✗  │
  │ fast, scalable, fuzzy     │    │ slow, top-k only, precise  │
  └───────────────────────────┘    └────────────────────────────┘
```

**Step 3 — the Case-B move: rerank the top-50.** Widen stage 1 (fetch top-50 instead of top-5), then run a cross-encoder over the 50 (query, chunk) pairs and keep the best 5:

```
  // reranking (the Case-B function to add)
  function rerank(query, candidates):          // candidates = stage-1 top-50
      scored = empty list
      for chunk in candidates:
          s = crossEncoder.score(query, chunk.text)   // joint scoring, per pair
          scored.append((chunk, s))
      sorted = scored sorted by s desc
      return sorted[:5]                          // precise top-5 → to the LLM
```

```
  Layers-and-hops — where rerank would slot in

  ┌─ pipeline ───┐ hop 1: search(vector, 50)   ┌─ pgvector ───────┐
  │ query()      │ ───────────────────────────►│ cosine top-50    │
  └──────┬───────┘ hop 2: 50 candidates back ◄─ └──────────────────┘
         │ hop 3: rerank(query, 50)
         ▼
  ┌─ cross-encoder (NEW provider) ┐ score each (query,chunk) pair jointly
  └──────────────┬────────────────┘ → reordered top-5 → LLM
```

The cross-encoder is a *new* provider (e.g. a local reranker model via Ollama, or a small ONNX cross-encoder) — keeping with buffr's local-first stance. The widen-then-rerank shape is the whole pattern.

**Step 4 — the boundary condition: it must earn its latency.** Reranking 50 candidates runs the model 50 times per query — real latency. So this is the one retrieval change you *must* measure: precision@k before (stage 1 only) and after (stage 1 + rerank). If precision doesn't improve enough to justify the latency, you don't ship it. That measurement gap is exactly what `../05-evals-and-observability/` is for.

### Move 3 — the principle

Recall and precision pull against each other under a cost budget, so split them: a cheap stage casts a wide net (recall) and an expensive stage reorders the catch (precision), with the expensive stage only ever touching the cheap stage's output. This two-stage shape recurs everywhere there's a cost/quality tradeoff — search, recommendations, hiring funnels. buffr running stage 1 alone is the *cheap, scalable* choice; adding stage 2 is the *quality* upgrade you reach for when the top-k order matters and you've measured that it's wrong.

## Primary diagram

The two-stage pattern, buffr's gap marked, one frame:

```
  reranking — two stages, buffr runs only the first

  query
    │ STAGE 1 (HAS): bi-encoder cosine ANN over agents.chunks
    ▼
  top-50 candidates  ← cheap, high recall, FUZZY order
    │
    │ STAGE 2 (MISSING): cross-encoder scores (query, chunk) jointly
    ▼
  precise top-5  ← would reach the LLM; today buffr skips this
  ───────────────────────────────────────────────────────────
  today: cosine top-5 reaches the LLM in bi-encoder order, unranked
  Case B: widen to top-50, cross-encode, keep 5 — MEASURE precision@k
```

## Elaborate

The bi-encoder/cross-encoder split is foundational to modern retrieval (the "ColBERT and friends" lineage). Bi-encoders win on scale because chunk embeddings precompute once and live in an ANN index — you embed the query and compare. Cross-encoders win on accuracy because they let a transformer attend over the query and chunk *together*, catching relevance signals (negation, specificity, actual answerhood) that independent embeddings lose — but they can't precompute, so they're infeasible over a whole corpus and only viable on a small candidate set. Hence: bi-encoder for recall, cross-encoder for precision, in that order.

Commercial rerankers (Cohere Rerank, Jina) are hosted cross-encoders; for buffr's local-first posture you'd want a local reranker model. The crucial discipline is measurement: reranking is the retrieval change most likely to *look* like an improvement and most likely to add latency, so it's the textbook case for a precision@k A/B. Ship it on evidence, not faith.

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so Build-item IDs are not cited. Exercises are derived directly from the codebase and the spec's concept set.

### Add a cross-encoder rerank over top-50

- **Exercise ID:** RRK-1 (Case B — buffr is single-stage; add stage 2).
- **What to build:** widen the dense search to top-50, run a local cross-encoder over the 50 (query, chunk) pairs, and return the reordered top-5. Keep stage 1 untouched; rerank is a wrapper after it.
- **Why it earns its place:** it's the standard precision upgrade for retrieval and the most-probed "how would you improve recall→precision" answer.
- **Files to touch:** `src/pg-vector-store.ts:67` (call `search(vector, 50)`), a new `src/retrieval/rerank.ts` cross-encoder, wired in `src/session.ts` retrieval path before the tool returns.
- **Done when:** the agent receives a cross-encoder-reordered top-5, and a test shows a known query's best chunk moves up versus cosine order.
- **Estimated effort:** half a day to a day.

### Measure precision@k before and after rerank

- **Exercise ID:** RRK-2 (Case B — the rerank must earn its latency).
- **What to build:** a precision@k A/B over a labelled query set: stage-1-only vs stage-1+rerank, plus a latency measurement, and a keep/drop decision based on the delta.
- **Why it earns its place:** reranking is the retrieval change most likely to add latency without improving quality — shipping it on faith is the rookie move; shipping it on a number is the senior one.
- **Files to touch:** the eval path (`src/cli/eval-cmd.ts`), running the pipeline with and without the RRK-1 reranker.
- **Done when:** you have a precision@k delta, a latency cost, and a defensible decision.
- **Estimated effort:** 1–4hr. Cross-link `../05-evals-and-observability/`.

## Interview defense

**Q: Does buffr rerank, and why would two stages beat one?**
Answer: no — buffr is single-stage; the cosine ANN top-k reaches the LLM in bi-encoder order, unranked. Two stages beat one because they split recall from precision under a cost budget: a bi-encoder embeds query and chunk *separately* (cheap, precomputable, slightly fuzzy) to cast a wide net, then a cross-encoder scores (query, chunk) pairs *jointly* (expensive, precise) to reorder only the survivors. The bi-encoder's lossy independent embedding is exactly what the cross-encoder fixes.

```
  STAGE 1 bi-encoder: embed apart → cosine top-50  (recall, cheap)
  STAGE 2 cross-encoder: score (q,chunk) together → top-5  (precision)
  buffr stops at stage 1
```

**Q: What's the one thing you must do before shipping a reranker?**
Answer: measure precision@k before and after, with the latency cost, because reranking runs the model per candidate and is the retrieval change most likely to add latency without improving quality. You widen stage 1 to top-50, cross-encode, keep 5, and only ship if the precision gain justifies the latency. The anchor: **the load-bearing discipline people skip is A/B-ing the second stage — a reranker that isn't measured is just latency.**

```
  widen→rerank→precision@k A/B (latency vs quality) → ship on the number
```

## See also

- `01-embeddings.md` — the bi-encoder cosine search that is buffr's stage 1.
- `06-hybrid-retrieval-rrf.md` — the *other* candidate-improvement lever (fuse vs rerank).
- `03-chunking-strategies.md` — better candidates start with better chunks.
- `../05-evals-and-observability/` — the precision@k A/B reranking demands.
