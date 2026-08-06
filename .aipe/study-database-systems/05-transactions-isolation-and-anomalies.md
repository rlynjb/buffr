# Transactions, isolation, and anomalies

**Industry name:** ACID transactions · isolation levels · the cross-transaction
write anomaly — *Industry standard*

---

## Zoom out — where this concept lives

Transactions live at the boundary between application code and the engine — they're
the unit the application draws around a set of writes to say "all of these, or none."
This is seam 1 from the map (`01`), and it's where buffr's most consequential
consistency gap lives: a logical operation that *should* be one atom is physically
two.

```
  where transactions sit

  ┌─ Application layer ─────────────────────────────────────┐
  │  ★ the code decides the transaction BOUNDARY ★           │
  │  pool.query (autocommit)  vs  connect()+begin (explicit) │
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ Connection layer ────────▼─────────────────────────────┐
  │  a transaction = one borrowed session, begin → commit    │
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ MVCC / storage layer ────▼─────────────────────────────┐
  │  atomicity (all-or-none) + isolation (READ COMMITTED)    │
  └───────────────────────────────────────────────────────────┘
```

---

## Zoom in — narrow to the concept

The question: *what does buffr wrap in a transaction, what does it leave loose, and
what isolation level is it silently running at?* A transaction gives you two of the
ACID letters directly — **A**tomicity (all writes commit or none) and **I**solation
(concurrent transactions don't see each other's half-done work). buffr uses explicit
transactions in exactly two places and *autocommit everywhere else* — and the one
place it should have wrapped a pair, it didn't. Name the transaction boundary, walk
the two-transaction write anomaly, then pin down the unstated isolation level.

---

## The structure pass

### Layers

```
  logical operation     →  "index this document" (one intent)
    transaction(s)      →  how many atoms the code actually opens
      isolation level   →  what a concurrent reader/writer sees mid-transaction
        MVCC mechanics  →  how the engine enforces both (file 06)
```

### Axis: trace *"is this set of writes atomic?"* across the call sites

```
  "are these writes all-or-none?"  — traced across buffr's writers

  ┌─ upsert (chunks loop) ──────────────┐
  │  begin → insert×N → commit           │  → YES. one atom. all chunks or none.
  └──────────────────────────────────────┘
  ┌─ indexDocumentRow (doc + chunks) ───┐
  │  query(doc)  ; then  upsert(chunks)  │  → NO. two atoms. ★ THE ANOMALY ★
  └──────────────────────────────────────┘
  ┌─ persistMessage (one event) ────────┐
  │  query(insert)                       │  → trivially atomic (single statement)
  └──────────────────────────────────────┘
  ┌─ runMigration (one schema file) ────┐
  │  begin → run one .sql file → commit  │  → YES, PER FILE. each file is one atom.
  └──────────────────────────────────────┘
  ┌─ runAllMigrations (the CLI run) ────┐
  │  runMigration(001) ; runMigration(002) │ → NO, ACROSS FILES. two atoms, no
  └──────────────────────────────────────┘   outer transaction wraps the pair.
  ┌─ listDue (due-decision lookup) ─────┐
  │  query(update status) ; query(select) │ → NO. two atoms. ★ SECOND ANOMALY ★
  └──────────────────────────────────────┘

  the answer flips at indexDocumentRow, runAllMigrations, AND listDue: each
  splits one logical operation across two unwrapped transactions.
```

### Seams

```
  seam 1  intent ↔ transaction   the load-bearing seam. "index a document" is ONE
                                intent but TWO transactions. The atom boundary
                                doesn't match the intent boundary. → the anomaly
  seam 2  default ↔ chosen        every begin takes READ COMMITTED by default. No
                                code ever names an isolation level. The level is
                                inherited, not decided.
```

Hand off: two real transactions, autocommit elsewhere, the document+chunk intent
(and now the due-decision lookup) split across two atoms each, and an isolation
level nobody chose.

---

