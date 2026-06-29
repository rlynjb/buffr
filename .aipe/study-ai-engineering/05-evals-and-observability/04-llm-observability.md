# LLM observability — full-signal trajectory traces

*Industry standard (LLM tracing / spans). buffr's `SupabaseTraceSink` persists all 6 CapabilityEvent types into `agents.messages` with `event.timestamp` as `created_at` — a complete, ordered, replayable trajectory.*

## Zoom out, then zoom in

This is the rich one. Most RAG demos log "question → answer" and call it observability. buffr captures the *whole trajectory* — every Thought, every tool-call with its args, every tool result with duration and error, every model's token usage, every warning — into one ordered table. That trace is three things at once: a debugging tool, a partial cost ledger, and the future fine-tuning corpus.

```
  Zoom out — where the trace is produced and where it lands

  ┌─ Agent loop (aptkit) ───────────────────────────────────────┐
  │  runAgentLoop emits CapabilityEvents at every beat:          │
  │   step · tool_call_start · tool_call_end · model_usage ·     │
  │   warning · error                                            │
  └───────────────────────────┬─────────────────────────────────┘
                              │  trace.emit(event)   ← SYNC (aptkit contract)
  ┌─ Trace sink (buffr) ──────▼─────────────────────────────────┐
  │  ★ SupabaseTraceSink — switch on event.type → queue insert ★ │  ← we are here
  │   emit() queues a Promise; flush() awaits them all           │
  └───────────────────────────┬─────────────────────────────────┘
                              │  persistMessage(...) — await on flush()
  ┌─ Storage ─────────────────▼─────────────────────────────────┐
  │  agents.messages  (created_at = event.timestamp)             │
  │   → the trajectory store · the fine-tuning corpus            │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: observability is the three pillars — logs, metrics, traces. buffr's `agents.messages` is primarily a **trace** (the ordered sequence of one agent run), carries one **metric** inline (`tokens_used`, from `model_usage` events), and treats `warning`/`error` events as structured **logs**. The clever part is the design: `emit()` is synchronous (aptkit forces it), so the sink can't `await` inside it — it queues writes and drains them later, while still preserving correct order via the event's own timestamp.

## Structure pass

**Layers:** the loop (produces events) → the sink (queues + drains) → the table (durable, ordered).

**Axis — "what's the timing guarantee at this boundary?" — traced across the sink:**

```
  trace "when does the write actually happen?" across the sink

  ┌─ emit() ────────────┐  seam   ┌─ pending[] ─────┐  seam   ┌─ flush() ──────┐
  │ called SYNC, during │ ═══════►│ Promise queued, │ ═══════►│ await all      │
  │ the agent run       │ (no     │ NOT yet awaited │ (drain  │ writes settle  │
  │ returns void        │  await) │                 │  point) │ ordered by     │
  │                     │         │                 │         │ created_at     │
  └─────────────────────┘         └─────────────────┘         └────────────────┘
   guarantee: never blocks         guarantee: in-flight        guarantee: durable

  the timing answer FLIPS: emit is fire-and-forget; flush is the durability barrier
```

**The seam:** `emit()` → `flush()` is where "fired" becomes "durable." If buffr called `await trace.flush()` and the writes raced each other on insert time, rows could land out of order. The fix lives at the table boundary: `created_at` is set from `event.timestamp` (captured at emit, deterministic), not from `now()` at insert. So **replay order is the emit order, regardless of which insert finishes first.** That single decision is what makes the trace replayable.

## How it works

### Move 1 — the mental model

You know how React's `useEffect` cleanup or a logging middleware fires a side effect *without* blocking the render? aptkit's trace contract is that: `emit()` must return `void` immediately — it can't be async, because the loop calls it inline between model calls and won't wait. So the sink does what a buffered logger does: it captures the work as a pending Promise, returns instantly, and someone drains the buffer later (`flush()`). The trick that keeps it correct: stamp each event with *when it happened*, not *when it's written*.

```
  the sync-emit / async-flush pattern

  loop ──emit(e1)──► sink: pending.push(write(e1))  ──► returns void (no wait)
  loop ──emit(e2)──► sink: pending.push(write(e2))  ──► returns void
  loop ──emit(e3)──► sink: pending.push(write(e3))  ──► returns void
       ...
  session ──flush()──► await Promise.all(pending)   ──► all rows durable
                       order preserved by created_at = e.timestamp (set at emit)
