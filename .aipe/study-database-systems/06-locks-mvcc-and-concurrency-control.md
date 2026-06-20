# Locks, MVCC, and Concurrency Control

**Industry name(s):** MVCC / multi-version concurrency control / row locks · **Type:** Industry standard

---

## Zoom out, then zoom in

Postgres lets readers and writers run at the same time without blocking each other, because it keeps *multiple versions* of every row. buffr never reaches for explicit locks, never sets an isolation level, and — being single-device — almost never has two transactions touching the same row at once. This file is about the concurrency machinery that's always running underneath, and how little of it buffr actually exercises.

```
  Zoom out — where concurrency control sits

  ┌─ Persistence ───────────────────────────────────────────────┐
  │  upsert ON CONFLICT · search · persistMessage                │
  └──────────────────────────┬──────────────────────────────────┘
                             │  SQL
  ┌─ Storage engine ─────────▼──────────────────────────────────┐
  │  ★ MVCC: every row has versions (xmin/xmax) ★                │ ← we are here
  │  readers see a snapshot · writers add a new version          │
  │  row locks only on conflicting writes · no FOR UPDATE in repo │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: MVCC's whole trick is that **a reader never blocks a writer and a writer never blocks a reader** — they see different versions. The verdict for buffr: this machinery is correct and free, but buffr's single-writer reality means the *interesting* parts (lock contention, serialization conflicts, retries) never fire. They're taught here against Postgres defaults, flagged `not yet exercised`.

---

## The structure pass

Two concurrency scenarios in this repo: reads-during-writes, and the upsert's `ON CONFLICT`. One axis: *does anyone block, and on what?*

```
  Axis = "who blocks whom?"  — traced across buffr's operations

  ┌─ search() reading while upsert writes ──┐  → NOBODY blocks
  │  reader sees old snapshot,              │     (MVCC: separate versions)
  │  writer makes a new version             │
  └──────────────────────────────────────────┘
  ┌─ two upserts hitting the same chunk id ─┐  → row lock on the loser
  │  ON CONFLICT → second waits for first    │     (but single-writer: never happens)
  └──────────────────────────────────────────┘
  ┌─ explicit FOR UPDATE / advisory locks ──┐  → not yet exercised
  └──────────────────────────────────────────┘
```

The seam is between "MVCC handles it invisibly" and "an actual lock is taken." In buffr almost everything stays on the left — MVCC absorbs the concurrency without a lock. A row lock only appears if two writers hit the same `id`, which a single-device CLI doesn't do. **The lesson: MVCC makes the common case lock-free; locks are the exception, and buffr rarely reaches it.**

---

## How it works

### Move 1 — the mental model

You know how React state is immutable — you don't mutate, you produce a new version and the old render still sees the old value until it re-reads? MVCC is that for rows. An `UPDATE` doesn't overwrite; it writes a *new row version* and marks the old one dead-as-of this transaction. Readers on an older snapshot keep seeing the old version.

```
  The pattern — a row is a chain of versions, readers pick by snapshot

  chunk id="doc#0"
   ┌─ version 1 ─┐   xmin=100  xmax=200   ← visible to snapshots < 200
   │ content="A" │
   └──────┬──────┘
          │ UPDATE in txn 200 creates →
   ┌─ version 2 ─┐   xmin=200  xmax=null  ← visible to snapshots ≥ 200
   │ content="B" │
   └─────────────┘
       a reader's snapshot picks the version whose xmin/xmax bracket it
```

One sentence: **every write makes a new row version stamped with its transaction id; every reader sees the version its snapshot is allowed to see — so reads and writes don't block each other.**

### Move 2 — the load-bearing skeleton

MVCC's kernel is the visibility check, and it rides the tuple header from `02`:

```
  MVCC visibility kernel (per row version)

  given a reader's snapshot (a set of "what's committed for me"):
    visible  IF  xmin is committed AND ≤ my snapshot
             AND (xmax is null OR xmax is NOT committed for me)
       │
       └─ xmin = txn that created this version
          xmax = txn that deleted/superseded it
