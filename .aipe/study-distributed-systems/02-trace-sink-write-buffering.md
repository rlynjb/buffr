# Trace-Sink Write Buffering

**Buffered async writes / fire-and-flush** · Project-specific

The one place buffr issues writes it doesn't immediately await: the trace sink
queues a write-promise per agent event, then drains them all at the end of the
turn. It's the repo's only at-least-once seam — and it used to carry a real,
mild ordering bug. That bug is now **fixed**: `created_at` is written from the
client-assigned `event.timestamp` instead of a server `now()` evaluated at
insert, so replay order matches emit order. This file walks the pattern, the
bug, and the fix — because the *reasoning* (a server clock is not a sequence
number) is the lesson, fixed or not.

---

## Zoom out, then zoom in

Here's where this sits. The agent loop runs in-process; as it emits events
(assistant turn, tool call), the sink turns each into a Postgres write — but
*queues* it instead of awaiting it inline, so the agent isn't blocked on the DB.

```
  Zoom out — where the trace sink lives

  ┌─ Process (session.ts → ChatSession.ask) ────────────────────┐
  │                                                              │
  │   RagQueryAgent.answer()                                     │
  │       │ emits CapabilityEvent (sync, carries .timestamp)     │
  │       ▼                                                      │
  │   ★ SupabaseTraceSink.emit() ★  ← we are here                │
  │       │ pushes a write-promise onto pending[]                │
  │       │ (does NOT await; passes createdAt = event.timestamp) │
  │   ...turn finishes...                                        │
  │       ▼                                                      │
  │   trace.flush()  → Promise.all(pending)                      │
  └────────────────────────────┬────────────────────────────────┘
                              writes │ pg.Pool
  ┌─ Postgres ─────────────────▼────────────────────────────────┐
  │  agents.messages  (one row per assistant / tool event)      │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **fire-and-flush** — emit synchronously, buffer the
async work, await the buffer once at the end. aptkit's `CapabilityTraceSink`
contract requires `emit` to be *synchronous* (it's called from inside the agent
loop, which can't `await` a sink). So buffr's sink can't await the write inline;
it stashes the promise and settles up later. The question this answers: *how do
you persist a side-effect stream from a synchronous callback without blocking
the producer — and what do you give up by doing it?*

---

## Structure pass

**Layers.** Two: the **producer** (the agent loop calling `emit`) and the
**writer** (the queued `persistMessage` calls hitting Postgres). The `pending[]`
array is the seam between them.

**Axis — trace *ordering guarantee* across the seam.** Hold the question:
*"is event A guaranteed to be persisted before event B if A was emitted first?"*

```
  One question across the seam: "does emit-order = persist-order?"

  ┌─ producer (agent loop) ──────────────┐
  │  emit(A) then emit(B)                │  → ORDERED: A before B, and each
  │  each carries event.timestamp        │    event stamps its own emit time
  └───────────────┬──────────────────────┘
                  │  the WRITES still race here…
  ┌─ pending[] + Promise.all ────────────▼┐
  │  fires A's write, then B's write      │  → writes still in flight together,
  │  but each insert sets created_at FROM │    BUT order is now carried in the
  │  its event.timestamp, not now()       │    data → replay-by-created_at = emit
  └───────────────────────────────────────┘
