# Transactions, isolation, and anomalies

**Subtitle:** ACID transactions / READ COMMITTED / cross-transaction atomicity gap — *Industry standard*

---

## Zoom out, then zoom in

A transaction is the unit of all-or-nothing. The repo draws transaction
boundaries in three places — and crucially, it draws one boundary in a spot that
leaves two related writes *outside the same boundary*. That's a real atomicity
anomaly, kept on purpose, and it's the most instructive thing in this file.

```
  Zoom out — transactions wrap the write paths

  ┌─ Service ───────────────────────────────────────────────┐
  │  indexDocumentRow()  upsert()  persistMessage()  migrate │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ ★ Transaction boundary ★▼───────────────────────────────┐ ← THIS FILE
  │  begin … commit / rollback   ·   autocommit single stmt  │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Storage (MVCC + WAL) ───▼───────────────────────────────┐
  │  versioned tuples · WAL append · READ COMMITTED          │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: a transaction promises atomicity (all writes land or none),
consistency, isolation (concurrent transactions don't corrupt each other's
view), and durability (a committed transaction survives a crash). This repo
runs every transaction at Postgres's default isolation, **READ COMMITTED**, and
never changes it. The question: where are the boundaries drawn, and where does a
related pair of writes fall on *opposite sides* of one?

---

## The structure pass

**Layers.** Three transaction shapes in the repo, by boundary discipline:

```
  ┌─ Explicit txn ───────────────────┐  begin/commit/rollback by hand
  │   upsert(), runMigration()        │  pg-vector-store.ts:42, migrate.ts:11
  └──────────────┬────────────────────┘
  ┌─ Autocommit single stmt ▼─────────┐  one pool.query = one implicit txn
  │   documents, messages, conv insert │  runtime.ts:11, trace-sink:27
  └──────────────┬────────────────────┘
  ┌─ Cross-txn sequence ▼─────────────┐  two txns, no shared boundary ⚠
  │   indexDocumentRow: A then B       │  runtime.ts:11 + :17
  └────────────────────────────────────┘
```

**Axis — trace `atomicity` (all-or-nothing scope) across the write paths.**
*What's the unit that lands or rolls back together?*

- `upsert()`: the unit is **all chunks in the batch** — `begin` … loop …
  `commit`. One fails, all roll back.
- A single autocommit insert: the unit is **that one statement**.
- `indexDocumentRow`: the documents write is one unit, the chunk writes are a
  *separate* unit. **There is no boundary around both.** Atomicity does not span
  them.

**Seam — the `await` between txn A and txn B in `indexDocumentRow`.** Above it:
the documents row is committed. Below it: the chunks commit in their own
transaction. The guarantee that flips is *atomicity* — it does not cross this
seam. A crash, an error, or a process kill in the gap leaves committed-A with
no-B. This seam is the anomaly. Keep it on the table.

---

## How it works

### Move 1 — the mental model

You've written optimistic UI updates: change local state, fire the network
request, roll back the local change if it fails. A transaction is that pattern
enforced by the database — except it rolls back *automatically and completely*
if anything inside fails, and nobody outside the transaction ever sees the
half-done state. The kernel is four moves: `begin`, do work, then either
`commit` (make it all visible and durable) or `rollback` (erase it all).

```
  The transaction kernel — what breaks if each part is missing

  begin     ─── without it: each statement autocommits, no grouping
    │
  work...   ─── the statements that must land together
    │
  commit    ─── without it: work is invisible & lost on disconnect
    or
  rollback  ─── without it: a mid-failure leaves partial writes
              (on error path)
