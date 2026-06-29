# Vector column + ANN index

**Industry name(s):** vector column with an approximate-nearest-neighbour
(ANN) index — here the embedding column (`embedding vector(768)`) under an
HNSW index (`chunks_embedding_hnsw`). **Type:** Industry standard
(pgvector / HNSW).

---

## Zoom out, then zoom in

You already know the RAG shape: embed → retrieve → augment → generate. This
file is the *retrieve* — specifically, the one table column and the one index
that make "find the k most similar chunks" a single SQL statement instead of a
full table scan.

```
  Zoom out — where the vector column lives

  ┌─ CLI / UI layer ─────────────────────────────────────────┐
  │  Ink chat → session.ask(question)                         │
  └───────────────────────────────┬───────────────────────────┘
                                  │  embed the question
  ┌─ Retrieval layer (aptkit) ────▼───────────────────────────┐
  │  RetrievalPipeline → search_knowledge_base tool           │
  │       → VectorStore.search(vector, k)                     │
  └───────────────────────────────┬───────────────────────────┘
                                  │  one SQL query
  ┌─ Storage layer (Postgres) ────▼───────────────────────────┐
  │  agents.chunks                                            │
  │    ★ embedding vector(768)  ★ ── the vector column        │
  │    ★ chunks_embedding_hnsw  ★ ── the ANN index            │ ← here
  │    where app_id = $ · order by embedding <=> $ · limit k  │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is "given a 768-number query vector, which stored chunks
are closest — fast, without comparing against every row?" The answer is two
schema objects working together: a typed vector column to hold the embedding,
and an HNSW index that turns the nearest-neighbour search from O(n) into a
graph walk.

---

## The structure pass

Layer the thing, pick one axis, find the seam.

```
  Three layers, one axis = "what shape is a vector here?"

  ┌─ app (TypeScript) ──────────────────────────────────────┐
  │  number[]  — a JS array of 768 floats                    │  cost axis:
  └─────────────────────────┬────────────────────────────────┘  in-memory,
                            │  seam: toVectorLiteral()          free to read
  ┌─ wire (SQL param) ──────▼────────────────────────────────┐
  │  "[0.1,0.2,...]"  — a text literal cast ::vector          │  serialized
  └─────────────────────────┬────────────────────────────────┘  once per call
                            │  seam: column type vector(768)
  ┌─ disk (pgvector) ───────▼────────────────────────────────┐
  │  packed float array + HNSW graph node                    │  indexed,
  └──────────────────────────────────────────────────────────┘  walked
```

The axis that makes the boundaries pop is **representation of the vector**. It
flips twice: a JS `number[]` becomes a text literal at `toVectorLiteral`
(`pg-vector-store.ts:15-17`), then the text literal becomes a packed,
HNSW-indexed on-disk vector at the `::vector` cast against the `vector(768)`
column. Those two casts are the seams — the contracts where one layer hands the
vector to the next in a different shape. Everything mechanical hangs off them.

---

## How it works

### Move 1 — the mental model

The shape: a B-tree lets you binary-search a *scalar* column; HNSW lets you
"binary-search" a *vector* column — except the geometry is 768-dimensional, so
instead of a sorted tree it's a layered graph you greedily walk toward the
query point. You drop in at the top (sparse) layer, hop to the nearest
neighbour you can see, descend a layer, repeat. You never look at most rows.

```
  HNSW — greedy descent through layers (the index shape)

  layer 2 (sparse)   ●─────────────●            entry
                      \           /              point
  layer 1            ●──●────●───●──●            hop to nearest
                      \  \   /   /                visible neighbour
  layer 0 (dense)   ●─●─●─●─●─●─●─●─●  ← query lands here, among
                          ▲              its true nearest k
                          └─ collect k nearest, return

  never compares against every row → approximate, but ~log(n) hops
