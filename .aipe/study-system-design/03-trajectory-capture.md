# Trajectory Capture

**Industry names:** trace sink / observer · trajectory logging · sync-emit /
async-flush · Project-specific (the Hermes "capture every conversation"
discipline)

## Zoom out, then zoom in

Every agent run leaves a trail: the user's question, each assistant step,
each tool call and its result. Trajectory capture persists that trail to
`agents.conversations` / `agents.messages` so it survives the process.
aptkit's agent emits *events*; buffr's `SupabaseTraceSink` turns those events
into rows. The point isn't observability for its own sake — it's the parent
plan's thesis: *capture trajectories now so fine-tuning is answerable later*.

```
  Zoom out — where the trace sink sits

  ┌─ CLI layer (buffr) ──────────────────────────────────────────┐
  │  ask-cmd: startConversation → persist user → agent.answer     │
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Toolkit layer (aptkit) ──▼──────────────────────────────────┐
  │  RagQueryAgent ── emits CapabilityEvent ──► trace.emit()      │
  └──────────────────────────┬───────────────────────────────────┘
                             │ implements CapabilityTraceSink
  ┌─ Adapter layer (buffr) ──▼──────────────────────────────────┐
  │      ★ SupabaseTraceSink ★   emit() queues, flush() awaits    │
  └──────────────────────────┬───────────────────────────────────┘
                             │ pg
  ┌─ Storage layer ──────────▼──────────────────────────────────┐
  │  agents.conversations  ·  agents.messages (role, content...)  │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is an **observer behind a sink interface**, with a twist
— the interface's `emit()` is *synchronous* but the writes are *async*. That
mismatch is the whole interesting part. Strip this out and the agent still
answers, but every conversation evaporates when the process exits — no history,
no trajectory dataset, no MLOps story.

## Structure pass

**Layers** — CLI (opens conversation, writes the user turn) → agent (emits
events) → sink (queues writes) → pg.

**Axis: synchronous or asynchronous?** Trace it across the seam — this is the
axis that flips and makes the boundary load-bearing.

```
  One question: "is this call sync or async?"

  ┌──────────────────────────────────────────────┐
  │ aptkit agent: emit(event)  — SYNC, returns void│ → contract is SYNC
  └───────────────────────┬──────────────────────┘
      ┌───────────────────▼──────────────────────┐
      │ sink.emit: push promise, don't await      │ → bridges sync→async
      └───────────────────┬──────────────────────┘
          ┌───────────────▼──────────────────────┐
          │ pg INSERT: inherently ASYNC (await)   │ → storage is ASYNC
          └───────────────────────────────────────┘

  the sync/async answer flips inside emit() — that's the seam's whole job
```

**Seam.** `CapabilityTraceSink.emit()` is a *horizontal seam* with a hard
shape constraint: aptkit calls it synchronously and ignores its return value.
A DB write is async. So the sink can't `await` inside `emit()` — it must queue
the promise and drain it later. The load-bearing part is `flush()`: the thing
that makes "fire-and-forget during the run" become "all writes landed before
exit."

## How it works

### Move 1 — the mental model

You know how you can fire off `void doSomethingAsync()` without awaiting, then
later `await Promise.all(pending)` to make sure they all finished? That's
exactly the kernel. `emit()` is the fire; `flush()` is the join.

```
  sync-emit / async-flush — the kernel

  agent run:
    emit(e1) ─► pending.push(write(e1))   ┐
    emit(e2) ─► pending.push(write(e2))   │  fire, don't await
    emit(e3) ─► pending.push(write(e3))   ┘
  run ends:
    flush() ─► await Promise.all(pending) ── all three land before exit
```

### Move 2 — the load-bearing skeleton

The kernel has three parts. Name each by what breaks without it.

#### Part 1 — the conversation row (the parent key)

Before any message, `startConversation` inserts an `agents.conversations` row
and returns its id. Every message FKs to it.

```
  conversation first — it's the parent every message needs

  startConversation(pool, appId) ─► INSERT conversations RETURNING id
                                         │
                                         ▼  conversationId
                          every persistMessage(conversationId, ...)
