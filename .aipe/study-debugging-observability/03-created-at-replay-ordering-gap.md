# Client-timestamp replay ordering

**Industry names:** event-time ordering / client-timestamped events / ordering by
emit time, not insert time. **Type:** Project-specific instance of a general
distributed-systems pattern.

> Updated: 2026-06-24 — reframed from a bug ("replay-by-`created_at` scrambles turn
> order under concurrent flush") to the fix. On 2026-06-24 the sink began persisting
> `event.timestamp` into `created_at`, so replay now sorts by *emit* time, not server
> insert time. The original gap and the one residual ambiguity (a same-millisecond tie)
> are both kept below.

## Zoom out, then zoom in

You know how if you sort rows by a timestamp column and two rows share the *same*
timestamp, their order is undefined — the database can return them either way? buffr's
trace replay used to be worse than that: the timestamps weren't event time at all, they
were the moment each row happened to get inserted by a server clock, after a concurrent
flush. The fix was to stamp each row with the *event's own* ISO timestamp, so replay
order reflects when things happened, not when they landed. This file walks that
client-timestamp ordering — and the one residual case it doesn't fully resolve.

```
  Zoom out — where the ordering is now decided

  ┌─ Agent loop (aptkit-core) ───────────────────────────────────┐
  │  every event carries timestamp: string  (ISO emit time)      │ ← the source of order
  └───────────────────────────┬──────────────────────────────────┘
                              │ emit()
  ┌─ SupabaseTraceSink ───────▼──────────────────────────────────┐
  │  flush() → Promise.all(pending)  (still fires concurrently)   │ ← we are here
  │  but each row carries created_at = event.timestamp           │
  └───────────────────────────┬──────────────────────────────────┘
                              │ N inserts race — but order key no longer depends on it
  ┌─ Storage (agents.messages) ▼─────────────────────────────────┐
  │  created_at = coalesce(event.timestamp, now())               │
  └───────────────────────────┬──────────────────────────────────┘
                              │ read back
  ┌─ Replay (test + any future consumer) ▼───────────────────────┐
  │  select ... order by created_at  ← now = emit order          │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **client-timestamped event ordering** — the producer stamps
each event with the time it happened, the recorder carries that stamp into the row, and
replay sorts by it. The insert race that used to scramble order no longer decides the
sort key, because the sort key is set upstream of the race. The residual: two events
emitted within the same millisecond tie, and a tie is still undefined under `order by`.

## Structure pass

**Layers.** Three: the *emit* (stamps event time), the *flush* (writes concurrently),
the *replay* (reads by the stamped time). The fix moved the ordering authority from the
insert layer up to the emit layer.

**Axis — trace `what guarantees turn order?` down the layers.**

```
  "what guarantees turn order?" — traced down, after the fix

  ┌──────────────────────────────────────┐
  │ emit(): event.timestamp = emit time  │   → ORDER STAMPED (on the event itself)
  └──────────────────┬──────────────────┘
        ┌─────────────────────────────────┐
        │ flush(): Promise.all — parallel │   → ORDER CARRIED (created_at already set)
        └─────────────┬───────────────────┘
              ┌──────────────────────────┐
              │ replay: order by created_at│ → ORDER REPLAYED (= emit order, modulo ties)
              └──────────────────────────┘

  the true order is stamped at emit and survives the concurrent flush
```

That's the whole fix in one diagram: the correct order is no longer something
`pending[]` knows and `Promise.all` throws away — it's stamped onto each row's
`created_at` before the inserts race, so the race can't reorder it. The seam that used
to fail is `flush → insert`; it no longer carries the ordering responsibility, because
the order travels in the column value, not in arrival time.

## How it works

### Move 1 — the mental model

The shape is **stamp-at-source ordering**: the producer attaches a monotonic-enough
timestamp to each event, the recorder writes it verbatim, and the reader sorts by it —
so concurrency in the write path can't perturb the read order.

```
  stamp-at-source ordering

  events:   e0@T0   e1@T1   e2@T2          ← emit time stamped on each
              │       │       │
  flush fires all three concurrently (order of arrival irrelevant)
              ▼       ▼       ▼
  inserts land: e1   e0   e2               ← arrival scrambled by the race
  created_at:   T1   T0   T2               ← but the stamp came WITH the event
              └───────┬───────┘
  order by created_at  ──►  e0, e1, e2      ← emit order, restored at read time
```

The kernel that's now present: each row carries the *event's* timestamp, so replay
sorts by intent order, not arrival time. What still breaks: if two events carry the
*same* `created_at` (same millisecond, or both empty → both `now()`), the tie is
undefined — that's the residual, not the common case.

### Move 2 — the walkthrough

**Why `created_at = event.timestamp` survives the race.** The sink reads
`event.timestamp` at the top of `emit` and threads it through `persistMessage` as the
`createdAt` extra; the insert coalesces it into the `created_at` column. So the value
written is fixed at emit time, before any insert fires. `Promise.all` can interleave the
inserts however it likes — each row already carries its correct sort key.

```
  the timestamp travels with the event, not the insert

  emit(event):
    at = event.timestamp           ← captured at emit, before any write
    persist(..., { createdAt: at }) ← row's created_at is now fixed
       │
       └─ Promise.all reorders the INSERTS, not the VALUES. created_at is
          decided upstream of the race, so the race can't touch the sort key.
```

This is the move that closed the original bug: had the sink still left `created_at` to
default `now()`, the inserts racing under `Promise.all` would land at near-identical
server times and `order by created_at` would be undefined. Stamping emit time sidesteps
the race entirely.

**Why `Promise.all` is now safe to keep.** The concurrent flush is still there
(`Promise.all(this.pending)`), chosen for throughput. It used to be the thing that
opened the race; now it's harmless to ordering, because ordering no longer depends on
insert arrival. The throughput win comes for free now — parallel writes, deterministic
replay.

```
  Promise.all — still concurrent, no longer order-deciding

  flush():
    await Promise.all([ insert(e0@T0), insert(e1@T1), insert(e2@T2) ])
                          │             │             │
                          └─ arrival order varies; created_at values don't.
                             replay sorts by the values, so order is stable.
```

**The residual: same-millisecond ties and the empty-timestamp fallback.** Two honest
gaps remain. First, if two events share a `created_at` to the millisecond, `order by
created_at` is undefined between them — SQL gives no tiebreaker. Second, the insert
coalesces: `created_at = coalesce($8::timestamptz, now())`, so an event with an empty
`timestamp` (the loop emits `''` in some paths, and the unit test passes `''`) falls
back to server `now()` — reintroducing the old race for exactly those rows.

```
  the residual tie

  e3@T  e4@T                          ← same millisecond
       │     │
  created_at  T     T                 ← identical
       └──────┬─────┘
  order by created_at  ──►  e3,e4  OR  e4,e3   ← undefined on the tie

  fix if it ever bites: add an integer seq column from the pending[] index
  and sort (created_at, seq). free order already exists in pending[].
```

The bulletproof version is still the explicit sequence column — `pending[]` knows the
true order as its array index, and persisting that index as a `seq int` would break any
tie. buffr hasn't needed it: on one device, one turn at a time, sub-millisecond ties are
rare and the timestamp fix already orders the common case correctly.

### Move 2.5 — current state vs future state

```
  Phase A (before 2026-06-24)         Phase B (now)
  ─────────────────────────────       ─────────────
  created_at = server now()           created_at = event.timestamp (coalesce now())
  ordering depends on insert race     ordering fixed at emit, survives the race
  ties common under Promise.all       ties only on same-ms OR empty-timestamp rows
  test replayed by fragile key        test asserts replay == emit order

  what did NOT change: Promise.all flush, conversation grouping, the CLI.
  residual: same-millisecond tie + the now() fallback for empty timestamps.
            close it with a seq column (pending[] index) if it ever matters.
```

### Move 3 — the principle

Physical insert time is not logical order, but a *client-stamped* event time is a good
proxy for it — and stamping at the source, before any concurrent write, is what lets
replay survive the race. The principle: *if order matters, carry the order in the data,
decided as far upstream as you can — never infer it from when the write happened to
land.* buffr first inferred order from server `now()` and got bitten; the fix stamps
emit time onto every row. The last mile (a same-ms tiebreaker) is the sequence column,
and the order for it already exists for free in `pending[]`.

## Primary diagram

The full path, end to end, after the fix.

```
  client-timestamp ordering — full path

  ┌─ Sink emit() ────────────────────────────────────────────────────┐
  │  at = event.timestamp   (e0@T0, e1@T1, e2@T2)  ← order stamped here│
  │  pending.push(persist(..., { createdAt: at }))                    │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ flush(): Promise.all  ← reorders inserts only
  ┌─ Postgres (agents.messages) ▼────────────────────────────────────┐
  │  created_at = coalesce(event.timestamp, now())                   │
  │  rows land in race order; created_at values are emit times       │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ select ... order by created_at
  ┌─ Replay ──────────────────▼──────────────────────────────────────┐
  │  returns e0, e1, e2  → tool call BEFORE its result, correctly     │
  │  residual: ties on identical created_at remain undefined         │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached on every `chat` flush (`src/session.ts:63`) and every trace
replay. The common case — a tool turn then an assistant turn emitted milliseconds apart
— now replays in emit order regardless of how the concurrent inserts land. The residual
window is a sub-millisecond tie, narrow on one device.

**The stamp capture — `src/supabase-trace-sink.ts:53-55`.**

```
  src/supabase-trace-sink.ts  (lines 54–55)

  emit(event: CapabilityEvent): void {
    const at = event.timestamp;          ← captured once, before any write
       │
       └─ every branch below threads `at` through as createdAt. the sort key is
          decided here, at emit, upstream of the Promise.all race.
```

**The coalescing insert — `src/supabase-trace-sink.ts:26-36`.**

```
  src/supabase-trace-sink.ts  (lines 26–30)

  const createdAt = extra?.createdAt && extra.createdAt.length > 0 ? extra.createdAt : null;
  ...
    values (..., coalesce($8::timestamptz, now()))
       │
       └─ event.timestamp becomes created_at when present; when empty it falls
          back to now() — the one path that reintroduces the old insert-race
          dependency. that's the residual ordering ambiguity.
```

**The concurrent flush — `src/supabase-trace-sink.ts:91-93`.**

```
  src/supabase-trace-sink.ts  (lines 91–93)

  async flush(): Promise<void> {
    await Promise.all(this.pending);   ← still concurrent, now safe for ordering
  }
       │
       └─ Promise.all reorders the inserts, not the created_at values. ordering
          survives because the sort key was stamped before flush ran.
```

**The schema — `sql/001_agents_schema.sql:49`.** `created_at timestamptz not null
default now()` — the default is now the *fallback*, not the primary source. There's
still no explicit `seq` column; a same-millisecond tie has no tiebreaker, which is the
documented residual.

**The test that proves emit-order replay — `test/supabase-trace-sink.test.ts:64-66`.**
The second test emits five events with distinct ISO timestamps
(`...00:00:01Z`…`...00:00:05Z`), replays with `order by created_at`, and asserts the
roles come back in *exactly* emit order (`['tool_call','tool','model_usage','warning',
'error']`). The test now pins the correct replay contract instead of baking in the old
gap.

## Elaborate

This is a small, local instance of one of the load-bearing lessons in distributed
systems: clocks are not sequence numbers, but a client-stamped event time gets you most
of the way there. The full version (Lamport clocks, vector clocks, why `now()` across
machines is hopeless) lives in `../study-distributed-systems/`; here it showed up in
miniature on a single machine, because `Promise.all` plus server-`now()` recreated the
hazard without any network at all — and the fix is the same one real systems reach for
first: stamp the order at the source. buffr already *had* the event time on every event;
it just wasn't persisting it. Now it does. The last residual (same-ms ties) is exactly
where you'd reach for the explicit sequence number, and the order for it already exists
as the `pending[]` index. What to read next: `02` (the timestamp this file relies on is
one of the signals that sink now keeps) and `../study-distributed-systems/`.

## Interview defense

**Q: You replay traces ordered by `created_at`. Server insert time scrambles under
concurrent flush — how is that safe?**
It would be, if `created_at` were server `now()` — and it used to be, which was a real
bug. I fixed it by persisting `event.timestamp` (the loop stamps every event with its
ISO emit time) into `created_at`. So the sort key is decided at emit, before the
`Promise.all` flush races the inserts. The race reorders which insert lands first; it
can't touch the `created_at` values, so `order by created_at` returns emit order.

```
  event.timestamp stamped at emit ──Promise.all──► inserts race
                                                    created_at values unchanged
                                                    order by created_at = emit order
```

**Q: What's the residual gap, and how would you close it?**
Two events emitted in the same millisecond carry the same `created_at`, and a tie is
undefined under `order by` — plus an empty event timestamp falls back to `now()`, which
reintroduces the race for those rows. To close it I'd add an integer `seq` column set
from the `pending[]` array index and sort by `(created_at, seq)`. The true order already
exists as that index; I just don't persist it yet, because on one device a sub-ms tie is
rare enough not to have earned the column.

## Validate

1. **Reconstruct.** Draw why stamping `event.timestamp` at emit survives the
   `Promise.all` race that server `now()` did not. (`src/supabase-trace-sink.ts:54-55`.)
2. **Explain.** What's the one path where ordering still falls back to insert time?
   (Empty `event.timestamp` → `coalesce(..., now())`, `src/supabase-trace-sink.ts:26,30`.)
3. **Apply.** Two events are emitted in the same millisecond. Write the replay query
   that would order them deterministically and the schema change it needs.
   (`order by created_at, seq`; add a `seq int` column from the `pending[]` index.)
4. **Defend.** Argue whether to ship the `seq` column now or stay on event-timestamp
   ordering. Which would you pick on a single-device tool, and why? (Stay: the timestamp
   fix orders the common case; add `seq` at the first sub-ms tie or first multi-writer
   path — see `audit.md` R2.)

## See also

- `02-discarded-trace-signal.md` — the `event.timestamp` this file relies on is one of
  the signals the sink now persists.
- `01-trajectory-capture-as-observability.md` — the rows this ordering replays.
- `../study-distributed-systems/` — clocks-aren't-sequence-numbers, the full lesson.
- `../study-testing/` — the test that now asserts replay order matches emit order.
