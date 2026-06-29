# Retrieval routing — send the query to the right source first

**Industry name(s):** retrieval routing · source routing · query
routing · the router-retriever. **Type label:** Industry standard.

**In this codebase: Not yet implemented — one source today.** buffr has
a single knowledge source: the `chunks` table in pgvector, searched by
cosine similarity. There's nothing to route *between*. The notable
wrinkle is that this one store holds two *kinds* (documents and
`kind=memory` exchanges), but they're recalled through the same search,
not routed — see the memory file. A second source (SQL, web) is what
would make this pattern apply.

## Zoom out, then zoom in

Retrieval routing is SECTION A's routing pattern applied to knowledge
sources: when there are multiple stores, pick the right one before
retrieving.

```
  Zoom out — routing across knowledge sources

  ┌─ Agentic retrieval (SECTION B) ──────────────────────────┐
  │  query → ★ router: which source? ★ → retrieve            │ ← we are here
  │             ├ semantic → vector store                    │
  │             ├ exact    → SQL                              │
  │             └ fresh    → web search                       │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: a single vector store is rarely the whole answer. Paraphrase
queries want a vector store; exact lookups want a relational store;
freshness wants live search. Routing between them is what production
retrieval looks like. buffr has one store, so it skips routing — for
now correctly.

## Structure pass

**Layers.** A router in front of N retrievers. buffr has N=1, so the
router degenerates to "always the vector store."

**Axis — "which store answers this query best?"** Semantic similarity →
vector; exact key lookup → SQL; recency → web. buffr only ever has one
answer to that question, so it doesn't ask it.

**Seam.** The query→source boundary. With one source there's no seam;
with many, this is where a query commits to a retrieval strategy, and
the wrong commit means a bad retrieval no grader can fully fix.

## How it works

#### Move 1 — the mental model

You've routed a request to different backends by its shape — a search
box hits the search service, an ID lookup hits the DB. Retrieval
routing is that dispatch for knowledge: the query's *shape* decides
which store can answer it.

```
  Pattern — retrieval routing

  query → ┌──────────────────────────┐
          │ router: which source?    │
          └──────────┬───────────────┘
        ┌────────────┼────────────┐
        ▼            ▼            ▼
     vector DB    SQL DB     web search
     (semantic)   (exact)    (fresh)
```

#### Move 2 — the walkthrough (buffr's one source, and the wrinkle)

**One store, one path.** buffr's only retriever is the pipeline over
`PgVectorStore` (`src/session.ts:41-42`). Every query goes there. No
routing decision exists because there's no alternative destination.

**The wrinkle: one store, two kinds.** The interesting thing in buffr
is that documents and conversation memory share the `chunks` table,
distinguished by `meta.kind` (`src/session.ts:50-53`; memory tagged
`kind=memory` in `conversation-memory.js:40`). You might think that
needs routing — "is this a memory question or a document question?" —
but buffr deliberately *doesn't* route it. Both kinds are recalled by
the same `search_knowledge_base` call, and the memory engine
over-fetches then filters by kind (`conversation-memory.js:48-53`).
That's a *unified* retrieval, not a routed one — a deliberate choice to
keep the agent's tool surface to exactly one tool.

**Where routing would actually apply.** If buffr added a relational
store of structured personal data ("what's my dentist's number") next
to the semantic notes store, *then* you'd route: exact lookups to SQL,
paraphrase questions to vector. And the two-brain design in
`agent-layer-plan.md` — a phone brain with its own store — would need
routing across devices. Both are real future sources; neither exists
yet.

```
  Comparison — buffr today vs a routed multi-source buffr

  buffr today:                      multi-source (would-be):
    query → vector store              query → router
    (one kind=memory over-fetch          ├ "what did I note about X" → vector
     filter, not a route)                ├ "my dentist's number"      → SQL
                                         └ "today's weather"           → web
```

#### Move 3 — the principle

Route across sources when the query's shape determines which store can
answer it. A single vector store handles paraphrase questions well and
exact lookups and freshness poorly — the moment buffr needs either, it
needs a router. Until then, one store with a kind-filter is the right,
simpler shape: don't add a router with one destination.

## Primary diagram

```
  Retrieval routing (buffr: one source, router would-be)

  TODAY:                          WOULD-BE (second source added):
  query → vector store            query → router → [vector | SQL | web]
          (kind filter splits             classify by query shape
           docs vs memory                 commit to a retrieval strategy
           AFTER search)
```

## Elaborate

Retrieval routing is the same dispatch as SECTION A's `07-routing.md`,
narrowed to "which knowledge source." It's also where the supervisor
pattern's routing instinct shows up at the data layer rather than the
agent layer. The reason buffr's shared-store-with-kind-filter works
instead of routing is that both kinds are *semantic* — they answer to
the same cosine search. The day a source needs a *different retrieval
mechanism* (exact SQL, live web) is the day a kind-filter stops being
enough and routing starts.

## Interview defense

**Q: buffr stores documents and memory in one table — does it route
between them?**
No, and that's deliberate. Both are semantic, so both answer to the
same cosine search; the memory engine over-fetches and filters by
`meta.kind` (`conversation-memory.js:48-53`) rather than routing the
query to a separate retriever. Keeping it one tool keeps the agent's
blast radius to a single read-only capability. Routing would only earn
its place if a source needed a *different* retrieval mechanism — an SQL
exact-lookup store, or live web search.

```
  one store, two kinds, one search + kind-filter ≠ routing
```

**Anchor:** "Route across sources only when the query's shape picks the
store — buffr's two kinds share one search, so no router."

## See also

- `01-agentic-rag.md` · `02-self-corrective-rag.md` — the other
  retrieval patterns
- `01-reasoning-patterns/07-routing.md` — the general routing pattern
- `04-agent-infrastructure/02-agent-memory-tiers.md` — the shared
  doc/memory store and its kind-filter
