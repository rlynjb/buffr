# 03 — Trajectory Capture

**Industry name(s):** Full-signal trajectory capture / observability sink / event-to-row
persistence. The MLOps "capture-now-so-fine-tuning-is-answerable-later" discipline.
**Type:** Industry standard (sink pattern), project-specific intent (the trajectory thesis).

## Zoom out, then zoom in

Here's the whole system, with one box lit. As aptkit's agent reasons through a turn, it
*emits* a stream of capability events — assistant steps, tool calls, model usage,
warnings, errors. buffr's `SupabaseTraceSink` catches every one and turns it into a row
in `agents.messages`. The turn becomes a replayable record.

```
  Zoom out — where the trace sink sits

  ┌─ aptkit agent (emits events) ───────────────────────────────────────┐
  │  RagQueryAgent.answer() → run-agent-loop → trace.emit(CapabilityEvent)│
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ emit(event)  (synchronous, 6 event types)
  ┌─ buffr persistence layer ─────▼──────────────────────────────────────┐
  │  ★ SupabaseTraceSink implements CapabilityTraceSink ★                 │ ← we are here
  │    queue writes on emit · await them on flush                         │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ INSERT INTO agents.messages
  ┌─ Storage layer ───────────────▼──────────────────────────────────────┐
  │  agents.messages (role, content, tool_calls, tool_results, model,     │
  │                   tokens_used, created_at)                            │
  └───────────────────────────────────────────────────────────────────────┘
```

Zoom in. The pattern is an **observability sink**: a passive listener that receives a
stream of events from a system it doesn't control and persists each one. The twist here
is *full-signal* — not just the assistant's words, but the cause (tool args), the
outcome (tool result + error + duration), the cost (tokens), and the failures. The
question it answers: *if you wanted to replay or fine-tune on this conversation six
months from now, is everything you'd need already on disk?*

## Structure pass

**Layers:** event source (aptkit loop) → contract (`CapabilityTraceSink.emit`) → sink
(`SupabaseTraceSink`) → persistence helper (`persistMessage`) → storage (`messages`).

**Axis — sync or async?** Trace it. The agent's `emit(event)` is **synchronous** — it's
aptkit's contract, the loop can't await a DB write mid-reasoning
(`src/supabase-trace-sink.ts:53`). But the actual INSERT is **async**. The sink bridges
the two: `emit` *queues* a promise without awaiting it (`src/supabase-trace-sink.ts:87-89`),
and a later `flush()` awaits them all (`src/supabase-trace-sink.ts:91-93`). The
sync/async answer flips at the sink — that flip is the whole design.

**Seam:** the `CapabilityTraceSink` contract (`src/supabase-trace-sink.ts:2`). Horizontal
seam — the lower layer (the sink) promises the upper layer (the agent) one method,
`emit`, that *never blocks and never throws into the loop*. Honor that and the agent
reasons at full speed while persistence happens behind it.

## How it works

### Move 1 — the mental model

You've written this shape: an event handler that fires-and-forgets a network call —
`onClick` pushes an analytics event without awaiting it, so the UI stays responsive.
Same idea, with one addition: the fired promises are kept in a list so you can `await
Promise.all` them at a checkpoint. The strategy: **decouple the fast emit from the slow
write by queueing, then drain the queue once at the end of the turn.**

```
  the sink kernel — queue on emit, drain on flush

   emit(e1) ─► push(insert(e1)) ─┐
   emit(e2) ─► push(insert(e2)) ─┤  pending: [p1, p2, p3, ...]
   emit(e3) ─► push(insert(e3)) ─┘            │
                                              ▼
   flush() ─────────────────────────► await Promise.all(pending)
```

### Move 2 — the load-bearing skeleton

This concept has a kernel — the emit/flush queue — so we walk it as a skeleton.

**1. Isolate the kernel.** Three parts, nothing removable:

```ts
// src/supabase-trace-sink.ts:50-93 (kernel, condensed)
private readonly pending: Promise<void>[] = [];        // the queue
emit(event: CapabilityEvent): void {                   // sync: route + queue
  switch (event.type) { /* ...build a persistMessage promise... */ }
}
private push(p: Promise<void>): void { this.pending.push(p); }  // queue, don't await
async flush(): Promise<void> { await Promise.all(this.pending); } // drain once
```

**2. Name each part by what breaks without it.**
- Drop the `pending` queue and await inside `emit` → `emit` becomes async, violating
  aptkit's sync contract; the loop stalls on every event.
- Drop `flush` → the promises are fired but never awaited; the process can exit (or the
  turn can return) before the rows land — trajectory silently lost.
- Drop the `created_at = event.timestamp` plumbing → rows get `now()` from whichever
  concurrent INSERT wins the race, so replay order scrambles
  (`src/supabase-trace-sink.ts:46-48`). This is the part people forget.

**3. Skeleton vs hardening.** The skeleton is queue + drain. The *full-signal* routing
(handling all 6 event types) and the timestamp-for-ordering are hardening that make the
captured trajectory complete and replayable rather than merely present.

**The full-signal routing — the part that earns the "trajectory" name.** A naive sink
persists only assistant text. This one routes all six `CapabilityEvent` types
(`src/supabase-trace-sink.ts:56-84`), each to a row that captures a different facet:

```
  one turn → six kinds of row (the full signal)

  event type          row role        what it preserves
  ──────────────      ───────────     ──────────────────────────────────
  step                <event.role>    the assistant's words (the answer)
  tool_call_start     tool_call       the CAUSE: toolName + args
  tool_call_end       tool            the OUTCOME: result + error + durationMs
  model_usage         model_usage     the COST: provider/model + tokens_used
  warning             warning         a soft failure
  error               error           a hard failure
```

```ts
// src/supabase-trace-sink.ts:62-66 — the cause, previously dropped on the floor
case 'tool_call_start':
  this.push(persistMessage(pool, conversationId, 'tool_call', event.toolName, {
    toolCalls: { toolName: event.toolName, args: event.args }, createdAt: at,
  }));
  return;
```

Capturing tool-call *args* (the cause) and `durationMs` + `error` (the outcome) and
`tokens_used` (the cost) is what turns `agents.messages` from a chat log into a
*replayable trajectory* — and fills the otherwise-orphaned `tokens_used` column
(`src/supabase-trace-sink.ts:42-48`).

**The timestamp-for-ordering detail.** Because writes are queued and drained with
`Promise.all`, the inserts race. If `created_at` defaulted to `now()`, replay order
would be the race outcome, not the emit order. So `persistMessage` persists the *event's*
timestamp into `created_at`, falling back to `now()` only when absent
(`src/supabase-trace-sink.ts:24-26`, `:30`):

```ts
// src/supabase-trace-sink.ts:26-30 — emit order survives the flush race
const createdAt = extra?.createdAt && extra.createdAt.length > 0 ? extra.createdAt : null;
await pool.query(
  `insert into agents.messages (... created_at)
   values ($1,...,$3, coalesce($8::timestamptz, now()))`, [...]);
```

```
  Layers-and-hops — emit during the loop, flush after

  ┌─ aptkit loop ─┐ hop 1: emit(step/tool/usage…)  ┌─ SupabaseTraceSink ─┐
  │  per reasoning │ ─────────────────────────────► │  route → push(p)    │
  │  step          │   (sync, non-blocking)         │  pending grows      │
  └───────┬────────┘                                └──────────┬──────────┘
          │ answer returned                                    │
  ┌───────▼────────┐ hop 2: flush()                            │
  │  session.ts:63 │ ─────────────────────────────────────────►│ Promise.all
  └────────────────┘                                 hop 3: INSERT ×N ▼
                                                     ┌─ agents.messages ─┐
                                                     └────────────────────┘
```

The session drives this: `agent.answer()` runs the loop (emits happen), *then*
`trace.flush()` drains the queue (`src/session.ts:62-63`). Flush after answer, not during.

### Move 3 — the principle