## How it works

### Move 1 — the mental model

You know how a `try`/`catch` around two `await`s doesn't make them atomic — if the
second throws, the first already happened and you have to manually undo it? A database
transaction is the fix for exactly that: wrap two writes in `begin`/`commit` and
either both land or neither does, with the *engine* doing the rollback. The anomaly in
buffr is the un-fixed version of that bug: two writes that *aren't* wrapped together.

```
  the cross-transaction write — the shape of the anomaly

  intent: "index this document"
  ┌────────────────────── ONE logical operation ──────────────────────┐
  │                                                                    │
  │  ┌─ txn #1 (autocommit) ─┐    GAP    ┌─ txn #2 (begin/commit) ─┐   │
  │  │ insert documents row  │ ════════► │ insert chunk × N        │   │
  │  │ COMMIT  ✓ durable     │  crash    │ COMMIT                  │   │
  │  └───────────────────────┘  here =   └─────────────────────────┘   │
  │                          orphaned doc, zero chunks                 │
  └────────────────────────────────────────────────────────────────────┘

  the atom boundary (dashed boxes) does NOT match the intent boundary (outer box)
```

### Move 2 — walk it

**The atomic case — upsert wraps its loop.** Start with what's done right, so the
contrast lands. `PgVectorStore.upsert` borrows one connection and brackets the whole
chunk loop.

```ts
// src/pg-vector-store.ts:40-64 (condensed)
const client = await this.pool.connect();
try {
  await client.query('begin');                    // ← atom opens
  for (const c of chunks) {
    await client.query(`insert into agents.chunks ... on conflict do update ...`);
  }
  await client.query('commit');                   // ← all chunks land together
} catch (err) {
  await client.query('rollback');                 // ← or none do
  throw err;
} finally {
  client.release();                               // ← always return the connection
}
```

This is textbook: one borrowed connection, `begin`/`commit`, `rollback` on the error
path, `release` in `finally` so the connection always goes back to the pool. If chunk
#7 of 10 fails, chunks #1–6 roll back too. The chunk set is one atom. Good.

**The anomaly — indexDocumentRow splits the intent.** Now the broken case. The
logical operation "index this document" is two physical writes, and they're in two
*different* transactions.

```ts
// src/runtime.ts:11-17
await pool.query(                                  // ← txn #1: autocommit on the pool.
  `insert into agents.documents (id, app_id, source_type, source_path, content)
   values ($1, $2, 'markdown', $3, $4)
   on conflict (id) do update ...`,                //   COMMITS immediately, by itself
  [doc.id, appId, doc.sourcePath ?? null, doc.text],
);
await pipeline.index({ id: doc.id, text: doc.text }); // ← txn #2: upsert's begin/commit
//    ▲ a SECOND, separate transaction. nothing wraps the pair.
```

Walk the failure, step by step:

```
  failure trace — crash in the gap

  step 1:  pool.query(insert documents)  →  documents row COMMITTED, durable
  step 2:  pipeline.index(...) starts    →  embeds the text (network call to Ollama)
           ░░░ process crashes here ░░░   →  txn #2 never opens
  result:  documents has the row, chunks has nothing for it
           the document is "indexed" per the documents table,
           but search() can never retrieve it (no chunks → no embeddings)
```

**Consequence, stated plainly:** a crash — or just an embedding-model error in
`pipeline.index` — between the two writes leaves an *orphaned document*: a row in
`documents` with no rows in `chunks`. The document looks indexed but is invisible to
retrieval. And because the chunks→documents FK is **deliberately dropped**
(`sql/001_agents_schema.sql:27`, a modeling choice owned by `study-data-modeling`),
the engine won't reject or even notice the inconsistency — there's no referential
constraint left to violate.

