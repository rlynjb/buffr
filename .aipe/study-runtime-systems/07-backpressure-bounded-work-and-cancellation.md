# Backpressure, Bounded Work, and Cancellation — the honest gaps

**Industry name(s):** bounded concurrency, backpressure, cancellation (`AbortSignal`), deadlines / timeouts, graceful shutdown · *Industry standard*

---

## Zoom out, then zoom in

This file used to be almost entirely `not yet exercised`. It no longer is — the repo shipped a real shutdown path (`64f822f`, `9c1b1e6`, Aug 2) after Ctrl-C was found to hang the process. What's still missing (a per-turn deadline, a way to cancel an in-flight turn) is named honestly below, and there's a genuine surprise in between: an entire `AbortSignal` cancellation *seam* is wired end-to-end through the kernel and connector packages — and never triggered by anything, anywhere in the repo, including tests. That's not the same claim as "no cancellation exists." It's "the plumbing exists and nobody turned the tap."

```
  Zoom out — where bounding lives today

  ┌─ Interface layer ────────────────────────────────────────┐
  │  busy flag: bounds to ONE turn at a time                  │ ← present
  │  Ctrl-C: forceExit() — bounded shutdown, hard 1.5s ceiling│ ← present (fixed Aug 2)
  │  ✗ no cancel key for an in-flight turn                    │ ← absent
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Runtime layer ──────────▼───────────────────────────────┐
  │  AbortSignal: threaded through every layer of @buffr/kernel│ ← wired, UNUSED
  │  (run-agent-loop, rag-query-agent, gemma-provider, embed)  │   no AbortController
  │  session.ts:675 calls agent.answer(q) with no signal       │   anywhere in the repo
  │  ✗ no per-turn deadline · ✗ no timeout                    │ ← absent
  │  pending[]: bounded per turn (drained each flush)          │ ← present
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Storage / Provider ─────▼───────────────────────────────┐
  │  ✗ no query timeout · ✗ no Ollama/connector request timeout│ ← absent
  │  pool max 10 (default): an implicit concurrency bound      │ ← implicit
  └──────────────────────────────────────────────────────────┘
```

Zoom in: "bounded work" means putting a ceiling on how much runs at once and how long it may take; "cancellation" means being able to stop in-flight work; "graceful shutdown" means draining cleanly on exit. The repo now has three of those: the seriality bound (one turn at a time), a *bounded* shutdown (not a fully graceful one — the distinction matters, see below), and a cancellation *mechanism* nothing calls yet.

---

## The structure pass

**Layers.** Input bounding (one turn at a time) → work bounding (a wired-but-unused cancel signal, no deadline) → resource bounding (pool max, implicit) → shutdown (bounded, not fully graceful).

**Axis — trace `failure`: when this resource is overloaded, wedged, or the process is asked to stop, what happens?**

```
  One axis across the layers: "what happens under overload / a wedge / a stop request?"

  ┌─ input (busy flag) ─────────────┐  bounded: 2nd submit blocked while busy
  │  → no overload from rapid typing │  (handled)
  └──────────────────────────────────┘
      ┌─ a wedged Ollama call ──────┐  UNBOUNDED: turn hangs forever — the
      │  no timeout, no AbortSignal  │  signal PARAMETER exists on agent.answer,
      │  passed at the call site     │  but session.ts never passes one
      └──────────────────────────────┘
          ┌─ a slow pg query ───────┐  UNBOUNDED: same — no statement_timeout
          │  no query deadline       │  set in app code
          └──────────────────────────┘
              ┌─ Ctrl-C ────────────┐  BOUNDED: forceExit() races close()
              │  against a hard 1.5s │  against a hard deadline — always exits,
              │  ceiling (Aug 2 fix) │  doesn't always finish draining first
              └──────────────────────┘
```

The `failure` answer is no longer a flat "handled at the top, unbounded everywhere else." Ctrl-C moved from abrupt to bounded. The model/DB wedge is still genuinely unbounded — that's the sharpest remaining gap, and it's sharper than R1 used to be, because now it's the *only* unhandled hang left in the interactive path.

**Seam — the `await agent.answer(q)` call (`src/session.ts:675`).** The load-bearing joint where a deadline and a cancel signal would both attach — and where one of the two *could* attach today with almost no new code, because `RagQueryAgent.answer(question, { signal })` already accepts one (`packages/kernel/src/agents/rag-query-agent.ts:63`). The `guarantees` axis flips at this exact call: one line upstream, the kernel's contract is "best-effort-with-signal" (every downstream call — the embed, the tool loop, the gateway fetch — honors `signal?.throwIfAborted()`); one line downstream, at the actual invocation, the axis flips back to "wait forever" because no signal is constructed or passed. That flip — a capability present in the callee's contract, absent at the caller — is the single most interesting seam in this file.

