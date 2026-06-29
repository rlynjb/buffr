# Cold-start — recommending with no history yet

*Industry standard (cold-start problem). buffr has no recommender so faces no recsys cold-start — not yet implemented; but the new-item / new-system flavor is genuinely dodged at the embedding layer.*

## Zoom out, then zoom in

Every system that learns from interactions has a chicken-and-egg moment: it needs history to make good predictions, but a brand-new user, a brand-new item, or a brand-new deployment *has no history*. That's the cold-start problem. It's usually framed as a recommender headache, and buffr has no recommender — but the most interesting thing about buffr is that its retrieval layer is *immune* to one whole flavor of cold-start, for free, by construction. This file teaches the three cold-starts, then shows the one buffr genuinely dodges and the one it would still face.

```
  Zoom out — where cold-start WOULD bite buffr (and where it can't)

  ┌─ Provider layer (Ollama, local) ───────────────────────────┐
  │  nomic-embed-text:v1.5 → embedding of any new doc           │
  └─────────────────────────┬───────────────────────────────────┘
                            │  vector(768), no interactions needed
  ┌─ Storage layer (Postgres + pgvector) ───────────────────────┐
  │  ★ agents.chunks.embedding ← new doc retrievable instantly ★ │ ← we are here
  │     (content-based → NO item cold-start)                     │
  └─────────────────────────┬───────────────────────────────────┘
                            │
  ┌─ Service layer (no recommender) ────────────────────────────┐
  │  ranking ties / "what's popular" ← new-system cold-start     │
  │  WOULD bite here (no popularity prior yet)                   │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: cold-start comes in three shapes — **new user** (no history, can't personalize), **new item** (no interactions, invisible to collaborative methods), and **new system** (no data at all, nothing to bootstrap from). The bridge across all three is **content features**: similarity over an item's own attributes needs *zero* interactions, so it sidesteps the new-item problem entirely. That's exactly the property buffr's cosine retrieval has — a markdown file added one second ago is retrievable the instant its embedding lands, with no interaction history whatsoever.

## Structure pass

**Layers:** the signal a method depends on (interactions vs content) → the entity that's missing history (user / item / whole system) → the fallback that bridges the gap.

**Axis — "does this method need interaction history to function?"** Trace it across the three cold-starts.

```
  trace "does it need interaction history?" across the three cold-starts

  ┌─ new USER ───────────┐   needs user's past   (no history → can't personalize)
  │  empty profile        │   fallback: onboarding, popularity prior
  └──────────────────────┘
  ┌─ new ITEM ───────────┐   needs item's interactions (invisible to collaborative)
  │  zero clicks          │   fallback: CONTENT features  ← buffr lives here
  └──────────────────────┘
  ┌─ new SYSTEM ─────────┐   needs ANY data      (nothing to bootstrap)
  │  empty everything     │   fallback: transfer, hand-seeded priors
  └──────────────────────┘
```

**The seam:** between *interaction-dependent* methods (collaborative filtering, popularity) and *content-dependent* methods (cosine over features). The axis flips across it: left of the seam, no history means no prediction; right of it, the item's own embedding carries the signal and history is irrelevant. buffr's retrieval sits firmly on the content side — which is *why* its new-item cold-start vanishes. The cold-start that survives is the one that lives left of the seam: ranking when there's no popularity or interaction signal to break ties.

## How it works

### Move 1 — the mental model

You've felt this as a developer the first time you opened a fresh analytics dashboard: every chart is empty because no events have fired yet. The dashboard isn't broken — it just has nothing to show until data accumulates. Cold-start is that emptiness, and the cure is to *not depend on the empty thing*. Content-based methods are the cure because they read the item itself, which exists before any interaction does.

```
  Pattern — the three cold-starts and the content-feature bridge

      needs INTERACTIONS                  needs only CONTENT
      (empty at start)                    (available immediately)
  ┌──────────────────────┐            ┌──────────────────────────┐
  │ new user  ───────────┼──┐         │  item's own features /   │
  │ new item  ───────────┼──┼───────► │  embedding               │
  │ new system ──────────┼──┘  bridge │  → cosine works w/ 0 logs │
  └──────────────────────┘            └──────────────────────────┘
        ✗ stuck                              ✓ functions on day zero