**Why it's structured this way — and the fix.** This isn't carelessness; it's the
cost of a clean seam. `pipeline.index` is aptkit's `RetrievalPipeline` (consumed,
never edited — a must-not-change constraint), and it owns its own transaction inside
`PgVectorStore.upsert`. buffr can't reach into it to share a connection without
breaking the abstraction. The honest fix is to invert control: open one transaction
in `indexDocumentRow`, write the documents row on *that* connection, and pass the same
connection down so the chunk upsert joins the same atom.

```
  current vs. fixed — the atom boundary

  CURRENT:  [doc txn] [chunk txn]        ← two atoms, gap between
  FIXED:    [ doc + chunks  one txn ]    ← one atom, no gap
                                            requires threading one connection
                                            through pipeline.index — an aptkit
                                            seam change, hence not done here
```

Until aptkit's pipeline accepts an injected transaction, the pragmatic mitigation is
*ordering* (index chunks first, then write the documents row last — so the visible
"document exists" flag is the *last* thing to commit) or a periodic reconciliation
sweep that deletes documents with no chunks. Neither is in the repo today.

**A second worked example — `listDue`'s unwrapped update+select.** The decision
journal (`sql/002_decision_journal.sql`) adds a fifth writer, `PgJournalStore`
(`src/pg-journal-store.ts`), and its `listDue` method repeats the same shape as
`indexDocumentRow`: one logical intent, two unwrapped statements.

```ts
// src/pg-journal-store.ts:86-98 (condensed)
await this.pool.query(                              // ← txn #1: autocommit
  `update agents.decisions set status = 'review-due'
   where app_id = $1 and user_id = $2 and workspace_id = $3
     and kind = 'decision' and status = 'open' and review_at <= $4`,
  [this.appId, userId, workspaceId, now],
);
const { rows } = await this.pool.query(              // ← txn #2: autocommit, separate
  `select * from agents.decisions
   where app_id = $1 and user_id = $2 and workspace_id = $3 and status = 'review-due'
   order by review_at asc`,
  [this.appId, userId, workspaceId],
);
```

The intent is "flip every due decision to `review-due`, then hand me the flipped
set." Read literally, that's one operation — but it's physically an `UPDATE` on one
connection borrowed from the pool, then a `SELECT` on another (or the same,
returned-and-reborrowed) connection, with no `begin`/`commit` around the pair.
Nothing stops `snooze` or `resolve` — the other two `PgJournalStore` writers — from
landing on the same row in the gap between the `UPDATE` and the `SELECT`; the
`SELECT` could then return a row whose status has already moved past
`review-due` again, or miss one that another `listDue` call (a second `/review`
session) just claimed.

```
  listDue — the gap, drawn

  UPDATE status='review-due' ──commit── ░gap░ ──► SELECT status='review-due'
                                          ▲
                          another writer's snooze()/resolve() could land here,
                          and this SELECT would read a state the caller didn't expect
```

**Why this is lower-stakes than the `indexDocumentRow` anomaly, and why it's the
same bug shape anyway.** `/review` is a single interactive CLI loop — there's no
concurrent second `/review` session in practice, so the gap is structurally
unreachable today, same as every other MVCC conflict in this repo (file `06`). But
notice the parallel is exact: a single intent ("read the due set") got split across
two autocommit statements because nobody thought to reach for `pool.connect()` +
`begin` instead of two `pool.query` calls. It's the identical mistake as write path
B, just with lower consequence because of the deployment shape, not because the
code is more careful. **Fix, if a second concurrent caller ever exists:** wrap both
statements in one transaction (`begin` → `UPDATE ... returning *` in a single
statement replaces both, which is also strictly better — one round trip instead of
two).

**The migration runner — atomic per file, not across the run.** `runMigration`
(`migrate.ts:10-22`) still wraps *one* SQL file in `begin`/`commit` — that part is
unchanged and still atomic. What changed is the CLI entry point: it used to call
`runMigration` once, directly, on `001_agents_schema.sql`. It now calls
`runAllMigrations` (`migrate.ts:25-30`), which loops `MIGRATION_FILES` and calls
`runMigration` once *per file* — `001_agents_schema.sql`, then
`002_decision_journal.sql`. Each file is its own atom; **the run as a whole is
not.** If `002` fails after `001` already committed, `001`'s tables exist,
durably, and `002`'s do not — there's no outer transaction to roll `001` back.
File `07` walks this in full, including why it's safe in practice (every
statement in both files is idempotent) even though the multi-file run isn't one
transaction.