---

## How it works

### Move 1 — the mental model

You know `Promise.race([fetch(url), timeout(5000)])` — the pattern that says "give up after 5s." That's the shape of every mechanism this file is about. The repo now has *half* of that pattern built and wired at the process-exit boundary (`forceExit()` races `session.close()` against a hard timer), but it's still absent at the one place it would matter most for a wedged turn — the model call. Think of this file as a map of which `Promise.race`-es exist, which don't, and one surprising case where the *cancellable* half of a `Promise.race` already exists three layers down and nobody built the race around it.

```
  Cancellation / deadline — what's built vs what's wired

  the shutdown race — BUILT and WIRED (src/cli/chat.tsx:464):
    Promise.race([ session.close(), timeout(1500) ])   ◄── always wins, may not drain

  what a bounded TURN would look like — BUILT (the signal), NOT WIRED:
    const ctrl = new AbortController()
    Promise.race([
      agent.answer(q, { signal: ctrl.signal }),  ◄── accepts a signal already
      deadline(30_000).then(() => ctrl.abort())   ◄── this half doesn't exist
    ])

  what session.ts ACTUALLY does at the call site (src/session.ts:675):
    const answer = await agent.answer(q)   ◄── no signal passed, no deadline, waits forever
```

The gap in the second block — a parameter the callee accepts and the caller never fills in — is more interesting than a flat "missing feature," because it means adding a turn deadline is mostly wiring, not new design.

### Move 2 — the walkthrough

**The one bound that exists: the `busy` flag bounds concurrency to one.** The strongest "bounded work" claim the repo can make is that it never runs two turns at once. `if (busy) return` at `src/cli/chat.tsx:156` rejects a second submit while a turn is in flight, and the UI hides the input entirely while busy. So concurrency is bounded to exactly 1 — which is also why the pool's default max of 10 connections is never a constraint: a single serial turn never opens more than a handful at once. This is real bounding, just the coarsest possible kind. The same guard now also fences the two interactive flows (`/research`, `/review` — `src/cli/research-flow.ts`, `src/cli/review-flow.ts`): `activeFlow.controller.submit(q)` runs under the identical `busy` gate, so a multi-step predict/reveal/promote loop can't be re-entered mid-step either.

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

**Cancellation — wired end-to-end in the library, connected to nothing.** This is the file's sharpest correction from the last pass, which found "nothing" on a grep for `AbortSignal`. That grep was run against `src/`. Run it against `packages/` and the story flips: `signal?: AbortSignal` is a parameter on `RagQueryAgent.answer` (`packages/kernel/src/agents/rag-query-agent.ts:63`), on `runAgentLoop` (`packages/kernel/src/workflow-runtime/run-agent-loop.ts:23,45`), on the Ollama embedder (`packages/kernel/src/retrieval/ollama-embedding-provider.ts:23`), on the Gemma model gateway's `fetch` call (`packages/kernel/src/model-gateway/gemma-provider.ts:62`), and on every discovery connector (Google, Reddit, Tavily, Brave, RSS, Amazon — `packages/connectors/src/discovery/*.ts`). Each layer checks `signal?.throwIfAborted()` before doing its work and forwards the same signal one layer deeper. That's a complete, correctly-threaded cancellation seam — the kind of thing you'd build specifically so a caller *could* cancel a run in progress.

Nobody calls it. `grep -rn "new AbortController" .` across the entire repo, including every test file, returns nothing. `session.ts:675` calls `agent.answer(question)` with zero options, so `runOptions.signal` defaults to `undefined` and every `throwIfAborted()` downstream is a no-op check against nothing. The OpenTUI UI has no cancel key. **The honest read:** this isn't "cancellation doesn't exist" — the mechanism is fully built and unit-testable in isolation. It's "cancellation was designed as a library capability and never connected to a trigger." **When this starts to matter:** the day someone wants a cancel key in the chat UI — at that point the work is entirely at the call site: construct an `AbortController` in `chat.tsx`, wire it to a keypress in `useKeyboard`, and pass `{ signal: ctrl.signal }` into `agent.answer` at `session.ts:675`. No kernel change required — that's the payoff of building the seam ahead of the caller.

