# B-tree, hash, and secondary indexes

**Industry name:** secondary indexes / the B-tree · the ANN index (HNSW) —
*Industry standard*

---

## Zoom out — where this concept lives

Indexes sit in the access-methods band: between the planner (which decides whether
to use one) and the heap (where the rows actually are). buffr has two *kinds* of
index doing very different jobs — exact-match B-trees on the keys, and one
approximate-nearest-neighbour index (the ANN index, HNSW) on the embedding column.

```
  where indexes sit

  ┌─ Execution layer ───────────────────────────────────┐
  │  planner: "is there an index that serves this query?"│
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ Access methods ──────────▼──────────────────────────┐
  │  ★ B-tree (primary keys, app_id)  ★                   │
  │  ★ the ANN index (HNSW, vector_cosine_ops) ★          │
  └───────────────────────────┬──────────────────────────┘
                              │ ctid → heap fetch
  ┌─ Storage layer ───────────▼──────────────────────────┐
  │  heap pages (the actual rows)                        │
  └───────────────────────────────────────────────────────┘
```

---

## Zoom in — narrow to the concept

The question: *for each query buffr runs, is there an index that turns an O(n) scan
into an O(log n) — or for vectors, an O(log n)-ish approximate — lookup, and is it
the RIGHT one?* Two index families answer differently. The B-tree is the workhorse
you already know (primary keys, the `app_id` filter). The ANN index (HNSW) is the
one that makes vector search fast — and the one with a subtle correctness trap: it
only works if the *operator* in your query matches the *opclass* the index was built
with. Name both, then walk how each serves a real buffr query.

---

## The structure pass

### Layers

```
  query predicate          →  what the WHERE/ORDER BY asks for
    index choice           →  which access method can serve it
      index structure      →  B-tree (sorted) or HNSW (proximity graph)
        heap fetch         →  index gives ctid, heap gives the row
```

### Axis: trace *"how does this index find the row?"* across the two families

```
  "how does the index locate matches?"  — B-tree vs HNSW

  ┌─ B-tree (exact / range) ──────────────────────────┐
  │  sorted keys → binary-search down to the leaf      │  → EXACT. log(n).
  │  used by: chunks PK (id), app_id filter            │     always correct.
  └────────────────────────────────────────────────────┘
                       │  the axis FLIPS here
  ┌─ HNSW (approximate nearest neighbour) ────────────┐
  │  multi-layer proximity graph → greedy walk toward  │  → APPROXIMATE.
  │  the query vector                                  │     fast, may miss
  │  used by: chunks.embedding <=> query               │     a true top-k.
  └────────────────────────────────────────────────────┘

  the answer flips from EXACT to APPROXIMATE — that's the load-bearing
  difference between every other index in the repo and the vector one.
```

### Seams

```
  seam 1  operator ↔ opclass   THE correctness seam. The query operator (<=>) must
                              match the opclass the index was built with
                              (vector_cosine_ops). Mismatch = the index is invisible
                              to the planner = silent seq scan. → file 04
  seam 2  index ↔ heap         the index returns a row location (ctid); the heap
                              returns the row. A vector search still hits the heap
                              for `content`.
```

Hand off: two families — exact B-tree, approximate HNSW; the operator/opclass
alignment is the seam that decides whether the ANN index is used at all.

---

## How it works

### Move 1 — the mental model

You've built a Binary Search Tree from scratch — `BinarySearchTree.ts`, insert /
search / delete, all three traversals. A B-tree *is* a BST flattened for disk: same
"go left or right by comparison" idea, but each node holds many keys so the tree
stays shallow and each node is one 8 KB page. That's the exact-match index.

The ANN index is a different animal — it's closer to a *graph search*, which you've
also built (BFS/DFS over `Graph.ts`, Dijkstra over `Graph2.ts`). HNSW is a layered
proximity graph: you start at a coarse top layer, greedily hop toward the query
vector, then drop a layer and refine. It's a navigable small-world graph, walked
greedily — Dijkstra's cousin, trading exactness for speed.

```
  two index shapes

  B-tree (exact):                 HNSW (approximate):
        [m | r]                    layer 2:  • ───────── •     (few nodes, long hops)
       /   |   \                              \
   [a,c] [n,p] [s,z]              layer 1:  •─•───•──•──•      (more nodes)
     │     │     │                            \  greedy walk
   leaves point to ctids         layer 0:  •••••••••••••••     (all vectors)
                                            ▲ enter top, descend toward query vector
   log(n), always correct        sub-linear, may miss a true neighbour
```