```

What breaks without it: messages have no `conversation_id` to hang on; the
FK (`messages.conversation_id → conversations.id`, `on delete cascade`) has
nothing to point at.

#### Part 2 — emit() queues, never awaits (the sync bridge)

`emit()` receives a `CapabilityEvent`, decides which events are worth a row
(assistant steps, tool-call ends), builds the write *promise*, and pushes it
onto `pending`. It returns `void` immediately — honoring aptkit's sync
contract.

```
  pseudocode — emit, the sync bridge

  emit(event):
    if event is assistant step with content:
      pending.push( persistMessage(convId, 'assistant', event.content) )
    else if event is tool_call_end:
      pending.push( persistMessage(convId, 'tool', event.toolName,
                                   { toolResults: event.result }) )
    return                              // SYNC — never await here
```

What breaks if you `await` inside `emit()`: you can't — aptkit's signature is
`emit(event): void`, so an await would either be dropped (floating promise) or
force you to change aptkit, which the must-not-change rule forbids. Queueing
is the *only* way to bridge sync-in to async-out without editing the library.

#### Part 3 — flush() joins (the part people forget)

After `agent.answer()` returns, the CLI calls `trace.flush()`, which awaits
every queued write. This is the load-bearing line: skip it and the process
exits while inserts are still in flight, and trajectory rows are silently lost.

```
  flush — the join that makes the writes real

  await agent.answer(question)     // emits queued N writes
  await trace.flush()              // ◄── await Promise.all(pending)
  // only now is it safe to pool.end() and exit
```

What breaks without flush: `pool.end()` (or process exit) races the pending
inserts. The answer prints fine; the conversation is half-written or empty.
This is the classic floating-promise bug, contained by making the join
explicit.

### Move 2.5 — current state vs the deferred future

This is also the seam the parent plan leans on for a future it hasn't built.

```
  Phase A (now)              vs   Phase B (deferred, named)

  trajectories → messages         same rows → fine-tune dataset
  for history + debugging         (LoRA on Gemma, IF Phase 4 demands it)
  ─────────────────────           ────────────────────────────────
  WRITTEN every run               READ later as training data
  no consumer yet                 consumer = the eval-driven decision
```

The takeaway: *nothing about the capture has to change* for the fine-tune
future. The rows are written now; whether they're ever consumed as training
data is a Phase-4 decision gated on eval numbers (`agent-layer-plan.md`
Phase 4). Capture-now-decide-later is the design.

### Move 3 — the principle

When a library hands you a *synchronous* callback but your real work is
*asynchronous*, you don't fight the signature — you queue the work and join it
at a known safe point. The contract stays clean (sync emit), the writes stay
correct (awaited flush), and the library stays untouched.

## Primary diagram

The full capture path, both message sources, the sync/async flip marked.

```
  Trajectory capture — full path

  ┌─ CLI (ask-cmd) ─────────────────────────────────────────────────┐
  │ startConversation ─► convId                                      │
  │ persistMessage(convId,'user', question)   ← user turn (CLI)      │
  │ agent.answer(question) ───────────────────────────────────┐     │
  │ await trace.flush()  ◄────────────────────────────────┐   │     │
  └──────────────────────────────────────────────────────┼───┼─────┘
  ┌─ Agent (aptkit) ──────────────────────────────────────┼───▼─────┐
  │ per step: trace.emit(event)  (SYNC, void) ─────────────┼─────────│
  └───────────────────────────────────────────────────────┼─────────┘
  ┌─ SupabaseTraceSink (buffr) ───────────────────────────▼─────────┐
  │ emit: push persistMessage(...) onto pending  (no await)         │
  │ flush: await Promise.all(pending)   ← the join                  │
  └──────────────────────────┬──────────────────────────────────────┘
                             │ pg INSERT (async)
  ┌─ Storage ────────────────▼──────────────────────────────────────┐
  │ conversations(id, app_id, agent_name)                           │
  │ messages(conversation_id, role, content, tool_results, model)   │
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached on every `ask`. The user turn is written by the CLI;
assistant and tool turns are written by the sink as the agent loop runs;
`flush()` runs once after the answer.

**Conversation + message writers** — `src/supabase-trace-sink.ts:4-19`

```
  startConversation: INSERT conversations (app_id, agent_name) RETURNING id  ← 5-6
  persistMessage: INSERT messages (conversation_id, role, content,
                                   tool_results, model)                       ← 14-18
        │
        └─ conversation is the parent key; persistMessage is reused by both
           the CLI (user turn) and the sink (assistant/tool turns).
```

**The sync bridge — emit queues** — `src/supabase-trace-sink.ts:23-35`

