# Backpressure, Bounded Work, and Cancellation — the honest gaps

**Industry name(s):** bounded concurrency, backpressure, cancellation (`AbortSignal`), deadlines / timeouts, graceful shutdown · *Industry standard*

---

## Zoom out, then zoom in

This is the file where the verdict is mostly **`not yet exercised`** — and that's the lesson, not a cop-out. A turn in this repo has no deadline, no cancel key, no timeout on the Ollama call, and the process has no SIGINT handler. For a single-device personal agent driven by a human typing one question at a time, none of that has bitten yet. This file names exactly what's missing, what makes each one start to matter, and the *one* bounding mechanism the repo does have (the `busy` flag).

```
  Zoom out — where bounding would live (mostly empty today)

  ┌─ Interface layer ────────────────────────────────────────┐
  │  busy flag: bounds to ONE turn at a time (the one control)│ ← present
  │  ✗ no cancel key · ✗ no SIGINT handler                   │ ← absent
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Runtime layer ──────────▼───────────────────────────────┐
  │  ✗ no AbortSignal · ✗ no per-turn deadline · ✗ no timeout │ ← absent
  │  pending[]: bounded per turn (drained each flush)         │ ← present
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Storage / Provider ─────▼───────────────────────────────┐
  │  ✗ no query timeout · ✗ no Ollama request timeout        │ ← absent
  │  pool max 10 (default): an implicit concurrency bound     │ ← implicit
  └──────────────────────────────────────────────────────────┘
```

Zoom in: "bounded work" means putting a ceiling on how much runs at once and how long it may take; "cancellation" means being able to stop in-flight work; "graceful shutdown" means draining cleanly on exit. The repo has the *seriality* bound (one turn at a time) and nothing else — by design.

---

## The structure pass

**Layers.** Input bounding (one turn at a time) → work bounding (no deadline, no cancel) → resource bounding (pool max, implicit) → shutdown (none explicit).

**Axis — trace `failure`: when this resource is overloaded or wedged, what happens?**

```
  One axis across the layers: "what happens under overload / a wedge?"

  ┌─ input (busy flag) ─────────────┐  bounded: 2nd submit blocked while busy
  │  → no overload from rapid typing │  (the ONE thing that's handled)
  └──────────────────────────────────┘
      ┌─ a wedged Ollama call ──────┐  UNBOUNDED: turn hangs forever, no
      │  no timeout, no AbortSignal  │  timeout, no cancel — spinner spins on
      └──────────────────────────────┘
          ┌─ a slow pg query ───────┐  UNBOUNDED: same — no statement_timeout
          │  no query deadline       │  set in app code
          └──────────────────────────┘
              ┌─ Ctrl-C ────────────┐  ABRUPT: no SIGINT handler → close()
              │  no graceful shutdown│  skipped, pool not drained, flush lost
              └──────────────────────┘
```

The `failure` answer flips from "handled" at the input layer to "unbounded / abrupt" everywhere below it. That contrast *is* the audit.

**Seam — the `await agent.answer(q)` call (`src/session.ts:62`).** The load-bearing joint where a deadline *would* attach but doesn't. On the caller side, the turn is committed to waiting however long the agent takes. On the agent side, there's no signal it can check to bail. The `guarantees` axis would flip here if a timeout existed (best-effort-with-deadline vs wait-forever) — today both sides say "wait forever."

---

## How it works

### Move 1 — the mental model

You know `Promise.race([fetch(url), timeout(5000)])` — the pattern that says "give up after 5s." That's the shape of every mechanism this file is about, and the repo has *none* of them in the hot path. The only bounding it does have is the simplest possible one: a flag that says "I'm busy, don't start another." Think of this file as a map of the `Promise.race`-es that aren't there yet.

```
  Cancellation / deadline — the pattern that's ABSENT here

  what a bounded turn WOULD look like:
    const ctrl = new AbortController()
    Promise.race([
      agent.answer(q, { signal: ctrl.signal }),  ◄── cancellable
      deadline(30_000).then(() => ctrl.abort())   ◄── deadline fires abort
    ])

  what the repo ACTUALLY does:
    const answer = await agent.answer(q)   ◄── no signal, no deadline, waits forever
```

The gap between those two blocks is the entire content of this file.

### Move 2 — the walkthrough

**The one bound that exists: the `busy` flag bounds concurrency to one.** The strongest "bounded work" claim the repo can make is that it never runs two turns at once. `if (busy) return` at `src/cli/chat.tsx:18` rejects a second submit while a turn is in flight, and the UI hides the input entirely while busy (`src/cli/chat.tsx:48`). So concurrency is bounded to exactly 1 — which is also why the pool's default max of 10 connections is never a constraint: a single serial turn never opens more than a handful at once. This is real bounding, just the coarsest possible kind.