```

### Move 2 — the step-by-step walkthrough

This sink is reached on *every* agent run — `runAgentLoop` emits events throughout, and `src/session.ts:63` calls `trace.flush()` after each answer.

**Step 1 — `emit()` is synchronous and switches on the event type.** aptkit's `CapabilityTraceSink` contract says `emit(event): void`. buffr's sink reads `event.timestamp` once, then dispatches on `event.type` — six cases, each mapping the event to a `messages` row shape.

```ts
// src/supabase-trace-sink.ts:53-85
emit(event: CapabilityEvent): void {
  const { pool, conversationId } = this.opts;
  const at = event.timestamp;                 // ← captured at emit, used for created_at
  switch (event.type) {
    case 'step': /* assistant reasoning text */ ...
    case 'tool_call_start': /* toolName + args */ ...
    case 'tool_call_end': /* result + error + durationMs */ ...
    case 'model_usage': /* provider/model + token counts */ ...
    case 'warning':
    case 'error': /* a message string */ ...
  }
}
```

It returns `void` — no `await` anywhere inside. That's mandatory: the loop calls this between `model.complete` calls and will not wait on a DB round-trip per event.

**Step 2 — each of the 6 event types maps to a specific row shape.** This is the heart of "full-signal." Most loggers drop everything but the assistant text; buffr persists all six. Here's the mapping, with what each captures and why it matters.

```ts
// src/supabase-trace-sink.ts:57-83 (the six cases)
case 'step':                                                     // ← the Thought
  if (event.content)
    this.push(persistMessage(pool, conversationId, event.role, event.content, { createdAt: at }));
  return;
case 'tool_call_start':                                          // ← the Action (the CAUSE)
  this.push(persistMessage(pool, conversationId, 'tool_call', event.toolName, {
    toolCalls: { toolName: event.toolName, args: event.args }, createdAt: at }));
  return;
case 'tool_call_end':                                            // ← the Observation + timing
  this.push(persistMessage(pool, conversationId, 'tool', event.toolName, {
    toolResults: { result: event.result, error: event.error, durationMs: event.durationMs }, createdAt: at }));
  return;
case 'model_usage':                                              // ← the cost metric
  this.push(persistMessage(pool, conversationId, 'model_usage', '', {
    model: `${event.provider}/${event.model}`,
    tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0), createdAt: at }));
  return;
case 'warning':
case 'error':                                                    // ← structured logs
  this.push(persistMessage(pool, conversationId, event.type, event.message, { createdAt: at }));
  return;
```

Walk the six:

- **`step`** — the assistant's reasoning text (the Thought). Skipped if empty. → `role` row with `content`.
- **`tool_call_start`** — the Action *with its args*. This is the causal record — "the model searched for X." Args are the thing most loggers drop, and they're exactly what you need to debug a bad retrieval. → `tool_call` row, args in `tool_calls` jsonb.
- **`tool_call_end`** — the Observation: the result, any `error`, and `durationMs` (per-tool latency). → `tool` row, in `tool_results` jsonb.
- **`model_usage`** — emitted by the loop per `complete()` when `response.usage` is present (run-agent-loop.ts:111-122). Fills the otherwise-orphaned `tokens_used` column. → `model_usage` row.
- **`warning`** / **`error`** — structured log lines (e.g., the context-guard refusal from `06-error-recovery.md`). → row keyed by the event type.

```
  Layers-and-hops — the 6 event types into one table

  ┌─ Loop ────────────────┐  emit(type)         ┌─ Sink ──────────────────┐
  │ produces, per turn:    │ ───────────────────►│ switch(type):           │
  │  step                  │                     │  step→ role row          │
  │  tool_call_start       │                     │  call_start→ tool_call   │
  │  tool_call_end         │                     │  call_end→ tool          │
  │  model_usage           │  hop: persistMessage│  usage→ model_usage      │
  │  warning / error       │ ───────────────────►│  warn/err→ warning/error │
  └────────────────────────┘                     └──────────┬───────────────┘
                                                 hop: insert │ created_at=e.ts
                                                             ▼
                                              ┌─ agents.messages ──────────┐
                                              │ ordered trajectory + tokens │
                                              └──────────────────────────────┘
