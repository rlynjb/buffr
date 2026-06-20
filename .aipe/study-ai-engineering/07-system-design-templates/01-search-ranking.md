# System design template — search ranking

> Interview reframe, not a codebase pattern. The 9-bullet shape is fixed (requirements → data → architecture → scale → eval → failure). The "Applies to this codebase" and "How to make it apply" bullets are answered about buffr's real files.

- **The prompt:** "Design a search ranking system that takes a user query and returns the top-k most relevant items from a corpus."

- **Standard architecture:**

```
  Query
    │
    ▼
  ┌──────────────────────────────────┐
  │ Query understanding              │
  │  (tokenize, expand, rewrite)     │
  └──────────────┬───────────────────┘
                 ▼
  ┌──────────────────────────────────┐
  │ Candidate retrieval              │
  │  (dense + sparse, top-N)         │
  └──────────────┬───────────────────┘
                 │  N candidates
                 ▼
  ┌──────────────────────────────────┐
  │ Ranking                          │
  │  (cross-encoder, learned model)  │
  └──────────────┬───────────────────┘
                 │  top-k
                 ▼
  ┌──────────────────────────────────┐
  │ Serving + logging                │
  │  (cache, instrument, return)     │
  └──────────────┬───────────────────┘
                 ▼
              Results
```

- **Data model:**
  - Document corpus with `{id, text, metadata, created_at, embedding}` per item.
  - Vector index for dense retrieval (embedding → doc IDs, ANN via HNSW).
  - Inverted index for sparse retrieval (BM25 / tsvector term → doc IDs).
  - Click/interaction logs `{query, doc_id, position, clicked, dwell}` for offline learning.

- **Key components:**
  - *Query understanding*: rewrite for better recall (synonym expansion, HyDE). Decision: rule-based for latency, LLM-rewrite only for hard queries.
  - *Retrieval*: hybrid dense + sparse, fused with RRF. Decision: keep both — sparse catches exact terms, dense catches paraphrases.
  - *Ranking*: cross-encoder rerank on the top-N. Decision: rerank only when bi-encoder margin is low, to bound latency.
  - *Serving*: cache top-k per query, instrument latency-per-stage and recall@k.

- **Scale concerns:**
  - At ~10M docs: ANN index exceeds single-node RAM. Solution: shard by doc-id range, query shards in parallel.
  - At ~1k QPS: cross-encoder rerank is the latency bottleneck. Solution: cache reranks for hot queries, distill to a smaller model.
  - At ~100M+ docs: full re-embed on model upgrade is multi-day. Solution: `embedding_version` per doc, dual-serve during migration.

- **Eval framing:**
  - Offline: hit@k, MRR, NDCG on a held-out query→doc relevance set.
  - Online: click-through at positions 1–3, dwell, query-reformulation rate.
  - "No-click is not a negative label" — a user reading the snippet and leaving isn't a bad result.

- **Common failure modes:**
  - Stale index → query returns deprecated docs. Mitigation: `embedding_stale_at` tracking, re-embed on edit.
  - Cold queries → no click data. Mitigation: query-similarity fallback, sparse-only retrieval.
  - Position bias in training data → model learns "position 1 is good." Mitigation: inverse propensity scoring or randomized sessions.
  - Lost-in-the-middle if results feed a downstream LLM. Mitigation: surface top-3 only.

- **Applies to this codebase:** `partially`. buffr is precisely the *retrieval* layer of a search ranking system — `PgVectorStore.search` (`src/pg-vector-store.ts:67`) is dense candidate retrieval over an HNSW cosine index, and `eval-cmd.ts` already scores precision@1/recall@3, which are the offline IR metrics this template asks for. What's missing is everything above and below retrieval: no query understanding/rewrite, no sparse index so no hybrid (dense-only, see `02-rag-query-path.md`), no cross-encoder rerank (top-k from `<=>` is final), no click logging (queries are paraphrase-style, not search-style with interaction signal), and no serving cache. So buffr is the retrieval stage of this template, scored — but not the ranking, query-understanding, or learning-from-clicks stages.

- **How to make it apply:** Three concrete steps against buffr's files. (1) Add a sparse path: a `tsvector` column + GIN index in `sql/001_agents_schema.sql` and a `searchSparse` + RRF merge in `src/pg-vector-store.ts` — this is the "add hybrid retrieval" exercise from `02-rag-query-path.md`. (2) Add click logging: a `search_logs` table and a CLI/UI surface that records which result the user opened, giving you the interaction signal a learned ranker needs. (3) After enough logged clicks, introduce a reranker over the cosine top-k and measure the lift with `eval-cmd.ts` before and after — the measure-then-add discipline. Each step is defensible in an interview as "I built retrieval, here's exactly how I'd grow it into a ranked search system, and here's the eval that proves each addition earns its place."