```
  the one real bound — concurrency = 1

  turn in flight (busy=true)
       │
  user submits again ──► if(busy) return ──► dropped
       │                  (input also hidden behind spinner)
       ▼
  turn completes ──► busy=false ──► next submit accepted
```

**`pending[]` is bounded per turn.** The trace sink's queue (`03`) doesn't grow without bound because `flush()` drains it every turn (`src/supabase-trace-sink.ts:91`). The ceiling is "events emitted in one turn" — small. If a single turn ever emitted thousands of events, this queue would need a periodic mid-run flush; today it doesn't, so it's bounded by the turn boundary. (Compare `turns[]` in `05`, which is *not* bounded — it grows across turns.)

**Cancellation — `not yet exercised`, nowhere.** Grep the repo for `AbortController`, `AbortSignal`, `.abort(`, `signal:` — nothing. `agent.answer(q)` (`src/session.ts:62`) takes no signal. Once a turn starts, there is no way to stop it: no cancel key in the Ink UI, no signal threaded into the agent, no way to interrupt the Ollama generation mid-stream. If the user changes their mind, they wait for the turn to finish or kill the process. **When this starts to matter:** the moment a turn can run long enough that a user wants to abort it — a 9B model on a slow machine generating a long answer is exactly that case. The place it would attach is `agent.answer`'s call site, threading an `AbortSignal` from a keypress handler.

**Timeouts / deadlines — `not yet exercised`, nowhere.** No `statement_timeout` on the pg side, no timeout option on the Ollama `fetch` (that's inside aptkit's providers, but buffr sets none). A wedged Ollama process — model still loading, GPU contention, a hung socket — hangs the turn indefinitely. The spinner (`src/cli/chat.tsx:48-51`) spins forever; the `busy` flag stays `true`; the UI is stuck until the process is killed. **When this starts to matter:** the first time a backend wedges in practice. A per-turn deadline (`Promise.race` against a timer) is the cheapest fix and would convert "hang forever" into "error after N seconds," which the existing `catch` in `onSubmit` (`src/cli/chat.tsx:30-32`) would already render gracefully.

```
  the wedge today — failure trace

  await agent.answer(q) ──► Ollama wedged (model loading / hung socket)
       │ no timeout, no signal
       ▼ ...waits...
  spinner spins ∞  ·  busy stays true  ·  UI accepts no input
       │
       ▼ only escape: kill the process (Ctrl-C) ── which skips close()
```

**Graceful shutdown — `not yet exercised`.** There is no `process.on('SIGINT', ...)` and no `process.on('SIGTERM', ...)` anywhere. The *only* clean shutdown path is `/exit` → `session.close()` → `pool.end()` (`src/cli/chat.tsx:18-21` → `src/session.ts:72-74`). Ctrl-C bypasses all of it: the process dies, the OS reclaims the sockets, but `pool.end()` never runs and any trace writes still in `pending[]` for an in-flight turn are lost (the turn is mid-`flush`). Ink restores the terminal on its own signal handling for the common case, but buffr adds no shutdown logic of its own.

```
  two exit paths — one clean, one abrupt

  ┌─ /exit (clean) ─────────────────────────────────────────┐
  │ onSubmit sees /exit ─► session.close() ─► pool.end()     │
  │ ─► sockets drained ─► exit() ─► terminal restored        │
  └──────────────────────────────────────────────────────────┘
  ┌─ Ctrl-C (abrupt) ───────────────────────────────────────┐
  │ SIGINT ─► (no handler) ─► process dies                   │
  │ ✗ close() skipped  ✗ pool.end() skipped  ✗ flush lost    │
  │ OS reclaims sockets (no app-level drain)                 │
  └──────────────────────────────────────────────────────────┘
```

**Backpressure on streams — `not yet exercised`.** The answer is returned as one complete string (`src/session.ts:62,70`), rendered in one `setTurns` (`src/cli/chat.tsx:29`). There's no token-by-token streaming to the TTY, so there's no fast-producer/slow-consumer mismatch to manage — no `stream.write()` returning `false`, no `drain` event, no pause/resume. Backpressure becomes real only if buffr streams model output as it generates. **When this starts to matter:** the day the UI shows tokens as they arrive instead of waiting for the full answer.

### Move 2 variant — the load-bearing skeleton of "bounded work" (what's missing)

If you were to add bounding, these are the parts, named by what each prevents:

