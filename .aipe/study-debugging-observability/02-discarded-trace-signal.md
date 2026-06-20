# Discarded trace signal

**Industry names:** dropped telemetry / lossy instrumentation / the observability
leak. **Type:** Project-specific (the rich-source / lossy-sink shape).

## Zoom out, then zoom in

You know how a `fetch()` response has a body *and* headers — and if your code only
reads `res.json()` and never looks at `res.status` or timing, you've thrown away
half the evidence the response handed you? That's what buffr's sink does. The agent
loop hands it six event types carrying latency, token cost, warnings, and errors.
The sink reads two fields off two of them and drops the rest on the floor.

```
  Zoom out — where the signal is lost

  ┌─ Agent loop (aptkit-core) ───────────────────────────────────┐
  │  emits 6 event types, each rich:                             │
  │    tool_call_end { durationMs, timestamp }                   │
  │    model_usage   { inputTokens, outputTokens }               │
  │    warning / error { message }                               │
  └───────────────────────────┬──────────────────────────────────┘
                              │ emit()
  ┌─ SupabaseTraceSink ───────▼──────────────────────────────────┐
  │  ★ THE LEAK ★  keeps step.content + tool_end.{name,result}   │ ← we are here
  │  drops durationMs · timestamp · tokens · warning · error     │
  └───────────────────────────┬──────────────────────────────────┘
                              │ insert (timing/cost columns left null)
  ┌─ agents.messages ─────────▼──────────────────────────────────┐
  │  tokens_used column exists, always null                      │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **lossy instrumentation** — the evidence exists upstream and
is destroyed at the recording boundary, not at the source. This matters because the
fix is cheap (the data already arrives) and the diagnosis is invisible (nothing
errors when you drop an event; the row just isn't there).

## Structure pass

**Layers.** Source (the loop, emits everything) → sink (selects) → store (holds what
survived). Same three layers as `01`, viewed through a different axis.

**Axis — trace `is the evidence available here?` down the layers.**

```
  "is durationMs available?" — traced downward

  ┌────────────────────────────────────┐
  │ loop: emits tool_call_end.durationMs│   → AVAILABLE (typed, populated)
  └──────────────────┬──────────────────┘
        ┌─────────────────────────────────┐
        │ sink: reads .toolName, .result  │   → DISCARDED (no branch reads it)
        └─────────────┬───────────────────┘
              ┌──────────────────────────┐
              │ store: no durationMs col  │   → GONE (unrecoverable)
        └──────────────────────────┘

  available → discarded → gone.  the loss is total and it's at the sink.
```

**Seam.** Same seam as `01` (loop → sink), read for a different property. In `01` the
seam decides *which events* become rows. Here it decides *which fields* of those
events survive — and for `tool_call_end`, the answer is "name and result, nothing
else." The `durationMs` on that very event is right there in the same object and
never read.

## How it works

### Move 1 — the mental model

The shape is a **field-narrowing projection at a recording boundary** — a `SELECT`
that picks two columns from a six-column feed and silently discards the other four.

```
  the projection — wide event in, narrow row out

  tool_call_end {
    toolName,        ──┐
    result,          ──┤──► row { content: toolName, tool_results: result }
    durationMs,      ──┐
    timestamp,       ──┤──► (dropped)
    error,           ──┤
    capabilityId,    ──┘
  }
```

The kernel: for each event the sink *does* handle, it reads a fixed subset of fields.
What breaks if the subset is too narrow: every property you didn't read becomes a
question you can't answer later, with no error to warn you it happened.

### Move 2 — the walkthrough

**`durationMs` — the latency you can't recover.** The aptkit `tool_call_end` event is
typed with `durationMs: number` (non-optional). The loop populates it from the actual
tool execution (`tools.callTool` returns `{ result, durationMs }`) and emits it. The
sink's `tool_call_end` branch reads `event.toolName` and `event.result` and stops.

```
  durationMs path — full life and death

  callTool() ──► { result, durationMs: 312 }
                    │
  loop emits ──► tool_call_end { toolName, result, durationMs: 312, timestamp }
                    │
  sink reads ──► persistMessage(..., 'tool', toolName, { toolResults: result })
                    │                                    └─ 312 not passed
  store ──────► messages row with no timing field
