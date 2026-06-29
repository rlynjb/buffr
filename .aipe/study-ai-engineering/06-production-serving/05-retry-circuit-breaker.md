# Retry and circuit breaker — surviving a flaky dependency

*Industry standard patterns; not exercised in buffr (no retry, no
breaker).*

## Zoom out, then zoom in

Pull up the moment buffr calls Ollama and ask: what happens if
that call fails — a dropped connection, a model still loading, a
timeout? Today the answer is **the error propagates straight up to
the UI and the turn is lost.** There's no retry, no backoff, no
breaker. The one resilience pattern in the code is the *opposite*
move: the memory-write swallow, which catches a failure and *gives
up* on purpose.

```
  Zoom out — where retry / breaker WOULD live (but doesn't)

  ┌─ CLI layer ─────────────────────────────────────────────────┐
  │  chat.tsx — catch(err) → shows "error: ..." to the user      │ ← failure surfaces here
  └───────────────────────────┬─────────────────────────────────┘
                              │  session.ask throws
  ┌─ Session layer ───────────▼─────────────────────────────────┐
  │  agent.answer()  [ NO RETRY · NO BREAKER ]                   │
  │  memory.remember() in try/catch → SWALLOW (give up, not retry)│ ← src/session.ts:64-70
  └───────────────────────────┬─────────────────────────────────┘
                              │  one attempt
  ┌─ Ollama (local) ──────────▼─────────────────────────────────┐
  │  ★ gemma2:9b / embedder — the flaky dependency ★             │ ← we are here
  └──────────────────────────────────────────────────────────────┘
```

Two concepts, both dormant. **Retry with backoff**: a transient
failure is retried a few times with growing waits, because flakes
are often momentary. **Circuit breaker**: after repeated failures
you stop calling the dead dependency entirely for a while, so you
fail fast instead of hammering it. buffr has neither — and the one
try/catch it does have is a "give up," not a "try again."

## Structure pass

**Layers:** CLI (surfaces failure) → session (no resilience) →
Ollama (the dependency that can fail).

**Axis — "failure: what happens when the Ollama call throws?"**

```
  trace "what happens on failure?" across the layers

  ┌─ Ollama call ───┐ seam  ┌─ session ───────┐ seam  ┌─ CLI ─────────┐
  │ throws (timeout,│ ═════►│ NOT caught for  │ ═════►│ catch → show  │
  │ down, loading)  │ (no   │ the model call; │ (UI   │ "error: ..."  │
  │                 │ retry)│ propagates up   │ catch)│ turn lost     │
  └─────────────────┘       └─────────────────┘       └───────────────┘
        │
        └─ EXCEPT memory.remember: caught + SWALLOWED (give up)

  failure answer: model call → propagate · memory write → swallow
```

The load-bearing seam is the Ollama call — it's the boundary where
a transient external failure becomes buffr's problem. Today buffr
does nothing protective at that seam for the model call. The one
place it *does* contain failure (memory write) chooses
abandonment, which is correct for best-effort data but is not
resilience.

## How it works

### Move 1 — the mental model

You know retry from a flaky `fetch()` — you wrap it in a loop that
tries 3 times with a growing delay, because the server was
probably just briefly busy. A circuit breaker is the next idea:
after enough failures you stop trying for a while, like a fuse
that trips so you stop flipping a switch on a dead circuit. Retry
handles *momentary* failures; the breaker handles *sustained*
ones — and the breaker exists precisely so retries don't turn a
dead dependency into a self-inflicted hammering.

```
  retry + breaker kernel — two timescales of failure

  call dependency
     │
     ▼
  fail? ──no──► return result
     │ yes
     ▼
  attempts < max AND breaker CLOSED?
     │ yes                         │ no
     ▼                             ▼
  wait backoff(attempt); retry   fail fast (breaker OPEN)
     │                             │
     └─ too many fails ───────────►trip breaker OPEN (stop calling)
                                    │ after cooldown
                                    └─► HALF-OPEN: test one call
```

### Move 2 — the step-by-step walkthrough

Walk the one resilience pattern buffr *does* have, see why it's
not retry, then the Case-B wrap.

**Step 1 — the one real pattern: best-effort swallow (give up,
not retry).** This is the closest thing to a resilience mindset in
`src/`, and it's important to see why it's *not* retry:

```ts
// src/session.ts:64-70 (the memory-write swallow)
const answer = await agent.answer(question);
await trace.flush();
// Best-effort: a memory-write failure must not lose the answer the user has.
try {
  await memory.remember({ conversationId, question, answer });
} catch {
  // swallow: memory is best-effort, the turn already succeeded
}
return answer;
```

