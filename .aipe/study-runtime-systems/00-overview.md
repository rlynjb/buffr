# Study — Runtime Systems · buffr-laptop

The execution model *inside* this repo: one Node process per command, a single
event loop, `async`/`await` over Postgres and Ollama HTTP, a connection pool as
the central runtime resource, and exactly one place where work is queued and
later drained. This is a curriculum — it teaches the runtime concepts that
apply to any Node service, grounded in the files you actually shipped.

The partition line: **how code executes inside one machine** lives here.
*Where* requests cross boundaries lives in `study-system-design`. *How*
behavior is verified lives in `study-testing`. When a topic belongs to a
neighbor, this guide cross-links instead of re-teaching.

---

## The repo in one runtime picture

The thing to hold in your head before anything else: buffr-laptop is not a
server. It is a set of short-lived CLI processes, each one a single trip
through the Node event loop, each one owning a Postgres pool for its lifetime
and then exiting.

```
  buffr-laptop — the runtime as-built

  ┌─ OS / process layer ─────────────────────────────────────────┐
  │  `node dist/src/cli/ask-cmd.js "question"`                    │
  │   one process · starts · runs to completion · exits           │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ owns for its lifetime
  ┌─ Node runtime (single thread) ▼──────────────────────────────┐
  │   ONE event loop · ONE call stack · microtask + macrotask q   │
  │                                                               │
  │   await loadProfile ─► await agent.answer ─► await flush      │
  │        │                    │                     │           │
  └────────┼────────────────────┼─────────────────────┼──────────┘
           │ pg pool            │ HTTP                 │ pg pool
  ┌────────▼─────────┐  ┌───────▼────────┐   ┌─────────▼─────────┐
  │ Postgres+pgvector│  │ Ollama (HTTP)  │   │ Postgres (writes) │
  │  reindb / agents │  │ gemma2 + nomic │   │  messages table   │
  └──────────────────┘  └────────────────┘   └───────────────────┘
   Storage layer         Provider layer        Storage layer

  the whole program is I/O-bound: the CPU mostly waits on these
  three external systems; the event loop's job is to not block while it does
```

Every line of every CLI hangs off that picture. The pool (`src/db.ts:4`) is the
resource. The `await` chain in `ask-cmd.ts` is the control flow. The
`SupabaseTraceSink` queue (`src/supabase-trace-sink.ts:24`) is the one place
work is deferred and later drained. `pool.end()` at the bottom of each CLI is
the lifecycle close.

---

## Ranked findings — what's most consequential

Verdict-first. These are ordered by how much they shape the runtime behavior,
and the back half are real risks an interviewer would push on.

1. **The pool is the runtime's one shared resource, and it's never closed
   on the error path.** `src/db.ts:4` hands every CLI a `pg.Pool`. Each CLI
   calls `await pool.end()` as its *last* line (`ask-cmd.ts:38`,
   `index-cmd.ts:27`, `eval-cmd.ts:34`) — but every `throw` before that line
   (a failed query, an Ollama timeout, a dimension mismatch) skips `pool.end()`
   entirely. The process exits anyway because the event loop empties, but on a
   thrown error the pool's open sockets are torn down by process exit, not by
   graceful drain. No `try/finally`, no signal handler. → `06`, `07`.