```

That's the index. The *column* is the simpler half: a fixed-width slot that
holds exactly 768 floats and rejects anything else.

### Move 2 — the walkthrough

**The vector column — a typed slot that rejects bad dimensions.**
The column is declared `embedding vector(768) not null`
(`sql/001_agents_schema.sql:22`). The `768` is not decoration — it's a
constraint. Try to store a 512-float vector and Postgres throws. That's the
database half of the "embeddings are always 768-dim" invariant; the app half
is `assertDim` (`pg-vector-store.ts:32-36`), which throws *before* the write so
you get a clear app-level error instead of a SQL error mid-transaction. Belt
and suspenders — both guard the same fact.

```
  Two guards, one invariant — dimension = 768

  app:   assertDim(v)  ── throws if v.length !== 768   pg-vector-store.ts:32
                          (before any SQL runs)
  db:    embedding vector(768)  ── rejects wrong width  001:22
                                   (last line of defense)
```

**Writing a vector — serialize to pgvector's text literal.**
node-postgres can't hand a JS `number[]` straight to a `vector` column, so the
store serializes it to pgvector's text form `[0.1,0.2,...]` and casts it
(`$6::vector`). Here's the exact code, annotated:

```ts
// pg-vector-store.ts:15-17
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;          // → "[0.1,0.2,0.3,...]" — pgvector's text form
}

// pg-vector-store.ts:47-56  (inside upsert, per chunk)
await client.query(
  `insert into agents.chunks (id, document_id, app_id, chunk_index,
     content, embedding, embedding_model, meta)
   values ($1, $2, $3, $4, $5, $6::vector, $7, $8)   // $6::vector ── text → vector cast
   on conflict (id) do update set ...`,              // upsert: re-index overwrites
  [c.id, docId, this.appId, chunkIndex, content,
   toVectorLiteral(c.vector), this.embeddingModel, c.meta],
);
```

The `$6::vector` is the write-side seam: the text literal crosses into the
typed column here, and the `vector(768)` declaration is what validates it.

**Reading — the ANN query that the HNSW index serves.**
The search is one statement. The index makes the `order by embedding <=> $1`
fast; without it that ordering is a full scan that computes distance against
every row.

```ts
// pg-vector-store.ts:70-78
const { rows } = await this.pool.query(
  `select id, content, chunk_index, document_id, meta,
          1 - (embedding <=> $1::vector) as score   // <=> is cosine DISTANCE
   from agents.chunks                                //   similarity = 1 - distance
   where app_id = $2                                 // tenant filter (chunks_app_id idx)
   order by embedding <=> $1::vector                 // ANN order (HNSW idx)
   limit $3`,                                         // top-k
  [toVectorLiteral(vector), this.appId, k],
);
```

The `<=>` operator is cosine *distance*; the query converts it to a similarity
*score* with `1 - distance` so callers get the intuitive "1.0 = identical"
number. The index that makes this cheap is declared once:

```sql
-- sql/001_agents_schema.sql:28-29
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);
```

`vector_cosine_ops` is the operator class — it tells HNSW to build the graph
using cosine distance, matching the `<=>` in the query. The index op-class and
the query operator **must** agree, or the planner won't use the index and you
silently fall back to a full scan. That's the load-bearing pairing: same
distance metric on both sides.

**The boundary condition — the index is global, the filter is not.**
The HNSW index has no `where app_id` predicate, so it's built over *all*
chunks. The `app_id = $2` filter is applied alongside the ANN walk, not baked
into the index. On the single `'laptop'` tenant that's a non-issue — there's
effectively one tenant. At multi-tenant scale you'd want a partial index per
tenant or a composite scheme, or the ANN walk wastes work on rows it'll filter
out. Named so it's not a surprise later.

### Move 3 — the principle

A typed column plus the *matching* index turns an O(n) scan into a sub-linear
lookup — but only when the index's distance metric and the query's operator are
the same metric. The vector column holds the data; the index holds the
*access path*; the operator class is the contract that binds them. Get the
op-class wrong and you have an index the planner ignores — the worst kind of
index, because it costs writes and buys no reads.

---

## Primary diagram

The full retrieve path, every layer and hop labelled.

```
  Vector column + ANN index — the full read path

  ┌─ app ─────────────────────────────────────────────────────┐
  │  query string → embedder → number[768]                     │
  │                              │ assertDim (001:throws if≠768)│
  │                              ▼                              │
  │  toVectorLiteral → "[...]"   (pg-vector-store.ts:15)        │
  └──────────────────────────────┬─────────────────────────────┘
                                 │  hop: SQL param $1::vector
  ┌─ Postgres (agents.chunks) ───▼─────────────────────────────┐
  │  where app_id = $2           ── chunks_app_id index (001:30)│
  │  order by embedding <=> $1    ── chunks_embedding_hnsw      │
  │                                  (hnsw vector_cosine_ops,   │
  │                                   001:28) walks the graph   │
  │  limit k                                                    │
  └──────────────────────────────┬─────────────────────────────┘
                                 │  hop: rows back
  ┌─ app ────────────────────────▼─────────────────────────────┐
  │  map → { id, score:1-dist, meta:{docId,chunkIndex,text} }   │
  │  (pg-vector-store.ts:80-84) — rebuilds in-memory meta shape │
  └────────────────────────────────────────────────────────────┘