```

**Step 3 — writes are queued, not awaited (the sync/async split).** `push()` just appends the in-flight Promise to a `pending` array. No `await`. The DB round-trip happens in the background while the loop keeps running.

```ts
// src/supabase-trace-sink.ts:50, 87-93
private readonly pending: Promise<void>[] = [];
private push(p: Promise<void>): void {
  this.pending.push(p);                 // ← capture the in-flight write, return immediately
}
async flush(): Promise<void> {
  await Promise.all(this.pending);      // ← THE durability barrier
}
```

This is the only way to honor a synchronous `emit()` while still doing async I/O: capture the Promise, drain it later. `flush()` is the single point where buffr says "now everything is durable."

**Step 4 — `created_at = event.timestamp` makes order deterministic.** Here's the subtle, load-bearing decision. The pending writes settle in *whatever order Postgres finishes them* — that's a race. If `created_at` were `now()` at insert, the rows would be timestamped by the race, and replay order would be wrong. Instead, `persistMessage` coalesces the event's own timestamp into `created_at`.

```ts
// src/supabase-trace-sink.ts:26, 30 (inside persistMessage)
const createdAt = extra?.createdAt && extra.createdAt.length > 0 ? extra.createdAt : null;
// ...
`... created_at) values ($1,...,coalesce($8::timestamptz, now()))`,   // ← event time wins; now() only if absent
```

So even though three inserts might land out of order, `order by created_at` replays them in the exact sequence the loop produced them. **The trajectory is replayable because order comes from emit-time, not insert-time.**

```
  Step 4 — why created_at = event.timestamp matters

  emit order:   e1(t=0) ──► e2(t=1) ──► e3(t=2)
  insert race:  e3 lands first, then e1, then e2   (Promise.all, no order)
  rows:         created_at = t=0, t=1, t=2  ◄── from event, NOT insert
  replay:       order by created_at ─► e1, e2, e3   ✓ correct sequence restored
```

**Step 5 — the session flushes after every answer.** Back at buffr's layer, `flush()` is called once per turn, right after the answer is ready and before the (best-effort) memory write.

```ts
// src/session.ts:62-63
const answer = await agent.answer(question);
await trace.flush();                       // ← drain all queued trajectory writes for this turn
```

After this line returns, the full trajectory of that one answer is durable in `agents.messages`, ordered, with token usage attached.

### Move 2 variant — the load-bearing skeleton

The kernel of this trace: **sync emit that queues a write → a flush barrier that drains the queue → an emit-time timestamp persisted as the order key.**

- Drop **the queue (write synchronously inside emit)** → impossible: aptkit's `emit` is `void`, you can't `await` a DB call there. The whole pattern exists to bridge a sync interface to async I/O.
- Drop **the flush barrier** → writes may still be in-flight when the process exits; you lose the tail of the trajectory.
- Drop **`created_at = event.timestamp`** → rows are ordered by the insert race; the replay sequence is scrambled and the trace becomes unreadable as a trajectory. This is the part people forget — they log everything, then can't reconstruct the order.

Optional hardening: per-tool `durationMs` (latency signal), `tokens_used` (cost signal), `error`/`warning` capture (failure signal). These enrich the trace; the skeleton above is what makes it a *trace* at all.

### Move 2.5 — current state vs future state

```
  Phase A (today)                       Phase B (the gaps)
  ─────────────                         ──────────────────
  full trajectory captured              replay HARNESS (read the rows back,
  ordered by created_at                   re-run / inspect a past run)
  tokens_used per model call            cost dashboard (sum tokens × price)
  durationMs per tool                   latency dashboard (p50/p95 over runs)
  warning/error rows                    alerting on error-rate
```

Everything Phase B needs is *already in the table* — the data is captured, it's just not read back yet. A replay harness reads `agents.messages` ordered by `created_at` and reconstructs the run; a cost view sums `tokens_used`; a latency view aggregates `durationMs`. What doesn't have to change: the sink, the loop, the schema. The trace was designed to be read; nobody's reading it yet.

### Move 3 — the principle

Observability for an agent is "capture the whole trajectory, ordered, so you can answer questions you didn't know to ask." The two decisions that make buffr's trace good generalize everywhere: **(1) bridge a sync emit to async I/O by queuing and draining, never by blocking the hot path; (2) order by event-time, not write-time, or your trace lies about sequence.** Get those two right and your "log" becomes a replayable trajectory — and a trajectory of (question, reasoning, tool-calls, answer) tuples is exactly the corpus you fine-tune on later.

## Primary diagram

```
  buffr observability — emit → queue → flush → ordered table, one frame

  ┌─ Agent loop ────────────────────────────────────────────────┐
  │  per turn, emits CapabilityEvents (sync, fire-and-forget):    │
  │   step ─ tool_call_start ─ tool_call_end ─ model_usage ─      │
  │   warning ─ error          each carries event.timestamp       │
  └───────────────────────────┬──────────────────────────────────┘
                              │ trace.emit(e)  (returns void)
  ┌─ SupabaseTraceSink ───────▼──────────────────────────────────┐
  │  switch(e.type) → persistMessage(...)  ─► pending.push(write)  │
  │  (no await — write is in-flight)                              │
  │                                                                │
  │  session: await trace.flush() ─► Promise.all(pending)         │
  │           └─ DURABILITY BARRIER (once per answer)             │
  └───────────────────────────┬──────────────────────────────────┘
                              │ insert, created_at = e.timestamp
  ┌─ agents.messages ─────────▼──────────────────────────────────┐
  │  role | content | tool_calls | tool_results | model |         │
  │  tokens_used | created_at                                     │
  │  order by created_at ─► replayable trajectory  (= FT corpus)  │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