```

**Seam — `pending[]` is load-bearing, but order no longer flips across it.**
Above the array, events are strictly ordered (the loop emits them in sequence),
and each event carries its own `event.timestamp`. Below it, the two writes still
race — `emit(A)` fires its `persistMessage` and returns, `emit(B)` fires its own,
both concurrent — *but* each insert now writes `created_at` from its event's
timestamp (`coalesce($8::timestamptz, now())`), not from a server `now()`
evaluated at insert. So the write race no longer decides the persisted order:
order is a property of the data, assigned at emit. The residual edge is two
events sharing the same millisecond — then the tie isn't broken and you're back
to insert-arrival order for that pair. That move — pushing order out of the race
and into the row — is the whole lesson of this file.

---

## How it works

### Move 1 — the mental model

You know the difference between `await fetch()` (block until it's done) and
`void fetch()` / fire-and-forget (kick it off, move on). This is the careful
middle: **fire-and-*flush*** — kick off each write, keep the promise, then
`await Promise.all(...)` of all of them at a single join point so you don't lose
errors or exit before the writes land.

```
  Pattern — fire-and-flush (kick off, collect, join once)

  emit(A) ─► push p_A ─┐
  emit(B) ─► push p_B ─┤   pending = [p_A, p_B, p_C]   (in flight)
  emit(C) ─► push p_C ─┘
                       │
   run ends ──► flush(): await Promise.all(pending)  ← single join point
                       │
                       ▼
              all writes settled (or first rejection thrown)
```

The kernel: **a sync producer + an in-memory promise buffer + a single
join/flush.** Drop the buffer and you lose the writes (fire-and-forget). Drop
the flush and the process can exit mid-write. Keep both and the producer never
blocks — but the buffer doesn't serialize, so **you don't get ordering for
free**. You have to *put it in the data* — which is exactly what the timestamp
fix below does.

### Move 2 — the walkthrough

**`emit` is synchronous and must not await.** Bridge from a DOM event handler:
`onClick` returns `void`, it can't be `async` and have the framework wait on it.
aptkit's `emit(event): void` is the same — the agent loop calls it and moves on.
What concretely happens: on an assistant `step` or a `tool_call_end`, the sink
builds a `persistMessage(...)` promise and `push`es it onto `pending`. It does
*not* await. Where it breaks: if you tried to `await` inside `emit`, you
couldn't — the signature is `void`. So the buffering isn't a style choice, it's
forced by the contract.

**Each write is independent and unkeyed.**

```
  Layers-and-hops — two emits, two concurrent writes

  ┌─ agent loop ─┐ emit(assistant) ┌─ sink ──────────────┐
  │ step A @ t1  │ ───────────────► │ push p_A (ca=t1)    │
  │ tool B @ t2  │ emit(tool) ─────► │ push p_B (ca=t2)    │
  └──────────────┘                  └──────┬───────────────┘
                          p_A insert │      │ p_B insert  (BOTH in flight)
                                     ▼      ▼
                          ┌─ Postgres agents.messages ──────┐
                          │ created_at = event.timestamp    │ ← order from t1<t2,
                          │ (coalesce(t, now()))            │   NOT insert arrival
                          └──────────────────────────────────┘
```

Each `persistMessage` is still a bare `insert` with a server-generated UUID and
no idempotency key, but it now carries the **client-assigned** `created_at`:
`event.timestamp` flows in as `createdAt` and the SQL writes
`coalesce($8::timestamptz, now())` (`supabase-trace-sink.ts:27-36`). What
concretely happens under the race now: emit-order A@t1 → B@t2, and even if B's
insert commits first, B.created_at = t2 > t1 = A.created_at. Where it still
breaks: if t1 == t2 (same millisecond), the timestamps tie and the pair falls
back to insert-arrival order — the residual edge. The client timestamp is a
*coarse* sequence, not a strict monotonic counter.

**`flush()` is the single join point — and the only error surface.**

```
  Execution trace — flush() draining the buffer

  pending = [p_A(pending), p_B(pending)]
  flush() → Promise.all(pending)
     p_A resolves ──► pending[0] settled
     p_B rejects  ──► Promise.all REJECTS immediately with p_B's error
                      (p_A already wrote; no rollback — at-least-once)
  → flush() throws; ChatSession.ask awaits it, so the turn rejects
