# Replication and read consistency

**Subtitle:** primary/replica streaming replication / replication lag / read-your-writes — *Industry standard*

---

## Zoom out, then zoom in

Replication is how a database stays available and scales reads: ship the WAL from
a primary to one or more replicas, so a replica can serve reads or take over on
failover. `buffr-laptop` has none of this — it's a single Postgres node, one
process, no standby. This file is mostly an honest `not yet exercised`: the
mechanism is real and worth understanding, but nothing in the repo drives it.
The value here is knowing *exactly* what would change the day a replica appears.

```
  Zoom out — replication would sit beside the single node

  ┌─ Service ───────────────────────────────────────────────┐
  │  search() (read)        upsert() / commits (write)        │
  └──────────────────────────┬───────────────────────────────┘
                             │  one pg.Pool → one node TODAY
  ┌─ Storage ───────────────▼────────────────────────────────┐
  │  ★ Postgres reindb (PRIMARY) ★                            │ ← only node today
  │  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
  │  ┌ replica (NONE) ┐  would stream WAL, serve stale reads  │
  │  └────────────────┘  ← not yet exercised                  │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: streaming replication works by shipping the same WAL records from `07`
to a replica, which replays them to stay (nearly) in sync. The lag between
"primary committed" and "replica replayed" is the whole game — it's why a read
from a replica can be *stale*. The question: what consistency does buffr assume
today (full, single-node), and which of its read paths would break under
replication lag?

---

## The structure pass

**Layers.** Replication, when it exists, decomposes into:

```
  ┌─ Write routing ──────────────────┐  writes → primary only
  └──────────────┬────────────────────┘
  ┌─ WAL streaming ▼──────────────────┐  primary ships WAL → replica
  │   the lag lives here               │
  └──────────────┬────────────────────┘
  ┌─ Read routing ▼───────────────────┐  reads → primary or replica?
  │   stale-read risk decided here     │
  └────────────────────────────────────┘
```

**Axis — trace `read consistency` (does a read see the latest write?) across the
topology.** *Will this read reflect what I just wrote?*

- Single node (today): **always yes.** One node, no lag, read-your-writes is
  free. buffr assumes this everywhere.
- With a replica, write to primary then read from replica: **maybe not** — if
  the read beats WAL replay, it's stale.

**Seam — the primary↔replica WAL stream (doesn't exist yet).** The day it does,
*read consistency* flips across it: a read on the primary side is current, a read
on the replica side is "current as of replay." buffr has no code that knows which
side it's reading from — `search()` just calls `pool.query()`. That's fine on one
node; it's the exact assumption that breaks under replication.

---

## How it works

### Move 1 — the mental model

You know read-your-writes from optimistic UI: you update local state immediately
so the user sees their own change before the server confirms — because reading
from the server might not reflect the write yet. Replication lag is the
server-side version of that exact problem: you write to the primary, the replica
hasn't replayed it yet, so a read from the replica shows the *old* value. The
fix is the same shape — route the read to where the write is guaranteed visible,
or wait for the replica to catch up.

```
  Replication lag — the staleness window (the kernel)

  t0  primary: COMMIT write  ──► durable on primary
        │ ship WAL
        ▼ (network + replay delay = LAG)
  t1  replica: replays WAL    ──► now visible on replica

  a read on the replica between t0 and t1 → STALE (sees pre-write state)
  read-your-writes requires reading the primary, or waiting past t1
```

### Move 2 — what buffr assumes, and what would change

**Today: single node, full consistency, every assumption holds.** There's one
Postgres, reached through one pool (`db.ts:4`). Walk the read-your-writes paths
that *depend* on single-node consistency:

- **Memory write-then-recall.** `session.ts` calls `memory.remember()` after a
  turn (writes a memory chunk), and the *next* turn's `search()` may recall it.
  On one node, the just-written memory chunk is immediately visible to the next
  search. **Under a replica:** if the next `search()` hit a lagging replica, the
  memory chunk might not be there yet — the agent "forgets" the exchange it just
  had. This is the read path most exposed to lag.

- **Index-then-query.** `indexDocumentRow` commits chunks, and a subsequent
  `search()` retrieves them. On one node, immediate. On a replica, a query right
  after indexing could miss the new chunks until replay catches up.

- **Conversation/message replay.** The trajectory writes
  (`supabase-trace-sink.ts`) and any later read of `agents.messages` assume the
  writes are visible. Single-node: guaranteed. Replica: lagged.

```
  Layers-and-hops — the memory recall path, single-node vs replica

  SINGLE NODE (today):
  ┌─ ask() turn N ─┐  remember()  ┌─ Postgres ─┐  search()  ┌─ turn N+1 ─┐
  │ write memory   │ ───────────► │ committed  │ ─────────► │ recalls it │
  └────────────────┘              └────────────┘            └────────────┘
       immediate visibility — read-your-writes is free

  WITH REPLICA (hypothetical):
  ┌─ write ─┐ → PRIMARY ──WAL lag──► REPLICA ◄── ┌─ read (search) ─┐
                                                  └─────────────────┘
       read may land before replay → memory chunk missing → "forgot"
