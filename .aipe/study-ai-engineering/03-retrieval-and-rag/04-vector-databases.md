# Vector databases — pgvector in the same Postgres

*Industry standard (with a project-specific decision). Where the 768-vectors live, and how they're searched.*

## Zoom out, then zoom in

Pull up the storage layer and ask the question that decides the whole architecture: *where do the vectors live?* buffr's answer is the opinionated one — not a separate vector service, but a `vector(768)` column in the *same* Postgres that already holds the agent's documents, conversations, and messages. One database, one connection pool, one transaction boundary.

```
  Zoom out — where the vectors live

  ┌─ Retrieval layer ──────────────────────────────────────────┐
  │  pipeline: embed → search(vector, k) → ranked chunks        │
  └───────────────────────────┬────────────────────────────────┘
                              │  store.search(vector, k)
  ┌─ Storage layer (one Postgres: schema "agents") ─────────────┐
  │  ★ pgvector — agents.chunks.embedding vector(768) ★         │ ← here
  │     HNSW index (vector_cosine_ops), app_id index            │
  │  ─────────────────────────────────────────────────────────  │
  │  agents.documents   agents.conversations   agents.messages  │
  │  (same DB, same pool, same migration)                       │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. You've used pgvector in shipped RAG, so this is familiar ground — which makes it the right place to get *precise* about the three decisions that matter: **why one Postgres instead of a dedicated vector DB**, **how HNSW cosine search actually runs**, and **why the FK from chunks to documents was deliberately dropped**. That last one looks like a mistake until you see it's the price of a clean abstraction. This file is the storage half of the RAG story; `01` is the geometry, this is the warehouse.

## Structure pass

Read the skeleton: the store sits behind one interface, scopes by one column, and indexes by one operator class.

**Layers:** the `VectorStore` interface (aptkit contract) → buffr's `PgVectorStore` (the implementation) → the `agents.chunks` table + HNSW index (the physical store).

**Axis traced — "what does each layer know about *documents*?"**

```
  one axis: who knows a "document" exists?

  ┌─ VectorStore contract ──┐  NOTHING — it upserts {id, vector, meta}.
  │  upsert / search only   │  No concept of a document. Pure vectors.
  └────────────┬────────────┘
               │ seam: the dropped FK lives exactly here
  ┌─ PgVectorStore impl ────┐  A LITTLE — it reads meta.docId and writes
  │  reads meta.docId       │  it to a SOFT column, but never requires one
  └────────────┬────────────┘
               │ seam: app boundary → SQL
  ┌─ agents.chunks table ───┐  document_id is a plain text column, no FK —
  │  document_id text (soft)│  a chunk can exist with no documents row
  └─────────────────────────┘
```

**The seam that matters:** the FK that *isn't* there, between `chunks.document_id` and `documents.id`. The `VectorStore` contract knows nothing about documents — it upserts bare vectors. A hard foreign key would force every chunk to have a documents row, breaking that contract (and the in-memory store that has no documents table at all). So the FK is deliberately dropped, keeping `PgVectorStore` a true drop-in for the in-memory implementation. Hold that: the missing constraint *is* the abstraction boundary made physical.

## How it works

### Move 1 — the mental model

You know how an index in a SQL database turns a full-table scan into a B-tree lookup — same data, but a structure that makes one query shape fast? HNSW is that for vectors. The raw operation "find the nearest point to my query" is, naively, "compare against every row" — exact k-NN, O(n). HNSW builds a navigable graph so you can *hop* toward the nearest neighbors instead of scanning all of them: approximate, but fast and good enough.

```
  the vector-store kernel — ANN over a navigable graph

   query point ●
                ╲  enter at a hub, greedily hop to closer nodes
                 ▼
   ┌─ HNSW graph (agents.chunks) ──────────────────┐
   │   ●───●        ●          you don't scan all   │
   │   │   ╲       ╱│          n points — you walk   │
   │   ●    ●────●  ●          a few dozen hops to   │
   │        ╱      ╲           the k nearest         │
   │   ●───●        ●──● ◀──── top-k returned        │
   └────────────────────────────────────────────────┘
   exact k-NN = scan all n (slow, perfect)
   HNSW ANN   = hop through graph (fast, ~perfect)
