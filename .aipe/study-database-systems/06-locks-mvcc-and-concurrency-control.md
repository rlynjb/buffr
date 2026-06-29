# Locks, MVCC, and concurrency control

**Industry name:** multi-version concurrency control (MVCC) · row versions ·
optimistic vs pessimistic locking — *Industry standard*

---

## Zoom out — where this concept lives

MVCC is the mechanism *underneath* transactions (`05`) — it's how Postgres actually
delivers isolation and atomicity without making readers wait for writers. It lives in
the storage layer, in the tuple headers, invisible to your SQL. buffr never writes a
lock or a version check, so this file is mostly "the machinery you're relying on
without naming it" — plus the one place that machinery costs you: index churn under
upsert.

```
  where MVCC sits

  ┌─ Transaction layer (file 05) ───────────────────────────┐
  │  begin / commit / isolation level                        │
  └───────────────────────────┬─────────────────────────────┘
                              │  enforced by…
  ┌─ MVCC / concurrency layer ▼─────────────────────────────┐
  │  ★ row versions (xmin/xmax) + visibility rules ★         │
  │  ★ readers don't block writers, writers don't block readers★│
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ Storage layer ───────────▼─────────────────────────────┐
  │  dead tuples (file 02) + autovacuum reclaims them        │
  └───────────────────────────────────────────────────────────┘
```

---

## Zoom in — narrow to the concept

The question: *how does Postgres let buffr's reads and writes happen "at the same
time" correctly — and what does buffr pay for it?* The answer is MVCC: every row is
versioned, every transaction sees a consistent snapshot, and nobody waits on a lock
for ordinary reads. buffr's single-writer reality means it never hits a *conflict* —
but it still pays MVCC's *storage* cost (dead tuples) and its *index* cost (HNSW
re-insertion on every update). Name the version mechanism, walk how a snapshot is
chosen, then show where the cost lands.

---

## The structure pass

### Layers

```
  isolation guarantee     →  "see a consistent snapshot" (file 05)
    snapshot              →  the set of row versions a transaction can see
      row version         →  one tuple, tagged xmin (created by) / xmax (deleted by)
        vacuum            →  reclaims versions no snapshot can see anymore
```

### Axis: trace *"does this operation block?"* across reads and writes

```
  "does this operation wait on a lock?"  — traced across buffr

  ┌─ search (read) ─────────────────────┐
  │  reads a snapshot of committed rows  │  → NEVER blocks. no lock taken.
  └──────────────────────────────────────┘
  ┌─ upsert insert (new chunk) ─────────┐
  │  writes a new tuple                  │  → NEVER blocks a reader.
  └──────────────────────────────────────┘
  ┌─ upsert on-conflict UPDATE ─────────┐
  │  same id, two writers at once?       │  → WOULD block on the row lock —
  │                                      │     but buffr has one writer, so never.
  └──────────────────────────────────────┘

  the answer would flip only at a write-write conflict on the SAME row — a case
  buffr's single writer never reaches. that's the luck the design rides on.
```

### Seams

```
  seam 1  reader ↔ writer       MVCC's whole point: this boundary has NO lock. A
                              reader sees the last committed version; a concurrent
                              writer makes a new version beside it. No contention.
  seam 2  live ↔ dead version   every UPDATE/DELETE leaves a dead version. Vacuum is
                              the seam that reclaims it. buffr's upsert-heavy
                              workload makes this seam busy. → file 02
```

Hand off: rows are versioned, readers and writers don't block each other, conflicts
need two writers (which buffr lacks), and the cost is dead tuples plus HNSW churn.

---

## How it works

### Move 1 — the mental model

You know how React state is immutable — you don't mutate the object, you produce a
*new* object and the old one is garbage-collected once nothing references it? MVCC is
that, for table rows. An UPDATE doesn't overwrite the row; it writes a new *version*
and marks the old one dead. Readers holding an older snapshot keep seeing the old
version (like a closure holding the old state), and the dead version is
garbage-collected later by *vacuum*. Immutable data structures, on disk, with a GC.

```
  MVCC — a row as versioned tuples

  time ──►
            ┌─ tuple v1 ──────────────┐
  insert →  │ xmin=100  xmax=∞ (live) │  ← created by txn 100, never deleted
            └─────────────────────────┘
                       │ UPDATE in txn 150
            ┌─ tuple v1 ──────────────┐   ┌─ tuple v2 ──────────────┐
  update →  │ xmin=100  xmax=150 (DEAD)│   │ xmin=150  xmax=∞ (live) │
            └─────────────────────────┘   └─────────────────────────┘
              a snapshot from txn 120        a snapshot from txn 160
              still sees v1 ✓                sees v2 ✓
                          ▲ no lock between them — that's MVCC
```

