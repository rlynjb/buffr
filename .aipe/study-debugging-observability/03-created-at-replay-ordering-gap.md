# created_at replay ordering gap

**Industry names:** clock-ordered events / server-timestamp ordering / the
wall-clock replay bug. **Type:** Project-specific instance of a general
distributed-systems hazard.

## Zoom out, then zoom in

You know how if you sort a list of rows by a timestamp column and two rows have the
*same* timestamp, their order is undefined — the database can return them either way?
buffr's trace replay does exactly that, and the timestamps aren't even event time;
they're the moment the row happened to get inserted, by a server clock, after a
concurrent flush. The order you read a conversation back in is not guaranteed to be
the order it happened.

```
  Zoom out — where the ordering is decided

  ┌─ SupabaseTraceSink ──────────────────────────────────────────┐
  │  emit() pushes writes onto pending[]  (in event order)       │
  │  flush() → Promise.all(pending)       (fires CONCURRENTLY)   │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │ N inserts race to the DB
  ┌─ Storage (agents.messages) ▼─────────────────────────────────┐
  │  created_at = now()  set per-insert by the SERVER            │
  │  no explicit sequence column                                 │
  └───────────────────────────┬──────────────────────────────────┘
                              │ read back
  ┌─ Replay (test + any future consumer) ▼───────────────────────┐
  │  select ... order by created_at      ← undefined on ties     │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **wall-clock event ordering with no logical sequence** — the
hazard where you reconstruct causal order from physical insert time, and physical
time isn't a reliable proxy for logical order under concurrency. A scrambled trace is
worse than a missing one: it reads as authoritative and it's wrong.

## Structure pass

**Layers.** Three: the *flush* (decides write concurrency), the *insert* (decides the
timestamp), the *replay* (decides the read order). The bug is an interaction across
all three — no single layer is wrong alone.

**Axis — trace `what guarantees turn order?` down the layers.**

```
  "what guarantees turn order?" — traced down

  ┌──────────────────────────────────────┐
  │ emit(): pushes in true event order   │   → ORDER KNOWN (the pending[] array)
  └──────────────────┬──────────────────┘
        ┌─────────────────────────────────┐
        │ flush(): Promise.all — parallel │   → ORDER LOST (concurrent, no sequencing)
        └─────────────┬───────────────────┘
              ┌──────────────────────────┐
              │ replay: order by created_at│ → ORDER GUESSED (ties undefined)
              └──────────────────────────┘

  the true order is known in pending[] and thrown away at flush()
```

That's the whole bug in one diagram: the correct order *exists* — it's the index of
each write in `pending[]` — and `Promise.all` discards it by firing everything at
once. The seam that fails is `flush → insert`: the array index (logical order) does
not propagate into any column, so the insert has nothing to carry it.

## How it works

### Move 1 — the mental model

The shape is a **lost-sequence race**: an ordered producer feeding a parallel writer
into a store sorted by arrival time.

```
  the lost-sequence race

  pending[]:  [w0]  [w1]  [w2]  [w3]      ← index = true order
                │     │     │     │
  Promise.all fires all four at once
                ▼     ▼     ▼     ▼
  inserts land:  w0   w2   w1   w3        ← arrival ≠ index (race)
  created_at:    t    t    t    t+ε       ← near-identical now()
                └──────────────┬────────┘
  order by created_at  ──►  w0, w2, w1, ... ← scrambled, and "valid" per SQL
```

The kernel that's missing: a monotonic per-conversation sequence number written into
each row, so replay sorts by *intent order*, not *arrival time*. What breaks without
it: replay order is undefined whenever two writes share a `created_at` — which, under
`Promise.all`, is the common case, not the edge case.

### Move 2 — the walkthrough

**Why `Promise.all` loses the order.** The sink queues writes synchronously as events
arrive, so `pending[]` is in true order. But `flush()` does `Promise.all(pending)` —
which starts all the writes concurrently and waits for all to *finish*, with no
ordering between them. The DB sees N inserts arrive interleaved on whatever
connections the pool hands out.

```
  Promise.all — concurrent, unordered

  flush():
    await Promise.all([ insert(w0), insert(w1), insert(w2) ])
                          │           │           │
                          └─ these run in parallel; the DB decides arrival order,
                             not the array order. nothing serializes them.