```

Boundary condition: there's nowhere for it to *go* even if the sink read it.
`messages` has no `duration_ms` column. So recovering latency is a two-part fix —
read the field *and* add the column. → cross-link `../study-performance-engineering/`
for what you'd do with the histogram once you had it.

**`model_usage` — the cost you never count.** Every model call emits a `model_usage`
event with `inputTokens` / `outputTokens`. The sink has *no branch* for
`model_usage` at all — it falls through both `if`s and returns. Meanwhile the schema
*has* a `tokens_used int` column sitting empty on every row. The schema designer
anticipated cost tracking; the sink never wired it up.

```
  the orphaned column

  schema:   messages.tokens_used int      ← built for this
  event:    model_usage { inputTokens, outputTokens }  ← carries this
  sink:     (no branch)                    ← never connects the two
  result:   tokens_used is null forever
```

**`warning` / `error` — the failures that leave no trace.** This is the highest-stakes
drop. The loop emits a `warning` event (e.g. when a turn budget is hit) and can emit
`error`. The sink handles neither. So a tool that throws, a model that refuses, a
recovery turn that fires — all produce events that vanish. The `messages` table, your
only durable record, shows a clean run.

```
  the silent failure

  tool throws ──► loop catches, emits error{message}   ← signal exists
                    │
  sink ──────────► (no branch for 'error')             ← signal dropped
                    │
  store ─────────► no error row;  run looks successful in the trace
```

Boundary condition that makes this worse than "no logging": the run *looks fine* in
the store. Absence of an error row is indistinguishable from a clean run. That's a
false-negative observability state — the most dangerous kind.

### Move 2.5 — current state vs future state

This is built-but-incomplete, so the comparison is the lesson: the gap is small
because the source is already rich.

```
  Phase A (now)                    Phase B (the cheap fix)
  ─────────────                    ──────────────────────
  sink: 2 branches, 2 fields       sink: 6 branches, read durationMs +
  drops 4 event types                    tokens + error message
  messages: timing/cost null       messages: + duration_ms, tokens_used set,
  errors invisible                          + an 'error' role row

  what does NOT change: the loop, the event contract, the CLI.
  the source already emits everything. only the sink's emit() and a
  migration change. that's the whole migration cost.
```

### Move 3 — the principle

Instrumentation loss at the recording boundary is invisible by construction —
nothing throws when you drop an event, so the gap only shows up the day you go
looking for evidence that was never written. The principle: *the cost of lossy
instrumentation is paid in the future, by whoever's debugging, and it's unbudgeted.*
When the source is already rich (as aptkit's event stream is), the discipline is to
default to recording everything and narrow later — because narrowing first means the
evidence is gone before you knew you'd want it.

## Primary diagram

Every dropped signal in one frame.

```
  the discarded-signal map — 6 event types, what survives

  ┌─ Agent loop emits ───────────────────────────────────────────────┐
  │  step{role,content}     ──► assistant row   (content only)    ✓   │
  │  tool_call_start{args}  ──► (dropped)        ✗  ← lose the query  │
  │  tool_call_end{                                                   │
  │     toolName, result    ──► tool row         ✓                    │
  │     durationMs          ──► (dropped)        ✗  ← lose latency    │
  │     timestamp           ──► (dropped)        ✗  ← lose event time │
  │  }                                                                │
  │  model_usage{tokens}    ──► (dropped)        ✗  ← lose cost       │
  │  warning{message}       ──► (dropped)        ✗  ← lose warnings   │
  │  error{message}         ──► (dropped)        ✗  ← lose failures   │
  └───────────────────────────┬──────────────────────────────────────┘
                              ▼
  ┌─ agents.messages ─────────────────────────────────────────────────┐
  │  role · content · tool_results · model · [tokens_used: null]      │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached for (or rather, *not* reached for) on every `ask` run — the
drops happen every time the sink processes the event stream. The cost surfaces when
you try to answer "why slow / how much / what failed" from stored evidence and find
the columns empty.

**The two-branch sink — `src/supabase-trace-sink.ts:27-35`.**

```
  src/supabase-trace-sink.ts  (lines 27–35)

  if (event.type === 'step' && event.role === 'assistant' && event.content) {
      this.pending.push(persistMessage(pool, conversationId, 'assistant', event.content));
  } else if (event.type === 'tool_call_end') {
      this.pending.push(
        persistMessage(pool, conversationId, 'tool', event.toolName,
          { toolResults: event.result }));   ← event.durationMs in scope, never read
  }
  // no else: model_usage, warning, error, tool_call_start all fall through
       │
       └─ the durationMs is one property access away (event.durationMs) and the
          branch reads everything around it except that. the leak is right here.
```

