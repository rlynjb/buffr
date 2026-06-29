# Backpressure, Bounded Work, and Cancellation — mostly the gaps

**Industry name(s):** bounded concurrency, backpressure, cancellation/deadlines, graceful shutdown · **Type:** Industry standard

## Zoom out, then zoom in

This is the file where the honest answer is mostly *"not yet exercised."* buffr has no cancellation, no timeouts, no deadlines, no bounded queues, and no signal-handled shutdown. For a single-user local CLI that's a defensible set of omissions — but naming exactly *where* each missing piece would attach, and what failure it would catch, is the whole lesson. The one bound that *does* exist is implicit: the chat UI's busy flag caps in-flight turns at one.

```
  Zoom out — where bounding/cancellation would live (mostly empty)

  ┌─ Turn gate (chat.tsx) ────────────────────────────────────────┐
  │  busy flag → at most ONE turn in flight  ✓ (the one real bound)│
  └───────────────────────────────┬───────────────────────────────┘
                                  │ but inside a turn:
  ┌─ The agent run ───────────────▼───────────────────────────────┐
  │  await agent.answer() — NO timeout, NO AbortSignal  ✗          │ ← can hang forever
  │  trace pending[] — UNBOUNDED fan-out of inserts  ✗            │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ at process edge:
  ┌─ Shutdown ────────────────────▼───────────────────────────────┐
  │  /exit → close() ✓     SIGINT → no handler ✗                  │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the axis is *overload and escape* — what happens when work is too slow, too much, or needs to stop? buffr's current answer at most of these points is "it doesn't stop."

## Structure pass

**Layers.** Three: the **turn gate** (one bound that exists), the **agent run** (where timeouts/cancellation/queue-bounds would go), and **shutdown** (where signal handling would go).

**Axis: control under overload — "what stops runaway or stuck work?"**

```
  One axis — "what stops it?" — traced down

  ┌──────────────────────────────────────────────┐
  │ turn gate: busy flag → 1 concurrent turn       │ → BOUNDED ✓
  └───────────────────────┬────────────────────────┘
       ┌──────────────────────────────────────────┐
       │ agent.answer(): nothing                    │ → UNBOUNDED time ✗ (hangs)
       │ trace pending[]: nothing                   │ → UNBOUNDED count ✗
       └───────────────────────┬───────────────────┘
            ┌─────────────────────────────────────┐
            │ SIGINT: no handler                    │ → no graceful stop ✗
            └─────────────────────────────────────┘

  one bound exists; everything below it is open-ended
```

**The seam: the start of `agent.answer()`.** Above it, the busy flag bounds concurrency to one. Below it — inside the turn — there is *no* bound on time and no way to cancel. That boundary is where every missing mechanism in this file would attach.

## How it works

### Move 1 — the mental model

You know how a `fetch()` can hang forever if the server never responds, and the fix is `AbortController` + a timeout that aborts it? buffr's `await agent.answer(question)` is a `fetch()` with no `AbortController` — if Ollama stalls mid-generation, the turn waits indefinitely and the only escape is killing the process. Most of this file is "here's the `AbortController` that isn't there."

```
  The pattern that's MISSING — a deadline racing the work

  Promise.race([
    agent.answer(q),                    ← the work
    timeout(30_000)  ← rejects after 30s  ← the deadline (not present in buffr)
  ])
  // buffr today: just  await agent.answer(q)  — no race, no deadline
```

### Move 2 — the walkthrough

**The one bound that exists: the busy flag caps concurrent turns at one.** This is real backpressure, just implicit. The chat UI refuses to start a second turn while one runs (→ `04`):

```ts
// src/cli/chat.tsx:17 — the only concurrency bound in the repo
if (busy) return;     // at most one ask() in flight; the rest is serialized
```

So buffr never has two agent runs racing, never floods Ollama with parallel generations, never opens an unbounded number of pool connections from overlapping turns. The bound is "1," enforced by UI state rather than a semaphore — but it *is* a bound, and it's why the unbounded pieces below don't compound into a real problem at single-user scale.

**Missing: a timeout/deadline on the agent run.** `session.ask` awaits the agent with no clock:

```ts
// src/session.ts:62 — no timeout, no AbortSignal
const answer = await agent.answer(question);
```

If Ollama hangs — model still loading, a generation that never terminates, a dropped HTTP connection that doesn't error — this `await` never settles. The Ink spinner spins forever (`src/cli/chat.tsx:48-51`), the busy flag stays `true`, and the *only* exit is Ctrl-C killing the process. The fix is a `Promise.race` against a timer or threading an `AbortSignal` into the provider — but the aptkit `RagQueryAgent.answer()` signature doesn't take one today, so this is partly an aptkit-side change. **Timeouts/deadlines: not yet exercised.**

**Missing: cancellation (`AbortSignal`).** There's no `AbortController` anywhere in the repo — no way for the user to say "stop this turn, I changed my mind." Even `/exit` mid-turn is gated out by `if (busy) return` (`src/cli/chat.tsx:17`), so you can't even quit while a turn is running; you wait for it or kill the process. Cooperative cancellation would mean an `AbortController` whose signal is checked between agent steps and passed to the HTTP calls. **Cancellation: not yet exercised** — the project context calls this out directly.

**Missing: a bound on the trace sink's fan-out.** `emit()` pushes every event's insert promise into `pending[]` with no cap (→ `03`, `05`):

```ts
// src/supabase-trace-sink.ts:87-93 — unbounded queue, no concurrency limit
private push(p: Promise<void>): void { this.pending.push(p); }  // no max length
async flush(): Promise<void> { await Promise.all(this.pending); } // fires ALL at once
```

A turn with hundreds of trace events would start hundreds of inserts simultaneously, all contending for the pool's 10 connections — most would queue *inside* the pool waiting for a free connection. In practice a turn emits a handful of events, so this never bites. But it's unbounded by construction: there's no `p-limit`-style concurrency cap, no chunking, no batching into a single multi-row insert. A bounded version would cap in-flight inserts or batch them. **Bounded queue / backpressure on inserts: not yet exercised.**

```
  The trace fan-out — unbounded by construction

  emit emit emit ... emit (N events)
    │    │    │        │
    ▼    ▼    ▼        ▼
  insert insert ... insert     ← all started at once
    └──────┬───────────┘
       pool (10 conns) ← the only real limiter, and it's accidental
