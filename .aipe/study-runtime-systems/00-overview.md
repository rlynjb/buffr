# Study — Runtime Systems · Overview

> The execution model inside `buffr-laptop`: where work runs, what resources it owns, and what breaks under concurrency or overload — grounded in the real files.

This is a **curriculum-style** guide. The eight concept files below teach the runtime fundamentals (event loop, tasks, synchronization, memory, resource lifecycle, bounded work) and anchor each to where the repo does — or pointedly does *not* — exercise it. Where the repo hasn't built a mechanism yet, you'll see `not yet exercised`, said plainly, with the trigger that would make it relevant.

---

## The repo in one runtime picture

The whole system is a **single-threaded process** (Bun for chat, Node for batch — NodeNext ESM either way) driving an **event loop**, holding one **connection pool (`pgPool`)** open to Postgres, and talking to Ollama over HTTP. There are two process *shapes* sharing this code: one **long-lived interactive process (the chat session)** and three **one-shot batch CLIs (migrate / index / eval)**. The chat process now hosts two domain-pack-driven research engines (`/investing`, `/research`) and a decision-journal loop (`/review`) that tracks predictions from `/research` through to a resolved outcome — all still running inside that same one thread, one event loop, one connection pool.

```
  buffr-laptop — the runtime map, one frame

  ┌─ Process layer (one OS process, one JS thread) ───────────────────┐
  │                                                                   │
  │   the event loop (libuv / Bun's equivalent)                       │
  │   ┌──────────────────────────────────────────────────────────┐   │
  │   │  microtask queue (Promise .then / await continuations)    │   │
  │   │  macrotask queues (timers, I/O callbacks, check)          │   │
  │   └──────────────────────────────────────────────────────────┘   │
  │                                                                   │
  │   shape A: chat (long-lived, Bun/JSC)  shape B: migrate/index/eval│
  │   ┌───────────────────────────┐     ┌──────────────────────────┐  │
  │   │ OpenTUI render loop (React)│     │ top-level await script   │  │
  │   │ raw-mode TTY stdin         │     │ run → pool.end() → exit  │  │
  │   │ warm pool across turns     │     │ pool opened per process  │  │
  │   │ forceExit(): bounded exit  │     └──────────────────────────┘  │
  │   │  on /exit, Ctrl-C, SIGINT  │                                   │
  │   └───────────────────────────┘                                   │
  └──────────────────────────────┬────────────────────────────────────┘
                                 │ async I/O (non-blocking sockets)
            ┌────────────────────┼─────────────────────┐
            ▼                                          ▼
  ┌─ Storage (Postgres) ──────┐          ┌─ Provider (Ollama, HTTP) ──┐
  │ connection pool (`pgPool`)│          │ gemma2:9b · nomic-embed    │
  │ pgvector / agents / decisions schema  │ (fetch over event loop)    │
  └───────────────────────────┘          └────────────────────────────┘
```

Every box here is a real file. The pool is `createPool` (`src/db.ts:4`). The chat process is `src/cli/chat.tsx` + `src/session.ts`, and now also `src/cli/research-flow.ts` + `src/cli/review-flow.ts` for the two interactive predict/reveal/review loops. The batch CLIs end with `await pool.end()` (`src/migrate.ts:39`, `src/cli/index-cmd.ts:40`, `src/cli/eval-cmd.ts:36`). The UI moved from Ink to `@opentui/react` (OpenTUI, a React reconciler over a Zig renderer) before this study guide was first written — chat now runs under **Bun**, not Node, because OpenTUI needs `bun:ffi`; every batch CLI still runs under Node. Same single-thread, single-event-loop model either way; only the engine and entry command differ.

---

## Top findings — ranked by consequence

**1. Ctrl-C used to hang the process. It doesn't anymore — and the fix is the best worked example in this guide.** Two commits landed the same day (`64f822f`, `9c1b1e6`) after Ctrl-C was found to hang the chat process in practice. The fix isn't a bare `process.on('SIGINT', ...)` — that alone doesn't work here, because `exitOnCtrlC: false` plus raw-mode stdin means the terminal never sends SIGINT for a Ctrl+C keystroke; it has to be caught inside the `useKeyboard` layer instead. And a signal handler that `await`s an unbounded `pool.end()` just moves the hang, so `forceExit()` (`src/cli/chat.tsx:464`) races `session.close()` (`src/session.ts:876-881`, itself racing `pool.end()` against a 1s timer) against a hard, `.unref()`'d 1.5s deadline. The process now always exits within 1.5s of Ctrl-C — but that's *bounded* shutdown, not fully graceful: a trace write still in flight can be lost if the pool doesn't close in time. → `07`, `08` (R1).

**2. The two process shapes still have different lifetime contracts, and the pool lifecycle is now bounded on both.** The chat session opens one pool and holds it across every turn (`src/session.ts:399`); `close()` — now racing a timeout — is what ends it, triggered by `/exit`, a Ctrl-C keystroke, or an external SIGINT (all routed through `forceExit()`). The batch CLIs still open a pool, do the work under top-level `await`, then `pool.end()` unbounded — batch scripts don't hold a TTY, so the raw-mode-swallows-SIGINT problem that motivated finding 1 doesn't apply to them.