```

### Move 2 — walk the three shapes, then the anomaly

**Shape 1 — the explicit transaction in `upsert()`.** Textbook. `pg-vector-store.ts:40-65`:

```ts
const client = await this.pool.connect();   // a dedicated connection — required
try {
  await client.query('begin');               // open the boundary
  for (const c of chunks) {
    await client.query(`insert ... on conflict (id) do update ...`, [...]);
  }
  await client.query('commit');              // all chunks land together
} catch (err) {
  await client.query('rollback');            // any failure → none land
  throw err;
} finally {
  client.release();                          // give the connection back, always
}
```

The load-bearing detail: you **must** `pool.connect()` to get one dedicated
client. `pool.query()` may hand each call a *different* pooled connection, and
`begin`/`commit` only group statements on the *same* connection. Run `begin` on
one connection and `insert` on another and you've grouped nothing. **What breaks
if you skip the dedicated client:** the transaction silently spans connections
and atomicity evaporates. `migrate.ts:9` does the same `connect()`-then-`begin`
correctly.

**Shape 2 — autocommit single statements.** A bare `pool.query` with no `begin`
is its own implicit transaction — Postgres wraps every standalone statement in
one. The `documents` insert (`runtime.ts:11`), each `messages` insert
(`supabase-trace-sink.ts:27`), the `conversations` insert
(`startConversation`): each lands atomically on its own, commits on its own.
Fine for a single independent row.

**Shape 3 — the cross-transaction anomaly in `indexDocumentRow`.** Here's the
one to study. `runtime.ts:11-17`:

```ts
await pool.query(                                    // ── txn A ──
  `insert into agents.documents (...) values (...)
   on conflict (id) do update set ...`,              // commits HERE, alone
  [doc.id, appId, doc.sourcePath ?? null, doc.text],
);
await pipeline.index({ id: doc.id, text: doc.text }); // ── txn B ──
//   └─► PgVectorStore.upsert() → its own begin/commit (separate txn)
```

Two transactions. The documents row commits in txn A. Then `pipeline.index()`
embeds the text and calls `upsert()`, which opens *its own* `begin`/`commit` —
txn B. **No boundary wraps both.** Walk the failure:

```
  indexDocumentRow — the atomicity gap

  txn A: INSERT documents ──commit──►  [documents row durable]
                                              │
                    ⚠ crash / error / kill here
                                              │
  txn B: begin → upsert chunks → commit ──►  [chunks durable]

  outcome if it dies in the gap:
    documents row exists, ZERO chunks → an un-retrievable document
```

The reverse can't happen here (A precedes B), but the asymmetry is the point:
you can land a documents row whose chunks never made it. The document is in the
corpus, contributes nothing to retrieval, and nothing flags it.

**Why it's kept — and it should be.** Fixing it would mean threading one
transaction through `pipeline.index()` — but `pipeline` is aptkit's
`RetrievalPipeline`, and `upsert()` implements aptkit's `VectorStore` contract,
which knows nothing about a `documents` row or an outer transaction. Forcing a
shared transaction would break the drop-in parity that lets buffr swap aptkit's
in-memory store for `PgVectorStore` (and is the same reason the FK is dropped —
`001_agents_schema.sql:16`). The deliberate call: **accept a small, recoverable
inconsistency (re-index fixes it, the `on conflict` upserts are idempotent) to
keep a clean storage abstraction.** That's a real engineering tradeoff, owned,
not an accident. The mitigation already in the code: both writes are
`on conflict do update` (`runtime.ts:14`, `pg-vector-store.ts:50`), so re-running
`indexDocumentRow` heals the gap with no duplicates.

**Isolation: READ COMMITTED, everywhere, by default.** No statement in the repo
sets an isolation level. READ COMMITTED means each statement sees rows committed
*before that statement began* — so within one transaction, two `select`s can see
different data if another transaction commits between them (a non-repeatable
read). Nothing in this repo is exposed to that anomaly: the explicit
transactions are write-only loops, and the reads (`search()`) are single
statements. So READ COMMITTED is sufficient — but it's *unexamined*, an
assumption nobody tested. → `not yet exercised`.

### Move 2.5 — current state vs future state (the anomaly)

```
  Phase A — now                    Phase B — if cross-write atomicity needed
  ─────────────────────────────    ──────────────────────────────────────
  documents (txn A), chunks (txn B) one txn wraps both writes
  gap heals on re-index (idempotent) no orphan window at all
  clean VectorStore abstraction      pipeline must accept an outer txn/client
  small recoverable inconsistency    breaks drop-in parity with aptkit store

  the call today: keep A. the abstraction is worth more than closing a
  gap that re-indexing already heals.