```

`flush` (`:91-93`) is `await Promise.all(this.pending)`. This is load-bearing:
it's what makes the writes *at-least-once* rather than *best-effort*. Without the
`await trace.flush()` call in `session.ts` (inside `ChatSession.ask`), the
process could `pool.end()` on `close()` and exit while writes were still in
flight, dropping trajectory rows. Where it breaks: `Promise.all` rejects on the
*first* failure — so if one write fails, you get the error but the other writes
that already succeeded stay committed (no atomicity across the batch). That's the
at-least-once / partial-write reality: some rows land, one errors, nothing rolls
back.

### Move 2.5 — the bug, and the fix that landed

This *was* a known sharp edge — the ordering quirk this whole file is built
around. It's now fixed. Here's the before/after.

```
  Comparison — BEFORE (racy order) vs NOW (client-assigned order)

  BEFORE (the bug)                     NOW (shipped fix)
  ┌──────────────────────────┐         ┌──────────────────────────────┐
  │ emit fires write, no wait │         │ emit fires write, no wait     │
  │ Promise.all (unordered)   │   →     │ Promise.all (still unordered) │
  │ created_at = now()@insert │         │ created_at = event.timestamp  │
  │ → replay can scramble turns│        │ → replay = emit order         │
  └──────────────────────────┘         └──────────────────────────────┘
  non-blocking but                      non-blocking AND ordered —
  wrong order under race                order is in the row, not the race
```

The fix is the client-assigned-ordering field this file originally argued for —
the same idea as a monotonic `seq` column, just realized with the event's own
timestamp. `event.timestamp` is captured at emit (in order, in the producer) and
written straight into `created_at`; replay sorts by `created_at` and gets emit
order back. It keeps the non-blocking fire-and-flush — nothing re-serializes,
the loop never waits on a write — and recovers deterministic order, because
order now comes from a client-assigned value instead of a server-side `now()`
race.

What it does **not** fully solve: ties. A timestamp is a clock, not a sequence
number, so two events stamped in the same millisecond sort arbitrarily relative
to each other — the residual edge. At single-device, low-event-count scale that
basically never bites (turns are tens of ms apart), and if it ever mattered the
strict-monotonic upgrade is a `seq` ordinal column sorted as the tiebreaker. The
load-bearing correctness hole is closed; what's left is a precision limit, not a
race.

### Move 3 — the principle

Fire-and-flush is how you persist a side-effect stream from a synchronous
producer without blocking it — but **a buffer is not a queue, and "I awaited
them all" is not "they happened in order."** The moment you decouple emit from
persist, ordering becomes something you have to *assign explicitly* — captured at
emit and carried in the row — not something you get for free from arrival time.
That's exactly the move buffr made: order now rides on `event.timestamp` in
`created_at`, so replay matches emit. buffr's sink is the smallest honest version
of every async write pipeline: the at-least-once delivery is real, the ordering
guarantee is *now* real too because order was made a property of the data instead
of the race — with the one caveat that a wall-clock timestamp is a coarse
sequence, so same-millisecond ties are the residual edge.

---

## Primary diagram

The complete picture: sync emit, buffered concurrent writes, single flush,
at-least-once — with order carried in the event timestamp, not the insert race.

```
  Trace-sink write buffering — the complete picture

  ┌─ Producer (RagQueryAgent loop, in-process) ─────────────────┐
  │  emit(step) ─┐  emit(tool_*) ─┐  emit(model_usage) ─┐        │
  │   sync, void │   sync, void   │   each carries .timestamp    │
  └───────┼──────┼────────┼───────┼──────────────┼──────────────┘
          ▼      ▼        ▼       ▼              ▼
  ┌─ Buffer: pending[] (in-memory promise array) ───────────────┐
  │  [ persistMessage(A, ca=t1), persistMessage(B, ca=t2), … ]  │
  └────────────────────────────┬────────────────────────────────┘
              flush(): Promise.all │  (single join, first-reject throws)
  ┌─ Postgres agents.messages ────▼─────────────────────────────┐
  │  N rows · UUID pk · created_at = event.timestamp ← EMIT ORDER│
  │  at-least-once · unkeyed · no cross-write atomicity          │
  │  residual edge: same-ms ties fall back to arrival order      │
  └─────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Triggered once per turn inside a long-lived chat session
