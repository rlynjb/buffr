# Full-Signal Trajectory Capture

**Industry name(s):** agent trajectory / execution-trace logging, "full-fidelity event capture" — *Project-specific* implementation of an *Industry-standard* pattern.

The repo's strongest observability investment: the trace / structured event stream (`CapabilityEvent` → `agents.messages`) persists *every* event the agent loop emits — not just the answer, but the cause, the result, the timing, and the token cost.

---

## Zoom out, then zoom in

Here's the whole thing. You know how a browser's Network tab shows you every request, not just the final rendered page — the URL that went out, the status that came back, the timing bar? This is that, for an agent turn. Each turn produces a stream of events; this pattern catches all of them and writes one database row per event.

```
  Zoom out — where trajectory capture lives

  ┌─ CLI layer (src/cli/chat.tsx) ──────────────────────────────┐
  │  Ink UI → session.ask(question)                             │
  └────────────────────────────────┬─────────────────────────────┘
                                    │  one turn
  ┌─ Session layer (src/session.ts) ──────▼─────────────────────┐
  │  agent.answer() ── emits ──►  ★ trace.emit() per event ★    │ ← we are here
  │                  then         trace.flush()                  │
  └────────────────────────────────┬─────────────────────────────┘
            CapabilityEvent ×6      │  (6 variants)
  ┌─ Sink (src/supabase-trace-sink.ts) ───▼─────────────────────┐
  │  SupabaseTraceSink.emit() → persistMessage() → INSERT       │
  └────────────────────────────────┬─────────────────────────────┘
                                    │
  ┌─ Storage (agents.messages) ────▼────────────────────────────┐
  │  one row per event — the replayable trajectory              │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The question this pattern answers: *when a turn goes wrong, can I reconstruct exactly what the agent did — including why it called a tool and what came back?* The pattern is **capture every event variant, not just the visible output**. The comment on the sink names the stakes directly: tool-call args (the cause), `durationMs` + error, and token usage "were previously dropped on the floor" (`src/supabase-trace-sink.ts:39-48`). Catching them is what turns a log into a trajectory.

## The structure pass

Before the mechanics, the skeleton. Three layers, one axis traced across them, the seam where the axis flips.

**Layers:** the agent loop (emits events) → the sink (`SupabaseTraceSink`) → the storage table (`agents.messages`).

**Axis — "who owns the event's shape?"** Trace it down:

```
  One question down the layers: who owns the event's shape?

  ┌──────────────────────────────────────────────┐
  │ agent loop (@rlynjb/aptkit-core)             │  → APTKIT owns it
  │   defines the 6 CapabilityEvent variants      │    (typed contract)
  └───────────────────────┬───────────────────────┘
       seam: trace.emit()  │  ═══ the contract boundary ═══
  ┌───────────────────────▼───────────────────────┐
  │ SupabaseTraceSink (src/supabase-trace-sink.ts)│  → BUFFR owns it
  │   maps each variant → a messages row           │    (the translation)
  └───────────────────────┬───────────────────────┘
  ┌───────────────────────▼───────────────────────┐
  │ agents.messages (sql/001_agents_schema.sql)   │  → POSTGRES owns it
  │   columns: role, tool_calls, tool_results, …   │    (the durable form)
  └────────────────────────────────────────────────┘
```

**The seam that matters: `trace.emit()`.** This is the vertical contract between aptkit (which *produces* events in a shape it controls) and buffr (which *consumes* them into a schema it controls). The axis flips here — above the seam the event is an in-memory typed union; below it, it's a row. Everything load-bearing about this pattern is buffr's job *below* the seam: deciding which fields of each variant survive into which columns. That's where you study it.

## How it works

#### Move 1 — the mental model

You've written a `switch` on a discriminated union before — `switch (action.type)` in a reducer, one `case` per action shape, each pulling different fields off the payload. That's exactly this. `CapabilityEvent` is a tagged union with six tags; `emit()` is the reducer that fans each tag out to a row with the right columns filled.

```
  The shape — fan-out by event type

                      emit(event)
                          │
        ┌─────────┬───────┼───────┬────────────┬─────────┐
        ▼         ▼       ▼        ▼            ▼         ▼
      step    tool_call  tool   model_usage  warning   error
        │      _start    _end      │            │         │
   content   args=     result+   tokens+     message   message
   → assistant the      error+    model       → warning → error
     row      CAUSE     durationMs row          row       row
              row       =EFFECT row
        └─────────┴───────┴────────┴────────────┴─────────┘
                          │
                  persistMessage() → INSERT into agents.messages
