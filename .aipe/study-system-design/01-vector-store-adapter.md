# 01 — Vector Store Adapter

**Industry name(s):** Adapter pattern / Ports-and-Adapters (Hexagonal) storage binding.
**Type:** Industry standard.

## Zoom out, then zoom in

Here's the whole system. The retrieval pipeline that the agent uses to find passages
doesn't know what a database is. It knows one contract — `VectorStore` — and calls
`upsert` and `search` on whatever you hand it. buffr's job is to hand it a box backed by
Postgres pgvector.

```
  Zoom out — where the adapter lives

  ┌─ aptkit (library, never edited) ────────────────────────────────────┐
  │  createRetrievalPipeline({ embedder, store }) ── speaks VectorStore  │
  │  RagQueryAgent → search_knowledge_base tool → pipeline.query         │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ store.search(vector, k)
                                  │ store.upsert(chunks)
  ┌─ buffr adapter layer ─────────▼──────────────────────────────────────┐
  │  ★ PgVectorStore implements VectorStore ★   (src/pg-vector-store.ts) │ ← we are here
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ pg Pool · SQL
  ┌─ Storage layer ───────────────▼──────────────────────────────────────┐
  │  agents.chunks (embedding vector(768), HNSW vector_cosine_ops)        │
  └───────────────────────────────────────────────────────────────────────┘
```

Zoom in. The pattern is an **adapter**: one class implements an interface the caller
already speaks, translating the caller's vocabulary (`upsert(chunks)`,
`search(vector, k)`) into a foreign system's vocabulary (SQL over pgvector). The
question it answers: *how do you swap the in-memory toy store for a durable Postgres
store without touching a single line of the agent or pipeline?*

## Structure pass

**Layers:** caller (aptkit pipeline) → contract (`VectorStore`) → adapter
(`PgVectorStore`) → driver (`pg`) → storage (pgvector).

**Axis — who knows about Postgres?** Trace it down. The pipeline: *doesn't know.* The
`VectorStore` contract: *doesn't know* — it's pure types. `PgVectorStore`: **this is the
only layer that knows.** The `pg.Pool`: knows the wire protocol. pgvector: is Postgres.
The axis-answer flips exactly once — at the adapter. That flip is why this is a clean
seam: everything above it is database-agnostic, everything at-and-below is
Postgres-specific.

**Seam:** the `VectorStore` interface (`src/pg-vector-store.ts:2`, imported from aptkit).
It's a horizontal seam — the lower layer (PgVectorStore) promises the upper layer
(pipeline) exactly two methods with exact shapes. Get the shapes right and the agent
can't tell it's talking to Postgres instead of an array.

## How it works

### Move 1 — the mental model

You've done this exact move in React: a component takes `props` of a known shape and
doesn't care whether the parent computed them from a `fetch`, a context, or a literal.
Same idea here — the pipeline takes a `store` of a known shape (`{ dimension, upsert,
search }`) and doesn't care whether it's an array in memory or a Postgres table. The
strategy: **conform to the contract exactly, hide everything else.**

```
  the adapter shape — one class, two translated methods

   caller speaks ──►  VectorStore contract  ──► PgVectorStore translates
   ───────────────    ───────────────────       ──────────────────────
   store.upsert(cs)   upsert(StoredChunk[])      → BEGIN; INSERT…ON CONFLICT×N; COMMIT
   store.search(v,k)  search(vec,k):Hit[]        → SELECT … ORDER BY embedding <=> v LIMIT k
   store.dimension    dimension: number          → 768 (must match embedder)
```

### Move 2 — the walkthrough

**The dimension guard — what breaks without it.** Every vector that enters the store is
length-checked against `this.dimension` *before* any SQL runs
(`src/pg-vector-store.ts:32-36`). Drop this and a 1536-dim OpenAI vector would get
written into a `vector(768)` column — Postgres would reject it with a cryptic error, or
worse, a future embedder swap would silently corrupt the corpus. The guard makes the
embedding-dimension one-way door a *loud* failure.

