# Processes, Threads, and Tasks — where work actually runs

**Industry name(s):** process/thread model, the single-threaded event loop · **Type:** Industry standard (Node runtime)

## Zoom out, then zoom in

Node gives you one thread for *your* code. That's the headline, and buffr leans all the way into it: there are no worker threads, no child processes, no clustering. Every line you wrote runs on one thread — and it gets away with that because almost nothing it does is CPU-bound.

```
  Zoom out — where buffr's work runs

  ┌─ Your code (one JS thread) ──────────────────────────────────┐
  │  chat UI · session.ask() · trace sink · pg-vector-store      │ ← we are here
  │  ALL of buffr's logic runs here, one task at a time          │
  └───────────────────────────────┬───────────────────────────────┘
                                  │  hands heavy work OUT to:
  ┌─ Out-of-process compute ──────▼───────────────────────────────┐
  │  Postgres process(es)  — vector search, inserts               │
  │  Ollama process(es)    — embedding + token generation (the    │
  │                          actually-expensive CPU/GPU work)     │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the question this file answers is *why is one thread enough?* The answer is that buffr is an orchestrator, not a compute engine. It moves bytes between Postgres and Ollama; the expensive math runs in those other processes.

## Structure pass

**Layers.** Two: **your-code** (the single JS thread) and **out-of-process compute** (Postgres, Ollama). There is no middle "worker pool" layer — and its absence is the lesson.

**Axis: control — "who's holding the CPU right now?"**

```
  One axis — "who holds the CPU?" — traced across the boundary

  ┌─ your-code thread ─┐   seam: await on a socket   ┌─ Ollama/PG ─────┐
  │ holds CPU only to  │ ═══════════╪═══════════════► │ holds CPU for   │
  │ build a request &  │  (control hands off)         │ the real work   │
  │ parse a response   │ ◄══════════╪═══════════════  │ (embed/generate)│
  └────────────────────┘   result comes back          └─────────────────┘

  the JS thread is busy for microseconds, idle for the seconds that matter
```

**The seam: every `await` on an out-of-process call.** Control flips there — your thread stops holding the CPU and the OS parks the work on a socket. That seam is *why* one thread suffices: while Ollama spends two seconds generating tokens, your thread is free.

## How it works

### Move 1 — the mental model

Think of a `.map()` over an array that calls `fetch()` for each item. The JavaScript that builds the URLs and reads the responses is yours and runs on one thread — but the network round-trips happen *elsewhere*, in parallel, while your thread waits. buffr is that pattern at the scale of a whole app: the thread's job is to issue I/O and stitch results, not to compute.

```
  The pattern — one thread, work delegated out

     JS thread:  build req → await ─ ─ ─ ─ ─ ─ ─ → read resp → next
                              │ (parked on socket)   ▲
                              ▼                       │
     elsewhere:        Ollama generates tokens ───────┘  (the heavy part)