1. **A deadline.** *Missing.* Without it, any backend wedge hangs the turn forever. The cheapest addition: `Promise.race([agent.answer(q), timeout(N)])` at `src/session.ts:62`.
2. **A cancellation signal.** *Missing.* Without it, a started turn can't be stopped. Needs an `AbortSignal` threaded from a keypress through `agent.answer`.
3. **A shutdown hook.** *Missing.* Without it, Ctrl-C skips `pool.end()` and loses in-flight flushes. The addition: `process.on('SIGINT', () => session.close().then(() => process.exit()))`.

The one part that *is* present: **the concurrency bound** (the `busy` flag), which prevents overlapping turns. Naming which of the four exist (one) and which don't (three) is the honest audit.

### Move 3 — the principle

Bounded work is insurance you buy *before* you need it: a deadline, a cancel path, and a shutdown hook cost almost nothing to add and convert "hangs forever / dies dirty" into "fails cleanly / drains cleanly." This repo deliberately skips all three because single-device + human-paced means the failure modes haven't bitten — a human notices a hung turn and kills it, and losing one in-flight trace row on Ctrl-C is harmless. That's a legitimate call at this scale. The principle to carry: **know exactly which bounds you've omitted and what makes each one start to matter**, so you add them the day the scale changes — not the day after an incident.

---

## Primary diagram

The full bounding picture — one mechanism present, three absent.

```
  Bounded work, cancellation, shutdown — full recap

  ┌─ PRESENT ───────────────────────────────────────────────────────┐
  │  concurrency bound: busy flag ── one turn at a time              │
  │     src/cli/chat.tsx:18,48                                       │
  │  queue bound: pending[] drained per flush ── bounded by one turn │
  │     src/supabase-trace-sink.ts:91                                │
  └──────────────────────────────────────────────────────────────────┘
  ┌─ ABSENT (not yet exercised) ────────────────────────────────────┐
  │  ✗ deadline / timeout   → wedged backend hangs turn forever      │
  │  ✗ AbortSignal / cancel → started turn can't be stopped          │
  │  ✗ SIGINT handler       → Ctrl-C skips close()/pool.end()/flush  │
  │  ✗ stream backpressure  → N/A (answer returned whole, not streamed)│
  └──────────────────────────────────────────────────────────────────┘
  The ONLY clean exit: /exit → close() → pool.end() (chat.tsx:18-21)
```

---

## Elaborate

The three missing mechanisms are a package deal in production services: a request gets a deadline (don't wait forever), a cancellation token (stop work when the client disconnects), and the server gets a SIGTERM handler (drain in-flight work before the orchestrator kills it). They're absent here for the same reason buffr has no load balancer or worker pool — it's a single-device personal tool, not a service under load. The `me.md` framing is honest about this: distributed-systems-at-scale patterns aren't in the portfolio, and inventing them here would be dishonest. The right move is to name them precisely and say when they'd land.

The one to add *first*, if buffr graduates toward unattended use, is the SIGINT handler — it's three lines, it makes Ctrl-C drain the pool and flush traces, and it's the difference between a clean exit and a dirty one. The deadline is second (cheap insurance against a wedged Ollama). Cancellation is third (a UX nicety until turns get long).

---

## Interview defense

**Q: "What happens if the model call hangs? And what happens on Ctrl-C?"**

> Both are unhandled today, deliberately. If Ollama wedges, the turn hangs forever — there's no timeout on the call and no `AbortSignal`, so the spinner spins and the `busy` flag stays true until the process is killed. On Ctrl-C there's no SIGINT handler, so `session.close()` and `pool.end()` are skipped — the OS reclaims the sockets but the app doesn't drain cleanly, and any trace writes still in the `pending[]` queue for an in-flight turn are lost. The only clean exit is `/exit`, which routes through `close()`. At single-device human-paced scale that's an acceptable tradeoff; the day it runs unattended, the first fix is a three-line SIGINT handler, then a per-turn deadline via `Promise.race`.

```
  the two gaps, one sketch

  hang:   await agent.answer(q) ── no timeout/signal ── spins ∞
  Ctrl-C: SIGINT ── no handler ── close()/pool.end()/flush all skipped
  clean:  /exit ── close() ── pool.end()  ◄── the only drained path
```

**Anchor:** "One bound present — `busy` caps concurrency at one turn (`chat.tsx:18`). Three absent — no deadline, no `AbortSignal`, no SIGINT handler; the only clean exit is `/exit` → `close()` at `session.ts:72`."

---

## See also

- `02-processes-threads-and-tasks.md` — the long-lived process that lacks a shutdown hook
- `03-event-loop-and-async-io.md` — the `pending[]` queue this file bounds
- `05-memory-stack-heap-gc-and-lifetimes.md` — `turns[]`, the unbounded structure this file's discipline would cap
- `08-runtime-systems-red-flags-audit.md` — these gaps ranked by consequence
