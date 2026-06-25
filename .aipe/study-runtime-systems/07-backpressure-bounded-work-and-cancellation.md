# 07 · Backpressure, Bounded Work, and Cancellation

**Serial loops, the missing AbortSignal, and graceful shutdown** · *Industry standard*

---

## Zoom out, then zoom in

What happens when there's too much work, or work that hangs, or work you want to
stop? buffr's answer today is uniform: it doesn't bound, doesn't cancel, doesn't
time out. The index loop does one file at a time with `await` in a `for` loop —
which is, accidentally, a *concurrency limit of one* (the simplest possible
backpressure). But nowhere is there an `AbortSignal`, a timeout, or a signal
handler. A hung Ollama call hangs the process forever — and in `chat` that's now
*user-visible*: `session.ask()` (`session.ts:62`) awaits `agent.answer` with no
deadline, so the UI sits on its `busy` spinner (`chat.tsx:13,48`) forever with no
key to cancel the in-flight turn. This file teaches the patterns and is honest
that most of them are `not yet exercised`.

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
  cancellation         not yet exercised     AbortSignal into pg/http; chat turn
  timeout / deadline   not yet exercised     Ollama + pg calls
  graceful shutdown    PARTIAL (flush only)  flush ✓ per turn; SIGINT handler ✗
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
the trace sink (`supabase-trace-sink.ts:53`): every `emit` *fires* a write
without awaiting, so N agent events produce N concurrent Postgres writes with no
cap. For a handful of events that's fine; it's the unbounded shape, and if an
agent emitted thousands of events you'd open thousands of concurrent writes
against a 10-client pool (they'd queue inside the pool, but the promises all
exist at once — see `05` for the memory cost). The asymmetry is the lesson: the
index path is bounded, the trace path is not.

**Cancellation — entirely absent, and now felt.** Node's standard cancellation
primitive is `AbortController` / `AbortSignal`: you create a controller, pass its
`.signal` into an async call, and calling `.abort()` rejects the call. buffr
threads *no* signal into *any* Ollama or Postgres call. There is no way to stop a
query mid-flight, no way to abandon a slow embed — and in `chat`, no key bound to
cancel the current turn. The `busy` guard (`chat.tsx:17`) even *blocks* new input
while a turn runs, so a stalled turn locks the whole UI. The kernel of the missing
pattern:

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
agent.answer(...)` (`session.ts:62`) hangs *forever*. In a batch CLI the process
just never exits. In `chat` it's worse-because-visible: the turn never returns,
the `busy` spinner (`chat.tsx:48-51`) animates indefinitely, input stays blocked
— a stuck UI a user has to `kill` from another terminal. No timeout means no
upper bound on a turn.

```
  No timeout → forever hang — the failure (chat makes it visible)

  session.ask ──► agent.answer ──► Ollama HTTP ──► (Ollama stalls)
        │               │                               │
        │ setBusy(true) └── waits ──────────────────────┘  no timer to break it
        ▼                   event loop alive (Ink loop) → spinner spins forever
   UI: thinking… ∞          but session.ask never resolves → input locked
```

**Graceful shutdown — partial, and the gap moved.** The one piece buffr gets is
draining the trace queue: `await trace.flush()` after `agent.answer`
(`session.ts:63`) ensures in-flight writes complete before the turn returns (the
`03` lesson). What's missing is the *signal* side: no `process.on('SIGINT', ...)`
/ `SIGTERM` handler. For the long-lived chat process this matters more than it did
for one-shot CLIs — Ctrl-C is the *natural* way to abandon a stuck turn, and it
kills the process mid-write, mid-transaction, bypassing `session.close()` →
`pool.end()` entirely (only `/exit` reaches that, `chat.tsx:18-20`). For a
single-user laptop tool the flush handles the per-turn case; the missing handler
is the cost of going long-lived without a signal story.

### Move 2.5 — current vs future state

```
  Current vs future — what's there, what's gated

  CURRENT                          FUTURE (if turns could stall / run supervised)
  ──────────────────────────────   ─────────────────────────────────
  serial index loop (limit 1)      bounded pool (limit N) for throughput
  no AbortSignal anywhere          signal threaded into pg + http
  no timeout                       deadline per turn (e.g. 30s, abort + retry)
  busy guard blocks input          a key (Esc) that aborts the in-flight turn
  flush() per turn ✓               + SIGINT/SIGTERM handler → close() (flush+end)
  pool.end() only on /exit         handler so Ctrl-C drains too
