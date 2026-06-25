# 03 · Event Loop and Async I/O

**The event loop, microtasks, and the sync/async `emit` seam** · *Industry standard*

---

## Zoom out, then zoom in

The single thread from `02` doesn't sit idle — the event loop keeps it busy by
running whatever task is ready next. In buffr the event loop's most interesting
moment is one specific seam: aptkit hands buffr a *synchronous* `emit(event)`
callback, but the work that callback wants to do — writing a row to Postgres —
is *asynchronous*. Bridging sync-in / async-out without blocking is the whole
trick, and buffr solves it with a queue.

```
  Zoom out — where the event loop sits

  ┌─ Library layer (aptkit) ─────────────────────────────────────┐
  │  RagQueryAgent loop  →  calls sink.emit(event)  SYNCHRONOUSLY │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ sync call, must return now
  ┌─ buffr glue ──────────────────▼──────────────────────────────┐
  │  ★ SupabaseTraceSink.emit ★  push promise, return immediately │ ← here
  └───────────────────────────────┬───────────────────────────────┘
                                  │ async I/O, runs on the loop
  ┌─ Storage layer ───────────────▼──────────────────────────────┐
  │  Postgres write (pool.query) — resolves later                │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is the **event loop** — the scheduler that decides which
parked task resumes next — and its two queue tiers: microtasks (resolved
promises, `await` continuations) and macrotasks (timers, I/O callbacks).

---

## Structure pass

**Layers, by "what the loop is doing":**

```
  Layer              The loop's job there
  ─────────────────  ─────────────────────────────────────────
  await chain (CLI)  resume the next .then after a promise settles
  emit() callback    accept sync work, defer the async part
  pending[] queue    hold promises that haven't settled yet
  flush()            drain the queue: Promise.all parks until all settle
```

**Axis traced — "is this synchronous or asynchronous?"** Watch it flip across
the `emit` seam:

```
  "does this return a value now, or a promise for later?"

  ┌─ aptkit agent ─┐   emit()   ┌─ buffr sink ────┐
  │ SYNC: needs    │ ═══════════►│ SYNC signature, │  ← the seam: sync in
  │ emit to return │  (it flips) │ ASYNC work fired│     async out
  └────────────────┘             └─────────────────┘
         ▲                              ▲
         └── must not block ────────────┘
             so the write is queued, not awaited inline
```

**Seams:**

- **sync ↔ async (the `emit` seam).** This is *the* load-bearing seam of the
  file. aptkit's `CapabilityTraceSink` contract makes `emit` synchronous; buffr
  cannot `await` inside it without changing the contract, so it pushes the
  promise and returns. The async work runs on the event loop afterward.
- **fired ↔ awaited (the `flush` seam).** Promises pushed in `emit` are
  *fired* but not *awaited* until `flush()`. Skip `flush()` and the process can
  exit with promises still pending — writes lost.

---

## How it works

### Move 1 — the mental model

You know how `setState` in React doesn't update the value on the next line —
it *schedules* a re-render and moves on? `emit()` here is the same move. It
doesn't do the write; it schedules the write and returns instantly. The event
loop runs the actual write later, when the call stack is clear.

```
  Fire-and-queue — the shape of emit()

   sync caller ──► emit(event) ──► push promise to pending[] ──► RETURN
                                        │
                                        │ (the write happens later,
                                        ▼  on the event loop)
                                   pg write resolves ──► row in DB

   the call returns BEFORE the write finishes — that's the point
```

### Move 2 — the loop, one part at a time

**The call stack and `await`.** When `session.ask` hits `await agent.answer(...)`,
the function suspends, the stack unwinds, and the event loop is free. When the
agent's promise settles, the continuation (everything after the `await`) is
queued as a *microtask* and runs as soon as the stack is empty. Every `await`
in `session.ts:60-70` is one of these suspend-resume points. In `chat` this
matters extra: while that turn is parked, the event loop is free to run Ink's
render loop — that's why the `thinking…` spinner (`chat.tsx:48-51`) animates
*during* the await instead of freezing.

```
  await as suspend/resume — the loop's core move

  stack:  [session.ask] ──await agent.answer──► (suspend, stack empty)
                                                  │
            event loop idle, free to run other tasks (incl. Ink render)
                                                  │
          agent promise settles ──► microtask: resume session.ask after the await
  stack:  [session.ask continues] ──► await trace.flush ...
