# Fan-Out Backpressure

*Industry names: **concurrency limiting** (the semaphore) / **backpressure** (the upward
signal). Type label: Industry standard. In buffr: NOT YET — single agent, no fan-out, one
local model, no provider rate limit. Taught as study material; buffr's would-need named.*

## Zoom out, then zoom in

```
  buffr's serving stack — backpressure would sit between a supervisor and the model

  ┌─ SUPERVISOR (multi-agent, Section C) ─ spawns sub-agents ───────┐  NOT YET in buffr
  │  fan-out: launch N research sub-agents in parallel             │
  │ ┌─ ★ FAN-OUT BACKPRESSURE ★ ─ the cap + the upward signal ───┐ │
  │ │  semaphore: at most K in flight · "slow down" pushed UP    │ │
  │ │ ┌─ THE MODEL CALL ─ run-agent-loop.ts:103 ───────────────┐ │ │
  │ │ │  model.complete(...) — ONE local Ollama, serialized    │ │ │
  │ │ │  no provider rate limit · no concurrency to bound      │ │ │
  │ │ └─────────────────────────────────────────────────────────┘ │ │
  │ └─────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────┘
```

Backpressure only exists when something *upstream can produce work faster than something
downstream can consume it* (★ marks where it would live). buffr has neither half: one agent
produces one model call at a time, and one local Ollama consumes it with no rate limit to hit.
So this control is **not yet** for buffr — and the honest framing is that it's a property of
*fan-out topologies*, which buffr deliberately doesn't run. This file teaches the mechanism so
you can name exactly what would turn it on.

## Structure pass

Two mechanisms, traced along ONE axis: **which direction the pressure flows**.

```
  Axis = PRESSURE DIRECTION · trace how each mechanism bounds an over-eager producer

  DOWNWARD cap (concurrency limiter)   producer is held       at most K calls in flight
    semaphore: acquire before spawn, release on finish        bounds the FAN-OUT width
  ──────────────── ★ SEAM: bound the width vs signal the source ★ ──────────────────────
  UPWARD signal (backpressure)         consumer pushes back    "I'm saturated — slow down"
    rate-limit / queue-full → propagate UP to the supervisor  bounds the SPAWN RATE
```

The seam separates two answers to "the supervisor wants 50 sub-agents now." The downward cap
*holds the producer*: only K run at once, the rest wait. The upward signal *informs the
producer*: the model layer is saturated (a 429, a full queue), and that fact propagates back up
so the supervisor stops spawning. A cap alone bounds width; backpressure makes the source itself
ease off. buffr needs neither because it never has more than one call in flight.

## How it works

### Move 1 — mental model

A concurrency limiter is `Promise.all()` you refuse to call naively. The frontend reflex:
firing `Promise.all(urls.map(fetch))` over 500 URLs melts the server — so you wrap it in a
concurrency cap, K requests in flight, the rest queued. A semaphore is that cap as a reusable
object: K permits, acquire one before you start, release it when you finish.

```
  THE SHAPE — a semaphore caps how many run at once (Promise.all with a leash)

  want to spawn: [A][B][C][D][E][F]   semaphore permits = 3
                  │  │  │
       acquire ──▶ A  B  C  (running)        D E F wait for a permit
                  ▼  ▼  ▼
       release ──▶ as each finishes, the next waiter acquires and starts
```

### Move 2 — the two mechanisms

**The concurrency limiter (the semaphore) — bound the fan-out width.**

When a supervisor fans out N sub-agents, you don't launch all N — you launch at most K, and the
rest wait for a permit. This is the same leash you'd put on `Promise.all()` so it doesn't open
500 sockets at once.

