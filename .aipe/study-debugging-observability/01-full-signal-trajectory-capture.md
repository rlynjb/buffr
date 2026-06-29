# Full-Signal Trajectory Capture

**Industry names:** agent trajectory logging · execution trace persistence ·
event-sourced agent run. **Type:** Project-specific (the application of a
general pattern — event sourcing — to an agent loop).

---

## Zoom out, then zoom in

You know how, when a `fetch()` fails, the only thing worse than the error is an
error with no request/response logged next to it? You're left guessing what you
sent. This pattern is the opposite end of that: the agent loop emits a typed
event at every interesting moment, and the sink writes *all* of them down, so
nothing is left to guess.

Here's where it sits. The thick box is this concept.

```
  Zoom out — where trajectory capture lives

  ┌─ UI layer (Ink) ─────────────────────────────────────────┐
  │  chat.tsx → session.ask(q)                                │
  └──────────────────────────┬────────────────────────────────┘
                             │  agent.answer(q)
  ┌─ Session / Agent layer ──▼────────────────────────────────┐
  │  RagQueryAgent → runAgentLoop → trace?.emit(event) × 6    │
  └──────────────────────────┬────────────────────────────────┘
                             │  CapabilityEvent (6 variants)
  ┌─ Trace sink ═════════════▼════════════════════════════════┐
  │ ║ ★ SupabaseTraceSink.emit() ★  switch on event.type      ║│ ← we are here
  │ ║   one persistMessage() per event, queued in pending[]   ║│
  └──────────────────────────┬────────────────────────────────┘
                             │  insert into agents.messages
  ┌─ Storage (Postgres) ─────▼────────────────────────────────┐
  │  agents.messages — the replayable trajectory              │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **persist every event type, not just the answer.** The
agent loop is a sequence of decisions and effects — it picks a tool, calls it,
spends tokens, writes text. Capture the *whole* sequence as durable rows and the
messages table stops being a chat log and becomes a trajectory you can replay,
audit, and root-cause from. The question it answers: *when an answer is wrong,
what evidence exists to explain it?* All of it.

## Structure pass

Three layers stack here, and one axis makes the boundaries pop: **failure
visibility** — "if something goes wrong at this layer, does a durable record
exist?"

```
  One axis — "does a durable record survive?" — down the layers

  ┌─ aptkit loop (emits) ───────────────┐  → emits 6 typed events;
  │  runAgentLoop, RagQueryAgent        │    owns WHAT is observable
  └──────────────────┬──────────────────┘
        seam: CapabilityTraceSink contract  ← axis flips here
  ┌─ buffr sink (persists) ─────────────┐  → DECIDES each event becomes
  │  SupabaseTraceSink.emit()           │    a row; durable record exists
  └──────────────────┬──────────────────┘
        seam: SQL insert (sync emit → async write)
  ┌─ Postgres (stores) ─────────────────┐  → record survives the process;
  │  agents.messages                    │    queryable after the fact
  └─────────────────────────────────────┘
```

**The load-bearing seam is `CapabilityTraceSink`.** Above it, aptkit decides
*what events exist* (the six `CapabilityEvent` variants). Below it, buffr decides
*which become durable and how*. The contract is one method: `emit(event)`,
synchronous. That seam is why buffr can capture the full signal without editing
aptkit — it just implements the sink richly. The axis flips right there: above
the seam an event is a fleeting function call; below it, it's a row that outlives
the run.

The other seam — `emit()` is **sync** but a SQL insert is **async** — is where
the `flush()` mechanism lives (Move 2 below). Hold that thought.

## How it works

### Move 1 — the mental model

The shape is event sourcing, shrunk to one agent run. Instead of storing the
final state ("the answer"), you store the *stream of events that produced it*,
and the state is whatever you get by replaying them. You've built the read-side
of this shape every time you rendered a list from an array of items: the array is
the source of truth, the rendered list is a projection. Here the event stream is
the source of truth; the answer is just the last projection.

```
  The pattern — one run, six event types, six (or more) rows

  agent run ──┐
              │  emit(step)             → row: role=assistant, content
              │  emit(tool_call_start)  → row: role=tool_call, args  ◄ THE CAUSE
              │  emit(tool_call_end)    → row: role=tool, result/error/durationMs
              │  emit(model_usage)      → row: role=model_usage, model, tokens
              │  emit(warning)          → row: role=warning, message
              │  emit(error)            → row: role=error, message
              ▼
        agents.messages  ── select order by created_at ──► replay the run
