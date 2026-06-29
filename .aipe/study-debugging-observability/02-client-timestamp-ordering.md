# Client-Timestamp Ordering

**Industry name(s):** client-side / application-assigned timestamps for event ordering, "logical timestamp at the source" — *Industry-standard* technique, *Project-specific* application.

The trace's deterministic-replay guarantee rests on one decision: the row's `created_at` is the *event's* timestamp, set where the event was emitted, not the server's `now()` set where the row landed. That's what makes replay order match emit order despite a racing parallel flush. It also leaves one residual edge: a same-millisecond tie with no tiebreaker.

---

## Zoom out, then zoom in

Here's the setup. You've hit this exact problem with `Promise.all` before: you fire five `fetch()`es in parallel, they resolve in an unpredictable order, and if you need them ordered you can't trust arrival — you tag each with an index *before* firing. Same move here, with timestamps instead of indices.

```
  Zoom out — where ordering is decided

  ┌─ Session layer (src/session.ts) ────────────────────────────┐
  │  agent.answer() emits events IN ORDER (e0, e1, e2, …)        │
  └────────────────────────────────┬─────────────────────────────┘
            each event carries      │  event.timestamp  ← stamped at SOURCE
            its own timestamp       │
  ┌─ Sink (src/supabase-trace-sink.ts) ───▼─────────────────────┐
  │  emit() queues inserts;  ★ created_at = event.timestamp ★   │ ← we are here
  │  flush() fires them ALL IN PARALLEL (order lost here)        │
  └────────────────────────────────┬─────────────────────────────┘
                                    │  Promise.all — arbitrary arrival
  ┌─ Storage (agents.messages) ────▼────────────────────────────┐
  │  ORDER BY created_at  → recovers emit order, not insert order│
  └──────────────────────────────────────────────────────────────┘
```

Zoom in. The question: *after a parallel flush scrambles insertion order, how does replay recover the order the agent actually ran in?* The pattern is **stamp the timestamp at the source, sort by it at read time**. Buffr writes `created_at` from `event.timestamp` and falls back to server `now()` only when the event has none — and that fallback choice is the seam where the guarantee can break.

## The structure pass

**Layers:** event emission (source of truth for order) → parallel flush (order destroyer) → read-time sort (order recovery).

**Axis — "what determines event order?"** Trace it:

```
  One question down the layers: what determines order?

  ┌──────────────────────────────────────────────┐
  │ emission (aptkit run-agent-loop)              │  → WALL-CLOCK at emit
  │   timestamp() = new Date().toISOString()      │    (ms resolution)
  └───────────────────────┬───────────────────────┘
       seam: flush()       │  ═══ order is DESTROYED here ═══
  ┌───────────────────────▼───────────────────────┐
  │ Promise.all(pending)  (src/…:91)              │  → ARRIVAL (arbitrary)
  │   parallel inserts — whoever's fastest wins    │    ← would corrupt order
  └───────────────────────┬───────────────────────┘
       seam: ORDER BY      │  ═══ order is RECOVERED here ═══
  ┌───────────────────────▼───────────────────────┐
  │ SELECT … ORDER BY created_at                  │  → SOURCE TIMESTAMP
  │   sorts by the stamped value, not arrival      │    (emit order restored)
  └────────────────────────────────────────────────┘
```

**Two seams, and they're the whole story.** At `flush()` the axis flips from emit-order to arrival-order — that's the *threat*. At `ORDER BY created_at` it flips back to source-order — that's the *fix*. The fix only works because the source timestamp rode along on every row. Study both seams together; one without the other is half the pattern.

## How it works

#### Move 1 — the mental model

Think of each event as a numbered ticket. The agent loop hands out tickets in order (`event.timestamp`). The flush is a crowd all rushing the counter at once — they arrive in no particular order. Replay doesn't care who arrived first; it reads the ticket numbers. The catch: the "number" is a wall-clock millisecond, and two people can grab a ticket in the same millisecond.

