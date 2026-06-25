# HNSW Approximate Search

*Approximate Nearest Neighbor (ANN) retrieval over a graph index — Industry
standard.*

## Zoom out, then zoom in

Here's the whole retrieval path. The question gets turned into a 768-dim vector,
and then the system has to find the handful of chunk vectors closest to it out of
everything you've ever indexed. That "find the closest" step is the box we care
about — and it's the one place in buffr where someone made a deliberate
performance choice.

```
  Zoom out — where the search sits

  ┌─ CLI / Agent layer ─────────────────────────────────────────┐
  │  chat turn → search_knowledge_base tool → pipeline.query     │
  └─────────────────────────┬────────────────────────────────────┘
                            │  embed(query) → 768-dim vector
  ┌─ VectorStore (buffr) ───▼────────────────────────────────────┐
  │  PgVectorStore.search()   ★ THIS CONCEPT ★                    │ ← we are here
  │  order by embedding <=> $1  limit k                           │
  └─────────────────────────┬────────────────────────────────────┘
                            │  SQL over the HNSW index
  ┌─ Storage — Postgres + pgvector ─▼────────────────────────────┐
  │  chunks_embedding_hnsw  (graph index on embedding column)    │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the naive way to find the k nearest vectors is to compute the distance
from your query to *every* stored vector and keep the smallest k. That's a full
scan — O(N) in the number of chunks. HNSW is the trade that buys you sub-linear
search by walking a navigable graph instead of scanning the table. That's the
pattern. The cost it charges — and the knobs nobody in buffr has touched — is the
rest of this file.

## Structure pass

**Layers.** Three: the *contract* (aptkit's `VectorStore` interface — "give me k
nearest"), the *query* (`PgVectorStore.search`, the SQL buffr wrote), and the
*index* (the HNSW graph Postgres maintains under the `embedding` column).

**Axis — cost (work per query, measured in vectors touched).** Hold that one
question across the layers:

```
  "how many stored vectors does a search touch?" — traced down

  ┌───────────────────────────────────────┐
  │ contract: "k nearest"                 │   → says nothing about cost
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ query: order by <=> limit k         │   → asks for k, but cost depends…
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ index: HNSW graph walk          │   → touches ~ef_search, NOT N
          └─────────────────────────────────┘

  the answer flips at the index layer: O(N) scan → O(log N)-ish graph walk
```

**Seam — the `<=>` operator.** That operator is the load-bearing joint. On one
side, `order by … limit k` looks like an ordinary sort-then-truncate (which would
be O(N log N)). On the other side, because there's an HNSW index on the column,
the planner substitutes a *graph walk* that never materializes all N distances.
The cost axis flips across that operator. Everything in this file hangs on that
single seam.

## How it works

### Move 1 — the mental model

You know how a binary search tree lets you find a value without checking every
node — you follow comparisons down toward the target instead of scanning? HNSW is
that idea for *high-dimensional vectors*, except the structure isn't a tree, it's
a layered graph you greedily navigate. The strategy in one sentence: **start at an
entry point, repeatedly hop to whichever neighbor is closer to your query, and you
converge on the nearest vectors without ever looking at most of the others.**

```
  HNSW — greedy graph descent (the kernel)

  layer 2 (sparse, long hops)      entry ●
                                       │ hop toward query
  layer 1 (denser)              ●──────●──────●
                                       │ hop toward query
  layer 0 (all vectors)    ●──●──●──●──●──●──●──●
                                    ▲
                              query lands here;
                              collect k nearest from
                              the local neighborhood

  never touches the ● nodes off to the sides → sub-linear
```

The "approximate" in ANN: the greedy walk can miss the true nearest neighbor if
the graph routes around it. You trade a small recall loss for a huge speed win.
How much you trade is a *knob*, not a fixed property — which is exactly the part
buffr leaves at default.

### Move 2 — the moving parts

**The distance operator (`<=>`).** This is cosine distance in pgvector. Bridge
from what you know: it's the same `1 - cosineSimilarity` you'd compute by hand,
but as a SQL operator so the planner can reason about it. buffr writes the query
as `order by embedding <=> $1::vector limit k` and converts distance back to a
similarity score with `1 - (embedding <=> $1)`. Boundary condition: the operator
only triggers the index if the index was built with the *matching* ops class —
here `vector_cosine_ops`. Build the index with L2 ops and query with `<=>` and
you silently fall back to a full scan.

**The HNSW index.** This is the graph from Move 1, persisted. It's built at
`create index` time and maintained incrementally on every insert. Bridge: think
of it like a btree on a normal column — the planner uses it instead of scanning,
and it costs write-time work to keep updated. Boundary condition: HNSW build is
*expensive* and the graph quality depends on `m` (neighbors per node) and
`ef_construction` (candidate-list size during build). Set them too low and recall
drops; too high and index build crawls.

**`ef_search` — the query-time knob.** This is the lever that decides how wide
the greedy walk searches before it commits. Higher `ef_search` = more candidates
considered = better recall = slower query. Bridge: it's the speed/accuracy dial on
the search itself, set per-session or per-query.

```
  ef_search — the speed/recall dial (NOT set in buffr)

  ef_search = 40 (default)   ──►  fast,  recall ~0.95
  ef_search = 100            ──►  slower, recall ~0.99
  ef_search = 200            ──►  slowest, recall ~0.999

  buffr never issues `set hnsw.ef_search = …`
  → it runs at whatever Postgres defaults to, unmeasured