```

**xmin/xmax — without them, no version can be placed in time.** These two ids (in the 23-byte tuple header, `02`) are the entire basis of "can I see this row." Strip them and Postgres can't tell a live version from a dead one.

**The snapshot — without it, no isolation.** When a statement starts (READ COMMITTED) it takes a snapshot: the set of transactions committed at that instant. The snapshot is what makes a read *repeatable within the statement* and *blind to uncommitted writes*.

**Dead versions accumulate — VACUUM reclaims them.** Every UPDATE/DELETE leaves a dead version. `autovacuum` (a background Postgres process, on by default) eventually removes versions no snapshot can see. buffr never configures it; on a write-light laptop DB, autovacuum keeps up silently. This is the optional-hardening layer: tuning vacuum matters only under heavy churn, which buffr doesn't have.

**Where a real lock appears — ON CONFLICT.** The one place buffr could take a row lock is `upsert`'s `INSERT … ON CONFLICT (id) DO UPDATE`. If two transactions tried to upsert the *same* `id` concurrently, the second would block on a row lock until the first commits, then proceed with the update. Bridge: it's an atomic compare-and-set on the row. But buffr is single-writer — the CLI runs one `index`/`ask` at a time — so this lock is *available* and essentially *never taken*.

```
  ON CONFLICT under concurrency (the lock buffr almost never hits)

  txn A: INSERT doc#0 ON CONFLICT … ──┐  takes row lock on doc#0
  txn B: INSERT doc#0 ON CONFLICT … ──┘  WAITS for A to commit, then UPDATEs
       │
       └─ single-device CLI = one writer = B never exists.
          The lock is correct and present; the contention is "not yet exercised."
```

### Move 2.5 — current vs future concurrency control

```
  Concurrency control — what buffr uses vs what it doesn't

  CURRENT (always on, free):
   ├─ MVCC snapshots (READ COMMITTED)  → lock-free reads during writes
   ├─ implicit row locks on write conflicts → resolve same-row writes
   └─ autovacuum → reclaim dead versions

  NOT YET EXERCISED (no code path):
   ├─ SELECT … FOR UPDATE / FOR SHARE  → pessimistic row locks
   ├─ SERIALIZABLE isolation + retry   → optimistic conflict detection
   ├─ advisory locks (pg_advisory_lock)→ app-level mutual exclusion
   └─ version-column optimistic locking → compare-and-set on UPDATE
```

The single-writer reality is *why* none of the right column is reached. Add a second concurrent writer — say a background re-indexer running while the CLI answers — and `SELECT … FOR UPDATE` or a version column becomes the tool to prevent lost updates. Today there's no lost-update risk because there's no concurrent update.

### Move 3 — the principle

MVCC trades disk (multiple versions + vacuum) for concurrency (lock-free reads). The payoff: in the common case, nobody waits. Explicit locks and serializable isolation are the tools you reach for *only* when two transactions genuinely race for the same row — and recognizing that buffr's single-writer model removes that race is the actual concurrency analysis. The skill is knowing when you've left the lock-free zone; buffr hasn't.

---

## Primary diagram

The full concurrency picture — versions, snapshots, the one lock site.

```
  buffr concurrency — MVCC default, one latent lock

  ┌─ readers (search, loadProfile) ─────────────────────────────┐
  │  take a snapshot → read the version their snapshot allows    │
  │  NEVER blocked by a concurrent writer                        │
  └──────────────────────────┬──────────────────────────────────┘
                             │  MVCC: separate versions
  ┌─ writers (upsert, persistMessage) ──────────────────────────┐
  │  write a NEW version (xmin = my txn)                         │
  │  ── only lock site ──►  ON CONFLICT(id): row lock IF two     │
  │                         writers hit same id (single-writer:  │
  │                         never)                               │
  └──────────────────────────┬──────────────────────────────────┘
                             ▼
  ┌─ autovacuum (background) ────────────────────────────────────┐
  │  reclaims dead versions no snapshot can see · untuned default │
  └──────────────────────────────────────────────────────────────┘

  FOR UPDATE · SERIALIZABLE · advisory locks · version columns: not yet exercised
