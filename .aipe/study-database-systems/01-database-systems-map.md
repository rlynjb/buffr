# The datastore map

**Industry name:** single-node RDBMS with a vector extension · the storage
topology / engine map — *Industry standard*

---

## Zoom out — where this concept lives

Before any mechanism: the whole storage surface in one picture. Every other file
in this guide zooms into one band of this diagram. This file *is* the map — it
names the engine, traces every query path, and draws the line where durability
ends.

```
  buffr-laptop — one engine, every path through it

  ┌─ Application layer (TypeScript) ────────────────────────────────────┐
  │                                                                      │
  │   ★ the four call sites that touch the database ★                    │
  │   ┌──────────────────┬──────────────────┬─────────────────────────┐ │
  │   │ PgVectorStore    │ indexDocumentRow │ SupabaseTraceSink /      │ │
  │   │ .upsert/.search  │                  │ persistMessage           │ │
  │   │ pg-vector-store  │ runtime.ts       │ supabase-trace-sink.ts   │ │
  │   └────────┬─────────┴────────┬─────────┴───────────┬──────────────┘ │
  └────────────┼──────────────────┼────────────────────┼────────────────┘
               │                  │                     │
  ┌─ Connection layer ────────────▼─────────────────────▼────────────────┐
  │   pg.Pool  (src/db.ts:5)  —  one pool, default config                │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ SQL over TCP (libpq protocol)
  ┌─ Postgres (reindb) ───────────▼──────────────────────────────────────┐
  │   schema agents:                                                     │
  │   documents · chunks(+vector) · conversations · messages · profiles  │
  │   parser → planner → executor → access methods → MVCC → WAL → heap   │
  └──────────────────────────────────────────────────────────────────────┘
```

There's the forest. The box that makes this repo interesting is `chunks` — it holds
the `embedding vector(768)` column and the ANN index, and it's the only table where
the *vector* extension changes how the engine behaves. Everything else is plain
relational Postgres.

---

## Zoom in — narrow to the concept

The map answers one question: *when buffr issues a read or a write, what engine
runs it, through which path, and how far does the guarantee reach?* There's exactly
one engine (Postgres), exactly one connection mechanism (the pool), and three
distinct write paths plus one read path. Name them once here; the rest of the guide
zooms into each.

---

## The structure pass

### Layers

Four nested levels, outer to inner:

```
  application code   →  decides WHAT to write and in how many transactions
      connection     →  borrows a session from the pool, hands SQL down
        execution    →  parses, plans, picks an access method, runs it
          storage    →  MVCC visibility + WAL durability + heap pages
```

### Axis: trace *"who guarantees this write survives a crash?"* down the layers

One question, held constant, and watch the answer change:

```
  "who guarantees the write survives?"  — traced downward

  ┌──────────────────────────────────────────────┐
  │ application: indexDocumentRow                 │  → NOBODY: two separate
  │                                               │     transactions, no outer atom
  └───────────────────────┬───────────────────────┘
      ┌───────────────────▼─────────────────────┐
      │ connection: pool.connect() + begin       │  → ONE transaction is atomic
      │                                          │     (upsert wraps its loop)
      └───────────────────┬─────────────────────┘
          ┌───────────────▼───────────────────┐
          │ execution: commit returns          │  → durable IF wal synced
          └───────────────┬───────────────────┘
              ┌───────────▼─────────────────┐
              │ storage: WAL fsync on commit │  → THIS is where durability lives
              └─────────────────────────────┘

  the answer flips at the top: a single transaction is atomic and durable,
  but the application stitches TWO of them together with no atom around the pair.
```

That flip at the very top is the most consequential seam in the whole repo — it's
the cross-transaction write anomaly (`05`).

### Seams

```
  seam 1  app ↔ connection     the transaction boundary. an axis flips here:
                               inside one begin/commit, atomicity holds;
                               across two pool calls, it's gone. → 05
  seam 2  connection ↔ execution  the SQL contract. the planner is free to choose
                               seq scan OR index scan — the operator/opclass
                               alignment decides which. → 03, 04
  seam 3  execution ↔ storage  the durability boundary. commit means "WAL fsynced",
                               NOT "checkpointed to the heap". → 07
```