**3. The trace sink is the one place the repo separates sync emission from async work — and a second instance of the same "sync interface, async work" hazard was just found and fixed in the interactive flows.** `emit()` is synchronous because the kernel's `CapabilityTraceSink` contract demands it (`src/supabase-trace-sink.ts:53`); the actual DB writes are fire-and-collect into a `pending[]` array and awaited once via `flush()`. Separately, `26f0e4b` fixed a real bug in `research-flow.ts`/`review-flow.ts`'s wiring: three `.then(success)` call sites with no rejection handler meant a thrown DB error became an unhandled promise rejection that left `busy` stuck `true` and the input permanently hidden. Both are event-loop-shaped lessons about async completion that isn't awaited or isn't caught. → `03-event-loop-and-async-io.md`, `08` (R8).

**4. Cancellation is built end-to-end in the library and connected to nothing.** This is a correction, not just an update: the last pass of this guide said "no `AbortSignal` anywhere" — that was true of `src/`, false of `packages/`. `RagQueryAgent.answer(question, { signal })`, `runAgentLoop`, the Ollama embedder, the Gemma model gateway's `fetch`, and every discovery connector all accept and forward an `AbortSignal`. `session.ts:675` never constructs one, and `grep -rn "new AbortController" .` across the whole repo (tests included) returns nothing. So a per-turn deadline is now mostly wiring, not new design — and it's the honest top gap to flag in an interview, now that the SIGINT hang is fixed. → `07`, `08` (R2/R3).

**5. Shared mutable state is real but single-threaded-safe, and the same `busy` guard now also fences the two multi-step flows.** React state (`turns`, `busy` — `src/cli/chat.tsx`) and the sink's `pending[]` are mutated across `await` points, but Node/Bun's run-to-completion guarantee means no data races — the only hazard is re-entrancy, closed by a synchronous `if (busy) return` at the top of `handleSubmit`. `/research` and `/review` are new closures (`createResearchFlow`, `createReviewFlow`) that hold `step`/`collected`/`prediction` as mutable `let`s across `await` boundaries — a second worked instance of the same closure-as-state-machine pattern already taught for `createChatSession`, guarded by the identical `busy` flag. → `04`, `05`.

---

## `not yet exercised` — named honestly

| Mechanism | Status | When it becomes relevant |
|---|---|---|
| Worker threads / `child_process` | not yet exercised | CPU-bound work off the main loop (embedding is offloaded to Ollama, so never local) |
| `AbortSignal` / cancellation | **wired through the kernel, never triggered** | a turn needs a deadline or a cancel key — the plumbing already exists, only the call site (`session.ts:675`) and a UI trigger are missing |
| Query / request timeouts | not yet exercised | Ollama, Postgres, or a connector call can wedge a turn — now the sharpest remaining gap |
| SIGINT handler / bounded shutdown | **exercised — fixed Aug 2** (`64f822f`, `9c1b1e6`) | was the top gap; Ctrl-C now force-exits within 1.5s, though the drain itself isn't guaranteed to finish |
| Unhandled promise rejections in long-lived UI state | **exercised — fixed Aug 4** (`26f0e4b`) | the interactive `/research`/`/review` flows now handle rejection on every `.then()` call site |
| Bounded concurrency / queue limits | not yet exercised | concurrent turns or batch indexing of large corpora |
| Backpressure on streams | not yet exercised | streaming model output token-by-token to the TTY (the `/research` progress panel streams *status*, not tokens) |
| Explicit GC / heap tuning | not yet exercised | long sessions accumulating `turns[]` unboundedly |
| Pool size limits / saturation handling | not yet exercised (defaults) | multiple concurrent agents on one pool — the journal store (`PgJournalStore`) now shares this same undertuned pool |
| File streaming (`createReadStream`) | not yet exercised | indexing files too large for `readFile` into memory |

---

## Reading order

```
  00-overview            ← you are here
  01-runtime-map         the process/task/resource map as-built
  02-processes-threads   one JS thread (Bun/Node); two process shapes; no workers
  03-event-loop          microtasks, await, the sync-emit/async-flush queue,
                          and the unhandled-rejection fix in the flow wiring
  04-shared-state        React state + pending[] across await; the busy guard,
                          now also fencing the research/review flow closures
  05-memory              heap, the unbounded turns[], V8 GC, closures —
                          the flow closures as a second worked example
  06-filesystem          readFile, the pool as a descriptor pool, cleanup
  07-bounded-work        the SIGINT fix, the AbortSignal seam nobody triggers,
                          and the deadline that's still missing
  08-red-flags-audit     ranked execution-model risks — two now fixed
```

Start at `01` for the map, then read in order. `08` is the verdict file — ranked risks with `file:line` evidence for each.

---

## Cross-links to neighboring guides

- **`study-system-design`** owns *where* components live and how requests cross the Postgres/Ollama boundaries. This guide owns *how* the code executes inside one machine. The pool-as-a-boundary belongs there; the pool-as-a-runtime-resource belongs here.
- **`study-networking`** owns the transport mechanics of the pool (DNS, TCP, TLS, HTTP keep-alive to Ollama). This guide treats the pool as a *runtime resource with a lifecycle*, not as a network connection.
- **`study-database-systems`** owns transactions, isolation, and pgvector internals. This guide owns the `BEGIN/COMMIT/ROLLBACK` only as *which client holds which connection for how long*.
- **`study-testing`** owns how the `--test-concurrency=1` flag makes runtime behavior deterministic in tests.