**The event contract that proves the data exists —
`@aptkit/runtime/dist/src/events.d.ts`.**

```
  node_modules/.../@aptkit/runtime/dist/src/events.d.ts

  | { type: 'tool_call_end'; toolName; result?; error?;
      durationMs: number;       ← non-optional. always populated.
      timestamp: string; }      ← ISO event time. also dropped.
  | { type: 'model_usage'; inputTokens?; outputTokens?; ... }   ← never handled
       │
       └─ this is the receipt: the evidence is typed, required, and arriving.
          the sink is the only reason it isn't in the database.
```

**The orphaned column — `sql/001_agents_schema.sql`.**

```
  sql/001_agents_schema.sql  (agents.messages)

  model         text,
  tokens_used   int,        ← built for model_usage; nothing ever writes it
       │
       └─ the schema author saw cost tracking coming. the sink never met it
          halfway. an empty column is a documented intention, unfulfilled.
```

**The test that quietly confirms the drop — `test/supabase-trace-sink.test.ts:27`.**
The test *passes* `durationMs: 5` into the sink, then asserts only that an `assistant`
and a `tool` role exist — never that the duration was stored, because it can't be.
The test encodes the gap: it feeds the field and verifies its absence is acceptable.

## Elaborate

This is the classic gap between "instrumented" and "observable." aptkit instrumented
the loop properly — it emits a complete, typed event stream with timing and cost.
buffr is observable only to the degree its sink chose to record, and that choice was
made for memory, not diagnostics (see `01`). The fix is the smallest kind of change:
add branches, add columns. The reason it's worth a whole file is that lossy
instrumentation is the single most common observability failure in real systems —
the telemetry exists, someone just never wired the last hop. What to read next:
`../study-performance-engineering/` (the latency histogram `durationMs` would feed),
and `03` (even the timestamps that *are* dropped here would have fixed the ordering
bug there).

## Interview defense

**Q: Your traces have no latency data. Where exactly is it lost — the agent, the
sink, or the schema?**
All the way at the sink, and that's the good news — it means the fix is cheap.
aptkit's `tool_call_end` event carries a non-optional `durationMs`, populated from
the real tool execution. My sink's `tool_call_end` branch reads `toolName` and
`result` and never touches `durationMs`, which is sitting in the same event object.
The schema also lacks the column, so it's a two-line fix: read the field, add the
column. The data was never the problem; the recording was.

```
  available ──► discarded ──► gone
   (loop)        (sink)       (store)
                   ▲
            the fix lives here, one property access
```

**Q: What's the most dangerous thing your sink drops, and why is it worse than no
logging at all?**
The `error` and `warning` events. A failed tool call emits an `error` event that my
sink has no branch for, so the run that hit an error looks *identical in the store* to
a clean run — there's no error row, and absence of a row is indistinguishable from
success. That's a false negative, which is worse than no logging: no logging tells you
"I don't know"; this tells you "everything's fine" when it wasn't.

## Validate

1. **Reconstruct.** List the six `CapabilityEvent` types and mark which the sink
   records. (`events.d.ts`; sink at `src/supabase-trace-sink.ts:27-35` records `step`
   + `tool_call_end`.)
2. **Explain.** The `messages.tokens_used` column is always null. Trace why, naming
   the event that would fill it and the missing branch. (`model_usage`; no sink
   branch.)
3. **Apply.** An `ask` run is slow. Name every place latency evidence exists in the
   pipeline and the exact line where it's destroyed.
   (`tool_call_end.durationMs`; destroyed at `src/supabase-trace-sink.ts:31-33` by
   omission.)
4. **Defend.** Argue whether the fix belongs in the sink, the schema, or both — and
   what you'd record *first* if you could only add one branch. (Both; record `error`
   first — false-negative failures are the highest-consequence drop, see `audit.md` R1.)

## See also

- `01-trajectory-capture-as-observability.md` — the two event types that *do* survive.
- `03-created-at-replay-ordering-gap.md` — the dropped `timestamp` would have fixed it.
- `05-eval-numbers-as-quality-signal.md` — the other signal that exists but is shallow.
- `../study-performance-engineering/` — the latency budget `durationMs` would serve.
- `../study-testing/` — the test that feeds `durationMs` and verifies its absence.