```ts
// src/pg-vector-store.ts:32-36 — fail before the write, not during it
private assertDim(v: number[]): void {
  if (v.length !== this.dimension) {
    throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
  }
}
```

**The upsert — a transaction, not a loop of inserts.** All chunks are dim-checked first,
then a single `begin` … `commit` wraps the whole batch
(`src/pg-vector-store.ts:38-65`), with `rollback` on any error.

```ts
// src/pg-vector-store.ts:38-65 (condensed) — atomic batch with rollback
async upsert(chunks: Chunk[]): Promise<void> {
  for (const c of chunks) this.assertDim(c.vector);   // guard all, then write
  const client = await this.pool.connect();
  try {
    await client.query('begin');
    for (const c of chunks) {
      await client.query(
        `insert into agents.chunks (...) values (...$6::vector...)
         on conflict (id) do update set ...`,          // idempotent re-index
        [c.id, docId, this.appId, chunkIndex, content,
         toVectorLiteral(c.vector), this.embeddingModel, c.meta]);
    }
    await client.query('commit');
  } catch (err) { await client.query('rollback'); throw err; }
  finally { client.release(); }
}
```

What breaks without each part: drop the transaction → a mid-batch failure leaves a
half-indexed document. Drop `on conflict do update` → re-indexing the same file throws
on the primary key instead of refreshing it (re-index is a first-class operation here).
Drop `::vector` cast → pgvector can't parse the text literal `[0.1,0.2,...]` built by
`toVectorLiteral` (`src/pg-vector-store.ts:15-17`).

**The search — cosine distance, score reconstruction.** The query orders by pgvector's
`<=>` cosine-distance operator and converts distance to a similarity score with
`1 - distance` (`src/pg-vector-store.ts:67-78`).

```
  Layers-and-hops — a search call crossing the seam

  ┌─ aptkit pipeline ─┐  hop 1: search(queryVec, k)   ┌─ PgVectorStore ─┐
  │  pipeline.query   │ ─────────────────────────────► │  search()       │
  └───────────────────┘  hop 4: Hit[] (meta rebuilt) ◄ └────────┬────────┘
                                                          hop 2  │ SQL: ORDER BY
                                                                 │ embedding <=> $1
                                                                 ▼
                                                        ┌─ pgvector ──────┐
                                                        │ HNSW cosine scan│
                                                        │ hop 3: rows ────┤
                                                        └─────────────────┘
```

**The meta reconstruction — the subtle load-bearing part.** The in-memory store returned
hits with `meta.docId`, `meta.chunkIndex`, `meta.text`. The `search_knowledge_base`
tool's citation logic reads those keys. So after the SQL returns flat columns,
`PgVectorStore` *rebuilds* the in-memory meta shape (`src/pg-vector-store.ts:80-84`):

```ts
// src/pg-vector-store.ts:80-84 — rebuild the shape the tool expects
return rows.map((r) => ({
  id: r.id,
  score: Number(r.score),
  meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
}));
```

Skip this and the agent's citations break even though search "works" — the rows come
back but the tool can't find `meta.text`. This is the part of an adapter that's easy to
forget: matching the *output* shape, not just the method signature.

**The dropped FK — where the contract forced a schema decision.** `chunks.document_id`
has **no foreign key** (`sql/001_agents_schema.sql:18-27`). A hard FK would give the
store a hidden precondition: a `documents` row must exist before any chunk. But the
`VectorStore` contract upserts chunks with no notion of a documents row — and memory
chunks have no documents row at all. So the FK was dropped to preserve drop-in parity
(`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md:204`). The
contract reached down and shaped the schema. → schema-integrity analysis lives in
`study-data-modeling`.

### Move 3 — the principle

An adapter earns its keep when the thing on the other side of the contract can change
without the caller noticing. Here the capability it buys is concrete: buffr swapped an
in-memory array for durable Postgres pgvector and the agent loop, the pipeline, and the
tool did not change one line. The contract is the unit of evolution — and a faithful
adapter matches not just the method signatures but the *data shapes* flowing back
through them.

