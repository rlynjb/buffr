# 07 · Backpressure, Bounded Work, and Cancellation

**Serial loops, the missing AbortSignal, and graceful shutdown** · *Industry standard*

---

## Zoom out, then zoom in

What happens when there's too much work, or work that hangs, or work you want to
stop? buffr's answer today is uniform: it doesn't bound, doesn't cancel, doesn't
time out. The index loop does one file at a time with `await` in a `for` loop —
which is, accidentally, a *concurrency limit of one* (the simplest possible
backpressure). But nowhere is there an `AbortSignal`, a timeout, or a signal
handler. A hung Ollama call hangs the process forever. This file teaches the
patterns and is honest that most of them are `not yet exercised`.

```
  Zoom out — where overload control would live

  ┌─ CLI layer ──────────────────────────────────────────────────┐
  │  for path of paths { await index(path) }  ← serial = limit 1  │ ← here
  └───────────────────────────────┬───────────────────────────────┘
                                  │ no timeout / no AbortSignal
  ┌─ Provider layer ──────────────▼──────────────────────────────┐
  │  Ollama HTTP  ·  Postgres  ← a hang here hangs the whole run  │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the concepts are **bounded concurrency** (cap in-flight work),
**cancellation** (stop work you no longer need), and **graceful shutdown**
(drain before exit). buffr exercises the first weakly and the other two not at
all.

---

## Structure pass

**Layers, by overload-control mechanism:**

```
  Mechanism            Present in buffr?     Where it would live
  ───────────────────  ────────────────────  ──────────────────────────
  bounded concurrency  WEAK (serial loop=1)  index-cmd.ts:22 for-await
  backpressure         not yet exercised     whole-file reads, no streams
  cancellation         not yet exercised     AbortSignal into pg/http
  timeout / deadline   not yet exercised     Ollama + pg calls
  graceful shutdown    PARTIAL (flush only)  flush ✓, pool.end on error ✗
```

**Axis traced — "what happens under overload or a hang?"**

```
  "if this work piles up or stalls, what happens?"

  ┌──────────────────────────────────────────────┐
  │ index loop  → serial, so no pile-up; but a    │  bounded (accidentally)
  │               slow file blocks the whole queue │
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ trace writes→ all fired at once into       │  ← UNBOUNDED: N events =
      │               pending[], no cap            │     N concurrent writes
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ Ollama call → no timeout, no abort →  │  ← HANGS FOREVER
          │               waits indefinitely       │
          └──────────────────────────────────────┘
```

The answer degrades as you descend: the index loop is accidentally bounded,
the trace writes are unbounded, and the external calls have no escape hatch at
all. The bottom row is the sharpest risk.

**Seams:**

- **serial loop ↔ batch.** `await` inside `for` serializes; that *is* the
  concurrency control, capped at one. The seam to a faster design is
  `Promise.all` (unbounded) or a worker pool (bounded > 1).
- **work ↔ cancellation.** There's no seam here at all — no `AbortSignal`
  threads from the CLI into any pg or http call. That missing seam is the
  finding.

---

## How it works

### Move 1 — the mental model

You know how `await`-ing inside a `for` loop runs requests one after another,
while `Promise.all(items.map(fetch))` fires them all at once? That choice — serial
vs all-at-once — *is* your concurrency control. buffr picks serial, which caps
in-flight work at one. The thing it's missing is the middle ground (a *bounded*
pool of, say, 4) and the escape hatch (cancel a request that's taking too long).

```
  Three concurrency shapes — buffr uses the first

   serial (buffr):   ──[a]──[b]──[c]──►   limit 1, slow, safe
   bounded pool:     ──[a][b][c]──         limit N, fast, controlled  ← absent
                       [d][e][f]──
   unbounded:        ──[a][b][c][d]...──   all at once, can overload  (trace writes)
```

### Move 2 — the parts, one at a time

**Bounded concurrency — the accidental limit of one.** The index loop
(`index-cmd.ts:22`) is `for (const path of paths) { await indexDocumentRow(...) }`.
Because each iteration `await`s before the next starts, only one file is
in-flight at a time. This is the simplest backpressure there is: the loop can't
get ahead of itself, can't overwhelm Ollama with 100 simultaneous embed
requests. It's slow (no overlap) but it's safe. The kernel of bounded work:

```
  Serial for-await — concurrency capped at 1

  for path in paths:
    await index(path)    ← blocks until THIS file is fully done
    # next iteration cannot start until the await resolves

  what this gives you:  natural backpressure — work can't pile up
  what it costs:        zero overlap — total time = sum of all files