```

**Missing: graceful shutdown on signals.** `/exit` drains cleanly (`session.close()` → `pool.end()`, → `06`), but there's no `process.on('SIGINT')`/`SIGTERM` handler, so Ctrl-C skips it. The graceful-shutdown pattern — catch the signal, stop accepting new work, await in-flight work (or its deadline), `pool.end()`, then exit — isn't here. **Graceful signal shutdown: not yet exercised.**

**Why these gaps are defensible today — and when they stop being.** This is a single-user, single-turn-at-a-time local CLI. One human, one question at a time, against a local Ollama and a local Postgres. The busy flag already bounds concurrency to one, so the unbounded fan-out can't actually fan out far, and a hung turn inconveniences one person who can Ctrl-C. The day this changes — multiple users, a server endpoint, turns kicked off programmatically, or an Ollama that's remote and flaky — every one of these gaps becomes a real incident: hung requests with no timeout, insert storms with no cap, no clean drain on deploy-time SIGTERM. The honest framing: these aren't bugs, they're *unbuilt* — correctly deferred for the current shape, first on the list for the next one.

### Move 3 — the principle

Bounded work and cancellation are the mechanisms that keep a system controllable when something downstream is slow, stuck, or flooded. buffr has exactly one — the busy flag — and it happens to be enough to keep the missing ones from mattering at single-user scale. That's the real lesson about deferral: a single strong bound upstream (one turn at a time) buys you the right to defer the bounds downstream (timeouts, queue caps, cancellation) until the workload shape actually demands them.

## Primary diagram

```
  buffr — bounding & cancellation, present vs absent

  ┌─ PRESENT ─────────────────────────────────────────────────────────────┐
  │  busy flag (chat.tsx:17) → ≤1 turn in flight                  ✓ BOUND   │
  │  /exit → session.close() → pool.end() → exit()               ✓ CLEAN   │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ inside a turn — all ABSENT:
  ┌─ NOT YET EXERCISED ───────────▼───────────────────────────────────────┐
  │  timeout/deadline on agent.answer()        ✗ hangs forever            │
  │  AbortSignal / cooperative cancellation     ✗ no way to stop a turn   │
  │  bounded queue on trace pending[]           ✗ unbounded fan-out       │
  │  SIGINT/SIGTERM graceful shutdown           ✗ Ctrl-C skips cleanup    │
  └────────────────────────────────────────────────────────────────────────┘
        accidental limiter: the pool's 10 connections cap real concurrency
```

## Elaborate

These four mechanisms are the standard toolkit for keeping a system controllable under stress: **timeouts/deadlines** put an upper bound on how long any single operation can hold a resource; **cancellation** (`AbortSignal`) lets a caller reclaim that resource early; **bounded queues/backpressure** stop a fast producer from overwhelming a slow consumer (the classic is `p-limit` or a semaphore capping concurrent in-flight work); **graceful shutdown** drains in-flight work before exit so a deploy or a Ctrl-C doesn't sever live requests. The reason buffr can skip all four is that its *one* upstream bound — one turn at a time — collapses the workload to a scale where none of them are load-bearing yet. This is the right way to think about deferral: not "we forgot," but "the workload doesn't generate the failure these prevent — yet." The moment buffr grows a second concurrent caller or a remote Ollama, the deferral expires, and the first thing to build is the timeout on `agent.answer()`, because a hung turn with no escape is the worst of the four failures.

## Interview defense

**Q: What stops a runaway or stuck turn in buffr?**
Upstream, the busy flag bounds it to one turn at a time. *Inside* a turn — nothing. `await agent.answer()` has no timeout and no `AbortSignal`, so a stalled Ollama hangs the turn forever; the only escape is killing the process. That's *not yet exercised* — defensible for a single-user CLI, first thing to fix if Ollama goes remote/flaky.

```
  busy flag → ≤1 turn ✓     but agent.answer() → no deadline ✗ → hangs
```
Anchor: *one upstream bound (one turn) is what lets the missing downstream bounds not bite yet.*

**Q: The trace sink fires N inserts at once — what bounds that?**
Nothing in the sink — `pending[]` is unbounded and `flush` fires all of them with `Promise.all`. The only accidental limiter is the pool's 10 connections, which queues the overflow. A real bound would be a concurrency cap (`p-limit`) or batching into one multi-row insert. In practice a turn emits a handful of events, so it never bites — but it's unbounded by construction. *Not yet exercised.*

```
  N emits → N inserts at once → pool(10) queues the rest (accidental cap)
```
Anchor: *the pool size is doing backpressure's job by accident.*

## See also

- `04-shared-state-races-and-synchronization.md` — the busy flag as the concurrency bound
- `03-event-loop-and-async-io.md` — the unbounded fan-out that lives on the loop
- `06-filesystem-streams-and-resource-lifecycle.md` — the shutdown/cleanup half of this story
- `08-runtime-systems-red-flags-audit.md` — these gaps, ranked by consequence
