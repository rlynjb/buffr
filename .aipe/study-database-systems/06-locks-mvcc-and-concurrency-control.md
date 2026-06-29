# Locks, MVCC, and concurrency control

**Subtitle:** multi-version concurrency control / ON CONFLICT upsert / connection-pool contention — *Industry standard*

---

## Zoom out, then zoom in

When two operations touch the same row at once, something has to keep them from
corrupting each other's view. Postgres's answer is MVCC — every write makes a
new row version instead of overwriting — so readers never block writers. This
repo barely exercises concurrency (one CLI, one conversation in-process), but
the two places it *could* see contention are the `on conflict` upserts and the
unsized connection pool.

```
  Zoom out — concurrency control sits in the storage engine

  ┌─ Service ───────────────────────────────────────────────┐
  │  upsert() ON CONFLICT  ·  parallel ask() turns?          │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Pool (db.ts:4) ─────────▼───────────────────────────────┐
  │  bare pg.Pool, max 10, no sizing  ← contention point      │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ ★ MVCC + locks ★ ───────▼───────────────────────────────┐ ← THIS FILE
  │  versioned tuples (xmin/xmax) · row locks · ON CONFLICT  │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: MVCC means a row isn't a slot you overwrite — it's a *chain of
versions*, each stamped with the transaction that created (`xmin`) and deleted
(`xmax`) it, from the tuple header you met in `02`. A reader sees the version
visible to its snapshot; a writer adds a new version. The question: how does that
let buffr's reads and writes coexist, and where does the pool become the real
bottleneck before MVCC ever does?

---

## The structure pass

**Layers.** Concurrency control decomposes into:

```
  ┌─ Pool admission ─────────────────┐  who gets a connection at all
  │   max 10 (default), no timeout    │  db.ts:4
  └──────────────┬────────────────────┘
  ┌─ MVCC visibility ▼────────────────┐  what each txn sees (snapshot)
  │   xmin/xmax, no read locks         │
  └──────────────┬────────────────────┘
  ┌─ Row locks (on write) ▼───────────┐  ON CONFLICT, concurrent updates
  └────────────────────────────────────┘
```

**Axis — trace `contention` (where work waits) down the layers.** *Where does an
operation block?*

- Pool admission: blocks when all `max` connections are checked out — the
  *first* place buffr would stall under load.
- MVCC visibility: readers **never block** writers and vice versa — that's the
  whole point of multi-version.
- Row locks: a writer blocks only another writer of the *same row*.

**Seam — the pool's `max` connections (`db.ts:4`).** Above it: the application
calls `pool.connect()` / `pool.query()` freely. Below it: at most `max` (10 by
default) run concurrently; the 11th waits. The guarantee that flips is
*availability* — and because `upsert()` holds a connection for a whole
multi-insert transaction (`pg-vector-store.ts:40-65`), a long index run can
starve a concurrent `search()`. This seam, not MVCC, is buffr's real concurrency
constraint.

---

## How it works

### Move 1 — the mental model

You know how React state updates don't mutate in place — you produce a *new*
state object and the old render keeps showing the old one until the re-render
commits. MVCC is that for rows: an update doesn't overwrite the row, it writes a
new version and marks the old one dead-as-of this transaction. Readers already
holding a snapshot keep seeing the old version; new readers see the new one. No
reader ever waits for a writer.

```
  MVCC — one logical row, a chain of versions

  logical row "memory:c1:0"
    ┌─ v1 ─────────┐   ┌─ v2 ─────────┐
    │ xmin=100     │──►│ xmin=140     │   newer version
    │ xmax=140     │   │ xmax=∞ (live)│
    └──────────────┘   └──────────────┘
       a txn with snapshot < 140 sees v1
       a txn with snapshot ≥ 140 sees v2
       → reader and writer never block each other