(`src/session.ts`, `ChatSession.ask`): the conversation row is created once when
the session opens (`startConversation`), then on each `ask()` the user's question
is written synchronously (awaited inline — *not* buffered), the sink buffers
every event the agent emits during `answer()` (assistant steps, tool-call start
*and* end, model usage, warnings/errors), and `flush()` settles them before the
answer returns. The pool is held warm across turns and only closed on
`session.close()`.

**The buffered emit — `src/supabase-trace-sink.ts` (lines 53-85).** It now
handles every `CapabilityEvent` variant, and every push passes
`createdAt: event.timestamp`.

```
  emit(event: CapabilityEvent): void {            ← sync: aptkit's contract
    const { pool, conversationId } = this.opts;
    const at = event.timestamp;                   ← client-assigned emit time
    switch (event.type) {
      case 'step':
        if (event.content) this.push(persistMessage(
          pool, conversationId, event.role, event.content, { createdAt: at }));
        return;                                    ← buffer, do NOT await
      case 'tool_call_start': /* args = the cause */
      case 'tool_call_end':   /* result + durationMs + error */
      case 'model_usage':     /* fills tokens_used */
      case 'warning': case 'error':
        this.push(persistMessage(..., { createdAt: at }));
        return;
    }
  }
       │
       └─ push-without-await is still the load-bearing non-blocking line. But
          createdAt: at is the fix: order is carried in the row, so two
          concurrent inserts no longer decide replay order — their timestamps do.
```

**The single join — `src/supabase-trace-sink.ts` (lines 91-93).**

```
  async flush(): Promise<void> {
    await Promise.all(this.pending);     ← the only place writes are awaited
  }
       │
       └─ this is what makes it at-LEAST-once instead of best-effort. Remove
          the `await trace.flush()` in session.ts (ChatSession.ask) and the
          process can pool.end() on close() + exit mid-write → lost trajectory
          rows. Promise.all rejects on first failure; earlier successes stay
          committed (no cross-write rollback) — the at-least-once reality.
```

**The now-ordered write — `src/supabase-trace-sink.ts` (lines 27-36).**

```
  const createdAt = extra?.createdAt?.length ? extra.createdAt : null;
  await pool.query(
    `insert into agents.messages
       (conversation_id, role, content, tool_calls, tool_results,
        model, tokens_used, created_at)
     values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now()))`,
    [..., createdAt]);
       │
       └─ created_at is the client's event.timestamp when present, falling
          back to the table default now() (sql/001_agents_schema.sql:49) only
          when absent. THIS is the ordering fix: order is assigned at emit and
          sorted on read, so the insert race no longer scrambles replay. Still
          no idempotency key (fine — nothing retries the sink).
```

---

## Elaborate

This pattern is the embryonic form of a **transactional outbox** without the
outbox: you're capturing a side-effect stream for later (here, trajectory rows
that the parent plan wants for eventual fine-tuning — the "capture every
conversation now" thesis in `agent-layer-plan.md`). A real outbox would write
the events to a table *inside the same transaction* as the work, then have a
relay drain them in order with delivery guarantees. buffr's sink skips all of
that because the consumer is "a human reading rows later," not another service —
but the ordering bug it *had* is *exactly* the bug outboxes are designed to
prevent, and the timestamp fix is the lightweight, single-writer version of the
"order is assigned, not observed" discipline an outbox relay enforces. That's why
it's worth understanding here.

What to read next: `audit.md` Lens 3 (delivery semantics) and Lens 6 (the
ordering verdict), and `01-app-to-postgres-boundary.md` for what these queued
writes do when they hit the pool. For how these rows function as the project's
primary observability artifact, see `.aipe/study-debugging-observability/` (the
trajectory-as-evidence material — not yet generated).

---

## Interview defense

**Q: "Your trace sink buffers writes and flushes with `Promise.all`. There was an
ordering bug — what was it, and how did you fix it?"**

```
  emit-order vs persist-order — before the fix, and after

  BEFORE                              AFTER
  emit:   A ──► B                     emit:  A@t1 ──► B@t2
             ╲   ╱  Promise.all              │         │  created_at = timestamp
              ╳     doesn't serialize        ▼         ▼
             ╱   ╲                     row:  ca=t1     ca=t2
  insert: B ──► A  (now() race →             order from t1<t2,
                    wrong replay order)      NOT insert arrival
```