```

The kernel: **a switch over `event.type`, one `persistMessage` per case, and a
`pending[]` queue awaited by `flush()`.** Everything else is which columns each
event type fills.

### Move 2 — the step-by-step walkthrough

**The use case.** Every chat turn. `session.ask()` runs the agent, then calls
`trace.flush()` (`src/session.ts:62-63`). Between those two lines, the loop has
emitted a handful of events and the sink has queued a handful of inserts.

**Part 1 — the sink is a switch over six event types.** This is the whole
contract. Drop any case and that event type silently vanishes from the
trajectory.

```ts
// src/supabase-trace-sink.ts:53-85
emit(event: CapabilityEvent): void {
  const { pool, conversationId } = this.opts;
  const at = event.timestamp;            // ← client timestamp, see file 02
  switch (event.type) {
    case 'step':                         // assistant text
      if (event.content) {               // ← gate: empty text = no row (the gap)
        this.push(persistMessage(pool, conversationId, event.role, event.content, { createdAt: at }));
      }
      return;
    case 'tool_call_start':              // THE CAUSE — args the tool was called with
      this.push(persistMessage(pool, conversationId, 'tool_call', event.toolName, {
        toolCalls: { toolName: event.toolName, args: event.args }, createdAt: at,
      }));
      return;
    case 'tool_call_end':                // result + error + how long it took
      this.push(persistMessage(pool, conversationId, 'tool', event.toolName, {
        toolResults: { result: event.result, error: event.error, durationMs: event.durationMs },
        createdAt: at,
      }));
      return;
    case 'model_usage':                  // fills the otherwise-orphaned tokens_used
      this.push(persistMessage(pool, conversationId, 'model_usage', '', {
        model: `${event.provider}/${event.model}`,
        tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
        createdAt: at,
      }));
      return;
    case 'warning':
    case 'error':                        // both fold into a single message row
      this.push(persistMessage(pool, conversationId, event.type, event.message, { createdAt: at }));
      return;
  }
}
```

Read it as: each event type maps to one row, and the *interesting* payload lands
in the right column. `tool_call_start` captures `args` into `tool_calls` — that's
**the cause**, the thing you need to explain a wrong answer. `tool_call_end`
captures `result`, `error`, and `durationMs` into `tool_results` — the effect and
its cost. `model_usage` is the one that fills `tokens_used`, a column that would
otherwise sit empty forever. Boundary condition: the `step` case has an
`if (event.content)` guard — keep that in mind, it's the source of the fallback
gap in Move 2.5.

**Part 2 — sync emit, async write: the `pending[]` queue.** Here's the seam the
structure pass flagged. `emit()` must be synchronous (that's aptkit's contract —
the loop calls it inline and moves on), but a SQL insert is a Promise. You can't
`await` inside `emit()`. So each insert is *queued*, not awaited:

```ts
// src/supabase-trace-sink.ts:50, 87-93
private readonly pending: Promise<void>[] = [];

private push(p: Promise<void>): void {
  this.pending.push(p);          // fire the insert, stash the promise
}

async flush(): Promise<void> {
  await Promise.all(this.pending);   // session.ts awaits this after the run
}
```

```
  Sync emit feeds an async drain

  loop (sync)        sink                    Postgres
  ──────────         ────                    ────────
  emit(e1) ───► push(insert1) ─┐ fire
  emit(e2) ───► push(insert2) ─┤ fire        inserts run
  emit(e3) ───► push(insert3) ─┘ fire        concurrently
                    │
  (run ends)        │
  flush() ─────► await Promise.all(pending)  ◄── all settled here
