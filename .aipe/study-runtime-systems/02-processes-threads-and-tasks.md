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
  │  ★ ONE V8 THREAD · TASKS ON THE EVENT LOOP ★             │ ← we are here
  │  no worker threads · no child_process · no cluster       │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: a "task" here is just a callback the event loop will run — a Promise continuation, an I/O completion, a timer. There are no OS threads you manage, no locks, no shared memory between processes. The interesting variation is entirely the *process shape*: does the loop ever empty?

---

## The structure pass

**Layers.** Process (the OS-level thing) → thread (the one V8 thread inside it) → task (a unit the loop schedules). The repo only ever touches the process layer directly (it spawns one per CLI) and the task layer implicitly (every `await`).

**Axis — trace `lifecycle`: when does this process exit?** Hold it constant across the two shapes.

```
  One axis, two process shapes: "what makes this process exit?"

  ┌─ chat (long-lived) ─────────────┐   exits when: exit() is called
  │  render() keeps loop non-empty  │   trigger: user types /exit
  └─────────────────────────────────┘   Ink unref's stdin, loop empties

  ┌─ batch (one-shot) ──────────────┐   exits when: event loop empties
  │  top-level await, then pool.end()│   trigger: last await resolves +
  └─────────────────────────────────┘            pool sockets closed
```

The answer flips hard across the shape boundary: chat exits on an *explicit command*, batch exits *passively* when there's nothing left to do.

**Seam — the `render()` call.** That's the load-bearing joint (`src/cli/chat.tsx:63`). Before it, the process behaves like a batch script (top-level await ran `createChatSession`). After it, Ink registers stdin and a render loop that keep the event loop alive indefinitely — *control* flips from "the script's linear top-to-bottom" to "Ink's event-driven render loop." Study that one call and you understand why chat is long-lived and batch isn't.

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

**Process shape A — the long-lived interactive process (the chat session).** `render(<Chat/>)` at `src/cli/chat.tsx:63` is the moment this becomes long-lived. Ink puts stdin into raw mode (so it can read keystrokes one at a time instead of waiting for Enter), starts a render loop that redraws the terminal on every state change, and — crucially — keeps a reference to stdin that keeps the event loop from emptying. The loop has nothing queued between turns, but it can't exit, because Ink is still listening on the TTY.

```ts
// src/cli/chat.tsx:62-63 — the moment the process becomes long-lived
const session = await createChatSession();  // ran like a batch script up to here
render(<Chat session={session} />);         // Ink takes the loop; process won't exit until exit()
```

The session it holds (`src/session.ts:34-76`) is built **once**: one pool, one embedder, one agent, one conversation row. Every turn reuses all of it. That's the whole point of the long-lived shape — pay setup once, amortize across turns.

**Process shape B — the one-shot batch CLIs.** `migrate`, `index`, `eval` are linear scripts: open a pool, do the work under top-level `await`, call `pool.end()`, fall off the bottom. No render loop, no stdin listener. When the last `await` resolves and the pool's sockets are closed, the event loop has nothing left and the process exits cleanly on its own — no `process.exit()` needed.

```ts
// src/cli/eval-cmd.ts:24-34 — batch shape: linear, self-terminating
for (const { query, relevant } of queries) {
  const hits = await pipeline.query(query, K);   // task: await Ollama embed + pg search
  // ... score, print ...
}
await pool.end();   // close sockets → loop empties → process exits
```

The boundary condition that bites people: forget `pool.end()` and a batch CLI **hangs after finishing its work** — the result printed, but the pool's idle sockets keep the loop alive and the process never returns to the shell. The repo gets this right in all three batch CLIs (`migrate.ts:30`, `index-cmd.ts:27`, `eval-cmd.ts:34`).

**Tasks — what the loop actually schedules.** Every `await` in this repo splits a function into "before" (runs now) and "after" (scheduled as a microtask when the awaited Promise settles). One turn of chat is a chain of these: `persistMessage` await → `agent.answer` await (which itself awaits Ollama + pg search internally) → `trace.flush` await → `memory.remember` await. Each `await` is a yield point where the loop is free to do something else — like render the spinner frame (`src/cli/chat.tsx:48-51`).

### Move 2 variant — the load-bearing skeleton of "long-lived process"