LLM observability matured as teams realized a chat completion is opaque — you see the answer, not the reasoning, the retrieved context, the tool args, or the token spend. The industry settled on *spans*: a trace is a tree/sequence of timed spans (model call, tool call, retrieval), each with inputs, outputs, and timing. buffr's `agents.messages` is a flat-but-ordered version of that — each row is effectively a span (the `tool_call_end` row carries `durationMs`, the span's duration). The sync-emit / async-flush split is the same shape as a buffered, batched logger (OpenTelemetry's BatchSpanProcessor does exactly this). The `created_at = event.timestamp` decision is the same lesson distributed tracing learned the hard way: order by the event's logical time, not the storage write time, because writes race. What buffr adds on top of generic tracing is intent: these rows are the `conversations`/`messages` tables, and they're explicitly the trajectory corpus a future fine-tune would train on (`../06-finetuning-and-training/` territory) — so the trace isn't just for debugging, it's a data asset. The one thing the trace can't catch is the `02-tool-calling.md` empty-query failure, because that failure produces a *clean* `tool_call_start`/`tool_call_end` pair — the trace shows success because every layer reported success.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Build a trajectory replay harness

- **Exercise ID:** OBS-1 (Case A — trace captured, replay not yet built). **The highest-leverage observability exercise.**
- **What to build:** a CLI that takes a `conversation_id`, reads its `agents.messages` ordered by `created_at`, and reconstructs the run as a readable trajectory (Thought / Action+args / Observation+duration / tokens), proving the trace is replayable.
- **Why it earns its place:** Phase B's headline gap. The data is captured; nobody reads it back. A working replay is the "my traces are actually replayable, here's proof" artifact — and it depends on the `created_at = event.timestamp` decision being correct.
- **Files to touch:** new `src/cli/replay-cmd.ts`, query `agents.messages` via `src/db.ts`; map the role/jsonb shapes from `src/supabase-trace-sink.ts:57-83`.
- **Done when:** a multi-turn conversation replays in the exact order the loop produced it, with args, durations, and token counts shown.
- **Estimated effort:** 1–4hr.

### Aggregate token usage into a per-conversation cost view

- **Exercise ID:** OBS-2 (Case A — metric captured, not aggregated).
- **What to build:** a query/CLI that sums `tokens_used` per `conversation_id` (and optionally multiplies by a per-model rate) so each session has a cost figure.
- **Why it earns its place:** `tokens_used` is already populated from `model_usage` events but never read — this turns a stored metric into an actual cost ledger, the start of cost observability.
- **Files to touch:** new query in `src/cli/` reading `agents.messages.tokens_used`; no schema change needed.
- **Done when:** `npm run cost` (or similar) prints total tokens per conversation, sourced from the `model_usage` rows.
- **Estimated effort:** 1–2hr.

## Interview defense

**Q: Walk me through buffr's observability. What do you capture, and how is it stored?**
Answer: the full agent trajectory. `SupabaseTraceSink` handles all six `CapabilityEvent` types — `step` (the Thought), `tool_call_start` (the Action with args, the cause), `tool_call_end` (the Observation with result, error, and `durationMs`), `model_usage` (token counts), and `warning`/`error` — mapping each to a row in `agents.messages`. So I capture the reasoning, the tool args, the results, latency, and token spend, not just the final answer.

```
  6 events → agents.messages: step·call_start·call_end·model_usage·warning·error
```

**Q: `emit()` can't be async — how do you write to Postgres without blocking the loop, and how do you keep the rows in order?**
Answer: two decisions. First, sync-emit / async-flush: `emit()` queues the write Promise into a `pending` array and returns `void` immediately; `flush()` awaits `Promise.all(pending)` once per answer — that's the durability barrier, never on the hot path. Second — and this is **the part people forget** — `created_at` is set from `event.timestamp` (captured at emit), not `now()` at insert. The queued writes settle in a race, but ordering by `created_at` restores the exact emit order. Without that, the trace would be ordered by the insert race and you couldn't replay it.

```
  emit→queue (void) · flush→drain (barrier) · created_at=event.timestamp (order survives the race)
```

## See also

- `02-eval-methods.md` — the eval that *should* read this trace (agent-path faithfulness).
- `03-react-pattern.md` — the trajectory these events record is the ReAct transcript.
- `../04-agents-and-tool-use/06-error-recovery.md` — the `warning`/`error` events this sink persists.
- `../04-agents-and-tool-use/02-tool-calling.md` — the one failure the trace can't catch (clean success on an empty query).
- `01-eval-set-types.md` — the trace is where a regression set's frozen bugs would be read from.