```

**The code has no read/write routing — which is correct for one node.**
`PgVectorStore` issues both `upsert()` (write) and `search()` (read) through the
same `pool` (`pg-vector-store.ts`). There's no "send reads here, writes there"
split because there's nowhere else to send them. **What this means:** adopting
replication isn't a config flip — it's an application change. You'd either keep
all reads on the primary (no read scaling, but read-your-writes preserved), or
route some reads to a replica and accept staleness on the paths above.

**Failover isn't handled either.** With one node, if Postgres goes down, buffr is
down — the `pool` has no failover target, and with no `connectionTimeoutMillis`
(`06`) a `connect()` would hang rather than fail over. That's the availability
side of the same single-node story.

### Move 2.5 — current state vs future state (replication)

```
  Phase A — now (single node)      Phase B — primary + replica
  ─────────────────────────────    ──────────────────────────────────────
  one Postgres, one pool            primary (writes) + replica(s) (reads)
  read-your-writes free             lag window → stale reads possible
  no read/write routing in code     app must route + handle staleness
  no failover                       replica promotion on primary failure
  memory recall always current      memory recall can miss recent turns

  what doesn't change: the SQL, the schema, the index. what changes:
  read routing and the read-your-writes assumption baked into session.ts.
```

### Move 3 — the principle

Single-node consistency is an assumption you get for free and stop noticing —
every read sees every prior write, instantly. Replication is what trades that
assumption for availability and read-scaling, and the price is a staleness
window measured in replication lag. The skill is knowing *which* of your read
paths actually depend on read-your-writes — here it's memory recall and
index-then-query — because those are the ones that break first when a replica
shows up. buffr's code is consistent by construction today; the day it isn't,
the change is in the application's read routing, not the schema.

---

## Primary diagram

The single-node reality and the replicated future, side by side.

```
  buffr-laptop — replication: now vs later

  NOW (single node, full consistency):
  ┌─ Service ─┐  read+write   ┌─ Postgres reindb (PRIMARY) ─┐
  │ search()  │ ────────────► │ every read sees every write  │
  │ upsert()  │              └──────────────────────────────┘
  └───────────┘   read-your-writes: FREE

  LATER (primary + replica — NOT YET EXERCISED):
  ┌─ Service ─┐ writes  ┌─ PRIMARY ─┐ ──WAL stream──► ┌─ REPLICA ─┐
  │ route by  │ ──────► │ authoritative│   (lag)       │ stale reads│
  │ read/write│ reads ?─┴────────────┘                └───────────┘
  └───────────┘
     exposed paths: memory recall, index-then-query (session.ts)
```

---

## Elaborate

Postgres streaming replication ships WAL records (the same log from `07`) over a
connection to a standby that replays them continuously — async by default (the
primary doesn't wait for the replica, so there's lag) or synchronous (the primary
waits for the replica to confirm, no data loss on failover but higher write
latency). The CAP-theorem framing: under a network partition you choose
consistency or availability, and async replication picks availability with a
stale-read window. Read-your-writes, monotonic-reads, and bounded-staleness are
the consistency levels you'd reach for to tame that window. None of this is in
buffr because there's one node — but the moment a second appears, the
consistency model becomes an application concern, which is why this lives at the
seam between this guide and `study-distributed-systems` / `study-system-design`.

---

## Interview defense

**Q: buffr is single-node. If you added a read replica tomorrow, what breaks
first?**

> Memory recall. After each turn `session.ts` writes a memory chunk via
> `memory.remember()`, and the next turn's `search()` may recall it. On one node
> that's immediate. Route that `search()` to a lagging replica and the chunk
> might not be replayed yet — the agent forgets the exchange it just had.
> Index-then-query has the same exposure: chunks committed on the primary, read
> from a replica before replay, missing. The code has no read/write routing
> because it doesn't need it yet — adding a replica is an application change, not
> a config flip.

```
  write memory → PRIMARY ──lag──► REPLICA ◄── next search()
  read beats replay → memory missing → "forgot the last turn"
```

> Anchor: the read-your-writes paths — memory recall and index-then-query — are
> what replication lag breaks first.

**Q: How do you keep read-your-writes once you have a replica?**

> Two options. Keep all reads on the primary — simplest, preserves
> read-your-writes, but you get no read-scaling. Or route reads to the replica
> for paths that tolerate staleness and pin the consistency-critical ones
> (memory recall, post-index queries) to the primary. Either way the decision
> lives in the application's read routing, which buffr doesn't have today because
> there's nowhere else to route to.

```
  consistency-critical reads → PRIMARY (read-your-writes)
  staleness-tolerant reads    → REPLICA (scale)
```

> Anchor: read-your-writes is an application routing decision once there's more
> than one node.

---

## See also

- `07-wal-durability-and-recovery.md` — the WAL that replication ships.
- `06-locks-mvcc-and-concurrency-control.md` — the pool that has no failover
  target today.
- `study-distributed-systems` — consistency models, CAP, lag tolerance in depth.
- `study-system-design` — the single-device scope decision and when it changes.
