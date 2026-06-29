# Search ranking system design

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
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ Candidate retrieval              │
  │  (dense ANN + sparse BM25, top-N)│
  └──────────────┬───────────────────┘
                 │  N candidates (N≈500)
                 ▼
  ┌──────────────────────────────────┐
  │ Ranking                          │
  │  (cross-encoder / learned model) │
  └──────────────┬───────────────────┘
                 │  top-k (k≈10)
                 ▼
  ┌──────────────────────────────────┐
  │ Serving + logging                │
  │  (cache, instrument, click logs) │
  └──────────────┬───────────────────┘
                 │
                 ▼
              Results
  ```

- **Data model:**
  - Corpus rows `{id, text, metadata, embedding}` — one per item; in buffr this is `chunks` with a 768-dim `nomic-embed-text` vector.
  - Vector index — embedding → doc IDs, ANN via HNSW cosine; buffr has this (HNSW index in `sql/001_agents_schema.sql`).
  - Inverted index — BM25 term → doc IDs for sparse retrieval; buffr does **not** have this.
  - Click/interaction logs `{query, doc_id, position, clicked, dwell_time}` — the training signal for a learned ranker; buffr has none.

- **Key components:**
  - *Query understanding*: rewrites the raw query for better recall (synonym expansion, typo correction, HyDE). Decision: rule-based on the hot path for latency, LLM-rewrite only for low-confidence queries.
  - *Candidate retrieval*: hybrid dense + sparse fused with RRF. Decision: keep both — sparse catches exact tokens (error codes, proper nouns), dense catches paraphrase.
  - *Ranking*: cross-encoder rerank over the top-N candidates. Decision: gate the reranker on the bi-encoder margin so cheap queries skip it and latency stays bounded.
  - *Serving*: cache top-k per query, instrument per-stage latency and recall@k. Decision: cache key is the normalized query so paraphrases miss — acceptable until QPS forces semantic caching.

- **Scale concerns:**
  - At ~100k chunks: a single-node HNSW index fits comfortably in RAM and exact-enough ANN holds; nothing to do — this is roughly where buffr lives.
  - At ~10M docs: the ANN index exceeds single-node RAM. Solution: shard by `app_id` (buffr already scopes every query by `app_id`), query shards in parallel, merge top-k.
  - At ~1k QPS: the cross-encoder reranker becomes the latency bottleneck. Solution: cache reranks for popular queries, distill the cross-encoder to a smaller model for cold queries.
  - Embedding-model upgrade is a one-way door: changing `nomic-embed-text` means re-embedding the entire corpus, because old and new vectors are not comparable. Solution: store `embedding_version` per chunk and dual-serve during migration.

- **Eval framing:**
  - Offline: hit@k, MRR, NDCG over a held-out query→relevant-doc set. buffr ships precision@1 and recall@3 — but over only **three rows** in `eval/queries.json`, which is a smoke test, not a ranking eval.
  - Online: click-through rate at positions 1–3, dwell time, query-reformulation rate (it drops when ranking is good). buffr logs none of this.
  - "No-click is not a negative label" — a user who reads the snippet and leaves got their answer; treating that as negative poisons the ranker.

- **Common failure modes:**
  - Stale index → query returns a deprecated chunk. Mitigation: track `embedding_stale_at`, re-embed on edit (buffr's `index-cmd.ts` re-runs embedding on re-index but has no staleness trigger).
  - Cold queries with no click history → nothing to learn from. Mitigation: fall back to sparse-only retrieval and similarity-to-known-queries.
  - Position bias in training data → the ranker learns "position 1 is good," not "this doc is good." Mitigation: inverse-propensity scoring or randomized result ordering in a fraction of sessions.
  - Dense-only blind spot → exact-token queries (an error code, an API name) get paraphrase-matched and miss. Mitigation: add the sparse leg; this is buffr's most concrete gap here.

- **Applies to this codebase:** **partially.** buffr's `embed → ANN → cosine top-k` path in `src/pg-vector-store.ts` *is* the candidate-retrieval layer of a search-ranking system, and the HNSW cosine index in `sql/001_agents_schema.sql` is exactly the dense index this template calls for. But that is only the bottom of the stack. There is no learned ranker over the candidates, no click or interaction logging, no query understanding or rewrite, and retrieval is dense-only — no sparse/BM25 leg. buffr's queries are question-style (feeding an agent loop) rather than search-style (returning a ranked list to a human), and the eval is precision@1/recall@3 over three rows in `eval/queries.json`, which can't measure ranking quality. buffr owns the retrieval spine and is missing everything above it.

- **How to make it apply:** Add a "search my corpus" surface that calls the existing `PgVectorStore.search` in `src/pg-vector-store.ts` and returns a ranked list directly to the user instead of into the agent. Log clicks (which result the user opens, at what position) into a new table — the existing `agents`-schema migration pattern in `sql/001_agents_schema.sql` is the template. Then add a reranker over the cosine top-50 before showing top-10, and cross-link the reranking + hybrid-retrieval concepts in `03-retrieval-and-rag/`. The dense index, the `app_id` scoping for sharding, and the re-embed path in `src/cli/index-cmd.ts` are already there — what's missing is the ranking layer and the click signal to train it.