### Move 2 — walk each index

**The B-tree primary keys — exact lookup, the boring-correct workhorse.** Every
`primary key` declaration creates a B-tree automatically.

```sql
-- sql/001_agents_schema.sql
id text primary key            -- chunks: B-tree on id (line 15)
                               -- documents.id, conversations.id, messages.id, profiles.id too
```

This is what serves `on conflict (id)` in `upsert` — the conflict check is a B-tree
probe on `chunks.id`. It's also what `indexDocumentRow`'s `on conflict (id)` uses for
`documents`. Exact, O(log n), never wrong. Nothing to tune.

**The `app_id` B-tree — the filter index.** One explicit secondary B-tree.

```sql
-- sql/001_agents_schema.sql:30
create index if not exists chunks_app_id on agents.chunks (app_id);
```

`search` filters `where app_id = $2` (`pg-vector-store.ts:74`). For a single-device
app every chunk has `app_id = 'laptop'`, so this index is *low-selectivity* — it can't
narrow much when 100% of rows match. **Consequence:** the planner will likely ignore
`chunks_app_id` and lean entirely on the vector index for the search query, because
filtering on a column where every row is identical buys nothing. The index earns its
place only if a second `app_id` ever shows up.

**The ANN index (HNSW) — approximate nearest neighbour, the star.** This is the
index that makes RAG fast, and the one with the trap.

```sql
-- sql/001_agents_schema.sql:28-29
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);
--                      ▲ access method     ▲ THE OPERATOR CLASS — load-bearing
```

Read that `vector_cosine_ops` carefully — it's the whole ballgame. An opclass tells
the index *which distance function it's organised around*. `vector_cosine_ops` builds
the proximity graph using **cosine distance**. There are siblings:
`vector_l2_ops` (Euclidean) and `vector_ip_ops` (inner product). An HNSW index built
for one distance **cannot** serve a query that orders by a different one.

**The alignment — operator ↔ opclass.** Now look at the query side:

```ts
// src/pg-vector-store.ts:75
order by embedding <=> $1::vector
//                 ▲ <=> is the COSINE DISTANCE operator
```

```
  the alignment that decides everything

  index opclass:   vector_cosine_ops   ←──── MUST MATCH ────►   query operator:  <=>
  (schema line 29)                                              (search line 75)

  ┌─ ALIGNED (buffr's actual state) ───────────────┐
  │  <=>  ⟷  vector_cosine_ops                      │  → planner uses HNSW. fast.
  └─────────────────────────────────────────────────┘

  ┌─ MISALIGNED (e.g. index built vector_l2_ops) ──┐
  │  <=>  ⟷  vector_l2_ops                          │  → planner CAN'T use the index.
  │         (no error! no warning!)                 │     silent SEQUENTIAL SCAN.
  └─────────────────────────────────────────────────┘     correct results, but O(n).
```

buffr is **aligned** — `<=>` matches `vector_cosine_ops`. So the planner uses the
HNSW index, and search is fast. The reason this is the #1 finding in the overview:
the failure mode is *silent*. Build the index with `vector_l2_ops` by mistake and
nothing throws — your results are still *correct* (the `<=>` operator computes cosine
distance row-by-row in a seq scan), just slow, and they get slower linearly as the
corpus grows. No exception, no log line. The only way to catch it is `EXPLAIN`
(file `04`), which the repo doesn't run.

The operator cheat-sheet, because the symbols are easy to confuse:

```
  pgvector operators ↔ opclasses

  <=>   cosine distance      ⟷  vector_cosine_ops    ← buffr uses this pair
  <->   L2 (Euclidean)       ⟷  vector_l2_ops
  <#>   negative inner prod   ⟷  vector_ip_ops
```

**The index keeps its own vector copy — the heap fetch still happens.** HNSW stores
the vectors inside the graph, so the *proximity walk* never touches the heap. But
`search` selects `content`, `chunk_index`, `document_id`, `meta`
(`pg-vector-store.ts:71`) — none of which are in the index. So after HNSW returns the
top-k row locations, the executor does a heap fetch per row to get those columns.
That's the index↔heap seam: index for *which rows*, heap for *the rest of the row*.

**Write cost — the part B-trees and HNSW differ on most.** A B-tree insert is cheap:
find the leaf, slot the key. An HNSW insert is expensive: the new vector has to be
*linked into the proximity graph* at multiple layers, which means distance
computations against existing neighbours. Tie this back to file `02`: every
`on conflict do update` in `upsert` writes a new tuple, and the new tuple needs a
*new HNSW entry* while the old one becomes a dead index entry. Re-indexing a corpus
isn't just heap bloat — it's repeated graph surgery. That's the write-amplification
cost you pay for fast reads.