```

**The unbounded counter-example — trace writes.** Contrast the index loop with
the trace sink (`supabase-trace-sink.ts:27`): every `emit` *fires* a write
without awaiting, so N agent events produce N concurrent Postgres writes with no
cap. For a handful of events that's fine; it's the unbounded shape, and if an
agent emitted thousands of events you'd open thousands of concurrent writes
against a 10-client pool (they'd queue inside the pool, but the promises all
exist at once — see `05` for the memory cost). The asymmetry is the lesson: the
index path is bounded, the trace path is not.

**Cancellation — entirely absent.** Node's standard cancellation primitive is
`AbortController` / `AbortSignal`: you create a controller, pass its `.signal`
into an async call, and calling `.abort()` rejects the call. buffr threads *no*
signal into *any* Ollama or Postgres call. There is no way to stop a query mid-
flight, no way to abandon a slow embed. The kernel of the missing pattern:

```
  Cancellation (the pattern buffr lacks)

  const ctrl = new AbortController()
  someAsyncCall({ signal: ctrl.signal })   ← call watches the signal
  ctrl.abort()                              ← rejects the call NOW
       │
       └─ buffr passes no signal anywhere → nothing is cancellable
```

**Timeouts / deadlines — also absent.** A timeout is cancellation on a clock:
start a timer, abort if it fires first. buffr sets none. The consequence is
concrete: if Ollama is up but stuck (model loading, GPU contention), the HTTP
call in the agent loop never resolves and never rejects, so `await
agent.answer(...)` (`ask-cmd.ts:34`) hangs *forever*. The process won't exit
because the event loop still has a pending I/O task. No timeout means no upper
bound on a run.

```
  No timeout → forever hang — the failure

  await agent.answer ──► Ollama HTTP ──► (Ollama stalls)
        │                                      │
        └── waits ────────────────────────────┘  no timer to break it
            event loop never empties → process never exits
```

**Graceful shutdown — partial.** The one piece buffr does get is draining the
trace queue: `await trace.flush()` before `pool.end()` (`ask-cmd.ts:35`) ensures
in-flight writes complete before teardown (the `03` lesson). What's missing is
the *signal* side: no `process.on('SIGINT', ...)` / `SIGTERM` handler. Ctrl-C
during an `ask` run kills the process immediately — mid-write, mid-transaction —
with no chance to flush or commit. For a single-user laptop tool that's
acceptable; the flush handles the normal-exit case, and Ctrl-C is a user
deliberately abandoning the run.

### Move 2.5 — current vs future state

```
  Current vs future — what's there, what's gated

  CURRENT                          FUTURE (if this ran unattended)
  ──────────────────────────────   ─────────────────────────────────
  serial index loop (limit 1)      bounded pool (limit N) for throughput
  no AbortSignal anywhere          signal threaded into pg + http
  no timeout                       deadline per external call (e.g. 30s)
  flush() before exit ✓            + SIGINT/SIGTERM handler → flush, end pool
  pool.end() on happy path only    try/finally { await pool.end() }
```

What *doesn't* have to change: the flush-before-exit ordering is already correct
and survives into any future design. What gates the rest: none of it earns its
place at single-user laptop scale. A timeout earns its place the first time
Ollama stalls in real use; bounded concurrency the first time you index a large
corpus and want it faster than serial; a signal handler the first time this runs
inside a supervisor that sends `SIGTERM`.

### Move 3 — the principle

**Unbounded work, uncancellable work, and ungraceful shutdown are the same
failure wearing three masks: no upper bound on what the runtime is committed
to.** A serial loop bounds *count*; a timeout bounds *duration*; a signal
handler bounds *abandonment*. buffr has the first (accidentally) and lacks the
other two — correct for a laptop CLI, and the exact set of things you add the
moment it stops being one.

---

## Primary diagram

```
  Bounded work, cancellation, shutdown — the full state

  ┌─ CLI ─────────────────────────────────────────────────────────┐
  │  for path of paths:  await index(path)   ← SERIAL: limit 1 ✓   │
  │                                                               │
  │  trace: emit fires write (no await) → pending[]  ← UNBOUNDED   │
  │                                                               │
  │  await agent.answer ──┐                                        │
  │                       │ no AbortSignal, no timeout             │
  └───────────────────────┼────────────────────────────────────────┘
                          │ if Ollama/pg stalls ▼
                   ┌──────────────────────┐
                   │ HANGS FOREVER         │  ← no escape hatch (the risk)
                   │ event loop never empties│
                   └──────────────────────┘

  shutdown path:  flush() ✓  →  pool.end() (happy path only)
                  SIGINT/SIGTERM handler: ABSENT