```
  CONCURRENCY LIMITER — at most K sub-agents in flight, rest queued

  supervisor wants: spawn(sub_1 .. sub_N)
                          │ each must acquire a permit first
                          ▼
        ┌─ semaphore (K=3 permits) ─┐
        │  sub_1 ▶ running           │   sub_4 ─ waiting ─┐
        │  sub_2 ▶ running           │   sub_5 ─ waiting ─┤ acquire when a permit frees
        │  sub_3 ▶ running           │   sub_6 ─ waiting ─┘
        └────────────────────────────┘
              ↑ release on finish → next waiter starts
```

```text
// SKETCH — not in buffr. A semaphore around a fan-out of sub-agents.
const sem = new Semaphore(3);                 // K = 3 permits
await Promise.all(subtasks.map(async (task) => {
  await sem.acquire();                        // wait for a permit (this is the leash)
  try { return await runSubAgent(task); }     // at most 3 sub-agents call the model at once
  finally { sem.release(); }                  // free the permit → next waiter proceeds
}));
```

Annotation: this code is **not in buffr** — there is no supervisor and no `Promise.all` of
sub-agents. buffr's loop calls `model.complete` once per turn, serially
(`run-agent-loop.ts:103`), inside a `for` loop. The fan-out the semaphore would bound simply
doesn't exist. **buffr's would-need: a supervisor that spawns parallel sub-agents — the
research-assistant topology — at which point K is the first knob you set.** (See Section C's
parallel topology and Section F's research-assistant template.)

**Upward backpressure — when the supervisor over-spawns, push the pressure back up.**

The semaphore bounds *your own* fan-out. Backpressure handles the case where the downstream —
the model provider — is the bottleneck and tells you so. The breakpoint is a **provider rate
limit (a 429)** or **per-call duration** climbing under load: the consumer signals saturation,
and that signal propagates *up* to the supervisor so it eases the spawn rate instead of
hammering a saturated endpoint.

```
  UPWARD BACKPRESSURE — saturation signal flows from the model UP to the supervisor

  supervisor ──spawn──▶ sub-agents ──model.complete──▶ provider
       ▲                                                  │
       │                                          429 / slow / queue full
       └───────────── "slow down" propagates UP ──────────┘
                       supervisor reduces spawn rate (or pauses)
```

Annotation: also **not in buffr** — the only consumer is a *local* Ollama with no rate limit and
no shared queue. There is no 429 to propagate, no saturation signal to push up, and no
supervisor to receive it. The breakpoints that make backpressure necessary — provider rate
limits, per-call duration under concurrency — are exactly the conditions buffr's single-device,
single-user, local-model setup never creates. **buffr's would-need: a billed provider with a
rate limit, or a shared model server under concurrent load — then the 429 has to flow somewhere,
and "somewhere" is upward to whatever decides to spawn.**

### Move 3 — the principle

**Bound how much work you start before you start it (the cap), and let the saturated consumer
slow the producer down (backpressure) — and recognize that both only exist when production can
outrun consumption.** A single-agent loop with one serialized local model has neither a producer
that races ahead nor a consumer that can say "stop." That's not a missing feature; it's the
absence of the *topology* that creates the pressure. The staff-engineer move is to name the
breakpoint precisely: backpressure earns its keep the moment you fan out across a rate-limited
provider, and not one moment before. In this codebase: **not yet — no fan-out; one local
model.**

## Primary diagram

The full picture, with buffr's status stamped on every box.

```
  Fan-out backpressure — the two mechanisms, and why buffr has neither

  SUPERVISOR (Section C topology)  ─ spawns N sub-agents          NOT YET (single agent)
        │ fan-out
        ▼
  CONCURRENCY LIMITER (semaphore)  ─ at most K in flight, rest wait   NOT YET (no fan-out)
        │ Promise.all with a leash
        ▼
  MODEL CALL (run-agent-loop.ts:103) ─ ONE local Ollama, serialized    IMPLEMENTED (serial)
        ▲ 429 / slow?
        │ upward signal
  UPWARD BACKPRESSURE ─ propagate saturation to the supervisor      NOT YET (no rate limit)

  Breakpoint that turns this on: a billed/shared provider with a rate limit + a supervisor fanning out.
```

buffr runs the bottom box (one serialized model call) and nothing above it. The two controls
are study material until the topology exists to need them.

## Elaborate

The cap and the signal solve different failures and you need both at scale. The concurrency cap
protects the *downstream* from your own enthusiasm — without it, a supervisor spawning 50
sub-agents opens 50 concurrent model calls and either trips a rate limit or balloons tail
latency. Backpressure protects the *system* from a downstream that's already saturated — without
it, you keep spawning into a 429 storm, retrying into the same wall, burning budget on calls
that will fail. A cap with no backpressure spawns politely into a dead provider; backpressure
with no cap reacts after the damage. buffr needs neither because the producer (one agent) and
the consumer (one local model) are the same speed by construction.

The fleet shape is the whole point of Section C and Section F. A research-assistant supervisor
that decomposes a question into 8 parallel sub-queries is the canonical fan-out: it *will*
over-spawn against a rate-limited provider unless a semaphore caps it and a 429 can flow back up
to throttle the spawn. That template is where this control stops being theory. buffr's
`maxToolCalls:4` is a *budget*, not backpressure — it bounds total work, not the *rate* or
*concurrency* of work, because there's no concurrency to bound.

Cross-ref `study-ai-engineering/06-production-serving/` for the call-level backpressure and
rate-limit handling (how a single client retries-with-jitter against a 429); this file is the
*topology* view — where that 429 has to propagate when the caller is a supervisor, not a leaf.

## Interview defense

**Q: "How do you handle backpressure / concurrency when your agent fans out?"**

Model answer: "I don't fan out — and that's the honest answer, not a dodge. buffr is a
single-agent loop calling one *local* Ollama serially, one `model.complete` per turn
(`run-agent-loop.ts:103`). There's no supervisor spawning sub-agents, no `Promise.all` of model
calls, and critically no provider rate limit — it's a local model on one device for one user. So
the two mechanisms backpressure needs simply have nothing to act on. I can name exactly what
would turn them on: the moment I add a supervisor that fans out N sub-agents — the
research-assistant topology — I'd cap concurrency with a semaphore (the `Promise.all`-with-a-leash
pattern, K permits) so I don't open N model calls at once, and I'd propagate a provider 429
*upward* to the supervisor so it slows its spawn rate instead of hammering a saturated endpoint.
The breakpoint is precise: backpressure earns its keep against a *rate-limited* provider under
*fan-out*, and buffr is neither. My `maxToolCalls:4` is a budget, not backpressure — it bounds
total work, not the rate of concurrent work."