```

### Move 2 — the step-by-step walkthrough

**New user — an empty profile, nothing to personalize from.** Bridge from auth: a just-registered account has no clicks, no ratings, no history. Any method keyed on "this user's past behavior" returns nothing. Mitigations: an **onboarding step** that asks for explicit preferences (genres, topics), a **popularity prior** (show what's broadly popular until you learn this user), and **exploration** (a bandit that tries varied items to learn fast). The fix is to substitute a population default for the missing individual signal.

```
  New user — empty profile → fall back to a default

  signup ─► profile = {}  ─► personalized rec = ??? (empty)
                              │
                              ▼ fallback
                    popularity prior OR onboarding answers
                    "show broadly-liked items until we learn you"
```

**New item — zero interactions, invisible to collaborative.** Here's the one that matters for buffr's shape. A collaborative method only knows an item through *who interacted with it*; a brand-new item has no interactions, so it never appears in any "users also liked" set — it's invisible until someone happens to find it another way. The fix is **content features**: describe the item by its own attributes (text, embedding) and recommend it by similarity to what the user already likes. No interactions required — the item is recommendable the moment it exists.

```
  New item — collaborative can't see it; content can

  COLLABORATIVE view:                CONTENT view:
  new item has 0 interactions        new item has an embedding
  → absent from R's columns          → cosine to user profile works NOW
  → invisible, never recommended     → recommendable on day zero
       ✗                                  ✓  ← buffr's retrieval is here
```

**New system — no data at all, bootstrap from nothing.** A fresh deployment has no users *and* no interactions. You can't personalize and you can't even compute popularity. Mitigations: **transfer from a related domain** (import a taste model or priors learned elsewhere), **hand-seeded priors** (editorial picks, default rankings), and again **content features** (which need no logs). The system limps on content and defaults until real data accrues.

```
  New system — empty everything → seed and transfer

  fresh deploy ─► no users, no interactions, no popularity
                   │
                   ▼ bootstrap
        content similarity (no logs needed)
        + hand-seeded defaults / editorial priors
        + transfer a model from a related domain
```

**buffr's genuine cold-start immunity.** Now the honest connection. buffr's retrieval is content-based at its core: a document is embedded by nomic-embed-text and stored in `agents.chunks.embedding` (via `PgVectorStore.upsert`, `src/pg-vector-store.ts:38-65`), and search is pure cosine over those embeddings (`src/pg-vector-store.ts:67-85`). Nothing in that path reads interaction history. So a markdown file added one second ago is *fully retrievable* the instant its embedding is written — no clicks, no ratings, no warm-up. That's the new-item cold-start dissolving entirely: content-based methods never needed interactions, so there's no cold to start from. This is a real architectural property buffr has, not aspiration.

```
  buffr — new doc is retrievable with ZERO interaction history

  add doc.md ─► nomic-embed ─► agents.chunks.embedding (upsert) ─► retrievable
       │                              │
       └── t=0s ──────────────────────┘
   no clicks, no ratings, no warm-up — content-based has no item cold-start
```

**The cold-start buffr would still face.** Immunity isn't total. The flavor that survives is *new-system / ranking-with-no-signal*: when many docs tie on cosine for a query (or for a "related notes" recommender), buffr has nothing to break the tie — no popularity, no click history, no recency prior. Cosine alone is silent on "which of these equally-similar docs is the better pick." That's where a popularity or recency prior earns its place — exactly the cold-start fallback the recommender chapter leans on (`10-recommender-systems.md`, REC-2).

### Move 3 — the principle

Cold-start is a *dependency* problem, not a data-volume problem: any method that keys on interaction history is empty until history exists, and the cure is to depend on something that exists at t=0 — the item's own content. Systems built on content similarity get new-item cold-start immunity for free; the cold-start that survives is always the one that needed the *crowd*, not the *item*.

## Primary diagram

```
  Cold-start — three types, the content bridge, and buffr's verdict

  ┌─ NEW USER ───────────────────────────────────────────────────┐
  │  empty profile → can't personalize                            │
  │  fallback: onboarding · popularity prior · bandit exploration │
  └────────────────────────────────────────────────────────────────┘
  ┌─ NEW ITEM ──────────────────────────── buffr IMMUNE ──────────┐
  │  0 interactions → invisible to collaborative                  │
  │  bridge: CONTENT features → cosine over agents.chunks.embedding│
  │  buffr: new doc retrievable at t=0 (pg-vector-store.ts:67)     │
  └────────────────────────────────────────────────────────────────┘
  ┌─ NEW SYSTEM ─────────────────────────── buffr STILL FACES ────┐
  │  no data at all → ranking ties have no tiebreak               │
  │  fallback: popularity / recency prior · transfer · seeds      │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