```

The kernel: a navigable graph + greedy nearest-hop traversal + a stop at k. Lose the graph and you're back to a full scan; lose the `order by <=>` and the planner won't *use* the graph; lose `app_id` scoping and you search every tenant's data.

### Move 2 — the step-by-step walkthrough

**Step 1 — the decision: pgvector in the same Postgres.** buffr already runs Postgres for documents, conversations, messages, and profiles. Adding vectors means one extension and one column type, not a second datastore to run, back up, and keep in sync. The schema sets it up in three lines:

```sql
-- sql/001_agents_schema.sql:1, 22, 28-30
create extension if not exists vector;            -- pgvector, in this same DB
...
embedding vector(768) not null,                   -- the vector column
...
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);   -- the ANN index
create index if not exists chunks_app_id on agents.chunks (app_id);
```

Compare the alternatives: a dedicated vector DB (Pinecone, Weaviate) gives better scale and managed ops but adds a network hop, a second consistency story, and a sync problem (your documents are in Postgres, your vectors are elsewhere — now they can drift). `sqlite-vec` is even more local but single-file. An in-memory store (aptkit's default) is great for tests but loses everything on restart. buffr's pick — pgvector — keeps vectors and their source documents in *one transaction boundary*, which is the property that matters when you re-index.

```
  Comparison — where vectors could live

  in-memory     sqlite-vec    pgvector (buffr)    Pinecone/Weaviate
  ┌──────────┐  ┌──────────┐  ┌──────────────┐   ┌──────────────┐
  │ Map<>     │  │ one file │  │ same Postgres│   │ separate svc  │
  │ no persist│  │ embedded │  │ as documents │   │ network hop   │
  │ test-only │  │ local    │  │ 1 txn, 1 pool│   │ best scale,   │
  │           │  │          │  │ HNSW cosine  │   │ sync problem  │
  └──────────┘  └──────────┘  └──────────────┘   └──────────────┘
  buffr: vectors + source docs in ONE DB → no drift, atomic re-index
