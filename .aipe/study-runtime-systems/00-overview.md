# Study — Runtime Systems · buffr-laptop

The execution model *inside* this repo: a single event loop, `async`/`await`
over Postgres and Ollama HTTP, a connection pool as the central runtime
resource, and exactly one place where work is queued and later drained. The
repo runs in **two process shapes**: short-lived one-shot CLIs (`index`, `eval`,
`migrate`) and one **long-lived interactive process** (`npm run chat`) that
holds a warm pool, one conversation, and an Ink render loop in memory across
many turns. This is a curriculum — it teaches the runtime concepts that apply to
any Node service, grounded in the files you actually shipped.

The partition line: **how code executes inside one machine** lives here.
*Where* requests cross boundaries lives in `study-system-design`. *How*
behavior is verified lives in `study-testing`. When a topic belongs to a
neighbor, this guide cross-links instead of re-teaching.

---

## The repo in one runtime picture

The thing to hold in your head before anything else: buffr-laptop is no longer
*only* a set of one-shot CLIs. Its **primary path is now a long-lived process** —
`npm run chat` starts an Ink/React terminal UI (`src/cli/chat.tsx:63`), holds
one warm Postgres pool and one conversation in memory (`src/session.ts`), and
keeps the event loop alive on raw-mode TTY stdin until you type `/exit`. The
batch CLIs (`index`, `eval`, `migrate`) keep the old fire-and-exit shape.

```
  buffr-laptop — the runtime as-built (two process shapes)

  ┌─ OS / process layer ─────────────────────────────────────────┐
  │  LONG-LIVED:  `node dist/src/cli/chat.js`                     │
  │   Ink render loop · raw-mode stdin · stays up across turns     │
  │  ONE-SHOT:    `node dist/src/cli/{index,eval}.js` · migrate    │
  │   starts · runs to completion · exits                          │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ owns for its lifetime
  ┌─ Node runtime (single thread) ▼──────────────────────────────┐
  │   ONE event loop · ONE call stack · microtask + macrotask q   │
  │                                                               │
  │   chat: render → [ ask → agent.answer → flush → remember ]ⁿ   │
  │            │            │              │          │           │
  └────────────┼────────────┼──────────────┼──────────┼──────────┘
           pg pool        HTTP          pg pool     pg pool (mem)
  ┌────────▼─────────┐  ┌───────▼────────┐   ┌─────────▼─────────┐
  │ Postgres+pgvector│  │ Ollama (HTTP)  │   │ Postgres (writes) │
  │  reindb / agents │  │ gemma2 + nomic │   │ messages + memory │
  └──────────────────┘  └────────────────┘   └───────────────────┘
   Storage layer         Provider layer        Storage layer

  the whole program is I/O-bound: the CPU mostly waits on these
  three external systems; the event loop's job is to not block while it does
```

Every line hangs off that picture. The pool (`src/db.ts:4`) is the resource —
held for *one run* in the batch CLIs, held *across all turns* in chat. The
`await` chain in `session.ask()` (`src/session.ts:60`) is the per-turn control
flow. The `SupabaseTraceSink` queue (`src/supabase-trace-sink.ts:50`) is the one
place work is deferred and later drained. `pool.end()` is the lifecycle close —
the last line of each batch CLI, and `session.close()` (`src/session.ts:72`) in
chat.

---

## Ranked findings — what's most consequential

Verdict-first. These are ordered by how much they shape the runtime behavior,
and the back half are real risks an interviewer would push on.

1. **The pool's lifetime now diverges by process shape — and chat makes it a
   genuinely long-lived resource.** `src/db.ts:4` hands every entry point a
   `pg.Pool`. The batch CLIs call `await pool.end()` as their *last* line
   (`index-cmd.ts:27`, `eval-cmd.ts:34`, `migrate.ts:30`) — but every `throw`
   before that line skips it, and there's still no `try/finally`. In chat the
   pool is held warm across *every turn* and closed exactly once in
   `session.close()` → `pool.end()` (`src/session.ts:73`), reached only when the
   user types `/exit` (`chat.tsx:18-20`). A crash mid-render or a `SIGINT`
   bypasses `close()` entirely — the pool dies with the process, ungracefully.
   No signal handler anywhere. → `06`, `07`.

2. **`emit()` is sync but the work it triggers is async — the queue-and-flush
   pattern is the most load-bearing runtime mechanic in the repo, and it now
   persists all six event types.** `SupabaseTraceSink.emit()`
   (`supabase-trace-sink.ts:53`) cannot be `async` (aptkit's
   `CapabilityTraceSink` contract is synchronous), so it pushes a *promise* into
   a `pending[]` array via `push()` and returns immediately. A `switch` over
   `event.type` now handles all six `CapabilityEvent` variants — `step`,
   `tool_call_start`, `tool_call_end`, `model_usage`, `warning`, `error` — and
   threads `event.timestamp` into each row's `created_at` (`:55`) so replay
   order matches emit order rather than the flush race. `flush()` (`:91`) awaits
   them all via `Promise.all`. Drop the `flush()` call (`session.ts:63`) and the
   turn returns before the trace rows are written. This is the seam where the
   sync world meets the async world. → `03`, `07`.

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

