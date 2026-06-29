# Trace-Sink Write Buffering

**Industry names:** async write buffering · deferred flush · timestamp-decided ordering (ordering at write-time, not commit-time). **Type:** Project-specific (a common shape, this repo's specific resolution).

## Zoom out, then zoom in

This is the most interesting correctness fact in `buffr-laptop`, and it's subtle enough to get wrong in an interview. The trace sink captures the agent's whole trajectory — every step, tool call, token-usage event — and writes it to `agents.messages`. The writes are **buffered and flushed concurrently**, so they hit the database in a **nondeterministic order**. Yet trajectory *replay* comes back in the right order anyway. The trick is that ordering is decided at **emit time** via `created_at`, not by the flush race. Here's where it sits.

```
  Zoom out — where the trace sink buffers writes

  ┌─ Process layer ──────────────────────────────────────────────┐
  │  RagQueryAgent.answer()  (aptkit)                             │
  │      │ emits CapabilityEvents (step, tool_call_*, usage, ...) │
  │      ▼                                                        │
  │  ★ SupabaseTraceSink ★   ← THIS CONCEPT                       │ ← we are here
  │     emit() → push promise onto pending[]                      │
  │     flush() → Promise.all(pending)   (unordered race)         │
  └──────────────────────────┼────────────────────────────────────┘
                             │  N concurrent INSERTs over the pool
                             ▼
  ┌─ Storage layer ──────────────────────────────────────────────┐
  │  agents.messages  —  created_at carries the emit-time order   │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **buffer-then-flush with the ordering key captured up front.** The question it answers is the classic concurrency one — *"if N writes race to the database, how do I still reconstruct the order they happened in?"* The repo's answer: don't rely on insertion order at all; stamp each event with `event.timestamp` when it's emitted, sort by that on read. The race becomes irrelevant.

## The structure pass

**Layers.** Three: the agent (emits events, fast, synchronous), the sink (buffers, then flushes), Postgres (stores rows). The sink is the joint.

**The axis: guarantees — what's promised vs best-effort, and *what determines order*.** Trace "who decides the order events appear in on replay?" down the stack.

```
  One axis — "who decides replay order?" — traced down the layers

  ┌─ agent (emit) ─────────────┐   → the AGENT decides:
  │ emits e1,e2,e3 in sequence │     event.timestamp stamped here
  └───────────┬────────────────┘
              │  seam: ordering key is already fixed
  ┌─ sink (flush) ────────────▼┐   → the RACE decides INSERT order
  │ Promise.all → e2,e1,e3 land │     (nondeterministic!) ...
  │ in whatever order finishes  │     ...but it DOESN'T decide replay order
  └───────────┬────────────────┘
              ▼
  ┌─ Postgres (read) ──────────┐   → created_at decides:
  │ ORDER BY created_at → e1,e2,e3│   replay = emit order, race ignored
  └────────────────────────────┘
```

**The seam that matters is between emit and flush — and the key insight is that the ordering decision happens *above* it, not at it.** If you traced only "insert order," you'd see nondeterminism and conclude the trajectory is corrupt. Trace "replay order" and you see it's sound, because the decision was made one layer up. That altitude flip is the whole lesson: **the race is real, and it doesn't matter, because order was decided before the race started.**

## How it works

### Move 1 — the mental model

You've written this shape without naming it: a function that can't `await` (a sync callback, an event handler) but needs to do async work, so it **fires the promise and stashes it**, then something later awaits the batch. `Array.prototype.forEach` with an async callback bites people for exactly this reason — the callbacks all start, none are awaited. The trace sink does it *on purpose*: `emit()` must be synchronous (aptkit's `CapabilityTraceSink` contract), so it pushes the write-promise into an array and `flush()` awaits them all after the agent run finishes.

```
  The pattern — buffer on emit, flush after the run

  emit(e1) ─► push P1 ─┐
  emit(e2) ─► push P2 ─┤  pending = [P1, P2, P3]   (sync, no await)
  emit(e3) ─► push P3 ─┘
        │
        ▼  (agent run ends)
  flush() ─► Promise.all(pending)   ← P2 may resolve before P1
        │                              INSERT order is a RACE
        ▼
  on read: ORDER BY created_at       ← order restored from emit-time stamp
```

The kernel has three parts. Name each by **what breaks if it's missing:**

- **The `pending` buffer** — drop it and `emit()` would have to `await`, violating the sync contract; the agent loop couldn't emit.
- **The `flush()` join** — drop it and the process could exit (or the next turn start) with writes still in flight, losing trajectory rows.
- **The `created_at = event.timestamp` stamp** — drop it (fall back to `now()` at insert time) and replay order becomes the **race order**, which is nondeterministic. This is the load-bearing part everyone forgets.

Everything else — the jsonb stringify, the per-event-type switch — is incidental detail, not skeleton.

### Move 2 — the step-by-step walkthrough

**`emit()` is synchronous and just enqueues.** This is the contract constraint that forces the whole pattern:

```ts
// src/supabase-trace-sink.ts:53
emit(event: CapabilityEvent): void {        // ← returns void, CANNOT await
  const { pool, conversationId } = this.opts;
  const at = event.timestamp;               // ← the ordering key, captured NOW
  switch (event.type) {
    case 'step':
      if (event.content) {
        this.push(persistMessage(pool, conversationId, event.role, event.content, { createdAt: at }));
        //         └─ persistMessage returns a Promise; push() stashes it, no await
      }
      return;
    // ... tool_call_start, tool_call_end, model_usage, warning, error — same shape
  }
}
```

The two lines that matter: `const at = event.timestamp` grabs the emit-time clock reading, and `this.push(persistMessage(...))` fires the insert and stows the promise without awaiting. `emit` returns `void` — it has to, that's aptkit's contract — so it physically cannot wait for the write.

**`push()` is the buffer.** One line, and it's the queue:

```ts
// src/supabase-trace-sink.ts:87
private push(p: Promise<void>): void {
  this.pending.push(p);                     // ← in-memory, in-process, unbounded for one run
}
```

This is the "queue" lens 6 of the audit calls thin: it's a `Promise<void>[]`, not a durable queue. No ack, no redelivery, no backpressure. Crash before flush, the buffered writes vanish. For a single turn's handful of events that's an acceptable durability tradeoff — the trajectory is observability data, not a ledger.

**`flush()` joins — and this is where the race lives:**

```ts
// src/supabase-trace-sink.ts:91
async flush(): Promise<void> {
  await Promise.all(this.pending);          // ← waits for ALL, in NO particular order
}
```

`Promise.all` waits for every promise to settle but imposes **no ordering** on when each insert commits. P2's `INSERT` round-trip may finish before P1's. So the *physical row order* in `agents.messages` — if you sorted by some hidden insertion sequence — would be nondeterministic across runs.

**The resolution — `created_at` carries the order, set in `persistMessage`:**

```ts
// src/supabase-trace-sink.ts:26
const createdAt = extra?.createdAt && extra.createdAt.length > 0 ? extra.createdAt : null;
await pool.query(
  `insert into agents.messages (..., created_at)
   values ($1, ..., coalesce($8::timestamptz, now()))`,   // ← emit-time stamp, or now() fallback
  [ /* ... */ createdAt ],
);
```

`coalesce($8::timestamptz, now())` is the hinge. When `createdAt` is the event's emit-time timestamp, *that* becomes the row's `created_at` — not the moment the insert happened to win the race. Replay reads `ORDER BY created_at` and gets emit order back. The race is defused not by serializing the writes (which would be slower and pointless) but by **deciding the order before the race begins.**

```
  Execution trace — three events, raced inserts, correct replay

  emit order:   e1 (t=100ms)   e2 (t=110ms)   e3 (t=120ms)
  pending:      [P1,            P2,             P3]
  flush race:   P2 commits 1st, P3 commits 2nd, P1 commits 3rd   ← nondeterministic
  rows' created_at:  P1=100, P2=110, P3=120     ← set at EMIT, not at commit
  read ORDER BY created_at:  e1(100), e2(110), e3(120)   ← emit order restored ✓
```

### Move 2.5 — current state vs future state (where this breaks)

This is sound **today** and breaks under **one specific future change**, so it earns the Phase-A/Phase-B treatment.

```
  Phase A (now): one device, one clock        Phase B (deferred): two writers, two clocks

  laptop emits e1,e2,e3                        laptop emits eL  (clock = T)
  all created_at from ONE clock                phone  emits eP  (clock = T - 400ms skew)
  → monotonic, comparable                      both write SAME agents.messages conversation
  → ORDER BY created_at = truth                → ORDER BY created_at interleaves WRONG:
                                                 eP sorts before eL even if eL happened first
  fix needed:  none                            fix needed: logical clock (Lamport/hybrid)
                                                            or server-assigned sequence
```

The takeaway is *what wouldn't have to change*: the buffer, the flush, the sink interface all stay. Only the **ordering key** would have to graduate from wall-clock `created_at` to something skew-proof. That's the one-way-door decision named in `audit.md` lens 7 and revisited in `03-deferred-two-brain-shared-memory.md`. Worth writing down now precisely because it's invisible while there's only one clock.

### Move 3 — the principle

When concurrent writes race to storage, you have two ways to recover their order: **serialize the writes** (slow, often needless) or **capture the ordering key before the race and sort on read** (fast, what this repo does). The second is almost always right — *until your "ordering key" is a wall clock and you grow a second clock.* The principle: a timestamp is a perfectly good ordering key right up to the moment two clocks generate it, at which point it silently lies. One writer, one clock, `created_at` is truth; two writers, you need a logical clock.

## Primary diagram

The whole mechanism in one frame — buffer, raced flush, order restored on read.

```
  Trace-sink write buffering — full recap

  ┌─ Process layer ──────────────────────────────────────────────────┐
  │  agent.answer() emits CapabilityEvents (timestamp stamped on each)│
  │         │                                                         │
  │   emit(event)  src/supabase-trace-sink.ts:53                      │
  │     at = event.timestamp        ← ordering key captured at EMIT   │
  │     push(persistMessage(...,{createdAt:at}))  → pending[]  (:87)  │
  │         │                                                         │
  │   flush()  (:91)  await Promise.all(pending)                      │
  │         │   ← inserts commit in a RACE (no ordering)              │
  └─────────┼─────────────────────────────────────────────────────────┘
            │  N concurrent INSERTs over pg.Pool
            ▼
  ┌─ Storage layer ──────────────────────────────────────────────────┐
  │  agents.messages                                                  │
  │    created_at = coalesce(emit_timestamp, now())   (:30)           │
  │    REPLAY: ORDER BY created_at  → emit order, race irrelevant     │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

The buffer-then-flush shape comes straight from the constraint that `emit` is synchronous — aptkit defined `CapabilityTraceSink.emit` as `(event) => void` so the agent loop never blocks on I/O. Anything that has to do async work inside a sync callback ends up with this exact pattern: fire the promise, collect it, await the batch at a join point. You've hit it in the browser too (a click handler that kicks off a `fetch` but can't await it).

