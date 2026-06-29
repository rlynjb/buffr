# WAL, durability, and recovery

**Industry name:** the write-ahead log (WAL) · durability / fsync ·
crash recovery and point-in-time recovery (PITR) — *Industry standard*

---

## Zoom out — where this concept lives

This is the bottom of the map (`01`) — seam 3, the durability boundary. It answers the
last ACID letter: **D**urability. When `upsert`'s `commit` returns, what *exactly* is
guaranteed to survive a power cut? The WAL is the mechanism, and where buffr's
durability story ends (no archiving, no PITR) is the honest edge of this file.

```
  where durability sits

  ┌─ Transaction layer ─────────────────────────────────────┐
  │  commit returns to the application                       │
  └───────────────────────────┬─────────────────────────────┘
                              │  "is it safe now?"
  ┌─ Durability layer ────────▼─────────────────────────────┐
  │  ★ write-ahead log (WAL) — fsync'd on commit ★           │
  │  the heap pages get written LATER (checkpoint)           │
  └───────────────────────────┬─────────────────────────────┘
                              │  recovery replays WAL after a crash
  ┌─ Storage layer ───────────▼─────────────────────────────┐
  │  heap pages on disk + WAL segments                       │
  │  (no archiving / no PITR configured in this repo)        │
  └───────────────────────────────────────────────────────────┘
```

---

## Zoom in — narrow to the concept

The question: *when buffr's `commit` returns, what survives a crash — and what
wouldn't?* The counterintuitive answer: at commit, the *data pages aren't written to
their final home yet*. What's durable is the **write-ahead log** — a sequential record
of the change, fsync'd to disk before commit returns. The heap catches up later. Name
the WAL, walk commit → crash → recovery, then mark exactly where buffr's durability
guarantee stops (local crash recovery: yes; point-in-time restore: not configured).

---

## The structure pass

### Layers

```
  commit returns          →  the application believes the write is safe
    WAL fsync             →  the change is durably logged (THIS is the guarantee)
      checkpoint          →  dirty heap pages flushed to their final location (later)
        recovery          →  on restart, replay WAL from last checkpoint
```

### Axis: trace *"what is durable RIGHT NOW?"* down the layers

```
  "what survives a power cut at this instant?"  — traced at commit time

  ┌──────────────────────────────────────────────┐
  │ heap page in shared_buffers (RAM)             │  → NOT durable. it's in memory.
  └───────────────────────┬───────────────────────┘
      ┌───────────────────▼───────────────────┐
      │ WAL record fsync'd to disk             │  → DURABLE. this is the line.
      └───────────────────┬───────────────────┘
          ┌───────────────▼───────────────────┐
          │ heap page flushed at checkpoint    │  → eventually durable, not yet
          └────────────────────────────────────┘

  the answer flips at the WAL fsync: the change is safe once it's in the log,
  NOT once it's in the heap. recovery rebuilds the heap from the log.
```

### Seams

```
  seam 1  RAM ↔ WAL         the durability line. Before the WAL fsync, a crash loses
                          the write. After it, the write survives — even though the
                          heap page is still dirty in memory.
  seam 2  local ↔ archived   buffr's edge. WAL gives LOCAL crash recovery for free.
                          PITR (restore to a past moment) needs WAL *archiving*,
                          which is NOT configured. → not yet exercised.
```

Hand off: durability lives at the WAL fsync, not the heap write; local recovery is
automatic; point-in-time recovery is the unconfigured edge.

---

## How it works

### Move 1 — the mental model

You know how you append to a log file before doing the expensive work, so that if you
crash mid-work you can replay the log and finish? That's *exactly* the WAL — "write the
intent to a sequential log, fsync it, *then* you're allowed to say it's done; apply it
to the real data structure whenever's convenient." The heap is the expensive
random-access structure; the WAL is the cheap sequential append that makes the heap
recoverable.

```
  write-ahead logging — the kernel

  a write happens:
    1. record the change in the WAL (sequential append)   ← cheap, fast
    2. fsync the WAL to disk                               ← the durability point
    3. NOW commit may return "done"  ◄─── the guarantee
    4. ...later... flush the dirty heap page (checkpoint)  ← lazy, batched

  crash after step 3, before step 4?
    → on restart, REPLAY the WAL from the last checkpoint → heap rebuilt. no data lost.
```

