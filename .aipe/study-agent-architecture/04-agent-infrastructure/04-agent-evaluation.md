# Agent Evaluation

*Industry names: **agent evaluation** / **trajectory evaluation** / **agent observability**.
Type label: Industry standard (the trajectory-as-unit principle is universal; buffr's 6-event
trace sink is Project-specific). Trajectory CAPTURED in buffr; trajectory NOT YET evaluated.*

## Zoom out, then zoom in

Evaluating an agent is not evaluating its answer. The answer can be right by luck — the model
guessed without searching — or wrong despite a perfect process. The unit of agent evaluation is
the **trajectory**: the full sequence of steps, tool calls, and decisions that produced the
answer. This file is about how buffr *captures* that trajectory completely, and where it stops:
it captures everything, but only *scores* retrieval precision.

```
  buffr's stack — evaluation captures what the loop did

  ┌─ Agent loop (Sections A–C) ────────────────────────────────────┐
  │  step → execute → accumulate → terminate  (emits 6 event types)│
  └──────────────────────────┬─────────────────────────────────────┘
  ┌─ ★ EVALUATION — what gets RECORDED ★ ─────────────▼────────────┐
  │  SupabaseTraceSink — persists all 6 CapabilityEvent types      │
  │  step · tool_call_start · tool_call_end · model_usage · warn · err│
  └──────────────────────────┬─────────────────────────────────────┘
  ┌─ Storage — agents.messages (timestamped, replayable) ─▼────────┐
  │  CAPTURE: complete · EVAL: only precision@k over retrieval     │
  └─────────────────────────────────────────────────────────────────┘
```

The surprising part: buffr already captures *everything you'd need* to score a trajectory — every
tool call's args, result, error, duration, and token usage, timestamped for deterministic replay —
but it doesn't yet score any of it beyond retrieval precision. The load-bearing distinction:
**capture and evaluation are two separate jobs, and buffr has done the first, not the second.**

## Structure pass

Two stages, one axis: **done vs not done** — what's captured, what's scored.

```
  Axis = DONE vs NOT DONE · trace the gap between capture and eval

  CAPTURE (done)     all 6 event types → agents.messages, timestamped   supabase-trace-sink.ts:49-94
                     args · result · error · durationMs · tokens
  ───────────────── ★ SEAM: capture exists, scoring doesn't ★ ─────────────────
  EVAL (partial)     ONLY precision@k over retrieval                     src/cli/eval-cmd.ts
  EVAL (not yet)     right tool? right order? recovered? steps/cost?     — trajectory NOT scored
```

The seam is the gap between a captured trajectory and a *scored* one. Below the seam, buffr scores
only one thing — whether retrieval returned the right chunks (precision@k, over
`eval/queries.json`). The trajectory metrics that define agent quality — did it pick the right
tool, in the right order, recover from errors, at acceptable steps and cost — are capturable from
what's already persisted, but not yet computed.

## How it works

### Move 1 — mental model

A trajectory is an append-only event log of everything the agent did, with timestamps. Bridge from
frontend: it is a structured event stream, like the network tab in dev tools — every request, its
payload, its response, its timing, in order. Evaluation is running assertions over that log. buffr
has built the network tab (complete) but hasn't written the assertions (only one, over retrieval).

```
  THE SHAPE — the trajectory is an event log; eval is assertions over it

  ┌─ CAPTURE: the event log (agents.messages) ─────────────────────┐
  │  step → tool_call_start → tool_call_end → model_usage → ...     │
  │  each row timestamped → deterministic replay order             │
  └────────────────────────────────────────────────────────────────┘
                          │ assertions run over the log
                          ▼
  ┌─ EVAL: the metrics that matter ────────────────────────────────┐
  │  precision@k   ✓ scored (retrieval only)                       │
  │  task success / tool accuracy / efficiency / recovery  ✗ not yet│
  └────────────────────────────────────────────────────────────────┘
```

### Capture: every event type is persisted, not just the answer

The loop emits typed events as it runs (`run-agent-loop.ts` calls `trace.emit(...)` at each step,
tool start, tool end, and model usage). `SupabaseTraceSink` persists *all six* into
`agents.messages` — including the things naive sinks drop: tool args (the cause of a call), errors,
durations, and token counts. Bridge from known: it's INSERTing one row per event into a DB table,
with `created_at` set from the event so replay order is exact.

