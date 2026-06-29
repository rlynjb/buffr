# Sync interface, async work — the trace sink as an observer

**Industry names:** the observer pattern · publish/subscribe · the
write-behind buffer · fire-and-forget with a barrier. **Type:** Industry
standard.

aptkit's agent loop emits events as it runs — a step, a tool call, token
usage. buffr wants to persist all of them to Postgres. The catch: aptkit's
emit contract is *synchronous* (it calls `emit(event)` and moves on, it
won't await you), but writing to Postgres is *asynchronous*. `SupabaseTrace
Sink` bridges that gap: a sync `emit` that queues a promise, and an async
`flush` that drains the queue after the run. That sync-front/async-back
split is the whole design.

Role-vocabulary (observer pattern), named once:

- **the subject** — aptkit's `RagQueryAgent`; the thing being observed; it
  emits events as it runs.
- **the observer** — `SupabaseTraceSink` (`supabase-trace-sink.ts`); it
  subscribes by being passed in, and reacts to each event.
- **notify** — `emit(event)`, the synchronous notification the subject
  calls per event.
- **the subscription** — the `trace` argument handed to the agent
  (`session.ts:57`); how the observer attaches to the subject.
- **flush** — the async barrier that drains queued writes after the run
  (buffr's addition; not part of the classic observer).

---

## Zoom out, then zoom in

The observer sits beside the agent loop, catching every event the loop
emits and turning it into a row in `agents.messages`.

```
  Zoom out — the observer beside the agent loop

  ┌─ aptkit (the subject) ───────────────────────────────────────┐
  │  RagQueryAgent.answer(q)                                      │
  │    ├─ emit(step)          ──┐                                 │
  │    ├─ emit(tool_call_start)──┤ notify() — SYNCHRONOUS,        │
  │    ├─ emit(tool_call_end) ──┤ the loop won't await you        │
  │    ├─ emit(model_usage)   ──┤                                 │
  │    └─ emit(warning|error) ──┘                                 │
  └───────────────────────────────│──────────────────────────────┘
                                  │ each event
  ┌─ buffr (the observer) ────────▼──────────────────────────────┐ ← here
  │  ★ SupabaseTraceSink ★                                        │
  │    emit(e): map → PUSH a pending promise (returns instantly)  │
  │    flush(): await Promise.all(pending)  ← the barrier         │
  └───────────────────────────────│──────────────────────────────┘
                                  │ INSERTs (async, drained at flush)
  ┌─ Storage ─────────────────────▼──────────────────────────────┐
  │  agents.messages  (full-signal trajectory, replayable)        │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the subject (the agent) doesn't know or care that the observer
writes to a database — it just calls `emit` and keeps running. The
observer's job is to react *without blocking the subject*. It can't `await`
inside `emit` (the contract is sync), so it queues the write and lets the
event loop run it later. After the agent finishes, `flush` waits for all
queued writes. That's the bridge between a sync contract and async I/O.

---

## The structure pass

**Layers:** the agent loop (subject) · the `CapabilityTraceSink` contract
(the seam) · the trace sink (observer) · Postgres.

**The axis: is this call synchronous or asynchronous?** Trace it across
emit and flush:

```
  axis traced = "does the caller wait for the work?"

  ┌─ agent.emit(e) ─┐  seam   ┌─ emit() body ─┐   ┌─ flush() ────┐
  │ caller does NOT │ ══╪════►│ queues promise │   │ caller WAITS │
  │ wait (sync)     │        │ returns instantly│  │ (async)      │
  └─────────────────┘        └────────────────┘   └──────────────┘
       sync                      sync push            async drain
            the same data (events) handled two ways:
            captured synchronously, persisted asynchronously
```

The axis flips *inside the observer*: `emit` is the sync face (it must be —
the subject won't await it), `flush` is the async face (it can be — the run
is over). The seam is the `CapabilityTraceSink` contract, and the
load-bearing fact about it is that `emit` returns `void`, not
`Promise<void>` — that's what forces the queue-and-flush design.

---

## How it works

### Move 1 — the mental model

You know this shape from the DOM: `element.addEventListener('click', fn)`.
The browser (subject) calls your handler (observer) synchronously on every
click; your handler can't make the browser *wait* for an async operation —
if you need to do I/O, you kick it off and return. `SupabaseTraceSink` is
exactly that handler, with one addition: a `flush` that lets you await all
the I/O you kicked off, once the clicks stop.

In one sentence: **capture every event synchronously by queuing a promise,
then drain the queue with one async barrier after the run.**

```
  Sync emit / async flush — the kernel

  emit(e) ─► map event ─► push promise to pending[] ─► return (sync)
  emit(e) ─► map event ─► push promise to pending[] ─► return (sync)
  emit(e) ─► ...                                    ─► return (sync)
       ──────────── run ends ────────────
  flush() ─► await Promise.all(pending)            ─► (async barrier)
```

### Move 2 — the load-bearing skeleton

This pattern has an irreducible kernel. Let's isolate it and name each
part by **what breaks when it's missing.**

**The kernel: a pending array + sync push + async drain.**

```ts
// supabase-trace-sink.ts:49-93 (skeleton)
export class SupabaseTraceSink implements CapabilityTraceSink {
  private readonly pending: Promise<void>[] = [];      // ← part 1: the queue

  emit(event: CapabilityEvent): void {                 // ← part 2: sync notify
    switch (event.type) { /* map each variant → persistMessage(...) */ }
  }
  private push(p: Promise<void>): void {
    this.pending.push(p);                              // ← queue, don't await
  }
  async flush(): Promise<void> {
    await Promise.all(this.pending);                   // ← part 3: the barrier
  }
}
```

**Part 1 — the `pending` array.** Remove it and you have nowhere to keep
the in-flight writes. `emit` is sync, so the moment it returns, any promise
it created is unreferenced — without `pending`, the writes either get
garbage-collected mid-flight or you have no handle to await. The array is
what keeps the async work alive across the sync boundary.

**Part 2 — `emit` returns `void`, never awaits.** This is forced by the
contract (`CapabilityEvent` → `void`), and it's the constraint the whole
design exists to satisfy. If you `await` inside `emit`, you'd either change
the contract (you can't — it's aptkit's) or block the agent loop on every
event. So `emit` does the cheap part synchronously — map the event, build
the insert promise — and pushes it. Remove the no-await discipline and you
serialize the agent on database round-trips.

**Part 3 — `flush` as the barrier.** Remove it and the process can exit (or
the next turn can start) with writes still in flight — you lose trajectory
rows nondeterministically. `flush` is called at exactly one place,
`session.ts:63`, *after* `agent.answer()` returns:

```ts
// session.ts:62-63
const answer = await agent.answer(question);   // subject runs, emits sync events
await trace.flush();                           // ← barrier: now wait for all queued writes
```

**The event-mapping — six variants, each a different row.** `emit`'s body
is a `switch` over all six `CapabilityEvent` types, each mapped to a
`messages` row shape (`supabase-trace-sink.ts:56-84`):

```ts
// supabase-trace-sink.ts:62-65  (one variant, annotated)
case 'tool_call_start':
  this.push(persistMessage(pool, conversationId, 'tool_call', event.toolName, {
    toolCalls: { toolName: event.toolName, args: event.args },  // ← the CAUSE, previously dropped
    createdAt: at,                                              // ← event timestamp, not now()
  }));
  return;
```

Two design choices ride here. First, the `switch` has **no `default`** —
an unknown event type is a silent no-op, not an error (audit lens 6:
special case defined out of existence). Second, every variant threads
`createdAt: at` from `event.timestamp`, so replay order matches *emit*
order, not the race between concurrent flush inserts (the class comment at
`:39-48` explains exactly this). Without the timestamp, `Promise.all`'s
nondeterministic completion order would scramble the trajectory.

```
  Layers-and-hops — one event becoming one row

  ┌─ aptkit ───┐ emit(tool_call_start)  ┌─ TraceSink ──┐
  │ agent loop │ ─────────────────────► │ map → push   │ returns sync
  └────────────┘   (sync, no await)     └──────┬───────┘
                                               │ pending[].push(INSERT promise)
                       ── run ends, flush() ──►│
                                               ▼ (async drain)
                                        ┌─ agents.messages ─┐
                                        │ role=tool_call,   │
                                        │ tool_calls={args},│
                                        │ created_at=event.ts│
                                        └───────────────────┘
```

**Hardening vs skeleton.** The skeleton is queue + sync-push + async-drain.
Everything else is hardening: the six-way event mapping (richer data, not a
different pattern), the timestamp-for-ordering (correctness under
`Promise.all`), the `toJsonb` stringify in `persistMessage` that dodges a
node-postgres array-literal gotcha (`:23-25`). Naming which is which is the
lesson — the pattern is three parts; the rest is making it *good*.

### Move 3 — the principle

When you have to satisfy a synchronous contract but do asynchronous work,
you can't await in the hot path — so you **decouple capture from
completion**: capture synchronously (cheap, non-blocking), complete
asynchronously (queued, drained at a barrier). The pending array is the
decoupling buffer; the flush is the barrier that re-couples them when it's
safe to wait. This is the same shape as a write-behind cache, a logging
ring buffer, or React's effect cleanup — anywhere a fast producer can't
block on a slow consumer. The part people forget is the barrier: fire-and-
forget without a `flush` loses data silently, and silent data loss in a
trajectory log is the worst kind, because the gap looks like the agent
simply didn't do anything.

---

## Primary diagram

```
  SupabaseTraceSink — sync observer + async barrier, full recap

  ┌─ aptkit: RagQueryAgent (the subject) ────────────────────────┐
  │  answer(q) loop emits, synchronously:                        │
  │    step · tool_call_start · tool_call_end ·                  │
  │    model_usage · warning · error      (6 CapabilityEvents)   │
  └───────────────────────────┬──────────────────────────────────┘
              notify() = emit() │ SYNC — agent never awaits buffr
  ┌─ buffr: SupabaseTraceSink (the observer) ─▼──────────────────┐
  │  emit(e):  switch(e.type) → persistMessage(...) → pending.push│
  │            no default (unknown = no-op) · createdAt = e.ts    │
  │  pending: [ INSERT, INSERT, INSERT, ... ]   ← the queue       │
  │  flush(): await Promise.all(pending)        ← the barrier     │
  └───────────────────────────┬──────────────────────────────────┘
        called once at session.ts:63, AFTER agent.answer() returns
                              ▼ (async drain)
  ┌─ Storage: agents.messages ───────────────────────────────────┐
  │  full-signal trajectory, ordered by event timestamp, replayable│
  └───────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The observer pattern (Gang of Four) is the base: a subject maintains a list
of observers and notifies them on change, decoupling "something happened"
from "who reacts." aptkit's `CapabilityTraceSink` is a one-observer
specialization — the agent notifies a single sink. The sync/async twist is
buffr's, and it's the part worth studying, because it's where most people
get the design wrong: they either block the producer (await in the handler,
serializing the agent on the database) or fire-and-forget with no barrier
(losing rows on exit). The pending-array-plus-flush is the standard fix,
the same shape as a write-behind buffer in a database or a batched logger.

The timestamp-for-ordering detail connects to a deeper idea: when you
parallelize writes with `Promise.all`, you give up completion order, so any
order you need must be *carried in the data* (here, `event.timestamp` →
`created_at`), not implied by insert sequence. That's a general rule for
async fan-out, not specific to buffr.

---

## Interview defense

**Q: Why doesn't `emit` just `await` the database write?** Because the
contract won't let it — `CapabilityTraceSink.emit` returns `void`, not a
promise, and aptkit's agent loop calls it synchronously without awaiting.
If `emit` did its own `await`, it couldn't actually block the loop (the
loop ignores the return), so the write would become an unhandled floating
promise — exactly the bug the `pending` array prevents. The design queues
the promise so there's a handle to await later, at `flush`.
*Anchor:* "the contract returns void — so the only place you *can* await is
a separate flush, not inside emit."

**Q: What's the load-bearing part people forget?** The flush barrier. The
queue-and-push half is intuitive; the part that gets dropped is awaiting
the queue before the process exits or the next turn starts. Without it
(`session.ts:63`), `Promise.all` never runs and you lose trajectory rows
nondeterministically — and a missing row looks like the agent did nothing,
which is the worst failure mode for a debugging log.

```
  with flush                    without flush (the bug)
  emit → queue → flush:await    emit → queue → (exit)
  all rows land                 in-flight writes lost silently
```
*Anchor:* "fire-and-forget needs a barrier — the flush is the difference
between a complete trajectory and a lossy one."

**Q: Why thread the event timestamp into `created_at`?** Because the writes
run under `Promise.all`, which gives no ordering guarantee — insert
completion order is a race. If `created_at` defaulted to `now()`, the
trajectory would be scrambled by that race. Carrying `event.timestamp`
into the row means replay order matches emit order regardless of which
insert finishes first. When you fan out async writes, any order you need
has to live in the data.
*Anchor:* "parallel writes lose ordering — so the order rides in the
timestamp column, not the insert sequence."

---

## See also

- `03-dependency-as-a-boundary.md` — `CapabilityTraceSink` is another
  aptkit contract buffr implements and injects up.
- `05-deep-session-facade.md` — where `flush` is called in the turn loop.
- `audit.md` lens 6 — the no-`default` switch as a special case erased.
- `study-debugging-observability/` (if present) — the trajectory as a
  debugging artifact.
- `study-testing/` — replay-order determinism as a correctness property.
