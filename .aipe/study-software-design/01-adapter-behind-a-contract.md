# Adapter behind a contract — `PgVectorStore` ⊳ `VectorStore`

> Updated: 2026-06-24 — `PgVectorStore` is unchanged, but it now backs a *second*
> consumer: aptkit's `createConversationMemory({ embedder, store })`
> (`src/session.ts:53`) writes memory chunks through the same `upsert`/`search`
> meta round-trip. The store is now built in `src/session.ts:41` (chat),
> `cli/index-cmd.ts:19`, and `cli/eval-cmd.ts:15` — the deleted `ask-cmd.ts` no
> longer builds it. Constructor now takes `appId`. The adapter's body is the same.

**Subtitle:** Adapter / Ports-and-Adapters port implementation — *Industry standard*.
The deep module of the repo: aptkit defines the `VectorStore` port; buffr writes
the pgvector adapter behind it.

---

## Zoom out, then zoom in

Here's the whole retrieval path, and the one box this file is about. aptkit owns
the *pipeline* — embed, store, search — but it doesn't know about Postgres.
buffr's job is to plug a real database in behind aptkit's `VectorStore` interface
without aptkit ever learning the word "pgvector."

```
  Zoom out — where PgVectorStore lives

  ┌─ aptkit-core (library) ──────────────────────────────────────┐
  │  RetrievalPipeline    →   needs a thing that can store +      │
  │  RagQueryAgent            search vectors. Calls it a          │
  │                           VectorStore. Doesn't care how.      │
  └───────────────────────────┬──────────────────────────────────┘
                              │  the VectorStore contract (narrow seam)
                              │  upsert(chunks) · search(vec,k) · dimension
  ┌─ buffr persistence ──────▼───────────────────────────────────┐
  │  ★ PgVectorStore ★   implements VectorStore over pgvector     │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │  SQL (begin/insert/commit · KNN order by <=>)
  ┌─ Storage ────────────────▼───────────────────────────────────┐
  │  Postgres + pgvector   agents.chunks   HNSW vector_cosine_ops │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is an *adapter*: aptkit declares a port (`VectorStore`),
buffr supplies the implementation. Two methods, `upsert` and `search`, plus a
`dimension` field. That's the entire surface aptkit sees. Everything else — the
transaction, the dimension check, the JS-array→pgvector encoding, the
distance→similarity flip, the meta round-trip — is hidden behind those two names.
This is APOSD's deep module: small interface, large body.

---

## Structure pass — layers · axis · seams

Three layers stack here: aptkit (pipeline), the `VectorStore` seam, the pgvector
adapter. The axis worth tracing is **who owns the data shape** — because that's
what flips across the seam and explains every line of the adapter.

```
  Axis traced = "who owns the shape of the data?"

  ┌─ aptkit pipeline ─┐   seam: VectorStore   ┌─ PgVectorStore ──┐
  │  owns Chunk {     │ ═════════╪═══════════► │  owns ROWS:      │
  │   id, vector,     │     (shape flips)      │  columns +       │
  │   meta }          │                        │  vector(768)     │
  └───────────────────┘                        └──────────────────┘
        ▲                                              ▲
        └──── in-memory JS objects ──── on disk, typed columns ────┘
              the adapter's whole job is translating between these