```
  The defense in one picture

  fan-out?        NO — single agent, one model.complete per turn (:103), serialized
  concurrency cap? would-need: semaphore (K permits) once a supervisor spawns sub-agents
  upward signal?   would-need: propagate a provider 429 up to the supervisor
  breakpoint:      rate-limited/shared provider + fan-out — buffr has neither (local, single-user)
```

Anchor: *Not yet — buffr is a single agent calling one local Ollama serially
(`run-agent-loop.ts:103`), no fan-out and no provider rate limit, so there's no producer racing
ahead and no saturated consumer to push back; the semaphore (concurrency cap) and upward
backpressure turn on only with a supervisor fanning out against a rate-limited provider —
Section C parallel topology, Section F research-assistant template.*

## See also

- `01-cross-turn-caching.md` — caching cuts the per-call cost; backpressure bounds the call
  rate. The two serving controls are complementary.
- `03-per-tool-circuit-breaking.md` — the third control; a breaker opening is a *form* of
  backpressure (stop sending to a dead dependency), scoped to one tool.
- `../03-multi-agent-orchestration/` — Section C, where the parallel fan-out topology lives;
  this file is its *serving* view.
- `../06-orchestration-system-design-templates/` — Section F, the research-assistant template
  where fan-out backpressure becomes a real design requirement.
- `study-ai-engineering/06-production-serving/` — the call-level backpressure / rate-limit
  handling this file points back to.