The name says it: write *ahead* — the log is written *before* the data page it
describes. That ordering is the whole invariant.

### Move 2 — walk it

**Commit fsyncs the WAL, not the heap.** When `PgVectorStore.upsert` runs `commit`
(`pg-vector-store.ts:58`), here's what physically happens, step by step:

```
  upsert commit — what's on disk at each step

  step 1:  insert chunk → row written into a heap page in shared_buffers (RAM)
  step 2:  the change also appended to the WAL buffer
  step 3:  commit → WAL buffer fsync'd to the WAL segment on disk  ◄── DURABLE HERE
  step 4:  commit returns to upsert's await
  step 5:  ...minutes later... checkpoint flushes the dirty heap page to its file
```

**Consequence:** the instant `await client.query('commit')` returns, the chunk
insert is safe even though the actual `chunks` heap page might still be sitting dirty
in RAM. If the machine loses power at step 4, restart replays the WAL and the chunk is
there. If it loses power at step 2 (before the fsync), the transaction never committed
and the chunk simply isn't there — which is correct, because `commit` never returned.

**This is what makes upsert's atomicity real.** Tie it back to file `05`: `upsert`
wraps its chunk loop in `begin`/`commit`. The reason "all chunks or none" *survives a
crash* is the WAL — the commit record is the atomic flip. WAL replay either finds the
commit record (replay all the chunk inserts) or doesn't (replay none). The transaction
boundary from file `05` and the durability boundary here are the same line, enforced
by the same WAL commit record.

**The cross-transaction anomaly, through the durability lens.** Now re-read file `05`'s
anomaly with the WAL in hand. `indexDocumentRow` does two commits:

```
  the two-transaction write — durability view

  insert documents ──commit (WAL fsync #1)──► DURABLE ░crash░ insert chunks (no commit)
       │                                                              │
       ▼ WAL has the documents commit record                         ▼ no WAL record
  recovery replays documents row → it's there                   chunks → never written

  the document is durably, permanently orphaned. the WAL faithfully preserved
  exactly the half that committed. durability is working CORRECTLY — the bug is
  that the atom was the wrong size (file 05), not that durability failed.
```

That's the subtle point: durability did its job perfectly. It durably persisted the
inconsistent state, because the inconsistency was baked in at the transaction
boundary, above the WAL. Durability can't save you from an atom that's the wrong size.

**Migrations are WAL-protected too.** `runMigration` (`migrate.ts:8-20`) wraps the
whole schema script in one `begin`/`commit`. Postgres supports transactional DDL, so
the WAL makes the *entire migration* atomic and durable: either the whole
`001_agents_schema.sql` applied and survives a crash, or none of it did. A crash
mid-migration leaves the schema untouched, not half-built. That's a real strength worth
naming — many databases can't do transactional DDL.

**Where buffr's durability story ends — local recovery only.** Here's the honest edge.
WAL gives you *crash recovery* for free: kill the process, restart, Postgres replays
the WAL from the last checkpoint, and you're consistent. buffr gets that automatically;
it configures nothing and needs nothing.

What buffr does **not** have is anything *beyond* local crash recovery:

```
  durability ladder — buffr's rung

  rung                          mechanism                buffr?
  ────────────────────────────  ───────────────────────  ──────────────────
  crash recovery (local)        WAL replay on restart     ✓ automatic, free
  point-in-time recovery (PITR) WAL archiving + base      ✗ NOT configured
                                backup → restore to any
                                past moment
  off-machine durability        replicate WAL to standby  ✗ NOT configured (file 08)
  scheduled logical backup      pg_dump on a cron         ✗ not in repo
```

**Consequence:** a corrupted disk, an accidental `delete from chunks`, or a dropped
table is *unrecoverable* in buffr today — there's no base backup + archived WAL to
roll back to, and no `pg_dump` schedule. The only safety net is "the source markdown
still exists, so re-index from scratch." For a single-device personal RAG corpus
that's a defensible call — the documents are reproducible from their source files
(`source_path`, `documents.source_path`) — but it's a *choice*, and it's invisible. The
moment the corpus contains anything not reproducible from source (the conversation
trajectories in `messages`, the episodic memory chunks), that gap becomes real data
loss with no restore path.

### Move 3 — the principle

