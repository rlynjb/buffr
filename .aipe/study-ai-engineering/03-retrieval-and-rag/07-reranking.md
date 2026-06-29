# Reranking

### *industry: reranking / cross-encoder reordering · type: the precision stage after recall*

## Zoom out

Everything so far has been about *recall* — getting candidate chunks into the result set. Reranking is the *precision* stage that runs after: take the candidates and reorder them so the genuinely-best one is on top. buffr stops at recall.

**buffr's retrieval stack, the missing precision stage marked**

```
┌──────────────────────────────────────────────────────────────┐
│  search_knowledge_base  returns top-k                          │
├──────────────────────────────────────────────────────────────┤
│  ★ RERANK ★             reorder candidates by true relevance  │  ◄── this file
│                         NOT IMPLEMENTED — single-stage ANN only│
├──────────────────────────────────────────────────────────────┤
│  PgVectorStore          cosine top-k (recall)                  │
└──────────────────────────────────────────────────────────────┘
```

You shipped single-stage retrieval before, so you've felt this: the cosine top-1 is *usually* right but sometimes the actually-best chunk sits at rank 3. Reranking is the standard fix, and buffr doesn't have it. This file is mechanism-first.

## Structure pass

The axis is **how the query and document are scored together**. The seam is whether they're embedded *separately* (cheap, approximate) or *jointly* (expensive, accurate).

**Bi-encoder vs. cross-encoder**

```
   BI-ENCODER (buffr's recall)       CROSS-ENCODER (reranking)
   ──────────────────────────       ─────────────────────────
   embed query alone                 feed [query + doc] TOGETHER
   embed doc alone (offline)         into one model, get a score
   compare with cosine               sees their interaction directly
   fast: docs pre-embedded           slow: one model pass PER candidate
   ┌──────────────────┐              ┌──────────────────┐
   │ q→v  d→v  cos    │   ──seam──►  │ score(q, d)      │
   └──────────────────┘              └──────────────────┘
        the seam: are q and d scored apart, or together?
```

Left of the seam: the bi-encoder embeds query and doc independently, so docs are pre-computed and search is a fast cosine lookup — but the model never *sees the pair together*, so it misses subtle query-doc interactions. Right of the seam: the cross-encoder reads query and doc jointly and scores their actual relevance — accurate, but it must run once *per candidate*, so you can't run it over the whole corpus. Consequence: you use the cheap bi-encoder to get ~50 candidates, then the expensive cross-encoder to reorder just those.

## How it works

### Move 1 — Mental model: a fast filter then a careful judge

Hiring: you screen 500 resumes with a keyword filter (fast, approximate) down to 20, then a human reads those 20 carefully (slow, accurate) to rank them. You'd never read all 500 carefully, and you'd never hire off the keyword filter alone. Recall is the filter; reranking is the careful read.

**Two stages, two costs**

```
  corpus (all chunks)
        │ STAGE 1: bi-encoder cosine  (cheap, run over everything)
        ▼
  top-N candidates (e.g. 50)          ◄── high recall, rough order
        │ STAGE 2: cross-encoder      (costly, run over just N)
        ▼
  top-k reranked (e.g. 4)             ◄── high precision, true order
```

Frontend bridge: it's pagination's "load 50, render 4." You over-fetch cheaply, then do the expensive layout/sort only on the small set you'll actually show. Reranking over-fetches by cosine, then sorts the small set by a costly judge.

### Move 2 — Walk the mechanism

**Part A — buffr's recall is single-stage (the honest state)**

buffr returns whatever the cosine order gives. There is no second pass. The order the model sees is raw bi-encoder similarity.

**The single stage**

```
  query ──► embed ──► order by embedding <=> q ──► top-k ──► model
                      ▲
            the order the model sees = raw cosine
            (no reorder by a precision model)
```

```ts
// src/pg-vector-store.ts:74-76 — recall order is final
`order by embedding <=> $1::vector
 limit $3`
```