A trajectory is only as useful as it is complete. The discipline isn't "log the answer" —
it's "capture the cause, the outcome, the cost, and the failures, in the order they
happened, so a future you can replay or train on it." Here that's a deliberate thesis:
capture every conversation as a trajectory *now* so fine-tuning is *answerable* later,
not assumed (`agent-layer-plan.md:17`). The sink pattern decouples that completeness from
the agent's speed — the agent never waits for a write.

## Primary diagram

The full sink, all six event types, the queue, the drain, every layer.

```
  SupabaseTraceSink — full-signal capture

  ┌─ aptkit agent (run-agent-loop) ─────────────────────────────────────┐
  │  emits: step · tool_call_start · tool_call_end · model_usage ·        │
  │         warning · error            (sync, with event.timestamp)       │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ emit(event)  — non-blocking
  ┌─ SupabaseTraceSink ───────────▼──────────────────────────────────────┐
  │  switch(type) → persistMessage(...) → push(promise)   [pending: P[]]  │
  │  flush() → await Promise.all(pending)                                 │
  └───────────────────────────────┬──────────────────────────────────────┘
                 created_at = event.timestamp (replay order preserved)
  ┌─ Postgres agents.messages ────▼──────────────────────────────────────┐
  │  role · content · tool_calls · tool_results · model · tokens_used ·   │
  │  created_at                 [ append-only, per conversation ]         │
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The sink is the borrowed discipline from Hermes Agent — "trajectory-capture discipline
but none of its platform machinery" (`agent-layer-plan.md:13`). The intent separates
this from a debug log: trajectories are training data in waiting. The pattern itself
(passive listener over an event stream, persisted out-of-band) is the same shape as a
metrics exporter or an audit log. The sync-emit/async-flush bridge is the same shape as
React's `useEffect` cleanup-and-flush, or any fire-and-forget-then-await-at-a-barrier
queue you've written. Observability mechanics (what to log, sampling, retention) belong
to `study-debugging-observability`; this file owns the architectural *boundary* — where
capture sits and why it can't block the loop.

What to read next: `04-long-lived-chat-session.md` (who calls `flush`),
`audit.md` lens 8 (why partial-flush is a ranked risk for the trajectory thesis).

## Interview defense

**Q: Why queue the writes instead of awaiting each insert in `emit`?**
Because `emit` is synchronous — aptkit's `CapabilityTraceSink` contract. The agent loop
can't await a DB round-trip between reasoning steps without stalling. So `emit` queues a
promise and returns immediately; `flush()` drains the queue once after the answer is in
hand.

```
  emit (sync, must not block) ─► push(p) ─► pending[]
  flush (async, at the barrier) ─► await Promise.all(pending)
```
Anchor: sync contract at `src/supabase-trace-sink.ts:53`; queue at `:87-89`; drain at
`:91-93`; flush call at `src/session.ts:63`.

**Q: What's the load-bearing part people forget in a queued sink?**
Ordering. Queued inserts race under `Promise.all`, so if `created_at` defaults to
`now()`, replay order is the race outcome. Persisting the *event* timestamp into
`created_at` preserves emit order. Forgetting it gives you a complete-but-scrambled
trajectory.
Anchor: `src/supabase-trace-sink.ts:46-48`; the `coalesce($8, now())` at
`src/supabase-trace-sink.ts:30`.

**Q: What makes this "full-signal" rather than a chat log?**
It routes all six event types, capturing the cause (tool args), the outcome (result +
error + durationMs), and the cost (tokens) — not just assistant text. That completeness
is what makes the trajectory replayable and fine-tuning answerable later.
Anchor: the switch at `src/supabase-trace-sink.ts:56-84`; the thesis at
`agent-layer-plan.md:17`.

## See also

- `04-long-lived-chat-session.md` — the session that calls `flush` per turn
- `02-library-as-dependency-boundary.md` — `CapabilityTraceSink` is aptkit's contract
- `study-debugging-observability` — log/metric/trace mechanics, retention, sampling
- `study-data-modeling` — the `messages` table shape, jsonb tool columns