This is **failure containment**: a memory-write failure is
isolated so it can't destroy the answer the user already has. The
right call for best-effort data. But notice what it does on
failure — it gives up *immediately* and moves on. No retry, no
record that it failed. It's the "swallow" arm of resilience, not
the "recover" arm. Contrast it with what's missing: the
`agent.answer()` call on the line above is **not** wrapped at all
— if Ollama is down, that throws and the whole turn fails up to the
CLI's catch.

```
  two failure policies in one function, side by side

  agent.answer()        → NO guard    → throws → turn lost      (gap)
  memory.remember()     → try/catch   → swallow → turn survives (real)
                                         ▲
                          "give up on this side-effect," NOT "retry"
```

**Step 2 — the missing retry-with-backoff (Case B).** The
`agent.answer()` and embed calls hit a *local* Ollama that can
genuinely flake: the model is still loading into VRAM on first
call, the daemon restarted, a request timed out. Those are
*transient* — a second attempt a moment later usually works. A
retry wrapper around the Ollama-touching calls would catch exactly
this class. The shape: try, on failure wait an exponentially
growing delay, retry up to a cap, then surface the error.

```
  retry-with-backoff over the Ollama call (Case B)

  attempt 1 ──fail──► wait 200ms
  attempt 2 ──fail──► wait 400ms     ← exponential backoff
  attempt 3 ──fail──► wait 800ms       (avoid hammering a busy daemon)
  attempt 4 ──fail──► give up, surface error to CLI

  buffr today: attempt 1 ──fail──► give up  (max attempts = 1)
```

**Step 3 — the missing circuit breaker (Case B).** Retry is wrong
when the dependency is *sustainedly* dead — if Ollama isn't
running at all, retrying with backoff just makes every turn slow to
fail. A breaker fixes that: after K consecutive failures it
**opens** and fails fast for a cooldown, so the user gets an
immediate "Ollama looks down, start it" instead of waiting through
four backoff delays per turn. After the cooldown it goes
**half-open**, tests one call, and closes if it succeeds.

```
  the breaker's three states (the part people forget)

  CLOSED ──K failures──► OPEN ──cooldown──► HALF-OPEN
    ▲                      │                   │
    │                      │ fail fast          │ test 1 call
    │                      │ (no real call)     │
    └──────success─────────┴────────────────────┘
                       (success closes it again)
```

For buffr the breaker's payoff is a *good local UX*: when you
forgot to start Ollama, you want one fast clear message, not four
slow timeouts per question.

### Move 2 variant — the load-bearing skeleton

Kernel of resilience: **detect failure + decide retry-or-give-up +
(across calls) trip a breaker on sustained failure.**

- Drop **failure detection** → you can't react; the error just
  propagates. (buffr detects only the memory-write failure.)
- Drop the **retry decision** → transient flakes become lost
  turns. (buffr: missing — max attempts is effectively 1.)
- Drop the **breaker** → a dead dependency gets hammered and every
  call is slow-to-fail. (buffr: missing.)
- The **backoff** is the part people botch — retrying with *no*
  delay turns a busy dependency into a thundering herd; the
  exponential wait is what makes retry safe.