```
  export class SupabaseTraceSink implements CapabilityTraceSink {   ← 23: the seam
    private readonly pending: Promise<void>[] = [];                 ← 24: the queue
    emit(event: CapabilityEvent): void {                            ← 27: SYNC, void
      if (event.type === 'step' && event.role === 'assistant' && event.content)
        this.pending.push(persistMessage(pool, conversationId, 'assistant', event.content)); ← 30
      else if (event.type === 'tool_call_end')
        this.pending.push(persistMessage(pool, conversationId, 'tool',
                          event.toolName, { toolResults: event.result }));     ← 32-33
    }
        │
        └─ pushes the write promise, never awaits — the only way to satisfy a
           void-returning emit() without editing aptkit.
```

**The join — flush** — `src/supabase-trace-sink.ts:37-39`

```
  async flush(): Promise<void> {
    await Promise.all(this.pending);     ← 38: await every queued write
  }
        │
        └─ called at ask-cmd.ts:35 after agent.answer. Without this line the
           process can exit mid-insert and lose trajectory rows.
```

**The wiring** — `src/cli/ask-cmd.ts:29-35`

```
  const conversationId = await startConversation(pool, cfg.appId);  ← 29
  await persistMessage(pool, conversationId, 'user', question);     ← 30: user turn
  const trace = new SupabaseTraceSink({ pool, conversationId });    ← 31
  const agent = new RagQueryAgent({ model, tools, profile, trace });← 33: trace injected
  const answer = await agent.answer(question);                      ← 34
  await trace.flush();                                              ← 35: THE JOIN
        │
        └─ user turn written by CLI before the agent runs; assistant/tool
           turns written by the sink during the run; flush joins after.
```

## Elaborate

The trace-sink shape is the observer pattern with a persistence backend, and
the sync/async bridge is a recurring real-world wrinkle: instrumentation APIs
(OpenTelemetry span processors, logging handlers) are often synchronous
because the instrumented code can't pay for an await on the hot path, while
the export is async. The queue-and-flush is the standard answer. The *reason*
buffr captures at all is borrowed deliberately from Nous Research's Hermes
Agent — its "capture every conversation as a trajectory" discipline — while
explicitly *not* borrowing its platform or its fine-tuned models
(`agent-layer-plan.md`, "What it is NOT"). The honest red flag (carried from
`audit.md` §8): an individual `emit` write failure surfaces only at `flush`'s
`Promise.all`, after the answer is computed — trajectory loss is non-fatal to
the answer, an acceptable ordering but a real property to know.

## Interview defense

**Q: aptkit's `emit()` is synchronous but a DB write is async. How do you
reconcile that without editing aptkit?**

Queue and join. `emit()` builds the write promise and pushes it onto a
`pending` array, returning void immediately — honoring the sync contract. A
`flush()` method awaits `Promise.all(pending)` after the run. The library stays
untouched; the writes still land.

```
  emit (sync) ─push─► [pending]  ─flush (async)─► Promise.all → all landed
```

Anchor: `src/supabase-trace-sink.ts:27` (emit) and `:38` (flush).

**Q: What's the bug if you forget `flush()`?**

The process exits — or `pool.end()` runs — while inserts are still in flight,
so you lose trajectory rows. The answer prints fine, which is what makes it
sneaky: it's a floating-promise race, and the explicit join is the fix.

```
  no flush:  answer printed ──► pool.end() ──X──► inserts dropped
  flush:     answer printed ──► await pending ──► pool.end() (safe)
```

Anchor: `src/cli/ask-cmd.ts:35`.

## Validate

1. **Reconstruct.** From memory, write the three-line kernel: the queue, the
   sync push, the async join.
2. **Explain.** Why can't `emit()` simply `await` the insert?
   (`supabase-trace-sink.ts:27`, aptkit's `emit(event): void` signature.)
3. **Apply.** A conversation's assistant turns are missing but the answer was
   correct. Which line would you check first? (`ask-cmd.ts:35` — was `flush`
   called and awaited.)
4. **Defend.** Argue why writing the `user` turn from the CLI
   (`ask-cmd.ts:30`) but the `assistant`/`tool` turns from the sink
   (`supabase-trace-sink.ts:30-33`) is a reasonable split.

## See also

- `02-retrieval-pipeline.md` — the tool whose `tool_call_end` events get
  captured.
- `06-profile-injection-as-context.md` — the other thing injected into the
  agent.
- `07-deferred-body.md` — why trajectories are written before there's a
  consumer.
- `study-runtime-systems` — the floating-promise / queue-and-join mechanics.
- `study-agent-architecture` — the agent loop that emits these events.