Cold-start is the canonical limitation of collaborative filtering, named alongside it in the recommender literature since the early GroupLens/Netflix era — collaborative methods are blind to anything with no interaction record, which is why every serious production recommender is *hybrid* (`10-recommender-systems.md`): content covers the cold items, collaborative adds crowd wisdom once interactions exist. The modern framing pushes content even further with **two-tower** models that embed users and items into a shared space, so a never-seen item still lands somewhere sensible from its features alone. buffr's immunity is a specific instance of this general truth: because its retrieval was *only ever* content-based, it never had an item cold-start to solve. The honest residue is the tie-breaking / new-system case, and it connects forward to ranking priors and to **stale embeddings** (`../03-retrieval-and-rag/09-stale-embeddings.md`) — the dual problem, where an item's *old* embedding no longer reflects its content. Cold-start is "no signal yet"; staleness is "the signal is out of date." buffr genuinely solves the first at the embedding layer and would have to engineer the second and the tie-break case.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Demonstrate content-based cold-start immunity

- **Exercise ID:** COLD-1 (Case B — no recommender, but the immunity is real and measurable). **The headline cold-start exercise.**
- **What to build:** a measurement that adds a brand-new markdown doc, embeds and upserts it with zero interaction history, then immediately issues a query it should answer and confirms the new doc is retrieved — proving content-based retrieval has no item cold-start.
- **Why it earns its place:** it turns an architectural claim ("we dodge item cold-start") into evidence, and names *why* (content-based needs no interactions). The "I proved our new docs are searchable at t=0" story.
- **Files to touch:** new `eval/coldstart.ts`; use `PgVectorStore.upsert` then `search` in `src/pg-vector-store.ts:38,67`; reuse pool/embedder setup from `src/cli/eval-cmd.ts:13-16`.
- **Done when:** a doc added at t=0 with no interactions is retrieved in the top-k for a relevant query, with a printed before/after.
- **Estimated effort:** 4–8 hr.

### Design a popularity / recency prior for cosine ties

- **Exercise ID:** COLD-2 (Case B — no tiebreak signal exists; this is the cold-start buffr still faces).
- **What to build:** a tiebreak prior for when multiple docs tie on cosine — rank ties by recency (`created_at`) or a simple access-count popularity prior, so the new-system "no signal" case degrades gracefully instead of returning an arbitrary order.
- **Why it earns its place:** content immunity covers new items, not the tie-break case; this addresses the one cold-start buffr genuinely has, and it's the same prior the recommender (REC-2) needs.
- **Files to touch:** wherever ranking happens over `search()` results (pipeline/recommender consumer); read `created_at` from `agents.chunks`; optionally a small access-count column/table.
- **Done when:** two docs with equal cosine are ordered deterministically by the chosen prior instead of by storage order.
- **Estimated effort:** 4–8 hr.

## Interview defense

**Q: Does buffr have a cold-start problem? Be specific about which flavor.**
Answer: it dodges the new-item flavor entirely. Retrieval is content-based — a doc is embedded by nomic-embed-text and stored in `agents.chunks.embedding`, and search is pure cosine (`src/pg-vector-store.ts:67`), reading no interaction history. So a doc added at t=0 is retrievable immediately; content-based methods never needed interactions, so there's no cold to start. The flavor it *would* still face is new-system / tie-breaking: when docs tie on cosine, there's no popularity or recency signal to order them, so I'd add a recency or popularity prior.

```
  new item: immune (content-based) · ranking ties: still cold (no crowd signal)
```

**Q: Why does content-based filtering dodge new-item cold-start when collaborative can't?**
Answer: collaborative knows an item only through who interacted with it, so a brand-new item with zero interactions is invisible — absent from every "users also liked" set. Content-based describes the item by its own features (its embedding) and recommends by similarity, which needs no interactions, so the item is recommendable the moment it exists. **The part people forget: this is exactly why production recommenders are hybrid — content covers the cold items, collaborative adds crowd wisdom only once interactions exist.**

```
  collaborative: item invisible until interactions · content: item live at t=0
```

## See also

- `10-recommender-systems.md` — content-based + rules is buffr's only viable recommender; this file is why its new items aren't a problem and where the tie-break prior fits.
- `09-calibration.md` — both lean on the same cosine; ranking-with-no-signal here is the dual of thresholding-an-uncalibrated-score there.
- `../03-retrieval-and-rag/09-stale-embeddings.md` — the dual of cold-start: signal that's out of date rather than missing.
- `../03-retrieval-and-rag/10-incremental-indexing.md` — how new docs land in `agents.chunks.embedding` to begin with, the upsert that makes t=0 retrieval possible.