Hand off to How it works with the skeleton named: four layers, the
crash-survival axis flipping at the top, three load-bearing seams.

---

## How it works

### Move 1 — the mental model

You already know the shape of a web request: it hits a handler, the handler talks
to a database, the database answers. The storage map is that same shape frozen and
labelled — except here there are *four* call sites in the application that talk to
the *one* database, and they don't all use the same transaction discipline. The
mental model is a fan-in: four writers, one pool, one engine.

```
  the fan-in — four call sites, one engine

   upsert ─────┐
   index ──────┤
   persistMsg ─┼──► pg.Pool ──► Postgres (reindb / agents)
   search ─────┘     (db.ts)        one planner, one MVCC, one WAL

   the trap: each writer chooses its OWN transaction scope.
   upsert wraps a transaction; indexDocumentRow does not wrap the pair.
```

### Move 2 — walk each path

**The connection layer is a single bare pool.** Everything funnels through one
object, created once with nothing but a connection string.

```ts
// src/db.ts:4-6
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
  //     ▲ no max, no idleTimeoutMillis, no connectionTimeoutMillis
  //       → pg defaults: max 10 connections, no statement timeout
}
```

This is the seam between your code and the engine. A `pool.query(...)` grabs a free
connection, runs one statement on it (autocommit — its own implicit transaction),
and returns it. A `pool.connect()` borrows a connection you hold across multiple
statements — that's how you get a *multi-statement* transaction. Which call you
reach for decides your transaction scope. Hold that distinction; it's the whole
story of file `05`.

**Write path A — the vector upsert, one explicit transaction.** `PgVectorStore.upsert`
borrows a connection and wraps the whole loop in `begin`/`commit`.

```ts
// src/pg-vector-store.ts:40-58 (condensed)
const client = await this.pool.connect();   // ← borrow, hold across statements
await client.query('begin');                //   one transaction opens
for (const c of chunks) {
  await client.query(`insert into agents.chunks ... on conflict (id) do update ...`);
}
await client.query('commit');               //   all chunks land atomically, or none
```

All chunks in one call commit together. Good. This is the *only* place in the repo
that holds a multi-statement transaction deliberately.

**Write path B — the document+chunk write, two transactions.** `indexDocumentRow`
writes the documents row on the pool directly, *then* calls the pipeline (which
calls upsert, path A).

```ts
// src/runtime.ts:11-17
await pool.query(`insert into agents.documents ... on conflict ...`); // txn #1 (autocommit)
await pipeline.index({ id: doc.id, text: doc.text });                 // txn #2 (upsert's begin/commit)
//    ▲ two separate transactions. nothing wraps the pair.
//      crash between them → orphaned document row, no chunks.
```

This is the most important thing on the map: a logical "index this document"
operation is physically two atoms. File `05` walks the anomaly in full.

**Write path C — trajectory capture, autocommit per event.** Each
`CapabilityEvent` becomes one `persistMessage` call, each its own autocommit
`pool.query`.

```ts
// src/supabase-trace-sink.ts:27-36 (the insert)
await pool.query(`insert into agents.messages (...) values (...)`);
//    ▲ one statement, one implicit transaction, per event.
//      ordering is preserved by created_at = event.timestamp, NOT by insert order.
```

The clever bit: because flush awaits a *pile of independent promises*
(`Promise.all(this.pending)`, line 92), the inserts race. Replay order is rescued
by writing `created_at` from `event.timestamp` (`supabase-trace-sink.ts:55`), so
the *data* is ordered even though the *writes* aren't. That's a real pattern: when
writes are concurrent, push ordering into a column, not into the insert sequence.

**The read path — vector search, one statement.** `search` is a single
`pool.query` ordering by cosine distance.

```ts
// src/pg-vector-store.ts:70-77
order by embedding <=> $1::vector    // ← the only query the ANN index serves
limit $3
```

One read path, and it's the one the whole RAG product depends on. Files `03` and
`04` zoom into whether the planner actually uses the index here.

### Move 3 — the principle

