# 01 · Vector column + ANN index

**Subtitle:** embedding column with an approximate-nearest-neighbor index
(pgvector HNSW, cosine) — *Industry standard*.

---

## Zoom out, then zoom in

Here's the whole retrieval path, top to bottom. The box we're opening is the one
in the storage layer where a `vector(768)` column meets an HNSW index — that's
the single piece of schema that turns "store some text" into "find the four
chunks closest in meaning to this question."

```
  Zoom out — where the vector column lives

  ┌─ Agent layer ───────────────────────────────────────────┐
  │  RagQueryAgent.answer(question)                          │
  │     → calls search_knowledge_base tool                   │
  └───────────────────────────┬─────────────────────────────┘
                              │  embed(question) → number[768]
  ┌─ Retrieval layer ─────────▼─────────────────────────────┐
  │  RetrievalPipeline → PgVectorStore.search(vector, k)     │
  └───────────────────────────┬─────────────────────────────┘
                              │  SQL: order by embedding <=> $vec
  ┌─ Storage layer (Postgres) ▼─────────────────────────────┐
  │  agents.chunks                                           │
  │    embedding vector(768)         ★ THE COLUMN ★          │
  │    index hnsw (embedding vector_cosine_ops)  ★ THE INDEX │ ← here
  └─────────────────────────────────────────────────────────┘
```

Zoom in: the question this pattern answers is "given a 768-dimension query
vector, which stored chunks are closest, *without* comparing against every row?"
The naive answer is a full scan — compute cosine distance to all N chunks, sort,
take k. That's O(N) per query and it dies as the corpus grows. The vector column
holds the embeddings; the ANN index makes the "closest k" lookup sublinear. You
know `useState`-shaped reactivity is the same primitive across frameworks — this
is the same idea for similarity search: *embedding + ANN + retrieval* is one
shape, and pgvector is just the implementation that happens to live in this repo.

## The structure pass

Three layers, one axis held constant — **cost** (latency per query) — and the
seam is where the cost contract flips.

```
  One question down the layers: "what's the cost of finding k-nearest?"

  ┌─ app code (PgVectorStore.search) ──────────────┐
  │  one SQL round trip                             │  → cost: 1 network hop
  └───────────────────────┬─────────────────────────┘
                          │  seam: SQL → index access method
  ┌─ query planner ───────▼─────────────────────────┐
  │  chooses HNSW index scan over seq scan          │  → cost flips here:
  └───────────────────────┬─────────────────────────┘    O(N) → O(log N)-ish
  ┌─ HNSW graph on disk ──▼─────────────────────────┐
  │  greedy walk down a layered proximity graph     │  → cost: bounded hops
  └─────────────────────────────────────────────────┘
```

The load-bearing seam is the planner choosing the HNSW index. Above it, the cost
is "one query." Below it, the cost is "a graph walk, not a table scan." If the
index is missing or the planner skips it, the same SQL silently becomes O(N) —
the seam is where the cost answer flips, so it's the boundary to understand
before the mechanics. (How the HNSW graph *itself* is laid out on disk is the
storage-engine question — that's `study-database-systems`. Here we care that the
column + index exist and that the query reaches them.)

## How it works

### Move 1 — the mental model

The shape is: **store one fixed-width vector per row, then build a graph that
lets you hop toward the nearest neighbors instead of scanning every row.** You've
built graph traversal — BFS over an adjacency list, Dijkstra with your
PriorityQueue. HNSW is a graph traversal too: a greedy walk that, at each node,
steps to whichever neighbor is closer to the query, descending through layers
from coarse to fine.

```
  HNSW search — greedy descent toward the query (pattern)

  query q ●

  layer 2 (sparse)   ○────────○         enter at top, few nodes
                      \       /          jump close fast
  layer 1            ○──○──○──○──○        denser, refine
                        \  |  /
  layer 0 (all nodes) ○─○─○─●─○─○─○       densest, q's true neighbors
                              ▲
                        stop: return k closest seen
```