That `order by` is both the recall *and* the final ranking. Whatever cosine thinks is nearest becomes what `search_knowledge_base` returns, in that order. If the truly-best chunk is cosine-rank 3, it stays rank 3 — and with buffr's `minTopK:4` it at least survives into the set, but it's not promoted to the top where the model attends hardest.

**Part B — Where a reranker would slot in**

Over-fetch a larger candidate set, score each with a cross-encoder (or an LLM-judge pass), keep the reordered top-k. Same `Hit` shape out.

**The two-stage path**

```
  query
    │ STAGE 1 (recall): order by cosine ──► top-N (e.g. 20)
    ▼
  candidates ──► STAGE 2 (rerank):
                 for each candidate: score = crossEncoder(query, chunk.text)
                 sort by score desc, take top-k (e.g. 4)
    │
    ▼
  reranked Hit[] (same shape) ──► search_knowledge_base unchanged
```

The plug point is precise: `pipeline.query(query, fetchK)` already over-fetches when `search_knowledge_base` filters (`fetchK = topK * 4`, `search-knowledge-base-tool.ts:88`) — that over-fetch is *exactly* the candidate pool a reranker wants. The reranker slots between that fetch and the final slice. buffr has the over-fetch wiring; it just doesn't have a reranker to feed it.

### Move 2.5 — Current vs. future

**Case B: buffr has NO reranking. It's single-stage ANN only.**

```
  TODAY                              TWO-STAGE (this is the gap)
  ─────                              ───────────────────────────
  cosine top-k = final order         cosine top-N ──► rerank ──► top-k
  best chunk may sit at rank 3       best chunk promoted to rank 1
  ┌──────────────┐                   ┌────────────────────────────┐
  │ recall only  │                   │ recall ──► precision        │
  └──────────────┘                   │ (cross-encoder / LLM judge) │
   no precision stage                └────────────────────────────┘
```

This is the same gap `../02-context-and-prompts/02-lost-in-the-middle.md` names from the other side: that file cares that the best chunk lands in a high-attention *position*; this file cares that it's *identified* as best in the first place. They're joined — you rerank to find the best chunk, then place it at an edge. buffr does neither.

### Move 3 — The principle

**Recall and precision are two jobs; one cheap model can't do both well.** The bi-encoder is optimized to *not miss* relevant chunks across a huge corpus — that's recall. The cross-encoder is optimized to *correctly order* a small set — that's precision. Single-stage retrieval asks the recall model to also be the precision model, and it's mediocre at the second job by design. The two-stage pattern is the standard answer because it lets each model do the one thing it's good at. buffr is honest single-stage: fine for a tiny corpus where rank-3 still survives the `minTopK:4` net, a real gap as the corpus grows.

## Primary diagram

The full two-stage path buffr would gain, measured.

**Recall stage, precision stage, and the measurement that justifies it**

```
  query
    │ STAGE 1 — recall (cheap, exists)
    ▼ order by embedding <=> q ──► top-N candidates (over-fetch, e.g. 20)
    │
    │ STAGE 2 — precision (costly, MISSING)
    ▼ score = crossEncoder(query, chunk) for each ──► sort ──► top-k
    │
    ▼ reranked Hit[] ──► place best at edge (lost-in-the-middle) ──► model
  ───────────────────────────────────────────────────────────────────
  JUSTIFY IT: measure hit@k before vs after rerank on eval/queries.json
              keep the stage only if precision actually rises
```

After the box: the reranker only earns its latency cost if hit@k measurably improves — which is why the exercise is "measure, then keep," not "add it because everyone does."

## Elaborate

