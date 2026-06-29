# Client-Timestamp Ordering

**Industry names:** event-time vs ingestion-time · client-assigned ordering ·
logical timestamp ordering. **Type:** Language-agnostic (a general distributed-
systems pattern, applied here to async DB writes).

---

## Zoom out, then zoom in

You know how `Promise.all([a, b, c])` makes no promise about which finishes
first? That's the whole problem this pattern solves. The trace sink fires its
inserts concurrently, so the order they *land* in Postgres is a race. If
`created_at` defaulted to `now()`, the row timestamps would reflect that race —
and replaying the trajectory would show events out of order. The fix: let the
*event* carry its own timestamp, assigned at emit time, and order by that.

Where it sits:

```
  Zoom out — where ordering is decided

  ┌─ Agent loop (aptkit) ─────────────────────────────────────┐
  │  timestamp() called at emit time → event.timestamp        │ ← order assigned HERE
  └──────────────────────────┬─────────────────────────────────┘
                             │  emit(event)  (in causal order)
  ┌─ Trace sink ────────────▼─────────────────────────────────┐
  │  persistMessage(..., { createdAt: event.timestamp })       │
  │  inserts fire CONCURRENTLY → completion order is a race    │
  └──────────────────────────┬─────────────────────────────────┘
                             │  insert ... created_at = coalesce($8, now())
  ┌─ Storage (Postgres) ════▼═════════════════════════════════┐
  │ ║ ★ created_at = the EVENT time, not the INSERT time ★    ║│ ← we are here
  │ ║ select ... order by created_at = replay in emit order   ║│
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **event-time ordering** — separate *when something
happened* (event time, assigned by the producer) from *when it was recorded*
(ingestion time, when the insert lands). Order by the former, never the latter.
The question it answers: *can I trust that replaying the trajectory shows what
actually happened, in the order it happened?*

## Structure pass

Two layers, one axis: **which clock decides order?** Trace it across the seam and
watch the answer flip.

```
  Axis — "which clock orders the rows?" — across the write seam

  ┌─ emit side (producer) ──────┐   seam: the SQL insert   ┌─ store side ──────┐
  │  event.timestamp            │ ════════╪══════════════► │  created_at column│
  │  = emit-time clock          │   (it flips if you let   │                   │
  │  monotonic-ish, causal      │    now() win)            │  now() = insert-  │
  └─────────────────────────────┘                          │  time clock, racy │
                                                           └───────────────────┘
  with coalesce($8, now()): producer clock wins when present → causal order kept
  without it (plain now()):  store clock wins → order = insert race
```

The seam is the `insert` statement, and the `coalesce` is the load-bearing
decision *at* that seam: it says "use the event's clock if I gave you one,
otherwise fall back to the store's clock." That single `coalesce` is what keeps
the producer's causal order from being overwritten by the ingestion race.

The residual edge — where even the event clock isn't enough — is millisecond
resolution. Hold that for Move 2.5.

## How it works

### Move 1 — the mental model

Think of two stamps on a package: the date the sender wrote on it (event time)
and the date the post office scanned it on arrival (ingestion time). If packages
travel at different speeds, the *scan* order can differ from the *send* order —
so to reconstruct what the sender did, you read the sender's date, not the scan.
Same here: the loop is the sender, the insert is the scan.

```
  The pattern — order by event time, not ingestion time

  EVENT TIME (assigned at emit, causal):   t1 ─ t2 ─ t3 ─ t4
                                            │    │    │    │
  inserts fire concurrently, land in        ▼    ▼    ▼    ▼
  whatever order they finish (a race):     t3   t1   t4   t2   ← ingestion order
                                            │    │    │    │
  but created_at carries EVENT time, so:   order by created_at
                                            └─► t1 ─ t2 ─ t3 ─ t4  ← causal order back
