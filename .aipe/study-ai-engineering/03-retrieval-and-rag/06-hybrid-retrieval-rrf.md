# Hybrid Retrieval & Reciprocal Rank Fusion

### *industry: hybrid retrieval / reciprocal rank fusion (RRF) · type: combining two relevance signals into one ranking*

## Zoom out

The last file ended on a cliffhanger: buffr should have both a dense and a sparse channel. This file answers the question that creates — *once you have two rankings, how do you merge them into one?* The answer is fusion, and the workhorse is RRF.

**buffr's retrieval stack, the fusion layer marked**

```
┌──────────────────────────────────────────────────────────────┐
│  search_knowledge_base  one final ranked list                  │
├──────────────────────────────────────────────────────────────┤
│  ★ FUSION (RRF) ★       merge dense + sparse rankings          │  ◄── this file
│                         NOT IMPLEMENTED — buffr is dense-only  │
├──────────────────────────────────────────────────────────────┤
│  dense channel          cosine  │  sparse channel  BM25/FTS    │
└──────────────────────────────────────────────────────────────┘
```

You've never built this — buffr doesn't have it. So this file is mechanism-first: what RRF *is*, why it beats naive score-averaging, and exactly where it would slot into buffr's query path.

## Structure pass

The axis is **how you combine two ranked lists**. The seam is whether you combine their *scores* (fragile) or their *ranks* (robust).

**Score fusion vs. rank fusion**

```
   SCORE FUSION (fragile)            RANK FUSION / RRF (robust)
   ─────────────────────            ──────────────────────────
   add cosine + BM25 scores         ignore scores, use POSITION
   but: cosine ∈ [0,1],             rrf = Σ 1/(k + rank_in_list)
        BM25 ∈ [0, ∞)               same units across lists
   needs normalization,             no normalization needed
   sensitive to scale               ┌──────────────────────┐
   ┌──────────────────┐   ──seam──► │ rank, not magnitude  │
   │ a + b (unitless?)│             └──────────────────────┘
   └──────────────────┘
        the seam: do you trust the numbers, or just the order?
```

Left of the seam: averaging raw scores requires the two scales to be comparable — they aren't (cosine is bounded, BM25 is unbounded), so you fight normalization forever. Right of the seam: RRF throws scores away and fuses *ranks*, which are already on the same scale (1st, 2nd, 3rd). Consequence: RRF is robust precisely because it refuses to trust incomparable numbers.

## How it works

### Move 1 — Mental model: two judges, score by placement not by points

Two judges rank ten dishes. One scores 0–100, the other 0–10. Averaging their raw points is nonsense — the 0–100 judge dominates. Instead, you reward each dish by its *placement* on each judge's list: 1st place is worth a lot, 10th place little, and a dish that places high on *both* lists wins. That's RRF.

**RRF: reward agreement in placement**

```
  dense ranking      sparse ranking      RRF (k=60)
  ─────────────      ──────────────      ──────────
  1. chunkA          1. chunkC           chunkC: 1/(60+2) + 1/(60+1) = high
  2. chunkC          2. chunkA           chunkA: 1/(60+1) + 1/(60+2) = high
  3. chunkB          3. chunkE           chunkB: 1/(60+3) + 0        = low
                                          ▲ ranks high on BOTH ──► wins
```

Frontend bridge: it's merging two sorted result lists in a search UI where one source is "semantic matches" and the other "title matches." You don't add their internal scores — you interleave by rank and boost anything appearing in both. RRF is that interleave with a precise formula.

### Move 2 — Walk the mechanism

**Part A — The RRF formula**

For each document, sum `1/(k + rank)` across every list it appears in. `k` (commonly 60) dampens how much the very top rank dominates. A doc absent from a list simply contributes 0 from that list.

**The fusion math**

```
  RRF_score(doc) = Σ over lists L:  1 / (k + rank_L(doc))

  k = 60 (standard)
  rank starts at 1 (top)

  doc in dense @ rank 2, sparse @ rank 1:
    1/(60+2) + 1/(60+1) = 0.01613 + 0.01639 = 0.03252
  doc in dense @ rank 1 only:
    1/(60+1) + 0        = 0.01639
  ──► the doc both channels agree on outranks the doc only one found
```

There's no buffr code to cite here — this stage does not exist. That's the honest centerpiece of the file: RRF is the *mechanism buffr is missing*, sitting exactly between its two (one real, one hypothetical) channels.

**Part B — Where it slots into buffr**

The fusion lives in the store/pipeline boundary: run both searches, fuse, return the top-k in buffr's existing `Hit` shape so nothing above it changes.

**The hybrid query path**

```
  query
    │
    ├──► dense:  embed ──► order by embedding <=> q  ──► [ranked list D]
    │
    └──► sparse: tsvector @@ tsquery ──► ts_rank      ──► [ranked list S]
                                                            │
                            ┌───────── RRF fuse ────────────┘
                            ▼
              one ranking, top-k, same Hit{id,score,meta} shape
                            │
                            ▼
              search_knowledge_base sees no difference
```

The design constraint that makes this clean: buffr's `VectorStore.search` already returns `Hit{id, score, meta}`. A hybrid search returns the *same shape* — so `search_knowledge_base`, the tool, the agent, and citations all keep working unchanged. Fusion is an internal upgrade to the store, invisible above it. That's the contract paying off again.

### Move 2.5 — Current vs. future

**Case B: neither the sparse channel nor RRF exists in buffr today.**