- **Cross-encoder vs. LLM-as-judge.** A dedicated cross-encoder (e.g. a bge-reranker) is the trained, fast option. An LLM-judge pass (ask gemma2:9b to rate each candidate's relevance) is the no-extra-model option buffr could reach for first, at higher latency. For a laptop agent, the LLM-judge route is the lower-friction prototype.
- **Reranking is latency you pay per query.** Stage 2 runs a model pass per candidate, online, in the request path — unlike embeddings, which are precomputed offline. That's why you rerank a *small* candidate set (tens), never the corpus.
- **It pairs with placement, not replaces it.** Even a perfect reranker doesn't fix lost-in-the-middle unless you then *place* the top chunk at a high-attention slot. Rerank finds the best; placement uses it. Both files, one fix.
- **Over-fetch is already there.** `search_knowledge_base` over-fetches `topK*4` when filtering. A reranker can reuse that pool — buffr has the recall headroom, just not the second-stage scorer.

## Project exercises

### Add an LLM-judge reranking stage and measure hit@k

- **Exercise ID:** [B2B.6] (cite [C2.6], Phase 2B) — Case B: reranking is **not implemented** (single-stage ANN only). This is the primary target.
- **What to build:** Over-fetch top-N by cosine, score each candidate's relevance to the query with a gemma2:9b judge pass, reorder, keep top-k. Measure hit@k on `eval/queries.json` before and after.
- **Why it earns its place:** It's the named precision gap, and the over-fetch wiring already exists in `search_knowledge_base`. Using the local model avoids adding a second model dependency — lowest-friction way to prove the stage pays.
- **Files to touch:** a rerank step around `pipeline.query` (consumed by `src/session.ts`/the tool); reuse the `GemmaModelProvider` already wired in `src/session.ts`; verify with `src/cli/eval-cmd.ts`.
- **Done when:** hit@k is measured before and after reranking on the eval set, and you can state whether the precision gain justifies the per-query latency.
- **Estimated effort:** 1–2 days.

### Wire rerank to placement (close the lost-in-the-middle loop)

- **Exercise ID:** [B2B.7] (cite [C2.6], Phase 2B) — Case B: ties this file to `../02-context-and-prompts/02-lost-in-the-middle.md` [B1.3].
- **What to build:** After reranking, position the single top chunk at the start or end of the injected block so it lands in a high-attention slot, not buried mid-context.
- **Why it earns its place:** Reranking without placement leaves the win on the table — the best chunk can still fall into the attention valley. This makes precision actually reach the model.
- **Files to touch:** `src/session.ts` (assemble the injected block ordering); cross-reference `../02-context-and-prompts/02-lost-in-the-middle.md`.
- **Done when:** For a fixed query, the reranker's top chunk is provably at an edge of the injected block and answer quality holds or improves.
- **Estimated effort:** 1 day (after [B2B.6]).

## Interview defense

**Q: "Why does single-stage retrieval need a reranker?"**

Because the bi-encoder is tuned for recall, not precise ordering — it embeds query and doc separately and never sees the pair together. A cross-encoder scores the pair jointly, so it orders a small candidate set far better. You recall cheaply with the bi-encoder, then rerank the top-N precisely.

```
  bi-encoder ──► recall (q, d apart) ──► rough order
  cross-encoder ──► precision (q, d together) ──► true order
```

Anchor: *"Recall and precision are two models' jobs."*

**Q: "Where would it slot into buffr, and what's the cost?"**

Between the cosine over-fetch and the final top-k — `search_knowledge_base` already over-fetches `topK*4`, so the candidate pool exists. The cost is a model pass per candidate, online, per query — so you rerank tens, never the corpus, and you keep it only if hit@k measurably improves.

```
  cosine top-N (have it) ──► rerank N (missing) ──► top-k
  cost: one model pass per candidate, in-request
```

Anchor: *"Single-stage today — precision is the open, measurable gap."*

## See also

- `../02-context-and-prompts/02-lost-in-the-middle.md` — placement: rerank finds the best chunk, this positions it.
- `./06-hybrid-retrieval-rrf.md` — a reranker's ordering can become a third RRF list.
- `./11-rag.md` — where the reranked, placed chunks become the grounded answer.
- `../05-evals-and-observability/` — hit@k, the metric that decides if reranking stays.
