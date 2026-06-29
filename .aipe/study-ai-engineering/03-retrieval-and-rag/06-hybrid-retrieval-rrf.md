# Hybrid retrieval + RRF — combining lanes buffr doesn't have yet

*Industry standard (NOT yet exercised). How you'd fuse dense and sparse into one ranked list.*

## Zoom out, then zoom in

Pull up the retrieval layer and picture two ranked lists arriving — one from dense (cosine), one from sparse (BM25). Hybrid retrieval is the box that *merges* them into a single ranking. buffr has neither the sparse lane nor the merge box: it's dense-only, so there's nothing to fuse.

```
  Zoom out — the fusion box buffr is missing

  ┌─ Retrieval layer ──────────────────────────────────────────┐
  │  DENSE list  ──┐                                            │
  │                ├─► ★ RRF FUSION (MISSING in buffr) ★ ─► top-k│ ← here
  │  SPARSE list ──┘    (buffr has no sparse list to fuse)      │
  └─────────────────────────────────────────────────────────────┘
  ┌─ Storage ───────────────────────────────────────────────────┐
  │  agents.chunks — one matcher (cosine) feeds one list only    │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. You've built graphs and heaps, so merging ranked lists is familiar territory. The concept is **reciprocal-rank fusion (RRF)** — a parameter-free way to combine multiple ranked lists by *rank position*, not by raw score. It's the standard answer to "I have two retrievers, how do I get one result set." buffr can't use it today (no second list), so this file builds RRF and names the precondition: first add sparse (`05`), then this fuses it. Honest and shorter — full format, but the gap is the point.

## Structure pass

Read the skeleton: hybrid is a merge over independent retrievers.

**Layers:** N independent retrievers → a fusion function → one ranked list.

**Axis traced — "what scale does the combine operate on?"**

```
  one axis: what does fusion combine?

  ┌─ retrievers ────────────┐   INCOMPARABLE SCORES — cosine ∈ [-1,1],
  │  dense score, BM25 score │   BM25 ∈ [0, ∞). Can't add them directly.
  └────────────┬────────────┘
               │ seam: scores are incomparable → use RANK instead
  ┌─ fusion ───▼────────────┐   RANK POSITION — RRF ignores raw scores,
  │  RRF: 1/(k + rank)       │   uses each item's POSITION in each list
  └─────────────────────────┘