```

**Microtasks vs macrotasks.** Two queues, strict priority. Resolved promises
and `await` continuations go to the *microtask* queue, drained completely
before the loop touches the *macrotask* queue (I/O callbacks, timers). buffr
never uses timers, so in practice the loop here is: run stack → drain
microtasks → poll I/O → repeat. The ordering matters for one reason — every
`persistMessage` promise resolution is a microtask, so they all flush before
the process considers exiting.

**The `emit` seam — sync signature, async body.** `emit(event)` must return
synchronously (aptkit calls it inline in its agent loop and doesn't `await` it).
buffr cannot block there, so it constructs the `persistMessage(...)` promise —
which *starts* the Postgres write — and pushes it into `pending[]`. The promise
is now "in flight" on the event loop. `emit` returns. The kernel of the pattern:

```
  Skeleton: queue-and-drain

   1. pending[]              ← the buffer that survives between emit calls
   2. emit → pending.push(p) ← enqueue without awaiting (keeps emit sync)
   3. flush → Promise.all    ← drain: park until every queued task settles

   what breaks if removed:
   • drop pending[]      → nowhere to hold the in-flight writes; lost
   • drop the push       → emit does nothing; no trace persisted
   • drop flush          → process may exit with writes unfinished → DATA LOSS
```

The load-bearing part people forget is **`flush()`**. Without it the turn
returns, `session.ask` resolves the answer to the UI, and the next turn (or
`/exit` → `pool.end()`) can fire while trace writes are still settling — the rows
silently never land. `session.ts:63` calls `await trace.flush()` *after*
`agent.answer` and *before* returning the answer for exactly this reason. (In a
long-lived chat there's no `pool.end()` per turn, so the risk shifts from
"process exits mid-write" to "pool closed at `/exit` mid-write" — same seam, same
fix.)

**Optional hardening (absent).** A real system would catch per-write failures
(`Promise.allSettled` instead of `Promise.all` so one failed write doesn't
reject the whole flush), and would cap how many writes can be in flight. buffr
does neither — `flush` uses `Promise.all` (`:92`), so a single failed trace
write rejects `flush` and throws out of `session.ask` — which `chat.tsx`'s
`try/catch` (`:30-31`) catches and renders as an error turn, so the *session*
survives even though that turn's trace is lost. That's a real edge, named in
`08`.

**Ordering inside the row, not just between calls.** A subtlety the trace sink
now adds: because all 6 event types are fired into `pending[]` as concurrent
writes, their *insert* order races. So `emit()` threads `event.timestamp` into
each row's `created_at` (`coalesce($8::timestamptz, now())`,
`supabase-trace-sink.ts:30,55`). Replay order then follows emit order, not the
flush race — the event loop decides *when* each write lands, the timestamp
decides how the trajectory reads back.

### Move 3 — the principle

**When a contract is synchronous but the work is asynchronous, queue the work
and drain at a boundary.** The sync callback's job becomes "enqueue," and a
later explicit drain (`flush`) owns the waiting. This decouples *when work is
requested* from *when it's guaranteed done* — and the drain point is where you
must not forget to await, or the runtime exits out from under your I/O.

---

## Primary diagram

```
  The emit→queue→flush lifecycle, full picture

  ┌─ Library (aptkit) ────────────────────────────────────────────┐
  │  agent loop step ──► sink.emit(event)  [synchronous call]      │
  └──────────────────────────────┬────────────────────────────────┘
                                 │ returns immediately
  ┌─ buffr glue ─────────────────▼────────────────────────────────┐
  │  emit: pending.push( persistMessage(...) )                     │
  │              │                                                 │
  │   pending[]: [ p1 ][ p2 ][ p3 ]   ← promises in flight         │
  │              │                                                 │
  │  flush: await Promise.all(pending)  ← drains at the end        │
  └──────────────┬─────────────────────────────────────────────────┘
                 │ each p is a pg write on the event loop
  ┌─ Storage ────▼────────────────────────────────────────────────┐
  │  agents.messages rows — guaranteed written only AFTER flush    │
  └───────────────────────────────────────────────────────────────┘

  per-turn order in session.ask:  agent.answer → trace.flush → memory.remember → return
  exit (once, at /exit):          session.close() → pool.end()
  reorder flush after the return and you race the next turn against unwritten rows
```

---

## Implementation in codebase

**Use cases.** The queue-and-drain pattern is reached for once per chat turn:
capturing the agent's trajectory. aptkit emits all 6 `CapabilityEvent` types
synchronously as the agent reasons — `step`, `tool_call_start`, `tool_call_end`,
`model_usage`, `warning`, `error` — and buffr persists each as a row without
blocking the agent loop.

**The seam, line by line** (`src/supabase-trace-sink.ts`, lines 53–93):

```
  src/supabase-trace-sink.ts  (lines 53–93)

  emit(event: CapabilityEvent): void {                ← SYNC: returns void, not Promise
    const { pool, conversationId } = this.opts;
    const at = event.timestamp;                        ← thread the emit time in
    switch (event.type) {                              ← all 6 variants persisted
      case 'step':
        if (event.content)
          this.push(persistMessage(..., event.role, event.content, { createdAt: at }));
        return;
      case 'tool_call_start':                          ← args (the cause) — was dropped before
        this.push(persistMessage(..., 'tool_call', event.toolName, {...args, createdAt: at }));
        return;
      case 'tool_call_end':                            ← result + durationMs + error
      case 'model_usage':                              ← fills tokens_used column
      case 'warning': case 'error':                    ← operational signals → rows too
        this.push(...);
        return;
    }
  }                                                    ← returns NOW; writes still pending

  private push(p) { this.pending.push(p); }            ← enqueue, do NOT await

  async flush(): Promise<void> {
    await Promise.all(this.pending);                   ← drain: park until all settle
  }
       │
       └─ emit can't be async (aptkit's contract, doc-comment lines 39-48). So
          each write is fired into pending[] via push() and the awaiting is
          deferred to flush(). createdAt threads event.timestamp so replay order
          survives the concurrent-insert race. Promise.all means one rejected
          write rejects the whole flush — see 08 for that edge.