Strip the chat process to its kernel — what must exist for it to *stay alive across turns*:

1. **A reference that keeps the loop non-empty.** Ink's stdin listener. *Remove it* and the process exits the instant `render` returns — you'd get one frame and a dead terminal.
2. **State held outside any single task.** The `session` closure (pool, agent, conversation id). *Remove it* — rebuild per turn — and you're back to the one-shot shape: cold pool every question, new conversation every question, no warm-pool speedup.
3. **An explicit exit path.** `/exit` → `session.close()` → `exit()` (`src/cli/chat.tsx:18-21`). *Remove it* and the only way out is Ctrl-C, which skips `close()` (see `07`).

Optional hardening, not skeleton: the spinner, the error-catch around `ask`, the placeholder text. The three above are what make it a long-lived process rather than a script.

### Move 3 — the principle

"How many threads" and "does the loop empty" are the two questions that classify any Node program. One thread means no locks and no data races — but also means one slow synchronous call freezes *everything* (the spinner included). "Does the loop empty" is the difference between a daemon and a job: a daemon holds a reference (a server socket, a TTY, a timer) that keeps the loop alive; a job lets the loop drain and dies. Knowing which one you're writing tells you whether you need a shutdown handler at all.

---

## Primary diagram

The two process shapes side by side, one thread each.

```
  Two process shapes, one thread each — recap

  SHAPE A: chat (long-lived)              SHAPE B: batch (one-shot)
  ┌──────────────────────────────┐        ┌──────────────────────────────┐
  │ createChatSession()          │        │ createPool()                 │
  │   one pool/agent/conv        │        │   one pool                   │
  │ render(<Chat/>)              │        │ for (...) await work         │
  │   ┌────────────────────────┐ │        │ await pool.end()             │
  │   │ Ink render loop        │ │        │ ── fall off bottom ──        │
  │   │ raw-mode TTY stdin     │ │        └──────────────┬───────────────┘
  │   │ loop stays NON-empty   │ │             loop empties → exit
  │   └────────────────────────┘ │
  │ /exit → close() → exit()     │        both: ONE V8 thread,
  └──────────────────────────────┘        tasks on the event loop
        loop empties only on exit()        I/O offloaded to OS / Ollama
```

---

## Elaborate

Node's single-threaded model came from the same insight as the browser's: most server work is I/O-bound, not CPU-bound, so you don't need a thread per request — you need one thread that never blocks on I/O. The cost is that any CPU-heavy or accidentally-synchronous call (a giant `JSON.parse`, a synchronous crypto hash, a `while` loop) stalls every other task. `buffr-laptop` sidesteps the cost structurally: the only heavy work (the model) lives in another process. If buffr ever did local embedding or a big in-process re-rank, *that's* when `worker_threads` would earn its place — and not before.

The long-lived-vs-batch split is the same distinction as a web server vs a cron job, or a React app vs a build script. Same language, same runtime, opposite lifetime contracts.

---

## Interview defense

**Q: "This is single-threaded — how does it handle a slow model call without freezing the UI?"**

> The slow part isn't on buffr's thread. `agent.answer` `await`s an HTTP call to Ollama; while that socket is in flight, the event loop is free, so Ink keeps rendering the spinner frames. The thread only freezes if something *synchronous* and slow runs — and nothing in the hot path is. The flip side: because it's one thread, a turn is fully serialized — the `busy` flag blocks new input until the current turn's await chain completes.

```
  why the spinner keeps spinning during a slow turn

  await agent.answer(q) ──► socket to Ollama (OS holds it)
        │ loop is FREE here
        ▼
  Ink renders <Spinner/> frame ... frame ... frame
        │ Ollama responds
        ▼
  continuation resumes ──► setTurns(answer) ──► spinner replaced
```

**Anchor:** "One thread, work offloaded to Ollama — the UI stays live because the await yields the loop, at `src/session.ts:62`."

---

## See also

- `01-runtime-map.md` — the resources each process shape owns
- `03-event-loop-and-async-io.md` — the loop that schedules every task
- `04-shared-state-races-and-synchronization.md` — why one thread means no locks
- `07-backpressure-bounded-work-and-cancellation.md` — the missing exit handler for shape A