That's the whole idea. The column stores the `●` positions; the index stores the
`────` edges between them; the query is the floating `q` you walk toward.

### Move 2 — the walkthrough

**The column: `embedding vector(768) not null`.**
This is the one schema line the whole pattern hangs on. `vector(768)` is a
pgvector type — a fixed-width array of 768 floats. The width is not cosmetic:
it's the embedding dimension of `nomic-embed-text:v1.5`, and the column type
*rejects* any insert that isn't exactly 768-wide.

```
  File: sql/001_agents_schema.sql
  Lines: 14-25 (the chunks table)

    embedding vector(768) not null,         ← fixed-width, not-null
    embedding_model text not null
      default 'nomic-embed-text:v1.5',      ← which model produced it
```

`embedding_model` sitting next to it is the discipline that saves you: it records
*which* model's geometry this vector lives in. Cosine distance between two
vectors from different embedding models is meaningless, so storing the model
name is how a future migration knows which rows to re-embed. Here it breaks if
removed: silently mix two models' vectors and search returns garbage with no way
to tell which rows are wrong.

**The index: HNSW with `vector_cosine_ops`.**
The column alone gives you storage; the index gives you sublinear search. Without
it, `order by embedding <=> $vec` is a sequential scan computing distance to
every row.

```
  File: sql/001_agents_schema.sql
  Lines: 28-29

    create index if not exists chunks_embedding_hnsw
      on agents.chunks using hnsw (embedding vector_cosine_ops);
                                  └─ the layered proximity graph ─┘
                                                     └ the distance metric ┘
```

`vector_cosine_ops` is the operator class — it tells the index to build its
graph using *cosine* distance, which must match the `<=>` operator the query
uses. Mismatch them (build with L2, query with cosine) and the index can't be
used: the planner falls back to a seq scan and you've paid for an index that does
nothing.

**The query that reaches both.**
Here's where the column and index get used, side by side with what each clause
buys:

```
  File: src/pg-vector-store.ts
  Function: PgVectorStore.search
  Lines: 67-85

    select id, content, chunk_index, document_id, meta,
           1 - (embedding <=> $1::vector) as score   ← cosine SIM = 1 - distance
    from agents.chunks
    where app_id = $2                                ← btree narrows candidates
    order by embedding <=> $1::vector                ← <=> = cosine DISTANCE,
    limit $3                                            uses the HNSW index
```

Read it top to bottom. `<=>` is pgvector's cosine-*distance* operator — smaller
is closer. The `select` flips it to a *similarity* score (`1 - distance`) because
the calling tool wants "higher = more relevant." The `order by ... limit` is the
ANN lookup the HNSW index accelerates. The `where app_id = $2` runs first, on the
`chunks_app_id` btree (`001:30`), shrinking the set the graph walk considers.

```
  Layers-and-hops — one search call, every hop labelled

  ┌─ Retrieval ──┐  hop1: search(vec,k)   ┌─ pg pool ─────────┐
  │ pipeline     │ ─────────────────────► │ one query()        │
  └──────────────┘  hop4: Hit[] ◄──────── └────────┬───────────┘
                                            hop2 SQL│ with $vec
                                                    ▼
                                          ┌─ Postgres ─────────┐
                                          │ btree app_id  →     │
                                          │ HNSW graph walk →   │
                                          │ top-k rows          │
                                          └────────┬───────────┘
                                            hop3 rows│
                                                     ▼ map → meta rebuild
```

