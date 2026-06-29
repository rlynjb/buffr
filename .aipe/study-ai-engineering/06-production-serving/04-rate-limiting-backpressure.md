# Rate Limiting & Backpressure

*Industry name: rate limiting / admission control / backpressure. Type: **Language-agnostic** serving pattern.*

## Zoom out, then zoom in

Rate limiting and backpressure are how a server protects itself from being asked to do more than it can. You know the symptoms from the web: a `429 Too Many Requests`, a `Retry-After` header, a request that queues instead of crashing the box. Here's where that machinery would sit in buffr — and for a single local user, most of the slots are honestly empty by design.

```
buffr serving stack — the missing admission control
┌──────────────────────────────────────────────────────────────┐
│ chat.tsx     ◀── ★ `if (busy) return` — the ONLY backpressure  │  (single-turn lock)
├──────────────────────────────────────────────────────────────┤
│ session.ask()  ◀── ★ QUEUE + CONCURRENCY CAP would go here     │  (empty)
├──────────────────────────────────────────────────────────────┤
│ RagQueryAgent ──▶ embed + pgvector + GemmaModelProvider        │
├──────────────────────────────────────────────────────────────┤
│ Ollama server   ◀── ★ the thing that actually saturates        │  one GPU/CPU
└──────────────────────────────────────────────────────────────┘
```

Buffr is one human typing one question at a time. There is no traffic to limit, no fleet of clients to fairness-schedule. **This is Case B: no rate limiter, no request queue, no concurrency cap is implemented.** But there *is* one real piece of backpressure — the `busy` flag in `chat.tsx` — and the thing it protects, the Ollama server, is genuinely saturatable. This file names the live piece, marks the empty slots, and names the exact trigger that flips this from N/A to required.

## Structure pass — trace *what happens to a second request* while the first runs

Pick one axis: **if a request arrives while one is in flight, what happens to it?** Trace it.

```
second-request behavior (buffr today)
  TUI path (chat.tsx):
    turn 1 in flight ──▶ user hits enter again ──▶ `if (busy) return`  ◀ dropped, silently
                                                    (no queue, no error, just ignored)
  programmatic path (if someone scripts session.ask() concurrently):
    call 1 ──┐
    call 2 ──┼──▶ ALL hit Ollama at once ──▶ server contends for one GPU  ◀ no cap
    call 3 ──┘                                (slower for everyone, no admission control)
```

There's no seam for the programmatic path — that's the latent problem. The TUI has a crude one (drop the second submit), but it's a UI guard, not server protection. The concrete consequence: the `busy` flag only exists because the *chat UI* is single-turn; nothing stops a script from firing ten `session.ask()` calls at once and saturating the single Ollama process, at which point every request slows down and there's no fairness, no queue, no shedding.

## How it works

### Move 1 — the mental model: a bounded buffer between fast producers and a slow consumer

Backpressure is what a bounded buffer does when it fills: it pushes back on the producer instead of overflowing. The producer is incoming requests; the consumer is the slow resource (Ollama, one generation at a time on one GPU). A queue with a *cap* and a *concurrency limit* sits between them: admit up to N in flight, queue up to M waiting, and when both are full, *shed* (reject with a clear signal) rather than melt down.

```
the bounded-buffer shape
  requests ──▶ [ queue, cap M ] ──▶ [ in-flight, cap N ] ──▶ Ollama (slow)
                    │                      │
              full? shed (429-like)   N reached? wait in queue
              ◀ backpressure: push back, don't overflow
```

### Move 2 — the moving parts

#### Bridge: it's a `429` and a `Retry-After`, but the server is your laptop

You already understand this from the client side — you back off when an API returns `429`. Backpressure is that same contract from the *server's* side: the server decides when to say "not now," based on how loaded it is. The terminology lead is **backpressure (the `busy` single-flight lock)** — "single-flight" because buffr's one real piece of it allows exactly one in-flight turn through the UI.

#### The live piece: `if (busy) return` in `chat.tsx`

The Ink chat guards against concurrent submits with a boolean (`src/cli/chat.tsx:13,17,26,33`):

```ts
// src/cli/chat.tsx:13
const [busy, setBusy] = useState(false);

const onSubmit = async (value: string): Promise<void> => {
  const q = value.trim();
  if (busy) return;                 // ← drop the submit if a turn is already running
  // ...
  setBusy(true);
  try {
    const answer = await session.ask(q);
    // ...
  } finally {
    setBusy(false);                 // ← release the lock when the turn completes
  }
};
```

