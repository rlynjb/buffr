# Recommender systems — content-based, collaborative, hybrid

*Industry standard (recommender systems). buffr has no recommender and is single-user, so collaborative filtering is structurally impossible — not yet implemented; only content-based + rules is viable.*

## Zoom out, then zoom in

A recommender answers "what should I show this user next" without the user asking a question. There are three classic families, and which one you *can* build is decided by your data shape, not your preference. buffr already has the raw material for one of them sitting in its vector store — item embeddings — and is structurally locked out of another, because it has exactly one user. This file teaches all three honestly, then shows which is the only one buffr could ship.

```
  Zoom out — where a recommender WOULD attach in buffr

  ┌─ Provider layer (Ollama, local) ───────────────────────────┐
  │  nomic-embed-text:v1.5 → item embeddings                    │
  └─────────────────────────┬───────────────────────────────────┘
                            │  vector(768) per chunk
  ┌─ Storage layer (Postgres + pgvector) ───────────────────────┐
  │  agents.chunks.embedding   ← item feature vectors EXIST      │
  │  agents.messages           ← interaction log (single user)   │
  └─────────────────────────┬───────────────────────────────────┘
                            │
  ┌─ Service layer (none today) ────────────────────────────────┐
  │  ★ "related notes" recommender  ← WOULD attach here ★        │ ← we are here
  │     content-based (item-item cosine) + rules ONLY            │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **content-based** recommends items *similar to ones the user liked*, using item feature vectors and a similarity metric — which is, in shape, exactly what buffr's cosine retrieval already does. **Collaborative filtering** ignores item content and learns from the *user-item interaction matrix* — "people who liked what you liked also liked X" — which requires a *population* of users. **Hybrid** combines them. buffr is single-user, so collaborative filtering has no population to borrow from. Its only viable recommender is content-based plus rules.

## Structure pass

**Layers:** the signal source (item features vs interaction matrix) → the similarity/scoring model → the ranked list shown to the user.

**Axis — "where does the recommendation signal come from?"** Trace that one question across the families.

```
  trace "where does the signal come from?" across the three families

  ┌─ content-based ──────┐   ITEM FEATURES        (buffr: ✓ embeddings exist)
  │  item ↔ item similar  │   "like things you liked"  needs: 1 user's history
  └──────────────────────┘
  ┌─ collaborative ──────┐   INTERACTION MATRIX   (buffr: ✗ only 1 user)
  │  user ↔ user / factor │   "users like you liked X"  needs: a POPULATION
  └──────────────────────┘
  ┌─ hybrid ─────────────┐   BOTH                 (buffr: ✗ blocked by CF)
  │  blend the two        │   "content + crowd"        needs: both signals
  └──────────────────────┘
```

**The seam:** between *content signal* and *collaborative signal* — and the axis flips hard across it. Content-based needs only the items themselves plus one user's preferences; collaborative needs many users' overlapping interactions. buffr sits entirely on the content side of that seam because it has one user. So the seam isn't a tuning knob for buffr — it's a wall. Everything buffr could build lives left of it.

## How it works

### Move 1 — the mental model

You already know the engine: it's the exact cosine search from `src/pg-vector-store.ts`, pointed at a different question. Retrieval asks "which chunks are nearest *this query vector*?" Content-based recommendation asks "which items are nearest *the items this user already liked*?" Same vector space, same distance metric — the query is just an item (or the average of liked items) instead of a search string. Collaborative filtering is a different animal entirely: no item content, just a giant sparse matrix of who-interacted-with-what, factorized into latent taste dimensions.

```
  Pattern — content-based is item-item cosine (the engine buffr has)

  liked item  ●─────► nearest neighbors in embedding space
              │        ┌──────────────────────────────────┐
              │        │   ●  ● liked                       │
              ▼        │      ●◄── recommend (high cosine)  │
        embed once     │  ●      ● far (low cosine, skip)   │
        (or avg of     │      ●                             │
         liked items)  └──────────────────────────────────┘
                       cosine(liked, candidate) → rank → top-k
```

### Move 2 — the step-by-step walkthrough

**Content-based filtering — similarity over item features.** Bridge from buffr's retrieval: you already embed every chunk and run cosine search. Content-based recs reuse that. Represent each item by its feature vector (buffr's `agents.chunks.embedding`, 768-d from nomic-embed-text). Build a user profile as the items they engaged with — or just the average of their liked-item vectors. Then score every candidate item by cosine to that profile and return the top-k, excluding items already seen. No other users required; it works for a population of one.

```
  Content-based — pseudocode (this is item-item cosine)

  recommend_content(liked_items, all_items, k):
    profile = mean([ embed(i) for i in liked_items ])   // user = avg of liked
    scored = []
    for item in all_items:
      if item in liked_items: continue                  // don't re-recommend
      s = cosine(profile, embed(item))                  // 1 - distance
      scored.append((item, s))
    return top_k(scored, k)                             // highest cosine wins
