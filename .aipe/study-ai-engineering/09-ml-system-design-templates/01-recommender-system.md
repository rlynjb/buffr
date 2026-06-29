# Recommender system design

- **The prompt:** "Design a recommender that surfaces N items per user from a catalog of M, maximizing engagement."

- **Standard architecture:**

  ```
  User + context
    │
    ▼
  ┌──────────────────────────────────┐
  │ Candidate generation             │
  │  (content-based + collaborative) │
  └──────────────┬───────────────────┘
                 │  ~hundreds of candidates
                 ▼
  ┌──────────────────────────────────┐
  │ Ranking                          │
  │  (learned model: pCTR, pEngage)  │
  └──────────────┬───────────────────┘
                 │  ranked list
                 ▼
  ┌──────────────────────────────────┐
  │ Re-ranking                       │
  │  (diversity, freshness, dedup)   │
  └──────────────┬───────────────────┘
                 │  N items
                 ▼
  ┌──────────────────────────────────┐
  │ Serving + logging                │
  │  (impressions, clicks, dwell)    │
  └──────────────────────────────────┘
  ```

- **Data model:**
  - Item catalog `{item_id, features, embedding}` — the M items to recommend from.
  - User profile `{user_id, history, embedding}` — the per-user signal.
  - Interaction log `{user_id, item_id, impression, click, dwell, timestamp}` — the training data for the ranker.
  - Collaborative matrix — user×item interactions factored into latent vectors.

- **Key components:**
  - *Candidate generation*: narrows M to hundreds cheaply, mixing content-based (item embedding similarity) and collaborative (co-engagement) sources. Decision: two-tower retrieval for sub-linear candidate lookup at large M.
  - *Ranking*: a learned model scores candidates by predicted engagement (pCTR, pWatch). Decision: gradient-boosted trees or a DLRM, trained on the interaction log.
  - *Re-ranking*: applies diversity, freshness, and dedup so the list isn't ten near-identical items. Decision: MMR or a determinantal point process for diversity.
  - *Serving + logging*: returns N items and logs impressions and outcomes. Decision: log impressions too, not just clicks — you need the negatives.

- **Scale concerns:**
  - At large M (millions of items): exhaustive scoring is infeasible. Solution: ANN candidate generation, score only hundreds.
  - At many users: per-user model inference dominates. Solution: precompute user embeddings, cache candidate sets for low-activity users.
  - Cold start: new users and new items have no interaction history. Solution: fall back to content-based recommendation until signal accumulates.

- **Eval framing:**
  - Offline: NDCG, MAP, recall@k over a held-out interaction set; AUC on the pCTR model.
  - Online: A/B on engagement, click-through, session length, long-term retention (the real objective, not the proxy).
  - Beware proxy gaming: optimizing pCTR can surface clickbait and hurt retention.

- **Common failure modes:**
  - Filter bubble → re-ranking diversity collapses, the user sees more of the same. Mitigation: diversity term + exploration slots.
  - Popularity bias → the head dominates, the long tail never surfaces. Mitigation: inverse-propensity weighting in training.
  - Feedback loop → the model recommends what it already recommends. Mitigation: epsilon-greedy exploration, log counterfactuals.

- **Applies to this codebase:** **no.** buffr recommends nothing. It is a single-user personal-knowledge tool with no catalog, no multi-user interaction matrix, and no engagement objective. There is no item-to-rank-for-a-user problem anywhere in the codebase — the closest thing is retrieval, but retrieval answers "which chunks are relevant to *this query*," not "which items will *this user* engage with." There is no user dimension at all; `app_id` scopes a corpus, not a person with a taste profile. This template does not map.

- **How to make it apply:** It's a stretch, and worth naming as one. The only ranking surface in buffr is "which chunk or memory to surface next" — you could frame retrieval ranking in `src/pg-vector-store.ts` as a *degenerate recommender* with a population of one user and the query standing in for context. A slightly less forced version: "which document should the user index next?" — recommend un-indexed documents by similarity to the existing corpus, logged through the `index-cmd.ts` path. Both are thought-experiments, not product needs; if an interviewer hands you this prompt, the honest move is to design the canonical system above and then say buffr's single-user, no-catalog shape means it never needed one.