```

This is the load-bearing gap. buffr has a *recall harness already*
(`eval-cmd.ts`) and an HNSW index — but never connects them by sweeping
`ef_search` and reading the recall number back. The dial exists; the measurement
exists; the wire between them doesn't.

### Move 2 variant — the load-bearing skeleton

The irreducible kernel of ANN-over-HNSW, and what breaks without each part:

1. **The graph index itself** — without it, `order by <=> limit k` is a full
   O(N) scan. This is the part that makes it sub-linear; drop it and you've lost
   the entire performance win.
2. **The matching ops class (`vector_cosine_ops`)** — without it the planner
   can't use the index for `<=>`, so you silently get the full scan back even
   though the index exists.
3. **`limit k`** — without the limit there's nothing to truncate the walk
   against; HNSW search is defined as "k nearest," so k is the termination.

Optional hardening on top of the kernel: `ef_search` tuning (recall/speed),
`m` / `ef_construction` tuning (graph quality vs build cost). buffr has the
kernel intact and zero hardening.

### Move 3 — the principle

Approximate-but-fast beats exact-but-linear once N is large enough that a full
scan stops fitting your latency. The win isn't free — you trade recall for speed —
but the trade is a *tunable dial*, and the engineering discipline is to measure
where on that dial you're sitting. An untuned ANN index is a Ferrari in first
gear: the capability is there, but you haven't found out what it can do.

## Primary diagram

The full retrieval path, every layer and hop labelled.

```
  Search path — query string to ranked chunks

  ┌─ Agent layer ───────────────────────────────────────────────┐
  │  "what does the author do for work"                          │
  └─────────────────────────┬────────────────────────────────────┘
        hop 1: embed(query)  │  HTTP → Ollama nomic-embed-text
                             ▼
  ┌─ Pipeline (aptkit) ──────────────────────────────────────────┐
  │  [0.1, 0.2, … 768 floats]                                    │
  └─────────────────────────┬────────────────────────────────────┘
        hop 2: search(vec,k) │  PgVectorStore.search
                             ▼
  ┌─ Storage — Postgres + pgvector ──────────────────────────────┐
  │  order by embedding <=> $1  limit k                          │
  │       │ planner sees HNSW index on embedding                 │
  │       ▼                                                       │
  │  greedy graph walk (touches ~ef_search nodes, NOT all N)     │
  │       │                                                       │
  │  also: where app_id = $2  → chunks_app_id btree              │
  └─────────────────────────┬────────────────────────────────────┘
        hop 3: rows + scores │  1 - distance as score
                             ▼
  ┌─ Agent layer ───────────────────────────────────────────────┐
  │  ranked chunks with citations → into the LLM prompt          │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached for on every `chat` turn (the `search_knowledge_base` tool
calls `pipeline.query`, which calls `store.search`) and on every eval query
(`src/cli/eval-cmd.ts:25`). It's the read side of the entire RAG loop — every
answer buffr gives starts here. New as of `chat`: the per-turn episodic-memory
upsert (`memory.remember`, `src/session.ts:66`) writes *into* this same HNSW index,
so the corpus the search walks now grows by one memory chunk per turn — still tiny,
but no longer write-only-at-index-time.

**The query — `src/pg-vector-store.ts:67-85`:**