**Timeouts / deadlines — `not yet exercised`, nowhere.** No `statement_timeout` on the pg side, no timeout option passed into the Ollama `fetch` from buffr's side (the gemma-provider *accepts* a signal that could double as a timeout trigger, per above — buffr just never constructs one). A wedged Ollama process — model still loading, GPU contention, a hung socket — hangs the turn indefinitely. The spinner and progress panel (`src/cli/chat.tsx`'s `ProgressPanel`) animate forever; `busy` stays `true`; the UI is stuck until the process is killed. **This is now the single largest hang risk in the interactive path** — Ctrl-C no longer hangs (see below), so a wedged model call is the one place a user can still get stuck without a clean way out other than force-quitting the terminal. **The fix:** `Promise.race([agent.answer(q, { signal: ctrl.signal }), deadline(N).then(() => ctrl.abort())])` at `src/session.ts:675` — cheap, because the signal parameter is already there.

```
  the wedge today — failure trace

  await agent.answer(q) ──► Ollama wedged (model loading / hung socket)
       │ no timeout, no signal passed (session.ts:675)
       ▼ ...waits...
  spinner spins ∞  ·  busy stays true  ·  UI accepts no input
       │
       ▼ escape: Ctrl-C — which now DOES force-exit within ~1.5s (see below)
```

**Shutdown — bounded, no longer abrupt, but still not fully graceful.** This section used to read `not yet exercised`. Two commits fixed it the same day (`64f822f`, `9c1b1e6`, Aug 2) after Ctrl-C was found to hang the process — a real incident, not a hypothetical, and worth walking in full because the fix has a subtlety worth understanding.

The naive fix — `process.on('SIGINT', () => session.close().then(() => process.exit(0)))` — has two problems, and the repo's final shape addresses both:

1. **`pool.end()` can itself hang.** If a query is mid-flight or a socket is in a bad state, `pool.end()` waits for it. A shutdown handler that `await`s an unbounded `close()` can hang exactly as badly as no handler at all. The fix: `session.close()` (`src/session.ts:876-881`) races `pool.end()` against a bare `setTimeout` —
   ```ts
   // src/session.ts:876-881 — close() no longer trusts pool.end() to return
   async close(): Promise<void> {
     await Promise.race([
       pool.end(),
       new Promise<void>(resolve => setTimeout(resolve, 1000)),
     ]);
   }
   ```
   `close()` now *always* resolves within 1s, whether or not the pool actually finished draining. That's a deliberate tradeoff: it trades "guaranteed clean drain" for "guaranteed to return" — see the principle below.

2. **`exitOnCtrlC: false` (passed to `createCliRenderer`) means SIGINT never fires from the terminal at all.** This is the non-obvious part. OpenTUI puts stdin into raw mode so it can read individual keystrokes for the textarea; in raw mode, Ctrl+C stops being a signal the terminal driver generates and becomes just another raw byte the application reads itself. `process.on('SIGINT', ...)` alone is a fix for a process that *isn't* holding stdin in raw mode — here it would sit registered and never trigger from a keypress. The repo closes that gap with an explicit handler inside the keyboard layer:
   ```ts
   // src/cli/chat.tsx:379-383 — Ctrl+C has to be caught as a keystroke, not a signal
   useKeyboard((e: any) => {
     if (e.ctrl && e.name === 'c') {
       onExit().catch(() => process.exit(1));
       return;
     }
     ...
   ```
   `process.on('SIGINT', forceExit)` (`src/cli/chat.tsx:466`) is kept too — not dead code, but the fallback for the one case the keyboard layer can't see: a signal sent from *outside* the terminal (`kill -INT <pid>`, a supervisor, a CI harness piping input). Two triggers, same `forceExit()`, because "the user pressed Ctrl+C" and "something sent SIGINT" are different events that happen to want the same response.

`forceExit()` itself (`src/cli/chat.tsx:464`) is the hard-deadline pattern that makes the whole thing bulletproof:
```ts
// src/cli/chat.tsx:464 — a timer that fires no matter what close() does
const forceExit = () => {
  setTimeout(() => process.exit(0), 1500).unref();  // fires regardless — the guarantee
  session.close().finally(() => process.exit(0));    // best-effort — may fire first if fast
};
```
Two competing exits, `.unref()`'d so the timer itself can't be the reason the process stays alive. Whichever fires first wins; both call `process.exit(0)`. The guarantee this buys: **the process always terminates within 1.5s of Ctrl-C, full stop** — no scenario in which stdin-in-raw-mode plus a stuck pool leaves a zombie terminal.