2. **`emit()` is sync but the work it triggers is async — the queue-and-flush
   pattern is the most load-bearing runtime mechanic in the repo.**
   `SupabaseTraceSink.emit()` (`supabase-trace-sink.ts:27`) cannot be `async`
   (aptkit's `CapabilityTraceSink` contract is synchronous), so it pushes a
   *promise* into a `pending[]` array and returns immediately. The writes race
   in the background; `flush()` (`:37`) awaits them all at the end via
   `Promise.all`. Drop the `flush()` call and the process can exit before the
   trace rows are written. This is the seam where the sync world meets the
   async world. → `03`, `07`.

3. **`upsert` and `search` use the pool two different ways, and the difference
   is a real transaction-vs-autocommit distinction.** `upsert`
   (`pg-vector-store.ts:38`) checks out a *dedicated client*
   (`pool.connect()`), wraps N inserts in `begin/commit`, and releases it.
   `search` (`:67`) calls `pool.query()` directly — one statement, auto-checked-
   out, auto-released, no transaction. Same `assertDim` guard runs *before*
   either touches the pool, so a bad vector never opens a transaction. → `04`,
   `06`.

4. **`--test-concurrency=1` is a deliberate serialization of the test
   runtime.** `package.json` runs `node --test --test-concurrency=1`. The
   integration tests share one real Postgres database and a `beforeEach` that
   `delete`s rows (`supabase-trace-sink.test.ts:18`); running test files in
   parallel would let one file's delete race another file's insert. Forcing
   concurrency to 1 trades wall-clock speed for a race-free shared resource.
   This is the repo's clearest synchronization decision. → `04`.

5. **No bounded concurrency, no cancellation, no timeout — anywhere.** The
   index loop (`index-cmd.ts:22`) processes files strictly one at a time with
   `await` in a `for` loop. No `AbortSignal` is threaded into any Ollama or
   Postgres call. A hung Ollama request hangs the whole process forever. For a
   single-user laptop CLI this is the right call *today* — but it's the first
   thing that breaks the moment this runs unattended or under load. → `07`.

---

## Not yet exercised

Honest gaps. These are real runtime concepts the repo simply does not touch
yet — named here so the curriculum doesn't invent them.

- **Threads / workers / `worker_threads`.** Single-threaded throughout. No CPU
  offload, no parallelism primitive. → `02`.
- **Streams / backpressure.** Every file is read whole with `readFile` into a
  string (`index-cmd.ts:23`); embeddings come back as arrays, not streams. No
  `Readable`/`Writable`, no `pipeline()`, no `highWaterMark`. → `06`, `07`.
- **`AbortController` / `AbortSignal` / timeouts / deadlines.** No cancellation
  path exists. → `07`.
- **Explicit locks / atomics / `SharedArrayBuffer`.** The only concurrency
  control is Postgres transactions and the test-concurrency flag. → `04`.
- **Manual memory management / GC tuning / heap profiling.** Default V8 GC, no
  `--max-old-space-size`, no streaming means whole files sit in the heap. → `05`.
- **Graceful shutdown / signal handlers (`SIGINT`/`SIGTERM`).** Processes exit
  by running out of work, not by catching a signal. → `07`.
- **Long-lived process / daemon / server loop.** Every entry point is
  fire-and-exit. There is no `listen()`, no `setInterval`, no daemon. → `02`.

---

## Reading order

Read top to bottom the first time — each file assumes the skeleton the previous
one laid down.

```
  01 ─► 02 ─► 03 ─► 04 ─► 05 ─► 06 ─► 07 ─► 08
  map    where   the     shared  memory  files   bounded  red
         work    event   state   & GC    &       work &   flags
         runs    loop    & races         cleanup cancel   audit
```

| File | What it gives you |
|------|-------------------|
| `01-runtime-map.md` | the process/task/resource map — the whole runtime in one frame |
| `02-processes-threads-and-tasks.md` | one process per CLI, one thread, where work runs (and doesn't) |
| `03-event-loop-and-async-io.md` | the single event loop, microtasks, and the sync/async `emit` seam |
| `04-shared-state-races-and-synchronization.md` | the pool as shared state; transactions and `--test-concurrency=1` |
| `05-memory-stack-heap-gc-and-lifetimes.md` | whole-file reads, the `pending[]` array, heap pressure, GC |
| `06-filesystem-streams-and-resource-lifecycle.md` | `readFile`, pool clients, `release()`, `pool.end()` |
| `07-backpressure-bounded-work-and-cancellation.md` | the serial `for await` loop, the missing AbortSignal, shutdown |
| `08-runtime-systems-red-flags-audit.md` | every risk ranked, with `file:line` evidence |

Cross-links at the seams: `03` and `07` both touch the trace-sink queue; `04`
and `06` both touch `pool.connect()`/`release()`; `08` references all seven.