```

Strength: handles brand-new items the day they're added (their embedding exists immediately — see `11-cold-start.md`). Weakness: it can only recommend *more of the same* — it has no way to surface something dissimilar that the user would nonetheless love, because it never sees other users' surprising overlaps.

**Collaborative filtering — the user-item matrix and matrix factorization.** This is the family buffr can't have, so understand exactly why. Build a matrix `R` with users as rows, items as columns, and each cell the interaction (rating, click, view). It's mostly empty. Matrix factorization approximates `R ≈ U · Vᵀ`, where `U` gives each user a short latent vector and `V` gives each item one; the dot product `U[u]·V[i]` predicts the missing cells. "Users like you also liked X" falls out because two users with similar `U` vectors get similar predictions. The whole thing is powered by *overlap between users* — the off-diagonal structure of `R`.

```
  Collaborative — the user-item matrix (needs a POPULATION)

            item_A  item_B  item_C  item_D
  user_1 [    5      ?       3       ? ]
  user_2 [    4      2       ?       1 ]   ← many rows = signal
  user_3 [    ?      2       5       1 ]
  ...
  factorize:  R  ≈  U · Vᵀ     (predict the ? cells)

  buffr's reality:
  user_1 [    5      ?       3       ? ]   ← ONE row
  (no other rows → nothing to borrow → CF is impossible)
```

The killer detail for buffr: with one user, `R` has one row. There are no "users like you" because there is no *you-plural*. Factorization of a single-row matrix learns nothing transferable — every prediction collapses back to that one user's own history, which is just content-based filtering wearing a costume. State it plainly: **buffr cannot do collaborative filtering, full stop, until it has a population of users.**

**Hybrid — blend content and collaborative.** When you have both signals, combine them — e.g. score = `α · content_cosine + (1-α) · collaborative_predicted`, or use content to cover items collaborative hasn't seen yet (cold-start) and collaborative to add crowd wisdom on popular items. Hybrid is the production default at scale precisely because each family covers the other's blind spot. buffr can't reach hybrid either, because one of its two terms (collaborative) is structurally unavailable.

```
  Hybrid — blend the two signals (blocked for buffr: CF term is empty)

  candidate ─┬─► content cosine     ─┐
             │                        ├─► α·content + (1-α)·collab ─► rank
             └─► collaborative pred  ─┘
                       ▲
                 buffr: this term doesn't exist (single user)
                 → hybrid degenerates to pure content
```

**So what buffr can actually build: content-based + rules.** With collaborative and hybrid off the table, the viable recommender is cosine over `agents.chunks.embedding` plus *heuristic rules* to break ties and shape the list — recency (prefer newer notes), section (prefer same source doc, or deliberately diversify across docs), and dedup (don't recommend two near-identical chunks). Rules stand in for the crowd signal buffr doesn't have: instead of "people like you liked this," you encode "items like this, recently, from a relevant section." It's the single-user-honest recommender.

```
  buffr's only viable recommender — content cosine + rule layer

  liked/current note
        │ embed
        ▼
  ┌─ content-based core ─────────┐   item-item cosine over agents.chunks.embedding
  │  top-k nearest by cosine      │   (pg-vector-store.ts:67 search())
  └──────────────┬────────────────┘
                 │ candidates
                 ▼
  ┌─ rule layer (stands in for crowd) ─┐
  │  + recency boost                    │
  │  + same/diverse-section heuristic   │
  │  + dedup near-identical chunks      │
  └──────────────┬──────────────────────┘
                 ▼  ranked "related notes"
