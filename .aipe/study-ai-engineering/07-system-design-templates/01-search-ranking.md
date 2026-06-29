# Search Ranking — interview reframe

## The prompt

> Design a search ranking system that takes a user query and returns the top-k most relevant items from a large corpus.

## Standard architecture

```
            Search ranking system — two-stage retrieve-then-rank
┌──────────────────────────────────────────────────────────────────────┐
│                              query                                     │
│                                │                                       │
│                                ▼                                       │
│                      ┌──────────────────┐                              │
│                      │  query understand │  rewrite / expand / embed   │
│                      └──────────────────┘                              │
│                                │                                       │
│                                ▼                                       │
│        ┌───────────────────────────────────────────────┐              │
│        │            CANDIDATE RETRIEVAL (recall)         │              │
│        │   dense ANN ──┐                                 │              │
│        │               ├──► union ──► ~hundreds of cands │              │
│        │   sparse BM25 ┘                                 │              │
│        └───────────────────────────────────────────────┘              │
│                                │                                       │
│                                ▼                                       │
│        ┌───────────────────────────────────────────────┐              │
│        │             RANKING (precision)                 │              │
│        │   feature build ──► learned ranker (LTR/cross-  │              │
│        │   encoder) ──► score & sort ──► top-k           │              │
│        └───────────────────────────────────────────────┘              │
│                                │                                       │
│                                ▼                                       │
│                       top-k results ──► UI                             │
│                                │                                       │
│                                ▼                                       │
│              ┌──────────────────────────────────┐                     │
│              │  interaction log (impressions,    │                     │
│              │  clicks, dwell) ──► training data │◄── feeds the ranker │
│              └──────────────────────────────────┘                     │
└──────────────────────────────────────────────────────────────────────┘
```

The load-bearing shape is two stages — cheap high-recall retrieval, then expensive high-precision ranking — plus a closed loop where interactions become the ranker's training signal.

## Data model

- **Inverted index (sparse)** — term → posting list of doc IDs; serves BM25 lexical candidate retrieval.
- **Vector index (dense)** — `(doc_id, embedding)` under an ANN structure (HNSW); serves semantic candidate retrieval. This is buffr's `agents.chunks.embedding vector(768)` with `chunks_embedding_hnsw`.
- **Document/feature store** — per-doc static features (length, freshness, popularity, source authority) used at ranking time.
- **Interaction log** — append-only `(query_id, doc_id, position, action, timestamp)` rows; impressions and clicks/dwell. This is what buffr does **not** have.
- **Learned-ranking model artifact** — versioned weights (LTR tree / cross-encoder) loaded by the ranking stage; retrained from the interaction log.

No markdown tables here on purpose — the relationships are flow, not a grid.

## Key components

- **Query understanding** — normalizes, rewrites, and embeds the query before retrieval; choice: rewrite/expand *before* embedding so the dense query vector matches search intent, not raw phrasing, because a bi-encoder embeds whatever string it's handed.
- **Candidate retrieval** — fans out to dense ANN and sparse BM25 and unions the result for high recall; choice: hybrid not pure-dense, because lexical and semantic miss different documents and the union recovers exact-term matches that cosine alone drops.
- **Ranking stage** — re-scores the few hundred candidates with a model that sees the (query, doc) pair jointly; choice: a cross-encoder or learned-to-rank model rather than reusing the bi-encoder cosine score, because the recall encoder is tuned to separate-then-compare, not to order a small set precisely.
- **Interaction logging** — records impressions and clicks as the ground-truth relevance signal; choice: log *impressions* (what was shown but not clicked) as well as clicks, because clicks without their impression set give you no negatives and you cannot train a ranker on positives alone.

## Scale concerns

Ordered by what breaks first for a system on buffr's trajectory:

- **Ranker latency, first.** At a few hundred candidates per query a cross-encoder pass is ~1 model call per candidate. At **~200 candidates and >10 QPS** the ranking stage dominates p99. Mitigation: cap the candidate set fed to the ranker (rerank tens, not hundreds) and cache rankings for hot queries.
- **ANN recall degradation, second.** HNSW recall and build cost degrade as the index grows. At **~1–10M vectors** default HNSW parameters (`m`, `ef_construction`) start trading recall for memory; you must tune `ef_search` per query. buffr is single-device and nowhere near this — but state the threshold.
- **Index freshness, third.** As ingest rate rises, the time between a doc landing and being searchable grows. At **>10k new docs/hour** a synchronous embed-on-write path (buffr's `index-cmd.ts`) blocks; you need an async indexing queue. Below that, synchronous is fine.
- **Training-data volume, fourth.** A learned ranker needs enough labeled interactions to beat the cosine baseline. Below **~10k–100k logged clicks** the learned ranker overfits and loses to plain cosine; don't ship the ranker until the log is large enough to validate it.

## Eval framing

- **Offline, per-deploy:** NDCG@k and MRR over a held-out judged set; for buffr today the proxy is **precision@1 / recall@3** over `eval/queries.json` (`scorePrecisionAtK` / `scoreRecallAtK` in `src/cli/eval-cmd.ts`). NDCG is the upgrade once you have graded (not binary) relevance.
- **Offline ranker gate:** does the learned ranker beat the cosine baseline on the same golden set? If not, don't deploy it — this is the literal hit@k before/after measurement the reranking exercise demands.
- **Online, per-deploy:** click-through-rate at position, time-to-first-click, and the rate of queries with zero clicks (abandonment). These need the interaction log buffr lacks.
- **The trap:** offline NDCG can rise while online CTR falls if your judged set doesn't match real query distribution. Buffr's golden queries are paraphrase-style, not search-style — so even buffr's offline metric is measuring a slightly different task than "search ranking."

## Common failure modes

- **Single-stage retrieval marketed as ranking.** Interviewer probe: "your cosine `order by` *is* your ranking?" Failure: bi-encoder cosine orders for recall, not precision. Mitigation: name the two-stage split out loud and add a reranking stage over the over-fetched candidate pool.
- **Position bias in the click log.** Probe: "users click position 1 because it's position 1." Failure: training on raw clicks teaches the ranker to reproduce its own current ordering. Mitigation: log impressions, model position bias (e.g. inverse-propensity weighting), or randomize within the top slot to collect unbiased pairs.
- **Pure-dense retrieval missing exact-match queries.** Probe: "user searches a SKU / an exact phrase — does cosine find it?" Failure: dense embeddings smear exact tokens. Mitigation: add sparse BM25 to the candidate union (hybrid) and fuse with RRF.
- **Query/eval distribution mismatch.** Probe: "are your eval queries what users actually type?" Failure: paraphrase-style golden queries flatter a paraphrase-tuned retriever. Mitigation: sample real queries from the interaction log into the judged set.

## Applies to this codebase

**Partially.** buffr's `RetrievalPipeline` + `PgVectorStore` is exactly the **candidate-retrieval stage** of this design and nothing more. It embeds the query (`OllamaEmbeddingProvider`, `nomic-embed-text:v1.5`), runs a cosine ANN over an HNSW index (`order by embedding <=> $1::vector ... limit $3` in `src/pg-vector-store.ts:67`), and returns ranked-by-distance chunks with a `1 - distance` score. That is a real, working, single-stage retriever with a real offline eval (`precision@1` / `recall@3` in `src/cli/eval-cmd.ts`). But the parts that make this a *search ranking system* are absent: there is no learned ranker (the ordering is pure cosine distance, no second-stage model), no interaction/click logging (`agents.messages` captures the agent trajectory, never search impressions or clicks), no sparse/hybrid retrieval (pure dense), and no query rewriting (it embeds the raw question). And the queries in `eval/queries.json` are paraphrase-style "ask my notes a question," not lexical search queries. So buffr is the bottom third of the diagram, honestly built, with the top two-thirds and the feedback loop missing. Claim it as the retrieval layer; do not claim it as a ranking system.

## How to make it apply

Three refactors, in dependency order, each in buffr's real files:

1. **Add a "search my notes" surface over the existing retrieval.** `pipeline.query(query, K)` already returns ranked hits — expose them directly as a result list (a new CLI command alongside `src/cli/index-cmd.ts`, or a thin wrapper in `src/session.ts`) instead of only feeding them to the agent. This is the impressions surface; it changes no retrieval code, it just stops hiding the ranked list inside the answer path.

2. **Log opens as a click signal.** When a user opens/expands a returned chunk, write an interaction row. The schema gap is real: `sql/001_agents_schema.sql` has `chunks`, `documents`, `conversations`, `messages` — no interaction table. Add `agents.search_interactions (query text, doc_id text, position int, action text, created_at timestamptz)` as a new migration. Persist via the same `pool.query` pattern `persistMessage` already uses in `src/supabase-trace-sink.ts`. Now you have negatives (shown-not-opened) and positives (opened).

3. **After enough clicks, add a learned reranker over the cosine candidates.** This is the same gap already scoped as exercise **[B2B.6]** in `../03-retrieval-and-rag/07-reranking.md`: over-fetch top-N by cosine (the `search_knowledge_base` tool already over-fetches via `minTopK`), score each (query, chunk) pair with a `gemma2:9b` judge pass — or, once the interaction log is large, a model trained on those clicks — reorder, keep top-k. Gate it on the offline eval in `src/cli/eval-cmd.ts`: measure hit@k before and after, ship only if it beats the cosine baseline. Pair with **[B2B.7]** if you also want to place the top result for the agent's context window.

Defended this way, "design a search ranking system" becomes: *"I built the candidate-retrieval stage — embed, HNSW cosine ANN, offline precision@1/recall@3. To make it a ranking system I'd surface the ranked list, log opens as clicks into a new interactions table, and add the [B2B.6] reranker gated on hit@k. Here's the file for each."* That is a strong partial, not a weak yes.
