# Replication and read consistency

**Industry name:** streaming replication · read replicas · replication lag and
stale reads · failover — *Industry standard*

---

## Zoom out — where this concept lives

Replication sits *beside* the engine, not inside it — it's a second Postgres instance
that copies the first's WAL. buffr has exactly one instance, so this entire band is
empty in the repo. The honest move per the spec: name it `not yet exercised`, teach
the mechanism so it's reachable, and mark precisely when it becomes relevant.

```
  where replication WOULD sit (currently absent)

  ┌─ Application ───────────────────────────────────────────┐
  │  pg.Pool → ONE connection string (DATABASE_URL)          │
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ Primary Postgres (reindb) ▼────────────────────────────┐
  │  WAL  →  fsync  →  heap                                  │
  └───────────────────────────┬─────────────────────────────┘
                              │  ░ ship WAL to a standby? ░
  ┌─ Replica (DOES NOT EXIST in buffr) ─────────────────────┐
  │  would replay primary's WAL, serve read-only queries     │
  │  ✗ NOT CONFIGURED — single instance, single device       │
  └───────────────────────────────────────────────────────────┘
```

---

## Zoom in — narrow to the concept

The verdict first: **replication is `not yet exercised`.** buffr is one Postgres
instance behind one connection string (`DATABASE_URL`, `src/db.ts:5`), serving one
device. There is no replica, no lag, no failover, no stale-read problem — because
there's no second copy to be stale. This file teaches the mechanism (so it transfers)
and names the exact trigger that would make buffr need it: a *second device* reading the
shared corpus. Until then, every consistency question collapses to the single-instance
answer — you always read your own writes, because there's only one place to read.

---

## The structure pass

### Layers

```
  one instance (today)    →  every read and write hits the same engine
    ──────────────────────────────────────────────────────────────────
    (the boundary buffr has not crossed)
    ──────────────────────────────────────────────────────────────────
  primary + replica (future)  →  writes to primary, reads can go to replica
    replication lag           →  the replica trails the primary by some delay
      stale reads             →  a read on the replica may miss a just-committed write
```

### Axis: trace *"can a read see the latest write?"* — single vs replicated

```
  "does a read see the most recent commit?"  — single vs replicated

  ┌─ buffr today: ONE instance ────────────────────┐
  │  write → commit → read                          │  → ALWAYS sees it.
  │  same engine, same MVCC snapshot rules           │     read-your-writes is free.
  └──────────────────────────────────────────────────┘
                       │  the axis would FLIP here, IF a replica existed
  ┌─ future: primary + replica ────────────────────┐
  │  write → primary commit → read on REPLICA        │  → MAYBE NOT: replica trails by
  │                                                  │     replication lag → STALE READ
  └──────────────────────────────────────────────────┘

  buffr never reaches the flip — one instance means read-your-writes is structural.
```

### Seams

```
  seam (absent)  primary ↔ replica   this seam DOES NOT EXIST in buffr. When it's
                                    created, an axis flips across it (read-your-writes
                                    → maybe-stale), which is exactly what makes it
                                    load-bearing — and exactly why it needs careful
                                    handling the day it appears.
```

Hand off: one instance today, read-your-writes for free; the primary↔replica seam is
the future boundary where stale reads enter.

---

## How it works

### Move 1 — the mental model

You know how a CDN edge node serves a cached copy of your origin's content, and there's
a window where the edge is stale until it revalidates? A read replica is that for a
database: the primary is the origin, the replica is the edge, and *replication lag* is
the staleness window. You send writes to the origin (primary) and you *can* send reads
to the edge (replica) to spread load — at the cost of sometimes reading a slightly old
copy.

```
  replication — the shape (what buffr would build, not what it has)

   writes ──────────────────────────► ┌─ PRIMARY ─┐
                                       │  WAL      │
                                       └─────┬─────┘
                                             │ stream WAL records
                                             ▼
   reads (optional) ──────────────► ┌─ REPLICA ─┐
                                     │ replay WAL │  ← trails primary by "lag"
                                     └────────────┘     (ms to seconds)

   buffr: the PRIMARY box exists. the REPLICA box and the stream do not.
```

### Move 2 — walk the mechanism (and where buffr stops)

**Single instance — the current reality.** buffr's connection layer is one pool to one
URL.

```ts
// src/db.ts:4-6
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
  //                   ▲ ONE database. no primary/replica routing.
}
```

Every read (`search`) and every write (`upsert`, `persistMessage`) hits this one
engine. **Consequence:** read-your-writes consistency is automatic and total — the
instant `upsert`'s commit returns (durable per file `07`), the very next `search` sees
those chunks, because they're in the same instance under the same MVCC visibility rules
(file `06`). There is no window, no lag, no routing decision. This is the simplest
possible consistency model, and it's correct *because* it's single-instance.

**Streaming replication — what a replica would add.** If buffr grew a replica, the
primary would stream its WAL (the same WAL from file `07`) to a standby, which replays
it to stay nearly current. Two flavors:

```
  the two replication flavors

  asynchronous (default):  primary commits, returns to app, THEN ships WAL
                           → fast writes, but replica lags → stale reads possible
  synchronous:             primary waits for replica to confirm before commit returns
                           → no stale reads on that replica, but slower writes
```

**Replication lag — the stale-read window.** With async replication (the common
choice), there's a gap between "primary committed" and "replica has it." A read routed
to the replica in that gap *misses the just-committed write*. For a RAG agent that
would mean: index a new document, immediately ask about it, and the search (on the
replica) returns nothing because the chunks haven't replicated yet.

