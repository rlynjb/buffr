# 02 · Processes, Threads, and Tasks

**Process boundaries, the single thread, and where work runs** · *Language-agnostic*

---

## Zoom out, then zoom in

Where does work physically run in this repo? Every box on the runtime map is
the *same* thread of the *same* single process. There are no workers, no child
processes, no thread pool you reach for explicitly. The unit of concurrency
here is not a thread — it's a *task*: a pending async operation the event loop
juggles while one thread does all the JS.

```
  Zoom out — the execution substrate

  ┌─ OS process ─────────────────────────────────────────────────┐
  │  pid · argv · env · file descriptors · heap                   │
  │                                                               │
  │  ┌─ JS thread (the only one your code runs on) ★ ─────────┐   │
  │  │   call stack · executes ALL your functions             │   │ ← here
  │  └────────────────────────────────────────────────────────┘   │
  │  ┌─ libuv thread pool (Node-internal, you don't touch) ───┐   │
  │  │   fs ops, DNS — Node uses it; buffr never schedules to │   │
  │  └────────────────────────────────────────────────────────┘   │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **process boundary vs task**. A *process* is the OS-
level container (one per CLI). A *task* is a unit of pending async work *inside*
that process. buffr has many tasks in flight (several pending Postgres writes)
but exactly one thread and one process at a time.

---

## Structure pass

**Layers, by execution substrate:**

```
  Substrate        Count in buffr        Who schedules it
  ───────────────  ────────────────────  ─────────────────────────
  process          1 per CLI invocation  the OS / your shell
  JS thread        exactly 1             V8, runs your code
  libuv pool       4 (default), hidden   Node, for fs/dns under the hood
  task (promise)   many, transient       the event loop (see 03)
```

**Axis traced — "what runs in parallel, truly?"**

```
  "is this actually parallel, or just concurrent?"

  ┌──────────────────────────────────────────────┐
  │ process level   → could be parallel, but buffr│  one at a time
  │                   runs ONE CLI at a time       │
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ JS thread       → NEVER parallel. One     │  ← the hard limit
      │                   stack, one thing at once │
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ I/O (pg/http)   → genuinely concurrent│  overlap in flight
          │                   while JS thread waits│
          └──────────────────────────────────────┘
```

The answer flips at the I/O boundary: your *code* never runs two things at
once, but your *I/O* can have many requests outstanding simultaneously. That
distinction — concurrent I/O on a single computational thread — is the entire
model.

**Seams:**

- **JS thread ↔ I/O.** Where concurrency enters. `await pool.query` doesn't
  block the thread; it parks the task and frees the thread to run the next one.
- **process ↔ external systems.** Postgres runs *its own* processes and
  threads; Ollama runs *its own* model on *its own* GPU/CPU. The real
  parallelism in the system happens outside buffr's process entirely.

---

## How it works

### Move 1 — the mental model

You know how a browser runs all your React on one main thread, and a slow
`fetch` doesn't freeze the UI because the network happens off-thread? Node is
the same model on the server. One thread for your logic; I/O happens elsewhere
and reports back. Your code never runs in parallel — it just doesn't *wait* in
a way that blocks.

```
  Single thread, many tasks in flight — the model

   JS thread (one):   ──run──park──run──park──run──park──►
                          │     ▲   │     ▲   │     ▲
                          ▼     │   ▼     │   ▼     │
   pending tasks:      [pg write][pg write][http embed]  ← all "in flight"
                       resolve   resolve   resolve        off-thread, report back

   the thread is busy a few ms at a time; the rest is waiting on I/O
```

### Move 2 — the parts

**The process boundary.** Each CLI is its own OS process with its own pid, heap,
and file descriptors. `process.argv` (`ask-cmd.ts:16`, `index-cmd.ts:14`) is
the process reading its launch arguments. `process.stdout.write` (`:37`) writes
to the process's stdout descriptor. `process.env` (`config.ts:9`) is the
process's environment. These are the only `process.*` touchpoints — buffr never
spawns a child or forks.

```
  Process boundary — what crosses it

  ┌─ shell ──────┐ argv + env  ┌─ node process ──────────┐ stdout ┌─ terminal ┐
  │ npm run ask  │ ──────────► │ process.argv / .env     │ ─────► │  your eyes│
  └──────────────┘             │ ★ all work happens here ★│       └───────────┘
                               └─────────────────────────┘
                                 no child process spawned