```

### Move 2 — the walkthrough

**There is exactly one OS process and one JS thread.** Nothing in the repo spawns more. Grep the source and you find no `worker_threads`, no `child_process`, no `cluster`. The chat entry is a plain top-level `await` followed by an Ink `render`:

```ts
// src/cli/chat.tsx:62-63
const session = await createChatSession();
render(<Chat session={session} />);
```

`render` does not fork — Ink draws to the *same* process's stdout and reads the *same* process's stdin. One process, start to finish.

**Heavy work is delegated to other processes over a socket.** The three expensive operations all leave the thread:

- *Embedding* — `OllamaEmbeddingProvider` (`src/session.ts:40`) HTTP-POSTs text to Ollama; the 768-dim vector comes back. The neural net runs in Ollama's process.
- *Generation* — `GemmaModelProvider` (`src/session.ts:46`) streams tokens from Ollama. Token-by-token decoding is the single most expensive thing in a turn, and your thread does none of it.
- *Vector search* — `PgVectorStore.search` (`src/pg-vector-store.ts:67-85`) sends one SQL query; the HNSW index scan runs inside Postgres.

Your thread's actual CPU work per turn is tiny: serialize a vector to a string (`toVectorLiteral`, `src/pg-vector-store.ts:15-17`), `JSON.stringify` some jsonb (`src/supabase-trace-sink.ts:25`), and React reconciliation for the Ink tree. Microseconds, against seconds of waiting.

**"Tasks" here means promises, not threads.** When buffr does several things "at once" — like the trace sink firing multiple inserts — it's scheduling multiple *async tasks* on the one thread, each parked on its own socket. Concurrency without parallelism in your code:

```ts
// src/supabase-trace-sink.ts:53-89 — many tasks, one thread
emit(event): void {
  // ...starts persistMessage(...) — returns a promise, pushes it
  this.push(persistMessage(pool, conversationId, /*...*/));
}
// flush() awaits Promise.all(pending) — all inserts in flight together
```

Those inserts run *concurrently* (all sockets open at once) but not in *parallel* in your code (one thread issued them all). The parallelism is in Postgres. → `03` walks the event loop that makes this work; `04` walks why it's race-free.

**The boundary condition: a CPU-bound task would freeze everything.** If buffr ever did real computation on the JS thread — say, re-ranking 10,000 candidates with a tight numeric loop, or computing embeddings *in-process* instead of calling Ollama — that loop would block the event loop, freeze the Ink UI mid-render, and stall every in-flight insert. It doesn't today, which is exactly why one thread is enough. The moment it does, the answer becomes "move it to a `worker_thread`." That's *not yet exercised*.

### Move 3 — the principle

A single thread is sufficient precisely when your code is I/O-bound — when it spends its life waiting on sockets, not crunching numbers. Node's one-thread model isn't a limitation buffr works around; it's a fit. The instant a workload turns CPU-bound, the model breaks and you reach for workers. Knowing *which* kind of work you have is the whole decision.

## Primary diagram

```
  buffr — one thread, work delegated, tasks multiplexed

  ┌─ Your-code layer: ONE JS thread ─────────────────────────────────────┐
  │                                                                       │
  │  Ink render ── session.ask() ── trace.emit()×N ── vector-store query  │
  │       │             │                  │                  │           │
  │       │ all share the one thread; each awaits its own socket          │
  └───────┼─────────────┼──────────────────┼──────────────────┼───────────┘
          │ stdout/stdin │ HTTP             │ TCP (×N)         │ TCP
  ┌───────▼─────┐  ┌─────▼───────┐   ┌───────▼──────────┐  ┌────▼─────────┐
  │  terminal   │  │ Ollama proc │   │ Postgres (inserts│  │ Postgres     │
  │  (TTY)      │  │ embed+gen   │   │  run in parallel)│  │ HNSW search  │
  └─────────────┘  └─────────────┘   └──────────────────┘  └──────────────┘
        out-of-process compute does the expensive work
```

## Elaborate

The single-threaded-with-async-I/O model came from the C10k problem: thread-per-connection servers fell over under load because OS threads are heavy (megabytes of stack each, context-switch cost). Node's bet was that most servers are I/O-bound, so one thread plus an event loop plus an OS-level async-I/O facility (epoll/kqueue) could multiplex thousands of connections cheaply. buffr is the small-scale version of the same bet: it has two "connections" (Postgres, Ollama) and one user, but the reason it never needs a second thread is identical. The escape hatch — `worker_threads` for CPU-bound work — exists in Node but buffr has never needed it, because it pushed all the compute out to Ollama and Postgres by design.

## Interview defense

**Q: Why does buffr get away with a single thread?**
Because it's I/O-bound, not CPU-bound. The expensive work — embedding, token generation, vector search — runs out-of-process in Ollama and Postgres. The JS thread only builds requests and parses responses, which costs microseconds, then parks on a socket.

```
  JS thread busy:   ▮ (µs)   ▮ (µs)   ▮ (µs)
  waiting on I/O:      ▱▱▱▱▱▱▱▱▱ (seconds, thread free)
```
Anchor: *the heavy math is in Ollama/Postgres; the thread orchestrates.*

**Q: When would this model break, and what would you reach for?**
The moment buffr does real computation on the JS thread — a tight numeric loop, in-process embedding, large-array re-ranking. That blocks the event loop, freezes the Ink UI, and stalls every in-flight insert. The fix is `worker_threads`. It's *not yet exercised* because nothing CPU-bound runs in-process today.

```
  CPU loop on JS thread ──► event loop blocked ──► UI frozen + inserts stalled
  fix: hand the loop to a worker_thread
```
Anchor: *single-thread is a fit for I/O-bound work and a trap for CPU-bound work.*

## See also

- `03-event-loop-and-async-io.md` — the loop that multiplexes those parked tasks
- `04-shared-state-races-and-synchronization.md` — why one thread makes most races impossible
- `07-backpressure-bounded-work-and-cancellation.md` — what bounds the fan-out of tasks (mostly: nothing yet)
