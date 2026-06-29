# Recommender System

### *interview reframe · fixed 9-bullet shape · Phase 5 anchor C5.11*

---

**The prompt:** Design a recommender that surfaces N items per user out of a catalog of M items, maximizing engagement.

---

**Standard architecture**

```text
┌──────────────────────────── RECOMMENDER (top-to-bottom) ────────────────────────────┐
│                                                                                      │
│   user + context (user_id, session, recent events)                                   │
│            │                                                                          │
│            ▼                                                                          │
│   ┌──────────────────┐     learned from interaction logs (clicks, dwell, buys)       │
│   │ CANDIDATE GEN    │ ◄── content embeddings + collaborative (user×item) factors    │
│   │ M items → ~1000  │                                                                │
│   └────────┬─────────┘                                                                │
│            │ candidate set                                                            │
│            ▼                                                                          │
│   ┌──────────────────┐     learned ranker scores P(engage | user, item, context)     │
│   │ RANKER (scoring) │ ◄── gradient-boosted trees / two-tower / DLRM                  │
│   │ ~1000 → scored   │                                                                │
│   └────────┬─────────┘                                                                │
│            │ scored candidates                                                        │
│            ▼                                                                          │
│   ┌──────────────────┐     dedupe, diversity, business rules, freshness              │
│   │ RE-RANK / POLICY │                                                                │
│   └────────┬─────────┘                                                                │
│            │ top-N                                                                     │
│            ▼                                                                          │
│   ┌──────────────────┐                                                                │
│   │ SERVE  (N items) │ ──► impression + click logged ──┐                              │
│   └──────────────────┘                                 │                              │
│                                                        ▼                              │
│   ┌──────────────────────────────────────────────────────────────┐                  │
│   │ FEEDBACK LOOP → interaction log → nightly retrain → new model │                  │
│   └──────────────────────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

---

**Data model**

- **Item catalog** — one row per recommendable item with its content features; the M-side of the problem.
- **Item embedding** — a dense vector per item (content-based signal); enables similarity-based candidate generation.
- **User × item interaction log** — append-only (user_id, item_id, event_type, timestamp); the collaborative signal and the training label source.
- **User profile / embedding** — aggregated taste vector per user; the query into the candidate generator.
- **Model artifact + version** — the trained ranker weights, versioned so a regression can be rolled back.

---

**Key components**

- **Candidate generator** — narrows M (millions) to ~1000 cheap candidates per request; choose **approximate nearest-neighbor over item embeddings** (HNSW) so candidate gen is sublinear, not a full catalog scan.
- **Ranker** — scores each candidate's engagement probability; choose **gradient-boosted trees for tabular interaction features** when the catalog is small-to-mid and interpretability matters, a two-tower net when you need to embed both sides and serve at scale.
- **Re-rank / policy layer** — applies diversity, freshness, and business rules the learned score ignores; choose a **deterministic post-filter** over baking rules into the model so policy changes ship without a retrain.
- **Feedback loop** — turns served impressions and clicks into next day's labels; choose **logged-impression joins** (every served item logged, clicked or not) so the training set isn't survivorship-biased toward only clicked items.

---

**Scale concerns** (ordered by which hits first)

- **At one user (buffr's reality), the collaborative signal is structurally empty.** Collaborative filtering needs a user×item matrix with overlap across users; with N=1 the matrix is a single row and there is nothing to factorize. This breaks *immediately*, before any scale concern — buffr is permanent cold-start (see `../08-machine-learning/11-cold-start.md`).
- **At ~10k catalog items, brute-force candidate scoring stops being free.** A full scan + score per request is fine at hundreds; past ~10k items it dominates latency and you must move candidate gen behind an ANN index (buffr already has one: the HNSW index `chunks_embedding_hnsw`).
- **At ~1M interactions, nightly full retrains stop fitting the batch window.** The training job's wall-clock grows with log size; past ~1M events you switch to incremental/online updates or sampled training rather than retraining on the full history each night.
- **At any real traffic, the feedback loop creates a popularity feedback runaway.** Items the model surfaces get clicked, which raises their training weight, which surfaces them more; without exploration injection this collapses diversity within days.

---

**Eval framing**

- **Offline:** ranking metrics on held-out interactions — NDCG@N, recall@N, MAP — computed on a temporally-split log (train on past, test on future, never random-split a time series). For content-only systems, offline relevance proxies (embedding similarity to known-relevant items) stand in until interaction data exists.
- **Online:** the only metric that counts is the engagement objective itself — click-through, dwell, conversion — measured by **A/B test** against the incumbent ranker. Offline NDCG that doesn't move online engagement is a model that learned the log, not the user.
- **Per-deployment:** a single-user system has no A/B population; eval degenerates to the user's own thumbs-up/down on surfaced items, which is qualitative, not statistical.

---

**Common failure modes**

- **Filter bubble / diversity collapse** — the feedback loop narrows recommendations to a self-reinforcing cluster. *Mitigation:* inject exploration (epsilon-greedy or bandit) and add an explicit diversity term in the re-rank layer.
- **Cold-start for new items/users** — no interaction history means the collaborative path can't score them. *Mitigation:* fall back to content-based candidate generation (embeddings, which exist day one) until interaction data accrues.
- **Popularity bias** — the model learns to recommend globally popular items regardless of personal fit, inflating offline metrics while feeling generic. *Mitigation:* down-weight by item frequency in the loss, or de-bias the candidate sampler.
- **Train/serve skew** — features computed differently offline (batch) vs online (request-time) silently degrade the live model. *Mitigation:* share one feature-computation path between training and serving.

---

**Applies to this codebase: no** (as a learned recommender)

buffr has no recommender — there is no learned ranker, no user×item interaction log, no engagement objective, no training loop, and crucially **one user**, which makes collaborative filtering structurally impossible. What buffr *does* have is a real **content-based ranking** surface: `PgVectorStore.search` (`src/pg-vector-store.ts:67`) embeds the query, then runs `order by embedding <=> $1::vector limit $3` against `agents.chunks` — cosine-distance ranking over content vectors, backed by the HNSW index `chunks_embedding_hnsw` (`sql/001_agents_schema.sql:28`). That is exactly the *candidate-generation* stage of a recommender, and exactly the *content-based* half of the content-vs-collaborative split (see `../08-machine-learning/10-recommender-systems.md`). The honest verdict is **no** because the system recommends nothing to anyone — it retrieves chunks to ground an answer, the rank score is never surfaced as a recommendation, there is no second user to collaborate with, and nothing is learned from clicks because there are no clicks. The score field returned (`1 - (embedding <=> $1)`) is a similarity number consumed internally by `createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 })` (`src/session.ts:43`), not a recommendation surfaced to a user.

---

**How to make it apply**

Frame the existing retrieval ranking as a **content-based recommender** and add one surfaced recommendation lane — no collaborative filtering, because buffr has one user, so it's content + rules only:

- **Reuse `PgVectorStore.search` as candidate gen.** It already returns ranked, scored content neighbors. The refactor is to expose a second entry point that, given a *note or chunk* as the query vector (not a question), returns its nearest neighbors — "notes you might revisit."
- **Add a `ml/` recommender surface** (new `ml/recommend.ts`) that, for a given seed chunk id, fetches its embedding from `agents.chunks` and calls `store.search(seedVector, k)` excluding the seed itself, then applies content rules (recency from `agents.documents.created_at`, dedupe by `document_id`) in the re-rank step. This is the candidate-gen + re-rank layers with the learned ranker honestly omitted.
- **State the collaborative gap out loud:** with one user there is no user×item matrix, so the collaborative path is permanently empty — this is the cold-start argument in `../08-machine-learning/11-cold-start.md`, and the correct answer is "content + rules is the *complete* design for N=1, not a degraded one."
- **If asked for the learned ranker:** that is the same reranking gap named in `../03-retrieval-and-rag/07-reranking.md` ([B2B.6]) — buffr's pure-dense cosine order has no learned scoring on top; wiring a reranker is the move that turns candidate-gen into a real ranker.
- **Eval it** by extending `eval/queries.json` with seed→expected-neighbor pairs and measuring recall@k on the surfaced recommendations, the same precision@k machinery the retrieval eval already uses.