```

The kernel: **the producer assigns the timestamp, the store preserves it, the
reader orders by it.** Remove any of the three and ordering falls back to the
insert race.

### Move 2 — the step-by-step walkthrough

**The use case.** Replaying any conversation for debugging: `select * from
agents.messages where conversation_id = $1 order by created_at`. You need this to
read in the order the agent actually did things.

**Part 1 — the producer assigns the timestamp at emit time.** Every
`CapabilityEvent` carries a `timestamp` field, set by aptkit's `timestamp()`
helper *when the event is created*, inline in the loop — not when it's written.

```ts
// aptkit run-agent-loop.js — timestamp captured at emit, in causal order
trace?.emit({ type: 'step', capabilityId, role: 'assistant',
              content: text, timestamp: timestamp() });   // ← t assigned HERE
```

The sink reads that field and passes it straight through as `createdAt`:

```ts
// src/supabase-trace-sink.ts:54-59
const at = event.timestamp;                 // the producer's clock
// ...
this.push(persistMessage(pool, conversationId, event.role, event.content,
          { createdAt: at }));              // carried into the row
```

Boundary condition: if `event.timestamp` were missing or empty, you'd silently
fall back to ingestion time — which is exactly what Part 3's `coalesce` guards.

**Part 2 — the store preserves it, with a fallback.** The insert is where event
time and ingestion time meet, and the `coalesce` decides the winner:

```ts
// src/supabase-trace-sink.ts:26, 27-36
const createdAt = extra?.createdAt && extra.createdAt.length > 0 ? extra.createdAt : null;
await pool.query(
  `insert into agents.messages
     (conversation_id, role, content, tool_calls, tool_results, model, tokens_used, created_at)
   values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))`,
  //                                  └─────────────┬──────────────┘
  //              event time if present ($8), else ingestion time (now())
  [ conversationId, role, content, /* ... */, createdAt ],
);
```

Read the `coalesce($8::timestamptz, now())` carefully — it's the entire pattern in
one expression. `$8` is the event timestamp (or `null`). If present, the row's
`created_at` is the *event* time. If `null`, it's `now()` — the *insert* time. So:
the producer clock wins when it exists; the store clock is only a fallback. The
schema default (`created_at timestamptz not null default now()`,
`sql/001_agents_schema.sql:49`) is the same fallback at the column level.

**Part 3 — the reader orders by it.** No special code — any debug query that says
`order by created_at` now replays in emit order, immune to the insert race.

```
  Layers-and-hops — the clock travels from loop to query

  ┌─ Loop ───────┐ event.timestamp  ┌─ Sink ────────┐ createdAt=$8 ┌─ Postgres ─────┐
  │ timestamp()  │ ───────────────► │ pass-through  │ ───────────► │ created_at =   │
  │ at emit      │   (event time)   │ no rewrite    │  coalesce    │ event time     │
  └──────────────┘                  └───────────────┘              └───────┬────────┘
                                                                           │ order by created_at
                                                                           ▼
                                                              replay in emit/causal order
```

#### Move 2.5 — the residual edge: the same-millisecond tie

This is the honest limit, and it's the audit's #2 blind spot. `created_at` is a
`timestamptz` — millisecond resolution. There is **no monotonic sequence column**
to break ties (`sql/001_agents_schema.sql:40-50` — no `seq`). So:

```
  Two events, same millisecond → tie → order undefined

  emit order:    e1 (12:00:00.123)   e2 (12:00:00.123)   ← same ms!
                          │                   │
  order by created_at:    └──── tie ──────────┘
                          Postgres returns them in ANY order
                          (no second sort key to break the tie)