```

**The single JS thread.** There is no `worker_threads`, no `child_process`, no
`cluster` anywhere in `src/`. Every function — `loadConfig`, `indexDocumentRow`,
`PgVectorStore.search`, the entire aptkit agent loop — runs on one thread. The
embedding math, the cosine ranking, the SQL building: all sequential on that
thread. **Not yet exercised:** CPU offload. If buffr ever embedded locally
(instead of calling Ollama over HTTP) it would block this thread, and *that's*
when a worker thread earns its place.

**The libuv pool (hidden).** Node's `readFile` (`index-cmd.ts:23`) is async
because libuv runs the actual disk read on its internal thread pool, then
resolves the promise on the JS thread. buffr never schedules to this pool
directly — it's Node's implementation detail — but it's *why* `await readFile`
doesn't block the thread. Worth knowing it exists; you don't touch it.

**Tasks, not threads, are the unit.** When `ask-cmd` is mid-run, the
`SupabaseTraceSink` has multiple `persistMessage` promises sitting in its
`pending[]` array (`supabase-trace-sink.ts:24`). Those are *tasks* — concurrent
units of work — but they all complete on the one JS thread as their I/O
resolves. Many tasks, one thread. → `03` walks how the event loop sequences
them.

### Move 3 — the principle

**Concurrency is not parallelism, and buffr is pure concurrency.** Your code is
single-threaded and will stay that way until something CPU-bound forces a
worker. The throughput comes entirely from overlapping I/O — many requests in
flight, one thread weaving between them. The moment you find yourself wanting
"two CPUs," you've left the model the repo is built on, and that's a deliberate
boundary, not an oversight.

---

## Primary diagram

```
  Where work runs in buffr — the full substrate picture

  ┌─ OS ─────────────────────────────────────────────────────────┐
  │  one node process (per CLI)                                   │
  │                                                               │
  │   ┌─ JS thread (your code) ──────────────────────────────┐   │
  │   │  loadConfig → createPool → agent.answer → flush       │   │
  │   │  sequential · one stack · never two things at once    │   │
  │   └───────────────┬───────────────────────┬───────────────┘   │
  │                   │ park on await          │ park on await     │
  │   ┌─ libuv pool ──▼─────┐    ┌─ network ───▼───────────────┐   │
  │   │ fs reads (readFile) │    │ pg sockets · http to ollama │   │
  │   └─────────────────────┘    └─────────────┬───────────────┘   │
  └───────────────────────────────────────────┼─────────────────┘
                                              │ true parallelism lives here
                          ┌───────────────────▼───────────────────┐
                          │ Postgres procs · Ollama model (GPU)    │
                          │ their own threads, their own processes │
                          └────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Every CLI run is one process. The "many tasks, one thread" model
shows up most clearly in `ask-cmd` where trace writes pile up as concurrent
tasks while the agent loop runs on the single thread.

**The only process touchpoints** (`src/cli/index-cmd.ts`, lines 14, 25):

```
  src/cli/index-cmd.ts  (lines 14, 25)

  const cfg = loadConfig(process.env);          ← process env (the boundary in)
  ...
  process.stdout.write(`indexed ${path}\n`);     ← process stdout (boundary out)
       │
       └─ argv in, stdout out, env read. No spawn, no fork, no worker.
          The process boundary is touched only to read input and write output.
```

**Concurrent tasks on one thread** (`src/supabase-trace-sink.ts`, lines 24, 30–34):

```
  src/supabase-trace-sink.ts  (lines 24, 30–34)

  private readonly pending: Promise<void>[] = [];   ← a list of TASKS, not threads
  ...
  this.pending.push(persistMessage(pool, ...));      ← starts a task, doesn't await
       │
       └─ each push fires a Postgres write that runs concurrently with the
          others. All of them complete on the SAME single JS thread as their
          I/O resolves. This is "many tasks, one thread" in one line. (see 03)
```

---

## Elaborate

The single-threaded-with-async-I/O model is Node's founding bet, inherited from
the event-driven server tradition (nginx, Twisted). The payoff is no
thread-synchronization bugs in *your* code — no mutexes, no data races on JS
objects — because only one thing runs at a time. The cost is that any CPU-bound
work freezes everything, which is why CPU-heavy Node services reach for
`worker_threads`. buffr sidesteps the cost by pushing all heavy compute
(embeddings, generation) across the network to Ollama, so the JS thread only
ever does light glue work between I/O waits.

`worker_threads` and `child_process` are the escape hatches when this model
breaks. Neither appears here — correctly, since nothing in buffr is CPU-bound on
the JS thread.

---

## Interview defense

**Q: Is buffr single-threaded? Then how does it do multiple DB writes at once?**

```
  one thread, many in-flight I/O

  JS thread: ─push─push─push──────────(idle, waiting)──────────►
                │    │    │
                ▼    ▼    ▼
   pg writes:  [w1] [w2] [w3]  ← all outstanding at the network layer
                resolve as Postgres finishes them, on the one thread
```

Single JS thread, yes. The writes aren't parallel *computation* — they're
parallel *I/O*. Each `persistMessage` starts a socket write and parks; the
thread moves on; Postgres does the actual work in its own processes.
`Promise.all` in `flush()` waits for all of them. *Anchor:* concurrency is
overlapping waits, not overlapping CPU.

**Q: When would you add a worker thread here?** The moment embeddings move
on-device — local embedding is CPU-bound and would freeze the event loop. Right
now Ollama owns that compute over HTTP, so the JS thread stays free. *Anchor:*
workers are for CPU, not I/O; buffr's heavy CPU is all remote.

---

## Validate

1. **Reconstruct:** draw "one thread, many tasks in flight" and place three
   `persistMessage` calls on it.
2. **Explain:** why does `await readFile` (`index-cmd.ts:23`) not block the JS
   thread, even though disk reads are slow?
3. **Apply:** you want to embed locally instead of via Ollama. Why does that
   break the single-thread model, and what primitive do you reach for?
4. **Defend:** buffr has zero `worker_threads`. Argue why that's correct for
   *this* repo and name the exact change that would flip the answer.

---

## See also

- `03-event-loop-and-async-io.md` — how the one thread sequences many tasks
- `04-shared-state-races-and-synchronization.md` — why one thread means no JS-level races
- `07-backpressure-bounded-work-and-cancellation.md` — the serial loop on the single thread
- `00-overview.md` → "Not yet exercised" — threads/workers gap
