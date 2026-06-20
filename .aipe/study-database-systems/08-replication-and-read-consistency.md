# Replication and Read Consistency

**Industry name(s):** streaming replication / read replicas / replication lag · **Type:** Industry standard

---

## Zoom out, then zoom in

buffr has one Postgres process. No standby, no replica, no failover. There is nothing to lag, no stale-read window, no failover to handle. This file is the shortest in the guide on purpose: it names what's `not yet exercised`, teaches the mechanism so you'd recognize when it becomes relevant, and draws the exact line where a second node would change buffr's consistency story.

```
  Zoom out — what isn't here

  ┌─ Persistence ───────────────────────────────────────────────┐
  │  one pg.Pool → one Postgres → one copy of the data           │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌─ Storage engine ─────────▼──────────────────────────────────┐
  │  single primary · NO replica · NO standby · NO failover      │ ← we are here
  │  every read and write hits the SAME node → always consistent  │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: replication is copying one database's writes to other nodes so reads can scale or survive a node loss. buffr does none of it — and for a single-device laptop agent, that's correct, not a gap to apologize for. The verdict: **read-your-writes is trivially guaranteed because there's exactly one node.** The whole interest here is the *boundary* — what changes the day a second device reads `reindb`.

---

## The structure pass

There's one node, so the usual replication axes collapse. Trace the axis anyway — *where could a read see stale data?* — to show why the answer is "nowhere, yet."

```
  Axis = "can a read return data older than my last write?"

  ┌─ buffr today (single node) ──────────────────────────────────┐
  │  write → primary → read ← same primary                       │  → NO stale read
  │  read-your-writes guaranteed by topology                     │     (one copy)
  └──────────────────────────────────────────────────────────────┘
  ┌─ buffr + a read replica (hypothetical) ─────────────────────┐
  │  write → primary ──async WAL──► replica ← read              │  → STALE possible
  │  replica lags the primary by some ms                        │     during lag
  └──────────────────────────────────────────────────────────────┘
       the seam that doesn't exist yet: primary↔replica
```

The seam — primary↔replica — is the boundary where read consistency *would* flip from "always fresh" to "possibly stale." buffr has no such seam. **That's the entire finding: the consistency question is answered by topology, and the topology has one node.**

---

## How it works

### Move 1 — the mental model

You know how the WAL (`07`) is an append-only log of every change? Streaming replication is just *shipping that log to another node and replaying it there*. The replica is a second Postgres continuously replaying the primary's WAL, so it converges toward the primary's state — a few milliseconds behind.

```
  The pattern — replication is WAL replay on a second node

  ┌─ primary ──────┐   stream WAL records   ┌─ replica ──────┐
  │ writes here    │ ─────────────────────► │ replays WAL    │
  │ WAL: …A,B,C    │   (async by default)   │ WAL: …A,B  ◄── │ lags by C
  └────────────────┘                        └────────────────┘
       reads here always fresh               reads here can be STALE (missing C)
```

One sentence: **a replica replays the primary's WAL stream, so it's a near-copy that trails by the replication lag.**

### Move 2 — what lag costs (the mechanism buffr would inherit)

**Async replication means the primary doesn't wait.** By default (and what a managed Postgres read replica gives you) the primary acks your commit *before* the replica has the change. So a read routed to the replica immediately after a write can miss it. Bridge: it's the same hazard as reading from a cache right after writing the source — the cache hasn't caught up.

```
  The read-your-writes trap on a replica

  t0: write C to primary  → commit acked
  t1: read from replica   → replica still at B → returns OLD data  ◄ stale
  t2: replica replays C    → now consistent
       │
       └─ the window t0→t2 is replication lag. Routing reads to a replica
          without handling this window breaks read-your-writes.
```

**Failover is the other reason replicas exist.** If the primary dies, a replica gets promoted. With async replication, any commits not yet shipped are lost on promotion — the durability gap from `07` reappears as a *replication* gap. Synchronous replication closes it (primary waits for the replica's ack) at the cost of write latency.

**None of this is in buffr.** No replica means no lag, no stale reads, no failover, no promotion data loss. The mechanism is taught so you recognize the day it arrives.

### Move 2.5 — current vs the line where this matters

```
  Replication — current vs the trigger that introduces it

  CURRENT: single node
   ├─ read-your-writes: guaranteed by topology
   ├─ consistency: strong (one copy)
   └─ failover: N/A

  TRIGGER (what introduces a replica):
   ├─ a SECOND device reads reindb        → now there's a remote reader
   ├─ buffr graduates off "laptop-only"   → the parent agent-layer vision
   └─ then: route reads to replica? → inherit lag + stale-read handling