### Move 2 — walk the machinery

**Row versions — xmin and xmax.** Every tuple carries two hidden transaction-id
fields in its 23-byte header (the header from file `02`): `xmin` = the transaction
that created this version, `xmax` = the transaction that deleted/superseded it (or
"infinity" if still live). That's the entire versioning mechanism — two integers per
row.

**Snapshots — what a transaction can see.** When a statement runs (under READ
COMMITTED, file `05`), Postgres takes a *snapshot*: the set of transaction-ids that
had committed at that moment. A tuple is visible if its `xmin` is in the snapshot
(committed before me) and its `xmax` is not (not yet deleted as far as I'm concerned).
**Consequence:** `search` reading the `chunks` table never waits — it just filters
tuples by visibility against its snapshot. A concurrent `upsert` writing new versions
is invisible to the in-flight read until it commits and the next statement takes a
fresh snapshot.

```
  visibility check — does this snapshot see this tuple?

  snapshot (committed txns ≤ 155):  {100, 150}
                                    xmax=155 not yet committed → ignore
       tuple              xmin   xmax    visible?
       ───────────────    ────   ────    ───────
       chunk v1           100    150     NO  (xmax 150 committed → superseded)
       chunk v2           150    ∞       YES (xmin 150 committed, not deleted)
       chunk v3 (uncommit) 156   ∞       NO  (xmin 156 not in snapshot)
```

**The single-writer luck — why buffr never sees a conflict.** Here's the verdict-first
take: buffr has *exactly one writer* (the CLI process). MVCC's conflict machinery —
row locks on UPDATE, the `could not serialize`/lost-update problems — only fires when
*two* transactions touch the *same row* concurrently. buffr never does. So the entire
pessimistic-vs-optimistic-locking question is *not exercised*:

```
  the conflict that never happens in buffr

  writer A: update chunk#5 ──┐
                             ├─► would contend on chunk#5's row lock
  writer B: update chunk#5 ──┘     (A holds it, B waits, classic pessimistic lock)

  buffr: there is no writer B. one CLI process. the contention is structural-impossible.
```

This is worth stating bluntly because it's the load-bearing assumption: buffr's
concurrency-correctness comes from *having one writer*, not from any locking or
versioning the code does. No `SELECT ... FOR UPDATE` (pessimistic), no version-column
check (optimistic) anywhere in the repo. The day a second writer appears — a sync
process, a second device writing the same `agents` schema — that structural guarantee
evaporates and you'd need to *add* one of those two strategies.

**The cost buffr DOES pay — dead tuples and HNSW churn.** Even with one writer, MVCC
isn't free. Every `on conflict do update` in `upsert` (`pg-vector-store.ts:50-54`)
creates a new tuple version and orphans the old one. Two costs stack:

```
  re-index the same chunk → MVCC cost, drawn

  heap:   [ chunk#0 v1 ✝ ][ chunk#0 v2 ]   ← dead v1 occupies the page (file 02)
                  │
  HNSW:   graph entry for v1 (now dead) ──┐  ← the OLD index entry is dead too
          graph entry for v2 (new) ───────┘  ← a NEW graph insertion: distance
                                              computations to link v2's neighbours
          ✝ both reclaimed only when autovacuum runs
```

**Consequence:** re-indexing the same corpus isn't just heap bloat (file `02`) — each
updated chunk forces a *fresh HNSW graph insertion* (file `03`'s expensive write) plus
leaves a dead graph entry. An upsert-heavy dev loop (re-run the indexer five times)
inflates both the table and the proximity graph until autovacuum catches up. The fix
isn't code — it's letting autovacuum run, or `VACUUM`-ing after bulk re-indexes.

**Autovacuum — the GC that closes the loop.** Dead tuples (heap and index) are
reclaimed by autovacuum, a background process that scans for versions no live snapshot
can see anymore and frees their space. buffr configures nothing here — it relies on
Postgres defaults. For a small single-device corpus that's fine; the dead tuples get
swept and space is reused. It only becomes a knob if write volume outpaces the default
vacuum cadence (`study-performance-engineering` owns the tuning).

### Move 3 — the principle

MVCC buys you the most valuable property in a concurrent database: *readers and writers
never block each other*. The price is that every update is a copy-and-mark-dead, so
update-heavy workloads accumulate garbage that vacuum must reclaim. And the deeper
lesson for buffr specifically: when your concurrency-correctness comes from *having one
writer* rather than from locks or versions, that correctness is a property of your
deployment, not your code — and it's the first thing to break when the deployment
grows a second writer.

---

## Primary diagram

The full MVCC picture: versions, snapshot visibility, the single-writer assumption, the
vacuum loop.

```
  MVCC in buffr — full recap

  ┌─ Concurrency layer ────────────────────────────────────────────────┐
  │                                                                    │
  │  reader (search)          writer (upsert)                          │
  │     │ takes snapshot          │ writes new tuple version           │
  │     ▼                         ▼                                     │
  │  ┌─ visibility by xmin/xmax ─────────────────────────────┐         │
  │  │ sees only committed-before-me, not-deleted versions    │         │
  │  │ NO lock between reader and writer  ←── MVCC's whole job │         │
  │  └────────────────────────────────────────────────────────┘         │
  │                                                                    │
  │  conflict path:  writer A vs writer B on same row → row lock        │
  │                  ✗ NOT REACHED — buffr has one writer               │
  │                                                                    │
  │  cost path:  every UPDATE → dead heap tuple + dead HNSW entry       │
  │              → autovacuum reclaims (defaults, untuned)              │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

MVCC is Postgres's answer to the oldest concurrency tradeoff: lock-based engines make
readers wait for writers (or vice versa); MVCC lets both proceed by keeping multiple
versions. The cost — accumulating dead versions and needing vacuum — is the deal
Postgres makes, and it's why "vacuum" is a word Postgres DBAs say constantly and MySQL
(InnoDB, which uses undo logs differently) DBAs say less. For a vector workload the
twist is that the index is *also* versioned-by-churn: HNSW doesn't update in place, so
the graph accumulates dead entries exactly like the heap.

Optimistic vs pessimistic concurrency — the two strategies buffr *doesn't* use — are
worth knowing as the menu for when a second writer arrives. Pessimistic
(`SELECT ... FOR UPDATE`) locks the row up front; optimistic (a `version int` column
checked on write) lets writes race and rejects the loser. For buffr's eventual
sync story, optimistic with a version column fits a low-contention, mostly-disjoint-writes
shape better than locking. `study-distributed-systems` (if generated) owns the
multi-writer reconciliation; this file just names that the seam exists.

---

## Interview defense

**Q: "Does buffr's vector search ever block on a write?"**

```
  reader and writer, no lock

  search (reader)  ──takes snapshot──►  sees committed versions only
  upsert (writer)  ──new tuple──────►  invisible until it commits
                          ▲ no lock between them — MVCC
```

Answer: "No. MVCC means the reader takes a snapshot and filters tuples by visibility
against it — it never waits on a lock for an ordinary read. A concurrent upsert writes
*new* tuple versions beside the old ones, and they're invisible to the in-flight read
until they commit and the next statement re-snapshots. Readers don't block writers and
writers don't block readers — that's the entire point of MVCC." Anchor: *MVCC removes
the reader-writer lock by versioning the rows.*

**Q: "What's buffr's concurrency-control strategy?"**

Answer: "Honestly — having one writer. There's no `FOR UPDATE` (pessimistic) and no
version-column check (optimistic) anywhere. The single CLI process means two
transactions never touch the same row, so the conflict machinery never fires.
Correctness comes from the deployment shape, not the code. The cost it *does* pay is
MVCC's dead tuples — every upsert update leaves a dead heap tuple and a dead HNSW
entry that autovacuum has to reclaim. The day a second writer appears, I'd reach for an
optimistic version column since the writes are mostly disjoint." Anchor: *the
load-bearing concurrency guarantee is "one writer," not a lock — and that's the first
thing to break at scale.*

---

## See also

- `05-transactions-isolation-and-anomalies.md` — MVCC is what enforces the isolation
  level; why one writer makes READ COMMITTED safe.
- `02-records-pages-and-storage-layout.md` — dead tuples on the heap page; the bloat.
- `03-btree-hash-and-secondary-indexes.md` — why every update re-inserts the HNSW entry.
- `07-wal-durability-and-recovery.md` — vacuum, checkpoints, and the WAL.
- `study-performance-engineering` — autovacuum tuning under write load.