```

What breaks if you remove `flush()`: the process could exit (or the next turn
start) before the inserts land — you'd lose the tail of the trajectory. What
breaks if you `await` inside `emit()` instead: you'd violate aptkit's sync
contract and serialize the whole loop on Postgres latency. The queue is the
resolution of that tension. Note the side effect: because inserts fire
concurrently, *insert completion order is a race* — which is exactly why ordering
can't rely on `now()` and must use the client timestamp. That's file 02.

**Part 3 — the correlation key ties every row to one run.** The sink is
constructed with a `conversationId` (`src/supabase-trace-sink.ts:51`), set once
per session in `startConversation` (`:4-8`). Every `persistMessage` carries it
(`sql/001_agents_schema.sql:42`, the FK). So the trajectory is queryable as a
unit:

```
  Layers-and-hops — one run becomes one queryable trajectory

  ┌─ Session ────┐ startConversation()  ┌─ Postgres ──────────┐
  │ session.ts   │ ───────────────────► │ conversations: 1 row│
  └──────┬───────┘    returns uuid      └─────────┬───────────┘
         │ new SupabaseTraceSink({conversationId})│ FK
         ▼                                         ▼
  ┌─ Trace sink ─┐  emit × N            ┌─ messages ──────────┐
  │ holds the id │ ───────────────────► │ N rows, same conv id│
  └──────────────┘                      └─────────────────────┘
       debug query: select * from messages
                    where conversation_id = $1 order by created_at
```

#### Move 2.5 — current state vs the fallback gap

The capture is full *except* for one path, and it's worth drawing as
before/after because it's the audit's #1 blind spot.

```
  Two paths out of the loop — only one leaves a row

  PATH A: model returns text         PATH B: model returns empty
  ────────────────────────          ────────────────────────────
  text = "..." (truthy)              text = "" (falsy)
  if (text) → emit(step) ✓           if (text) → NO emit          ← gate
  finalText = text                   finalText = ""
  answer = text                      answer = "" || FALLBACK_ANSWER
                                              = FALLBACK_ANSWER
  ▼                                  ▼
  messages has a step row            messages has NO row for the answer
  (the answer is recorded)           (user sees fallback, trace is blank)
