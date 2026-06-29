# Rate limiting and backpressure — bounding concurrent work

*Industry standard pattern; not exercised in buffr (serial by
construction).*

## Zoom out, then zoom in

Pull up the path from "user submits" to "Ollama answers" and look
for where work could pile up faster than it drains. In buffr it
can't — the system is **serial by construction**: one
conversation, one question at a time, the UI blocked while busy.
There's no queue because there's nothing to queue. The one
backpressure-*shaped* guard is the context-window check that
refuses oversized input instead of overflowing.

```
  Zoom out — where a rate limiter / queue WOULD live (but doesn't)

  ┌─ CLI layer ─────────────────────────────────────────────────┐
  │  chat.tsx — input DISABLED while busy (natural backpressure) │
  └───────────────────────────┬─────────────────────────────────┘
                              │  one question, when ready
  ┌─ Session layer ───────────▼─────────────────────────────────┐
  │  [ NO QUEUE · NO CONCURRENCY CAP ]  ← serial, nothing to bound │
  └───────────────────────────┬─────────────────────────────────┘
                              │  one request at a time
  ┌─ Provider layer ──────────▼─────────────────────────────────┐
  │  ★ ContextWindowGuardedProvider — refuses > 8192 tokens ★    │ ← the one guard
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ Ollama (local) ──────────▼─────────────────────────────────┐
  │  gemma2:9b — one inference at a time on the laptop GPU        │
  └──────────────────────────────────────────────────────────────┘
```

The concept: backpressure is **the system telling the producer to
slow down** when the consumer can't keep up; rate limiting is
**capping requests per unit time** at a boundary. Both exist to
protect a bounded resource from an unbounded arrival rate. buffr
has no unbounded arrival rate — one human typing — so both are
dormant. The window guard is the closest thing: it refuses work
that won't fit, which is backpressure's *refuse* move without the
*queue* part.

## Structure pass

**Layers:** CLI (single producer) → session (no buffer) →
provider (one guard) → Ollama (single consumer).

**Axis — "control: who decides when the next unit of work
runs?"**

```
  trace "who admits the next request?" across the layers

  ┌─ CLI ───────────┐  seam   ┌─ provider ──────┐  seam   ┌─ Ollama ──────┐
  │ user submits    │ ═══════►│ guard: fits in  │ ═══════►│ runs it (one  │
  │ (blocked while  │ (size   │ 8192 tokens?    │ (no     │ at a time)    │
  │  busy)          │ check)  │ no → REFUSE     │ queue)  │               │
  └─────────────────┘         └─────────────────┘         └───────────────┘
       admission: the UI            admission: the              consumer:
       (busy flag)                  size guard                  serial

  the only "no, not yet" in the system is the size guard
```

The load-bearing seam is the provider's size check — it's the one
place buffr says "no" to work. The CLI's busy flag is the *only*
reason there's no concurrency to manage; remove it (batch
indexing many files) and the dormant concerns wake up.

## How it works

### Move 1 — the mental model

You know backpressure from streams: a slow consumer makes a
`Readable` pause the producer so the buffer doesn't blow up. Rate
limiting is the bouncer at the door counting people per minute.
Both are the same instinct — **don't let arrivals outpace
service** — applied at different boundaries. buffr's version of
this is the simplest possible: a queue of depth one (the current
question) and a producer (the human) who literally can't submit
while the consumer is busy.

```
  the backpressure kernel — bound the in-flight work

  producer ──► [ buffer / queue ] ──► consumer
                     │
                     │ buffer near full?
                     ▼
              signal producer: SLOW / WAIT / REFUSE
                     │
   buffr's version:  queue depth = 1, producer blocked while busy
                     → the signal is "input disabled"
```

### Move 2 — the step-by-step walkthrough

Walk the natural backpressure that's real, then the one explicit
guard, then the Case-B scenario where a real cap is needed.

**Step 1 — the UI is the natural backpressure (real).** The chat
loop disables input while a turn is in flight. The producer
*cannot* outrun the consumer because the producer is gated on the
consumer finishing:

```tsx
// src/cli/chat.tsx (onSubmit + render, condensed)
const onSubmit = async (value) => {
  if (busy) return;              // ← producer refused while consumer works
  setBusy(true);
  try { const answer = await session.ask(q); /* ... */ }
  finally { setBusy(false); }    // ← producer admitted again only when done
};
// render: while busy, show a spinner INSTEAD of the TextInput
//   → the user physically cannot submit a second question
```