Durability is a *line drawn at the WAL fsync*, not at the heap write — commit means
"the log is on disk," and the heap catches up lazily. That decoupling is what makes
Postgres fast (sequential log writes, lazy random heap writes) *and* recoverable
(replay the log). But durability only protects what the transaction boundary captured:
it'll faithfully preserve an inconsistent state if the atom was the wrong size, and it
gives you *local* recovery only — surviving a process crash is free, surviving a disk
failure or a fat-fingered DELETE needs backups and archiving you have to set up
deliberately.

---

## Primary diagram

The full durability picture: commit → WAL → checkpoint → recovery, with buffr's edge marked.

```
  WAL durability in buffr — full recap

  ┌─ Application ──────────────────────────────────────────────────────┐
  │  upsert: await commit  ◄─── returns only after WAL fsync           │
  └───────────────────────────┬────────────────────────────────────────┘
                              │
  ┌─ Durability layer ────────▼────────────────────────────────────────┐
  │  1. change → shared_buffers (RAM, dirty heap page)                  │
  │  2. change → WAL buffer                                             │
  │  3. commit → WAL fsync to disk   ◄═══ THE DURABILITY LINE ═══       │
  │  4. ...later... checkpoint flushes dirty heap pages                 │
  │                                                                    │
  │  crash → restart → replay WAL from last checkpoint → consistent     │
  │  ✓ local crash recovery: AUTOMATIC                                  │
  │  ✗ PITR / WAL archiving / pg_dump: NOT CONFIGURED                   │
  │     → disk failure or bad DELETE = unrecoverable (re-index instead) │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Write-ahead logging is the foundational durability technique in every serious
database (Postgres WAL, MySQL redo log, SQLite WAL mode). The shared insight: random
writes to the data file are slow and unsafe to do eagerly, so you make durability cheap
by appending to a sequential log and fsyncing *that*, then apply the changes to the data
file lazily and in batches (the checkpoint). It's the same trick an event-sourced
system uses — the log is the source of truth, the materialised state is a cache you can
rebuild.

PITR — the rung buffr skips — works by keeping one base backup plus every WAL segment
since, so you can replay forward to any chosen moment ("restore to 3:00pm, just before
the bad delete"). It's the standard production safety net and it's genuinely *not
needed* for a reproducible-from-source single-device corpus — until the database holds
state that *isn't* reproducible (conversation history, episodic memory). That's the
trigger to revisit. `study-system-design` owns the backup-strategy decision; this file
just marks that the mechanism is absent and why that's currently acceptable.

---

## Interview defense

**Q: "When upsert's commit returns, what's actually on disk?"**

```
  commit time — what's durable

  RAM:  dirty heap page (the chunk row)      → NOT yet on disk
  DISK: WAL record, fsync'd                   → DURABLE ◄── the guarantee
  later: checkpoint flushes the heap page
```

Answer: "The WAL record, fsync'd — not the heap page. Commit returns the moment the
write-ahead log is durably on disk; the actual `chunks` heap page can still be dirty in
RAM and gets flushed later at a checkpoint. If the box loses power right after commit
returns, recovery replays the WAL and the chunk is there. Durability lives at the WAL
fsync, not the heap write." Anchor: *commit means the log is on disk, not the data
page.*

**Q: "Can buffr recover from an accidental `delete from chunks`?"**

Answer: "No. WAL gives local crash recovery for free — kill and restart, it replays. But
there's no WAL archiving, no PITR, no `pg_dump` schedule. A bad DELETE or a disk failure
has no restore path. The only recovery is re-indexing from the source markdown, which
works for the corpus because documents carry their `source_path` — but *not* for the
conversation trajectories or episodic memory, which aren't reproducible from source.
That's the gap that turns real the moment the database holds anything you can't
regenerate." Anchor: *WAL = crash recovery for free; PITR and backups are a separate,
unconfigured rung.*

---

## See also

- `05-transactions-isolation-and-anomalies.md` — the commit record is the atomic flip;
  the cross-transaction anomaly durably preserves the inconsistency.
- `02-records-pages-and-storage-layout.md` — dirty heap pages, checkpoints, vacuum.
- `08-replication-and-read-consistency.md` — replicating the WAL to a standby (absent).
- `study-system-design` — the backup-strategy decision (re-index vs PITR vs replica).
