# Event Loop and Async I/O — the engine under every await

**Industry name(s):** the event loop, microtask queue, async/await · **Type:** Industry standard (JS/Node runtime)

## Zoom out, then zoom in

Every `await` you've written in buffr is a handoff to the same machine: the event loop. It's the scheduler that lets one thread juggle a chat UI, a token stream from Ollama, and a fan of concurrent Postgres inserts without any of them blocking the others.

```
  Zoom out — the event loop sits under all of buffr's async code

  ┌─ buffr's async surface ───────────────────────────────────────┐
  │  session.ask()  trace.flush()  pool.query()  Ink re-renders   │
  └───────────────────────────────┬───────────────────────────────┘
                                  │  every await registers a callback with:
  ┌─ The event loop (one thread) ─▼───────────────────────────────┐ ← we are here
  │  microtask queue (promises)  ·  timer/I-O/poll phases         │
  │  pulls the next ready callback, runs it to completion         │
  └───────────────────────────────┬───────────────────────────────┘
                                  │  parks pending I/O on:
  ┌─ OS async I/O ────────────────▼───────────────────────────────┐
  │  epoll/kqueue — sockets to Postgres + Ollama                  │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: this file answers *what actually happens at an `await`* — where control goes, what gets queued, and the one rule that keeps it all correct (a callback runs to completion before any other runs).

## Structure pass

**Layers.** Three: **your async code**, **the event loop** (microtask queue + phases), and **OS async I/O** (the sockets).

**Axis: control — "who runs next?"**

```
  One axis — "who runs next?" — traced down

  ┌────────────────────────────────────────────────┐
  │ your code: runs straight-line UNTIL an await    │  → YOU decide, linearly
  └───────────────────────┬─────────────────────────┘
       ┌──────────────────────────────────────────┐
       │ event loop: picks next ready callback     │  → THE LOOP decides order
       └───────────────────────┬───────────────────┘
            ┌─────────────────────────────────────┐
            │ OS: signals "socket ready" via epoll │  → THE KERNEL decides timing
            └─────────────────────────────────────┘

  control flips from you → loop → kernel and back
```

**The seam: the `await` keyword itself.** On the left of an `await`, control is yours and synchronous. On the right — after the awaited promise settles — control is the loop's to schedule. That single keyword is where straight-line code becomes scheduled code.

## How it works

### Move 1 — the mental model

You know how `setState` in React doesn't update the variable on the next line — the change is queued and applied later? `await` is the same shape: it pauses your function, hands the rest of it to a queue as a callback, and lets the thread go do other ready work. When the awaited thing settles, your callback gets pulled off the queue and your function resumes exactly where it stopped.

```
  The pattern — await splits a function at the seam

  async function ask(q) {
    persistUser(q)          ┐  runs synchronously now
    ─── await agent.answer ─┤◄── PAUSE: rest becomes a queued callback;
    flush()                 ┘    thread goes idle / runs other tasks;
                                 resumes here when answer settles
  }
```

### Move 2 — the walkthrough

**An `await` registers a continuation and yields the thread.** Take `session.ask` (`src/session.ts:60-71`):

```ts
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);  // ← yield #1
  const answer = await agent.answer(question);                   // ← yield #2 (the long one)
  await trace.flush();                                           // ← yield #3
  try { await memory.remember({ conversationId, question, answer }); } catch {}
  return answer;
}
```

At each `await`, the function suspends and the rest of it is parked as a continuation. During `await agent.answer(question)` — which is Ollama generating tokens over HTTP — the thread is *free*. That's why the Ink spinner keeps animating: its re-render callbacks get to run on the same loop while `ask` is parked. → `02` covered why one thread can do this; here's the loop that schedules it.

**The microtask queue runs before the macrotask phases.** This is the part people trip on. Promise continuations (everything after an `await`) go on the **microtask** queue, which the loop drains *completely* after each macrotask and between phases. Timers, I/O callbacks, and `setImmediate` are **macrotasks** in the loop's phases. Practically: a resolved promise's `.then` runs before a `setTimeout(…, 0)` queued at the same moment.

```
  One tick of the loop — microtasks drain between everything

  ┌─ run one macrotask (e.g. an I/O callback) ─┐
  │   ... your code runs, hits awaits ...        │
  └───────────────────┬──────────────────────────┘
                      ▼
  ┌─ DRAIN microtask queue COMPLETELY ──────────┐  ← all promise continuations
  │   await-continuations, .then, queueMicrotask │     run here, before the
  └───────────────────┬──────────────────────────┘     next macrotask
                      ▼
  ┌─ next phase: timers → poll(I/O) → check ────┐
  └──────────────────────────────────────────────┘