```

---

## Elaborate

HNSW (Hierarchical Navigable Small World) is the default pgvector index for
recall-sensitive ANN — it trades a little accuracy (approximate, not exact
nearest neighbour) for a huge speed win, and it's what most production RAG runs
on. The alternative pgvector index, IVFFlat, partitions vectors into lists and
scans the nearest few; it's faster to build but needs tuning (`lists`,
`probes`) and is more sensitive to data distribution. This repo picked HNSW —
the right default when you don't want to tune and recall matters.

The deeper engine mechanics — how HNSW lays its graph on disk, how the planner
decides to use the index, how `<=>` executes — belong to **study-database-
systems**. Here the lesson is the *schema shape*: one typed column, one index,
one operator class, all agreeing on cosine.

Worth knowing: this same `chunks` table and HNSW index also serve *episodic
memory* — memory chunks (`meta.kind='memory'`) ride the identical column and
index, so "remember a past exchange" reuses the exact retrieval path.
`06-trajectory-tables.md` and `03-soft-link-no-fk.md` cover that overload.

---

## Interview defense

**Q: Why does the column declare `vector(768)` instead of just `vector`?**
The dimension is a constraint, not a label. `vector(768)` makes Postgres reject
any embedding that isn't 768-dim — the database half of the invariant the app
also checks in `assertDim` (`pg-vector-store.ts:32`). If you'd indexed with a
different-dim model by mistake, the column throws instead of silently storing a
ragged vector that the ANN distance can't compare.

```
  Q: why typed vector(768)?
  number[512] ──► vector(768) column ──► ERROR (good)
                  ←─ DB rejects width mismatch
  the load-bearing part people forget: the metric, not the column
```

**Q: What's the one thing that silently breaks ANN search?**
The index operator class and the query operator disagreeing on the distance
metric. The index is `vector_cosine_ops` (`001:28`); the query uses `<=>`
(`pg-vector-store.ts:74`). Both are cosine. Build the index with
`vector_l2_ops` but query with `<=>` and the planner won't use the index — you
get correct results from a full scan, just slow, and nothing errors. That
silent fallback is the load-bearing part people forget.

**Q: The HNSW index has no app_id predicate. Problem?**
Not at this phase — one tenant (`'laptop'`), so the global index is the whole
dataset. At multi-tenant scale you'd partial-index or composite-index per
tenant so the ANN walk doesn't traverse rows it'll filter out. Deliberate,
correct now, named for later.

---

## See also

- `02-deterministic-chunk-ids.md` — the primary key that the upsert conflicts on
- `03-soft-link-no-fk.md` — why this table holds memory chunks with no document
- `06-trajectory-tables.md` — the episodic-memory overload on this same column
- `audit.md` §3 — indexing-vs-query-patterns lens
- **study-database-systems** — how HNSW and `<=>` execute beneath the schema