```
  src/pg-vector-store.ts  (search, lines 67-85)

  this.assertDim(vector);                     ← 768-dim guard; mismatch throws
  const { rows } = await this.pool.query(     ← warm pool conn (see 04-)
    `select id, content, chunk_index, document_id, meta,
            1 - (embedding <=> $1::vector) as score   ← distance → similarity
     from agents.chunks
     where app_id = $2                        ← btree-backed tenant filter
     order by embedding <=> $1::vector        ← THE seam: triggers HNSW walk
     limit $3`,                               ← k = termination of the walk
    [toVectorLiteral(vector), this.appId, k]);
        │
        └─ order-by-<=>-then-limit is the literal pattern pgvector documents
           for HNSW. Without the index this is a full scan + sort; with it,
           the planner walks the graph. The line reads identical either way —
           the index is what makes it sub-linear (load-bearing, invisible).
```

**The index — `sql/001_agents_schema.sql:30-31`:**

```
  sql/001_agents_schema.sql  (lines 30-31)

  create index if not exists chunks_embedding_hnsw
    on agents.chunks using hnsw (embedding vector_cosine_ops);
        │                  │              │
        │                  │              └─ ops class MUST match the <=>
        │                  │                 operator or the index is ignored
        │                  └─ the index type — the graph from Move 1
        └─ no WITH (m = …, ef_construction = …) → all defaults, never tuned
           and no `set hnsw.ef_search` anywhere → query-time recall is default
```

The thing to see: every parameter that controls the speed/recall trade is absent
from this line. The index is correct and load-bearing, and also completely
untuned.

## Elaborate

HNSW (Hierarchical Navigable Small World, Malkov & Yashunin 2016) is the
ANN index most production vector stores reach for — pgvector, Qdrant, Weaviate,
and Faiss all ship it. The layered-graph structure is what lets it beat the
older IVF (inverted-file) approach on the recall/latency curve for most
workloads. The pattern is vendor-independent: swap pgvector for Qdrant and you're
still tuning `m`, `ef_construction`, and `ef_search` — only the SQL changes.

What to read next: `study-database-systems` for how the planner decides to use an
index at all and how `<=>` plans; `05-no-caching.md` for the layer that would sit
*in front* of this search to skip it on repeat queries.

## Interview defense

**Q: Why is `order by embedding <=> $1 limit k` not O(N log N)?**
Because the HNSW index turns the order-by into a graph walk, not a sort. The
planner sees the index on the `embedding` column with a matching ops class and
substitutes a greedy descent that touches roughly `ef_search` nodes instead of
all N. Without the index it *would* be a full scan plus sort.

```
  with index:    walk ~ef_search nodes      → sub-linear
  without index: compute N distances + sort → O(N log N)
  same SQL, the index is the whole difference
```

Anchor: `src/pg-vector-store.ts:74` reads identically with or without the index —
the index at `sql/001_agents_schema.sql:30-31` is what makes it fast.

**Q: The load-bearing part people forget?**
The ops class. `using hnsw (embedding vector_cosine_ops)` must match the `<=>`
(cosine) operator. Build it `vector_l2_ops` and query with `<=>` and you silently
fall back to a sequential scan — fast in dev with three rows, a cliff in prod.

**Q: How would you tune it?**
Sweep `set hnsw.ef_search` (40 → 100 → 200) and read recall@k back from the eval
harness that already exists (`eval-cmd.ts:24-33`). Pick the lowest `ef_search`
that holds recall above your bar. buffr has both halves and never connects them.

## Validate

1. **Reconstruct:** draw the HNSW layered-graph descent from memory and label
   what `ef_search` controls.
2. **Explain:** why does `src/pg-vector-store.ts:74` change from O(N) to
   sub-linear purely because of `sql/001_agents_schema.sql:30-31`?
3. **Apply:** the corpus grows to 1M chunks and recall@3 drops to 0.85. Which
   knob do you turn first, and how do you measure the result using `eval-cmd.ts`?
4. **Defend:** someone says "just remove the index, it's only three eval docs."
   Argue when they're right and when adding `WITH (m=…)` becomes mandatory.

## See also

- `audit.md` § io-network-and-database-bottlenecks, § performance-red-flags (#1)
- `04-connection-pool-reuse.md` — the warm connection this search rides on
- `05-no-caching.md` — the cache that would skip this search on repeat queries
- `study-database-systems` — index types, query planning, the `<=>` operator

---

Updated: 2026-06-24 — Re-verified UNCHANGED: the search query
(`pg-vector-store.ts:67-85`) and the untuned HNSW index
(`sql/001_agents_schema.sql:30-31`) are byte-for-byte the same; the
approximate-search finding stands. Reframed the read-path entry from `ask` to a
`chat` turn, and noted the new per-turn memory upsert (`session.ts:66`) now writes
into this same index, so the searched corpus grows per turn.