```
the busy lock — single-flight at the UI, not the server
  busy=false ──▶ submit allowed ──▶ setBusy(true) ──▶ ask() runs ──▶ finally setBusy(false)
       ▲                                  │
       └────── second submit while true ──┘  ◀ `if (busy) return` drops it
```

This is real backpressure, but understand its scope precisely: it is a **UI single-flight lock**, not server admission control. It guarantees the *chat UI* never has two turns running at once. It does *nothing* if a different caller — a script, a future HTTP wrapper, a second TUI instance — calls `session.ask()` directly. The protection lives in the wrong layer to be a server defense; it's a UX guard that happens to also serialize Ollama access *for this one client*.

#### The empty slots: queue, concurrency cap, shedding

The slots that would make this real server protection are all empty:

- **No request queue.** A second concurrent `session.ask()` doesn't wait its turn — it races straight to Ollama.
- **No concurrency cap.** Nothing limits how many generations hit Ollama at once. The implicit cap is "however many callers call at once."
- **No load shedding.** Nothing rejects a request when overloaded. There's no `429`-equivalent, no `Retry-After`, no clear "try again later."

```
the three empty slots (and the one trigger that fills them)
  queue:        none   ── fills when: >1 concurrent caller exists
  concurrency:  uncapped ── fills when: a fleet (not one human) submits
  shedding:     none   ── fills when: load can exceed Ollama's throughput
  ───────────────────────────────────────────────────────────────────────
  TRIGGER: the moment buffr serves more than one user / device / over a network
```

### Move 2.5 — current vs future

```
current (buffr today)               │  future (after the exercise / multi-user)
──────────────────────────────────────┼──────────────────────────────────────────
in-flight limit: 1 (UI lock only)    │  N-concurrency cap at session/server layer
second request: dropped (TUI) /       │  queued up to M, then shed with a clear signal
                races to Ollama (API)  │
overload behavior: Ollama contends    │  admission control protects Ollama throughput
fairness: none                        │  FIFO queue (or priority) across callers
```

The honest shape: buffr's backpressure is correct *for its current shape* (one UI, one user) and absent *for any other shape*. The `busy` flag is the right amount of mechanism for a single-turn TUI and the wrong layer entirely for a multi-client server.

### Move 3 — the principle

**A slow consumer must be allowed to push back, or a fast producer will drown it.** The mechanism — UI lock, queue, concurrency cap, load shedding — scales with the number of producers. One producer (one human at a keyboard) needs only a single-flight lock, which is exactly what buffr has. More producers need a real bounded buffer with admission control, which is exactly what buffr lacks. Match the mechanism to the producer count; don't build a queue for an audience of one.

## Primary diagram

The whole backpressure story: one live UI lock, the saturatable resource it incidentally protects, and the empty server-side slots.

```
buffr backpressure — UI lock live, server admission control empty
  UI CLIENT (chat.tsx)                          OTHER CALLERS (scripts, future HTTP)
  ┌────────────────────┐                        ┌────────────────────┐
  │ if (busy) return    │ ◀ single-flight LOCK   │ session.ask() ×N    │ ◀ no lock
  │ setBusy(true/false) │   (protects THIS UI)   │ all race            │
  └─────────┬──────────┘                        └─────────┬──────────┘
            │                                              │
            └──────────────┐              ┌────────────────┘
                           ▼              ▼
              ★ QUEUE + CONCURRENCY CAP (empty) — would admit/queue/shed here
                           │
                           ▼
                    Ollama server  ◀ ONE GPU/CPU, the actually-saturatable resource
```

## Elaborate

Why this is **Case B and the right call**: building a rate limiter for a single local user is solving a problem you don't have. The `busy` flag is precisely enough — it stops the one realistic failure (a user double-submitting and getting two interleaved generations) with one boolean. Adding a queue and concurrency cap now would be speculative complexity, the kind APOSD warns against: mechanism with no load to justify it.

