# Study — Runtime Systems · Overview

> The execution model inside `buffr-laptop`: where work runs, what resources it owns, and what breaks under concurrency or overload — grounded in the real files.

This is a **curriculum-style** guide. The eight concept files below teach the runtime fundamentals (event loop, tasks, synchronization, memory, resource lifecycle, bounded work) and anchor each to where the repo does — or pointedly does *not* — exercise it. Where the repo hasn't built a mechanism yet, you'll see `not yet exercised`, said plainly, with the trigger that would make it relevant.

---

## The repo in one runtime picture

The whole system is a **single-threaded Node.js process** (NodeNext ESM) driving an **event loop**, holding one **connection pool (`pgPool`)** open to Postgres, and talking to Ollama over HTTP. There are two process *shapes* sharing this code: one **long-lived interactive process (the chat session)** and three **one-shot batch CLIs (migrate / index / eval)**.

```
  buffr-laptop — the runtime map, one frame

  ┌─ Process layer (one OS process, one V8 thread) ───────────────────┐
  │                                                                   │
  │   the event loop (libuv)                                          │
  │   ┌──────────────────────────────────────────────────────────┐   │
  │   │  microtask queue (Promise .then / await continuations)    │   │
  │   │  macrotask queues (timers, I/O callbacks, check)          │   │
  │   └──────────────────────────────────────────────────────────┘   │
  │                                                                   │
  │   shape A: chat (long-lived)        shape B: migrate/index/eval   │
  │   ┌───────────────────────────┐     ┌──────────────────────────┐  │
  │   │ Ink render loop (React)   │     │ top-level await script   │  │
  │   │ raw-mode TTY stdin        │     │ run → pool.end() → exit  │  │
  │   │ warm pool across turns    │     │ pool opened per process  │  │
  │   └───────────────────────────┘     └──────────────────────────┘  │
  └──────────────────────────────┬────────────────────────────────────┘
                                 │ async I/O (non-blocking sockets)
            ┌────────────────────┼─────────────────────┐
            ▼                                          ▼
  ┌─ Storage (Postgres) ──────┐          ┌─ Provider (Ollama, HTTP) ──┐
  │ connection pool (`pgPool`)│          │ gemma2:9b · nomic-embed    │
  │ pgvector / agents schema  │          │ (fetch over event loop)    │
  └───────────────────────────┘          └────────────────────────────┘
```

Every box here is a real file. The pool is `createPool` (`src/db.ts:4`). The chat process is `src/cli/chat.tsx` + `src/session.ts`. The batch CLIs end with `await pool.end()` (`src/migrate.ts:30`, `src/cli/index-cmd.ts:27`, `src/cli/eval-cmd.ts:34`).

---

## Top findings — ranked by consequence

**1. The two process shapes have different lifetime contracts, and the repo gets the pool lifecycle right for both.** The chat session opens one pool and holds it across every turn (`src/session.ts:39`); `close()` is the only thing that ends it (`src/session.ts:72-74`), wired to `/exit` in the UI (`src/cli/chat.tsx:18-21`). The batch CLIs open a pool, do the work under top-level `await`, then `pool.end()` so the event loop drains and the process exits on its own. The single most load-bearing runtime fact in this repo is that **the chat pool's lifetime is tied to a user typing `/exit`, not to a signal** — see finding 3.

**2. The trace sink is the one place the repo separates sync emission from async work.** `emit()` is synchronous because aptkit's `CapabilityTraceSink` contract demands it (`src/supabase-trace-sink.ts:53`); the actual DB writes are fire-and-collect into a `pending[]` array and awaited once via `flush()` after the agent run (`src/supabase-trace-sink.ts:50,91-93`). This is the repo's only hand-rolled async-queue pattern. → `03-event-loop-and-async-io.md`, `07-backpressure-bounded-work-and-cancellation.md`.

**3. There is no SIGINT handler and no graceful shutdown.** Ctrl-C on the chat process kills it without calling `session.close()`, so the warm pool is never drained — the OS reclaims the sockets, but there's no flush of in-flight trace writes and no clean Postgres disconnect. This is a deliberate single-device tradeoff, not a bug, but it's the first thing that changes if buffr ever runs unattended. → `07`.

**4. Cancellation and deadlines are entirely absent.** No `AbortSignal`, no query timeout, no per-turn deadline. A wedged Ollama call or a slow Postgres query hangs the turn forever; the `busy` flag in the UI (`src/cli/chat.tsx:13,16`) just blocks new input while it hangs. `not yet exercised` — and the honest one to flag in an interview. → `07`.

**5. Shared mutable state is real but single-threaded-safe.** React state in the Ink component (`turns`, `busy` — `src/cli/chat.tsx:11-13`) and the `pending[]` array in the sink are mutated across `await` points, but because Node runs one callback to completion before the next, there are no data races. The one genuine concurrency hazard — `await` interleaving on the `busy` guard — is closed by the synchronous `if (busy) return` check at the top of `onSubmit`. → `04`.

---

## `not yet exercised` — named honestly

| Mechanism | Status | When it becomes relevant |
|---|---|---|
| Worker threads / `child_process` | not yet exercised | CPU-bound work off the main loop (embedding is offloaded to Ollama, so never local) |
| `AbortSignal` / cancellation | not yet exercised | a turn needs a deadline or a cancel key |
| Query / request timeouts | not yet exercised | Ollama or Postgres can wedge a turn |
| SIGINT / SIGTERM handler | not yet exercised | unattended runs, or guaranteeing trace flush on exit |
| Bounded concurrency / queue limits | not yet exercised | concurrent turns or batch indexing of large corpora |
| Backpressure on streams | not yet exercised | streaming model output token-by-token to the TTY |
| Explicit GC / heap tuning | not yet exercised | long sessions accumulating `turns[]` unboundedly |
| Pool size limits / saturation handling | not yet exercised (defaults) | multiple concurrent agents on one pool |
| File streaming (`createReadStream`) | not yet exercised | indexing files too large for `readFile` into memory |

---

## Reading order

```
  00-overview            ← you are here
  01-runtime-map         the process/task/resource map as-built
  02-processes-threads   one V8 thread; two process shapes; no workers
  03-event-loop          microtasks, await, the sync-emit/async-flush queue
  04-shared-state        React state + pending[] across await; the busy guard
  05-memory              heap, the unbounded turns[], V8 GC, closures
  06-filesystem          readFile, the pool as a descriptor pool, cleanup
  07-bounded-work        no cancellation, no timeout, no SIGINT — the honest gaps
  08-red-flags-audit     ranked execution-model risks with evidence
```

Start at `01` for the map, then read in order. `08` is the verdict file — ranked risks with `file:line` evidence for each.

---

## Cross-links to neighboring guides

- **`study-system-design`** owns *where* components live and how requests cross the Postgres/Ollama boundaries. This guide owns *how* the code executes inside one machine. The pool-as-a-boundary belongs there; the pool-as-a-runtime-resource belongs here.
- **`study-networking`** owns the transport mechanics of the pool (DNS, TCP, TLS, HTTP keep-alive to Ollama). This guide treats the pool as a *runtime resource with a lifecycle*, not as a network connection.
- **`study-database-systems`** owns transactions, isolation, and pgvector internals. This guide owns the `BEGIN/COMMIT/ROLLBACK` only as *which client holds which connection for how long*.
- **`study-testing`** owns how the `--test-concurrency=1` flag makes runtime behavior deterministic in tests.