```
  two exit paths — one still fully clean, one now bounded

  ┌─ /exit (clean, no time pressure) ──────────────────────────┐
  │ handleSubmit sees /exit ─► onExit() ─► forceExit()          │
  │ ─► session.close() races 1s pool.end() ─► exit(0)           │
  └───────────────────────────────────────────────────────────┘
  ┌─ Ctrl-C (bounded — fixed Aug 2, was abrupt before) ─────────┐
  │ keystroke (raw mode, no SIGINT) ─► useKeyboard ─► onExit()  │
  │ EXTERNAL SIGINT (kill -INT) ─► process.on('SIGINT') ────────┤─► forceExit()
  │ forceExit(): hard 1.5s timer (always wins) races close()    │
  │ ✓ never hangs   ✗ NOT guaranteed to finish draining pending[]│
  └───────────────────────────────────────────────────────────┘
```

**The nuance worth naming precisely:** this is *bounded* shutdown, not *graceful* shutdown in the strict sense. Graceful means "finish draining, then exit." What's built here means "exit no later than ~1.5s, having *tried* to drain." If a turn is mid-`flush()` (trace writes still in `pending[]`, `03`) when Ctrl-C lands, and the pool takes the full second to close, those writes can still be lost — the same risk the old audit flagged, just now capped at ~1-1.5s of exposure instead of unbounded. That's a legitimate design call: the alternative (block indefinitely until every write lands) reintroduces the exact hang this fix was written to kill. Naming the tradeoff precisely — "always exits, may not finish draining" — is worth more in an interview than claiming it's now fully graceful.