Skeleton = detect + retry-or-give-up + breaker. Jitter, per-error
classification (retry timeouts, don't retry 4xx-equivalents), and
budgets are hardening on top.

### Move 2.5 — current state vs future state

```
  Phase A (today)                  Phase B (Case B — wrap Ollama)
  ─────────────                    ──────────────────────────────
  agent.answer(): no guard         retry-with-backoff around Ollama
  one attempt → fail → turn lost   calls (model + embed)
  Ollama down → 4 slow timeouts/q  breaker opens → one fast clear
  memory write: swallow (give up)  message "Ollama down"
                                   memory swallow: UNCHANGED (correct)
```

What doesn't change: the best-effort memory swallow stays — giving
up on a side-effect is the right call. Phase B wraps the
*load-bearing* call (the model) that today has no guard at all.

### Move 3 — the principle

Resilience is two decisions at two timescales: on a *single*
failure, retry-or-give-up; across *repeated* failures, trip a
breaker so retries don't pile onto a corpse. buffr today makes
neither — it has exactly one failure policy (swallow the
best-effort memory write) and lets the load-bearing model call fail
on the first flake. The general lesson the swallow *does* teach is
real and worth keeping: **classify each failure by whether the
caller can survive without the result.** Memory can be lost; the
answer cannot — and the answer's dependency (Ollama) is the one
that deserves the retry/breaker buffr hasn't built.

## Primary diagram

```
  buffr resilience — real (solid) vs dormant (dashed)

  CLI:      chat.tsx catch(err) ─► "error: ..."   ◄── failures land here, turn lost
                          ▲
  Session:  agent.answer() ── throws ─────────────┘   ◄── NO guard (the gap)
            │
            └─ memory.remember() ── try/catch ─► SWALLOW   ◄── real: give up (correct)

  ┄┄┄ Case B (dormant) ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  retry(backoff) around Ollama call ──► breaker(CLOSED→OPEN→HALF)
     transient flake → retry            Ollama down → fail fast, clear msg
```

## Elaborate

Retry-with-backoff and the circuit breaker (popularized by
Nygard's *Release It!* and Hystrix) are the canonical pair for a
flaky downstream dependency. They're usually taught for *network*
dependencies, but buffr's Ollama is a local process — and a local
process flakes too: cold model loads, daemon restarts, timeouts
under GPU contention. The reason buffr hasn't built them is the
same honest reason it lacks a cache or a rate limiter: single-user
local, one call at a time, and a human who can just retype the
question. But the cost-benefit flips the instant you care about
unattended runs (batch indexing, a scheduled re-index) where no
human is watching to retry. The one pattern buffr *did* build —
the best-effort swallow — is the right reflex pointed at the wrong
end: it protects a disposable side-effect while the irreplaceable
call (the answer) runs bare. Pointing that same failure-classifying
instinct at the model call is the whole Case-B exercise.

## Project exercises

> No curriculum file present; exercises derived from the
> codebase. Case B — neither retry nor breaker is exercised.

### Retry-with-backoff around the Ollama calls

- **Exercise ID:** RETRY-1 (Case B — the core resilience add).
- **What to build:** a wrapper that retries the model and embed
  calls on transient failure with exponential backoff (e.g. 3
  attempts, 200/400/800ms), surfacing the error only after the cap.
- **Why it earns its place:** turns a cold-model-load or momentary
  timeout from a lost turn into a recovered one — the canonical
  "I made my flaky dependency survivable" story, with backoff (the
  part people botch) front and center.
- **Files to touch:** wrap the model provider at `src/session.ts:46`
  (compose around `GemmaModelProvider`/`OllamaEmbeddingProvider`),
  or a new `src/retry.ts`.
- **Done when:** a simulated transient Ollama failure is retried
  and the turn succeeds, verified by a test that fails once then
  succeeds.
- **Estimated effort:** 1–4hr.

### Circuit breaker for a down Ollama

- **Exercise ID:** RETRY-2 (Case B — the sustained-failure half).
- **What to build:** a breaker around the Ollama calls that opens
  after K consecutive failures and fails fast with a clear "Ollama
  appears to be down — start it with `ollama serve`" message,
  half-opening after a cooldown.
- **Why it earns its place:** forces the three-state machine
  (closed/open/half-open) and delivers real local UX — one fast
  clear message instead of four slow timeouts when you forgot to
  start Ollama.
- **Files to touch:** same wrap point as RETRY-1
  (`src/session.ts:46`), plus the CLI error branch in
  `src/cli/chat.tsx` to render the breaker message.
- **Done when:** with Ollama stopped, the second query fails
  *fast* with the clear message rather than waiting through retries.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: What's buffr's failure handling around the model call?**
Answer: honestly, almost none. The `agent.answer()` call to Ollama
has no retry and no circuit breaker — a transient flake (cold model
load, timeout) propagates straight to the CLI and the turn is lost.
The only resilience pattern in the code is the *opposite* move: the
memory-write swallow at `src/session.ts:64-70`, which catches a
best-effort failure and gives up so the answer the user already has
isn't lost. That's failure *containment*, not recovery.

**Q: What would you add, and what's the difference between the two
patterns?**
Answer: retry-with-backoff for *transient* failures, a circuit
breaker for *sustained* ones. Retry handles "Ollama was briefly
busy" — try again with a growing delay. The breaker handles "Ollama
is down" — after K failures it opens and fails fast so I'm not
waiting through retries every turn, then half-opens to test
recovery. **The load-bearing part people forget is the breaker's
half-open state** — without it the breaker either stays open
forever or flaps; the single test call is how it safely closes
again. And the backoff matters: retrying with no delay just hammers
a busy daemon.

```
  the one-liner:  retry = momentary failure (backoff, don't hammer)  ·
                  breaker = sustained failure (fail fast, half-open to
                  recover)  ·  buffr has neither, only a give-up swallow
```

## See also

- `04-rate-limiting-backpressure.md` — the other resilience axis:
  bounding work that's *oversized* or *too concurrent*, vs work
  that *failed*.
- `../04-agents-and-tool-use/06-error-recovery.md` — recovery
  *inside* the agent loop (a tool error becomes an observation),
  the complement to recovery *around* the model call.
- `../01-llm-foundations/08-provider-abstraction.md` — the provider
  seam where a retry/breaker wrapper would compose.