```
  TODAY                              HYBRID (this is the gap)
  ─────                              ────────────────────────
  dense only                         dense + sparse, fused by RRF
  one order by                       two queries, one fusion
  ┌──────────────┐                   ┌──────────────────────────┐
  │ cosine ──► k │                   │ cosine ─┐                 │
  └──────────────┘                   │ FTS ────┴─► RRF ──► top-k │
   exact tokens weak,                └──────────────────────────┘
   no agreement signal                exact tokens + paraphrase both win;
                                       docs both channels agree on rank up
```

Two things are missing: the sparse channel (file 05's exercise) and the fusion (this file's exercise). They're a pair — RRF has nothing to fuse without the second channel, and a second channel needs fusion to combine with the first. Build sparse first, then RRF on top.

### Move 3 — The principle

**Fuse by rank, not by score, because ranks are comparable and scores aren't.** RRF's power is that it makes *no assumption* about the two channels' score scales — it only trusts their ordering and rewards agreement. That robustness is why it's the default fusion across the industry despite being almost trivially simple. buffr's gap here is downstream of its dense-only gap: you can't fuse one channel. The lesson is the dependency order — channel, then fusion.

## Primary diagram

The full hybrid path buffr would gain.

**Two channels in, one RRF ranking out**

```
  query ──┬──► DENSE  embed → cosine over chunks      → rank list D
          │
          └──► SPARSE tsvector @@ tsquery → ts_rank    → rank list S
                                                            │
                        RRF: score(doc) = Σ 1/(60 + rank)   │
                        ──────────────────────────────────◄─┘
                                  │
                                  ▼
                     fused top-k, Hit{id,score,meta} (unchanged shape)
                                  │
                                  ▼
                     search_knowledge_base → RagQueryAgent → answer
```

After the box: every layer above the store is untouched — the upgrade is entirely inside the retrieval boundary, which is exactly why the existing contract makes it safe to add.

## Elaborate

- **Why k = 60.** It's the value from the original RRF paper, and it's stuck because it works. Smaller `k` lets the very top ranks dominate; larger `k` flattens the contribution curve. It's a damping constant, not a tuned-per-corpus knob, though you *can* sweep it.
- **RRF beats weighted score-sum in practice.** Weighted sums need per-channel normalization and a weight you must tune; they break when one channel's score distribution shifts. RRF needs neither — it's parameter-light and channel-agnostic. Reach for the fragile version only if you have a measured reason.
- **Agreement is the signal.** The deep reason hybrid beats either channel: a doc that *both* a meaning-matcher and a term-matcher rank highly is very likely relevant. RRF operationalizes "both judges liked it."
- **It generalizes past two channels.** RRF fuses any number of rankings — add a reranker's ordering as a third list later. The formula doesn't care how many lists.

## Project exercises

### Implement RRF fusion over dense + sparse

- **Exercise ID:** [B2B.4] (cite [C2.5], Phase 2B) — Case B: hybrid retrieval is **not implemented** in buffr. This is the primary target (depends on the sparse channel from [B2B.2]).
- **What to build:** A `searchHybrid(query, k)` on `PgVectorStore` (or a wrapper) that runs the dense and sparse searches, fuses by RRF (`k=60`), and returns the top-k in the standard `Hit` shape.
- **Why it earns its place:** It's the missing fusion that turns two weak-in-different-ways channels into one strong ranking, and it lands entirely inside the existing store contract — zero ripple above it.
- **Files to touch:** `src/pg-vector-store.ts` (add the hybrid method using the dense path + the sparse method from [B2B.2]); wire it in `src/cli/index-cmd.ts`/`src/session.ts` if made selectable.
- **Done when:** `eval-cmd` shows hybrid P@1/R@3 meets or beats dense-only, and an exact-token query that dense missed now ranks correctly via fusion.
- **Estimated effort:** 1 day (after sparse exists).

### A/B dense vs. hybrid on the eval set

- **Exercise ID:** [B2B.5] (cite [C2.5], Phase 2B) — Case B: proves the fusion earned its complexity.
- **What to build:** Run `eval-cmd` against dense-only and hybrid back-to-back on the same corpus and tabulate the delta per query. Include the exact-token queries from [B2B.3].
- **Why it earns its place:** Hybrid adds complexity; you only keep complexity that the eval rewards. This is the evidence that decides whether RRF stays.
- **Files to touch:** `src/cli/eval-cmd.ts` (run both modes), `eval/queries.json`.
- **Done when:** A per-query table shows where hybrid wins, loses, or ties vs. dense, and you can defend keeping or dropping it.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: "Why RRF instead of averaging the two scores?"**

Because cosine and BM25 live on incomparable scales — cosine is bounded, BM25 is unbounded — so averaging needs fragile normalization. RRF ignores scores and fuses *ranks*, which are already comparable, and rewards docs both channels rank highly. Parameter-light and robust.

```
  scores ──► incomparable units ──► fragile
  ranks  ──► same units ──► RRF: Σ 1/(60+rank)
```

Anchor: *"Fuse the order, not the numbers."*

**Q: "What does buffr need before it can do hybrid?"**

A second channel. buffr is dense-only, and RRF has nothing to fuse with one ranking. So: add a Postgres FTS sparse channel first, then layer RRF on top. They're a dependency pair, in that order.

```
  dense only ──► add sparse (FTS) ──► RRF fuse
```

Anchor: *"No fusion without a second channel."*

## See also

- `./05-dense-vs-sparse.md` — the second channel RRF needs; build it first.
- `./07-reranking.md` — a different precision stage; its ordering can become a third RRF list.
- `./04-vector-databases.md` — the store contract that keeps fusion invisible to everything above it.
- `../../study-dsa-foundations/` — merging ranked lists, scoring, and rank statistics.