**Backpressure on streams — `not yet exercised`.** The answer is still returned as one complete string (`src/session.ts:675`), rendered in one `setTurns` call in `handleSubmit`. There's no token-by-token streaming to the TTY, so there's no fast-producer/slow-consumer mismatch to manage — no `stream.write()` returning `false`, no `drain` event, no pause/resume. Backpressure becomes real only if buffr streams model output as it generates. **When this starts to matter:** the day the UI shows tokens as they arrive instead of waiting for the full answer. (Note: the `/research` progress panel *looks* like streaming — steps light up live via an `onProgress` callback — but that's status events, not token backpressure; the underlying answer text still arrives whole per stage.)

### Move 2 variant — the load-bearing skeleton of "bounded work"

1. **A deadline.** *Still missing.* Without it, any backend wedge hangs the turn forever. The addition is now cheap because the signal parameter already exists: `Promise.race([agent.answer(q, { signal: ctrl.signal }), deadline(N).then(() => ctrl.abort())])` at `src/session.ts:675`.
2. **A cancellation signal.** *Threaded through the kernel, not constructed anywhere.* The parameter exists at every layer (`packages/kernel/src/agents/rag-query-agent.ts:63` down to `packages/kernel/src/model-gateway/gemma-provider.ts:62`); what's missing is one `new AbortController()` and a keypress binding at the UI layer.
3. **A shutdown hook.** *Now present, and bounded rather than skipped.* `forceExit()` (`src/cli/chat.tsx:464`) races `session.close()` against a hard 1.5s timer, triggered both by a keystroke (`useKeyboard`, raw-mode TTY intercepts Ctrl+C before it becomes SIGINT) and by `process.on('SIGINT', ...)` as the external-signal fallback. It guarantees termination; it doesn't guarantee the drain finished.

The part that's been present since before this fix: **the concurrency bound** (the `busy` flag), which prevents overlapping turns. What changed: shutdown moved from missing to bounded. What's still missing: the deadline and the cancel trigger — both cheap, because #2's plumbing is already built.

### Move 3 — the principle

Bounded work is insurance you buy *before* you need it — and this repo's shutdown fix is the case study for why: it wasn't added speculatively, it was added *after* Ctrl-C actually hung the process, which is the expensive way to discover a missing bound. The fix itself teaches a second principle: **a bound only counts if it can't itself hang.** A shutdown handler that `await`s an unbounded `pool.end()` is not a fix — it's the same bug moved one level up. `Promise.race` against a hard, `.unref()`'d timer is what makes a bound trustworthy: it converts "should return quickly" into "provably returns by time T," at the cost of admitting the drain might not finish. That's the same tradeoff every timeout makes, just easiest to see at the one place in this repo where it's already been paid for.

---

## Primary diagram

The full bounding picture — what changed, what's wired-but-unused, what's still missing.

```
  Bounded work, cancellation, shutdown — full recap

  ┌─ PRESENT ───────────────────────────────────────────────────────┐
  │  concurrency bound: busy flag ── one turn at a time (chat + flows)│
  │     src/cli/chat.tsx:156                                          │
  │  queue bound: pending[] drained per flush ── bounded by one turn  │
  │     src/supabase-trace-sink.ts:91                                 │
  │  shutdown bound: forceExit() races close() vs hard 1.5s timer    │
  │     src/cli/chat.tsx:464-466, src/session.ts:876-881 (fixed Aug 2)│
  └─────────────────────────────────────────────────────────────────┘
  ┌─ WIRED, NEVER TRIGGERED ──────────────────────────────────────────┐
  │  AbortSignal threaded through every kernel/connector layer        │
  │  session.ts:675 never constructs one → dead capability today      │
  └─────────────────────────────────────────────────────────────────┘
  ┌─ ABSENT (not yet exercised) ──────────────────────────────────────┐
  │  ✗ per-turn deadline    → wedged model call hangs turn forever    │
  │                            (now the sharpest remaining gap)       │
  │  ✗ stream backpressure  → N/A (answer returned whole, not streamed)│
  └─────────────────────────────────────────────────────────────────┘
  Shutdown: bounded (always exits ≤1.5s). NOT the same as: drain guaranteed.
```

---

## Elaborate

A deadline, a cancellation token, and a shutdown hook are a package deal in production services: a request gets a deadline (don't wait forever), a cancellation token (stop work when the client disconnects), and the server gets a SIGTERM handler (drain in-flight work before the orchestrator kills it). This repo now has one of the three fully built (shutdown), one built as a library capability but never triggered (cancellation), and one genuinely missing (the deadline). That's a more interesting position than "none of them exist" — it shows the codebase over-building the cancellation seam ahead of a caller that needs it, which is a defensible bet if the kernel is meant to be reused by other UIs later, and a mild YAGNI flag if it isn't.

The shutdown fix is worth reading as a two-commit story, not one: `64f822f` added the pool-close race and a first `process.on('SIGINT', ...)`, and two minutes of wall-clock commit history later `9c1b1e6` discovered that handler alone didn't work — because `exitOnCtrlC: false` plus raw-mode stdin means the terminal never sends SIGINT for a Ctrl+C keystroke in the first place. That's the kind of bug you only find by actually testing Ctrl-C in the running TUI, not by reading the Node docs for `process.on('SIGINT')`. Worth remembering: a signal handler is necessary but not sufficient when something else (a TUI framework, a readline library, raw-mode stdin) is between the OS and your process.

---

## Interview defense

**Q: "What happens if the model call hangs? And what happens on Ctrl-C?"**

> Different answers now than they used to be, and the contrast is the interesting part. If Ollama wedges, the turn still hangs forever — there's no timeout on `agent.answer`, and although the kernel accepts an `AbortSignal` at every layer down to the fetch call, `session.ts` never constructs one, so it's dead capability today. That's the sharpest remaining gap. Ctrl-C used to hang too, but doesn't anymore: `forceExit()` races `session.close()` against a hard 1.5-second timer, and it's wired from two triggers — a keystroke handler in the TUI's keyboard layer, because raw-mode stdin means Ctrl+C never reaches the OS as SIGINT, plus `process.on('SIGINT')` as the fallback for an external signal. The guarantee is "exits within 1.5s," not "always finishes draining" — if a trace write is mid-flight when the timer fires, it can still be lost. That's a deliberate bound, not an oversight: the alternative is blocking forever on a hung pool, which is the exact bug this fix replaced.

```
  the two gaps, one sketch — before and after

  hang:   await agent.answer(q) ── no timeout, signal unused ── still spins ∞
  Ctrl-C: keystroke/SIGINT ── forceExit() races 1.5s timer ── ALWAYS exits now
                                (may not finish draining pending[])
  clean:  /exit ── same forceExit() path, no time pressure ── best-effort drain
```

**Anchor:** "The shutdown gap is fixed — `forceExit()` at `chat.tsx:464` races `session.close()` (`session.ts:876`) against a hard 1.5s deadline, triggered by both a raw-mode keystroke and a real SIGINT. The turn-hang gap isn't — `agent.answer` takes no signal at the call site, even though the kernel already accepts one three layers down."

---

## See also

- `02-processes-threads-and-tasks.md` — the long-lived process and its now-bounded shutdown hook
- `03-event-loop-and-async-io.md` — the `pending[]` queue this file bounds
- `05-memory-stack-heap-gc-and-lifetimes.md` — `turns[]`, the unbounded structure this file's discipline would cap
- `08-runtime-systems-red-flags-audit.md` — these gaps ranked by consequence