```

### Move 2 — walk concurrency in this repo

**MVCC means the reads are lock-free.** `search()` (`pg-vector-store.ts:67`) is a
plain `select`. Under MVCC it takes no row locks — it reads the versions visible
to its snapshot. So a `search()` running while `memory.remember()` upserts a new
memory chunk doesn't block; it just sees the pre-upsert snapshot. **What this
buys buffr:** the per-turn read never waits on the per-turn write. Nothing in the
repo needs `select ... for update` (lock-on-read), and it doesn't use it.

**`ON CONFLICT` is the write-write concurrency primitive.** Both
`upsert()` (`pg-vector-store.ts:50`) and the documents insert (`runtime.ts:14`)
use `insert ... on conflict (id) do update`. Walk what it does under concurrency:

```
  ON CONFLICT (id) DO UPDATE — atomic insert-or-update

  txn tries: INSERT row id="<docId>#0"
       │
       ├─ id absent  → insert it, take the new row
       │
       └─ id present → row lock the existing tuple,
                       apply DO UPDATE SET ...,
                       new MVCC version
```

The key property: `on conflict` makes insert-or-update a **single atomic
statement** — no read-then-write race where two transactions both check "does it
exist?", both see no, both insert, one fails on the primary key. Postgres
resolves the conflict at the row level. **What breaks without it:** you'd hand-
roll `select` then `insert`/`update`, opening exactly that lost-update race. For
buffr this also makes re-indexing idempotent (the heal from `05`) and lets the
same chunk id be re-embedded without duplicating.

**The primary key is what `on conflict` keys on.** `chunks.id` is the PK
(`001_agents_schema.sql:15`), `documents.id` is the PK (`:5`). The chunk id is
aptkit's deterministic `"<docId>#<index>"`, so re-indexing the same document
produces the same ids → `on conflict` updates in place rather than duplicating.
The determinism and the `on conflict` work together.

**The real contention is the pool, not the rows.** `db.ts:4`:

```ts
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });   // no max, no timeouts
}
```

No `max`, no `idleTimeoutMillis`, no `connectionTimeoutMillis`. node-postgres
defaults `max` to 10. For the current shape — one CLI, one in-process
conversation (`session.ts` holds a single `conversationId` across turns) — you
rarely have two concurrent queries, so 10 is plenty. But trace the contention:
`upsert()` checks out a dedicated client (`pool.connect()`) and holds it for the
*entire* multi-chunk transaction. During a corpus index run, that's one
connection pinned for the whole batch.

```
  Layers-and-hops — where a query waits under load

  ┌─ Service ──────┐  many concurrent     ┌─ Pool ─────────────┐
  │ search() +     │  pool.connect()/     │ max 10 (default)   │
  │ index upsert() │  query() ──────────► │ 11th call: WAITS   │
  └────────────────┘                       │ (no timeout → ∞)   │
        ▲                                   └─────────┬──────────┘
        │  index upsert holds 1 client               ▼
        │  for the whole txn                  ┌─ Postgres ─────┐
        └──── starved if pool exhausted ───── │ MVCC: no row   │
                                              │ contention here │
                                              └────────────────┘
```

**What breaks at scale:** with no `connectionTimeoutMillis`, an exhausted pool
makes the 11th `connect()` wait *indefinitely* rather than failing fast. For a
single-user CLI you'll never hit it; the moment buffr grows a second concurrent
caller or a background indexer, pool sizing becomes the first thing to tune. →
`not yet exercised`.

### Move 2.5 — current state vs future state (pool + locking)

```
  Phase A — now                    Phase B — concurrent callers / indexer
  ─────────────────────────────    ──────────────────────────────────────
  bare Pool, max 10, no timeouts    max sized to workload + connectionTimeout
  one in-process conversation       multiple concurrent ask()/index runs
  MVCC handles all read/write mix   still MVCC — pool is what needs sizing
  ON CONFLICT covers write races    maybe SELECT … FOR UPDATE if read-modify

  what doesn't change: MVCC and ON CONFLICT already handle correctness.
  the gap is admission control (pool), not concurrency control (engine).
