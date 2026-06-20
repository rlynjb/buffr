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

**The call stack and `await`.** When `ask-cmd` hits `await agent.answer(...)`,
the function suspends, the stack unwinds, and the event loop is free. When the
agent's promise settles, the continuation (everything after the `await`) is
queued as a *microtask* and runs as soon as the stack is empty. Every `await`
in `ask-cmd.ts` is one of these suspend-resume points.

```
  await as suspend/resume — the loop's core move

  stack:  [ask-cmd] ──await agent.answer──► (suspend, stack empty)
                                                  │
            event loop idle, free to run other tasks
                                                  │
          agent promise settles ──► microtask: resume ask-cmd after the await
  stack:  [ask-cmd continues] ──► await trace.flush ...
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

The load-bearing part people forget is **`flush()`**. Without it the agent
finishes, the await chain reaches `pool.end()`, and the process exits while
trace writes are still settling — the rows silently never land. `ask-cmd.ts:35`
calls `await trace.flush()` *before* `pool.end()` for exactly this reason.

**Optional hardening (absent).** A real system would catch per-write failures
(`Promise.allSettled` instead of `Promise.all` so one failed write doesn't
reject the whole flush), and would cap how many writes can be in flight. buffr
does neither — `flush` uses `Promise.all` (`:38`), so a single failed trace
write rejects `flush` and throws past `pool.end()`. That's a real edge, named
in `08`.

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

  exit order in ask-cmd:  agent.answer → trace.flush → pool.end → exit
  reorder these and you lose data or close the pool mid-write
```

---

## Implementation in codebase

**Use cases.** The queue-and-drain pattern is reached for exactly once: capturing
the agent's trajectory during `ask-cmd`. aptkit emits `step` and `tool_call_end`
events synchronously as the agent reasons; buffr persists each as a row without
blocking the agent loop.

**The seam, line by line** (`src/supabase-trace-sink.ts`, lines 27–39):

```
  src/supabase-trace-sink.ts  (lines 27–39)

  emit(event: CapabilityEvent): void {                ← SYNC: returns void, not Promise
    const { pool, conversationId } = this.opts;
    if (event.type === 'step' && event.role === 'assistant' && event.content) {
      this.pending.push(                              ← enqueue, do NOT await
        persistMessage(pool, conversationId, 'assistant', event.content));
    } else if (event.type === 'tool_call_end') {       ← tool result → a row too
      this.pending.push(
        persistMessage(pool, conversationId, 'tool', event.toolName,
                       { toolResults: event.result }));
    }
  }                                                    ← returns NOW; writes still pending

  async flush(): Promise<void> {
    await Promise.all(this.pending);                   ← drain: park until all settle
  }
       │
       └─ emit can't be async (aptkit's contract, see the class doc-comment
          lines 21-22). So the write is fired into pending[] and the awaiting
          is deferred to flush(). Promise.all means one rejected write rejects
          the whole flush — see 08 for that edge.
```

**The drain ordering that protects the data** (`src/cli/ask-cmd.ts`, lines 34–38):

```
  src/cli/ask-cmd.ts  (lines 34–38)

  const answer = await agent.answer(question);  ← agent runs, emit() fires writes
  await trace.flush();                          ← ★ DRAIN before exit — load-bearing ★
  process.stdout.write(`\n${answer}\n`);
  await pool.end();                             ← only now safe to close the pool
       │
       └─ flush() BEFORE pool.end() is the whole correctness argument. Swap the
          two lines and Promise.all may still be awaiting writes against a pool
          that's mid-teardown. Drop flush() entirely and the process exits with
          rows unwritten (see 07 for graceful-shutdown framing).
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
weaker choice — `Promise.all` rejects on the first failed write, throwing past
`pool.end()` and leaking the pool. `allSettled` would drain everything and let
you inspect failures. buffr uses `all` (`:38`); for a single-user laptop that's
acceptable, but it's the honest weak spot. *Anchor:* `all` = fail-fast,
`allSettled` = drain-everything.

---

## Validate

1. **Reconstruct:** draw the queue-and-drain skeleton and name what breaks if
   you remove `pending[]`, the `push`, or `flush`.
2. **Explain:** why can't `emit` (`supabase-trace-sink.ts:27`) be `async`? What
   in aptkit's contract forbids it (see the doc-comment, lines 21–22)?
3. **Apply:** you move `await trace.flush()` to *after* `pool.end()` in
   `ask-cmd.ts`. What goes wrong at runtime?
4. **Defend:** argue for switching `flush` to `Promise.allSettled`. What does
   the repo gain, what does it give up, and is it worth it for a laptop CLI?

---

## See also

- `02-processes-threads-and-tasks.md` — the single thread the loop drives
- `05-memory-stack-heap-gc-and-lifetimes.md` — what `pending[]` costs while it fills
- `07-backpressure-bounded-work-and-cancellation.md` — flush as graceful shutdown
- `08-runtime-systems-red-flags-audit.md` — the `Promise.all` fail-fast edge
