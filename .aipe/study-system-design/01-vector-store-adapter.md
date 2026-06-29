# 01 — Vector Store Adapter

**Industry name(s):** Ports & Adapters / Hexagonal Architecture · the Adapter pattern · dependency inversion. **Type:** Industry standard.

The standard role-vocabulary used below — *port* (the contract), *adapter* (an implementation
of it), *client* (code depending on the port), *seam* (the swap boundary), *dependency
inversion* (depending on the port, not the adapter) — is owned at the code altitude by
`study-software-design` → PATTERN VOCABULARY. This file uses those terms and binds them to
buffr's local names. The deep code-level treatment of the port lives there; here it's the
*architectural* consequence — what swapping the adapter buys the system.

## Zoom out — where this concept lives

The whole RAG side of buffr runs on one swap point. aptkit's retrieval pipeline depends on a
**port** — the `VectorStore` contract — and never on any concrete store. buffr supplies the
**adapter** (`PgVectorStore`) that fills it. That single seam is what lets the same agent run
against an in-memory array in dev and Postgres+pgvector in production with **zero agent changes**.

```
  Zoom out — the VectorStore seam in the system

  ┌─ Library layer (aptkit, never edited here) ──────────────────┐
  │  createRetrievalPipeline ─ depends on the PORT, not a store   │
  │  RagQueryAgent ─ asks the pipeline, never sees SQL            │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  the PORT: VectorStore contract
                                  │  upsert(chunks) · search(vec,k)
  ┌─ Adapter layer (buffr owns) ──▼──────────────────────────────┐
  │  ★ PgVectorStore implements VectorStore ★   ← we are here     │
  │  src/pg-vector-store.ts                                       │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  node-postgres (pg)
  ┌─ Storage layer ───────────────▼──────────────────────────────┐
  │  agents.chunks — embedding vector(768), HNSW cosine index     │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **ports & adapters**. The port is an interface aptkit owns; the adapter
is a class buffr owns that satisfies it. The question it answers: *how do you change the
database without touching the agent?* Answer — you don't depend on the database, you depend on
the contract, and the database is a detail behind it.

## Structure pass — layers, axis, seam

**Layers:** library (aptkit) → port (`VectorStore`) → adapter (`PgVectorStore`) → engine (pgvector).

**Axis — trace *dependency direction* down the stack:**

```
  axis = "which way does the dependency arrow point?"

  aptkit pipeline ──depends on──► VectorStore (port)   ◄──implements── PgVectorStore
       (high-level policy)          (abstraction)            (low-level detail)

  both sides point AT the port. neither points at the other.
  → that's dependency inversion: the detail depends on the contract,
    the policy depends on the contract, the contract depends on nothing.
```

**The seam, and why it's load-bearing:** the boundary is the `VectorStore` interface. An axis
*flips* across it — above the seam, code knows nothing about SQL or pgvector; below it,
`PgVectorStore` knows nothing about agents or retrieval ranking. Control, knowledge, and the
SQL dialect all change side at that line. That's the test for a real seam (`format.md` structure
pass): an axis-answer changes across it. Swap, mock, and test all happen here.

## How it works

### Move 1 — the mental model

You already know this shape from frontend: a `<DataProvider>` exposes a `useData()` hook and the
component never knows whether the data came from `fetch`, localStorage, or a mock. The component
codes against the *hook's contract*; the source is swappable underneath. The `VectorStore` port
is that hook's contract, one layer down in the stack.

The plain-English strategy: **define the operations as an interface, depend on the interface, and
make the database one implementation of it.**

```
  The adapter pattern — one port, many possible adapters

                 ┌──────────────────────────┐
   client  ────► │  VectorStore (the port)  │ ◄──── many adapters can fill it
   (aptkit)      │  upsert(chunks)          │
                 │  search(vector, k)       │
                 │  dimension               │
                 └──────────────────────────┘
                        ▲            ▲
        ┌───────────────┘            └───────────────┐
   InMemoryVectorStore                          PgVectorStore
   (aptkit, dev/test)                           (buffr, production)
   array + cosine loop                          pgvector + HNSW + SQL

   the client calls the SAME two methods; the adapter is swapped, not the call site
