# WAL, durability, and recovery

**Subtitle:** write-ahead log / fsync durability boundary / crash recovery — *Industry standard*

---

## Zoom out, then zoom in

Durability is the D in ACID: once a transaction commits, it survives a crash.
Postgres delivers it with a write-ahead log — every change is appended to the
WAL and flushed to disk *before* the transaction reports success. This repo
doesn't configure any of it; durability is whatever Postgres's default
`fsync=on` gives. The interesting question isn't "how is the WAL tuned" (it
isn't) — it's "what does `commit` actually promise, and where does the repo's
two-transaction write leave a recovery gap."

```
  Zoom out — the WAL underpins every commit

  ┌─ Service ───────────────────────────────────────────────┐
  │  upsert() commit · documents commit · messages commit    │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Transaction layer ──────▼───────────────────────────────┐
  │  begin/commit (05)                                        │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ ★ WAL + durability ★ ───▼───────────────────────────────┐ ← THIS FILE
  │  append change → fsync → ack commit · crash → replay WAL │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the WAL is an append-only log of *intentions*. Before Postgres modifies
a data page in the buffer cache, it writes a record describing the change to the
WAL and flushes that. So even if the modified data page never made it to disk
before a crash, the WAL has the record, and recovery replays it. The question:
what's the exact durability boundary for each write in this repo, and what does a
crash mid-`indexDocumentRow` leave behind?

---

## The structure pass

**Layers.** Durability decomposes into:

```
  ┌─ Commit ack ─────────────────────┐  client hears "committed"
  └──────────────┬────────────────────┘
  ┌─ WAL fsync ──▼────────────────────┐  the durability boundary
  │   record flushed to disk           │  ← "committed" means past here
  └──────────────┬────────────────────┘
  ┌─ Data page write (later) ▼────────┐  buffer cache → disk, lazily
  │   checkpoint flushes dirty pages   │
  └────────────────────────────────────┘
```

**Axis — trace `durability` (will it survive a crash?) down the layers.** *At
what point is this write safe?*

- Commit ack: the client *believes* it's durable.
- WAL fsync: it *is* durable — the change is on disk in the log. **This is the
  boundary.**
- Data page write: the data file catches up later; irrelevant to durability
  because the WAL already has the change.

**Seam — the fsync at commit.** Above it: the change lives only in RAM (buffer
cache + WAL buffers) — a crash loses it. Below it: the WAL record is on disk — a
crash *replays* it. The guarantee that flips is *survives a crash*, and it flips
exactly at the `commit`'s fsync. Every `commit` in the repo crosses this seam;
the cross-transaction write in `indexDocumentRow` crosses it *twice*, separately
— which is the recovery gap.

---

## How it works

### Move 1 — the mental model

You've built optimistic UI with a pending queue: you record the intended change
in a durable local log *before* you apply it to the screen, so if the render
crashes you can replay the queue and rebuild the UI. The WAL is exactly that
discipline inside the database — write the intent to a durable log first, apply
it to the data pages whenever, and on crash replay the log to reconstruct any
applied-but-not-yet-flushed changes.

```
  WAL — log the intent before the change (the kernel)

  1. modify request ─► write WAL record (the intent)
                            │
  2.                    fsync WAL to disk  ◄── commit waits HERE
                            │
  3.                    ack "committed"  (now durable)
                            │
  4.  (lazily)  apply change to data page in cache → disk at checkpoint

  crash after step 2 → recovery replays WAL record → change restored
  crash before step 2 → change never happened (correct: not acked)
```

The load-bearing part is the ordering: **WAL first, data page second.** Drop
that and a crash between the data-page write and its log record could leave a
half-written page with no way to know — the "write-ahead" *is* the guarantee.

### Move 2 — walk durability in this repo

**Every commit waits on the WAL fsync.** When `upsert()` runs `commit`
(`pg-vector-store.ts:58`), Postgres flushes the WAL records for all the chunk
inserts to disk, *then* returns. By the time the `await client.query('commit')`
resolves in JS, the chunks are durable. Same for the documents insert's implicit
commit (`runtime.ts:11`) and each `messages` insert
(`supabase-trace-sink.ts:27`). **What this means concretely:** if the Node
process dies the instant after a `commit` resolves, those rows are still there
when Postgres restarts — recovery replays the WAL.

**Recovery is automatic and the repo relies on it implicitly.** Nobody wrote
recovery code; there's none to write. On restart after a crash, Postgres reads
the WAL from the last checkpoint forward and replays every committed change not
yet in the data files. The repo's only "recovery" posture is idempotency: the
`on conflict do update` writes (`05`, `06`) mean re-running an index or replaying
a turn can't duplicate rows.

**The two-transaction write has a two-fsync recovery gap.** Connect this to `05`.
`indexDocumentRow` commits txn A (documents), then txn B (chunks) — two separate
fsyncs, two separate durability boundaries:

```
  indexDocumentRow — durability boundaries, two separate crossings

  txn A: INSERT documents → commit → fsync ✓ ──► [documents DURABLE]
                                                       │
                                          ⚠ crash here
                                                       │
  txn B: begin → insert chunks → commit → fsync ✓ ──► [chunks DURABLE]

  recovery after a crash in the gap:
    WAL has txn A (durable) → documents row survives
    txn B never committed   → no chunks
    result: a durable, retrievable-from-corpus document with no embeddings