```

The point the diagram makes: six tags, six row shapes, and the two that carry the diagnostic weight are `tool_call_start` (the **cause** — the args) and `tool_call_end` (the **effect** — result, error, and how long it took). A logger that keeps only `step` and `tool_call_end` answers "what did the agent do" but not "why" — you'd see a tool returned junk but not what you asked it. Keeping `args` is what makes the trajectory debuggable.

#### Move 2 — the step-by-step walkthrough

**The `emit()` dispatch.** `emit()` is synchronous because that's aptkit's contract — the agent loop can't `await` a trace write mid-step. So buffr's sink doesn't write inline; it *queues* the promise and awaits the batch later via `flush()`. Here's the dispatch and the two load-bearing cases, from `src/supabase-trace-sink.ts:53-72`:

```
  src/supabase-trace-sink.ts:53   emit(event: CapabilityEvent): void {
  :54     const at = event.timestamp;        // ← client timestamp, see 02-
  :56     switch (event.type) {
  :57       case 'step':
  :58         if (event.content)             // ← empty steps skipped (note the gap!)
  :59           this.push(persistMessage(…, event.role, event.content, {createdAt: at}));
  :62       case 'tool_call_start':          // ── THE CAUSE ──
  :63         this.push(persistMessage(…, 'tool_call', event.toolName, {
  :64           toolCalls: { toolName: event.toolName, args: event.args }, createdAt: at,
  :65         }));
  :67       case 'tool_call_end':            // ── THE EFFECT ──
  :68         this.push(persistMessage(…, 'tool', event.toolName, {
  :69           toolResults: { result: event.result, error: event.error,
  :70                          durationMs: event.durationMs }, createdAt: at,
  :71         }));
```

Read the two cases together. `tool_call_start` (`:62-66`) writes `args` into the `tool_calls` jsonb column — that's the input you handed the tool. `tool_call_end` (`:67-72`) writes `result`, `error`, *and* `durationMs` into `tool_results`. Put the two rows side by side for the same `toolName` and you have a complete call record: what went in, what came out, whether it failed, how long it took. That's the trajectory.

**Why queue-then-flush.** `push()` (`:87-89`) just appends the insert promise to `this.pending`; `flush()` (`:91-93`) does `Promise.all(this.pending)`. The session calls it once after the run (`src/session.ts:62-63`):

```
  src/session.ts:61   const answer = await agent.answer(question);
  :62                 await trace.flush();      // ← all queued inserts settle here
```

The boundary condition: because `flush()` races all the inserts in parallel, **insertion order does not equal emit order**. The pattern survives that race only because each row carries its own `created_at = event.timestamp` — replay sorts by the timestamp, not by which insert landed first. That's a whole pattern on its own → `02-client-timestamp-ordering.md`.

**The model-usage and warning/error cases.** `model_usage` (`:73-78`) fills the otherwise-orphaned `tokens_used` column by summing `inputTokens + outputTokens`, and stamps `model` as `provider/model`. `warning` and `error` (`:80-83`) share one case — each lands as a row tagged with its own `role`. Nothing is dropped on the floor.

#### Move 2 variant — the load-bearing skeleton

The irreducible kernel of this pattern, the part you'd reconstruct from memory:

1. **A sink that implements the trace contract** (`CapabilityTraceSink`) — without it the agent loop has nowhere to emit. (`src/supabase-trace-sink.ts:49`)
2. **A total switch over every event variant** — drop a `case` and that event type silently vanishes from the trajectory. The `step` case's `if (event.content)` guard (`:58`) is exactly this failure in miniature: empty-content steps are *intentionally* dropped, which is why the FALLBACK_ANSWER turn (empty synthesis) leaves no row.
3. **The cause/effect pair** — `args` on start, `result`/`error` on end. Drop `args` and you can see *that* a tool failed but never *why* you called it.
4. **A correlation key** — `conversationId`, threaded through every `persistMessage`. Drop it and the rows are an undifferentiated heap; you can't reconstruct a single turn.

Optional hardening layered on top: `durationMs` (latency attribution — nice, not load-bearing for correctness), `tokens_used` (cost tracking), the queue/flush batching (a throughput optimization over inserting inline).

#### Move 3 — the principle

Capture the **cause alongside the effect**, or your trace can only narrate, not explain. A log that records "tool returned X" tells you what happened; one that also records "because you called it with args Y" tells you why — and "why" is what every debugging session is actually after. The general rule: an observable boundary is only as good as the *inputs* it records, not just the outputs.

## Primary diagram

The full recap — one turn, every event, every row.

```
  One turn → the full trajectory in agents.messages

  Session (src/session.ts)                     Storage (agents.messages)
  ────────────────────────                     ─────────────────────────
  persistMessage('user', q) ─────────────────► row: role=user, content=q

  agent.answer(q)
    │  emits CapabilityEvents
    ▼
  SupabaseTraceSink.emit():
    tool_call_start  ──► push ──┐
    tool_call_end    ──► push   │  queued
    model_usage      ──► push   │  (sync emit,
    step (assistant) ──► push ──┘   no await)
    │
  trace.flush() ── Promise.all ──────────────► rows (each created_at =
                                                event.timestamp):
                                                 role=tool_call  (args)
                                                 role=tool       (result/error/ms)
                                                 role=model_usage(tokens/model)
                                                 role=assistant  (the answer)

  replay:  SELECT … WHERE conversation_id=$1 ORDER BY created_at
           → the trajectory, in emit order
```

## Elaborate

This pattern is the agent-era descendant of structured request logging. The classic version logs one line per HTTP request with method, path, status, latency. The agent version logs one *event* per reasoning step because a single user turn isn't one request — it's a small program the LLM writes at runtime (call this tool, read the result, call again, synthesize). You can't reconstruct that program from a single log line, so you capture the whole event stream.

The deliberate design choice worth calling out: buffr persists the trajectory into the *same* table it uses for conversation content (`agents.messages`), not a separate `traces` table. That's why `role` carries values like `tool_call`, `tool`, and `model_usage` alongside `user`/`assistant` — the trajectory and the conversation are the same artifact, queried the same way. The cost: the table mixes "what the user sees" with "how the agent got there," so any UI replay has to filter by `role`. The benefit: one correlation key, one query, no join.

Where it connects: `study-agent-architecture` owns the loop that *produces* these events (`run-agent-loop`, `RagQueryAgent`); this file owns the sink that *persists* them. `study-performance-engineering` reads `durationMs` as a latency budget; here it's just a trace field.

## Interview defense

**Q: Your agent calls a tool and gets a wrong answer. Walk me through debugging it with your trace.**

```
  the cause/effect pair is the whole answer

  tool_call row  ──►  tool row
   args = {q:…}        result = {…}, error = null, durationMs = 240
      │                   │
      └─── compare ───────┘
      "I asked X, it returned Y" — root cause in two rows
```

Pull the turn by `conversation_id`, sort by `created_at`. Find the `tool_call` row — its `tool_calls.args` is exactly what I handed the tool. Find the matching `tool` row — `tool_results.result` is what came back, `error` tells me if it threw, `durationMs` if it was slow. The bug is whichever side is wrong: bad `args` means the agent reasoned wrong; bad `result` with good `args` means the tool's the problem. **Anchor:** the cause/effect pair at `src/supabase-trace-sink.ts:62-72`.

**Q: What's the one thing this trace gets wrong?**

The FALLBACK_ANSWER gap. The `step` case skips empty content (`:58`), and `RagQueryAgent` returns its fallback string *without emitting a step* (aptkit `rag-query-agent.js:51`) — so an empty-synthesis turn shows the user "I couldn't find anything" but leaves no assistant row in the table. The trace says the agent answered nothing; the user got an answer. That's the load-bearing part people miss: full-signal capture is only as full as the loop's willingness to emit. **Anchor:** `if (event.content)` at `src/supabase-trace-sink.ts:58`.

## See also

- `02-client-timestamp-ordering.md` — why `created_at` carries the event timestamp, and the tie it leaves.
- `03-stdout-as-only-log.md` — what observability looks like *outside* this table.
- `audit.md` lens 5 (traces) and lens 6 (state snapshots).
- Cross-guide: `study-agent-architecture` (the emitting loop), `study-performance-engineering` (`durationMs` as a budget).