That `if (busy) return` plus swapping the input for a spinner is
backpressure with a queue depth of one. It's not a rate limiter,
but it's the reason buffr never needs one: arrival rate is capped
at "one human, one at a time."

**Step 2 — the context-window guard is the one explicit refusal
(real).** This is the closest thing to a backpressure *mechanism*
in `src/`: the provider is wrapped so that input exceeding 8192
tokens is refused rather than sent to overflow the model's
window.

```ts
// src/session.ts:46
const model = new ContextWindowGuardedProvider(
  new GemmaModelProvider({ host: cfg.ollamaHost }),
  { maxTokens: 8192 },                // ← refuse, don't overflow
);
```

Trace the consequence: if retrieval + profile + question exceed
8192 tokens, the guard refuses instead of silently truncating or
crashing the model. That's the "REFUSE" arm of backpressure — the
system protecting a bounded resource (the context window) from an
oversized unit of work. What it is *not*: a queue, a retry, or a
per-second cap. It bounds *size*, not *rate*.

```
  the guard's decision — bound input SIZE (not rate)

  request tokens ──► ┌─ ContextWindowGuardedProvider ─┐
                     │  tokens ≤ 8192 ? ─yes─► forward │──► Ollama
                     │       │ no                       │
                     │       ▼                          │
                     │    REFUSE (don't overflow)       │
                     └──────────────────────────────────┘
```

**Step 3 — where a real cap WOULD be needed (Case B).** The
dormant concern wakes the instant buffr does concurrent work. The
obvious trigger: batch indexing. Today `npm run index -- a.md
b.md` loops files **serially** in `src/cli/index-cmd.ts`:

```ts
// src/cli/index-cmd.ts (the indexing loop) — serial today
for (const path of paths) {
  const text = await readFile(path, 'utf8');
  await indexDocumentRow(pool, cfg.appId, pipeline, { ... });  // ← one at a time
}
```

If you sped that up by embedding many files **concurrently**, you'd
suddenly have N requests hitting one local Ollama instance that
serves one inference at a time. *Now* you need a concurrency cap —
a semaphore that admits, say, 2–4 embeds at once and makes the
rest wait. That's the real backpressure exercise: bound the
in-flight requests to what the laptop GPU can actually serve.

```
  layers-and-hops — Case-B concurrency cap on batch indexing

  ┌─ index-cmd ───┐ hop 1: N files   ┌─ Semaphore ──┐
  │ index a..z.md │ ────────────────►│ cap = 4      │
  └───────────────┘                  │ admit ≤ 4    │
                              hop 2: │ rest WAIT     │
                            admitted ▼               │
                                   ┌─ Ollama ───────┐│
                                   │ embeds (serial  ││
                                   │ inference)      ││
                                   └─────────────────┘│
                              hop 3: done → admit next ┘
```

### Move 2 variant — the load-bearing skeleton

Kernel of backpressure: **a bounded buffer + an admission
decision + a signal to the producer.**

- Drop the **bound** → the buffer grows unbounded; memory blows
  up or the consumer is swamped. (buffr's bound is "depth 1, UI
  gated" — trivially safe.)
- Drop the **admission decision** → every request goes through;
  the size guard is exactly this decision for *size*.
- Drop the **producer signal** → the producer keeps pushing; in
  buffr the signal is the disabled input.

Skeleton = bound + admit/refuse + signal. Token-bucket rate
limiting, fair queueing, and priority lanes are hardening on top.

### Move 2.5 — current state vs future state

```
  Phase A (today)                  Phase B (Case B — concurrent indexing)
  ─────────────                    ──────────────────────────────────────
  one human, one question          batch index runs files concurrently
  UI gates the producer            semaphore caps in-flight embeds
  context guard refuses big input  context guard unchanged
  no rate/concurrency cap needed   cap = what the GPU can serve at once
```

What doesn't change: chat stays serial; the context guard stays
exactly as is. Phase B only adds a cap to the *one* path that
could go concurrent — indexing.

### Move 3 — the principle

Backpressure and rate limiting protect a bounded resource from an
unbounded arrival rate. buffr is the degenerate, honest case:
arrival rate is bounded by physics (one human, gated UI), so the
machinery is dormant. The one guard it does have — refusing
oversized input — is backpressure's "refuse" move on the *size*
axis rather than the *rate* axis. The day any path goes concurrent
(batch indexing is the obvious one), the rate axis comes alive and
you cap in-flight work to what the consumer can actually serve.

## Primary diagram

```
  buffr backpressure — real guards (solid) vs dormant cap (dashed)

  CLI:      chat.tsx ── busy? ──► input DISABLED   ◄── natural backpressure
                          │ not busy                    (queue depth 1)
                          ▼
  Provider: ContextWindowGuardedProvider             ◄── REFUSE oversized
            tokens ≤ 8192 ? forward : refuse              (size axis, REAL)
                          │
                          ▼
  Ollama:   gemma2:9b — one inference at a time

  ┄┄┄ Case B (dormant) ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  index-cmd ─► [ semaphore cap=4 ] ─► Ollama embeds   (rate axis)
```

## Elaborate

Rate limiting and backpressure are the two answers to "arrivals
exceed service." Rate limiting (token bucket, leaky bucket, fixed
window) lives at an API boundary and protects a *shared* resource
from *many* clients — buffr has no shared boundary and one client,
so it's structurally N/A. Backpressure lives inside a pipeline and
protects a *downstream* stage from an *upstream* one; buffr's
pipeline is a depth-one queue gated by the UI, so it's trivially
satisfied. The single genuinely-engineered piece is the
context-window guard, which is the size-axis cousin of the same
family — it refuses a unit of work too big for the consumer rather
than letting it overflow. The moment you parallelize indexing, the
rate axis becomes real and you reach for a concurrency semaphore;
that's the one place the dormant concept earns its Case-B exercise.

