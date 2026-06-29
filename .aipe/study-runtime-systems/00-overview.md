# Study — Runtime Systems · buffr-laptop

The execution model *inside* one machine: where work runs, what resources it holds, and what breaks under concurrency or overload. Not "where the services live" (that's `study-system-design`) and not "how we verify behavior deterministically" (that's `study-testing`). This guide is the question:

```
  where does work execute, what does it own, and what breaks under load?
```

## The repo in one frame

buffr-laptop is a single Node process, single-threaded event loop, talking to two out-of-process resources over sockets: Postgres (via a `pg.Pool`) and Ollama (over HTTP). There are two *shapes* of process here, and the whole runtime story splits along that seam.

```
  buffr-laptop — one runtime, two process shapes

  ┌─ LONG-LIVED ────────────────────────────────┐   ┌─ ONE-SHOT BATCH ──────────────────┐
  │  npm run chat                                │   │  npm run migrate / index / eval   │
  │                                              │   │                                   │
  │  Ink render loop (React-in-terminal)         │   │  top-level await, linear:         │
  │  raw-mode TTY stdin held open                │   │   load env → open pool → do work  │
  │  ONE pg Pool warm across every turn          │   │   → pool.end() → process exits    │
  │  ONE conversation, agent built once          │   │                                   │
  │  process stays up until /exit                │   │  lifetime = one batch             │
  └──────────────────────┬───────────────────────┘   └──────────────────┬────────────────┘
                         │  both sit on the same event loop                │
                         ▼                                                  ▼
  ┌─ shared runtime: Node event loop (single thread) ──────────────────────────────────┐
  │  pg.Pool ──socket──► Postgres (reindb)        fetch ──socket──► Ollama (gemma2:9b)  │
  └─────────────────────────────────────────────────────────────────────────────────────┘
```

Everything in this guide is a detail you can hang on that picture: the event loop is the engine, the pool is the resource that outlives a turn, and the chat process is the thing that holds it all open.

## The ranked findings — what to look at first

1. **The warm pool held across turns is the single most consequential runtime decision.** `createChatSession()` opens one `pg.Pool` and keeps it alive for the entire chat session; every `ask()` borrows a connection and returns it. The one-shot CLIs do the opposite — open, drain, `pool.end()`, exit. Same `createPool()` factory (`src/db.ts:4`), opposite lifecycle. → `01-runtime-map.md`, `06-filesystem-streams-and-resource-lifecycle.md`.

2. **The trace sink's sync-emit / async-flush split is the cleanest concurrency pattern in the repo.** `emit()` is synchronous (aptkit's contract forces it), so each event *starts* a DB write and pushes the promise into a `pending[]` array; `flush()` awaits them all after the run (`src/supabase-trace-sink.ts:53-93`). That's a fan-out of unbounded concurrent inserts with a single join point. → `03-event-loop-and-async-io.md`, `07-backpressure-bounded-work-and-cancellation.md`.

3. **There is no cancellation anywhere.** No `AbortSignal`, no timeouts, no SIGINT handler. A turn that hangs on Ollama hangs the whole chat with no way out but Ctrl-C killing the process — and that kill skips `pool.end()`. This is *not yet exercised*, and the guide says so plainly rather than inventing a shutdown path. → `07-backpressure-bounded-work-and-cancellation.md`.

4. **The single-threaded event loop never blocks on CPU — every heavy operation is I/O.** Embedding, generation, and vector search all happen out-of-process (Ollama, Postgres). The Node thread is almost always idle, waiting on a socket. That's why one thread serves the whole app without a worker pool. → `02-processes-threads-and-tasks.md`, `03-event-loop-and-async-io.md`.

5. **State ownership is clean because there's no shared mutable state across concurrent tasks.** The chat UI serializes turns with a `busy` flag (`src/cli/chat.tsx:18,27`); only one `ask()` runs at a time. The one place with genuine concurrency — the trace sink's parallel inserts — shares nothing but an append-only array. → `04-shared-state-races-and-synchronization.md`.

## `not yet exercised` — named honestly

- **Cancellation / deadlines / timeouts.** No `AbortSignal`, no `Promise.race` against a timer, no per-turn deadline. → `07`.
- **Graceful shutdown / signal handling.** No `SIGINT`/`SIGTERM` handler; Ctrl-C kills the process without `pool.end()`. → `06`, `07`.
- **Worker threads / child processes / clustering.** Single thread, single process. No `worker_threads`, no `cluster`. → `02`.
- **Locks / atomics / shared-memory concurrency.** No `Atomics`, no `SharedArrayBuffer`, no mutex. Concurrency is task-level (promises), not thread-level. → `04`.
- **Backpressure / bounded queues.** The trace sink's `pending[]` is unbounded; nothing caps in-flight inserts. → `07`.
- **Explicit GC / memory tuning / streams.** No manual heap management, no Node `stream` plumbing, no `--max-old-space-size`. → `05`, `06`.
- **Connection-pool tuning.** `pg.Pool` runs on library defaults (max 10); no `max`/`idleTimeoutMillis` set. → `06`.

## Reading order

```
  00-overview ······· you are here
  01-runtime-map ···· the process/resource map as-built — read this next
  02-processes ······ one thread, why it's enough, where work actually runs
  03-event-loop ····· async/await, microtasks, the I/O that keeps the thread idle
  04-shared-state ··· why there are almost no races here (and the one spot to watch)
  05-memory ········· V8 heap, closures that outlive a turn, the embedding arrays
  06-filesystem ····· the pool as a descriptor pool, TTY raw mode, cleanup
  07-backpressure ··· bounded work, cancellation, shutdown — mostly the gaps
  08-red-flags ······ ranked execution-model risks with evidence
```

Each concept file is self-contained and follows the same shape: zoom out to the map, read the skeleton, walk the mechanism against real `file:line` code, then a primary recap diagram and interview defense.

## Partition — what this guide does NOT cover

```
  study-runtime-systems  ← HOW code executes inside this one Node process
  study-system-design       WHERE buffr / Postgres / Ollama live, how requests cross
  study-testing             HOW the node:test suite verifies behavior deterministically
  study-database-systems    HOW Postgres stores/indexes/isolates underneath the pool
```

When a finding is really about *the boundary* (buffr → Postgres → Ollama topology), it belongs to `study-system-design`; this guide cross-links rather than re-teaches.