```

If this were a plain `for...of` with `await` inside — one insert at a time — arrival
order would match `pending[]` order and the bug would mostly disappear (mostly:
`now()` could still tie). The choice of `Promise.all` for throughput is what opens the
race. That's the deliberate tradeoff: parallel writes are faster, and they cost you
ordering.

**Why `created_at = now()` can't save it.** The timestamp is set by the *server* at
insert time, not by the *event* at emit time. Two things break it:

```
  now() is the wrong clock

  event emitted at:   T0, T1, T2     ← the order that matters (dropped, see 02)
  row inserted at:    now(), now(), now()
                       │      │      │
                       └──────┴──────┴── all within microseconds under Promise.all
                          → ties → order by created_at is undefined on ties
```

The event's *own* `timestamp` field — the ISO time of when it actually happened — is
dropped by the sink (that's `02-discarded-trace-signal.md`). Had the sink written
`event.timestamp` into the row and replayed by *that*, this bug largely closes,
because event time reflects emit order regardless of insert race. The two gaps are the
same gap seen twice.

**Why the test bakes it in.** The one trace test reads rows back with `order by
created_at` (`test/supabase-trace-sink.test.ts:31`) and asserts only that an
`assistant` role and a `tool` role *exist* — it never asserts they're in the right
*order*. So the test passes regardless of scramble, and it teaches the wrong replay
query to anyone who copies it. The flawed read path is now the documented one.

### Move 2.5 — current state vs future state

```
  Phase A (now)                       Phase B (the fix)
  ─────────────                       ────────────────
  flush: Promise.all (parallel)       option 1: serial for-await (cheap, slower)
  order key: created_at = now()       option 2: + seq int column, set from
  replay: order by created_at                   pending[] index, replay by seq
  ties → undefined order              option 3: persist event.timestamp (free —
                                                the field is already on the event,
                                                just dropped today; see 02)

  what does NOT change: the event source, the CLI, conversation grouping.
  on one device with one ask at a time, the race window is tiny — but the
  test already replays by the wrong key, so the bug is latent, not theoretical.
```

### Move 3 — the principle

Physical time is not logical order. The moment you reconstruct "what happened in what
sequence" from wall-clock insert timestamps, you've bet that physical time and causal
order agree — and under any concurrency, they don't. The principle: *if order
matters, carry an explicit logical sequence; never infer it from a clock.* The
correct order existed for free (the `pending[]` index) and was thrown away for a
throughput win that one device doesn't need.

## Primary diagram

The full hazard, end to end.

```
  the ordering gap — full path

  ┌─ Sink emit() ────────────────────────────────────────────────────┐
  │  pending = [ w0(user-step), w1(tool), w2(assistant) ]  ← TRUE order│
  └───────────────────────────┬──────────────────────────────────────┘
                              │ flush(): Promise.all  ← order discarded
  ┌─ Postgres (agents.messages) ▼────────────────────────────────────┐
  │  inserts race; created_at = now() for each; no seq column        │
  │  rows land:  w0@t  w2@t  w1@t   (arrival ≠ true order)            │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ select ... order by created_at
  ┌─ Replay ──────────────────▼──────────────────────────────────────┐
  │  returns w0, w2, w1  → assistant appears BEFORE its tool call     │
  │  the trace now lies about causality                              │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached on every `ask` flush and every trace replay. The scramble
window is widest when a run produces several messages close together (a tool turn
plus an assistant turn) and the flush fires them in parallel. On one device with one
query at a time the window is narrow — but the read path is already wrong, so it's a
latent bug waiting for the first concurrent or higher-volume use.

**The concurrent flush — `src/supabase-trace-sink.ts:37-39`.**