## Project exercises

> No curriculum file present; exercises derived from the
> codebase. Case B — no queue or rate cap is exercised; chat is
> serial by construction.

### Concurrency cap on batch indexing

- **Exercise ID:** RATE-1 (Case B — the real backpressure
  scenario).
- **What to build:** parallelize the indexing loop, then bound it
  with a semaphore that admits a fixed number of concurrent embeds
  (e.g. 4) and makes the rest wait — so you don't swamp the single
  local Ollama instance.
- **Why it earns its place:** it's the one path in buffr where
  concurrency is real, so it's where the bound + admit + signal
  kernel actually has to work; a clean "I capped in-flight work to
  what the consumer could serve" story.
- **Files to touch:** `src/cli/index-cmd.ts` (the `for` loop) and
  `src/runtime.ts indexDocumentRow`.
- **Done when:** indexing many files runs faster than serial but
  never exceeds the configured concurrency, verified by logging
  in-flight count.
- **Estimated effort:** 1–4hr.

### Make the context-guard refusal observable

- **Exercise ID:** RATE-2 (Case A — surface the one real guard).
- **What to build:** when `ContextWindowGuardedProvider` refuses
  oversized input, surface it as a clear user-facing message and a
  `warning` trace event instead of a generic error.
- **Why it earns its place:** turns the one real backpressure
  guard from a silent refusal into a measurable, explainable event
  — the observability half of backpressure.
- **Files to touch:** `src/session.ts:46` (catch/translate the
  refusal), `src/cli/chat.tsx` (the error branch),
  `src/supabase-trace-sink.ts` (already handles `warning`).
- **Done when:** an oversized question produces a readable "input
  too large" message and a traced warning.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: How does buffr handle rate limiting and backpressure?**
Answer: it doesn't need most of it — it's single-user local, so
the arrival rate is one human, and the UI gates the producer
(`if (busy) return` plus swapping the input for a spinner), giving
a queue of depth one. There's no provider rate limit because
there's no paid provider. The one real backpressure-shaped guard
is `ContextWindowGuardedProvider` (`src/session.ts:46`), which
refuses input over 8192 tokens rather than overflowing the window.

**Q: When would you actually need a real cap, and what would you
add?**
Answer: the moment any path goes concurrent — batch indexing is
the obvious one. If I parallelized the index loop, N embeds would
hit one local Ollama that serves one inference at a time, so I'd
add a concurrency semaphore capping in-flight requests to what the
GPU can serve. **The load-bearing part people forget is the
producer signal** — bounding the buffer is useless if you don't
make the producer wait; in buffr today that signal is the disabled
UI, and in the indexing case it'd be the semaphore making excess
embeds await a slot.

```
  the one-liner:  no unbounded arrival rate → no rate limiter  ·
                  the one guard refuses SIZE (8192 tokens)  ·
                  concurrency cap wakes up only if indexing
                  goes parallel
```

## See also

- `05-retry-circuit-breaker.md` — the other half of resilience:
  what to do when the bounded call *fails*, not when it's
  *oversized*.
- `02-llm-cost-optimization.md` — latency as the local budget the
  concurrency cap is protecting.
- `../02-context-and-prompts/01-context-window.md` — the 8192
  bound the guard enforces, from the prompt side.
