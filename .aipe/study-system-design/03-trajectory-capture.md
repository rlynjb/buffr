# 03 — Trajectory Capture

**Industry name(s):** event sourcing / trace sink · full-signal observability · the trajectory-capture discipline (Hermes Agent's idea). **Type:** Industry standard (applied to agents).

## Zoom out — where this concept lives

Every agent run emits a stream of events — the model spoke, a tool was called with these args,
the tool returned in 240ms, the model used 1,800 tokens, a warning fired. buffr persists *all six
event types* as rows, turning each conversation into a complete, replayable trajectory. This is
the **observability port** of the system: aptkit defines the `CapabilityTraceSink` contract;
buffr's `SupabaseTraceSink` is the adapter that lands those events in Postgres.

```
  Zoom out — the trace sink in the system

  ┌─ Agent layer (aptkit) ────────────────────────────────────────┐
  │  RagQueryAgent.answer() — emits CapabilityEvents as it runs    │
  │    step · tool_call_start · tool_call_end ·                    │
  │    model_usage · warning · error                              │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  the PORT: CapabilityTraceSink.emit(event)
  ┌─ Adapter layer (buffr owns) ──▼──────────────────────────────┐
  │  ★ SupabaseTraceSink implements CapabilityTraceSink ★         │
  │  src/supabase-trace-sink.ts — emit() queues, flush() awaits   │
  └───────────────────────────────┬──────────────────────────────┘
  ┌─ Storage layer ───────────────▼──────────────────────────────┐
  │  agents.messages — one row per event, ordered by event time   │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **a trace sink that captures full signal**. The question it answers:
*if you wanted to fine-tune on this agent's behavior next year, would you have the data?* buffr's
answer is yes, captured from day one — the parent plan calls this "capture every conversation as a
trajectory now so fine-tuning is *answerable* later" (`agent-layer-plan.md:13,17`).

## Structure pass — layers, axis, seam

**Layers:** agent (emits) → sink (queues) → flush (awaits) → `agents.messages` (rows).

**Axis — trace *control flow timing* (sync vs async) across the seam:**

```
  axis = "is this call sync or async?"

  agent loop ──emit(event)──► sink        SYNC   (aptkit's contract demands it)
       sink ──push(promise)──► pending[]  SYNC   (queue the write, don't await)
       turn ──flush()──────────► await all ASYNC  (drain the queue after the run)

  the axis FLIPS at the sink: emit must return instantly, but the DB write is async.
  the sink bridges sync-in to async-out. that bridge IS the pattern.
```

**The seam:** `CapabilityTraceSink.emit(event)` is the joint. aptkit calls it *synchronously*
mid-loop — it can't `await` a database on every event without serializing the whole agent. So the
sink's job is to accept a sync call and *defer* the async I/O. The seam is where a sync contract
meets async storage; the queue is how the sink honors both.

## How it works

### Move 1 — the mental model

You've fired analytics events from a React component: `track('clicked')` returns instantly, the
network POST happens in the background, and you never `await` it in the click handler. The trace
sink is that, with one addition — at the end of the turn you `flush()` to make sure every queued
write actually landed before you move on. Fire-and-collect, then drain.

```
  The trace-sink pattern — sync emit, deferred flush

  agent loop:   emit ─► emit ─► emit ─► emit ─► emit ─► (run ends)
                  │       │       │       │       │
                  ▼       ▼       ▼       ▼       ▼
  pending[]:    [ p0 ]  [p0,p1] [..p2]  [..p3]  [..p4]      ← promises queued, not awaited
                                                  │
                                            flush() ─► await Promise.all(pending)  ← drain here
                                                  │
                                            all rows durable in agents.messages
```

### Move 2 — the walkthrough

**The sync/async bridge — `emit` queues, `flush` awaits.** This is the kernel
(`supabase-trace-sink.ts:49-93`):

```ts
// src/supabase-trace-sink.ts:49
export class SupabaseTraceSink implements CapabilityTraceSink {
  private readonly pending: Promise<void>[] = [];          // the queue

  emit(event: CapabilityEvent): void {                     // SYNC — returns void, no await
    // ... switch on event.type, each case calls this.push(persistMessage(...))
  }
  private push(p: Promise<void>): void { this.pending.push(p); }  // queue, don't await

  async flush(): Promise<void> { await Promise.all(this.pending); }  // drain after the run
}
```

`emit` returns `void` — it *must*, because aptkit's contract calls it synchronously inside the
loop (line 39-40 of the source comment: "emit() is sync (aptkit's contract); writes are queued and
awaited via flush()"). If `emit` blocked on a DB round-trip, every event would serialize the agent.
Instead each write is a promise pushed onto `pending`; `flush()` (called once in `session.ts:63`
after `agent.answer`) awaits them all at once. The per-event writes run *concurrently*, drained in
one `Promise.all`.

**Full-signal capture — every event type becomes a row.** The `switch` is the whole point: it
handles all six `CapabilityEvent` variants, not just the obvious two (`supabase-trace-sink.ts:53-84`):

```ts
// src/supabase-trace-sink.ts:53
emit(event: CapabilityEvent): void {
  const at = event.timestamp;
  switch (event.type) {
    case 'step':                                    // assistant text
      if (event.content) this.push(persistMessage(pool, conv, event.role, event.content, { createdAt: at }));
      return;
    case 'tool_call_start':                         // the CAUSE — args the model passed
      this.push(persistMessage(pool, conv, 'tool_call', event.toolName,
        { toolCalls: { toolName: event.toolName, args: event.args }, createdAt: at })); return;
    case 'tool_call_end':                           // the EFFECT — result, error, duration
      this.push(persistMessage(pool, conv, 'tool', event.toolName,
        { toolResults: { result: event.result, error: event.error, durationMs: event.durationMs }, createdAt: at })); return;
    case 'model_usage':                             // tokens — fills the orphaned tokens_used column
      this.push(persistMessage(pool, conv, 'model_usage', '',
        { model: `${event.provider}/${event.model}`, tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0), createdAt: at })); return;
    case 'warning': case 'error':                   // the failures, not dropped
      this.push(persistMessage(pool, conv, event.type, event.message, { createdAt: at })); return;
  }
}
```

The source comment (lines 43-48) names exactly what *used* to be dropped: "Tool-call args (the
cause), durationMs + error, token usage, and warning/error events were previously dropped on the
floor; capturing them turns `agents.messages` into a complete, replayable trajectory." That's the
difference between a chat log (assistant said X) and a trajectory (model decided to call tool T with
args A, it returned R in 240ms using 1800 tokens). The trajectory is the fine-tuning-grade signal.

**Deterministic replay order — the timestamp is load-bearing.** Every `persistMessage` passes
`createdAt: at` from `event.timestamp`, and the SQL coalesces it (`supabase-trace-sink.ts:26-30`):

```ts
// src/supabase-trace-sink.ts:27
const createdAt = extra?.createdAt && extra.createdAt.length > 0 ? extra.createdAt : null;
await pool.query(
  `insert into agents.messages (... created_at)
   values (..., coalesce($8::timestamptz, now()))`,   // event time, not insert time
  [..., createdAt]);
```

Why this matters: the writes flush *concurrently* (`Promise.all`), so insert order is a race. If
`created_at` defaulted to `now()` at insert time, replay order would be nondeterministic — events
could be reordered by which INSERT won the race. Using the *event's* timestamp pins replay order to
emit order (source comment lines 47-48). This is the subtle correctness detail in the file: the
concurrency that makes flush fast would scramble order, so the event timestamp re-pins it.

**Conversation lifecycle — one row, created once.** `startConversation` inserts the parent row at
session start (`supabase-trace-sink.ts:4-8`, called once in `session.ts:55`); every event row
references that `conversation_id` (the FK with `on delete cascade`, `sql/001:42`). One conversation
per session (`05`), many event rows under it.

### Move 2 variant — the load-bearing skeleton

```
  Trace-sink kernel:
    1. emit() returns void          — honor aptkit's sync contract
    2. queue promise, don't await   — don't serialize the agent on DB I/O
    3. flush() awaits all           — guarantee durability after the run
    4. event.timestamp → created_at — pin replay order against concurrent inserts
    5. switch over ALL 6 types      — full signal, not just assistant text
```

- Drop **#1** (make emit async) → the agent loop must await; every event serializes the run.
- Drop **#3** → the turn returns before writes land; a fast exit loses the trajectory.
- Drop **#4** → concurrent flush reorders events; replay is nondeterministic.
- Drop **#5's tool/usage/error cases** → you have a chat log, not a trajectory; fine-tuning is
  no longer answerable. That's the *whole reason the pattern exists*.

Optional hardening *not* here: batching the inserts into one multi-row statement, a write-ahead
buffer, backpressure if `pending` grows unbounded. None needed at single-user volume.

### Move 3 — the principle

**Capture the cause and the effect of every decision, timestamped, or you don't have a trajectory —
you have a log.** The discipline is to record *why* the agent did something (tool args, token spend,
warnings), not just *what* it said, because next year's question ("should we fine-tune, and on
what?") can only be answered from data you captured before you knew you'd need it. The cost is a row
per event; the payoff is that the decision stays evidence-based instead of a guess.

## Primary diagram

```
  Trajectory Capture — full picture

  ┌─ Agent (aptkit) ──────────────────────────────────────────────┐
  │  RagQueryAgent.answer()  emits, in order:                      │
  │   step → tool_call_start → tool_call_end → model_usage → step  │
  └──────────────┬────────────────────────────────────────────────┘
       emit() SYNC│  (void return, mid-loop)
  ┌─ SupabaseTraceSink (buffr) ▼──────────────────────────────────┐
  │  switch(type): build row payload (args / result+duration /    │
  │                tokens / message) tagged with event.timestamp  │
  │  push(persistMessage(...)) → pending[]   (queued, concurrent) │
  └──────────────┬────────────────────────────────────────────────┘
   flush() ASYNC  │  await Promise.all(pending)  (once, after the run — session.ts:63)
  ┌─ Storage ─────▼───────────────────────────────────────────────┐
  │  agents.messages — one row per event,                          │
  │   created_at = event time → deterministic replay order         │
  │   FK → conversations(id) on delete cascade                     │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

This is borrowed, explicitly, from Hermes Agent's MLOps discipline — but "none of its platform
machinery or its fine-tuned models" (`agent-layer-plan.md:13`). buffr steals the *pattern* (capture
trajectories now) without the platform. The deeper idea is event sourcing: the `messages` table is
an append-only event log, and the conversation is a projection you can rebuild by replaying it in
`created_at` order. That's why the timestamp pinning matters — event sourcing is only sound if the
log order is the truth.

The trajectory is also the bridge to the deferred fine-tuning ceiling: Phase 4's "ship vs. iterate
vs. fine-tune" decision "can supply data" from "Phase-3 trajectories" (`agent-layer-plan.md:97`).
You can't fine-tune on data you didn't capture, and you can't capture it after the fact — hence
day-one capture.

Read next: `05-long-lived-chat-session.md` (where `flush` is called in the turn), `04-library-as-
dependency-boundary.md` (why the sink is a port). Log/metric/trace mechanics →
`study-debugging-observability`. The `messages` schema shape → `study-data-modeling`.

## Interview defense

**Q: Why not just await each event write inside emit?**
Because aptkit calls `emit` synchronously inside the agent loop — its contract returns `void`. If
you awaited a DB round-trip per event, every event would serialize the agent's reasoning. So `emit`
queues a promise and `flush()` drains them concurrently after the run (`supabase-trace-sink.ts:53,
87-93`). Sync contract honored, I/O deferred, writes parallel.

```
  emit (sync)  ─► push promise ─► pending[]          ← agent never blocks
  flush (async)─► Promise.all(pending)               ← drained once, concurrently
```

**Q: Your inserts run concurrently. How do you keep the trajectory in order?**
Every row's `created_at` is the *event's* timestamp, not insert time — `coalesce($8::timestamptz,
now())` with the event time passed in (`supabase-trace-sink.ts:27-30`). Concurrent inserts can land
in any order, but ordering by `created_at` replays them in emit order. The timestamp is the part
people forget — without it the concurrency that makes flush fast would scramble the trajectory.

**Q: What makes this a trajectory and not a chat log?**
The full-signal capture: `tool_call_start` records the *args the model chose* (the cause),
`tool_call_end` records result + `durationMs` + error (the effect), `model_usage` records tokens.
A chat log has assistant text; a trajectory has every decision and its cost
(`supabase-trace-sink.ts:62-78`). That's what makes fine-tuning answerable later.

## See also

- `05-long-lived-chat-session.md` — where `flush()` sits in the turn ordering.
- `04-library-as-dependency-boundary.md` — `CapabilityTraceSink` as an injected port.
- `audit.md` lens 2 (the ask flow), lens 5 (per-event durability), red-flag #3 (silent memory catch).
- `study-debugging-observability` → traces/logs. `study-data-modeling` → the `messages` table.