```

What breaks: two events emitted inside the same millisecond can replay in either
order. On this single-device, sequential flow the loop emits events with real
work between them, so a true same-ms tie is rare — but it's not impossible, and
it's a real correctness gap in principle. The fix is a tiebreaker: add a
monotonically increasing `seq` (a per-conversation counter, or a `bigserial`) and
`order by created_at, seq`. That's the standard event-sourcing move — a logical
sequence number layered under the wall-clock timestamp. study-distributed-systems
owns the general version of this (Lamport clocks, sequence numbers); here it's the
one missing tiebreaker.

#### Move 3 — the principle

Never order durable events by when they were *written*. Writes race;
assign order at the source and carry it through. The moment your writes are
concurrent — `Promise.all`, a worker pool, a queue — ingestion time stops
matching event time, and only a producer-assigned clock tells the truth. And
once you commit to that, finish the job: wall-clock resolution always ties
eventually, so pair the timestamp with a sequence number for the events that land
in the same tick.

## Primary diagram

The full ordering story in one frame.

```
  Client-timestamp ordering — event time beats the insert race

  ┌─ Producer (aptkit loop) ──────────────────────────────────────────┐
  │  emits e1,e2,e3,e4 in causal order, each timestamp()'d at emit     │
  │     e1.ts=t1   e2.ts=t2   e3.ts=t3   e4.ts=t4                       │
  └───────────────────────────────┬───────────────────────────────────┘
              emit() sync → push insert → pending[]  (concurrent)
  ┌─ SupabaseTraceSink ───────────▼───────────────────────────────────┐
  │  createdAt = event.timestamp (non-empty) else null                 │
  │  insert ... created_at = coalesce($8::timestamptz, now())          │
  │  inserts COMPLETE in race order: e3,e1,e4,e2  ← does NOT matter     │
  └───────────────────────────────┬───────────────────────────────────┘
  ┌─ agents.messages ─────────────▼───────────────────────────────────┐
  │  created_at holds EVENT time → select order by created_at = t1..t4 │
  │  EDGE: t2==t3 to the ms → tie, no seq column → order undefined     │
  │  FIX:  add seq, order by created_at, seq                           │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the event-time vs processing-time distinction that stream processors
(Flink, Kafka Streams) make load-bearing, shrunk to one agent run and one table.
The general rule: in any system where records are written concurrently or
out-of-band, the write timestamp is meaningless for ordering — you assign a
logical or event-time order at the source. The same-millisecond tie is why
production event stores pair a timestamp with a sequence number; wall clocks have
finite resolution and clocks aren't even monotonic across machines.

Connects to: `01-full-signal-trajectory-capture.md` (this ordering is what makes
*that* file's replay trustworthy — the two are a pair), and study-distributed-
systems for the general ordering-under-concurrency problem (logical clocks,
sequence numbers, why wall-clock alone is never enough).

## Interview defense

**Q: Why does `created_at` come from the event instead of `now()`?** Because the
inserts fire concurrently — `emit()` queues them and `flush()` awaits them all
with `Promise.all`, so completion order is a race. If `created_at` were `now()`,
the row timestamps would reflect that race and the trajectory would replay out of
order. Assigning the timestamp at emit time, in the loop, captures *event time*;
ordering by it survives the insert race.

```
  emit order ≠ insert-completion order  →  order by EVENT time, not now()
```

**Q: What's the failure mode that survives even this?** A same-millisecond tie.
`created_at` is millisecond `timestamptz` and there's no sequence column, so two
events in the same millisecond have undefined relative order. Rare on a sequential
single-device flow, real in principle. The fix is a monotonic `seq` and
`order by created_at, seq` — the standard sequence-number tiebreaker under the
wall clock. Naming that the timestamp alone isn't enough is the signal that I've
actually reasoned about ordering, not just set a column.

```
  created_at (ms)  ── ties ──►  + seq (monotonic)  ──►  total order
```

**Q: Why the `coalesce`?** It makes event time the default and ingestion time the
fallback in one expression: `coalesce($8::timestamptz, now())`. If the producer
gave a timestamp, use it; if not, don't drop the row — fall back to `now()`. It's
graceful degradation: worst case you lose causal ordering for one event, you never
lose the row.

## See also

- `01-full-signal-trajectory-capture.md` — the trajectory this ordering makes
  replayable; the two files are a pair.
- `audit.md` lens 5 (traces / lifecycles) and red-flag #2 (the ms tie).
- Cross-guide: study-distributed-systems (logical clocks, sequence numbers,
  ordering under concurrency — the general form of this file's edge).
