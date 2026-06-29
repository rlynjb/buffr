# 02 — Trace-sink write buffering

## Subtitle

**Asynchronous write buffering with read-time ordering** — *Project-specific*
shape over two industry standards: a **fire-and-forget write buffer** and
**event-time ordering** (the logical clock, absent — a physical timestamp
stands in). In buffr this is `SupabaseTraceSink`
(`src/supabase-trace-sink.ts:49-94`).

## Zoom out, then zoom in

aptkit's agent loop calls `trace.emit(event)` synchronously as it runs — it
can't `await` a database write in the middle of reasoning. buffr's job is to
turn those synchronous emits into durable rows in `agents.messages` without
blocking the agent, and without scrambling the order they replay in.

```
  Zoom out — where the trace sink lives

  ┌─ Client (one Node process) ───────────────────────────────┐
  │  RagQueryAgent (aptkit)                                   │
  │     │ emit(event)  — SYNCHRONOUS (aptkit's contract)       │
  │     ▼                                                      │
  │  ★ SupabaseTraceSink (src/supabase-trace-sink.ts) ★        │
  │     buffers a write-promise per event; flush() drains them │
  └─────────────────────────────────┬──────────────────────────┘
                                    │ pooled pg conn ×N
  ┌─ Storage layer ─────────────────▼──────────────────────────┐
  │  Postgres  agents.messages   (created_at = event.timestamp) │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **write buffer** — `emit()` doesn't write, it
*enqueues* a promise; `flush()` awaits the whole batch after the run. The twist
that makes it correct: the rows go in **out of order** (a `Promise.all` race),
but each row carries `created_at = event.timestamp`, so a replay that does
`ORDER BY created_at` reconstructs the true emit order. **Order is decided at
emit time, not by the flush race.**

## Structure pass — layers, one axis, the seam

Trace **one axis — what decides ordering — down through the path** and watch it
flip.

```
  axis traced = "what decides the order events end up in?"

  ┌─ emit() — src/supabase-trace-sink.ts:53 ─────┐  → emit ORDER fixed here:
  │  reads event.timestamp, pushes a promise     │    timestamp captured now
  └──────────────────────┬───────────────────────┘
                         │  seam — the buffer (pending[])
  ┌─ flush() — :91 ─────▼────────────────────────┐  → INSERT order = RACE:
  │  Promise.all(pending) — concurrent inserts   │    whoever Postgres finishes
  └──────────────────────┬───────────────────────┘
                         │
  ┌─ replay — ORDER BY created_at ───────────────┐  → READ order = emit order:
  │  sorts by the timestamp captured at emit      │    the race is undone
  └───────────────────────────────────────────────┘

  the axis answer flips twice: emit fixes it → flush scrambles it →
  read restores it. the restore works ONLY because created_at came from
  one machine's clock.
```

The **seam is the buffer (`pending[]`)** — the boundary between synchronous
emit and asynchronous, racing inserts. The whole correctness argument is: *the
ordering information is captured before the seam, so the race after it doesn't
matter.*

## How it works

### Move 1 — the mental model

You've written this shape: a UI that fires off several `fetch()` POSTs with
`Promise.all` and doesn't care which resolves first — because each POST carries
its own data, the server doesn't need them in arrival order. The trace sink is
exactly that, plus a sort key. Each event carries its own timestamp, so the
inserts can race; replay sorts them back.

```
  the kernel — buffer, race, sort-key

   emit(e1) → push p1   (p1 carries created_at = t1)
   emit(e2) → push p2   (p2 carries created_at = t2)
   emit(e3) → push p3   (p3 carries created_at = t3)
        │
        ▼  flush()
   Promise.all([p1,p2,p3])   ← inserts complete in ANY order: p3,p1,p2
        │
        ▼  later: SELECT ... ORDER BY created_at
   e1(t1), e2(t2), e3(t3)    ← true order restored by the sort key