```
  the stale read that buffr would have to handle (but doesn't, today)

  t0: indexDocumentRow → primary commits new chunks
  t1: replica still replaying... (lag window)
  t2: user asks → search routed to REPLICA → chunks NOT THERE yet → empty result
  t3: replica catches up → search would now work

  the fix when it matters: route read-your-writes-sensitive reads to the PRIMARY,
  or use synchronous replication, or tolerate the staleness explicitly.
```

**Failover — what a replica buys for durability.** The other reason to run a replica is
*availability*: if the primary's machine dies, a replica can be promoted to primary.
This connects to file `07`'s durability gap — a replica is *off-machine durability*, the
rung buffr skips. A replica that has the WAL is a live, queryable backup that survives a
disk failure the single instance can't.

**Why buffr correctly has none of this.** State it without apology: buffr is a
*single-device personal RAG agent* (the `'laptop'` app_id, the whole premise). One
device, one user, one writer (file `06`), one reader. A replica would add a stale-read
problem the app doesn't currently have, in exchange for read-scaling and availability
the app doesn't currently need. The right number of replicas for a single-device app is
zero. This is a deliberate non-decision, not an omission.

**The exact trigger to revisit.** Per the spec's "name when it becomes relevant":

```
  when buffr would need replication

  trigger                                    why
  ─────────────────────────────────────────  ─────────────────────────────────────
  a SECOND device reads the shared corpus    read load to spread, or off-laptop access
  the corpus must survive laptop failure     off-machine durability (replica as backup)
  the agent must stay up if Postgres dies     failover to a promoted replica

  until ANY of these, single-instance read-your-writes is the correct model.
```

The buffr-laptop name and the `agent-layer-plan.md` parent vision hint at a future
multi-device "brain" — *that's* the moment this file stops being `not yet exercised`.

### Move 3 — the principle

Replication is a trade you make to buy read-scaling or availability, and the bill is
*consistency complexity*: the moment a second copy exists, "read your own writes" stops
being free and becomes a routing decision (read the primary) or a tolerance ("stale is
okay here"). A single instance has the strongest consistency model possible — total,
automatic read-your-writes — precisely because it has no replica. Don't add a replica
until a concrete trigger (a second reader, an availability requirement) makes the trade
worth the consistency complexity.

---

## Primary diagram

The full picture: what buffr has (one instance) and what it would add (replica + lag).

```
  replication in buffr — full recap (one band real, one band hypothetical)

  ┌─ REAL: single instance ────────────────────────────────────────────┐
  │  pg.Pool ──► Postgres (reindb) ──► WAL ──► heap                     │
  │  read-your-writes: TOTAL & AUTOMATIC (same MVCC snapshot)           │
  └────────────────────────────────────────────────────────────────────┘

  ░░░░░░░░░░░░░░░░ the boundary buffr has not crossed ░░░░░░░░░░░░░░░░░░░

  ┌─ HYPOTHETICAL: primary + replica (NOT in repo) ────────────────────┐
  │  writes ─► PRIMARY ═WAL stream═► REPLICA ─► reads                   │
  │            (commits)   (lag)      (replays, trails by lag)          │
  │  new problem introduced: STALE READS in the lag window             │
  │  fix: route read-your-writes to primary, or sync replication        │
  │  trigger to build: a 2nd device, off-machine durability, failover   │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Streaming replication ships the same WAL that file `07` uses for crash recovery — a
replica is just a second Postgres continuously running WAL replay from the primary's
log instead of from its own restart. That's the elegant unification: the durability log
*is* the replication stream. Synchronous vs asynchronous is the one knob that decides
whether you've traded write latency for replica freshness.

The consistency vocabulary this file gestures at — read-your-writes, monotonic reads,
eventual consistency — is the *distributed-systems* consistency model, and a
multi-replica buffr would be a small distributed system. `study-distributed-systems` (if
generated) owns the full treatment: quorums, consistency levels, partition tolerance.
`study-system-design` owns the *decision* of when buffr's architecture should grow a
replica. This file's job is narrow: name that the mechanism is absent, teach enough to
recognize it, and pin the trigger.

---

## Interview defense

**Q: "What's buffr's read consistency model?"**

```
  single instance → read-your-writes is free

  write → commit → read    all on ONE engine, one MVCC ruleset
       └──── always sees it ────┘   no replica, no lag, no stale window
```

Answer: "Total read-your-writes, automatically — because it's a single instance. The
moment `upsert` commits, the next `search` sees those chunks under the same MVCC
visibility. There's no replica, so there's no lag and no stale-read problem. That's the
strongest consistency model there is, and buffr gets it for free by being
single-device." Anchor: *one instance means read-your-writes is structural, not
engineered.*

**Q: "When would you add a read replica, and what would break?"**

Answer: "When a second device needs to read the corpus, or the corpus has to survive the
laptop dying, or the agent must stay up through a Postgres failure. The cost: a replica
trails the primary by replication lag, so a read routed to it can miss a just-committed
write — index a doc, immediately query it, get nothing. You'd fix that by routing
read-your-writes-sensitive reads to the primary, or running synchronous replication, or
explicitly tolerating staleness. Today none of those triggers exist, so zero replicas is
the right call." Anchor: *a replica buys scaling and availability and bills you in
stale-read complexity — don't buy until a trigger forces it.*

---

## See also

- `07-wal-durability-and-recovery.md` — the WAL that a replica would stream; replica as
  off-machine durability.
- `06-locks-mvcc-and-concurrency-control.md` — the single-writer reality that pairs with
  single-instance.
- `09-database-systems-red-flags-audit.md` — replication listed under `not yet
  exercised`.
- `study-system-design` — the *decision* of when to grow a replica.