**The boundary condition.** `assertDim` (`pg-vector-store.ts:32-36`) throws if
the query vector isn't 768-wide *before* the SQL runs — so a dimension bug fails
loud in TypeScript, not as a cryptic pgvector cast error. The `vector(768)`
column type is the second guard at insert time. Both agree on 768; that
belt-and-suspenders is deliberate (context.md: "a mismatch must throw, never
silently truncate").

### Move 2 variant — the load-bearing skeleton

Strip this pattern to what can't be removed:

```
  the irreducible kernel
    1. a fixed-width vector column        ← store the geometry
    2. an ANN index using a distance op   ← make lookup sublinear
    3. a query whose operator MATCHES      ← <=> must match cosine_ops
       the index's operator class
    4. a top-k order-by + limit            ← the actual retrieval
```

- Drop **(1)** the fixed width → you can't index; vectors of varying length have
  no shared geometry.
- Drop **(2)** the index → every search is O(N); correct but dies at scale.
- Break **(3)** the operator match → the index exists but is never used; you
  silently fall back to a seq scan.
- Drop **(4)** the limit → you sort the whole table; the ANN win evaporates.

Optional hardening, *not* the kernel: `embedding_model` provenance, the
`app_id` pre-filter, the `1 - distance` score flip. Useful, but the pattern is
still itself without them.

### Move 3 — the principle

An index is a bet that a specific query is hot enough to pay storage for. The
vector-column-plus-ANN-index pattern is that bet made for similarity search: you
accept extra write cost and disk to turn an O(N) scan into a graph walk. The
discipline that makes it correct isn't the index — it's that the query's distance
operator must match the index's operator class. An index the query can't use is
pure cost.

## Primary diagram

The full pattern in one frame — column, index, query, and the layers they cross.

```
  Vector column + ANN index — the complete picture

  ┌─ Storage: agents.chunks ────────────────────────────────┐
  │  id text pk                                              │
  │  app_id text          ──► index chunks_app_id (btree)    │
  │  embedding vector(768)──► index chunks_embedding_hnsw    │
  │  embedding_model text     (hnsw, vector_cosine_ops)      │
  │  content text                                            │
  └───────────────────────────┬─────────────────────────────┘
                              ▲ │
       query (search:70-77)  │ │  planner: btree filter, then
       where app_id=$2 ──────┘ │  HNSW greedy walk, top-k
       order by embedding<=>$1 ┘
                              │
                              ▼
              k Hit{ id, score=1-dist, meta }  → tool citations
```

## Elaborate

HNSW (Hierarchical Navigable Small World) is the index pgvector reaches for when
you want recall without an exhaustive scan. The layered structure is the same
trick a skip-list uses: sparse upper layers for big jumps, dense lower layers for
precision. It's *approximate* — it can miss a true neighbor — which is the
tradeoff you accept for sublinear search. For a single-device personal RAG corpus
that's the right call; the recall loss is invisible and the latency win is real.

Where to read next: `study-database-systems` for how the HNSW graph is actually
stored and walked at the page level, and `02-text-stored-twice.md` for the `meta`
rebuild that happens to the rows this query returns.

## Interview defense

**Q: Why does the `<=>` operator in the query have to match `vector_cosine_ops`
in the index?**

Because the index *is* a graph built using one specific distance function. If you
build the HNSW graph with cosine distance but query with L2, the planner can't
prove the index answers the query, so it falls back to a sequential scan — you've
paid the index's write and storage cost for nothing.

```
  build:  hnsw (embedding vector_cosine_ops)   ← graph uses cosine
  query:  order by embedding <=> $vec          ← <=> IS cosine distance
                                  └─ match → index used; mismatch → seq scan
```

Anchor: "the operator class is a contract between the index and the query — break
it and the index goes dark."

**Q: What's the one column people forget that makes this safe over time?**

`embedding_model`. Cosine distance is only meaningful between vectors from the
same model's geometry. Store the model name per row and a re-embedding migration
knows exactly which rows are stale; drop it and mixed-model vectors silently
poison search with no way to tell which rows are wrong.

```
  embedding_model text not null default 'nomic-embed-text:v1.5'
       └─ the provenance that makes "re-embed everything" a safe query
```

Anchor: "the embedding is the data; the model name is the data's coordinate
system — store both or the geometry rots."

## See also

- `02-text-stored-twice.md` — what `search` does to the rows it returns here.
- `05-app-id-tenant-column.md` — the `where app_id = $2` pre-filter in this query.
- `audit.md` Lens 3 — indexes vs queries, and the latent `messages` gap.
- `study-database-systems` — how HNSW is laid out and walked beneath this column.