```

**The drain ordering that protects the data** (`src/session.ts`, lines 60–70):

```
  src/session.ts  (lines 60–70)

  await persistMessage(pool, conversationId, 'user', question);  ← user turn first
  const answer = await agent.answer(question);  ← agent runs, emit() fires trace writes
  await trace.flush();                          ← ★ DRAIN before returning — load-bearing ★
  try { await memory.remember({ conversationId, question, answer }); }
  catch { /* best-effort: memory failure must not lose the answer */ }
  return answer;                                ← only now hand the answer back to the UI
       │
       └─ flush() BEFORE return is the correctness argument. The pool is NOT
          closed here (it's held warm for the next turn) — close()/pool.end()
          happens once at /exit. memory.remember is wrapped so a failed memory
          write can't reject the turn the user already has. (see 07.)
```

---

## Elaborate

The microtask/macrotask split is the JavaScript event loop's defining feature,
formalized by the HTML spec and matched by Node via libuv's phases (timers,
poll, check, close). `await` continuations and `.then` callbacks are
microtasks; `setTimeout` and I/O completions are macrotasks. The practical rule:
microtasks always fully drain between macrotasks, which is why a flood of
resolved promises can starve a timer.

The queue-and-flush pattern buffr uses is the standard answer to "I have a sync
hook but async work" — the same shape appears in logging libraries (buffer log
lines, flush on exit), analytics SDKs (`beforeunload` flush), and write-behind
caches. The danger is always identical: forgetting to drain before the runtime
tears down. See `07` for the graceful-shutdown angle and `05` for what the
`pending[]` array costs in memory while it fills.

---

## Interview defense

**Q: aptkit's `emit` is synchronous but you need to write to Postgres. How?**

```
  sync emit, async write — the bridge

  emit(e): void {           ┌─ pending[] ─┐
    pending.push(write(e))  │ [p1][p2]... │  ← fired, not awaited
  }                         └──────┬──────┘
                                   │ later
  flush(): await Promise.all(pending)  ← one drain point owns all the awaiting
```

You can't await inside a sync callback without breaking the contract, so you
*start* the write (which gives you a promise) and stash it. A later `flush()`
awaits the whole batch. *Anchor:* the part people forget is calling `flush`
before exit — without it the process dies with writes pending and the rows
silently never land.

**Q: Why `Promise.all` and not `Promise.allSettled` in `flush`?** It's the
weaker choice — `Promise.all` rejects on the first failed write, throwing out of
`session.ask`. In chat that throw is caught by `chat.tsx`'s `try/catch`
(`:30-31`) and rendered as an error turn, so the session survives but that turn's
whole trace is lost. `allSettled` would drain everything and let you inspect
failures. buffr uses `all` (`:92`); for a single-user laptop that's acceptable,
but it's the honest weak spot. *Anchor:* `all` = fail-fast, `allSettled` =
drain-everything.

---

## Validate

1. **Reconstruct:** draw the queue-and-drain skeleton and name what breaks if
   you remove `pending[]`, the `push`, or `flush`.
2. **Explain:** why can't `emit` (`supabase-trace-sink.ts:53`) be `async`? What
   in aptkit's `CapabilityTraceSink` contract forbids it (doc-comment 39-48)?
   And why does it now thread `event.timestamp` into `created_at`?
3. **Apply:** you move `await trace.flush()` to *after* `return answer` in
   `session.ts`. What races the next turn at runtime?
4. **Defend:** argue for switching `flush` to `Promise.allSettled`. What does
   the repo gain, what does it give up, and is it worth it for a laptop CLI?

---

## See also

- `02-processes-threads-and-tasks.md` — the single thread the loop drives (and the Ink loop)
- `05-memory-stack-heap-gc-and-lifetimes.md` — what `pending[]` costs while it fills
- `07-backpressure-bounded-work-and-cancellation.md` — flush as graceful shutdown
- `08-runtime-systems-red-flags-audit.md` — the `Promise.all` fail-fast edge

---

Updated: 2026-06-24 — re-grounded emit() on the 6-type switch + `event.timestamp`→`created_at`; moved drain ordering from `ask-cmd.ts` to `session.ts:60-70` (flush before return, pool held warm); added the Ink render loop running during the parked `await`.