```

The context doc describes buffr as the "laptop brain" that *graduates* an in-memory pipeline to persistent Postgres, single-device — and `agent-layer-plan.md` is the parent multi-surface vision. **The moment a phone or a second laptop reads the same `reindb`, this file stops being `not yet exercised`.** Until then, every read hits the one primary and is strongly consistent for free.

### Move 3 — the principle

Read consistency is a function of topology. One node → strong consistency, no lag, read-your-writes for free. Add a replica and you trade that for read scaling or availability, inheriting lag and stale-read handling. The skill isn't configuring replication — it's recognizing that buffr's single-node topology *gives* it the strongest consistency guarantee at zero cost, and naming the exact trigger (a second reader) that would force the tradeoff.

---

## Primary diagram

The whole replication story — current reality and the hypothetical seam.

```
  buffr read consistency — one node now, the seam that's absent

  NOW (single primary):
  ┌─ pg.Pool ─┐  write+read  ┌─ Postgres primary ─┐
  │           │ ───────────► │ one copy of reindb  │  → strong consistency
  └───────────┘              └─────────────────────┘     read-your-writes free

  IF a replica were added (NOT in repo):
  ┌─ pg.Pool ─┐  writes  ┌─ primary ─┐ ─async WAL─► ┌─ replica ─┐
  │           │ ───────► │           │              │ trails by │
  │           │  reads?  │           │              │ lag       │ ← stale reads
  └───────────┘ ────────►└───────────┘              └───────────┘   possible here

  replica · streaming replication · lag · failover · synchronous_commit
  for replicas: ALL not yet exercised
```

---

## Implementation in codebase

**Use cases.** There is no replication code to walk — that's the point. The evidence is the *single* pool pointing at a *single* `DATABASE_URL`, with no replica URL, no read/write split, no failover client config anywhere.

```
  src/db.ts  (lines 4–6)  — one connection target, no replica

  export function createPool(databaseUrl: string): pg.Pool {
    return new pg.Pool({ connectionString: databaseUrl });
  }
       │
       └─ ONE connection string. No primary/replica split, no read-replica
          host, no failover list. Every read and write resolves to the same
          node — which is exactly why read-your-writes is free.
```

```
  src/config.ts  (lines 11–16)  — one DATABASE_URL, full stop

  return {
    databaseUrl: env.DATABASE_URL || undefined,   ← single URL, no REPLICA_URL
    appId: …, schema: …, ollamaHost: …,
  };
       │
       └─ config exposes exactly one database URL. There's no second env var
          for a replica, confirming single-node by configuration.
```

Every read path (`search`, `loadProfile`) and every write path (`upsert`, `persistMessage`) uses this one pool against this one URL. Replication, read replicas, failover, replication lag, synchronous replication: all `not yet exercised`.

---

## Elaborate

Postgres streaming replication ships WAL — which is why `07` (WAL) is the prerequisite for this file. Everything a replica knows, it learned by replaying the primary's WAL. That's also why the consistency models line up: a synchronous replica (primary waits for its ack) gives you no data loss on failover but adds write latency; an async replica gives you fast writes but a lag window where reads are stale and a promotion can lose the un-shipped tail. The CAP-flavored tradeoff — consistency vs availability vs latency — only becomes a *decision* when there's more than one node to be inconsistent across.

For buffr specifically, the most likely first replica isn't for scale (a laptop doesn't need read scaling) — it's for *sync to a second device*, which is the parent `agent-layer-plan.md` vision. That's a different shape from a classic read replica: it's closer to the canonical-local-with-cloud-mirror pattern you shipped in buffr's React Native sibling and in dryrun. When it arrives, the question won't be "route reads to the replica" — it'll be "which device is canonical and how do conflicting writes merge." Cross-link `study-system-design` for that multi-device topology; cross-link `07` for the WAL the replica would replay.

---

## Interview defense

**Q: How does this system handle replication lag and stale reads?**

It doesn't need to — single node. One Postgres, one pool, one `DATABASE_URL`. Every read hits the same node that took the write, so read-your-writes is guaranteed by topology and there's no lag window. Adding a read replica is what would introduce stale reads, and buffr has none.

```
  one node → write and read hit the same copy → no stale window
```

Anchor: *"Single-node topology gives strong consistency for free — there's no replica to lag."*

**Q: When would you add a replica, and what would it cost you?**

The trigger is a second device reading `reindb` — the parent multi-surface vision. The cost: an async replica introduces a lag window where reads can miss a just-committed write, and a failover can lose un-shipped commits. For buffr that'd more likely be a device-sync problem (which copy is canonical) than a read-scaling one.

Anchor: *"A second reader introduces the replica; with it comes lag and a failover data-loss tail — trade strong consistency for availability only when you must."*

---

## Validate

1. **Reconstruct:** Draw the primary→replica WAL stream and mark the lag window where a read goes stale.
2. **Explain:** Why does buffr's single `DATABASE_URL` (`src/config.ts:12`) guarantee read-your-writes with no extra code?
3. **Apply:** A second device starts reading `reindb` via an async replica. What's the first consistency bug a user would hit, and when?
4. **Defend:** Argue why buffr correctly has *zero* replication today, and name the exact trigger that changes the answer.

---

## See also

- `07-wal-durability-and-recovery.md` — the WAL a replica would replay
- `01-database-systems-map.md` — the single-node topology this file confirms
- `study-system-design` — the multi-device topology where replication becomes a decision
- `study-distributed-systems` — consistency across nodes once there's more than one
