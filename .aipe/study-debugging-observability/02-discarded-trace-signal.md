# Full-signal trajectory capture

**Industry names:** complete telemetry / lossless instrumentation / capturing the
whole event stream. **Type:** Project-specific (the rich-source / faithful-sink shape).

> Updated: 2026-06-24 — reframed from a bug ("the sink drops durationMs / tokens /
> warning / error") to the fix. The sink was rewritten on 2026-06-24 to persist all
> six `CapabilityEvent` types; the signal that used to vanish is now in the database.
> History of the original gap is kept below so the lesson survives.

## Zoom out, then zoom in

You know how a `fetch()` response has a body *and* headers — and if your code only
reads `res.json()` and never looks at `res.status` or timing, you've thrown away half
the evidence the response handed you? buffr's sink used to do exactly that. The agent
loop hands it six event types carrying latency, token cost, warnings, and errors, and
the old sink read two fields off two of them and dropped the rest on the floor. The
current sink reads all six. This file walks what good looks like when the source is
rich and the sink keeps faith with it — and notes the one real gap this used to be.

```
  Zoom out — where the signal is preserved

  ┌─ Agent loop (aptkit-core) ───────────────────────────────────┐
  │  emits 6 event types, each rich:                             │
  │    step / tool_call_start{args} / tool_call_end{durationMs}  │
  │    model_usage{inputTokens,outputTokens} / warning / error   │
  └───────────────────────────┬──────────────────────────────────┘
                              │ emit()  (sync)
  ┌─ SupabaseTraceSink ───────▼──────────────────────────────────┐
  │  ★ THE FAITHFUL HOP ★  switch over event.type, one row each  │ ← we are here
  │  keeps args · durationMs · error · tokens · warning · error  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ insert (tool_calls, tool_results, tokens_used set)
  ┌─ agents.messages ─────────▼──────────────────────────────────┐
  │  tokens_used column now filled by model_usage rows           │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **lossless instrumentation** — every property the source
emits survives the recording boundary into a queryable row. This matters because the
diagnosis the data enables is only as complete as the recording, and dropping a field
is invisible (nothing errors when you drop an event; the row just isn't there). The
sink's discipline is to default to recording everything and let the *reader* narrow.

## Structure pass

**Layers.** Source (the loop, emits everything) → sink (records faithfully) → store
(holds what was recorded). Same three layers as `01`, viewed through a different axis.

**Axis — trace `is the evidence available here?` down the layers.**

```
  "is durationMs available?" — traced downward

  ┌────────────────────────────────────┐
  │ loop: emits tool_call_end.durationMs│   → AVAILABLE (typed, populated)
  └──────────────────┬──────────────────┘
        ┌─────────────────────────────────┐
        │ sink: writes it into tool_results│   → RECORDED (tool_call_end branch)
        └─────────────┬───────────────────┘
              ┌──────────────────────────┐
              │ store: tool_results jsonb │   → DURABLE (queryable later)
        └──────────────────────────┘

  available → recorded → durable.  the chain holds at every hop now.
```

**Seam.** Same seam as `01` (loop → sink), read for a different property. In `01` the
seam decides *which events* become rows. Here it decides *which fields* of those
events survive — and the answer is now "all of them." The axis no longer flips at the
sink: completeness is guaranteed upstream *and* preserved downstream. The whole point
of this file is that the seam is no longer the leak.

## How it works

### Move 1 — the mental model

The shape is a **type-dispatched faithful projection at a recording boundary** — a
`switch` on `event.type` that builds one row per event, carrying that event's payload
into the columns that fit it.

```
  the dispatch — wide event in, full row out

  tool_call_end {
    toolName,        ──► content
    result,          ──┐
    error,           ──┤──► tool_results jsonb { result, error, durationMs }
    durationMs,      ──┘
    timestamp,       ──► created_at
  }
```

The kernel: for each event the sink builds a row whose columns carry that event's
distinguishing payload, then stamps `created_at` from the event's own `timestamp`.
What breaks if a branch is too narrow: every property you didn't read becomes a
question you can't answer later, with no error to warn you it happened. The old sink
*was* that narrow; the rewrite is what removed the gap.

### Move 2 — the walkthrough

**`durationMs` — the latency you can now recover.** The aptkit `tool_call_end` event
is typed with `durationMs: number` (non-optional). The loop populates it from the
actual tool execution and emits it. The sink's `tool_call_end` branch now writes it
into the `tool_results` jsonb alongside `result` and `error`.

```
  durationMs path — full life, now preserved

  callTool() ──► { result, durationMs: 312 }
                    │
  loop emits ──► tool_call_end { toolName, result, durationMs: 312, timestamp }
                    │
  sink reads ──► persistMessage(..., 'tool', toolName,
                   { toolResults: { result, error, durationMs: 312 } })
                    │
  store ──────► messages row, tool_results.durationMs = 312
```

Boundary condition: it lands in the `tool_results` jsonb, not a dedicated
`duration_ms` column — so you query it as `tool_results->>'durationMs'`, and you can't
build a SQL histogram off an indexed numeric column without promoting it. That's the
residual shape: the evidence is *captured* but not yet *first-class*. → cross-link
`../study-performance-engineering/` for what you'd do with the histogram once you
promoted it.

**`model_usage` — the cost you now count.** Every model call emits a `model_usage`
event with `inputTokens` / `outputTokens`. The sink now has a branch for it: it writes
a `model_usage`-role row, fills `model` with `provider/model`, and sets `tokens_used`
to the summed input+output. The previously-orphaned `tokens_used int` column is now
written on every run.

```
  the column, now connected

  schema:   messages.tokens_used int      ← built for this
  event:    model_usage { inputTokens, outputTokens }  ← carries this
  sink:     case 'model_usage': tokensUsed = in + out  ← connects the two
  result:   tokens_used is populated, one row per model call
```

**`warning` / `error` — the failures that now leave a trace.** This was the
highest-stakes drop. The loop emits a `warning` event (e.g. when a turn budget is hit)
and can emit `error`. The sink now handles both: each writes a row whose `role` is the
event type and whose `content` is the event message. So a tool that throws, a model
that warns, a recovery turn — all produce a durable row. The `messages` table no
longer shows a clean run when one wasn't.

```
  the failure that now records

  tool throws ──► loop emits error{message}            ← signal exists
                    │
  sink ──────────► case 'error': row{role:'error', content:message}  ← signal kept
                    │
  store ─────────► an 'error' row;  the run looks failed in the trace, correctly
```

Boundary condition that used to make this worse than "no logging": the run *looked
fine* in the store because absence of an error row was indistinguishable from a clean
run — a false-negative observability state, the most dangerous kind. That false
negative is now closed: a failed run has an `error` row.

**`tool_call_start` — the cause, now captured.** The old sink had no branch for
`tool_call_start`, so the *search query* sent to the tool was never stored — you saw
the effect (the tool result) but never the cause (the args). The new branch writes a
`tool_call`-role row with `tool_calls = { toolName, args }`. The query that drove the
retrieval is now in the trace. → `01` walks why the cause matters for replay.

### Move 2.5 — current state vs future state

This is now shipped, so the comparison is history-vs-now plus the small residual.

```
  Phase A (before 2026-06-24)        Phase B (now)
  ─────────────────────────────      ─────────────
  sink: 2 branches, 2 fields         sink: switch, all 6 event types
  drops 4 event types                records args, durationMs, error,
  messages: timing/cost null               tokens, warning, error
  errors invisible (false negative)  messages: tokens_used set; error row on failure

  what did NOT change: the loop, the event contract, the CLI surface.
  the source always emitted everything. only the sink's emit() and the
  messages schema (tool_calls + tokens_used columns) changed.

  residual: durationMs/tokens live in jsonb, not first-class numeric columns,
  so there's no indexed histogram yet — captured, not yet metric-shaped.
```

### Move 3 — the principle

Instrumentation loss at the recording boundary is invisible by construction — nothing
throws when you drop an event, so the gap only shows up the day you go looking for
evidence that was never written. buffr learned this the expensive way: the original
sink discarded latency, cost, and failures, and the cost was paid in the future by
whoever debugged. The principle the fix encodes: *when the source is already rich (as
aptkit's event stream is), default to recording everything and narrow at read time —
because narrowing at write time means the evidence is gone before you knew you'd want
it.* The cheap part is that the data already arrives; the discipline is keeping it.

## Primary diagram

Every event type and what it now writes, in one frame.

```
  the full-signal map — 6 event types, all recorded

  ┌─ Agent loop emits ───────────────────────────────────────────────┐
  │  step{role,content}     ──► <role> row  (content)            ✓    │
  │  tool_call_start{args}  ──► tool_call row (tool_calls=args)  ✓    │
  │  tool_call_end{                                                   │
  │     toolName, result    ──► tool row     (tool_results)      ✓    │
  │     error, durationMs   ──► (in tool_results jsonb)          ✓    │
  │     timestamp           ──► created_at                      ✓    │
  │  }                                                                │
  │  model_usage{tokens}    ──► model_usage row (tokens_used)    ✓    │
  │  warning{message}       ──► warning row  (content)          ✓    │
  │  error{message}         ──► error row    (content)          ✓    │
  └───────────────────────────┬──────────────────────────────────────┘
                              ▼
  ┌─ agents.messages ─────────────────────────────────────────────────┐
  │  role · content · tool_calls · tool_results · model · tokens_used │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached on every `chat` turn — the sink processes the whole event
stream and writes one row per event into the held conversation (`src/session.ts:63`
flushes after each `ask`). The payoff surfaces when you `psql` into `messages` to
answer "why slow / how much / what failed" and the columns are populated.

**The six-branch switch — `src/supabase-trace-sink.ts:53-85`.**

```
  src/supabase-trace-sink.ts  (lines 55–84)

  const at = event.timestamp;
  switch (event.type) {
    case 'step':                                         ← role from the event,
      if (event.content) persist(event.role, event.content, {createdAt: at});  not hardcoded
    case 'tool_call_start':
      persist('tool_call', toolName,
        { toolCalls: { toolName, args: event.args }, createdAt: at });  ← the CAUSE
    case 'tool_call_end':
      persist('tool', toolName,
        { toolResults: { result, error, durationMs }, ... });  ← latency + error kept
    case 'model_usage':
      persist('model_usage', '',
        { model: `${provider}/${model}`, tokensUsed: in + out, ... });  ← fills column
    case 'warning': case 'error':
      persist(event.type, event.message, { createdAt: at });  ← failures recorded
  }
       │
       └─ every variant of the union has a branch. nothing falls through to a
          silent drop. this switch is the whole fix.
```

**The row writer that carries the new fields — `src/supabase-trace-sink.ts:19-37`.**

```
  src/supabase-trace-sink.ts  (lines 27–36)

  insert into agents.messages
    (conversation_id, role, content, tool_calls, tool_results, model,
     tokens_used, created_at)
    values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now()))
       │
       └─ tool_calls + tokens_used are in the column list now (they weren't before).
          created_at takes $8 = event.timestamp, falling back to now() only when the
          event timestamp is empty — that fallback is the residual ordering risk, see 03.
```

**The event contract that proves the data exists —
`@aptkit/runtime/dist/src/events.d.ts:1-40`.**

```
  node_modules/.../@aptkit/runtime/dist/src/events.d.ts

  | { type: 'tool_call_end'; toolName; result?; error?;
      durationMs: number;       ← non-optional. always populated. now recorded.
      timestamp: string; }      ← ISO event time → created_at now.
  | { type: 'model_usage'; inputTokens?; outputTokens?; provider; model; ... }  ← now handled
       │
       └─ the receipt: the evidence is typed, required, arriving — and now the sink
          keeps it. the loop was always honest; the sink finally matches it.
```

**The schema that now has somewhere for it to go — `sql/001_agents_schema.sql:40-50`.**

```
  sql/001_agents_schema.sql  (agents.messages)

  tool_calls    jsonb,      ← added: holds tool_call_start args
  tool_results  jsonb,      ← holds result + error + durationMs
  tokens_used   int,        ← model_usage now writes it (was always null before)
       │
       └─ durationMs and tokens live inside jsonb / a generic int — captured, but
          not promoted to indexed numeric columns. that's the next rung, not a gap.
```

**The test that proves the capture — `test/supabase-trace-sink.test.ts:37-67`.** The
second test (`captures the full event signal`) emits one of every event type, then
asserts the args are in `tool_calls`, `durationMs` (42) and `error` ('boom') survive in
`tool_results`, `tokens_used` is the summed 123, `warning`/`error` content is stored,
*and* the replay order matches emit order via event-timestamp ordering. The test that
once encoded the gap now encodes the contract.

## Elaborate

This is the classic gap between "instrumented" and "observable," and buffr now sits on
the right side of it. aptkit instrumented the loop properly — a complete, typed event
stream with timing and cost. For a while buffr was observable only to the degree its
sink chose to record, and that choice was made for memory, not diagnostics (see `01`).
The rewrite made the sink faithful: it records everything the loop emits. The residual
honesty: `durationMs` and `tokens_used` are captured but not metric-shaped (no
histogram, no Prometheus, no OTel — `not yet exercised`, see `00-overview.md`). What to
read next: `../study-performance-engineering/` (the latency histogram `durationMs`
would feed once promoted), `03` (the event timestamps this sink now persists are what
fixed the ordering gap), and `01` (the captured `tool_call_start` args complete the
replayable trajectory).

## Interview defense

**Q: Your traces had no latency data. Where was it lost, and how did you fix it?**
At the sink — and that was the good news, because the fix was cheap. aptkit's
`tool_call_end` event carries a non-optional `durationMs`, populated from the real tool
execution. The old sink's branch read `toolName` and `result` and never touched
`durationMs`, which was sitting in the same event object. I rewrote `emit` as a switch
over all six event types and now write `durationMs`, `error`, and `result` together
into the `tool_results` jsonb. The data was never the problem; the recording was, and
that's now fixed.

```
  available ──► recorded ──► durable
   (loop)        (sink)       (store)
                   ▲
            the fix lived here — one branch per event type
```

**Q: What was the most dangerous thing your sink used to drop, and is it fixed?**
The `error` and `warning` events. A failed tool call emits an `error` event the old
sink had no branch for, so a run that hit an error looked *identical in the store* to a
clean run — a false negative, worse than no logging, because it told you "everything's
fine" when it wasn't. The new sink writes an `error`-role row with the message, so a
failed run now has a record. The false-negative state is closed.

## Validate

1. **Reconstruct.** List the six `CapabilityEvent` types and the row each one now
   writes. (`events.d.ts:1-40`; sink switch at `src/supabase-trace-sink.ts:56-84`.)
2. **Explain.** The `messages.tokens_used` column used to be always null. What fills it
   now, and where? (`model_usage` event → `case 'model_usage'`,
   `src/supabase-trace-sink.ts:73-78`, summing input+output tokens.)
3. **Apply.** A `chat` turn is slow. Name every place latency evidence now lives and the
   exact line that records it. (`tool_call_end.durationMs` → `tool_results.durationMs`,
   written at `src/supabase-trace-sink.ts:68-71`; queryable as `tool_results->>'durationMs'`.)
4. **Defend.** The data is captured but `durationMs`/`tokens_used` live in jsonb / a
   generic int. Argue whether to promote them to first-class numeric columns now or
   wait. (Wait until you need an indexed histogram / SLO; capture-first, promote-on-need
   — see `audit.md` R3 and `../study-performance-engineering/`.)

## See also

- `01-trajectory-capture-as-observability.md` — the full set of rows the sink now writes.
- `03-created-at-replay-ordering-gap.md` — the event timestamps this sink persists are
  what fixed the ordering gap (and the residual same-ms tie).
- `05-eval-numbers-as-quality-signal.md` — the other signal that exists but is shallow.
- `../study-performance-engineering/` — the latency budget `durationMs` would serve once promoted.
- `../study-testing/` — the test that emits all six events and asserts each survives.
