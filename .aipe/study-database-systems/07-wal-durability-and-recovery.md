# WAL, Durability, and Recovery

**Industry name(s):** write-ahead log / durability / crash recovery · **Type:** Industry standard

---

## Zoom out, then zoom in

When `COMMIT` returns in buffr, the data is safe against a process crash — Postgres wrote the change to the write-ahead log and fsynced it first. This file is about that guarantee: what WAL is, why "log before data" makes crash recovery possible, and the durability buffr has versus the durability it doesn't (no backup, no replica).

```
  Zoom out — where durability is decided

  ┌─ Persistence ───────────────────────────────────────────────┐
  │  upsert COMMIT · migrate COMMIT · persistMessage (autocommit) │
  └──────────────────────────┬──────────────────────────────────┘
                             │  COMMIT
  ┌─ Storage engine ─────────▼──────────────────────────────────┐
  │  ★ WAL: append change to log, fsync, THEN ack the commit ★   │ ← we are here
  │  heap pages flushed lazily later · crash → replay WAL        │
  └─────────────────────────────────────────────────────────────┘
                             │  (no replica · no backup script in repo)
  ┌─ Durability boundary ────▼──────────────────────────────────┐
  │  survives: process crash, power loss   NOT: disk loss        │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the verdict up front — **buffr's writes are crash-durable (WAL default) but not disaster-durable (no backup, no replica).** A `kill -9` or power cut mid-write loses nothing committed; a dead SSD loses everything. The repo never addresses the second, and for a laptop side-project that's a defensible line — but it's a line worth naming.

---

## The structure pass

Trace one axis across the failure spectrum: *what survives each kind of failure?*

```
  Axis = "does committed data survive THIS failure?"

  ┌─ process crash (kill -9) ──────┐  → SURVIVES (WAL replay on restart)
  ├─ OS crash / power loss ────────┤  → SURVIVES (fsync'd WAL on disk)
  ├─ disk / SSD failure ───────────┤  → LOST   (no backup, no replica)  ◄ the gap
  ├─ accidental DROP / bad write ──┤  → LOST   (no PITR, no snapshot)    ◄ the gap
  └─ datacenter loss ──────────────┘  → N/A    (single laptop)
```

The seam is between "WAL covers it" and "nothing covers it." WAL protects against *crashes* — the data's on disk, the process just died. WAL does *nothing* against the disk itself dying or a human dropping a table. **That seam is the durability story: buffr is on the safe side of it for crashes and the exposed side for disasters.**

---

## How it works

### Move 1 — the mental model

You know how an append-only event log lets you rebuild state by replaying events? WAL is exactly that for the database. Before touching the actual data pages, Postgres appends "here's what I'm about to change" to a sequential log and fsyncs it. If the process dies before the data pages are flushed, restart replays the log and re-applies the changes.

```
  The pattern — log first, data later, replay on crash

  COMMIT:
    1. append change record to WAL ──► fsync ──► ack the commit  ◄ durable HERE
    2. (later, lazily) flush dirty heap pages to disk

  CRASH between 1 and 2:
    restart → read WAL → replay un-flushed changes → data pages caught up
       │
       └─ the commit is safe the instant step 1's fsync returns,
          even though the heap page wasn't written yet
```

One sentence: **write the intent to a fsync'd sequential log before the data pages, so a crash can be recovered by replaying the log.**

### Move 2 — the load-bearing skeleton

WAL durability has a small kernel. Drop a piece and the guarantee collapses:

```
  WAL durability kernel

  ① write-ahead ordering: WAL record hits disk BEFORE the data page
  ② fsync on commit:      synchronous_commit=on → fsync before ack
  ③ replay on restart:    redo un-flushed committed changes from WAL
  ④ checkpoint:           periodically flush data pages, trim old WAL
```

**① Write-ahead ordering — without it, no recovery.** If a data page could hit disk before its WAL record, a crash could leave a half-written page with no log to fix it. The "ahead" in write-ahead is the whole guarantee. This is sequential I/O (append to one log) standing in for random I/O (scattered page writes), which is *also* why it's fast.

**② fsync at commit — without it, "committed" is a lie.** `synchronous_commit=on` (the default buffr runs) means `COMMIT` doesn't return until the WAL record is fsync'd to disk. Turn it off and commits ack before the fsync — faster, but a power loss can lose the last few "committed" transactions. buffr never changes this; it runs the safe default.

**③ Replay on restart — without it, the log is useless.** On startup Postgres finds the last checkpoint and replays every committed WAL record after it, redoing changes that hadn't reached the data pages. This is automatic; buffr does nothing to invoke it.

**④ Checkpoint — without it, WAL grows forever and recovery takes forever.** Periodically Postgres flushes all dirty pages and records a checkpoint, so replay only needs WAL *after* the last checkpoint. Untuned default in buffr; on a write-light DB, default checkpointing is fine.

```
  Recovery after a crash — the replay window

  ──WAL──[checkpoint]──[commit A]──[commit B]──[commit C]──✗crash
                          │           │           │
                          └───────────┴───────────┘
                          replay re-applies A, B, C if their
                          data pages hadn't flushed yet
                          (anything before the checkpoint is already on disk)
```

### Move 2.5 — what buffr has vs what's missing

```
  Durability — present vs not yet exercised

  PRESENT (Postgres default, free):
   ├─ WAL with synchronous_commit=on  → crash & power-loss durable
   ├─ automatic crash recovery (WAL replay)
   └─ checkpointing

  NOT YET EXERCISED (nothing in the repo):
   ├─ pg_dump / backup script          → no protection vs disk failure
   ├─ WAL archiving (archive_command)  → no point-in-time recovery
   ├─ pg_basebackup / snapshots        → no restore-to-yesterday
   └─ replica / standby (see 08)       → no second copy
```

The honest line: WAL gives buffr crash durability for free, and the repo stops exactly there. There's no `pg_dump` in `package.json` scripts, no backup runbook, no WAL archiving config. For a laptop agent whose corpus is *re-derivable* (it's indexed from markdown files on disk — re-run `index` and it's rebuilt), losing `reindb` is annoying, not catastrophic: the source of truth is the markdown, not the database. That's the actual reason the gap is acceptable, and it's worth stating plainly rather than pretending the gap doesn't exist.

### Move 3 — the principle

Durability is a boundary, not a binary: WAL draws the line at "survives a crash," and you choose where to draw the next line (backup → survives disk loss; replica → survives node loss; PITR → survives a bad write). buffr draws exactly the first line and relies on the markdown corpus being the real source of truth for everything past it. Knowing *which* line you've drawn — and that re-indexing makes the DB reconstructible — is the durability analysis.

---

## Primary diagram

The full durability picture — commit path, replay, and the boundary.

```
  buffr durability — WAL covers crashes, nothing covers disasters

  COMMIT (upsert / migrate / persistMessage)
        │
        ▼
  ┌─ WAL ────────────────────────────────────────┐
  │ append change record → fsync → ack commit    │ ◄── DURABLE HERE
  │ (synchronous_commit=on, default)             │     (crash/power safe)
  └──────────────────────┬───────────────────────┘
                         │ lazily, later
  ┌─ heap pages ─────────▼───────────────────────┐
  │ dirty pages flushed at checkpoint            │
  └──────────────────────────────────────────────┘
        │
   CRASH? → restart → replay WAL since last checkpoint → recovered

  ════════════ DURABILITY BOUNDARY ════════════
  beyond here NOT covered:
   disk failure · DROP TABLE · "restore to yesterday"
   → mitigated only by: the markdown corpus is re-indexable
     (re-run `index` to rebuild reindb)
```

---

## Implementation in codebase

**Use cases.** Durability is decided at every `COMMIT`. The two explicit commits (`upsert`, `migrate`) and every implicit one (`persistMessage`, `startConversation`) all ride the same WAL guarantee. The recovery story is "re-index from markdown" — which is implemented as `indexDocumentRow` + the CLI.

```
  src/pg-vector-store.ts  (line 58)  — the durability point

  await client.query('commit');
       │
       └─ this single line is where the chunk batch becomes durable. Under
          synchronous_commit=on (default), `commit` doesn't return until the
          WAL record is fsync'd. A crash AFTER this line loses nothing; a
          crash BEFORE it rolls the whole batch back (see 05).
```

```
  src/migrate.ts  (lines 12–13)  — schema durability

  await client.query(sql);
  await client.query('commit');   ← the schema is WAL-logged + fsync'd here
       │
       └─ DDL is WAL-logged like any write, so a crash mid-migration replays
          to either the full schema or none — transactional DDL + WAL together.
```

```
  src/runtime.ts  (lines 11–18)  — why losing reindb isn't fatal

  await pool.query(`insert into agents.documents …`, [...]);  ← derived from markdown
  await pipeline.index({ id: doc.id, text: doc.text });        ← derived from markdown
       │
       └─ both writes are reconstructible from the markdown source files. The
          DB is a DERIVED store, not the source of truth — which is the real
          reason "no backup" is a tolerable gap. Re-run `index` and reindb is
          rebuilt. (The source-of-truth markdown lives outside the DB.)
```

There is no backup script, no `archive_command`, no `pg_dump` in the repo's `package.json` scripts — confirmed `not yet exercised`. The recovery plan is implicit: re-index.

---

## Elaborate

WAL is the foundation under almost everything else in this guide — it's what makes COMMIT atomic *and* durable (`05`), it's what replication ships to standbys (`08`), and it's the sequential-I/O trick that makes commits fast despite fsync (random page writes would be far slower). "Log the intent before mutating the state, then replay the log to recover" is the same pattern as a redo log, an event-sourced aggregate, or a filesystem journal — once you see it in WAL you see it everywhere.

The durability gap worth taking seriously isn't crash (WAL covers it) — it's the *human* failure: an accidental `DROP TABLE agents.chunks` or a bad migration. WAL doesn't help; you'd need point-in-time recovery (WAL archiving + a base backup) to rewind. For buffr the mitigation is the re-indexable corpus, but that only restores *documents and chunks* — the `conversations`/`messages` trace history is *not* re-derivable, and that's the one slice of data a disk loss would actually destroy permanently. If any data in buffr deserves a `pg_dump`, it's the trajectory tables, not the chunks. Cross-link `08` for the replica path; cross-link `study-system-design` for where backup would live operationally.

---

## Interview defense

**Q: When is a write durable here, and against what failures?**

When `COMMIT` returns. Under the default `synchronous_commit=on`, COMMIT doesn't return until the WAL record is fsync'd, so the write survives a process crash or power loss — restart replays the WAL. It does *not* survive disk failure or a bad DROP, because there's no backup or replica.

```
  COMMIT → WAL fsync → durable vs crash/power
              │
        NOT vs disk-loss / DROP (no backup, no PITR)
```

Anchor: *"Crash-durable via WAL, not disaster-durable — no backup, no replica. The mitigation is the corpus is re-indexable."*

**Q: If `reindb` is wiped, what's actually lost?**

Documents and chunks are re-derivable — re-run `index` from the markdown source. What's *permanently* lost is the conversations/messages trace history; it's not reconstructible from anything. So if anything deserves a backup, it's the trajectory tables, not the vectors.

Anchor: *"The vectors are derived data; the trace history isn't — that's the slice that actually needs a backup."*

---

## Validate

1. **Reconstruct:** Draw the WAL commit path and the crash-replay window. Why does logging *before* the data page make recovery possible?
2. **Explain:** Why does `await client.query('commit')` (`src/pg-vector-store.ts:58`) make the batch durable but `BEGIN` does not?
3. **Apply:** A teammate sets `synchronous_commit=off` for speed. Name exactly what's now at risk and in which failure.
4. **Defend:** Justify buffr having no backup — then identify the one table where that justification fails.

---

## See also

- `05-transactions-isolation-and-anomalies.md` — COMMIT as both atomic and durable
- `08-replication-and-read-consistency.md` — shipping WAL to a standby (not yet exercised)
- `06-locks-mvcc-and-concurrency-control.md` — how committed versions become visible
- `study-system-design` — where backup/restore would live operationally