```

- **Horizontal seam (load-bearing):** `VectorStore`. Above it the data is a JS
  `Chunk` with a `number[]` vector and a free-form `meta` bag. Below it the data
  is a typed Postgres row with a `vector(768)` column and dedicated
  `document_id`/`chunk_index`/`content` columns. The *shape* of the data flips
  across this seam — that's what makes it load-bearing, and that flip is the
  adapter's entire reason to exist.
- **The contract's promise upward:** "give me chunks, I'll make them durable and
  searchable; ask me for the top-k, I'll give you scored hits." aptkit reasons
  about the pipeline without knowing Postgres exists.
- **What the seam buys you:** drop-in parity. aptkit ships an in-memory
  `VectorStore` for tests; buffr's `PgVectorStore` is a same-shaped swap. The
  pipeline code doesn't change between them.

---

## How it works

### Move 1 — the mental model

You've written a React component that takes a `props` interface and the parent
doesn't care how you render it internally — same idea here, one level down. aptkit
hands you a *contract* (`VectorStore`) the way a parent hands you props; you
implement the body however you want as long as the two method signatures hold.
The underlying strategy: **invert the dependency** — the library depends on an
interface, you depend on the same interface, and neither depends on the other's
internals.

```
  The adapter shape — two methods, one hidden body

         aptkit calls                    you implement
       ┌──────────────┐               ┌────────────────────┐
   ──► │ upsert(chunks)│ ────────────► │ validate · txn ·   │ ──► rows
       └──────────────┘               │ encode vector ·    │
       ┌──────────────┐               │ ON CONFLICT upsert │
   ──► │ search(vec,k) │ ────────────► │ KNN · score · meta │ ──► hits
       └──────────────┘               └────────────────────┘
            narrow                          deep body
         (the contract)                  (hidden from aptkit)
```

### Move 2 — the step-by-step walkthrough

**The dimension guard — the part that protects every other part.** Before any
work, both methods call `assertDim`. The project constraint is that embeddings are
768-dim and a mismatch must *throw*, never silently truncate. Drop this guard and
a 512-dim vector reaches Postgres, the `vector(768)` column rejects it with a
cryptic driver error deep inside a transaction, and you've lost the clear failure.
The guard pulls that failure up to a readable throw at the entrance.

```
  assertDim — the gate before the work

   upsert(chunks) ──► for each chunk: assertDim(vector) ──► txn
   search(vec,k)  ──► assertDim(vec) ──────────────────► query
                          │
                          └─ length != 768 ?  ─► throw "dimension mismatch"
                             (load-bearing: without it the error surfaces
                              as an opaque pg error mid-transaction)
```

**The vector encoding — translating JS to pgvector's wire format.** pgvector does
not accept a JS array. It wants a text literal: `[0.1,0.2,...]`. `toVectorLiteral`
joins the array into that string and the SQL casts it `$1::vector`. This is the
smallest, most easily-forgotten part of the adapter and it's exactly the kind of
encoding detail the contract lets you hide — aptkit never sees it.

```
  number[]  ──► toVectorLiteral ──► "[0.1,0.2,0.3]" ──► $1::vector ──► column
   (JS)            join(',')            text literal       cast        vector(768)
```

**The transactional upsert — all-or-nothing chunk writes.** `upsert` takes one
pool connection, wraps every chunk insert in a single `begin`/`commit`, and on any
throw issues `rollback` before re-raising — then always `release`s the connection
in `finally`. The boundary condition: index a 200-chunk document, fail on chunk
180, and *without* the transaction you'd have 179 orphaned chunks half-indexing
the doc. With it, the document is all-in or all-out.

```
  Transaction skeleton — what breaks if each part is removed

   connect ─► begin ─► [insert chunk]×N ─► commit ─► release
                │                            ▲          ▲
        on throw│                            │          │ finally (always)
                └──► rollback ──► re-throw ──┘   drop release → pool leak;
                     drop rollback → partial doc stays committed