5. **No bounded concurrency, no cancellation, no timeout — anywhere, and chat
   makes the hang user-visible.** The index loop (`index-cmd.ts:22`) processes
   files strictly one at a time with `await` in a `for` loop. No `AbortSignal`
   is threaded into any Ollama or Postgres call. A hung Ollama request now hangs
   the *interactive* process: `session.ask()` (`session.ts:62`) awaits
   `agent.answer` with no deadline, so the `finally` that clears `busy` never
   runs and the chat UI sits on its spinner (`chat.tsx:13,48`) forever — input
   locked by the busy guard, no way to cancel the in-flight turn. For a
   single-user laptop tool this is tolerable *today* — but it's the first thing
   that breaks the moment a turn stalls. → `07`.

---

## Newly exercised (since the last revision)

Concepts the guide previously listed as *not yet exercised* that the `chat`
process now genuinely exercises. These moved out of the gap list:

- **Long-lived process / interactive loop.** `npm run chat` is no longer
  fire-and-exit. `render(<Chat/>)` (`chat.tsx:63`) starts an Ink reconcile loop
  that keeps the event loop alive on raw-mode TTY stdin; the process stays up
  across many turns until `/exit`. Not a `listen()` server, but a genuine
  long-lived process holding state in memory. → `02`, `03`.
- **Per-turn resource reuse across a held session.** One warm pool + one
  conversation + one agent are built once in `createChatSession`
  (`session.ts:34-57`) and reused every turn — the opposite of the per-call
  wire-up the old `ask` CLI repeated. → `01`, `04`, `06`.

## Not yet exercised

Honest gaps. These are real runtime concepts the repo simply does not touch
yet — named here so the curriculum doesn't invent them.

- **Threads / workers / `worker_threads`.** Single-threaded throughout, in both
  process shapes. No CPU offload, no parallelism primitive. → `02`.
- **Streams / backpressure.** Every file is read whole with `readFile` into a
  string (`index-cmd.ts:23`); embeddings come back as arrays, not streams. No
  `Readable`/`Writable`, no `pipeline()`, no `highWaterMark`. → `06`, `07`.
- **`AbortController` / `AbortSignal` / timeouts / deadlines.** No cancellation
  path exists — and chat has no way to abort an in-flight turn. → `07`.
- **Explicit locks / atomics / `SharedArrayBuffer`.** The only concurrency
  control is Postgres transactions and the test-concurrency flag. → `04`.
- **Manual memory management / GC tuning / heap profiling.** Default V8 GC, no
  `--max-old-space-size`, no streaming means whole files sit in the heap. The
  chat process is long-lived now, so unbounded per-turn growth (the `turns[]`
  React array, accumulated `pending[]`) would matter — but no profiling exists.
  → `05`.
- **Graceful shutdown / signal handlers (`SIGINT`/`SIGTERM`).** Still absent.
  Chat's *normal* exit (`/exit`) drains via `session.close()`, but a `SIGINT`
  (Ctrl-C) kills the long-lived process mid-turn with no flush, no `pool.end()`.
  → `07`.
- **Server loop / `listen()` / daemon.** Chat is long-lived but not a *server* —
  no socket bind, no request multiplexing, no `setInterval`. One user, one
  stdin, one conversation. → `02`.

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
| `02-processes-threads-and-tasks.md` | two process shapes (one-shot CLIs + the long-lived chat loop), one thread, where work runs |
| `03-event-loop-and-async-io.md` | the single event loop, the Ink render loop, microtasks, and the sync/async `emit` seam |
| `04-shared-state-races-and-synchronization.md` | the pool as shared state held across turns; transactions and `--test-concurrency=1` |
| `05-memory-stack-heap-gc-and-lifetimes.md` | whole-file reads, the `pending[]` array, the long-lived `turns[]`, heap pressure, GC |
| `06-filesystem-streams-and-resource-lifecycle.md` | `readFile`, pool clients, `release()`, `pool.end()`, `session.close()` |
| `07-backpressure-bounded-work-and-cancellation.md` | the serial `for await` loop, the missing AbortSignal, shutdown |
| `08-runtime-systems-red-flags-audit.md` | every risk ranked, with `file:line` evidence |

Cross-links at the seams: `03` and `07` both touch the trace-sink queue; `04`
and `06` both touch `pool.connect()`/`release()`; `08` references all seven.

---

Updated: 2026-06-24 — reconciled all 8 concept files to the long-lived `chat`/`session.ts` shape: purged ask-cmd/`npm run ask`; tightened the user-visible-hang spinner ref to `chat.tsx:13,48` (busy `finally` never clears); confirmed the newly-exercised long-lived-process + per-turn-resource-reuse entries against current code.