```

What *doesn't* have to change: the per-turn flush ordering is already correct and
survives into any future design. What gates the rest: none of it earns its place
at single-user laptop scale *until a turn actually stalls*. A timeout + an Esc-to-
cancel earn their place the first time Ollama stalls in real chat use — which is
now the most likely trigger, since the hang is interactive and visible. A signal
handler earns its place the first time Ctrl-C is the way users quit, or this runs
under a supervisor that sends `SIGTERM`.

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

  ┌─ batch CLI ───────────────────────────────────────────────────┐
  │  for path of paths:  await index(path)   ← SERIAL: limit 1 ✓   │
  │  trace: emit fires write (no await) → pending[]  ← UNBOUNDED   │
  └───────────────────────────────────────────────────────────────┘
  ┌─ chat (long-lived) ───────────────────────────────────────────┐
  │  session.ask: setBusy → await agent.answer ──┐                 │
  │               busy guard blocks new input     │ no signal/timeout│
  └───────────────────────────────────────────────┼─────────────────┘
                          │ if Ollama/pg stalls ▼
                   ┌──────────────────────────┐
                   │ HANGS FOREVER             │  ← no escape hatch (the risk)
                   │ spinner spins, input locked│     now USER-VISIBLE in chat
                   └──────────────────────────┘

  shutdown path:  flush() per turn ✓  →  pool.end() only on /exit
                  SIGINT/SIGTERM handler: ABSENT (Ctrl-C skips the drain)
```

---

## Implementation in codebase

**Use cases.** Bounded work shows up in the index loop (one file at a time). The
*absence* of cancellation shows up everywhere an external call is awaited — every
`agent.answer`, `pipeline.query`, `pool.query` is uninterruptible — and bites
hardest in `chat`, where a stalled `session.ask` wedges the interactive UI.

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

**The uninterruptible call, now interactive** (`src/session.ts:62` + `src/cli/chat.tsx:26-34`):

```
  src/session.ts  (line 62)        src/cli/chat.tsx  (lines 26-34)

  const answer =                   setBusy(true);
    await agent.answer(question);  try { const answer = await session.ask(q); ... }
       │  ← no signal, no timeout  finally { setBusy(false); }   ← only runs IF ask resolves
       │
       └─ this await has no upper bound. If Ollama is reachable but stalled, the
          HTTP call inside never settles, session.ask never resolves, so the
          finally never runs — busy stays true forever, the spinner spins, and
          the busy guard (chat.tsx:17) blocks every new keystroke. The whole UI
          is wedged with no in-app way out. Fix: race agent.answer against a
          timeout that aborts, and bind a key to .abort() the controller. Not yet
          exercised — the single sharpest runtime risk, now user-facing.
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

**Not yet exercised:** `AbortController`/`AbortSignal`, request timeouts, an
in-app cancel key for a chat turn, `SIGINT`/`SIGTERM` handlers, retry-with-
backoff, circuit breakers, rate limiting, stream backpressure, worker-pool
concurrency caps. The repo has one weak form of bounded work (serial loop) and
none of the rest — and the long-lived chat process is where their absence first
becomes a felt UX problem rather than a theoretical one.

---

## Interview defense

**Q: What happens if Ollama hangs mid-turn during a chat?**

```
  the forever hang — now wedges the UI

  session.ask ─► agent.answer ─► http to Ollama ─► (stalls, never responds)
        │              │
        │ busy=true    └─ no timeout, no abort → ask never settles →
        ▼                 finally never runs → busy stuck true
   spinner ∞, input blocked (busy guard) → no in-app way out
```

It hangs forever, and in `chat` that's visible: the await in `session.ts:62` has
no timeout and no `AbortSignal`, so `session.ask` never resolves, the `finally`
that clears `busy` (`chat.tsx:32-34`) never runs, and the busy guard locks input.
The user has to `kill` the process. Fix: a deadline that aborts, plus a key bound
to cancel. *Anchor:* a call with no timeout is a commitment with no upper bound —
the repo's sharpest risk, now user-facing.

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
2. **Explain:** why does a stalled Ollama wedge the chat UI (`session.ts:62` +
   `chat.tsx:32-34`) rather than time out — trace how `busy` gets stuck true.
3. **Apply:** add a 30-second deadline + an Esc-to-cancel to a chat turn. Sketch
   the `AbortController` + timer race and where the signal must reach.
4. **Defend:** argue why zero cancellation was right for one-shot CLIs, then name
   the exact trigger (the interactive chat turn) that flips it to a must-fix now.

---

## See also

- `03-event-loop-and-async-io.md` — `flush()` as the working half of graceful shutdown
- `05-memory-stack-heap-gc-and-lifetimes.md` — the memory cost of session-scoped arrays
- `06-filesystem-streams-and-resource-lifecycle.md` — `session.close()` skipped on SIGINT
- `08-runtime-systems-red-flags-audit.md` — the no-timeout hang ranked #1

---

Updated: 2026-06-24 — re-grounded the no-timeout hang on `session.ts:62` + `chat.tsx`; made it user-visible (busy spinner forever, input locked, `finally` never clears `busy`); reframed graceful shutdown around the long-lived chat where Ctrl-C skips `session.close()`.