The deeper idea — **decide order at write time, not commit time** — is the same insight behind event-sourcing's sequence numbers and Kafka's per-partition offsets: the order is a property of the *event*, assigned when it's produced, not an accident of when storage got around to it. The repo does the cheap single-device version of that with a wall-clock timestamp. The expensive distributed version (logical clocks) is what Phase B would need, and naming the gap now is the whole point of capturing trajectories early (`agent-layer-plan.md`'s trajectory-capture thesis).

This same sink is also an **observability** artifact — full-signal trajectory capture, every event type persisted. That angle (what it lets you *see*, debugging a bad agent run) belongs to `study-debugging-observability/`. This file owns the **ordering** angle only.

## Interview defense

**Q: "You buffer trace writes and flush them with `Promise.all`. Doesn't that mean the rows land out of order?"**

> The inserts do land out of order — `Promise.all` (`src/supabase-trace-sink.ts:92`) imposes no ordering, so whichever round-trip wins, commits first. But replay order is correct anyway, because I don't rely on insertion order at all. Each event's `created_at` is stamped from `event.timestamp` at emit time (`:55`, coalesced at `:30`), and replay reads `ORDER BY created_at`. The race is real and irrelevant — order was decided before the race started.

```
  insert order:  P2, P3, P1   ← race (nondeterministic)
  created_at:    e1<e2<e3      ← stamped at emit, one clock
  read order:    e1, e2, e3    ← correct
```

> The part most people miss — and the part that proves you've thought about it distributed-ly: **this is only sound because there's one clock.** Add a second writer (the deferred phone brain) writing the same conversation, and wall-clock `created_at` ordering breaks on clock skew — a phone message stamped 400ms slow sorts ahead of a laptop message that actually came first. The fix then is a logical clock or a server-assigned sequence, not `now()`. That's the one distributed-systems hazard this design quietly sidesteps by having a single writer.

**Anchor:** *"Order decided at emit via created_at, not by the flush race — sound on one clock, needs a logical clock the moment there's a second writer."*

## See also

- `01-app-to-postgres-boundary.md` — the seam these buffered writes cross.
- `03-deferred-two-brain-shared-memory.md` — the second writer that breaks single-clock ordering.
- `audit.md` — lens 6 (queues/ordering) and lens 7 (clocks); the clock-skew red flag (Rank 2).
- `study-debugging-observability/` — the same sink as a trajectory/evidence artifact.
- `study-system-design/03-trajectory-capture.md` — the architectural reason every event is captured.