```

### Move 2 — the walkthrough

**The contract buffr promises to honor.** The port is three things: a `dimension`, an `upsert`,
and a `search`. buffr's class declares it implements the contract and nothing more
(`pg-vector-store.ts:19-30`):

```ts
// src/pg-vector-store.ts:19
export class PgVectorStore implements VectorStore {
  readonly dimension: number;                 // the port requires this
  private readonly pool: pg.Pool;             // the adapter's private detail
  // ...
  this.dimension = opts.dimension ?? 768;     // 768 = nomic-embed-text:v1.5
}
```

The `implements VectorStore` is the load-bearing word. It's a compile-time promise: if aptkit's
contract gains a method, this class fails to build until it's satisfied. The `pool` is `private`
— the port exposes none of it, so no client can reach through the adapter to the database.

**`upsert` — translate the contract's vocabulary into SQL.** The port speaks in `{id, vector,
meta}`; pgvector speaks in rows and a vector literal. The adapter is the translator
(`pg-vector-store.ts:38-65`):

```ts
// src/pg-vector-store.ts:38
async upsert(chunks: Chunk[]): Promise<void> {
  for (const c of chunks) this.assertDim(c.vector);   // guard the 768 one-way door first
  const client = await this.pool.connect();
  try {
    await client.query('begin');                      // all-or-nothing: no partial index
    for (const c of chunks) {
      const docId = typeof c.meta.docId === 'string' ? c.meta.docId : null;  // soft link, may be null
      await client.query(
        `insert into agents.chunks (...) values (...$6::vector...)
         on conflict (id) do update set ...`,          // idempotent re-index
        [c.id, docId, this.appId, ..., toVectorLiteral(c.vector), ...]);
    }
    await client.query('commit');
  } catch (err) { await client.query('rollback'); throw err; }
  finally { client.release(); }                        // always return the connection
}
```

Three boundary conditions live here. `assertDim` (line 39) makes a wrong-dimension vector a loud
throw, not a silent truncate — the storage edge guards the 768-dim one-way door. The `begin/commit/
rollback` makes a multi-chunk index atomic. The `on conflict (id) do update` makes re-indexing the
same doc idempotent — run the index twice, get one set of rows. The `docId` can be `null` because
the FK was deliberately dropped (see below).

**`search` — and the most important detail in the file.** The cosine query is straightforward;
the subtle part is line 80-84, where the adapter *reconstructs the meta shape the in-memory store
produced* (`pg-vector-store.ts:67-85`):

```ts
// src/pg-vector-store.ts:67
async search(vector: number[], k: number): Promise<Hit[]> {
  this.assertDim(vector);
  const { rows } = await this.pool.query(
    `select id, content, chunk_index, document_id, meta,
            1 - (embedding <=> $1::vector) as score    -- <=> is cosine DISTANCE; sim = 1 - dist
     from agents.chunks where app_id = $2
     order by embedding <=> $1::vector limit $3`,
    [toVectorLiteral(vector), this.appId, k]);
  return rows.map((r) => ({
    id: r.id, score: Number(r.score),
    meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
  }));                                                  // ← rebuild the in-memory meta shape
}
```

Why line 82 is load-bearing: the `search_knowledge_base` tool downstream builds citations from
`meta.docId` and `meta.text`. The in-memory store returned those keys; if `PgVectorStore` returned
raw DB columns (`document_id`, `content`) instead, **the same tool would break** when you swapped
stores. The adapter's job isn't just "run SQL" — it's "make the SQL *indistinguishable* from the
reference adapter at the contract surface." That's what makes the swap truly zero-change.

### Move 2 variant — the load-bearing skeleton

Strip the adapter to its kernel and name each part by what breaks without it:

```
  PgVectorStore kernel:
    1. implements VectorStore        — the compile-time contract bond
    2. dimension + assertDim         — the dimension one-way-door guard
    3. upsert: serialize → INSERT    — write side of the contract
    4. search: cosine → meta rebuild — read side, shaped like the reference adapter
```

- Drop **#1** and it's just a class — aptkit can't accept it where a `VectorStore` is required.
- Drop **#2** and a 1536-dim OpenAI vector silently lands in a 768 column → corrupt search forever.
- Drop **#4's meta rebuild** and citations break on swap → the "drop-in" claim is a lie.

Optional hardening *not* in the kernel: connection pooling (could be a single client), the
`on conflict` idempotency (could be delete-then-insert), the `app_id` scoping (a second tenant's
concern). The transaction in `upsert` is closer to kernel than hardening — without it a partial
index leaves orphan chunks.

### Move 3 — the principle

**Depend on contracts, not implementations, and the implementation becomes a Tuesday-afternoon
swap instead of a rewrite.** buffr proves it twice over: the design spec says `PgVectorStore`
"drops into `createRetrievalPipeline` with zero agent changes" (`...graduation-design.md:132-134`),
and the *reason* the FK was dropped (`sql/001:26-27`) was to preserve that drop-in parity — the
schema bent to keep the contract honest, not the other way around. When the schema yields to the
contract, you know the port is real.

## Primary diagram — the whole pattern in one frame

Everything Move 2 walked, on one map.

```
  Vector Store Adapter — full picture

  ┌─ aptkit (library) ────────────────────────────────────────────┐
  │  createRetrievalPipeline({ embedder, store })                  │
  │    index: store.upsert(chunks)   query: store.search(vec, k)   │
  └───────────────────────────┬───────────────────────────────────┘
                  the PORT ────┤  VectorStore { dimension, upsert, search }
                  (contract)   │
  ┌─ buffr adapter ────────────▼───────────────────────────────────┐
  │  PgVectorStore implements VectorStore   (src/pg-vector-store.ts)│
  │   upsert  → assertDim → begin → INSERT…ON CONFLICT → commit     │
  │   search  → cosine `<=>` → 1-dist score → REBUILD in-mem meta   │
  └───────────────────────────┬───────────────────────────────────┘
                  pg driver ───┤  node-postgres, direct TCP
  ┌─ Postgres `agents` ────────▼───────────────────────────────────┐
  │  chunks(embedding vector(768), HNSW vector_cosine_ops, app_id)  │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