```

**The search — KNN with a distance→similarity flip.** `search` runs an `order by
embedding <=> $1::vector limit k`. pgvector's `<=>` is *cosine distance* (0 =
identical, 2 = opposite), but callers want a *similarity score* where higher is
better. So the SELECT computes `1 - (embedding <=> $1)` as `score`. Forget the
inversion and your "best" match sorts last in the agent's citation list.

**The meta round-trip — keeping citations alive.** This is the subtle one.
aptkit's chunker puts `docId`, `chunkIndex`, and `text` *inside* `meta` on the way
in; buffr reads those keys to fill dedicated columns on `upsert`, then on `search`
rebuilds the same in-memory `meta` shape from those columns so aptkit's
`search_knowledge_base` tool can render citations. The adapter has to speak both
languages: columns on disk, `meta` bag in memory.

### Move 3 — the principle

The contract is what makes the module deep. Because aptkit froze the interface at
two methods, every decision below it — transactions, encoding, the score flip — is
yours to make and yours to hide. **A narrow interface you didn't design is a gift:
it's an upper bound on how much complexity you're allowed to leak.** That's why
buffr, a tiny codebase, has a genuinely deep module — it didn't have to invent the
discipline, it inherited it from the port.

---

## Primary diagram

The whole adapter in one frame.

```
  PgVectorStore — the full adapter

  ┌─ aptkit (in-memory JS) ──────────────────────────────────────┐
  │  Chunk{ id, vector:number[], meta{docId,chunkIndex,text} }    │
  └───────────────┬───────────────────────────▲──────────────────┘
       upsert      │                           │ search → Hit{id,score,meta}
  ┌────────────────▼───────────────────────────┴──────────────────┐
  │ PgVectorStore   (src/pg-vector-store.ts:19-86)                 │
  │  assertDim ──► txn{ begin → insert×N → commit/rollback } 38-65 │
  │  toVectorLiteral: number[] → "[...]"                    15-17  │
  │  search: order by <=> ; score = 1 - distance ; meta rebuild 67│
  └────────────────┬───────────────────────────▲──────────────────┘
       SQL          │                           │ rows
  ┌────────────────▼───────────────────────────┴──────────────────┐
  │ Postgres: agents.chunks  vector(768)  HNSW vector_cosine_ops   │
  └────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Reached for in three flows now: `cli/index-cmd.ts` builds a
`PgVectorStore` and hands it to `createRetrievalPipeline`, which calls `upsert`
when indexing markdown (`src/cli/index-cmd.ts:19-20`); `src/session.ts` (chat) and
`cli/eval-cmd.ts` build the same store so the pipeline's `query`/`search` runs KNN
against stored chunks (`src/session.ts:41-42`, `src/cli/eval-cmd.ts:15-16`). And
new: in the chat path the *same store instance* is also injected into aptkit's
`createConversationMemory` (`src/session.ts:53`), so conversation memory `upsert`s
and `search`es through this exact adapter — one store, two aptkit consumers
(retrieval + memory). The store is constructed once per process and the embedder's
`dimension` is threaded in so store and embedder agree.

**Code side by side.**

```
  src/pg-vector-store.ts  (upsert, lines 38-65)

  for (const c of chunks) this.assertDim(c.vector);  ← gate ALL before any write
  const client = await this.pool.connect();          ← one connection for the txn
  try {
    await client.query('begin');                     ← open the all-or-nothing window
    for (const c of chunks) {
      const docId = typeof c.meta.docId === 'string'      ← read the meta contract:
        ? c.meta.docId : null;                            these 3 keys are an
      const chunkIndex = typeof c.meta.chunkIndex         undocumented coupling with
        === 'number' ? c.meta.chunkIndex : 0;             aptkit's chunker (Lens 7)
      const content = typeof c.meta.text === 'string'
        ? c.meta.text : '';
      await client.query(`insert ... on conflict (id)     ← idempotent re-index:
        do update set ...`, [c.id, docId, this.appId,        same id overwrites,
        chunkIndex, content,                                 not duplicates
        toVectorLiteral(c.vector),                        ← JS array → "[...]"
        this.embeddingModel, c.meta]);                    ← $6::vector casts it
    }
    await client.query('commit');                      ← all chunks land together
  } catch (err) {
    await client.query('rollback');                    ← or none do
    throw err;                                          ← re-raise: caller decides
  } finally {
    client.release();                                  ← always return the conn
  }                                                       (drop this → pool leak)
```

```
  src/pg-vector-store.ts  (search, lines 67-85)

  this.assertDim(vector);                              ← same gate on the way out
  const { rows } = await this.pool.query(
    `select id, content, chunk_index, document_id, meta,
       1 - (embedding <=> $1::vector) as score          ← <=> is DISTANCE;
     from agents.chunks                                    1 - it = similarity
     where app_id = $2                                  ← tenant scoping by app
     order by embedding <=> $1::vector                  ← KNN: nearest first
     limit $3`, [toVectorLiteral(vector), this.appId, k]);
  return rows.map((r) => ({
    id: r.id, score: Number(r.score),
    meta: { ...(r.meta ?? {}), docId: r.document_id,    ← rebuild the in-memory
            chunkIndex: r.chunk_index, text: r.content },  meta shape so aptkit's
  }));                                                     citation tool works
       │
       └─ the meta rebuild IS the round-trip: columns on disk become the
          meta bag in memory. Drop it and citations lose docId/text.
```