```

Name each part by what breaks without it:

- **The buffer (`pending[]`)** — without it, `emit()` would have to `await`,
  but `emit()` is synchronous by aptkit's contract. Drop it and you can't
  persist from inside the loop at all.
- **The sort key (`created_at = event.timestamp`)** — without it, replay order
  is the `Promise.all` race, which is *arbitrary*. Drop it and your trajectory
  reads back scrambled — a tool result before the tool call that caused it.
- **`flush()`** — without it, the process could exit with writes still pending,
  losing the tail of the trajectory.

The sort key is the load-bearing, easy-to-forget part. Everything else is
plumbing; that one column is what makes the race safe.

### Move 2 — the walkthrough

**`emit()` is synchronous and just enqueues.** aptkit's `CapabilityTraceSink`
contract makes `emit` return `void` — the agent can't be blocked on I/O
mid-reasoning. So every branch does the same move: build a `persistMessage`
promise and `push` it (`src/supabase-trace-sink.ts:53-85`). The critical detail
is `const at = event.timestamp` on line 55, threaded into *every* branch as
`createdAt: at`:

```ts
emit(event: CapabilityEvent): void {
  const { pool, conversationId } = this.opts;
  const at = event.timestamp;                          // ← capture order NOW
  switch (event.type) {
    case 'step':
      if (event.content)
        this.push(persistMessage(pool, conversationId, event.role,
                  event.content, { createdAt: at }));   // ← carried into the row
      return;
    case 'tool_call_start': /* args = the cause */       return;
    case 'tool_call_end':   /* result, error, durationMs */ return;
    case 'model_usage':     /* tokens_used */             return;
    case 'warning': case 'error': /* message */           return;
  }
}
```

Every variant is persisted — not just assistant steps. Tool-call args (the
cause), `durationMs` + error, token usage, and warning/error events all become
rows. That's what makes `agents.messages` a *complete, replayable trajectory*
rather than a partial log. And every one of them stamps `createdAt: at`.

**The buffer and the flush race.** The push and drain are four lines
(`:87-93`):

```ts
private push(p: Promise<void>): void { this.pending.push(p); }

async flush(): Promise<void> {
  await Promise.all(this.pending);   // ← inserts race; completion order arbitrary
}
```

`Promise.all` awaits them concurrently. Postgres finishes them in whatever order
it pleases — connection scheduling, query cost, pure timing. **Nothing here
preserves emit order.** That's intentional: emit order was already captured in
`created_at`.

**Where the order actually gets written.** `persistMessage`
(`src/session.ts:27-36`) lands the timestamp:

```ts
`insert into agents.messages
   (conversation_id, role, content, tool_calls, tool_results, model,
    tokens_used, created_at)
 values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))`
```

`coalesce($8::timestamptz, now())` (`:30`): use the event's timestamp when
present, fall back to the server's `now()` only when it's absent. So the
ordering key is the **event's** time, set on the client, not the insert's time.
Replay is then `ORDER BY created_at` and the flush race vanishes.

```
  Layers-and-hops — emit-time order survives the flush race

  ┌─ Client ───────────────────────────────────────┐
  │ emit(step,   t=10:00:01) → push p_a             │
  │ emit(tool,   t=10:00:02) → push p_b             │
  │ emit(result, t=10:00:03) → push p_c             │
  │            flush(): Promise.all([p_a,p_b,p_c])   │
  └───────┬─────────────┬─────────────┬─────────────┘
          │ insert #2    │ insert #3   │ insert #1   ← RACE: arbitrary
          ▼ (p_c lands)  ▼ (p_a lands) ▼ (p_b lands)
  ┌─ Storage: agents.messages ──────────────────────┐
  │ created_at carries 10:00:03 / :01 / :02          │
  │ SELECT ... ORDER BY created_at →                 │
  │   step(:01), tool(:02), result(:03)  ✓ restored  │
  └──────────────────────────────────────────────────┘
```

### Move 2.5 — current state vs future state

This is the file's whole reason for existing. The read-time ordering is **sound
on one device and breaks under cross-device clock skew.**

```
  Phase A (now): one machine's clock           Phase B (deferred two-brain)
  ───────────────────────────────────          ──────────────────────────────
  laptop emits → laptop clock stamps all        laptop AND phone both emit into
  created_at. every timestamp comes from        the same agents.messages. each
  ONE clock, so "t1 < t2" is always true        stamps created_at from ITS OWN
  if e1 happened before e2.                      clock.

  ORDER BY created_at = true causal order        laptop clock and phone clock can
                                                 differ by seconds. a phone event
                                                 stamped 10:00:01 can sort BEFORE
                                                 a laptop event that truly
                                                 happened first at 10:00:02.

  ✓ correct                                      ✗ ORDER BY created_at can lie