```

### Move 3 — the principle

A transaction's guarantee is exactly as wide as its `begin`/`commit`, and not
one statement wider. The moment two related writes sit in two transactions —
even back-to-back, even with an `await` between them — atomicity does not span
them, and a crash in the gap is a real possible state you have to design for.
Here the design choice is honest: accept the gap, make both writes idempotent so
re-running heals it, and keep the storage abstraction clean. Naming *which*
inconsistency you've accepted, and *why*, is the senior move — not pretending
the boundary is wider than it is.

---

## Primary diagram

Every transaction boundary in the repo, with the anomaly marked.

```
  buffr-laptop — transaction boundaries

  EXPLICIT (begin/commit on a dedicated client):
    upsert()      [begin → insert*N → commit | rollback]  pg-vector-store.ts:42
    migrate       [begin → whole schema    → commit | rollback]  migrate.ts:11

  AUTOCOMMIT (one implicit txn per statement):
    documents     [INSERT … on conflict]   runtime.ts:11
    messages      [INSERT]                  supabase-trace-sink.ts:27
    conversations [INSERT … returning]      startConversation

  CROSS-TXN (no shared boundary — the anomaly):
    indexDocumentRow:
      txn A [INSERT documents] ──commit──► ⚠gap⚠ ──► txn B [begin upsert commit]
                                  heals on re-index (both idempotent)

  ISOLATION: READ COMMITTED for all of the above (Postgres default, untuned)
```

---

## Elaborate

ACID isn't one property — it's four, and they're served by different machinery:
atomicity and durability by the WAL (`07`), isolation and consistency by MVCC
(`06`). READ COMMITTED is Postgres's default and the loosest level that still
prevents dirty reads (you never see another transaction's uncommitted writes).
The stricter levels — REPEATABLE READ (snapshot stable for the whole
transaction) and SERIALIZABLE (as if transactions ran one at a time) — cost
more and matter when a transaction reads the same data twice or makes decisions
on what it read. This repo's transactions don't do either, so the default is
right; the gap is that it was never *examined*. The cross-transaction pattern in
`indexDocumentRow` is a distributed-write-in-miniature: two independent commits
with a consistency window between them, healed by idempotent retry — the same
shape you'd see writing to two services, which is why `study-data-modeling`
treats the soft-link integrity choice and `study-system-design` treats the
broader durability boundary.

---

## Interview defense

**Q: Walk me through an atomicity bug in this codebase.**

> `indexDocumentRow` at `runtime.ts:11` writes the `documents` row in one
> autocommit transaction, then calls `pipeline.index()`, which routes to
> `PgVectorStore.upsert()` — its own `begin`/`commit`. Two transactions, no
> shared boundary. Crash in the gap and you've committed a documents row with
> zero chunks: it's in the corpus but invisible to retrieval. It's deliberate —
> wrapping both would force aptkit's `VectorStore` to know about a documents row
> and break drop-in parity — and it's mitigated: both writes are
> `on conflict do update`, so re-indexing heals it idempotently.

```
  txn A: documents commit ──► ⚠gap⚠ ──► txn B: chunks commit
  die in gap → orphan document → re-index heals (idempotent upserts)
```

> Anchor: atomicity is exactly as wide as one begin/commit — these two writes
> sit in two.

**Q: Why does `upsert()` call `pool.connect()` instead of `pool.query()`?**

> Because a transaction only groups statements on the *same* connection.
> `pool.query()` can hand each call a different pooled connection, so `begin` and
> `insert` could land on different ones and group nothing. `pool.connect()`
> (`pg-vector-store.ts:40`) checks out one dedicated client, runs
> `begin`/inserts/`commit` on it, and releases it in `finally`. Skip that and
> your transaction silently spans connections and atomicity is gone.

```
  pool.connect() → one client → begin…commit grouped correctly
  pool.query()*N → maybe N connections → begin and insert unrelated
```

> Anchor: a transaction lives on one connection — `connect()` is what pins it.

---

## See also

- `06-locks-mvcc-and-concurrency-control.md` — MVCC, the `on conflict` mechanic,
  and why the dedicated connection matters under contention.
- `07-wal-durability-and-recovery.md` — what "committed" actually guarantees on
  disk.
- `study-data-modeling` — the soft-link / dropped-FK integrity tradeoff behind
  the cross-transaction pattern.