```
  src/supabase-trace-sink.ts  (lines 37–39)

  async flush(): Promise<void> {
    await Promise.all(this.pending);   ← fires all queued inserts concurrently
  }
       │
       └─ pending[] holds the writes in true event order. Promise.all throws that
          order away. swap for a serial for-await loop, or attach the index to
          each row, to preserve it.
```

**The timestamp source — `sql/001_agents_schema.sql` (agents.messages).**

```
  sql/001_agents_schema.sql

  created_at timestamptz not null default now()
       │
       └─ set by the SERVER at insert time, not by the event. there is no
          sequence column and no event-time column. now() is the only sort key
          available to replay, and it ties under concurrent insert.
```

**The replay query that cements it — `test/supabase-trace-sink.test.ts:30-34`.**

```
  test/supabase-trace-sink.test.ts  (lines 30–34)

  select role from agents.messages where conversation_id = $1 order by created_at
  ...
  assert.ok(roles.includes('assistant'));   ← only checks PRESENCE
  assert.ok(roles.includes('tool'));        ← never checks ORDER
       │
       └─ the test replays by the fragile key AND doesn't assert order, so it
          passes under scramble. it documents the wrong query as the right one.
```

**The dropped fix — `events.d.ts`.** Every event carries `timestamp: string` (event
time). The sink drops it (`02`). Persisting `event.timestamp` and replaying by it
would order by *emit* time, which survives the insert race — the cheapest fix, and the
data already arrives.

## Elaborate

This is a small, local instance of one of the load-bearing lessons in distributed
systems: clocks are not sequence numbers. The full version (Lamport clocks, vector
clocks, the reasons `now()` across machines is hopeless) lives in
`../study-distributed-systems/`; here it shows up in miniature on a single machine,
because `Promise.all` plus server-`now()` recreates the same hazard without any
network at all. The fix that real systems reach for is the same: an explicit logical
sequence per stream. buffr already *has* the sequence (the `pending[]` index) and the
event time (the dropped `timestamp`) — it just doesn't persist either. What to read
next: `02` (the dropped timestamp is the free fix) and `../study-distributed-systems/`
(the general principle).

## Interview defense

**Q: You replay traces ordered by `created_at`. What's wrong with that?**
`created_at` is `now()` set by the server at insert time, and I flush with
`Promise.all`, so my inserts race and land at near-identical timestamps. `order by
created_at` is undefined on ties, so the replay can show an assistant turn before the
tool call that produced it — the trace lies about causality. The real order existed
in my `pending[]` array and `Promise.all` threw it away.

```
  pending[] index = truth ──Promise.all──► arrival order = guess
                                            order by created_at = ties
```

**Q: Cheapest fix?**
Persist the event's own `timestamp` — it's already on every event, I'm just dropping
it today — and replay by that instead of `created_at`. Event time reflects emit order
regardless of the insert race. If I want it bulletproof, add an integer sequence
column set from the `pending[]` index and sort by that. The fix that costs nothing is
the one where the data already arrives.

## Validate

1. **Reconstruct.** Draw why `Promise.all` over `pending[]` loses the order that
   `pending[]` itself preserves. (`src/supabase-trace-sink.ts:38`.)
2. **Explain.** Why doesn't `created_at = now()` rescue the order?
   (`sql/001_agents_schema.sql` — server insert time, ties under concurrency.)
3. **Apply.** Write the replay query you'd use *after* persisting `event.timestamp`,
   and say why it survives the insert race. (`order by <event_time_col>`; event time
   reflects emit order, not arrival.)
4. **Defend.** Argue serial-flush vs sequence-column vs persist-timestamp. Which would
   you ship first on a single-device tool, and why? (Persist-timestamp: zero schema
   risk beyond one column, data already arrives, fixes the read path the test uses.)

## See also

- `02-discarded-trace-signal.md` — the dropped `event.timestamp` is the free fix.
- `01-trajectory-capture-as-observability.md` — the rows this bug reorders.
- `../study-distributed-systems/` — clocks-aren't-sequence-numbers, the full lesson.
- `../study-testing/` — the test that replays by the fragile key without asserting order.