```
  The shape — source stamp survives the parallel scramble

  emit order:   e0 ──► e1 ──► e2 ──► e3      (truth)
                │t=…001 │t=…002 │t=…002 │t=…004
                ▼       ▼       ▼       ▼
  flush:        ┌─────────────────────────┐
                │  Promise.all — parallel  │  arrival: e2,e0,e3,e1
                └─────────────────────────┘   (scrambled!)
                          │
  ORDER BY created_at:    ▼
                e0 ──► e1 ?? e2 ──► e3
                          ▲
                   t=…002 == t=…002  ← TIE: no tiebreaker
                   e1 vs e2 order is arbitrary within the ms
```

The mechanism recovers order perfectly *except* inside a shared millisecond. That's the one honest crack.

#### Move 2 — the step-by-step walkthrough

**Where the timestamp is born.** It's not buffr's — aptkit's runtime stamps it. `timestamp()` is `new Date().toISOString()` (aptkit `runtime/dist/src/events.js:2`), called inline at each emit site, e.g. the assistant `step`:

```
  aptkit runtime/dist/src/run-agent-loop.js:51
    trace?.emit({ type: 'step', …, content: text, timestamp: timestamp() });
```

Millisecond resolution, no monotonic counter. This is the root of both the guarantee (it's the *emit* moment, captured at the source) and the limit (two emits in one millisecond get identical strings).

**Where buffr carries it through.** The sink reads `event.timestamp` once and threads it into every `persistMessage` as `createdAt` (`src/supabase-trace-sink.ts:54`, then `:59`, `:64`, `:70`, `:76`, `:82`):

```
  src/supabase-trace-sink.ts:53   emit(event): void {
  :54     const at = event.timestamp;     // read once
  :59       …persistMessage(…, { createdAt: at });   // passed to every case
```

**Where it becomes a column — and the deliberate fallback.** `persistMessage` only uses the event timestamp if it's a non-empty string; otherwise it hands `null` to a `coalesce` that falls back to server `now()` (`src/supabase-trace-sink.ts:26`, `:30`):

```
  src/supabase-trace-sink.ts:26
    const createdAt = extra?.createdAt && extra.createdAt.length > 0
                        ? extra.createdAt : null;
  :30   values (…, coalesce($8::timestamptz, now()))
```

Read the boundary condition carefully. When the event *has* a timestamp, replay order = emit order — clean. When it *doesn't*, the row gets server `now()`, which is the insert moment — and because `flush()` inserts in parallel, that's *arrival* order, the very thing the pattern set out to avoid. So the fallback is a controlled degradation: timestamped events stay ordered; un-timestamped ones fall back to the racy path. Every aptkit event ships a timestamp today, so the fallback is defensive, not active — but it's the line where the guarantee is conditional.

**Where order is recovered.** Any replay sorts by `created_at` (e.g. the reproduction query in `audit.md` lens 2). That's the `ORDER BY` seam. It recovers emit order for every distinct-millisecond pair — and ties on the rest.

#### Move 2 variant — the load-bearing skeleton

The kernel:

1. **A source timestamp on every event** — the order's source of truth. Drop it and you're sorting by arrival, which the parallel flush has already scrambled. (`run-agent-loop.js:51`, carried at `sink.ts:54`)
2. **The timestamp travels with the row** — written to `created_at`, not recomputed at insert. Recompute it and you'd capture insert time = arrival time = scrambled. (`sink.ts:30`)
3. **Read-time sort on that column** — `ORDER BY created_at`. Without it the rows come back in physical/arbitrary order.

What's *missing* from the kernel, and is the residual edge: **a tiebreaker**. A monotonic sequence number per conversation (`seq` 0,1,2,…) emitted alongside the timestamp would make order total. aptkit emits no such counter, so two same-millisecond events have no defined order. For a fast local loop — several events per turn through an in-process agent — same-millisecond emits are reachable, not theoretical.

Optional hardening: the `coalesce(now())` fallback is defensive hardening for the (currently impossible) un-timestamped event — not part of the correctness kernel.

#### Move 3 — the principle

**Order is a property of when an event happened, not when its record arrived** — so stamp it at the source and never let the transport reassign it. The corollary buffr half-implements: if your timestamp resolution can collide, a source timestamp alone gives you *mostly*-ordered, not *totally*-ordered; a tiebreaker (sequence number) is what closes the gap. `study-distributed-systems` owns the deeper theory — this is a single-process echo of the same logical-clock problem.

## Primary diagram

```
  Client-timestamp ordering — threat and fix, end to end

  SOURCE (aptkit run-agent-loop)
    e0 t=…001   e1 t=…002   e2 t=…002   e3 t=…004     ← emit order = truth
       │           │           │           │
       └───────────┴─────┬─────┴───────────┘
                         ▼
  SINK (src/supabase-trace-sink.ts)
    emit(): at = event.timestamp  (:54)
    push(persistMessage(… createdAt: at))   ← stamp rides along
    flush(): Promise.all(pending)  (:91)     ← ✗ ORDER DESTROYED (parallel)
                         │
                         ▼  arrival: e2,e0,e3,e1
  STORAGE (agents.messages)
    created_at = coalesce(event.ts, now())  (:30)
    SELECT … ORDER BY created_at             ← ✓ ORDER RECOVERED
                         │
                         ▼
    e0 ─ {e1,e2 tie} ─ e3    ← total order EXCEPT the same-ms pair
                ▲
         residual edge: no seq tiebreaker
```

## Elaborate

This is the single-machine, low-stakes cousin of a problem distributed systems spend whole papers on: event ordering when you can't trust arrival. In a distributed log you reach for Lamport clocks or hybrid logical clocks precisely because wall-clock timestamps tie and skew. buffr is in-process, so there's no clock skew — but the *tie* half of the problem still shows up because `Date.now()` resolution is coarser than the loop is fast.

The reason buffr chose source-timestamp-into-`created_at` over the simpler "let Postgres set `now()`" is spelled out in the sink comment (`src/supabase-trace-sink.ts:46-48`): the timestamp is persisted "so replay order matches emit order rather than the race between concurrent flush inserts." That's an explicit, correct trade — it accepts the same-millisecond tie in exchange for not depending on insert arrival at all. The fix for the residual (a per-conversation sequence counter) lives upstream in aptkit, which buffr consumes and never edits (`context.md`), so buffr can't close it unilaterally without adding its own counter in the sink.

## Interview defense

**Q: Your flush inserts rows in parallel. How is replay order still correct?**

```
  arrival ≠ order; the stamp is the order

  Promise.all  ──►  rows land in arbitrary physical order
                         │
                    ORDER BY created_at   (created_at = event.timestamp)
                         ▼
                    emit order restored
```

Because order doesn't come from insertion — it comes from `created_at`, which is the *event's* timestamp captured at emit (`sink.ts:54`), not the server's `now()`. The parallel `Promise.all` in `flush()` (`:91`) scrambles which row lands first, but every row carries its own emit-time stamp, so `ORDER BY created_at` recovers the true sequence. **Anchor:** `coalesce($8::timestamptz, now())` at `:30` — event timestamp wins, server time is only the fallback.

**Q: When does that break?**

Same millisecond, no tiebreaker. `timestamp()` is `new Date().toISOString()` — millisecond resolution (`events.js:2`). Two events emitted in the same millisecond get byte-identical `created_at`, and there's no sequence column to break the tie, so their replay order is arbitrary. The fix is a monotonic `seq` per conversation — but that's an aptkit-side emit change, and aptkit is consumed, not edited here. **Anchor:** the missing tiebreaker is the load-bearing part — naming it shows you know source timestamps give *mostly*-ordered, not *totally*-ordered.

## See also

- `01-full-signal-trajectory-capture.md` — the trajectory whose order this guarantees.
- `audit.md` lens 5 (traces) and lens 8 (red-flag rank 2).
- Cross-guide: `study-distributed-systems` (logical clocks, total vs partial order), `study-performance-engineering` (the parallel-flush throughput choice that created the race).