```

This is the same anomaly as `05`, seen through the durability lens: recovery
faithfully restores exactly what committed, and what committed was *only* the
documents row. WAL recovery doesn't heal the gap — it *preserves* it. The heal is
the application's job (re-index, idempotent). That's the honest boundary: the WAL
guarantees per-transaction durability, not cross-transaction atomicity.

**Backups, PITR, archiving: none of it.** The repo configures no WAL archiving
(`archive_mode`), no base backups, no point-in-time recovery. There's no
`pg_dump` in the scripts, no restore path. For a single-device personal RAG
where the source corpus is re-indexable markdown and the database is a derived
artifact, that's a defensible call — you can rebuild from source. But it's worth
naming: **there is no backup strategy, and the durability story stops at "the WAL
survives a process crash," not "the data survives a disk failure."** → `not yet
exercised`.

### Move 2.5 — current state vs future state (durability posture)

```
  Phase A — now                    Phase B — if the DB becomes authoritative
  ─────────────────────────────    ──────────────────────────────────────
  fsync=on default (per-txn safe)   same — plus WAL archiving (archive_mode)
  no backups / no PITR              base backup + continuous WAL archive
  recovery = restart replay only    PITR: restore to any point in time
  corpus is the real source         DB holds data not re-derivable (memory!)

  the tell: conversation MEMORY chunks are NOT re-derivable from the corpus.
  the day those matter, "rebuild from source" stops being a backup plan.
```

That last line is the real finding: indexed *documents* are re-derivable, but
*memory* chunks (`meta.kind='memory'`, written by `memory.remember()` in
`session.ts`) are generated from conversations and aren't in the source corpus.
Once memory matters, "no backups, rebuild from markdown" no longer covers
everything.

### Move 3 — the principle

The WAL gives you exactly one durability promise: a *committed* transaction
survives a crash, because its intent hit the log before the commit was
acknowledged. It does not promise cross-transaction atomicity (the gap survives
recovery, it doesn't get healed), and it does not protect against disk loss
(that's backups, which this repo doesn't have). Knowing precisely where the
durability boundary sits — at the per-transaction fsync — is what lets you reason
about what a crash actually costs: here, at worst, an orphaned document a
re-index fixes, and conversation memory that has no second copy.

---

## Primary diagram

The full durability path and the recovery outcomes.

```
  buffr-laptop — WAL durability + recovery

  WRITE PATH (every commit):
  ┌─ Service ─────┐  commit   ┌─ Postgres ───────────────────────┐
  │ upsert()      │ ────────► │ 1. WAL record appended            │
  │ documents     │           │ 2. fsync WAL  ◄── durability seam │
  │ messages      │ ◄──────── │ 3. ack commit                     │
  └───────────────┘  resolved │ 4. data page flushed @ checkpoint │
                              └───────────────────────────────────┘

  RECOVERY (on restart after crash):
    replay WAL from last checkpoint → restore committed-but-unflushed

  indexDocumentRow gap:  txn A durable ✓  ⚠  txn B lost  →  orphan doc
    WAL preserves the gap; app heals via idempotent re-index

  NOT CONFIGURED:  WAL archiving · base backups · PITR
    risk: memory chunks (not in corpus) have no second copy
```

---

## Elaborate

The write-ahead logging rule — log the change before applying it — is the
foundation of crash recovery in every serious database (Postgres WAL, MySQL
redo log, SQLite WAL mode). It turns durability from "flush every data page on
every commit" (slow, random I/O) into "append to one sequential log on every
commit" (fast, sequential I/O) plus lazy background page writes at checkpoints.
PITR builds on the same log: archive every WAL segment and you can replay the
database forward to any moment, which is how you recover from "someone dropped a
table at 2pm" rather than just a crash. This repo stops at crash recovery
because the database is mostly a derived artifact — a deliberate scope, with the
one caveat that memory chunks break the "rebuild from source" assumption. See
`study-system-design` for the broader durability-boundary decision.

---

## Interview defense

**Q: When `await client.query('commit')` resolves in your code, what's
guaranteed?**

> That the transaction's WAL records are fsynced to disk — it's durable. Postgres
> writes every change to the write-ahead log and flushes that log *before*
> acknowledging the commit. So in `upsert()` at `pg-vector-store.ts:58`, once the
> `commit` await resolves, those chunks survive a process crash: on restart,
> recovery replays the WAL. The data file pages get written lazily at a
> checkpoint, but durability doesn't wait on them — the WAL already has the
> change.

```
  commit → append WAL → fsync ◄(durable here) → ack → (page flush later)
```

> Anchor: "committed" means the WAL fsync happened, not that the data page was
> written.

**Q: A crash hits mid-`indexDocumentRow`. What does recovery give you back?**

> Exactly what committed — which might be only the documents row. The function
> commits documents in one transaction, then chunks in another. If the crash
> lands in the gap, WAL recovery restores the committed documents row and the
> uncommitted chunks simply never existed. Recovery *preserves* the gap, it
> doesn't heal it — that's the application's job via idempotent re-index. And
> there's no backup beyond crash recovery, so a disk failure loses the lot;
> documents re-index from the corpus, but conversation memory doesn't.

```
  crash in gap → WAL replays txn A (documents) → txn B (chunks) gone
  heal = re-index (idempotent), NOT recovery
```

> Anchor: WAL guarantees per-transaction durability; it doesn't give you
> cross-transaction atomicity or disk-failure protection.

---

## See also

- `05-transactions-isolation-and-anomalies.md` — the two-transaction write whose
  durability gap this file traces.
- `06-locks-mvcc-and-concurrency-control.md` — idempotent `on conflict` writes,
  the application-level heal for the gap.
- `08-replication-and-read-consistency.md` — where WAL goes when there's a
  replica.
- `study-system-design` — the durability-boundary and backup-scope decision.
