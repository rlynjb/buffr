# Processes, Threads, and Tasks — where work actually runs

**Industry name(s):** process model, single-threaded event-driven runtime, the long-lived process vs the batch job · *Industry standard*

---

## Zoom out, then zoom in

Two questions sit under this whole file: **how many threads run your code** (answer: one), and **what shape of process is running it** (answer: one of two — a long-lived interactive one, or a one-shot batch one). Get those two facts and most "concurrency bug" worries in this repo evaporate, because there's no second thread to race against.

```
  Zoom out — process & thread model in the stack

  ┌─ Interface layer ────────────────────────────────────────┐
  │  npm run chat        npm run migrate / index / eval      │
  └──────────┬────────────────────────┬──────────────────────┘
             │ long-lived process     │ one-shot process
  ┌─ Runtime layer ──────▼────────────▼──────────────────────┐
  │  ★ ONE JS THREAD (Bun/JSC or Node/V8) · TASKS ON THE LOOP ★│ ← we are here
  │  no worker threads · no child_process · no cluster        │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: a "task" here is just a callback the event loop will run — a Promise continuation, an I/O completion, a timer. There are no OS threads you manage, no locks, no shared memory between processes. The interesting variation is entirely the *process shape*: does the loop ever empty?

---

## The structure pass

**Layers.** Process (the OS-level thing) → thread (the one JS thread inside it — JSC under Bun for chat, V8 under Node for batch) → task (a unit the loop schedules). The repo only ever touches the process layer directly (it spawns one per CLI) and the task layer implicitly (every `await`).

**Axis — trace `lifecycle`: when does this process exit?** Hold it constant across the two shapes.

```
  One axis, two process shapes: "what makes this process exit?"

  ┌─ chat (long-lived) ─────────────┐   exits when: forceExit() fires
  │  render() keeps loop non-empty  │   trigger: /exit, Ctrl-C keystroke,
  └─────────────────────────────────┘   or external SIGINT — bounded to ≤1.5s

  ┌─ batch (one-shot) ──────────────┐   exits when: event loop empties
  │  top-level await, then pool.end()│   trigger: last await resolves +
  └─────────────────────────────────┘            pool sockets closed (unbounded)
```

The answer flips hard across the shape boundary: chat exits on an *explicit command*, batch exits *passively* when there's nothing left to do.

**Seam — the `createRoot(renderer).render()` call.** That's the load-bearing joint (`src/cli/chat.tsx:468`). Before it, the process behaves like a batch script (top-level await ran `createChatSession`). After it, OpenTUI registers raw-mode stdin and a render loop that keep the event loop alive indefinitely — *control* flips from "the script's linear top-to-bottom" to "OpenTUI's event-driven render loop." Study that one call and you understand why chat is long-lived and batch isn't.

---

## How it works

### Move 1 — the mental model

You know how a `fetch()` in the browser doesn't block the page — the main thread keeps running, and your `.then()` fires later? Node is that, everywhere, with no second thread doing the heavy lifting underneath. **One thread runs your JavaScript; every blocking thing (a DB query, an HTTP call, a file read) is handed to the OS and its result comes back as a task on the loop.** A "process" is one running instance of `node`; a "thread" is the single line of execution inside it; a "task" is one callback the loop picks up.

```
  Single-threaded event-driven model — pattern shape

   your JS code ──► hits `await pool.query(...)`
        │                 │
        │                 ▼  hands the socket to the OS, RETURNS immediately
        │           ┌──────────────┐
        │           │ event loop   │  free to run other tasks
        │           │ keeps going  │  (render a frame, run another await)
        │           └──────┬───────┘
        │                  │ OS signals "query done"
        ▼                  ▼
   continuation  ◄──── loop schedules the .then/await resume as a task
   (one thread, one task at a time, run to completion)
