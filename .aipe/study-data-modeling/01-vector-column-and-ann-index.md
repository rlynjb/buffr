# Vector Column + ANN Index

**Industry names:** vector column / approximate-nearest-neighbor (ANN) index
/ HNSW (Hierarchical Navigable Small World). **Type:** Industry standard.

## Zoom out, then zoom in

Here's the whole retrieval path, and the one box that makes it fast enough to
be a product.

```
  Zoom out — where the vector column lives

  ┌─ CLI layer ─────────────────────────────────────────┐
  │  npm run chat   →   ChatSession.ask()  →  RagQueryAgent│
  └───────────────────────────┬──────────────────────────┘
                              │  tool call: search_knowledge_base
  ┌─ Pipeline layer (aptkit) ─▼──────────────────────────┐
  │  embed query → store.search(vector, k)               │
  └───────────────────────────┬──────────────────────────┘
                              │  SQL: order by embedding <=> $1
  ┌─ Storage layer (Postgres + pgvector) ───────────────┐
  │  agents.chunks                                       │
  │    embedding vector(768)   ★ THIS CONCEPT ★          │ ← we are here
  │    chunks_embedding_hnsw (vector_cosine_ops)         │
  └──────────────────────────────────────────────────────┘
```

**Zoom in.** Two things make this work together: a **column typed
`vector(768)`** that stores an embedding as a first-class value Postgres can
compute distance over, and an **HNSW index** so finding the nearest vectors
isn't a scan of every row. The question this answers: *given a query
embedding, return the k closest chunks without comparing against all of
them.*

## The structure pass

**Layers:** (1) the column — a typed 768-float value per row. (2) the
distance operator — `<=>` computes cosine distance between two vectors. (3)
the index — HNSW, a navigable graph over the vectors so the operator doesn't
run row-by-row.

**Axis — cost (work per query):** trace it down. Without the index, the
`order by embedding <=> $1` is O(N) distance computations — every chunk,
every query. With HNSW it's roughly O(log N) graph hops to a good-enough
neighbor set. The axis flips at the index seam: above it the query is a
sequential scan; below it, a graph walk.

**Seam:** the load-bearing boundary is **exact vs approximate**. A B-tree
gives exact answers; HNSW gives *approximate* nearest neighbors — it can miss
a true neighbor to stay fast. That's the contract: you trade recall for
latency, and you tune it. That seam is where the index earns its name.

## How it works

### Move 1 — the mental model

You know how a B-tree index turns `where age > 30` from a table scan into a
range walk down a sorted tree? HNSW does the same job for "closest vector,"
except *closest* isn't a sortable scalar — it's a distance in 768-dimensional
space. So the index isn't a sorted tree; it's a **navigable graph** you greedily
walk toward the query point.

```
  HNSW — greedy descent through layered graphs

  query q  ●
           │  enter at sparse top layer
  layer 2  ○───────○        (few nodes, long hops)
           │       │
  layer 1  ○──○──○──○──○     (more nodes, medium hops)
              │  │
  layer 0  ○─○─○─○─○─○─○─○   (all nodes, short hops)
                 ▲
                 └─ greedily hop to the neighbor
                    closest to q; stop when no
                    neighbor is closer → that's
                    your approximate nearest set
```

You drop in at a sparse top layer, hop to whichever neighbor is closest to
`q`, descend a layer, repeat. By the bottom you're in the right
neighborhood — having touched a handful of nodes, not all N.

### Move 2 — the load-bearing skeleton

The kernel, named by what breaks if removed:

- **the typed column `vector(768)`.** Drop the type and you're storing floats
  in a `float[]` or jsonb — Postgres can't apply `<=>` and can't index it for
  ANN. The type is what makes distance a first-class operation. Drop it: no
  vector search at all.
- **the distance operator `<=>`.** This is cosine distance. Drop it (use
  Euclidean `<->` instead) and your scores stop matching the cosine
  similarity the embedding model was trained for — retrieval quality
  silently drops.
- **the HNSW index with `vector_cosine_ops`.** The op-class must match the
  operator. Drop the index and every query is correct but O(N) — a full scan
  computing distance to every chunk. Drop *just the op-class match* (index
  built for L2 but query uses cosine) and Postgres ignores the index and
  scans anyway. The pairing is load-bearing.