**The isolation level nobody chose — READ COMMITTED.** Every `begin` in the repo —
`upsert` (`pg-vector-store.ts:42`), `runMigration` (`migrate.ts:13`) — takes
Postgres's default isolation level, **READ COMMITTED**, because no code ever runs
`SET TRANSACTION ISOLATION LEVEL`.

```
  the isolation ladder — buffr sits on the bottom rung, by default

  rung                what it prevents              buffr uses?
  ──────────────────  ────────────────────────────  ────────────
  READ UNCOMMITTED    (Postgres treats as RC)       —
  READ COMMITTED      dirty reads                    ✓ DEFAULT, unstated
  REPEATABLE READ     + non-repeatable / phantom     not used
  SERIALIZABLE        + write skew (full isolation)  not used
```

Under READ COMMITTED, each *statement* sees a fresh snapshot of committed data. Two
statements in the same transaction can see different data if another transaction
commits in between. **For buffr this is fine** — it's a single-device, single-writer
CLI; there's no concurrent transaction to read a moving snapshot. But "fine because
there's one writer" is a *property of the deployment*, not a *decision in the code*.
The moment a second writer appears (a sync daemon, a second device), READ COMMITTED's
non-repeatable reads and lost updates become reachable, and the code gives you no
signal because it never named the level. That's the seam-2 risk: an inherited
guarantee masquerading as a chosen one.

### Move 3 — the principle

A transaction's job is to make the *atom boundary match the intent boundary*. When
they match (upsert: one intent, one atom; runMigration: one file, one atom) you get
correctness for free. When they drift (indexDocumentRow: one intent, two atoms;
listDue: one intent, two atoms; runAllMigrations: one CLI invocation, N atoms) you get
an anomaly the engine can't catch — especially once you've dropped the constraint
that would have caught it. This is a *repeated* mistake shape in this repo, not a
one-off: three different call sites choose "two `pool.query` calls" over
"`pool.connect()` + `begin`" for what's conceptually one operation. And isolation
level is a *decision*, even when you don't make it: the default is a choice you've
delegated to Postgres, safe only as long as your concurrency assumptions hold.

---

## Primary diagram

The full transaction picture: who's atomic, who isn't, what isolation everyone runs.