```

### Move 3 — the principle

Your data shape, not your ambition, decides which recommender you can build. Item features alone get you content-based; a population of overlapping users gets you collaborative; both get you hybrid. A single-user system has exactly one move — content-based plus rules — and any "collaborative" approach you bolt on quietly collapses back into that one user's own history.

## Primary diagram

```
  Recommender families — signal source, requirement, and buffr's verdict

  ┌─ CONTENT-BASED ──────────────────────────── VIABLE for buffr ─┐
  │  signal: item feature vectors (agents.chunks.embedding)        │
  │  engine: cosine, same as pg-vector-store.ts search()           │
  │  needs: one user's history          → buffr HAS this           │
  └────────────────────────────────────────────────────────────────┘
  ┌─ COLLABORATIVE ──────────────────────────── IMPOSSIBLE ───────┐
  │  signal: user-item matrix R ≈ U·Vᵀ                             │
  │  needs: a POPULATION of users       → buffr has ONE row        │
  └────────────────────────────────────────────────────────────────┘
  ┌─ HYBRID ─────────────────────────────────── BLOCKED ──────────┐
  │  signal: content + collaborative blended                       │
  │  needs: both                        → CF term empty → degrades │
  └────────────────────────────────────────────────────────────────┘
        ↓ buffr's only build:
  ┌─ CONTENT-BASED + RULES (recency / section / dedup) ───────────┐
  │  rules stand in for the crowd signal a single user can't give  │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The content-vs-collaborative split goes back to the 1990s (GroupLens for collaborative; content-based filtering from information retrieval), and the modern collaborative workhorse — matrix factorization — was cemented by the Netflix Prize (2006–2009), where SVD-style latent-factor models dominated. The field has since moved to neural and two-tower retrieval models, but the data requirement is unchanged: collaborative methods are powered by *interaction overlap between users*, and no architecture conjures that from a single user. There's a deep rhyme worth noticing: buffr's existing RAG retrieval (`../03-retrieval-and-rag/11-rag.md`) and a content-based recommender are the *same operation* — embed, cosine, top-k — differing only in whether the "query" is a typed question or an item the user just engaged with. That's why the recommender is a small lift on top of what `src/pg-vector-store.ts` already does. The honest ceiling is the multi-user version: once `agents.messages` accumulates trajectories from many users, collaborative and hybrid open up — but buffr is single-user today, so that's a future, not a feature.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Build a content-based "related notes" recommender

- **Exercise ID:** REC-1 (Case B — no recommender exists). **The core recommender exercise.**
- **What to build:** given a note (or the current note in context), return the top-k most similar *other* notes by item-item cosine over `agents.chunks.embedding`, excluding the source note itself. Reuse the existing cosine search — fetch the source note's embedding, then `search()` for nearest neighbors.
- **Why it earns its place:** it's the one recommender family a single-user system can actually ship, and it's a small lift on the cosine engine already in the repo. The "I turned our retrieval into a related-content recommender" story.
- **Files to touch:** new `src/recommend.ts` calling `PgVectorStore.search` in `src/pg-vector-store.ts:67`; reuse pool/embedder/store setup from `src/cli/eval-cmd.ts:13-16`; read embeddings from `agents.chunks.embedding`.
- **Done when:** given a note id, the command prints k related notes ranked by cosine, with the source note excluded.
- **Estimated effort:** 1 day.

### Add a rule-based ranking layer

- **Exercise ID:** REC-2 (Case B — no ranking heuristics exist; depends on REC-1).
- **What to build:** layer recency and section heuristics on top of REC-1's cosine candidates — boost newer notes (using `created_at`), and add a same-vs-diverse-section toggle plus near-duplicate dedup. These rules stand in for the collaborative signal a single user can't provide.
- **Why it earns its place:** makes explicit *why* buffr leans on rules — there's no population to give crowd signal, so heuristics carry the load collaborative filtering would otherwise carry.
- **Files to touch:** extend `src/recommend.ts`; read `created_at` / `meta` from `agents.chunks` (and document timestamps); no new table needed.
- **Done when:** two notes with near-identical cosine are broken apart by recency/section rules, and near-duplicate chunks are collapsed.
- **Estimated effort:** 4–8 hr (after REC-1).

## Interview defense

**Q: Why can't buffr do collaborative filtering, and what can it do instead?**
Answer: collaborative filtering is powered by the user-item interaction matrix — "users like you also liked X" — and buffr is single-user, so that matrix has exactly one row. There's no population to borrow signal from; factorizing one row just hands back that user's own history. So the only viable recommender is content-based: item-item cosine over `agents.chunks.embedding`, which is the same engine as `src/pg-vector-store.ts` retrieval, plus rule heuristics (recency, section) to stand in for the crowd signal.

```
  CF needs many rows of R · buffr has 1 row · → content-based + rules only
```

**Q: A content-based recommender and buffr's RAG retrieval — how are they related?**
Answer: they're the same operation. Both embed, run cosine, and take top-k over `agents.chunks.embedding`. The only difference is the "query": retrieval uses a typed question, content-based recs use an item the user just engaged with (or the average of their liked items). **The part people forget: content-based recs inherit retrieval's blind spot — they can only suggest *more of the same*, because with no other users there's no source of pleasant surprise.**

```
  retrieval: query string → cosine → top-k  ·  content recs: liked item → cosine → top-k
```

## See also

- `11-cold-start.md` — content-based recs dodge item cold-start (new items are recommendable the moment their embedding exists); the cold-start that does bite is new-user/new-system.
- `09-calibration.md` — the recommender ranks on cosine, and ranking is order-invariant, so it dodges calibration the same way buffr's retrieval does.
- `../03-retrieval-and-rag/11-rag.md` — the retrieval pipeline the recommender reuses wholesale.
- `../03-retrieval-and-rag/04-vector-databases.md` — the pgvector store (`agents.chunks.embedding`) the recommender queries.
