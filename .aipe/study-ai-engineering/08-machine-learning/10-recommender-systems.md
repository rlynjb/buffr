# Recommender Systems

### *industry: recommender systems (content-based vs collaborative vs hybrid) · type: the three ways to decide what to surface next*

## Zoom out

Every "you might also like" is a recommender, and they split into three families by *what signal they learn from*. This is the first file in the section where the pipeline isn't a classifier — it's a ranker over items for a user. But the shape rhymes: data in, features out, a model that scores, a deployed ranking. See where the family choice sits:

**A recommender pipeline, with the family-choice stage marked**
```
┌──────────┐  ┌──────────┐  ┌───────┐  ┌────────────────────────────┐  ┌──────────┐
│ Items +  │─►│ Features │─►│ Split │─►│ ★ CHOOSE THE SIGNAL ★       │─►│ Rank &   │ ◄── this file
│ inter-   │  │ (item or │  │ (by   │  │  content / collaborative /  │  │ serve    │
│ actions  │  │  user)   │  │ user) │  │  hybrid                     │  │ top-N    │
└──────────┘  └──────────┘  └───────┘  └────────────────────────────┘  └──────────┘
                                                  │
                  what data exists DECIDES which family is even possible ─┘
```
The family is not a taste preference — it's forced by the data you actually have, which is the whole tension this file resolves for buffr.

## Structure pass

One axis separates the three families: **does the recommender learn from item content, from other users' behavior, or both?**

**The one axis: where the signal comes from, with the seam buffr falls on**
```
   CONTENT-BASED              COLLABORATIVE              HYBRID
   ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
   │ item features │           │ user×item     │           │ both signals  │
   │ + this user's │           │ interaction   │           │ blended       │
   │ own profile   │           │ matrix        │           │               │
   │               │           │ (OTHER users) │           │               │
   └──────────────┘           └──────────────┘           └──────────────┘
   needs: item content        needs: MANY users          needs: both
   works for 1 user           needs: cross-user overlap   best when rich

   ┌──────────────────────────────── THE SEAM ───────────────────────────────┐
   │ COLLABORATIVE filtering REQUIRES other users to borrow taste from.        │
   │ buffr is effectively SINGLE-USER — a personal RAG over your own markdown.  │
   │ With one user there is no user×item matrix to factorize. Collaborative     │
   │ filtering is IMPOSSIBLE here, not just unbuilt. Content + rules is the     │
   │ ONLY viable shape.                                                          │
   └───────────────────────────────────────────────────────────────────────────┘
```
The seam is decisive for buffr: single-user kills the collaborative family outright, so the design space narrows to content-based plus rules before you write a line.

## How it works

### Move 1 — Mental model

The mental model: **content-based recommends things *similar to what you liked* (item-to-item by features); collaborative recommends things *liked by people similar to you* (user-to-user by behavior).** Content asks "what is this item like?"; collaborative asks "who else acted like you, and what did they pick?"

**The two questions, side by side**
```
   CONTENT-BASED                          COLLABORATIVE
   "you liked item A"                     "you behaved like user U"
        │                                      │
        ▼                                      ▼
   find items whose FEATURES                find what user U liked
   resemble A's features                   that you haven't seen
        │                                      │
        ▼                                      ▼
   recommend B (similar item)              recommend C (peer's pick)
   ── needs NO other users ──              ── needs MANY other users ──
```
Content-based is the family that survives with a single user — it never looks past your own item features and your own history.

### Move 2 — Walk the mechanism

**Part 1 — Content-based: build an item feature vector and a user profile, then score by similarity.** Each item gets a feature vector; the user profile is an aggregate of items they engaged with; recommendation is nearest items to the profile.

**Content-based scoring = similarity between user profile and item vectors**
```
   user profile  ●───────► (mean of liked item vectors)
                  \
                   \  cosine
                    \
   item vectors:  ◇  ◇  ◇  ◇      score each item by similarity to the profile
                  └──┬──────────────┐
                     ▼              ▼
              top-N nearest items ─► recommend
```

**Part 2 — Collaborative: factorize the user×item interaction matrix.** The matrix is mostly empty (most users touched few items). Matrix factorization learns low-rank user and item vectors whose dot product reconstructs the observed cells and predicts the empty ones. Illustrative, not buffr code:

**Matrix factorization — learn latent user/item vectors that reconstruct interactions (illustrative)**
```python
# ILLUSTRATIVE ONLY — not buffr code. Requires MANY users; buffr has one.
#   R ≈ U · Vᵀ      R: users×items (sparse),  U: users×k,  V: items×k
for (u, i, observed) in interactions:          # only the FILLED cells
    pred  = dot(U[u], V[i])
    error = observed - pred
    U[u] += lr * (error * V[i] - reg * U[u])   # nudge user vector
    V[i] += lr * (error * U[u] - reg * V[i])   # nudge item vector
# empty cells are then predicted by U[u] · V[i]  ── impossible with a single user
```

**Part 3 — Why collaborative collapses to nothing with one user.** The interaction matrix is a single row. There is no second user to borrow taste from; factorization has nothing to generalize across.

**Single-user interaction matrix — a degenerate one-row case**
```
              item1 item2 item3 item4
   you   ►   [  1     0     1     0  ]   ◄── ONE row, no peers
            ┌──────────────────────────────────────────┐
            │ no other rows ⇒ no cross-user signal ⇒    │
            │ collaborative filtering has no input.      │
            │ Only the item FEATURES (columns) remain.   │
            └──────────────────────────────────────────┘
```

**Part 4 — Hybrid: blend content scores with rules.** Even without collaborative signal, you combine content similarity with business rules — recency, diversity, deduplication.

**Hybrid for a single user = content similarity × rules**
```
   content score  ──┐
                    ├─► weighted blend ─► re-rank ─► top-N
   recency boost  ──┤        │
   already-seen   ──┘   drop already-read, enforce diversity
   penalty
```
For buffr the "hybrid" is content-based embeddings plus deterministic rules — there is no collaborative term to blend in.

### Move 2.5 — current vs future

**What buffr can do vs what's structurally impossible**
```
   POSSIBLE (content-based, Case B to build)      IMPOSSIBLE (collaborative)
   ┌────────────────────────────────────┐         ┌────────────────────────────────┐
   │ recommend-next-doc / related-chunks │         │ "users like you also read…"     │
   │ via embedding similarity over the    │         │ needs a user×item matrix with   │
   │ existing 768-dim chunk vectors +     │   ✗     │ MANY users. buffr is single-user│
   │ recency rules                         │         │ ⇒ no matrix ⇒ not buildable      │
   │ ── uses agents.chunks embeddings     │         │ (not "not yet" — never, as-is)  │
   └────────────────────────────────────┘         └────────────────────────────────┘
```
The only recommender buffr can honestly build is content-based over its own embeddings; the collaborative family is off the table by construction, not by backlog.

### Move 3 — The principle

The principle: **the data you have decides the family before any modeling choice — collaborative filtering buys you "wisdom of the crowd" only if there is a crowd.** A single-user system has no crowd, so it must lean entirely on item content (and rules) and accept that it can never surprise you with a peer's taste. Don't reach for matrix factorization out of habit; check whether a user×item matrix even exists first.

## Primary diagram

The full picture — three families, the data each demands, and the one branch buffr can actually take.

**The recommender decision, with buffr's forced path**
```
                        ┌─────────────────────────┐
                        │ what data do you HAVE?   │
                        └─────────────┬───────────┘
            ┌─────────────────────────┼─────────────────────────┐
            ▼                         ▼                         ▼
   item features only?        many users' behavior?       both, richly?
            │                         │                         │
            ▼                         ▼                         ▼
   ┌────────────────┐        ┌────────────────┐        ┌────────────────┐
   │ CONTENT-BASED   │        │ COLLABORATIVE   │        │ HYBRID          │
   │ profile↔item sim│        │ matrix factor.  │        │ blend both      │
   └────────┬───────┘        └────────────────┘        └────────────────┘
            │                         ✗ (no crowd)
   ★ buffr lives here ★
   ┌──────────────────────────────────────────────────────────────────────┐
   │ recommend-next-doc via cosine over agents.chunks' 768-dim embeddings   │
   │ + recency rules. SINGLE-USER ⇒ content-based + rules is the only shape. │
   └──────────────────────────────────────────────────────────────────────┘
```
For buffr, the flowchart has exactly one open exit, and it runs on embeddings the repo already stores.

## Elaborate

The sharp edges:

- **Content-based can't surprise you.** It only ever recommends things similar to what you've already engaged with — a filter bubble of one. Collaborative's whole value is *serendipity* from peers, which a single-user system structurally forfeits.
- **The cold-start problem hits these families differently.** Content-based handles new *items* fine (it has features) but needs a user profile to start; collaborative needs interactions for both. This is the subject of the next file, `11-cold-start.md`.
- **Implicit vs explicit feedback.** Few systems get star ratings; most infer preference from clicks, dwell, opens. buffr's `agents.messages` (which docs got retrieved and used) is exactly this kind of *implicit* signal — a latent profile source.
- **Rules carry more weight than people admit.** Recency, diversity, dedup, and "don't show what they just read" often matter more than the model's score. For a single-user recommender, rules are most of the system.
- **buffr's honest line.** buffr stores 768-dim chunk embeddings in `agents.chunks` and serves them by cosine in `src/pg-vector-store.ts` — that's the entire engine a content-based recommender needs. The honest gap: there is no recommender feature yet, and there *can't* be a collaborative one because buffr is single-user (a personal RAG over your own markdown). A `recommend-next-doc` / related-chunks feature over those embeddings plus recency rules is the one buffr-plausible new build.

## Project exercises

### Build a content-based "related chunks / next doc" recommender

- **Exercise ID:** [B2C.10] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Add a content-based recommender over buffr's existing 768-dim embeddings: given the doc/chunk you're currently reading (or the last one retrieved), return the top-N most similar *other* chunks by cosine, then re-rank with rules — boost recent docs, drop the current doc, enforce source diversity so all N aren't from one file. No training, no collaborative term — pure item-similarity + rules.
- **Why it earns its place:** It's the only recommender family buffr can honestly ship, and it reuses the embedding index that already exists — so it teaches content-based + hybrid-rules end to end on real data, and produces a genuinely useful feature.
- **Files to touch:** new `ml/recommender.py` or a CLI command alongside `src/cli/`, reads `agents.chunks` embeddings via the `src/pg-vector-store.ts` contract, recency from `documents`/`created_at`, writes the ranking logic and a short eval to `ml/README.md`.
- **Done when:** given a seed chunk it returns top-N related chunks; the current doc is excluded; a recency boost and a per-source diversity cap are applied and visible in the output; a note states plainly why no collaborative term exists.
- **Estimated effort:** 1 day.

### Derive a user profile vector from agents.messages (implicit feedback)

- **Exercise ID:** [B2C.10b] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Treat `agents.messages` as implicit-feedback signal: extract which chunks were retrieved and actually used across conversations, average their embeddings into a single *user profile vector*, and recommend the nearest unread chunks to that profile. This is content-based recommendation driven by behavior rather than a single seed item.
- **Why it earns its place:** It shows you can manufacture a user profile from implicit signals — the realistic case, since nobody hands you star ratings — using the trajectory table buffr already captures.
- **Files to touch:** new `ml/user_profile.py`, reads `agents.messages` (retrieved/used chunk references) and `agents.chunks` embeddings, writes the profile-building logic to `ml/README.md`.
- **Done when:** a single profile vector is built from message history, top-N recommendations are returned against it excluding already-seen chunks, and a note explains why this is still content-based (one user) and not collaborative.
- **Estimated effort:** 1 day.

## Interview defense

Most candidates reach for matrix factorization reflexively. Knowing *why* it's impossible for a single-user system — and what you build instead — is the staff-level signal that data shape drives the design.

**Q: How would you add recommendations to a single-user RAG like buffr?**
```
   single user ─► no user×item matrix ─► collaborative is OUT
        │
        └─► content-based: cosine over existing embeddings + recency/diversity rules
```
Anchor: with one user there's no crowd to borrow from, so the only viable family is content-based plus rules.

**Q: Content-based vs collaborative — when does each win?**
```
   CONTENT-BASED                 COLLABORATIVE
   wins: cold items, niche,      wins: serendipity, dense
   single user, explainable      cross-user signal, scale
        │                             │
        └─ buffr's regime ────────────┘ (needs many users — buffr has one)
```
Anchor: content-based wins when items have features and users are few; collaborative wins when many users overlap — and buffr structurally can't reach the second.

**Q: Where's the implicit feedback in buffr?**
```
   agents.messages ─► which chunks were retrieved & used
        │
        └─ average their embeddings ─► a USER PROFILE vector (no ratings needed)
```
Anchor: `agents.messages` is captured trajectory data — implicit feedback you can aggregate into a profile without ever asking for an explicit rating.

## See also

- `./09-calibration.md` — when a recommender's scores feed a downstream threshold, calibration starts to matter.
- `./11-cold-start.md` — the new-user / new-item / new-system problem these families each hit differently.
- `../03-retrieval-and-rag/` — buffr's embedding index, the engine a content-based recommender reuses wholesale.
- `../05-evals-and-observability/` — `eval/queries.json` and ranking metrics (P@1/R@3) reused to evaluate recommendations.
- `../09-ml-system-design-templates/` — where "single-user ⇒ content-based + rules" becomes a documented design constraint.