## Primary diagram

The full adapter, both methods, both directions, every layer labelled.

```
  PgVectorStore — the full adapter

  ┌─ aptkit (agnostic) ─────────────────────────────────────────────────┐
  │  RagQueryAgent → search_knowledge_base → createRetrievalPipeline      │
  └───────────────┬───────────────────────────────┬──────────────────────┘
        upsert(chunks)                       search(vector, k)
                  │                                 │
  ┌─ VectorStore contract (types only) ─────────────────────────────────┐
  │  { dimension; upsert(StoredChunk[]); search(vec,k):Hit[] }            │
  └───────────────┬───────────────────────────────┬──────────────────────┘
                  ▼                                 ▼
  ┌─ PgVectorStore (the only Postgres-aware layer) ─────────────────────┐
  │  assertDim → BEGIN/INSERT…ON CONFLICT/COMMIT     SELECT … <=> … LIMIT │
  │  toVectorLiteral([..])                            rebuild meta shape   │
  └───────────────┬───────────────────────────────┬──────────────────────┘
                  ▼ pg Pool                         ▼ pg Pool
  ┌─ Postgres agents.chunks · vector(768) · HNSW vector_cosine_ops ──────┐
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Ports-and-adapters comes from hexagonal architecture (Alistair Cockburn): the
application core defines ports (interfaces), and adapters bind them to the outside
world. aptkit is the core with the `VectorStore` port; `PgVectorStore` and the in-memory
store are two adapters on the same port. The pattern is the same shape as a
`ModelProvider` (Gemma / OpenAI / Anthropic side by side) — `me.md`'s "pattern over
vendor" made structural: *embedding + ANN + retrieval* is the pattern; pgvector is
incidental. You've shipped this exact shape before — AdvntrCue colocated pgvector with
relational data in one Postgres; this is the same colocation, now behind a clean
contract.

What to read next: `06-retrieval-as-memory.md` (the same store serving two roles),
`02-library-as-dependency-boundary.md` (why the contract lives in aptkit, not buffr).

## Interview defense

**Q: Why implement a `VectorStore` interface instead of just calling pgvector directly
from the agent?**
Because the agent and pipeline must stay database-agnostic. The in-memory store was the
first adapter; pgvector is the second; an Edge-Function-backed store is the third, later.
Each swap is zero agent change. The contract is the unit of evolution.

```
  in-memory  ─┐
  pgvector   ─┼──► same VectorStore port ──► zero agent change on swap
  edge-fn    ─┘
```
Anchor: `src/pg-vector-store.ts:19` implements the aptkit contract; the swap from
in-memory required no agent edits.

**Q: What's the load-bearing part people forget when writing an adapter like this?**
Matching the *output shape*, not just the method signature. `search` rebuilds
`meta.docId / chunkIndex / text` (`src/pg-vector-store.ts:80-84`) because the citation
tool reads those keys. Get the signature right but the meta shape wrong and search
"works" while citations silently break.

```
  signature match  ✓ ── necessary
  output-shape match ✓ ── the part people forget
       └─ meta.{docId,chunkIndex,text} rebuilt from flat columns
```
Anchor: the row→hit mapping at `src/pg-vector-store.ts:80-84`.

**Q: Why no foreign key on `chunks.document_id`?**
Deliberate. A hard FK adds a hidden precondition (documents row must exist first) that
breaks the contract — the store upserts chunks with no documents row, and memory chunks
have none at all. Soft link preserves drop-in parity.
Anchor: `sql/001_agents_schema.sql:18-27`; tradeoff documented at
`...graduation-design.md:204`.

## See also

- `02-library-as-dependency-boundary.md` — why the contract is aptkit's, not buffr's
- `06-retrieval-as-memory.md` — the second role this same store plays
- `study-database-systems` — HNSW, the `<=>` operator, transaction isolation
- `study-data-modeling` — the dropped FK, jsonb meta, chunk-id design