---

## Elaborate

This is the Ports-and-Adapters (hexagonal) pattern, narrowed to one port. The
"port" is `VectorStore`; the "adapter" is `PgVectorStore`. The pattern exists to
keep a domain core (aptkit's retrieval pipeline) independent of infrastructure
(Postgres) so the infrastructure can be swapped — in-memory for tests, pgvector
for production — without touching the core. The vendor here (pgvector 0.x in one
Postgres instance) is the implementation detail the port hides; swap to Qdrant or
Weaviate and only this file changes. The adjacent concept is dependency inversion
(`04-dependency-as-a-boundary.md`): the contract is the inversion point, the
adapter is one concrete plug.

---

## Interview defense

**Q: Defend the no-foreign-key decision between `chunks.document_id` and
`documents.id`.** The `VectorStore` contract upserts chunks with no notion of a
documents row — that's aptkit's model, not buffr's. A hard FK would mean
`upsert` could only run after a `documents` insert, which breaks drop-in parity
with aptkit's in-memory store (it has no documents table at all). So the link is
*soft*: `document_id` is a column, not a constraint (`sql/001_agents_schema.sql:15-17`).
The cost: a chunk can reference a document that doesn't exist. The buy: the adapter
honors the contract exactly. Right call — and as of 2026-06-24 it pays off twice:
aptkit's `createConversationMemory` writes *memory* chunks with no documents row at
all (`src/session.ts:53`), which only works because the FK was dropped. A hard FK
would have blocked conversation memory from sharing this store.

```
  hard FK                          soft link (chosen)
  ─────────                        ──────────────────
  chunks.document_id ─FK─►docs     chunks.document_id (plain col)
  upsert REQUIRES doc row first    upsert works standalone
  breaks in-memory parity          matches the contract
```

**Q: What's the load-bearing part people forget in this adapter?** The
transaction's `finally { client.release() }`. Everyone remembers
begin/commit/rollback; the connection release is the one that, if dropped, leaks a
pool connection per failed upsert until the pool is exhausted and the next query
hangs forever. Naming that is the signal you've actually run this under load, not
just read it.

**Q: Is `PgVectorStore` too deep — does hiding the transaction hurt
testability?** No. The pool is injected (`opts.pool`), so a test substitutes a
fake pool and asserts the SQL. Depth and testability aren't in tension here
because the dependency is a constructor arg, not a hidden `new`.

---

## Validate

1. **Reconstruct:** from memory, name the two public methods of `VectorStore` and
   the four things `upsert` hides behind them. (Answer: `upsert`/`search`; hides
   the txn, `assertDim`, `toVectorLiteral`, the ON CONFLICT upsert.)
2. **Explain:** why does `search` compute `1 - (embedding <=> $1)` instead of
   sorting on `<=>` and returning it as the score? (`src/pg-vector-store.ts:72`.)
3. **Apply:** aptkit ships a new chunk meta key `pageNumber`. What breaks in
   `upsert`, and where would you add the read? (`src/pg-vector-store.ts:44-46`.)
4. **Defend:** a reviewer says "just put a foreign key on `document_id`, it's
   cleaner." Refute it using the contract. (`sql/001_agents_schema.sql:15-17`.)

---

## See also

- `audit.md` — Lens 2 (deepest module), Lens 1 (the `meta` unknown-unknown).
- `04-dependency-as-a-boundary.md` — why the contract is the inversion point.
- `03-sync-interface-async-work.md` — the sibling adapter (`SupabaseTraceSink`)
  that implements a *different* aptkit contract.
- `study-system-design` → the retrieval flow at the architecture altitude.
- `study-testing` → the injected pool is the seam that makes this testable.