```
  buffr transactions — full recap

  ┌─ Application writers ──────────────────────────────────────────────┐
  │                                                                    │
  │  upsert           [ begin → insert×N → commit ]   ATOMIC  ✓        │
  │  persistMessage   [ single insert ]               ATOMIC  ✓        │
  │  runMigration     [ begin → one file → commit ]   ATOMIC  ✓ (per file) │
  │  create/snooze/   [ single statement ]            ATOMIC  ✓        │
  │  resolve (journal)                                                 │
  │                                                                    │
  │  indexDocumentRow  [ doc txn ] ░gap░ [ chunk txn ]  NOT ATOMIC  ✗   │
  │                     crash in gap → orphaned document                │
  │                     (FK dropped → engine stays silent)              │
  │  listDue (journal)  [ update txn ] ░gap░ [ select txn ]  NOT ATOMIC ✗│
  │                     concurrent snooze/resolve could land in the gap │
  │  runAllMigrations  [ file 001 txn ] ░gap░ [ file 002 txn ]  NOT ATOMIC ✗│
  │                     failure after 001 commits leaves 002 unapplied  │
  │                     (mitigated by idempotency, not atomicity — → 07)│
  └───────────────────────────┬────────────────────────────────────────┘
                              │  every begin inherits…
  ┌─ Isolation ───────────────▼────────────────────────────────────────┐
  │  READ COMMITTED  (default, never stated)                           │
  │  safe ONLY because there is exactly one writer today               │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

ACID's four letters split across this guide: **A**tomicity and **I**solation are this
file; **C**onsistency (constraints — and here, the *dropped* constraint) leans on
`study-data-modeling`; **D**urability is file `07`. The cross-transaction anomaly is a
classic distributed-transactions-in-miniature: two writes that need to be atomic but
live behind an abstraction boundary that owns its own transaction. The general
solutions — pass a transaction handle through the boundary, use a saga with
compensation, or accept eventual consistency plus a reconciliation sweep — are exactly
the patterns you'd reach for if `documents` and `chunks` lived in two different
*services* instead of two different *transactions*. Same problem, smaller scale.
`study-distributed-systems` (if generated) owns the multi-service version; here it's a
single-process write that simply forgot to share an atom.

---

## Interview defense

**Q: "Where can buffr leave the database inconsistent, and why won't it error?"**

```
  the orphaned-document anomaly

  insert documents ──COMMIT──► ░crash░ ──► insert chunks (never runs)
       │                                          │
       ▼                                          ▼
  documents has row                         chunks has nothing
       └──────────── no FK to catch it ─────────┘
```

Answer: "`indexDocumentRow` writes the documents row in one autocommit transaction,
then indexes the chunks in a *second* transaction inside `PgVectorStore.upsert`.
There's no atom around the pair, so a crash or an embedding error in the gap leaves a
document row with zero chunks — indexed on paper, invisible to retrieval. It won't
error because the chunks→documents FK is deliberately dropped, so there's no constraint
left to violate. The fix is to thread one transaction through both writes, which means
changing aptkit's pipeline seam to accept an injected connection." Anchor: *the atom
boundary doesn't match the intent boundary, and the constraint that would catch it was
removed on purpose.*

**Q: "What isolation level does buffr run at?"**

Answer: "READ COMMITTED — the Postgres default — and nowhere in the code is that
chosen; every `begin` just inherits it. It's correct today only because there's
exactly one writer. With a second writer, non-repeatable reads and lost updates become
reachable, and the code gives no signal because the level was never named. Inherited,
not decided." Anchor: *the isolation level is a delegated decision, safe only while the
single-writer assumption holds.*

**Q: "Is `indexDocumentRow` the only place with this bug shape?"**

Answer: "No — it's the pattern, and it shows up twice more. `PgJournalStore.listDue`
runs an `UPDATE` (flip due decisions to `review-due`) and a `SELECT` (read them back)
as two separate autocommit statements, so a concurrent `snooze` or `resolve` could
land in the gap. And `runAllMigrations` runs each migration file in its own
transaction with nothing wrapping the sequence, so a failure on file two leaves file
one committed. All three are the same root cause: reaching for two `pool.query` calls
where the intent was one operation. The first is HIGH consequence (a permanently
orphaned document with no FK to catch it); the other two are lower consequence today
because buffr has one writer and every migration statement is idempotent — but
they're the identical shape." Anchor: *the same seam mistake, made three times, at
three different consequence levels.*

---

## See also

- `01-database-systems-map.md` — seam 1, the transaction boundary on the map; write
  path D (`PgJournalStore`).
- `02-records-pages-and-storage-layout.md` — the `decisions` row lifecycle, the dead
  tuple `listDue`'s status flip leaves behind.
- `06-locks-mvcc-and-concurrency-control.md` — how MVCC enforces atomicity and
  isolation, and why one writer makes the default safe.
- `07-wal-durability-and-recovery.md` — what "commit" actually durably guarantees; the
  full walk of `runAllMigrations`'s per-file-atomic, not-whole-run-atomic durability
  story, and why idempotency substitutes for atomicity there.
- `study-data-modeling` — the *deliberately dropped* chunks→documents FK (the missing
  constraint).