```

The "one task at a time, run to completion" rule is why you'll see in `04` that the repo's shared-state mutations are safe without locks.

### Move 2 — the walkthrough

**The single V8 thread.** Search the repo for `worker_threads`, `child_process`, `cluster`, `Worker` — none appear. All work runs on the one thread. This is the right call: the only CPU-heavy work in a RAG agent is embedding and generation, and both are **offloaded to Ollama over HTTP**. The local thread never does a tight CPU loop; it spends its life waiting on I/O. So the classic reason to reach for a worker thread (don't block the loop with CPU work) never triggers here.

```
  Why no worker threads — the CPU work lives elsewhere

  ┌─ buffr process (one thread) ─┐  HTTP   ┌─ Ollama (separate process) ─┐
  │  build prompt (cheap)        │ ──────► │  gemma2:9b generation (slow, │
  │  await fetch ◄───────────────│ ◄────── │  CPU/GPU heavy) — NOT on     │
  │  parse JSON (cheap)          │         │  buffr's thread              │
  └──────────────────────────────┘         └──────────────────────────────┘
       loop stays responsive                the heavy lifting is over here
```

**Process shape A — the long-lived interactive process (the chat session).** `createRoot(renderer).render(<Chat/>)` at `src/cli/chat.tsx:468` is the moment this becomes long-lived. OpenTUI puts stdin into raw mode (so it can read keystrokes one at a time instead of waiting for Enter), starts a render loop that redraws the terminal on every state change, and — crucially — keeps a reference to stdin that keeps the event loop from emptying. The loop has nothing queued between turns, but it can't exit on its own, because OpenTUI is still listening on the TTY.

```ts
// src/cli/chat.tsx:461-468 — the moment the process becomes long-lived
const session = await createChatSession();  // ran like a batch script up to here
const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<Chat session={session} onExit={…} />);  // OpenTUI takes the loop
```

The session it holds (`src/session.ts:394-882`) is built **once**: one pool, one embedder, one agent, one conversation row, one `PgJournalStore`. Every turn — and every `/research`/`/review` flow step — reuses all of it. That's the whole point of the long-lived shape — pay setup once, amortize across turns.

**Process shape B — the one-shot batch CLIs.** `migrate`, `index`, `eval` are linear scripts: open a pool, do the work under top-level `await`, call `pool.end()`, fall off the bottom. No render loop, no stdin listener. When the last `await` resolves and the pool's sockets are closed, the event loop has nothing left and the process exits cleanly on its own — no `process.exit()` needed.

```ts
// src/cli/eval-cmd.ts:24-36 — batch shape: linear, self-terminating
for (const { query, relevant } of queries) {
  const hits = await pipeline.query(query, K);   // task: await Ollama embed + pg search
  // ... score, print ...
}
await pool.end();   // close sockets → loop empties → process exits, unbounded
```

The boundary condition that bites people: forget `pool.end()` and a batch CLI **hangs after finishing its work** — the result printed, but the pool's idle sockets keep the loop alive and the process never returns to the shell. The repo gets this right in all three batch CLIs (`migrate.ts:39`, `index-cmd.ts:40`, `eval-cmd.ts:36`), and unlike the chat process, none of them wrap `pool.end()` in a timeout — there's no TTY holding the process hostage if it's slow, so the cost of an unbounded `pool.end()` here is just a slower script exit, not a stuck terminal.

**Tasks — what the loop actually schedules.** Every `await` in this repo splits a function into "before" (runs now) and "after" (scheduled as a microtask when the awaited Promise settles). One turn of chat is a chain of these: `persistMessage` await → `agent.answer` await (which itself awaits Ollama + pg search internally) → `trace.flush` await → `memory.remember` await. Each `await` is a yield point where the loop is free to do something else — like render the spinner or the live progress panel.

### Move 2 variant — the load-bearing skeleton of "long-lived process"

Strip the chat process to its kernel — what must exist for it to *stay alive across turns*:

1. **A reference that keeps the loop non-empty.** OpenTUI's raw-mode stdin listener. *Remove it* and the process exits the instant `render` returns — you'd get one frame and a dead terminal.
2. **State held outside any single task.** The `session` closure (pool, agent, conversation id, journal store). *Remove it* — rebuild per turn — and you're back to the one-shot shape: cold pool every question, new conversation every question, no warm-pool speedup.
3. **An explicit exit path that can't itself hang.** `forceExit()` (`src/cli/chat.tsx:464`) — triggered by `/exit`, a Ctrl-C keystroke, or an external `SIGINT` — races `session.close()` against a hard 1.5s deadline. *Remove the deadline half* and you're back to the bug this shipped to fix: a hung `pool.end()` hangs the whole process, because a signal handler that `await`s an unbounded close is not actually an exit path. This was missing entirely until `64f822f`/`9c1b1e6` (Aug 2) — before that, Ctrl-C really did skip `close()` and leave the process hung.

Optional hardening, not skeleton: the spinner, the error-catch around `ask`, the placeholder text. The three above are what make it a long-lived process rather than a script — and #3 is the one this repo got wrong once and then fixed.

### Move 3 — the principle

"How many threads" and "does the loop empty" are the two questions that classify any Node program. One thread means no locks and no data races — but also means one slow synchronous call freezes *everything* (the spinner included). "Does the loop empty" is the difference between a daemon and a job: a daemon holds a reference (a server socket, a TTY, a timer) that keeps the loop alive; a job lets the loop drain and dies. Knowing which one you're writing tells you whether you need a shutdown handler at all.

---

## Primary diagram

The two process shapes side by side, one thread each.

```
  Two process shapes, one thread each — recap

  SHAPE A: chat (long-lived, Bun)          SHAPE B: batch (one-shot, Node)
  ┌──────────────────────────────┐        ┌──────────────────────────────┐
  │ createChatSession()          │        │ createPool()                 │
  │   one pool/agent/conv/journal│        │   one pool                   │
  │ createRoot(renderer).render()│        │ for (...) await work         │
  │   ┌────────────────────────┐ │        │ await pool.end()             │
  │   │ OpenTUI render loop     │ │        │ ── fall off bottom ──        │
  │   │ raw-mode TTY stdin      │ │        └──────────────┬───────────────┘
  │   │ loop stays NON-empty    │ │             loop empties → exit
  │   └────────────────────────┘ │             (unbounded, no TTY to hang)
  │ /exit, Ctrl-C, SIGINT →      │        both: ONE JS thread,
  │   forceExit() (bounded,      │        tasks on the event loop
  │   1.5s hard deadline)        │        I/O offloaded to OS / Ollama
  └──────────────────────────────┘
        loop empties only via forceExit() — fixed Aug 2, was unhandled before