A storage map isn't a list of tables — it's a list of *transaction boundaries* and
*durability boundaries*. The tables tell you what data exists; the boundaries tell
you what the engine promises about it. buffr has one engine and one pool, which
makes the tables easy — but four call sites each choosing their own transaction
scope is where every consistency question in this guide originates. Map the
boundaries first; the tables are the easy part.

---

## Primary diagram

The full map: four call sites, one pool, one engine, the three seams marked.

```
  buffr storage map — call sites, pool, engine, seams

  ┌─ Application ────────────────────────────────────────────────────────┐
  │  upsert(txn)   indexDocumentRow(2 txns)   persistMessage(autocommit)  │
  │  search(read)                                                         │
  └──────┬──────────────┬────────────────────────────┬───────────────────┘
         │              │  ░ SEAM 1: transaction boundary — atom or no atom?
  ┌──────▼──────────────▼────────────────────────────▼───────────────────┐
  │  pg.Pool (db.ts) — one pool, default max 10                          │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │  ░ SEAM 2: SQL contract — seq scan vs index scan?
  ┌─ Postgres (reindb / agents) ─▼───────────────────────────────────────┐
  │  parser → planner → executor                                         │
  │  access methods:  B-tree (PKs)   |   ANN index HNSW (chunks.embedding)│
  │  MVCC: row versions + visibility                                     │
  │                                 ░ SEAM 3: durability — WAL fsync line │
  │  WAL  →  fsync on commit  →  heap pages (8 KB)                        │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Postgres is a *process-per-connection*, MVCC, heap-storage relational engine. The
`pgvector` extension (`create extension vector`, `sql/001_agents_schema.sql:1`) adds
one new column type (`vector`) and two new access methods (IVFFlat and HNSW). It
does *not* change the transaction manager, the WAL, or MVCC — a vector row is an
ordinary heap row with an ordinary index entry. That's the key insight for the rest
of this guide: pgvector is "just another index type," so everything you know about
B-tree Postgres (visibility, WAL, vacuum) applies unchanged. The novelty is purely
in *how the index is searched* (approximate, not exact) and *how the operator must
match the opclass* (file `03`).

Where this sits in the larger system: `study-system-design` owns the choice to put
vectors and relational data in *one* Postgres rather than a dedicated vector DB
(the AdvntrCue shape Rein has shipped). This guide takes that choice as given and
audits the mechanism.

---

## Interview defense

**Q: "Walk me through what happens when buffr indexes one document."**

```
  indexDocumentRow — two atoms, drawn

  ┌─ txn #1 (autocommit) ─┐        ┌─ txn #2 (upsert begin/commit) ─┐
  │ insert documents row  │  ───►  │ begin                          │
  │ commit                │  gap!  │ insert chunk, chunk, chunk     │
  └───────────────────────┘  ░░░░  │ commit                         │
                          crash here└────────────────────────────────┘
                          = document row with zero chunks
```

Answer: "Two transactions. The documents row commits on its own via a bare
`pool.query`, then `pipeline.index` runs `PgVectorStore.upsert`, which opens its own
`begin`/`commit` for the chunks. There's no atom around the pair, so a crash in the
gap orphans the document. With a hard FK that'd be a dangling reference — but the FK
is deliberately dropped, so the engine stays silent." Anchor: *the load-bearing fact
is the transaction boundary, not the table list.*

**Q: "Is pgvector a different database?"**

Answer: "No — it's an extension to the same Postgres. One new column type, two new
index access methods. Same MVCC, same WAL, same planner. A vector row is a normal
heap row; the only thing special is the index is approximate and the operator has to
match the opclass it was built with." Anchor: *pgvector is just another index type.*

---

## See also

- `02-records-pages-and-storage-layout.md` — how a chunk row sits on a heap page.
- `04-query-planning-and-execution.md` — seam 2, the scan decision.
- `05-transactions-isolation-and-anomalies.md` — seam 1, the two-transaction write.
- `07-wal-durability-and-recovery.md` — seam 3, the fsync line.
- `study-system-design` — *why* one Postgres holds both vector and relational data.