```ts
// src/supabase-trace-sink.ts:49-85 — all 6 CapabilityEvent types persisted (condensed).
export class SupabaseTraceSink implements CapabilityTraceSink {
  emit(event) {
    const at = event.timestamp;                                  // event time → created_at (replay order)
    switch (event.type) {
      case 'step':                                               // 1. the assistant's reasoning text
        if (event.content) this.push(persistMessage(pool, conv, event.role, event.content, { createdAt: at }));
        return;
      case 'tool_call_start':                                    // 2. the CAUSE: which tool, what args
        this.push(persistMessage(pool, conv, 'tool_call', event.toolName,
          { toolCalls: { toolName: event.toolName, args: event.args }, createdAt: at }));
        return;
      case 'tool_call_end':                                      // 3. the EFFECT: result, error, durationMs
        this.push(persistMessage(pool, conv, 'tool', event.toolName,
          { toolResults: { result: event.result, error: event.error, durationMs: event.durationMs }, createdAt: at }));
        return;
      case 'model_usage':                                        // 4. tokens + model (the cost axis)
        this.push(persistMessage(pool, conv, 'model_usage', '',
          { model: `${event.provider}/${event.model}`, tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0), createdAt: at }));
        return;
      case 'warning':                                            // 5 + 6. warnings and errors
      case 'error':
        this.push(persistMessage(pool, conv, event.type, event.message, { createdAt: at }));
        return;
    }
  }
}
```

```
  CAPTURE — 6 event types → one replayable log

  loop emits:  step · tool_call_start · tool_call_end · model_usage · warning · error
                   │ each → persistMessage(..., createdAt = event.timestamp)
                   ▼
            agents.messages (timestamped rows)
                   │  ordered by created_at, not by flush race
                   ▼
            deterministic replay of the EXACT trajectory
```