**Skeleton vs hardening.** Kernel: typed column + matching operator + matching
op-class index. Hardening (not present here, and that's fine at this scale):
HNSW build params (`m`, `ef_construction`), query-time `ef_search` tuning,
per-tenant partial indexes. None of those are in the schema — the defaults are
taken.

### Move 3 — the principle

An ANN index is a recall/latency trade made explicit in the schema. The
moment you write `using hnsw`, you've decided "approximate is good enough,
and I'll buy log-time lookups with it." The exact-search version
(no index, sequential scan) is always available as the correctness baseline —
which is exactly how you'd validate that HNSW isn't dropping real neighbors.

## Primary diagram

The full path, one frame, every layer labeled.

```
  chat → embed → ANN search → cited answer

  ┌─ CLI ────────┐  question text
  │ chat.tsx /   │ ─────────────────────────┐
  │ session.ts   │                          ▼
  ┌─ aptkit pipeline ───────────────────────────────────┐
  │ OllamaEmbeddingProvider  →  number[768]              │
  │ PgVectorStore.search(vector, k)                      │
  └───────────────────────────┬──────────────────────────┘
                              │  SQL
  ┌─ Postgres + pgvector ─────▼──────────────────────────┐
  │ select id, content, 1 - (embedding <=> $1) as score  │
  │ from agents.chunks                                    │
  │ where app_id = $2                                     │
  │ order by embedding <=> $1::vector   ← HNSW serves this│
  │ limit $3                                              │
  └───────────────────────────┬──────────────────────────┘
                              │  rows: id, content, score
  ┌─ back in pipeline ────────▼──────────────────────────┐
  │ meta rebuilt → search_knowledge_base citations        │
  └───────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case.** Every `npm run chat` turn and every `eval-cmd` query hits this.
The memory-recall path (`@aptkit/memory`) also runs `store.search` over the
same index, so episodic recall and corpus retrieval share one HNSW graph. The
agent calls `search_knowledge_base`, aptkit embeds the query to 768 floats,
and `PgVectorStore.search` runs the ANN query. The HNSW index is the
difference between sub-second retrieval and scanning the entire `chunks`
table per question.

**The column and index — `sql/001_agents_schema.sql:22,28-29`:**

```
  embedding vector(768) not null         ← typed column; null/wrong-dim
                                            can't enter (DB-side dim guard)

  create index if not exists chunks_embedding_hnsw
    on agents.chunks using hnsw (embedding vector_cosine_ops);
       │                              │
       │                              └─ op-class MUST match the <=> operator
       │                                 used at query time, or the index is
       │                                 ignored and the query scans
       └─ HNSW: without this line the order-by below is O(N) per query
```

**The query — `src/pg-vector-store.ts:70-78`:**

```
  select id, content, chunk_index, document_id, meta,
         1 - (embedding <=> $1::vector) as score   ← <=> is cosine DISTANCE;
  from agents.chunks                                  similarity = 1 - distance
  where app_id = $2                                 ← B-tree filter, NOT in HNSW
  order by embedding <=> $1::vector                 ← THIS is what HNSW serves
  limit $3                                          ← k; HNSW returns ~k fast
       │
       └─ note: the where app_id filter and the HNSW order-by don't compose
          inside the index — Postgres walks HNSW, then filters app_id. Fine at
          one tenant; under many it can under-fill k (see 05).
```

**The dimension guard — `src/pg-vector-store.ts:32-36,68`:** `assertDim` runs
before every search and every write, so a wrong-length vector throws in app
code *before* the `vector(768)` column would reject it at the DB. Belt and
suspenders, both honoring the must-not-change 768 constraint.

## Elaborate

HNSW comes from the navigable-small-world line of ANN research — the insight
that a graph with both short-range and long-range links lets greedy search
reach any node in roughly log-time, like the "six degrees" small-world
effect. `pgvector` ships HNSW and IVFFlat; HNSW trades higher build cost and
memory for better recall-at-speed and no training step, which is why it's the
default reach for a corpus that changes. The op-class (`vector_cosine_ops`
vs `vector_l2_ops` vs `vector_ip_ops`) pins which distance the graph is built
for — get it wrong and the index is dead weight. Read next:
`study-database-systems` for how the index actually stores and traverses on
disk, and `02-text-stored-twice` for why `content` rides along in the SELECT.

## Interview defense

**Q: Why HNSW and not just `order by` the distance?**

```
  without index:  scan ALL N chunks, compute N distances   → O(N)
  with HNSW:      greedy graph walk, touch ~log N nodes     → O(log N)
                  (approximate — may miss a true neighbor)
```
Answer: the bare `order by embedding <=> $1` is correct but O(N) per query —
a full distance scan. HNSW makes it a log-time graph walk. The cost is
approximation: it can miss a true nearest neighbor. At my corpus size that
trade is free recall-wise and a large latency win. **Anchor:**
`sql/001_agents_schema.sql:28` is the whole trade in one line.

**Q: What's the one thing people get wrong with pgvector indexes?**

The op-class / operator mismatch. If the index is `vector_cosine_ops` but the
query uses `<->` (L2), Postgres silently ignores the index and scans. The
load-bearing pairing is "index op-class == query operator." **Anchor:**
`vector_cosine_ops` at `:29` matches `<=>` at `pg-vector-store.ts:76`.

## Validate

1. **Reconstruct:** draw the three-layer HNSW greedy descent from memory.
2. **Explain:** why does `where app_id = $2` not benefit from the HNSW index?
   (`src/pg-vector-store.ts:75`)
3. **Apply:** the corpus grows 100×, recall drops. Which knobs do you reach
   for, and why are none of them in the schema today?
4. **Defend:** justify approximate-over-exact for this app. When would you
   keep the sequential scan instead? (`sql/001_agents_schema.sql:28`)

## See also

- `02-text-stored-twice.md` — why `content` is in the SELECT alongside the vector.
- `05-app-id-tenant-column.md` — the `where app_id` filter HNSW can't use.
- `audit.md` §3 — indexing-vs-query, the post-filter gap.
- `study-database-systems` — HNSW on-disk layout and traversal mechanics.

---
Updated: 2026-06-24 — `ask`/`ask-cmd.ts` refs → `chat`/`session.ts`; noted the
`@aptkit/memory` recall path also searches this same HNSW index.