```

buffr never reaches for `setTimeout` or `setImmediate`, so its async is *all* microtask-driven: promise after promise, draining as fast as I/O settles. There are no timers to reason about — which also means no timeouts, a gap `07` returns to.

**The fan-out in the trace sink is the loop's concurrency on display.** `emit()` is synchronous by contract (aptkit calls it without awaiting), so it *starts* a `persistMessage` promise and stashes it — it does not await:

```ts
// src/supabase-trace-sink.ts:53-89
emit(event: CapabilityEvent): void {      // sync — cannot await
  // ...
  this.push(persistMessage(pool, conversationId, event.role, event.content, { createdAt: at }));
  // ...
}
private push(p: Promise<void>): void { this.pending.push(p); }

async flush(): Promise<void> {
  await Promise.all(this.pending);         // join all the in-flight inserts
}
```

Each `emit` kicks off an insert that immediately parks on a Postgres socket. By the time `flush()` runs, *N* inserts are all in flight at once, multiplexed by the loop across *N* connections from the pool. `Promise.all` is the single join point where the loop waits for the slowest one. This is the cleanest "async I/O without blocking" example in the repo. → `07` notes the missing bound on *N*.

**The blocking hazard: a sync call that doesn't yield.** The loop's correctness rule is *run-to-completion* — once a callback starts, nothing else runs until it returns or hits an `await`. So a synchronous blocking call (a `fs.readFileSync` of a huge file, a tight CPU loop, a sync DB driver) would freeze the loop: no microtasks drain, the spinner stops, every parked insert waits. buffr avoids this — its file reads are `await readFile(...)` (`src/cli/index-cmd.ts:23`, async), and there's no sync compute. The only `readFileSync`-shaped risk would be if someone swapped an async call for a sync one. → `02` covers the CPU-bound version of this hazard.

### Move 3 — the principle

`await` doesn't make code wait — it makes the *thread* not wait. It splits your function at the seam, queues the back half, and frees the loop to serve every other ready callback. The whole model holds together on one rule: each callback runs to completion before the next, so you never have two callbacks half-executed at once. That rule is also why buffr has almost no races (→ `04`).

## Primary diagram

```
  buffr — one turn through the event loop

  ┌─ your code ──────────────────────────────────────────────────────────┐
  │ ask(): persistUser → await answer → await flush → remember            │
  └───┬─────────────────────┬──────────────────────┬────────────────────┘
      │ await (yield)        │ await (yield, long)  │ await (yield)
  ┌───▼─────────────────────▼──────────────────────▼────────────────────┐
  │  EVENT LOOP (one thread)                                             │
  │  microtask queue: [ask-cont] [emit-inserts...] [Ink re-render]       │
  │  drains fully between phases; runs each callback to completion       │
  └───┬─────────────────────┬──────────────────────┬────────────────────┘
      │ socket              │ socket               │ stdout
  ┌───▼──────────┐  ┌───────▼────────────┐  ┌──────▼──────────┐
  │ Ollama HTTP  │  │ Postgres ×N (pool) │  │ terminal (TTY)  │
  │ token stream │  │ inserts in flight  │  │ spinner frames  │
  └──────────────┘  └────────────────────┘  └─────────────────┘
```

## Elaborate

The microtask-vs-macrotask split exists to give promises *priority and predictability*: once a promise resolves, you want its `.then` to run as soon as possible — before the loop wanders off to the next timer or I/O event — so promise chains complete in a tight burst. The cost is a footgun: an infinitely-recursive microtask (a `.then` that schedules another microtask forever) can starve the macrotask phases entirely, so timers never fire. buffr never builds such a chain — its microtasks are finite per turn (one per `await`, *N* per trace flush) — but it's the classic event-loop starvation bug worth naming. The model itself traces back to Node's libuv, which wraps epoll/kqueue/IOCP into the phase machine you see above.

## Interview defense

**Q: Walk me through what happens at `await agent.answer(question)`.**
The `ask` function suspends; everything after the `await` becomes a continuation on the microtask queue. The thread is freed and the loop runs other ready callbacks — the Ink spinner re-renders, any in-flight inserts progress. When Ollama's HTTP response settles, the continuation is pulled off the queue and `ask` resumes with `answer` bound.

```
  await answer ─► suspend, queue continuation ─► thread serves spinner/inserts
              ◄─ Ollama responds ─► resume ask() with answer
```
Anchor: *await frees the thread, not the function — the back half is a queued callback.*

**Q: Microtask vs macrotask — why does it matter here?**
Promise continuations are microtasks and drain completely between phases; timers/`setImmediate` are macrotasks. buffr is all-microtask (no timers anywhere), so its async is a tight drain of promises as I/O settles. The footgun is microtask starvation — an endlessly self-scheduling microtask would block timers forever — but buffr's per-turn microtasks are finite.

```
  [macrotask] → DRAIN all microtasks → [next phase]
  buffr: only microtasks → fast settle, no timer reasoning needed
```
Anchor: *promises jump the queue ahead of timers; buffr never queues a timer.*

## See also

- `02-processes-threads-and-tasks.md` — the one thread this loop drives
- `04-shared-state-races-and-synchronization.md` — run-to-completion is why there are no half-updates
- `07-backpressure-bounded-work-and-cancellation.md` — the unbounded fan-out and the missing timeouts