Ports & adapters is Alistair Cockburn's hexagonal architecture; the narrower idea here is the
Gang-of-Four Adapter plus Robert Martin's Dependency Inversion Principle. The thing that makes it
*system design* and not just a code pattern: the seam is where the architecture's evolution money
is. buffr's whole deferred-body plan rides on this one port — the in-memory store was "built and
fully tested now", `PgVectorStore` was "a second adapter, deferred to the body decision"
(`aptkit-packages-design.md:202-205`). The port let the team ship a working laptop brain *before*
deciding anything about the database, then fill it in.

You've shipped this shape before: AdvntrCue colocated pgvector + relational in one Postgres, and
the lesson there (`me.md`) was that welding OpenAI into the embedding path was vendor lock-in. The
`VectorStore` + `EmbeddingProvider` port pair is the structural fix for exactly that mistake.

Read next: `02-retrieval-pipeline.md` (what flows *through* the port), `04-library-as-dependency-
boundary.md` (the aptkit boundary this port sits on). Engine internals of `<=>` and HNSW →
`study-database-systems`. The schema behind `chunks` → `study-data-modeling`.

## Interview defense

**Q: Why not just call pgvector directly from the agent?**
Because then the agent depends on Postgres, and you can't run it in a test, in dev, or against a
different store without standing up a database. The port inverts that — the agent depends on a
contract; the database is a detail you inject. The proof it's real: buffr swapped an in-memory
array for pgvector with *zero agent changes* (`...graduation-design.md:132`).

```
  with port:     agent ──► VectorStore ◄── [InMemory | Pg | Qdrant | …]   swap = inject
  without port:  agent ──► pgvector SQL                                    swap = rewrite
```
Anchor: `PgVectorStore implements VectorStore` — `src/pg-vector-store.ts:19`.

**Q: What's the part of the adapter people forget?**
The meta reconstruction in `search` (`pg-vector-store.ts:80-84`). Anyone can write the SQL. The
load-bearing part is returning `{docId, chunkIndex, text}` — the *in-memory store's shape* — so the
citation tool downstream doesn't know the store changed. An adapter that returns raw DB columns
technically implements the interface but breaks the drop-in promise.

```
  contract surface must be IDENTICAL across adapters:
    in-mem  → meta: { docId, chunkIndex, text }
    pg      → meta: { docId, chunkIndex, text }   ← rebuilt from document_id, chunk_index, content
                                                     ↑ THIS is the work, not the SELECT
```
Anchor: the `.map` rebuild — `src/pg-vector-store.ts:80-84`.

**Q: The schema dropped a foreign key for this. Defend that.**
The FK from `chunks.document_id` to `documents.id` gave the store a hidden precondition: a document
row must exist before any chunk. But the `VectorStore` contract's `upsert` takes chunks alone — it
has no concept of a documents row. A hard FK would make `PgVectorStore` reject a valid contract call
that `InMemoryVectorStore` accepts, breaking parity. So the FK is a soft link; integrity is traded
for contract fidelity, and it's documented as an as-built deviation (`sql/001:26-27`,
`...graduation-design.md:199-208`). The cost — an orphan chunk is possible — is real and accepted.

## See also

- `02-retrieval-pipeline.md` — the index/query flow that drives this port.
- `04-library-as-dependency-boundary.md` — why the port lives in aptkit, not buffr.
- `audit.md` lens 1 (boundaries), lens 5 (storage), red-flag #4 (the soft FK).
- `study-software-design` → ports & adapters / PATTERN VOCABULARY (code-altitude treatment).
- `study-database-systems` → how `<=>` and HNSW execute. `study-data-modeling` → the `chunks` schema.