The trigger that flips it is sharp and worth memorizing: **the moment buffr has more than one concurrent producer.** That happens if you wrap `session.ask()` in an HTTP endpoint, run buffr as a shared team service, or even script batch questions against it. At that point the `busy` flag is useless (it's per-UI-instance) and Ollama — which serializes generations on one device — becomes the bottleneck that *needs* a cap, because uncapped concurrency against a single-GPU Ollama doesn't fail loudly; it just makes everyone slow with no fairness and no signal. The fix is a server-layer semaphore (concurrency cap) plus a bounded queue with shedding, placed at `session.ask()` or the HTTP boundary — *not* in the React component.

## Project exercises

### Exercise: concurrency cap + bounded queue at the session layer

- **Exercise ID:** [B5.8] (Phase 5, production-serving)
- **What to build:** A semaphore-backed admission layer around `session.ask()`: cap concurrent generations at N (start at 1, since Ollama serializes anyway), queue up to M waiters, and shed beyond M with a clear, typed error (the `429`-equivalent). This makes backpressure a *server* property, independent of any UI.
- **Why it earns its place:** It moves protection from the wrong layer (a React boolean that only guards one UI) to the right one (the shared entry point every caller goes through), and it's the prerequisite for ever exposing buffr over a network without melting Ollama under concurrent load.
- **Files to touch:** `src/session.ts` (wrap `ask()` in the admission layer), a new `src/admission.ts` (the semaphore + bounded queue), `src/cli/chat.tsx` can then drop or keep the `busy` flag as a UX nicety.
- **Done when:** Firing N+M+1 concurrent `session.ask()` calls results in exactly N running, M queued, and the rest rejected with a clear "try again" signal — and Ollama is never hit by more than N generations at once.
- **Estimated effort:** One day.

### Exercise: per-caller rate limit for a multi-user wrapper

- **Exercise ID:** [B5.9] (Phase 5, production-serving)
- **What to build:** If/when buffr is wrapped in an HTTP endpoint, a token-bucket rate limiter keyed per caller (IP, API key, or user id) that returns a real `429` with `Retry-After` when a caller exceeds their budget — the classic web contract, now on the server side.
- **Why it earns its place:** It introduces fairness across callers, which the concurrency cap alone doesn't give (one greedy caller could still fill the whole queue). It's the standard multi-tenant defense and pairs naturally with the admission layer.
- **Files to touch:** A new HTTP layer (does not exist yet — this exercise is partly "stand up the endpoint"), the limiter middleware, reusing `src/session.ts`'s admission layer beneath it.
- **Done when:** A single caller exceeding their token budget receives `429 + Retry-After` while other callers are unaffected — proving per-caller fairness, not just global capacity.
- **Estimated effort:** One to two days (includes standing up the endpoint).
- **Case note:** This is two steps out — it requires the HTTP wrapper (Case B) *and* the admission layer ([B5.8]) first. Treat [B5.8] as the primary; this is the multi-user follow-on.

## Interview defense

**Q: "How does buffr handle rate limiting and backpressure?"**

Honestly: it mostly doesn't, and that's correct for a single-user local agent. The one real piece is a single-flight lock — `if (busy) return` in the Ink chat — which stops the user from double-submitting and getting interleaved generations. But that's a *UI* guard, not server admission control: it only protects the one chat instance and does nothing against a script or a future HTTP wrapper calling `session.ask()` concurrently. There's no queue, no concurrency cap, no load shedding. The thing that actually saturates is the Ollama server, which serializes generations on one GPU — so uncapped concurrency wouldn't crash, it'd just make everyone slow with no fairness.

```
buffr backpressure today
  live: `if (busy) return`  ── UI single-flight lock (one client only)
  empty: queue / concurrency cap / shedding  ── server admission control
  trigger to build: >1 concurrent producer (HTTP wrap, team service, batch script)
```

*Anchor:* "The busy flag is the right mechanism for an audience of one, and the wrong layer for an audience of two."

**Q: "What breaks first if you put buffr behind an HTTP endpoint as-is?"**

Ollama. The `busy` flag is per-UI-instance, so it provides zero protection across HTTP callers — every concurrent request races straight to the single Ollama process. It won't error loudly; it'll just contend for one GPU and slow everyone down with no fairness and no signal to back off. The fix is a server-layer semaphore at `session.ask()` (concurrency cap N, since Ollama serializes anyway) plus a bounded queue with shedding — admission control in the shared layer, not the React component.

```
HTTP-wrap failure mode
  busy flag: per-UI, useless across callers
  Ollama: serializes on 1 GPU ──▶ uncapped concurrency = slow-for-all, no fairness
  fix: semaphore + bounded queue at session.ask() (server layer)
```

*Anchor:* "Put the cap where every caller passes through, not where one UI does."

## See also

- `../../study-runtime-systems/` — bounded work, semaphores, and cancellation as runtime-execution mechanics.
- `05-retry-circuit-breaker.md` — the client-side counterpart: backpressure is the server saying "not now"; retry/breaker is the client *hearing* it correctly.
- `02-llm-cost-optimization.md` — routing reduces the *load* a limiter has to shed by making cheap requests cheaper.
- `../00-overview.md` — where the single-process, single-device shape of buffr is framed.