```

---

## Implementation in codebase

**Use cases.** MVCC is invisible — it's always on, never invoked by name. The one place concurrency control is *almost* relevant is `upsert`'s `ON CONFLICT`, which is an atomic compare-and-set that would take a row lock under contention buffr doesn't generate.

```
  src/pg-vector-store.ts  (lines 48–54)  — the atomic compare-and-set

  insert into agents.chunks (id, …) values ($1, …, $6::vector, …)
  on conflict (id) do update set
    document_id = excluded.document_id, …, embedding = excluded.embedding, …
       │
       └─ ON CONFLICT is the only place a row lock COULD be taken: if two
          txns upserted the same id, the second waits on the first's row
          lock, then applies the UPDATE. Single-writer CLI = the second txn
          never exists, so the lock is latent, never contended.
```

```
  src/supabase-trace-sink.ts  (lines 27–39)  — concurrent INSERTs, no conflict

  emit(event) {                              ← sync; queues a write promise
    this.pending.push(persistMessage(pool, conversationId, …));
  }
  async flush() { await Promise.all(this.pending); }
       │
       └─ flush() fires multiple persistMessage INSERTs concurrently on the
          pool. They DON'T conflict: each is a fresh row (gen_random_uuid PK),
          so no two writers race for the same id → MVCC handles it lock-free.
          This is the closest buffr gets to concurrent writes, and it's
          conflict-free by construction.
```

There is no `SELECT … FOR UPDATE`, no `pg_advisory_lock`, no `set transaction isolation level`, and no version column anywhere in `src/`. Concurrency control is entirely the Postgres default.

---

## Elaborate

MVCC is why Postgres reads scale without read locks — the design choice (vs. lock-based concurrency like older SQL Server) trades storage and a vacuum process for the property that analytics-style reads never block transactional writes. The cost surfaces only under heavy update churn (bloat from dead tuples), which is a tuning problem buffr doesn't have.

The interesting concurrency question for buffr is forward-looking: the trace sink (`flush()`) already fires concurrent INSERTs, and they're safe *only because* each message gets a fresh UUID PK — no two writers contend for a row. If buffr ever added a counter row ("messages so far") that multiple writers incremented, that's a lost-update setup, and the fix is `UPDATE … SET n = n + 1` (atomic at the row) or a version column with retry. Recognizing which writes are conflict-free by construction (fresh-PK inserts) vs. which would race (shared-row updates) is the whole skill. Cross-link `study-runtime-systems` for the event-loop side of those concurrent `flush()` promises; cross-link `05` for the isolation level that governs what each snapshot sees.

---

## Interview defense

**Q: How do reads and writes coordinate here — is there locking?**

MVCC, not locks, in the common case. Every write creates a new row version stamped with its transaction id; readers see the version their snapshot allows. A reader during a concurrent write never blocks — it sees the old version. The only lock site is `ON CONFLICT` on the same id, which single-writer buffr never contends.

```
  reader → old version (snapshot)     writer → new version (xmin=me)
                  no block between them
```

Anchor: *"MVCC: writers make new versions, readers pick by snapshot — nobody blocks unless two writers hit the same row, which a single-device CLI doesn't."*

**Q: Where's the closest thing to concurrent writes, and why is it safe?**

The trace sink's `flush()` fires multiple `persistMessage` INSERTs at once. They're safe because each row gets a fresh `gen_random_uuid()` PK — no two writers race for the same id, so MVCC handles them lock-free. It'd only become a problem if they shared a row to update.

Anchor: *"Fresh-PK inserts never conflict; shared-row updates would — buffr only does the former."*

---

## Validate

1. **Reconstruct:** Draw a row's version chain with xmin/xmax and show which version two different snapshots see.
2. **Explain:** Why does `search()` never block even while `upsert()` is mid-write to the same table?
3. **Apply:** You add a `message_count` column that every `persistMessage` increments. What concurrency bug appears, and what's the one-line fix?
4. **Defend:** Argue why buffr correctly uses *no* explicit locks today, and name the exact change that would force you to add `SELECT … FOR UPDATE`.

---

## See also

- `05-transactions-isolation-and-anomalies.md` — the READ COMMITTED snapshot rules
- `02-records-pages-and-storage-layout.md` — the xmin/xmax tuple header MVCC rides on
- `07-wal-durability-and-recovery.md` — how committed versions become durable
- `study-runtime-systems` — the event loop behind concurrent flush() promises