```

Grounding: the gate is `if (text)` at
`@aptkit/runtime/dist/src/run-agent-loop.js:50-52`; the substitution is
`finalText.trim() || FALLBACK_ANSWER` at
`@aptkit/agent-rag-query/dist/src/rag-query-agent.js:51`. The fallback string is
`"I couldn't find anything in the knowledge base to answer that."` (`:21`).

This is an **aptkit-side** gate — buffr's sink is faithful; it can't emit a `step`
that was never emitted. The fix, if buffr wants the fallback in the trajectory,
is in `session.ts`: after `agent.answer()`, if the returned answer is the fallback
sentinel, persist a synthetic `step` row before `flush()`. The takeaway worth
keeping: **full-signal capture is only as complete as the events the producer
emits** — a gated `emit` upstream is a hole in your trajectory downstream, and you
won't see the hole until you go looking for the row that isn't there.

#### Move 3 — the principle

Store the events, not the state. The state is a projection you can always
recompute; the events are the only thing you can't reconstruct after the fact. An
agent run is a perfect fit for this because the run *is* a sequence of decisions
and effects — capture them all and "why did it do that?" becomes a query instead
of a guess. The discipline that makes it pay off: capture the *cause* (args) next
to the *effect* (result), at the same fidelity, or you'll have half a story.

## Primary diagram

The whole pattern in one frame.

```
  Full-signal trajectory capture — end to end

  ┌─ Agent loop (aptkit) ─────────────────────────────────────────────┐
  │  per run, emits in causal order:                                   │
  │   model_usage → tool_call_start(args) → tool_call_end(result) → step│
  │   (+ warning / error anywhere)                                     │
  └───────────────────────────────┬───────────────────────────────────┘
                  seam: CapabilityTraceSink.emit(event)  [sync]
  ┌─ SupabaseTraceSink ───────────▼───────────────────────────────────┐
  │  switch(event.type) → persistMessage(...) → push to pending[]      │
  │     step          → role=assistant, content   [gated on content]  │
  │     tool_call_start→ role=tool_call, tool_calls={toolName,args}    │
  │     tool_call_end  → role=tool, tool_results={result,error,durMs}  │
  │     model_usage    → role=model_usage, model, tokens_used          │
  │     warning/error  → role=warning|error, content=message          │
  └───────────────────────────────┬───────────────────────────────────┘
              run ends → flush(): await Promise.all(pending)
  ┌─ agents.messages (Postgres) ──▼───────────────────────────────────┐
  │  conversation_id (corr key) · role · content · tool_calls ·        │
  │  tool_results · model · tokens_used · created_at (event ts)        │
  │  → select where conversation_id=$1 order by created_at = replay    │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is event sourcing (Fowler's term) narrowed to a single bounded context: one
agent run. The full pattern keeps an append-only event log as the system of
record and derives all read models from it; here the "read model" is just a
`select`, and there's no projection cache because one conversation is small.

Where it connects: the captured `durationMs` and `tokens_used` are raw material
for **performance** metrics (study-performance-engineering owns turning them into
p95 latency and token budgets). The typed events are effectively **structured
logs** (file 03 contrasts this with the repo's stdout logging). And the producer
of these events — the ReAct-style loop, the tool policy, the synthesis turn —
belongs to **study-agent-architecture**; this file only reads the events that
loop emits.

What to read next: `02-client-timestamp-ordering.md` for why `created_at` makes
replay deterministic, and the audit's lens 6 for the fallback gap in context.

## Interview defense

**Q: You persist agent events to Postgres. Why not just log the final answer?**
Because the answer alone can't explain itself. When an answer is wrong, the
question is "which passages did retrieval surface, what did the tool return, did
it error, how many tokens did it burn?" — and all of that is *cause*, not
*result*. I capture `tool_call_start.args` (the cause) right next to
`tool_call_end.result/error/durationMs` (the effect), so root-causing a bad answer
is a `select ... order by created_at`, not a re-run with print statements.

```
  the cause lives one row before the effect
  tool_call_start { args }  →  tool_call_end { result, error, durationMs }
        WHY it called             WHAT it got back + how long
```

**Q: `emit()` is synchronous but a DB insert is async. How do you not lose
writes?** I queue, I don't await. `emit()` fires the insert and pushes the promise
into a `pending[]` array; after the run, `session.ts` calls `flush()` which awaits
`Promise.all(pending)`. That respects aptkit's sync `emit` contract without
serializing the loop on DB latency. The cost I accepted: insert *completion* order
is a race, so ordering can't use `now()` — I use the event's own timestamp. The
load-bearing part people forget is `flush()`: without it the process can exit
before the tail of the trajectory lands.

```
  emit (sync) → push promise → pending[] → flush() awaits all
```

**Q: Is the capture actually complete?** Almost — and I'll name the hole, because
naming it is the point. The loop gates the `step` event behind `if (text)`, so when
the model returns empty text no step fires, yet the agent still returns a
`FALLBACK_ANSWER` the user sees. That answer-class — "it found nothing" — is the
one with no row, which is exactly the one you'd most want to debug. The fix is a
synthetic step row in `session.ts` when the answer equals the fallback sentinel.

## See also

- `02-client-timestamp-ordering.md` — why `created_at = event.timestamp` makes
  the replay in this file deterministic.
- `03-stdout-as-only-log.md` — the contrast: these typed events vs the repo's
  unstructured stdout logging.
- `04-eval-numbers-as-quality-signal.md` — the other place numbers come from.
- `audit.md` lens 5 (traces) and lens 6 (the fallback gap).
- Cross-guide: study-agent-architecture (the loop that emits these events),
  study-performance-engineering (turning `durationMs`/`tokens_used` into metrics).
