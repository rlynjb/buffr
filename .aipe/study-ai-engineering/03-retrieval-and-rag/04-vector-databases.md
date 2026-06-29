# Vector Databases

### *industry: vector database / approximate-nearest-neighbour store · type: the storage + search engine under retrieval*

## Zoom out

This is where the vectors *live* and how you find the nearest ones fast. Embeddings make the geometry; the vector store is the index that makes searching that geometry sub-linear instead of scanning every row.

**buffr's retrieval stack, the store marked**

```
┌──────────────────────────────────────────────────────────────┐
│  search_knowledge_base  ranked hits + citations                │
├──────────────────────────────────────────────────────────────┤
│  ★ VECTOR STORE ★       PgVectorStore over Postgres+pgvector   │  ◄── this file
│                         HNSW index, cosine ops                 │
├──────────────────────────────────────────────────────────────┤
│  embeddings             768-dim vectors to store + query       │
└──────────────────────────────────────────────────────────────┘
```

You used pgvector before, so the headline lands instantly: vectors in a Postgres column, an index, a `<=>` query. This file slows down on the parts you probably treated as a black box — what HNSW actually does, and one deliberate schema decision (a dropped foreign key) that's more interesting than it looks.

## Structure pass

The axis is **search cost**: exact scan on one end, approximate index on the other. The seam is the HNSW index — the structure that trades a sliver of accuracy for a massive speed win.

**Exact scan vs. approximate index**

```
   EXACT (no index)                  APPROXIMATE (HNSW)
   ───────────────                   ──────────────────
   compare query to EVERY row        navigate a graph of vectors
   O(n) — every chunk, every query   O(log n)-ish — skip most rows
   100% recall, slow at scale        ~99% recall, fast at scale
   ┌──────────────────┐              ┌──────────────────┐
   │ scan all chunks  │              │ chunks_embedding │
   │ sort by distance │   ──seam──►  │ _hnsw index      │
   └──────────────────┘              └──────────────────┘
        the seam: do you look at every vector, or jump near the answer?
```

Left of the seam: you compare the query against every stored vector. Correct, but linear — fine for buffr's tiny corpus, fatal at a million chunks. Right of the seam: HNSW builds a navigable graph so search *jumps* toward the neighbourhood of the answer and checks a tiny fraction of vectors. Consequence: buffr gets near-perfect recall at a fraction of the work — and accepts "approximate" because the rare missed neighbour is cheaper than scanning everything.

## How it works

### Move 1 — Mental model: a skip-list for geometry

You know a skip-list: layered express lanes over a sorted list, so you jump most of the way then walk the last bit. HNSW (Hierarchical Navigable Small World) is that idea in vector space. Top layers are sparse express graphs that get you to the right region in a few hops; lower layers are dense local graphs that walk you to the actual nearest neighbours.

**HNSW as layered express lanes**

```
  layer 2 (sparse)   ●─────────────────●          few long hops
                      │                 │
  layer 1 (medium)   ●────●────────●────●          medium hops
                      │    │        │    │
  layer 0 (dense)    ●─●─●─●─●─●─●─●─●─●─●          local walk
                          ▲                ▲
                    enter here       arrive near query's
                    (top)            nearest neighbours
```

Frontend bridge: it's the same instinct as a quadtree for hit-testing in a canvas — you don't test the cursor against every shape, you descend a spatial structure that prunes whole regions. HNSW prunes whole regions of the 768-dim space.

### Move 2 — Walk the mechanism

**Part A — Storage: the schema and the index**

buffr stores chunks in `agents.chunks` with the embedding as a `vector(768)` column, and builds an HNSW index on it using cosine operators.

**The schema that makes search fast**

```
  agents.chunks
  ┌────────────────────────────────────────────────────┐
  │ id              text  PK   "<docId>#<i>"             │
  │ document_id     text       SOFT LINK (no FK!)        │
  │ app_id          text       multi-tenant filter       │
  │ chunk_index     int                                  │
  │ content         text       the chunk's raw text       │
  │ embedding       vector(768) ◄── the searchable column│
  │ embedding_model text                                 │
  │ meta            jsonb                                 │
  └────────────────────────────────────────────────────┘
  index: chunks_embedding_hnsw  USING hnsw (embedding vector_cosine_ops)
  index: chunks_app_id          (app_id)
```

```sql
-- sql/001_agents_schema.sql:22, 28-30 — the column and the index
embedding vector(768) not null,
…
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_app_id on agents.chunks (app_id);
```

Two indexes, two jobs. `chunks_embedding_hnsw` makes the *nearest-neighbour* search fast. `chunks_app_id` makes the *tenant filter* (`where app_id = …`) fast. `vector_cosine_ops` tells HNSW to build its graph using cosine distance — matching the `<=>` operator the query uses. Index op-class and query op must agree, or the index silently won't be used.