```

### Move 3 — the principle

MVCC's gift is that readers and writers don't block each other — concurrency
correctness in Postgres is mostly free, paid for by keeping multiple row
versions around. So the bottleneck moves *up* a layer: it's not lock contention
in the engine, it's admission control at the pool. The lesson for buffr is to
look in the right place — the unsized `pg.Pool` is the contention point long
before any row lock is, and `on conflict` already closes the one write-write race
the repo could hit. Concurrency bugs hide where work *waits*, and here that's the
pool.

---

## Primary diagram

The full concurrency picture: pool admission, MVCC visibility, row locks.

```
  buffr-laptop — concurrency control, full

  ┌─ Application ───────────────────────────────────────────────┐
  │  search() (read)      upsert()/index (write, holds 1 client) │
  └────────┬───────────────────────┬─────────────────────────────┘
           │ pool.query            │ pool.connect (dedicated)
  ┌─ Pool (db.ts:4) ───────────────▼─────────────────────────────┐
  │  max 10, no timeouts  ← FIRST contention point under load     │
  └────────┬───────────────────────┬─────────────────────────────┘
           ▼                       ▼
  ┌─ MVCC ───────────────┐  ┌─ Row locks (writes only) ──────────┐
  │ readers see snapshot │  │ ON CONFLICT (id) DO UPDATE         │
  │ never block writers  │  │ → atomic insert-or-update           │
  │ xmin/xmax per tuple  │  │ → idempotent re-index (PK keyed)    │
  └──────────────────────┘  └────────────────────────────────────┘
```

---

## Elaborate

MVCC is why Postgres `select`s don't take read locks — the cost is that old row
versions accumulate (dead tuples) and have to be reclaimed by `VACUUM`,
Postgres's background garbage collector. This repo never tunes `VACUUM`; for a
low-write single-device app, autovacuum's defaults are fine, but a high-churn
table (imagine the memory chunks rewritten constantly) would eventually need
attention. The `on conflict` clause — Postgres's "upsert," added in 9.5 — is the
SQL-standard `MERGE`'s pragmatic cousin: it resolves the unique-constraint
conflict atomically so you never hand-roll the read-check-write race. Optimistic
vs pessimistic concurrency (`for update` locks vs version-check-and-retry) isn't
exercised here because no path does read-modify-write on a contended row; if
buffr grew a counter or a balance, that's where the choice would surface.

---

## Interview defense

**Q: A `search()` and a memory `upsert()` run at the same moment on the same
table. Do they block each other?**

> No. MVCC means the `select` reads the versions visible to its snapshot and
> takes no row locks; the `upsert()` writes a new version. The reader sees the
> pre-write snapshot, the writer commits a new one, neither waits. Readers don't
> block writers in Postgres. The only place they'd contend is the connection
> pool — if `upsert()` has the last connection checked out for its whole
> transaction, `search()` waits for a *connection*, not for a *lock*.

```
  search (snapshot read) ──┐
                           ├─ no row contention (MVCC)
  upsert (new version) ────┘
  contention is at the pool (db.ts:4), not the rows
```

> Anchor: in Postgres readers and writers don't block each other — the
> bottleneck is pool admission, not locks.

**Q: Why is `on conflict (id) do update` the right write primitive here?**

> Because it makes insert-or-update a single atomic statement and keys on the
> primary key — `chunks.id`, which is aptkit's deterministic `"<docId>#<index>"`.
> Two effects: re-indexing the same document updates in place instead of
> duplicating, and there's no read-then-write race where two transactions both
> check existence and both insert. Postgres resolves the conflict at the row
> level. It's also what makes the cross-transaction gap in `indexDocumentRow`
> self-healing — re-run and the upserts are idempotent.

```
  INSERT … ON CONFLICT (id) DO UPDATE
    id absent → insert · id present → row-lock + update → new version
    → idempotent, race-free, dedup by PK
```

> Anchor: `on conflict` collapses the lost-update race into one atomic,
> idempotent statement keyed on the deterministic id.

---

## See also

- `05-transactions-isolation-and-anomalies.md` — why the dedicated connection
  matters and how `on conflict` heals the cross-transaction gap.
- `02-records-pages-and-storage-layout.md` — the `xmin`/`xmax` MVCC stamps in the
  tuple header.
- `study-performance-engineering` — pool sizing as a throughput/latency budget.
- `study-runtime-systems` — the in-process event loop that issues these queries.
