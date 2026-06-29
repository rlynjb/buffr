# Event Loop and Async I/O — the engine under every await

**Industry name(s):** the event loop, microtask/macrotask queues, non-blocking async I/O, the sync-emit / async-flush queue · *Industry standard*

---

## Zoom out, then zoom in

This is the file the whole repo runs *on*. Every `await pool.query`, every `await fetch` to Ollama, every Ink re-render is a task scheduled by the event loop. The most interesting repo-specific pattern lives here too: the **trace sink** that emits *synchronously* (because aptkit's contract demands it) but does its DB writes *asynchronously*, collecting them in a queue and draining once with `flush()`.

```
  Zoom out — the event loop under the stack

  ┌─ Interface ──────────────────────────────────────────────┐
  │  Ink render loop  ·  CLI await chains                     │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Runtime ────────────────▼───────────────────────────────┐
  │  ★ THE EVENT LOOP ★  microtasks · macrotasks · I/O poll  │ ← we are here
  │  the sync-emit / async-flush queue (trace sink)          │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Storage / Provider ─────▼───────────────────────────────┐
  │  pg sockets (non-blocking)     Ollama HTTP (non-blocking) │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the event loop is a `while` loop that, each tick, drains all pending microtasks (Promise continuations), then runs the next macrotask (a timer, an I/O completion). "Async I/O" means the slow part is the OS's job, not the thread's. The repo's one hand-built piece is the sink's queue — worth the deep walk.

---

## The structure pass

**Layers.** Three nested levels of scheduling: the **macrotask** level (I/O completions, timers — coarse), the **microtask** level (Promise `.then`/`await` continuations — fine, drained fully between macrotasks), and the **synchronous** level (code that runs start-to-finish with no yield).

**Axis — trace `guarantees`: is this work synchronous (runs now, blocks) or asynchronous (scheduled, yields)?**

```
  One axis, three altitudes: "does this yield the loop, or block it?"

  ┌─ synchronous ────────────────┐  blocks: assertDim(), toVectorLiteral(),
  │  runs to completion, no yield │           emit()'s switch, JSON.stringify
  └───────────────────────────────┘
      ┌─ microtask ──────────────┐  yields then resumes ASAP: every `await`
      │  Promise continuation     │  persistMessage continuation, .then
      └───────────────────────────┘
          ┌─ macrotask ──────────┐  yields, resumes on event: I/O done,
          │  I/O completion/timer │  Ollama response arrives, pg row returns
          └───────────────────────┘
```

The answer flips as you descend: `emit()` is synchronous (must be — see the seam), but each `persistMessage` it spawns is async, resolving as a macrotask when Postgres replies.

**Seam — the `emit()` boundary.** This is *the* load-bearing seam in the file (`src/supabase-trace-sink.ts:53`). On aptkit's side, `CapabilityTraceSink.emit` is declared `void` — synchronous, fire-and-forget, no `await`. On buffr's side, the actual work (a DB insert) is inherently async. The `guarantees` axis flips across this one method signature: caller expects "returns instantly," reality is "I/O that takes milliseconds." The repo bridges the flip with a queue.

---

## How it works

### Move 1 — the mental model

You've seen `Promise.all([...])` fire several `fetch`es and wait for all of them. The trace sink is that pattern turned inside out: instead of awaiting at the call site, it **stashes each Promise in an array and awaits the whole array later.** The synchronous `emit()` can't `await` (its signature forbids it), so it does the only thing a sync function can do with an async call — kick it off and remember it.

```
  The sync-emit / async-flush queue — pattern shape

  agent emits events (synchronously, rapid-fire)
    emit(step)        ─► persistMessage(...) ─┐
    emit(tool_start)  ─► persistMessage(...) ─┤  each returns a Promise,
    emit(tool_end)    ─► persistMessage(...) ─┤  none awaited yet
    emit(model_usage) ─► persistMessage(...) ─┘
                              │ pushed onto
                              ▼
                       pending: Promise[]   ◄── the queue
                              │
        ... agent run finishes ...
                              ▼
                  await flush()  ──► Promise.all(pending)
                  (drains every queued write in one go)
```

The kernel: a queue that decouples *when work is requested* (synchronously, mid-run) from *when it's awaited* (once, after the run).

### Move 2 — the walkthrough

**`emit()` is synchronous by contract.** aptkit's `CapabilityTraceSink.emit(event): void` — no Promise return, no `await` allowed. The agent calls it inline as it runs (a `step`, then a `tool_call_start`, etc.). Look at the signature and the synchronous `switch`:

```ts
// src/supabase-trace-sink.ts:53-59 — sync emit, fire-and-collect
emit(event: CapabilityEvent): void {     // ← void: cannot be async
  const { pool, conversationId } = this.opts;
  const at = event.timestamp;
  switch (event.type) {
    case 'step':
      if (event.content) {
        this.push(persistMessage(pool, conversationId, event.role, event.content, { createdAt: at }));
        //        └─ returns Promise<void>, NOT awaited — handed to push()
      }
      return;
```

The whole `switch` runs synchronously to completion. `persistMessage` returns a Promise that's immediately handed to `push`, never awaited here. That's deliberate: awaiting inside `emit` is impossible (wrong return type) and would serialize the agent's event stream behind DB latency even if it were possible.

**`push()` is the queue — one line.** It appends to `pending[]`:

```ts
// src/supabase-trace-sink.ts:87-89
private push(p: Promise<void>): void {
  this.pending.push(p);   // the write is already in flight; we keep the handle to await later
}
```

The subtle point: by the time `push` runs, the insert is *already executing* on Postgres (calling `persistMessage` started it). `pending[]` doesn't hold "work to do" — it holds "work in flight, await-handles for." The writes run concurrently against the pool; `flush` just waits for the slowest one.

**`flush()` drains the queue once.** After the agent finishes a turn, the session awaits everything:

```ts
// src/supabase-trace-sink.ts:91-93
async flush(): Promise<void> {
  await Promise.all(this.pending);   // wait for every queued insert to settle
}
```

Called at `src/session.ts:63`, right after `agent.answer` returns and before `memory.remember`. So the ordering guarantee per turn is: answer produced → all trace rows durable → memory written → answer returned to the UI.

```
  one turn's async I/O timeline — layers-and-hops

  ┌─ session.ask ──────────────────────────────────────────────┐
  │ hop 1: await persistMessage(user turn)  ──► pg insert       │
  │ hop 2: await agent.answer(q)                                │
  │        │ during this, agent calls trace.emit() N times:     │
  │        │   each ─► persistMessage ─► pg insert (in flight)  │
  │        │   each ─► pending.push(handle)                     │
  │        │ agent also awaits Ollama (embed + generate) ◄──HTTP │
  │ hop 3: await trace.flush() ──► Promise.all(pending) drains  │
  │ hop 4: await memory.remember() ──► pg insert (best-effort)  │
  └─────────────────────────────────────────────────────────────┘
       every "await" = a yield point; the loop runs other tasks between
```

**Non-blocking I/O is why none of this freezes.** Every `pool.query` and every Ollama `fetch` hands a socket to the OS and yields. While Postgres is computing the HNSW search or Ollama is generating tokens, buffr's thread is *idle and available* — which is exactly what lets Ink render the spinner (`src/cli/chat.tsx:48-51`) during a long turn. If `persistMessage` were synchronous (it isn't — it's `pool.query`, which is async), the whole UI would lock up on every trace write.

**The microtask vs macrotask detail that matters here.** When `agent.answer` resolves, its continuation in `ask` is a *microtask* — it runs before the loop checks for new I/O. The pg insert completions are *macrotasks* — they fire when the OS reports the socket is readable. So `Promise.all(pending)` in `flush` is waiting on macrotasks (the DB round-trips), interleaved with microtasks (each insert's `.then`). You don't manage this ordering; the loop does. You only need to know that `flush` won't resolve until the slowest *macrotask* (DB round-trip) in the batch lands.

### Move 2 variant — the load-bearing skeleton of the sink's queue

The kernel that makes "sync emit, async write" work:

1. **A synchronous entry point that returns void.** `emit`. *Remove the sync constraint* and you don't need the pattern — you'd just `await` inline. The whole pattern exists *because* the contract is sync.
2. **A handle store.** `pending[]`. *Remove it* and the in-flight writes become un-awaitable — the turn would return before the trace rows are durable, and a fast `pool.end()` (batch) could kill the connections mid-insert.
3. **A single drain point.** `flush` → `Promise.all`. *Remove it* and you have fire-and-forget with no ordering guarantee; `created_at` from `event.timestamp` (`src/supabase-trace-sink.ts:54-55`) is what keeps replay order correct *despite* the concurrent inserts racing.

Optional hardening, not skeleton: the `created_at`-from-event-timestamp trick is hardening on top — it makes replay deterministic even though the inserts finish in arbitrary order. Worth calling out because it's the clever bit: the queue doesn't preserve order, so order is reconstructed from the event timestamp at read time.

### Move 3 — the principle

When an interface forces synchronous *return* but the work is asynchronous, you don't fight the signature — you **decouple request from completion with a queue**: kick the work off now, collect the handle, await the batch later at a point you control. The event loop makes this cheap because the kicked-off work runs concurrently for free. The cost you accept is that you lose call-site ordering — so if order matters, you reconstruct it (here, from `event.timestamp`) rather than enforce it.

---

## Primary diagram

The full sync-emit / async-flush mechanism over one turn.

```
  Sync emit, async flush — full recap

  ┌─ Runtime: the event loop ───────────────────────────────────────┐
  │                                                                 │
  │  agent run (one turn)                                           │
  │  ┌───────────────────────────────────────────────────────────┐ │
  │  │ emit(step)        emit(tool_start)  emit(tool_end)  ...     │ │
  │  │   │                 │                 │                     │ │
  │  │   ▼ sync            ▼ sync            ▼ sync                │ │
  │  │ persistMessage    persistMessage    persistMessage         │ │
  │  │   │ Promise         │ Promise         │ Promise             │ │
  │  │   └──────┬──────────┴──────┬──────────┘                     │ │
  │  │          ▼                 ▼                                 │ │
  │  │      pending[] ◄── push() ── (writes already in flight)     │ │
  │  └───────────────────────┬───────────────────────────────────┘ │
  │                          │ agent.answer resolves                │
  │                          ▼                                       │
  │                  await flush() = Promise.all(pending)           │
  └──────────────────────────┬──────────────────────────────────────┘
                             │ all inserts settled
                             ▼
  ┌─ Storage: Postgres ───────────────────────────────────────────┐
  │  agents.messages — created_at = event.timestamp (replay order) │
  └────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The sync-emit/async-flush split is the same shape as a write-behind buffer or a logging appender that batches flushes — and the same shape as React's own state-update batching (multiple `setState` calls, one render). The deeper idea is **temporal decoupling**: separate "I want this to happen" from "make sure it happened." aptkit forces it by making `emit` synchronous; the alternative design (async `emit` the agent awaits) would couple the agent's progress to DB latency, which is exactly what you don't want in a trace sink — tracing should never slow the thing it traces.

What the repo does *not* do: bound the queue. `pending[]` grows with the number of events in a turn, drained per turn, so it's naturally bounded by one turn's event count (small). If a turn ever emitted thousands of events, this would be the place to add a periodic flush. `not yet exercised` — see `07`.

---

## Interview defense

**Q: "Your trace sink's `emit` is synchronous but it writes to a database. How does that work without blocking?"**

> `emit` returns `void` because aptkit's contract requires it, so I can't `await` inside it. Instead I call `persistMessage` — which kicks off the `pool.query` immediately and returns a Promise — and push that Promise onto a `pending[]` array. The write is already in flight; `emit` just records the handle. After the agent run, `flush` does `Promise.all(pending)` to wait for every insert to land. The writes run concurrently against the pool, so the cost is the slowest single round-trip, not the sum.

```
  the answer in one sketch

  emit (sync, void) ──► start write ──► push Promise to pending[]
       ... N times, all in flight concurrently ...
  flush ──► Promise.all(pending) ──► all durable
  order? reconstructed from event.timestamp, not from insert order
```

**Anchor:** "Sync emit, async flush — the queue is `pending[]` at `src/supabase-trace-sink.ts:50`, drained once at `:91`; replay order comes from `event.timestamp`, not insert order."

---

## See also

- `02-processes-threads-and-tasks.md` — the one thread the loop runs on
- `04-shared-state-races-and-synchronization.md` — why pushing to `pending[]` across awaits is race-free
- `07-backpressure-bounded-work-and-cancellation.md` — the unbounded queue and missing timeouts
- `06-filesystem-streams-and-resource-lifecycle.md` — the pool the async writes run against