**Part B — Search: cosine distance, ordered and scored**

The `search` method embeds nothing (the pipeline passes it a vector), filters by tenant, orders by cosine distance through the HNSW index, and converts distance to a similarity score.

**The search query, annotated**

```
  query vector (768)
        │
        ▼
  where app_id = $2                  ◄── tenant filter (chunks_app_id)
  order by embedding <=> $1          ◄── HNSW does the nearest-neighbour walk
  limit $3                           ◄── top-k
        │
        ▼
  1 - (embedding <=> $1) as score    ◄── distance → similarity for the caller
```

```ts
// src/pg-vector-store.ts:67-85 — search, with meta rebuilt for citations
async search(vector: number[], k: number): Promise<Hit[]> {
  this.assertDim(vector);
  const { rows } = await this.pool.query(
    `select id, content, chunk_index, document_id, meta,
            1 - (embedding <=> $1::vector) as score
       from agents.chunks
       where app_id = $2
       order by embedding <=> $1::vector
       limit $3`, [toVectorLiteral(vector), this.appId, k]);
  return rows.map((r) => ({ id: r.id, score: Number(r.score),
    meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content } }));
}
```

The subtle bit: the row stores `document_id`, `chunk_index`, `content` as *columns*, but the in-memory `Hit` needs them inside `meta` as `docId`, `chunkIndex`, `text` — because that's the shape the citation builder expects. So `search` *rebuilds* the meta shape on the way out. The store is an adapter: SQL columns in the table, the contract's meta shape at the boundary.

**Part C — The dropped foreign key (the interesting decision)**

`document_id` *looks* like it should be a foreign key to `documents.id`. It deliberately isn't.

**Why the FK is dropped**

```
  HARD FK (rejected)                 SOFT LINK (chosen)
  ─────────────────                  ──────────────────
  chunks.document_id ──FK──►         chunks.document_id  (plain text)
    documents.id                        │ points at documents.id by convention
  upsert a chunk ──► REQUIRES a       upsert a chunk ──► no documents row needed
    documents row first                  │
  breaks VectorStore drop-in            ✓ VectorStore contract upserts chunks
  parity (contract knows no docs)         with no notion of a documents row
```

```sql
-- sql/001_agents_schema.sql:15-27 — the soft link, explained in the schema
document_id text,   -- Soft link to documents.id (no FK)
…
-- Drop the FK on databases migrated before this change (idempotent).
alter table agents.chunks drop constraint if exists chunks_document_id_fkey;
```

The `VectorStore` contract (`upsert(chunks)`) knows nothing about a `documents` table — it just stores chunks. A hard FK would force every chunk to have a parent `documents` row, breaking that drop-in contract. Concretely, this is what lets buffr's **conversation memory** write chunks tagged `kind=memory` that have *no* `documents` row at all (`src/session.ts:52`). The dropped FK isn't sloppiness — it's the price of keeping the store a clean, document-agnostic adapter.

### Move 3 — The principle

**A vector database is just an index that makes angle-search sub-linear, and buffr's is Postgres earning its keep twice.** The opinion baked in: don't reach for a dedicated vector DB (Pinecone, Weaviate, Qdrant) when your data already lives in Postgres and pgvector + HNSW covers your scale. One database, one backup story, one transaction model, SQL filters for free. The dropped FK shows the deeper discipline — the store stays a narrow adapter so it can host things (memory chunks) the `documents` table never knew about.

## Primary diagram

The full store, from upsert to ranked hit.

**Postgres as buffr's vector database**

```
  UPSERT (index time)                 SEARCH (query time)
  ───────────────────                 ───────────────────
  chunk { id, vector, meta }          query vector (768)
        │ assertDim(768)                    │ assertDim(768)
        ▼ txn: begin                         ▼
  insert … on conflict (id)           where app_id = $2          (chunks_app_id)
    do update  (idempotent upsert)    order by embedding <=> $1  (HNSW walk)
        │ embedding $6::vector              limit $3
        ▼ commit / rollback                 │ 1 - distance = score
  ┌──────────────────────────────────────────────────────────┐
  │  agents.chunks · vector(768) · chunks_embedding_hnsw      │
  │  document_id = SOFT LINK (no FK) → hosts memory chunks too │
  └──────────────────────────────────────────────────────────┘
        ▲                                    │
        │                                    ▼
   transactional write              ranked hits, meta rebuilt for citations
```

After the box: one Postgres table serves both the write (transactional, idempotent upsert) and the read (HNSW-accelerated cosine search) — no second datastore, no sync problem.