```

**Step 2 — upsert: per-chunk, transactional, idempotent.** Writing vectors happens in a single transaction, one insert per chunk, with `on conflict do update` so re-indexing a chunk overwrites it instead of duplicating:

```ts
// src/pg-vector-store.ts:38-58 (condensed)
async upsert(chunks: Chunk[]): Promise<void> {
  for (const c of chunks) this.assertDim(c.vector);     // every vector is 768 (guard)
  const client = await this.pool.connect();
  try {
    await client.query('begin');                        // all-or-nothing
    for (const c of chunks) {
      const docId = typeof c.meta.docId === 'string' ? c.meta.docId : null;   // SOFT link
      await client.query(
        `insert into agents.chunks (id, document_id, app_id, chunk_index, content, embedding, ...)
         values ($1, $2, $3, $4, $5, $6::vector, ...)
         on conflict (id) do update set                 -- idempotent: re-index overwrites
           document_id = excluded.document_id, ..., embedding = excluded.embedding, ...`,
        [c.id, docId, this.appId, chunkIndex, content, toVectorLiteral(c.vector), ...]);
    }
    await client.query('commit');
  } catch (err) { await client.query('rollback'); throw err; }  // partial index never persists
  finally { client.release(); }
}
```

Three load-bearing details. `begin`/`commit` make a multi-chunk index atomic — a crash mid-file leaves zero chunks, not half. `$6::vector` casts the text literal `[0.1,0.2,...]` into pgvector's type. And `docId` defaults to `null` when meta has none — that's the soft link in action: a chunk *can* be parentless. The chunk `id` is `"<docId>#<index>"` (built upstream in the pipeline), so the same chunk always upserts to the same row.

```
  Pattern — idempotent per-chunk upsert

  file.md ─► chunks [doc#0][doc#1][doc#2]
                │ begin
                ▼
  for each:  insert (id="doc#i", embedding::vector)
             on conflict (id) do update ◀── re-index = overwrite, no dup
                │ commit (atomic)
                ▼
  agents.chunks rows  (crash before commit → rollback → nothing written)
```

**Step 3 — search: scoped, ranked, ANN-indexed.** The read path is one query. It scopes by `app_id`, scores by cosine similarity, and — critically — orders by the `<=>` operator so the planner uses the HNSW index:

```ts
// src/pg-vector-store.ts:67-85
async search(vector: number[], k: number): Promise<Hit[]> {
  this.assertDim(vector);                                    // query vector is 768 too
  const { rows } = await this.pool.query(
    `select id, content, chunk_index, document_id, meta,
            1 - (embedding <=> $1::vector) as score          -- cosine similarity
     from agents.chunks
     where app_id = $2                                       -- tenant scope
     order by embedding <=> $1::vector                       -- ← this hits HNSW
     limit $3`,
    [toVectorLiteral(vector), this.appId, k]);
  return rows.map((r) => ({
    id: r.id, score: Number(r.score),
    meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
  }));
}
```

The `order by embedding <=> $1::vector` is the line that matters most. Without it — say you ordered by the `score` alias instead — the planner can't recognize the HNSW-indexable expression and falls back to scanning every row and computing distance. *With* it, Postgres walks the HNSW graph. Same results conceptually; orders-of-magnitude different at scale. And `where app_id = $2` (backed by the `chunks_app_id` index) keeps one buffr install's "laptop" data from leaking into another's.

```
  Layers-and-hops — one search

  ┌─ PgVectorStore ─┐ hop 1: SQL with $1::vector  ┌─ Postgres/pgvector ──┐
  │ search(v, k)    │ ──────────────────────────► │ where app_id=$2       │
  └───────▲─────────┘ hop 4: rows (id,score,meta) │ order by emb <=> v    │
          │            ◄───────────────────────── │   └► HNSW graph walk   │
          │                                  hop 2 │ limit k               │
          │ hop 5: rebuild meta {docId,            └──────────┬───────────┘
          │        chunkIndex, text}                     hop 3│ top-k rows
          └────────── for the citation formatter ◄───────────┘
```

**Step 4 — the meta rebuild: why parity with in-memory matters.** The returned `meta` is reconstructed into the exact shape the in-memory store would return — `{docId, chunkIndex, text}` — by mapping the SQL columns back:

```ts
// src/pg-vector-store.ts:80-84
return rows.map((r) => ({
  id: r.id, score: Number(r.score),
  meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
}));
```

This is the payoff of the dropped FK and the soft link, made concrete. The `search_knowledge_base` tool that formats citations doesn't know or care whether it's talking to pgvector or an in-memory `Map`. Both return hits with `meta.docId`, `meta.chunkIndex`, `meta.text`. `PgVectorStore` is a *drop-in* — swap it for the in-memory store in a test and nothing above it changes. The FK had to go for that to be true: the in-memory store has no documents table, so requiring a documents row would break the shared contract.

### Move 3 — the principle

Put the vectors where the source data already is, unless scale forces you out. Co-locating vectors with their documents in one Postgres buys you atomic re-indexing, no sync problem, and one ops story — and the only thing you give up (best-in-class vector scale) doesn't bind at a personal-corpus scale. And when you implement a shared interface, let the interface — not your richer storage's capabilities — set the constraints: buffr dropped a "correct" foreign key precisely *because* the abstraction it implements doesn't have documents, and keeping drop-in parity was worth more than the referential-integrity guarantee.

## Primary diagram

The store, end to end, one frame:

```
  buffr vector store — pgvector in the agents schema

  ┌─ aptkit VectorStore contract ─────────────────────────────┐
  │  upsert({id, vector, meta})   search(vector, k)            │
  │  (no concept of "documents" — pure vectors)               │
  └───────────────────────────┬───────────────────────────────┘
                  PgVectorStore implements it (drop-in for in-memory)
                              │
  ┌─ Postgres "agents" schema (ONE DB) ───────────────────────┐
  │  chunks(id "doc#i", document_id text SOFT, app_id,         │
  │         embedding vector(768), content, meta)              │
  │   ├─ HNSW (vector_cosine_ops)  ← order by <=> uses this    │
  │   └─ index(app_id)             ← tenant scope               │
  │                                                            │
  │  documents(id, content)  ◄┄┄ soft link, NO FK ┄┄ chunks    │
  │  (source of truth)           (chunk can be parentless)     │
  └────────────────────────────────────────────────────────────┘
   WRITE: begin → per-chunk insert ::vector → on conflict update → commit
   READ:  where app_id → order by <=> (HNSW) → limit k → rebuild meta
```

## Elaborate

pgvector is a Postgres extension that adds a `vector` type and distance operators (`<=>` cosine, `<->` L2, `<#>` inner product). HNSW (Hierarchical Navigable Small World) is the index that makes approximate nearest-neighbor search fast — a multi-layer graph you greedily traverse, trading a little recall for a lot of speed. It's the same family of ANN structures as IVF; HNSW tends to win on recall-at-speed for moderate datasets, which is why it's the default choice here.

The "vector DB vs Postgres extension" debate is mostly about scale and operational separation. Dedicated vector DBs (Pinecone, Weaviate, Qdrant) win when you have hundreds of millions of vectors, need horizontal sharding, or want vectors decoupled from your OLTP database. For buffr — a single laptop, a personal corpus — those are non-problems, and the cost of a second datastore (sync, ops, a network hop, a second consistency model) is real. The decisive advantage of co-location is the one you feel at re-index time: the documents row and its chunks update in the same database, so they can't drift. The internals of HNSW and how `<=>` executes belong to the storage-engine guide; cross-link `.aipe/study-database-systems/`.

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so Build-item IDs are not cited. Exercises are derived directly from the codebase and the spec's concept set.

### Make the HNSW index usage observable

- **Exercise ID:** VDB-1 (Case A — store implemented; prove the index is used).
- **What to build:** an `EXPLAIN ANALYZE` harness that runs the `search` query and asserts the plan uses the `chunks_embedding_hnsw` index (Index Scan, not Seq Scan) — then deliberately rewrite the query to `order by score desc` and show the plan *falls back to a seq scan*, proving why `order by <=>` is load-bearing.
- **Why it earns its place:** "I proved the index is actually hit, and showed the one rewrite that silently breaks it" is exactly the depth interviewers probe on pgvector.
- **Files to touch:** new `scripts/explain-search.ts` wrapping the query from `src/pg-vector-store.ts:70-78`.
- **Done when:** the report shows an HNSW index scan for the real query and a seq scan for the broken ordering.
- **Estimated effort:** 1–4hr.

### Add an integrity-sweep for orphaned chunks

- **Exercise ID:** VDB-2 (Case A — manage the cost of the dropped FK).
- **What to build:** since there's no FK enforcing it, add a maintenance query/command that finds `agents.chunks` whose `document_id` has no matching `agents.documents` row (orphans the dropped FK would have prevented) and reports or prunes them.
- **Why it earns its place:** dropping the FK was the right call for parity, but it moves referential integrity to application responsibility — owning that tradeoff is the mature answer.
- **Files to touch:** new `src/cli/sweep-cmd.ts` joining `agents.chunks.document_id` against `agents.documents.id` (schema `sql/001_agents_schema.sql:4-30`).
- **Done when:** the command lists orphaned chunks and can optionally delete them, with a test fixture that creates one.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: Why pgvector in your existing Postgres instead of a dedicated vector database?**
Answer: the vectors and their source documents live in one database, one connection pool, one transaction boundary — so re-indexing is atomic and the two can never drift, which is the failure mode of putting vectors in a separate service. A dedicated vector DB wins at hundreds-of-millions scale with sharding needs; buffr is a personal corpus on a laptop, so that scale advantage doesn't bind, and the cost (a second datastore, a sync problem, a network hop) does. HNSW with `vector_cosine_ops` gives the ANN speed without leaving Postgres.

```
  pgvector co-located         vs   separate vector DB
  vectors + docs, 1 txn            vectors here, docs there → drift
  no network hop                   network hop + 2 consistency models
  HNSW cosine, app_id scope        better raw scale you don't need yet
```

**Q: Why is there no foreign key from chunks to documents — isn't that a data-integrity bug?**
Answer: it's deliberate. `PgVectorStore` implements aptkit's `VectorStore` interface, which upserts bare `{id, vector, meta}` with no concept of a document — and the in-memory store it must stay drop-in compatible with has no documents table at all. A hard FK would force every chunk to have a documents row, breaking that contract. So `document_id` is a *soft* link (plain text column), and integrity becomes an application concern. The anchor: **the load-bearing decision people miss is that the missing FK is the abstraction boundary made physical — drop-in parity beat referential integrity, on purpose.**

```
  VectorStore contract: upsert({id, vector, meta})  ← no "document" exists here
  hard FK would require a documents row → breaks in-memory parity
  → document_id is SOFT (text, no FK); chunk can be parentless
```

## See also

- `01-embeddings.md` — the 768-vector and what `<=>` measures geometrically.
- `02-embedding-model-choice.md` — the `vector(768)` column as the SQL-layer dimension guard.
- `10-incremental-indexing.md` — the atomic per-file upsert that the soft link enables.
- `11-rag.md` — the search call in the full pipeline.
- `.aipe/study-database-systems/` — HNSW internals, cosine distance, query planning at the storage engine.