### Move 3 — the principle

An index is a bet that reads outnumber writes and that the query shape is known in
advance. B-trees are the safe bet — exact, cheap to maintain, no tuning. ANN indexes
are a *different* bet: you trade exactness for sub-linear search, and you take on a
new failure mode that doesn't exist for B-trees — the operator and the opclass must
agree, and the engine won't tell you if they don't. The discipline that protects you
is `EXPLAIN`: an index you can't prove the planner is using is an index you don't
have.

---

## Primary diagram

The full index picture: two families, the alignment seam, the heap fetch.

```
  buffr indexes — full recap

  ┌─ a query arrives ────────────────────────────────────────────────┐
  │                                                                   │
  │  exact key?  ──────────────────────► B-tree (id PK, app_id)       │
  │  "where id = X" / "on conflict (id)"   exact, log(n), always right│
  │                                                                   │
  │  vector proximity?  ───────────────► the ANN index (HNSW)         │
  │  "order by embedding <=> q"            ┌──────────────────────┐   │
  │                                        │ <=> MUST match        │   │
  │                                        │ vector_cosine_ops     │   │
  │                                        │ ✓ aligned in buffr    │   │
  │                                        └──────────┬───────────┘   │
  │                                                   │ top-k ctids   │
  └───────────────────────────────────────────────────┼──────────────┘
                                                      ▼
  ┌─ heap fetch ─────────────────────────────────────────────────────┐
  │  index gave row locations; heap gives content/meta/document_id    │
  └───────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

HNSW (Hierarchical Navigable Small World) is the index pgvector 0.5+ added alongside
the older IVFFlat. The difference: IVFFlat clusters vectors into lists and probes a
few lists (you tune `lists` and `probes`); HNSW builds a navigable graph and walks it
(you tune `m`, `ef_construction`, `ef_search`). HNSW gives better recall-vs-speed for
most workloads, which is why the schema picks it. buffr uses **all defaults** for
those parameters — `using hnsw (...)` with no `WITH (m = ..., ef_construction = ...)`.
That's the right call for a small single-device corpus and a tuning gap the moment
recall or build time disappoints (`study-performance-engineering` owns the
recall/latency curve; see the "not yet exercised" note in `00`).

The opclass concept generalises beyond vectors: every Postgres index is built around
an operator class, B-trees included (`text_ops`, `int4_ops`). You just never think
about it for B-trees because the defaults always match. Vectors force the choice into
the open because there are three plausible distance functions and no universally
right default.

---

## Interview defense

**Q: "What happens if the HNSW index is built with the wrong opclass?"**

```
  the silent-scan trap

  query:  order by embedding <=> q     (cosine distance)
  index:  hnsw (embedding vector_l2_ops)  (Euclidean — WRONG)
            │
            ▼
  planner: "no index matches this operator" → SEQUENTIAL SCAN
            │
            ▼
  result:  CORRECT (computes <=> per row), but O(n), no error, no warning
```

Answer: "Nothing breaks loudly — that's the danger. The planner can only use an HNSW
index when the query operator matches the index's opclass. If the index is
`vector_l2_ops` but the query uses `<=>` (cosine), the planner silently falls back to
a sequential scan, computing cosine distance row by row. Results stay correct; they
just go O(n) and get slower as the corpus grows. The only way to catch it is
`EXPLAIN` — there's no exception." Anchor: *operator and opclass must agree, and a
mismatch is silent.*

**Q: "Why is `chunks_app_id` probably dead weight right now?"**

Answer: "It's a B-tree on a column where every row is `'laptop'` — zero selectivity
on a single-device app. The planner won't use an index that can't narrow the result,
so it leans on the vector index alone. The `app_id` index only earns its keep when a
second `app_id` exists." Anchor: *an index on a constant column buys nothing.*

---

## See also

- `02-records-pages-and-storage-layout.md` — HNSW keeps its own vector copy; the heap
  fetch for `content`; the dead-index-entry churn on update.
- `04-query-planning-and-execution.md` — how the planner *uses* (or skips) these
  indexes, and the EXPLAIN discipline that proves it.
- `06-locks-mvcc-and-concurrency-control.md` — why every update re-inserts the HNSW
  entry.
- `study-performance-engineering` — HNSW `m` / `ef_search` recall-vs-latency tuning.