## Elaborate

- **Idempotent upsert is what makes re-indexing safe.** `insert … on conflict (id) do update` means re-running `npm run index` over a doc *replaces* its chunks by id rather than duplicating them. That's the whole reason indexing is re-runnable (see `./10-incremental-indexing.md`). The chunk id `"<docId>#<i>"` is the conflict key.
- **The write is a transaction.** `upsert` wraps all chunks of a batch in `begin`/`commit`/`rollback` (`src/pg-vector-store.ts:42-64`). A doc's chunks land all-or-nothing — you never get a half-indexed document with three of five chunks stored.
- **HNSW is approximate, and that's a knob.** It can miss a true nearest neighbour occasionally. pgvector exposes `ef_search` to trade recall for speed. buffr doesn't tune it — at this corpus size, default recall is effectively perfect.
- **`app_id` is multi-tenancy on the cheap.** Every query filters `where app_id`, and there's a dedicated index for it. One table can hold many logical corpora; buffr's default tenant is `'laptop'`. Memory chunks share the table but ride the same tenant filter.
- **Why not a dedicated vector DB.** Pinecone/Weaviate/Qdrant add operational surface (another service, another backup, another auth boundary) to buy scale buffr doesn't need. Postgres+pgvector is the right altitude until your vector count or QPS outgrows a single Postgres — a problem buffr does not have.

## Project exercises

### Verify HNSW is actually being used (EXPLAIN the search)

- **Exercise ID:** [B2A.6] (cite [C2.3], Phase 2A) — Case A: the index exists; this proves the query uses it.
- **What to build:** Run `EXPLAIN (ANALYZE)` on the `search` query against a populated corpus and confirm the plan hits `chunks_embedding_hnsw` (an Index Scan), not a Seq Scan. Then drop the index and re-EXPLAIN to see the fallback.
- **Why it earns its place:** An op-class mismatch or a tiny table can make Postgres ignore the HNSW index silently. "The index exists" is not "the index is used" — you only know by reading the plan.
- **Files to touch:** read-only investigation against `src/pg-vector-store.ts`'s table; capture the two plans.
- **Done when:** You can show the EXPLAIN output proving HNSW is used with the index and a Seq Scan without it, and state the row-count threshold where the planner switches.
- **Estimated effort:** 1–2hr.

### Stress the soft-link: index a memory chunk with no documents row

- **Exercise ID:** [B2A.7] (cite [C2.3], Phase 2A) — Case A: the dropped FK exists; this exercises *why* it's there.
- **What to build:** Write a chunk directly via `PgVectorStore.upsert` with a `document_id` that has no matching `documents` row (mimicking a `kind=memory` chunk), then search and confirm it returns cleanly. Re-add a hard FK and watch the same upsert fail.
- **Why it earns its place:** The dropped FK is the file's most opinionated detail. Demonstrating that a hard FK *breaks* the memory path makes the design rationale concrete instead of asserted.
- **Files to touch:** a test/script around `src/pg-vector-store.ts`; toggle the FK in `sql/001_agents_schema.sql`.
- **Done when:** You can show the orphan-chunk upsert succeeding without an FK and failing with one, tying it back to `src/session.ts`'s memory write.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: "Why Postgres+pgvector instead of a dedicated vector DB?"**

Because buffr's data already lives in Postgres and the scale fits. HNSW gives sub-linear cosine search; `app_id` filtering and transactions come free. A dedicated vector DB adds a second service, backup, and auth boundary to buy scale buffr doesn't need.

```
  vectors in a Postgres column + HNSW
  one DB, one backup, SQL filters free
```

Anchor: *"Make Postgres earn its keep before adding a vector DB."*

**Q: "Why is there no foreign key from chunks to documents?"**

To keep the `VectorStore` contract a clean drop-in. `upsert(chunks)` knows nothing about a documents table — a hard FK would force a parent row per chunk and break that. Concretely it's what lets conversation-memory chunks exist with no documents row.

```
  hard FK ──► chunk needs a parent ──► breaks memory chunks
  soft link ──► store stays document-agnostic
```

Anchor: *"The store is an adapter, not a child of documents."*

## See also

- `./01-embeddings.md` — the cosine geometry the HNSW index accelerates.
- `./02-embedding-model-choice.md` — the `vector(768)` column is the schema-level dimension guard.
- `./10-incremental-indexing.md` — the idempotent `on conflict` upsert that makes re-indexing safe.
- `../../study-database-systems/` — indexes, query planning, EXPLAIN, and transactions under this table.
- `../../study-dsa-foundations/` — HNSW, graph search, and skip-lists as the structures under ANN.
