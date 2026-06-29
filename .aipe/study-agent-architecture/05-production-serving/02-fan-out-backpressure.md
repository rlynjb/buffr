# Fan-out backpressure — bounding concurrent agent calls

**Industry name(s):** fan-out backpressure · concurrency limiting ·
semaphore-bounded fan-out · upward backpressure. **Type label:** Industry
standard.

**In this codebase: Not yet applicable — buffr is single-agent,
single-user, serial.** There's no fan-out to bound. The one place buffr
fans out is the trace sink's `Promise.all` over queued DB writes
(`src/supabase-trace-sink.ts:92`) — and even that is *unbounded*, which
is fine at one-conversation scale but is the exact shape that needs a
cap once it grows.

## Zoom out, then zoom in

```
  Zoom out — where backpressure would sit

  Supervisor decomposes → many worker calls at once
                       │
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Concurrency limiter (semaphore)              │ ← we are here
  │   pop up to N concurrent; queue the rest      │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Provider — receives at most N at a time      │
  └───────────────────────────────────────────────┘
```

Zoom in: a single call has one outbound request to rate-limit. A fan-out
topology fires many concurrent calls from one task, and a supervisor can
fan out faster than the provider allows. Backpressure caps concurrency
*and* pushes back upward — telling the supervisor to stop decomposing
when the queue grows. buffr is serial, so it has no fan-out to cap yet.

## Structure pass

**Layers.** A producer (supervisor/fan-out), a limiter (semaphore), a
provider (Ollama). buffr has only a serial producer.

**Axis — "how many concurrent calls hit the provider?"** Single-agent
buffr: one at a time. A fan-out: as many as the supervisor spawns,
unless a limiter caps it. The cap is the whole concern.

**Seam.** The producer→provider boundary. Without a limiter there, a
runaway producer (a supervisor that keeps spawning workers) is an
unbounded queue — the multi-agent version of the trace sink's unbounded
`pending` array.

## How it works

#### Move 1 — the mental model

You've fired 200 independent requests but didn't open 200 connections —
you used `Promise.all` with a concurrency cap. Fan-out backpressure is
that cap applied to agent calls, plus a second rule: when the queue
backs up, stop *producing* more work, not just stop *sending* it.

```
  Pattern — bounded fan-out with upward backpressure

  supervisor → 12 worker calls
       │
       ▼ semaphore (N=4)
  [4 running] [8 queued]
       │
       │ queue > threshold?
       ▼
  supervisor STOPS decomposing further  ← upward backpressure
```

#### Move 2 — the walkthrough (buffr's unbounded primitive)

**buffr's only fan-out is unbounded — and that's the lesson.** The trace
sink queues every write into a `pending` array and awaits them all at
once (`src/supabase-trace-sink.ts:87-93`):

```ts
private push(p: Promise<void>): void { this.pending.push(p); }
async flush(): Promise<void> { await Promise.all(this.pending); }
```

At one-conversation scale that's a handful of inserts — fine. But it's
the textbook unbounded-fan-out shape: there's no cap on how many writes
fire concurrently. If a long run emitted hundreds of events, this would
open hundreds of concurrent DB writes. The fix is the same semaphore an
agent fan-out needs — `Promise.all` with a concurrency cap.

**The agent version adds the provider constraint.** If buffr went
fan-out (the parallel topology,
`03-multi-agent-orchestration/04-parallel-fan-out.md`), the limiter
would protect *Ollama*: three concurrent Gemma calls on one local
instance compete for the same GPU/CPU, so unbounded fan-out just queues
at Ollama and loses the parallel-latency win that made fan-out worth it.
The cap's breakpoint is the provider's throughput divided by per-call
duration — set concurrency just under that.

**Upward backpressure is the part people miss.** Capping concurrency
isn't enough — you also have to stop the *supervisor* from spawning
unbounded work. A runaway supervisor that keeps decomposing is an
unbounded queue no matter how low the send cap is. The control is a
queue-depth threshold that pauses decomposition. buffr's existing budget
instinct (`maxToolCalls`) is the single-agent seed of this: bound the
work, not just the rate.

```
  Comparison — buffr's unbounded flush vs a bounded fan-out

  buffr today (unbounded):          bounded fan-out (would-be):
    pending.push(...) × N             semaphore(N=4) over agent calls
    await Promise.all(pending)        + queue-depth threshold pauses
    (fine at 1 conversation)            the supervisor (upward pushback)
```

#### Move 3 — the principle

A single call has one request to rate-limit; a fan-out has many, and a
supervisor can produce them faster than the provider serves. Bound
concurrency with a semaphore, and bound *production* with upward
backpressure — capping the send rate isn't enough if the producer
queues unbounded work. buffr is serial today, but its one fan-out (the
trace flush) is already the unbounded shape; the same cap fixes both the
I/O case now and the agent case later.

## Primary diagram

```
  Fan-out backpressure (would-be in buffr; trace flush is the seed)

  TODAY (I/O, unbounded):  pending.push × N → Promise.all (no cap)

  WOULD-BE (agent fan-out):
    supervisor → N worker calls
         │ semaphore (cap ≈ provider_throughput / call_duration)
         ▼
    [running ≤ cap] [queued]
         │ queue deep? → pause supervisor decomposition (upward pushback)
         ▼
    Ollama receives ≤ cap at a time
```

## Interview defense

**Q: How would you keep buffr's fan-out from overwhelming the
provider?**
Two controls. A concurrency semaphore — `Promise.all` with a cap set
just under Ollama's throughput divided by per-call duration — so I don't
queue 12 concurrent Gemma calls on one local instance. And upward
backpressure: a queue-depth threshold that stops the supervisor from
decomposing more work, because capping the send rate doesn't help if the
producer queues unbounded. buffr's trace-sink `flush` is already the
unbounded shape — the same cap fixes it.

```
  semaphore(N) + queue-depth threshold pauses the producer
```

**Anchor:** "Cap concurrency AND production — a runaway supervisor is an
unbounded queue no matter how low the send cap is."

## See also

- `03-multi-agent-orchestration/04-parallel-fan-out.md` — the topology
  this bounds
- `03-multi-agent-orchestration/09-coordination-failure-modes.md` — cost
  blowup and tool-call cascade
- `01-cross-turn-caching.md` · `03-per-tool-circuit-breaking.md` — the
  sibling serving concerns
- `.aipe/study-system-design/03-trajectory-capture.md` — the trace flush
  that's the unbounded seed