```

**The seam that matters:** the boundary where raw scores become ranks. Cosine similarity and BM25 scores live on different, non-comparable scales — you can't average them. RRF's whole trick is to throw away the scores and keep only *position*, which is comparable across any retriever. Hold that: RRF works *because* it refuses to trust raw scores.

## How it works

### Move 1 — the mental model

You know how you'd merge two sorted lists — but here you can't just compare values, because list A's "0.8" and list B's "12.4" mean nothing to each other. RRF sidesteps it: each item gets points based on *how high it ranks* in each list (`1/(k+rank)`), and you sum those points across lists. An item that ranks well in *both* lists wins; an item that's #1 in one and absent from the other still scores decently.

```
  the RRF kernel — sum reciprocal ranks across lists

  for each item, across each ranked list it appears in:
      contribution = 1 / (k + rank_in_that_list)     (k ≈ 60, rank 1-based)
  RRF_score(item) = Σ contributions
  → rank all items by RRF_score, take top-k

  example (k=60):
    chunk X: dense rank 1, sparse rank 3 → 1/61 + 1/63 = 0.0322
    chunk Y: dense rank 2, sparse absent → 1/62          = 0.0161
    → X beats Y (it's strong in BOTH lists)
```

The kernel: reciprocal of rank, summed across lists, with a smoothing constant `k`. The load-bearing piece is using *rank* not *score* — that's what makes two incomparable retrievers combinable with zero tuning.

### Move 2 — the step-by-step walkthrough

**Step 1 — what buffr does today: one list, no fusion.** The query path returns exactly one ranked list, straight from cosine:

```ts
// aptkit packages/retrieval/src/pipeline.ts:55-58
const [vector] = await wiring.embedder.embed([query]);
if (!vector) return [];
return wiring.store.search(vector, topK);    // one list; nothing to fuse
```

There is no second retriever, so there's no merge step. Adding hybrid is strictly downstream of adding sparse (`05-dense-vs-sparse.md`) — you can't fuse one list.

**Step 2 — the precondition: two lists.** Once a `searchSparse` exists beside `search` (the `05` exercise), you have two ranked lists for the same query. Each item is a chunk id; each list orders them differently:

```
  Pattern — two lists, same items, different orders

  dense (cosine):   [c7, c2, c9, c1, ...]   rank by meaning
  sparse (BM25):    [c2, c5, c7, c3, ...]   rank by exact terms
                     │         │
                     └── c7 strong in both ─┘  ← RRF will reward this
```

**Step 3 — fuse by reciprocal rank.** RRF in pseudocode — no scores, only positions:

```
  // RRF fusion (the Case-B function to add)
  function rrf(denseList, sparseList, k = 60, topK):
      scores = empty map (chunkId → number)
      for rank, chunkId in denseList:        // rank is 1-based
          scores[chunkId] += 1 / (k + rank)
      for rank, chunkId in sparseList:
          scores[chunkId] += 1 / (k + rank)  // same item accumulates
      sorted = chunkIds sorted by scores desc
      return sorted[:topK]                    // one fused ranked list
```

`k ≈ 60` is the conventional smoothing constant — it dampens the gap between rank 1 and rank 2 so a single list can't dominate. The output is one list, ready to hand to the agent exactly where `pipeline.query` returns today.

```
  Layers-and-hops — where fusion would slot in

  ┌─ pipeline ───┐ hop 1: embed → search (dense)  ┌─ agents.chunks ──┐
  │ query()      │ ─────────────────────────────► │ embedding (768)  │
  │ (NEW: also   │ hop 2: searchSparse (BM25)      │ content_tsv (05) │
  │  call sparse)│ ─────────────────────────────► └──────────────────┘
  └──────┬───────┘ hop 3: two lists back
         ▼
  ┌─ RRF fuse (NEW) ┐  sum 1/(k+rank) per chunk → one ranked list → top-k
  └─────────────────┘
```

**Step 4 — the boundary condition.** RRF assumes both lists are *roughly trustworthy*. If one retriever is badly miscalibrated (e.g. sparse returns garbage for conceptual queries), it still injects its top items into the fusion. RRF is robust but not magic — it dilutes a bad list rather than ignoring it. That's why you measure (precision@k before/after) rather than assume hybrid always wins.

### Move 3 — the principle

When you have multiple rankers with complementary strengths, fuse them by *rank*, not by *score* — because scores from different methods are incomparable, but positions always are. RRF is the parameter-free default for exactly this. The deeper lesson: the moment you have two opinions on the same question, the engineering problem shifts from "which retriever" to "how do I combine evidence" — and rank-fusion is the cheapest correct answer.

## Primary diagram

The fusion buffr would add, one frame:

```
  hybrid retrieval + RRF — the merge buffr doesn't have yet

  query
    ├─► DENSE  search(vector,k)        → [c7,c2,c9,c1,...]  (HAS)
    └─► SPARSE searchSparse(query,k)   → [c2,c5,c7,c3,...]  (needs 05)
                                              │
                       ┌──────────────────────▼──────────────────────┐
                       │ RRF (MISSING):  score(c) = Σ 1/(60 + rank)   │
                       │ rank, don't score; sum across both lists     │
                       └──────────────────────┬──────────────────────┘
                                              ▼
                                      one fused top-k list
  precondition: sparse lane (05) must exist first
```

## Elaborate

RRF comes from a 2009 IR paper (Cormack et al.) and won out over score-normalization approaches because it needs *no per-retriever calibration* — you don't have to learn how to map cosine scores onto BM25 scores, which is brittle and dataset-specific. It just works on positions. That parameter-freedom is why it's the default fusion in modern hybrid search (it's what Elasticsearch's and Weaviate's hybrid modes use under the hood).

For buffr specifically, hybrid is a *two-step* gap: there's no sparse lane to fuse (`05`) and no fusion function (this file). The honest sequencing is sparse-first, then RRF — and both only earn their place if an eval shows the combined list beats dense-alone on a query set that mixes conceptual and exact-term queries. Hybrid that isn't measured is just complexity.

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so Build-item IDs are not cited. Exercises are derived directly from the codebase and the spec's concept set.

### Implement RRF fusion over dense + sparse

- **Exercise ID:** RRF-1 (Case B — buffr has no fusion; add it).
- **What to build:** an `rrf(denseHits, sparseHits, k=60, topK)` function that sums `1/(k+rank)` per chunk across both lists and returns one ranked top-k; wire it into a `searchHybrid` that calls both `search` (`src/pg-vector-store.ts:67`) and the `searchSparse` from the `05` exercise.
- **Why it earns its place:** it's the standard, parameter-free way to combine retrievers, and it's the payoff that makes adding sparse worth it.
- **Files to touch:** new `src/retrieval/rrf.ts`, a `searchHybrid` orchestrator (in `src/session.ts` wiring or a small module), consuming both `PgVectorStore.search` and `searchSparse`.
- **Done when:** a chunk ranking well in *both* lanes outranks one ranking #1 in only one lane, proven by a unit test on the fusion function.
- **Estimated effort:** half a day.

### Prove hybrid beats dense-alone with precision@k

- **Exercise ID:** RRF-2 (Case B — measure before trusting).
- **What to build:** run the same mixed query set (conceptual + exact-term) through dense-only and hybrid, compare precision@k, and only keep hybrid if it wins overall.
- **Why it earns its place:** hybrid adds latency and complexity; it must earn its place with a number, not intuition.
- **Files to touch:** the eval path (`src/cli/eval-cmd.ts`), running `search` vs `searchHybrid`.
- **Done when:** you have a precision@k delta and a defensible keep/drop decision.
- **Estimated effort:** 1–4hr. Cross-link `../05-evals-and-observability/`.

## Interview defense

**Q: Does buffr do hybrid retrieval, and why is RRF the right way to combine retrievers?**
Answer: no — buffr is dense-only, so there's one list and nothing to fuse. RRF is the right combiner because cosine and BM25 scores live on incomparable scales (you can't average a `0.8` cosine with a `12.4` BM25), so RRF throws the scores away and combines by *rank position*: `score(item) = Σ 1/(k+rank)` across lists, `k≈60`. An item strong in both lists wins; it's parameter-free, so no per-retriever calibration.

```
  scores incomparable → fuse by RANK
  RRF(c) = Σ 1/(60 + rank_in_list)   strong in BOTH lists ⇒ wins
```

**Q: What's the precondition before you can add RRF to buffr?**
Answer: a second retriever. RRF fuses lists, and buffr has exactly one (cosine). So the order is: add the sparse `tsvector` lane first (`05`), giving two lists, *then* fuse with RRF — and only ship it if precision@k on a mixed query set beats dense-alone. The anchor: **the load-bearing trick people forget is that RRF uses rank, not score — that's what makes incomparable retrievers combinable with zero tuning.**

```
  add sparse lane (05) → two lists → RRF fuse → measure vs dense-only
```

## See also

- `05-dense-vs-sparse.md` — the sparse lane that must exist before fusion (the precondition).
- `07-reranking.md` — the *other* post-retrieval quality lever (rerank vs fuse).
- `01-embeddings.md` — why cosine scores aren't comparable to BM25 scores.
- `../05-evals-and-observability/` — measuring whether hybrid actually wins.