Ordering. `emit` is sync so I can't await inline — I buffer a promise per event
and `Promise.all` them at flush. `Promise.all` doesn't serialize, so the inserts
race. The bug was that `created_at` defaulted to a server-side `now()` at insert
time, so the persisted order could disagree with emit order and replay could
scramble turns. The fix that landed: write `created_at` from the event's own
`event.timestamp` (`coalesce($8::timestamptz, now())`), captured at emit, in
order. That keeps the writes non-blocking *and* makes order a property of the row
instead of the race. The one residual edge is a same-millisecond tie — a wall
clock is a coarse sequence, so a strict `seq` ordinal would be the upgrade if
ties ever mattered.

*Anchor: `supabase-trace-sink.ts:55` (`at = event.timestamp`), `:59-82` (every push passes `createdAt: at`), and `:30` (the `coalesce` in the SQL).*

**Q: "Is it at-least-once, at-most-once, or exactly-once?"**

At-least-once in spirit, but really "fire-and-flush once." There's no retry, so
in practice each event is written once. But the writes aren't keyed or atomic as
a batch — if `flush`'s `Promise.all` rejects on write #3, writes #1 and #2 are
already committed and don't roll back. So: no dedup needed because no retry, but
no cross-write atomicity either. The load-bearing part people forget is the
`flush()` itself — without that single join, it'd silently drop to
best-effort/fire-and-forget and lose rows on a fast process exit.

*Anchor: `flush()` at `:91-93` is what upgrades it from best-effort to at-least-once.*

---

## Validate

1. **Reconstruct.** From memory, draw fire-and-flush: sync emit → push to
   `pending[]` → single `Promise.all` at flush. Name what breaks if you remove
   the buffer (lost writes) and if you remove the flush (mid-write exit).
2. **Explain.** Why can't `emit` just `await` the write? (Contract is
   `emit(event): void`, called sync from the agent loop.) Cite
   `supabase-trace-sink.ts:53`.
3. **Apply.** Two events emit A@t1-then-B@t2. Walk why, *despite* the unordered
   `Promise.all` (`:92`) racing the inserts, replay-by-`created_at` still returns
   emit order — citing `at = event.timestamp` (`:55`), the `createdAt: at` push
   (`:59`), and the `coalesce($8::timestamptz, now())` write (`:30`). Then name
   the one case where it still ties (t1 == t2) and the `seq`-column upgrade.
4. **Defend.** Explain why writing `created_at` from the client timestamp was the
   right fix over re-serializing the writes (keeps fire-and-flush non-blocking),
   and name the exact residual condition where it's still imprecise
   (same-millisecond ties) and the phase where a coarse clock stops being enough
   (the deferred multi-writer / cross-device phase).

---

## See also

- `01-app-to-postgres-boundary.md` — where these queued writes actually land.
- `03-deferred-two-brain-shared-memory.md` — what at-least-once + ordering
  becomes when two devices write the same `agents.messages`.
- `audit.md` — Lens 3 (delivery semantics), Lens 6 (queues/ordering verdict),
  Lens 8 (why this is not an outbox).
- `.aipe/study-debugging-observability/` — the trajectory rows as the project's
  evidence trail (not yet generated).

---

Updated: 2026-06-24 — ordering bug reframed from open → RESOLVED: `created_at`
now written from client `event.timestamp` via `coalesce($8::timestamptz, now())`
(`supabase-trace-sink.ts:27-36,55,59-82`), so replay order matches emit order;
same-millisecond tie is the residual edge. Entry point `ask-cmd.ts` → `session.ts`
(`ChatSession.ask`, long-lived session); `flush()` now at `:91-93`; emit handles
all six `CapabilityEvent` variants. Code snippets, diagrams, interview Q, and
Validate re-anchored to current line ranges.