Annotation two things. First, `created_at` is set from the *event's* timestamp, not server `now()`
(`:55, :59` etc.) — so replay order matches emit order, not the race between concurrent flush
inserts. Second, `emit` is synchronous (aptkit's contract) but the actual writes are queued and
awaited in `flush()` (`:91-93`), called once per turn from `session.ts:63`. The trajectory is
durable and ordered. That's a complete capture.

### Eval: only retrieval precision is scored — the trajectory is not

Here's the stop. buffr's *only* automated eval is precision@k over retrieval — given a labeled
query set (`eval/queries.json`), did the top-k chunks contain the expected sources? That's run by
`src/cli/eval-cmd.ts`. It scores the *retrieval*, not the *trajectory*. Whether the agent called
the right tool, in the right order, recovered from a tool error, or did it in an acceptable number
of steps — none of that is scored yet, even though every fact needed to score it is in
`agents.messages`.

```
  EVAL — what's scored vs what's capturable-but-not-scored

  SCORED (eval-cmd.ts, queries.json)
  ┌────────────────────────────────────────────────────────────────┐
  │ precision@k over retrieval: did top-k contain expected sources? │
  └────────────────────────────────────────────────────────────────┘

  CAPTURED but NOT YET SCORED (all derivable from agents.messages)
  ┌────────────────────────────────────────────────────────────────┐
  │ task success   did the final answer actually answer the Q?      │
  │ tool accuracy  right tool, right args?  (tool_call_start rows)   │
  │ trajectory eff. how many steps / tool calls / tokens? (model_usage)│
  │ recovery rate  did it recover after a tool error?  (error rows)  │
  └────────────────────────────────────────────────────────────────┘
```

Annotation: the four un-scored metrics map one-to-one onto event types already in the log. Tool
accuracy is a query over `tool_call_start` rows; trajectory efficiency is a `count` and a `sum` over
`model_usage` rows; recovery rate is "did a `step` with a real answer follow an `error` row." The
data is there. The scoring isn't. That gap is the honest state of buffr's evaluation.

### Move 3 — the principle

**Capture the trajectory before you can evaluate it, and the trajectory — not the answer — is the
unit.** An agent that returns the right answer by skipping the search is broken; an answer-only eval
can't see that, a trajectory eval can. buffr has done the hard, easy-to-skip half: it persists the
full causal log, timestamped for replay. The remaining half — assertions over that log — is cheap
*because* the capture is complete. Most teams do this backwards: they score the final answer, ship,
and only build trajectory capture after the first "right answer, wrong process" incident. buffr
built capture first.

## Primary diagram

Full recap: the 6-event capture, the replay log, and the eval gap.

```
  buffr's evaluation — capture complete, eval partial (supabase-trace-sink.ts:49-94)

  THE LOOP emits 6 event types
  ┌────────────────────────────────────────────────────────────────┐
  │ step · tool_call_start · tool_call_end · model_usage · warn · err│
  └──────────────────────────┬─────────────────────────────────────┘
  SupabaseTraceSink (:49-85) — persist ALL 6, created_at = event time
  ┌──────────────────────────▼─────────────────────────────────────┐
  │ agents.messages — timestamped, ordered, replayable             │
  │ flush() per turn (session.ts:63)                               │
  └──────────────────────────┬─────────────────────────────────────┘
                             │
        ┌────────────────────┴────────────────────┐
        ▼                                          ▼
  EVAL (done)                              EVAL (not yet)
  precision@k over retrieval               task success · tool accuracy
  (eval-cmd.ts, queries.json)              trajectory efficiency · recovery
  ─ scores RETRIEVAL ─                      ─ scores the TRAJECTORY (capturable, unscored) ─
```

Capture is complete and replayable; evaluation scores retrieval only. That's the state of the art
in this repo, named exactly.

## Elaborate

The reason capture-first is the right order: a trajectory eval you can't reproduce is worthless, and
reproduction requires the *exact* event order. buffr's choice to persist `created_at` from the event
timestamp rather than the insert time (`supabase-trace-sink.ts:55` and each case) is what makes
replay deterministic despite concurrent flush inserts. Without that, two tool calls that flushed in
a race could replay out of order and a trajectory assertion ("did it search *before* answering?")
would be unreliable. The timestamp discipline is the quiet load-bearing detail of the capture.

The multi-agent shape of evaluation is *handoff scoring*: when agent A delegates to agent B, you
evaluate not just each agent's trajectory but the *handoff* — did A pass the right task, did B
return something A could use? buffr is single-agent, so its trajectory is a single linear log with
no handoffs to score. That keeps the eval surface small: one trajectory per `answer()`, no
inter-agent edges. Name handoff scoring as the thing that appears the moment buffr grows a second
agent (Section C).

Cross-ref `study-ai-engineering` for the eval-harness mechanics — LLM-as-judge and its biases (the
likely tool for the un-scored *task success* metric), labeled-set construction, and offline-vs-online
eval. This file covers only the trajectory-as-unit angle and buffr's capture/eval gap.

## Interview defense

**Q: "How do you evaluate your agent?"**

Model answer: "I separate capture from scoring, because they're different jobs. Capture is done:
`SupabaseTraceSink` (`supabase-trace-sink.ts:49-94`) persists all six event types — step,
tool_call_start, tool_call_end, model_usage, warning, error — into `agents.messages`, with
`created_at` set from the event timestamp so the trajectory replays in exact order, not in flush-race
order. So I have the full causal log: every tool call's args, result, error, duration, and token
count. Scoring is partial: today I only score precision@k over retrieval (`eval-cmd.ts`,
`queries.json`). The trajectory metrics that actually define agent quality — task success, tool-call
accuracy, trajectory efficiency, recovery rate — aren't scored yet, but every one is derivable from
the captured log, because the unit of agent eval is the trajectory, not the answer. I built capture
first on purpose: you can't evaluate a process you didn't record."

```
  The defense in one picture

  CAPTURE (done):  6 event types, timestamped → deterministic replay
  EVAL (partial):  precision@k over retrieval  ✓
  EVAL (not yet):  tool accuracy · efficiency · recovery  — capturable, unscored
                   the unit is the TRAJECTORY, not the final answer
```

Anchor: *The unit is the trajectory, not the answer; buffr captures all 6 event types for
deterministic replay (`supabase-trace-sink.ts:49-94`) but scores only retrieval precision@k —
capture complete, trajectory eval not yet.*

## See also

- `03-tool-calling-and-mcp.md` — `callTool` records the `durationMs` that feeds trajectory efficiency.
- `05-guardrails-and-control.md` — the bounds (maxTurns, maxToolCalls) are what trajectory
  efficiency would measure against.
- `../03-multi-agent-orchestration/` — handoff scoring, the multi-agent eval surface buffr lacks.
- `study-ai-engineering` → LLM-as-judge bias, eval-harness mechanics, labeled-set construction.
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop that emits the events captured here.