```

---

## Elaborate

The single-threaded model came from the same insight as the browser's: most server work is I/O-bound, not CPU-bound, so you don't need a thread per request — you need one thread that never blocks on I/O. The cost is that any CPU-heavy or accidentally-synchronous call (a giant `JSON.parse`, a synchronous crypto hash, a `while` loop) stalls every other task. `buffr-laptop` sidesteps the cost structurally: the only heavy work (the model) lives in another process. If buffr ever did local embedding or a big in-process re-rank, *that's* when `worker_threads` would earn its place — and not before.

The long-lived-vs-batch split is the same distinction as a web server vs a cron job, or a React app vs a build script. Same language, same runtime, opposite lifetime contracts — and, as of Aug 2, only the long-lived one needs a bounded exit path, because it's the only one holding a TTY hostage if a shutdown call hangs.

---

## Interview defense

**Q: "This is single-threaded — how does it handle a slow model call without freezing the UI?"**

> The slow part isn't on buffr's thread. `agent.answer` `await`s an HTTP call to Ollama; while that socket is in flight, the event loop is free, so OpenTUI keeps rendering the spinner and progress-panel frames. The thread only freezes if something *synchronous* and slow runs — and nothing in the hot path is. The flip side: because it's one thread, a turn is fully serialized — the `busy` flag blocks new input until the current turn's await chain completes, and that same flag now also fences the multi-step `/research`/`/review` flows.

```
  why the spinner keeps spinning during a slow turn

  await agent.answer(q) ──► socket to Ollama (OS holds it)
        │ loop is FREE here
        ▼
  OpenTUI renders spinner frame ... frame ... frame
        │ Ollama responds
        ▼
  continuation resumes ──► setTurns(answer) ──► spinner replaced
```

**Anchor:** "One thread, work offloaded to Ollama — the UI stays live because the `await` yields the loop, at `src/session.ts:675`. The one place this repo's single-thread model used to bite: `forceExit()` didn't exist until Aug 2, so a hung `pool.end()` on Ctrl-C hung the whole process — see `07`."

---

## See also

- `01-runtime-map.md` — the resources each process shape owns
- `03-event-loop-and-async-io.md` — the loop that schedules every task
- `04-shared-state-races-and-synchronization.md` — why one thread means no locks
- `05-memory-stack-heap-gc-and-lifetimes.md` — the research/review flow closures as a second long-lived-state example
- `07-backpressure-bounded-work-and-cancellation.md` — the now-bounded exit handler for shape A, and the deadline that's still missing