```

What doesn't have to change is most of the code — the buffer, the per-event
persistence, the flush. What *does* have to change is the **clock**: a physical
wall-clock sort key (`event.timestamp`) is only a valid total order when one
clock produces all the timestamps. Two writers need a **logical clock** (a
Lamport or per-conversation sequence number) or a server-assigned monotonic
sequence, so order doesn't depend on two machines agreeing on time. That's the
single sharpest future-RFC point in this guide — see `03` and `audit.md` lens 7.

This is not a bug to fix now. On one device the physical clock *is* a correct
total order, and a logical clock would be machinery with nothing to coordinate.
It's a prerequisite to name *before* a second writer ships, not before.

### Move 3 — the principle

**Capture ordering information before the boundary that scrambles it, and you
can let the writes race.** That's the general move: don't fight the concurrency,
make it irrelevant by stamping order at the source. The catch is the source of
truth for "order" — a physical clock is a valid total order only under one
clock. The day "the source" becomes plural, the physical timestamp stops being
an order and becomes an *approximation*, and you need a logical clock. buffr is
on the right side of that line today and one design decision away from the wrong
side.

## Primary diagram

The complete sink — synchronous emit, racing flush, read-time restore, and the
clock assumption that holds it all up.

```
  SupabaseTraceSink — the complete picture

  ┌─ Client: one Node process ─────────────────────────────────────┐
  │  RagQueryAgent ── emit(event) [SYNC] ──►                        │
  │                                                                 │
  │   emit (sink.ts:53)        flush (sink.ts:91)                   │
  │   ┌──────────────────┐     ┌─────────────────────┐             │
  │   │ at = event.      │     │ Promise.all(pending)│             │
  │   │   timestamp  ────┼──┐  │  → inserts RACE     │             │
  │   │ push promise     │  │  └──────────┬──────────┘             │
  │   └──────────────────┘  │             │                        │
  │       pending[] ◄───────┘             │ pooled pg conn ×N      │
  └───────────────────────────────────────┼────────────────────────┘
                                          │
  ┌─ Storage: Postgres agents.messages ───▼────────────────────────┐
  │  created_at = coalesce(event.timestamp, now())  (session.ts:30) │
  │  replay:  ORDER BY created_at  → true emit order                │
  │                                                                 │
  │  ⚠ valid ONLY while all timestamps come from ONE clock          │
  │    (logical clock absent — see 03, audit lens 7)                │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "stamp order at the source, let writes race" pattern is the same instinct
behind event sourcing and append-only logs: the event carries its own position,
so storage order is incidental. The clock caveat is the classic distributed-
systems lesson — wall clocks aren't a reliable cross-machine order, which is why
Lamport timestamps and vector clocks exist (to order events *without* trusting
synchronized physical time). buffr doesn't need them yet; it's a textbook
example of *when you don't* (single clock) and *exactly when you start to*
(second writer). Read `study-debugging-observability` for how this trajectory is
*read back* as an observability artifact; this file only covers its
write-ordering correctness.

## Interview defense

**Q: Your trace writes race in `Promise.all`. How is the trajectory not
scrambled?**

Verdict first: the writes race, but the *order* doesn't live in the write order
— it lives in a column.

```
  emit: at = event.timestamp ──► created_at column
  flush: Promise.all ──► inserts complete in ANY order
  replay: ORDER BY created_at ──► race undone
```

The load-bearing part people miss: ordering is captured at *emit*, before the
buffer, so the `Promise.all` race after it is irrelevant. The one line that
makes it work is `const at = event.timestamp` (`sink.ts:55`) threaded into every
branch, landing via `coalesce($8::timestamptz, now())` (`session.ts:30`).

**Q: When does that break?**

The instant a second device writes to the same table. Two clocks, two sources of
`created_at`, and `ORDER BY created_at` can interleave them wrong — a phone event
sorting before a laptop event that truly came first. The fix is a logical clock
(per-conversation sequence number), not a physical one. Anchor: it's sound on
one device *because* one machine stamps every timestamp; that's the assumption,
and it's the assumption the deferred two-brain design has to retire (`03`).

## See also

- `00-overview.md` — finding #2.
- `03-deferred-two-brain-shared-memory.md` — DESIGN-NOT-CODE; the clock-skew
  break projected forward.
- `audit.md` — lens 6 (buffer/backpressure), lens 7 (clocks).
- `01-app-to-postgres-boundary.md` — the pool these N inserts fan across.
- `study-debugging-observability` — reading the trajectory back.