```

---

## Implementation in codebase

**Use cases.** Bounded work shows up in the index loop (one file at a time). The
*absence* of cancellation shows up everywhere an external call is awaited — every
`agent.answer`, `pipeline.query`, `pool.query` is uninterruptible.

**The accidental concurrency limit** (`src/cli/index-cmd.ts`, lines 22–26):

```
  src/cli/index-cmd.ts  (lines 22-26)

  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    await indexDocumentRow(pool, cfg.appId, pipeline, { ... });  ← serial: blocks here
    process.stdout.write(`indexed ${path}\n`);
  }
       │
       └─ the await INSIDE the for is the concurrency control: file N+1 can't
          start until file N finishes. Limit of 1 — natural backpressure, no
          pile-up against Ollama. To bound at N instead, you'd batch with a
          worker pool; to go unbounded, Promise.all(paths.map(...)). buffr
          picks the safest, slowest option — correct for a laptop.
```

**The uninterruptible call** (`src/cli/ask-cmd.ts`, lines 33–34):

```
  src/cli/ask-cmd.ts  (lines 33-34)

  const agent = new RagQueryAgent({ model, tools, profile, trace });
  const answer = await agent.answer(question);   ← no signal, no timeout
       │
       └─ this await has no upper bound. If Ollama is reachable but stalled, the
          HTTP call inside never settles, this await never resolves, the event
          loop stays non-empty, and the process hangs forever. The fix is a
          deadline: race agent.answer against a timeout that aborts. Not yet
          exercised — and the single sharpest runtime risk in the repo.
```

---

## Elaborate

Backpressure is the idea that a fast producer must not overwhelm a slow consumer
— formalized in Node's stream API (`highWaterMark`, `.pause()`/`.resume()`) and
in reactive systems generally. buffr's serial loop is backpressure by the
crudest possible means: never produce the next item until the last is consumed.
It works, it just leaves throughput on the table.

`AbortController` came to Node from the browser's `fetch` cancellation story and
is now the standard cancellation token across the platform — `fetch`, `pg`
(via query cancellation), timers, streams all accept a `signal`. The pattern is
*cooperative*: the callee must watch the signal; you can't force-kill an
operation that ignores it. The reason cancellation matters isn't just stopping
work — it's bounding *resource commitment*. A request with no deadline is a
resource you've promised indefinitely. → `03` for the flush half of graceful
shutdown, `06` for how a leaked-and-uncancelled pool checkout becomes a forever
hang, `05` for the memory cost of unbounded `pending[]`.

**Not yet exercised:** `AbortController`/`AbortSignal`, request timeouts,
`SIGINT`/`SIGTERM` handlers, retry-with-backoff, circuit breakers, rate
limiting, stream backpressure, worker-pool concurrency caps. The repo has one
weak form of bounded work (serial loop) and none of the rest.

---

## Interview defense

**Q: What happens if Ollama hangs mid-request during an `ask`?**

```
  the forever hang

  await agent.answer ──► http to Ollama ──► (stalls, never responds)
        │
        └─ no timeout, no abort → await never settles → event loop
           never empties → process hangs indefinitely
```

It hangs forever. There's no timeout and no `AbortSignal` anywhere
(`ask-cmd.ts:34`), so the await never resolves or rejects and the process can't
exit. The fix is a deadline — race the call against a timer that aborts.
*Anchor:* a call with no timeout is a commitment with no upper bound; that's the
repo's sharpest risk.

**Q: How does buffr bound concurrency when indexing 100 files?** With an `await`
inside a `for` loop (`index-cmd.ts:22`) — that's a concurrency limit of one. One
file fully completes before the next starts, so it never floods Ollama. Slow but
safe. To speed it up you'd add a bounded worker pool; to wreck it you'd use
`Promise.all` and fire 100 embed requests at once. *Anchor:* `await`-in-`for`
*is* the backpressure, capped at one.

---

## Validate

1. **Reconstruct:** draw the three concurrency shapes (serial / bounded /
   unbounded) and place buffr's index loop and trace writes on them.
2. **Explain:** why does a stalled Ollama hang the *whole process*
   (`ask-cmd.ts:34`) rather than time out?
3. **Apply:** add a 30-second deadline to `agent.answer`. Sketch the
   `AbortController` + timer race and where the signal must reach.
4. **Defend:** argue why zero cancellation is the right call for a laptop CLI
   today, then name the exact trigger (unattended / supervised execution) that
   flips it to a must-fix.

---

## See also

- `03-event-loop-and-async-io.md` — `flush()` as the working half of graceful shutdown
- `05-memory-stack-heap-gc-and-lifetimes.md` — the memory cost of unbounded `pending[]`
- `06-filesystem-streams-and-resource-lifecycle.md` — uncancelled checkout → forever hang
- `08-runtime-systems-red-flags-audit.md` — the no-timeout hang ranked #1
