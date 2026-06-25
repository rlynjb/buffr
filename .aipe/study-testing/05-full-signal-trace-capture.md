# Full-Signal Trace Capture

**Industry names:** event-sink contract test · "assert the whole payload, not
just that a row landed" · trace completeness test. **Type:** Industry standard
(the `CapabilityEvent` union and `agents.messages` columns are project-specific).

---

## Zoom out, then zoom in

The agent loop in aptkit fires a stream of `CapabilityEvent`s as it runs — an
assistant step, a tool call starting, a tool call ending, token usage, a
warning, an error. `SupabaseTraceSink` is the thing that turns that stream into
durable rows in `agents.messages`. The first version of the sink only kept two
of those event types and dropped the rest on the floor; this test grew to pin
that *every* variant — and its *full payload* — survives the trip to Postgres.

```
  Zoom out — where the trace sink sits

  ┌─ Agent loop (aptkit) ───────────────────────────────────┐
  │  RagQueryAgent.answer() ──fires──► CapabilityEvent stream │
  └────────────────────────────┬────────────────────────────┘
                               │  sink.emit(event)  (sync)
  ┌─ Trace sink (buffr) ───────▼────────────────────────────┐
  │  SupabaseTraceSink.emit → switch(event.type)             │ ← we are here
  │  → persistMessage(...) queued, awaited by flush()        │
  └────────────────────────────┬────────────────────────────┘
                               │  insert into agents.messages
  ┌─ Storage (real Postgres) ──▼────────────────────────────┐
  │  rows: role · content · tool_calls · tool_results ·      │
  │        model · tokens_used · created_at                  │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **contract test over a fan-out sink** — emit one of
every input event, flush, then read every output column back and assert the
payload made it through intact. It's the inverse of the happy-path test that
only checks "a row exists": this checks "the *right* row exists, with the
*right* fields, in the *right* order."

---

## Structure pass

One sink, two `it`s, one axis: **signal — how much of each event survives
emit → flush → row?**

```
  Axis: "what of the event reaches the row?" — across the two tests

  ┌─ it #1 (lines 23-35) ────────┐
  │  emit step + tool_call_end    │   → asserts ROLES only:
  │  read role column             │     'assistant' + 'tool' present
  └──────────────┬────────────────┘     (existence, not payload)
       seam: persistMessage's column mapping  ← signal widens here
  ┌──────────────▼────────────────┐
  │  it #2 (lines 37-67)          │   → asserts FULL PAYLOAD of all 6
  │  emit one of every event type │     event types: args, durationMs,
  │  read every column            │     error, tokens_used, model,
  │                               │     warning/error content, ordering
  └────────────────────────────────┘
```

The seam is `persistMessage`'s column mapping (`supabase-trace-sink.ts:27-36`).
The first test stands just past it and checks roles landed; the second stands
much further back and checks the *whole* event survived the mapping. The axis —
how much signal — flips from "a row exists" to "every field of the row is
correct." That widening is the whole point of the new test.

---

## How it works

### Move 1 — the mental model

You know how you'd test a serializer not by checking "it returned a string" but
by round-tripping a fully-populated object through it and asserting every field
came back? Same move. The sink is a serializer from `CapabilityEvent` to a
`messages` row. You hand it one of every event variant, flush, and read every
column back to prove nothing was silently dropped.

```
  Emit one of every type → flush → read every column back

  emit:  tool_call_start ─┐
         tool_call_end   ─┤
         model_usage     ─┼─► flush() ─► insert × 5 ─► agents.messages
         warning         ─┤
         error           ─┘                              │
                                                         ▼
  read:  role, content, tool_calls, tool_results, model, tokens_used, created_at
         └────────── assert each field, not just rowCount ──────────┘
```

### Move 2 — the walkthrough

**Emit one of every event variant.** The test (`supabase-trace-sink.test.ts:41-45`)
fires a `tool_call_start` (with `args`), a `tool_call_end` (with `result`,
`error`, `durationMs`), a `model_usage` (with input/output tokens, provider,
model), a `warning`, and an `error`. Each carries a distinct ISO timestamp
(`...:01` through `...:05`) — that's deliberate, and load-bearing for the
ordering assertion below.

```
  The five events, each carrying a different slice of signal

  tool_call_start  → args            (the CAUSE of a tool call)
  tool_call_end    → durationMs, error (the COST + failure of it)
  model_usage      → input+output tokens, model
  warning          → message
  error            → message
```

**Read every column, key the rows by role.** After `flush()`, the test selects
all seven payload columns and builds `byRole` — a lookup from the role string to
its row (`supabase-trace-sink.test.ts:48-51`). This lets each assertion address
one event's row by name instead of by array index.

**Assert the cause: tool args survive.** `byRole.tool_call.tool_calls` must
deep-equal `{ toolName, args: { query: 'rag' } }`
(`supabase-trace-sink.test.ts:54`). Before the fix, `tool_call_start` was
dropped entirely — you knew a tool *ran* but not what it was *asked*. This pins
the cause back into the trajectory.

**Assert the cost: durationMs + error survive.** `byRole.tool.tool_results`
must keep `durationMs: 42` and `error: 'boom'`
(`supabase-trace-sink.test.ts:56-57`). The old sink kept only the result and
threw away timing and failure — so a slow or failed tool call left no trace. Now
both are in the row.

**Assert the orphaned column gets filled: tokens_used.** `model_usage` sums
`inputTokens + outputTokens` (100 + 23) into `tokens_used`, asserted as `123`,
and records the model string matching `/gemma2:9b/`
(`supabase-trace-sink.test.ts:59-60`). `tokens_used` existed in the schema but
nothing ever wrote it — this is the column going from decoration to data.

**Assert the previously-dropped events land at all: warning + error.** Their
`content` must be `'low confidence'` and `'tool failed'`
(`supabase-trace-sink.test.ts:62-63`). Before, these event types hit no `case`
and vanished; now they're rows you can read.

**Assert replay order via created_at.** The rows, ordered by `created_at`, must
come back in emit order: `['tool_call', 'tool', 'model_usage', 'warning',
'error']` (`supabase-trace-sink.test.ts:65-66`). This is why each event carried
a distinct timestamp — the sink persists `created_at` from the *event's*
timestamp, not `now()`, so the trajectory replays in the order it happened
rather than in the race order of concurrent flush inserts.

```
  Why event-timestamp beats now() for ordering

  created_at = now()              created_at = event.timestamp
  ──────────────────              ────────────────────────────
  order = flush-insert race       order = emit order (deterministic)
  replay can scramble turns       replay matches what happened
  → assertion could flip          → assertion is stable
```

**The skeleton — what breaks without each part:**

- **One emit per event variant.** Drop any and that event type's row mapping
  goes unverified — a future refactor could silently stop persisting it.
- **Reading every column, not just `role`.** This is the whole upgrade over
  it #1. Drop it and you're back to "a row exists," blind to dropped fields.
  **Load-bearing for the completeness claim.**
- **Distinct per-event timestamps + the ordering assert.** Remove them and the
  `created_at`-drives-replay-order guarantee is untested; the sink could revert
  to `now()` and nothing notices.
- **Keying rows by role.** Hardening — makes each assertion legible. You could
  index by array position instead, but the named lookup is what keeps the test
  readable as it grew to seven assertions.

### Move 3 — the principle

A sink's contract isn't "it wrote something" — it's "it preserved the signal."
Test it by pushing a fully-populated instance of every input variant through and
reading every output field back. The bug class this catches is the quiet one: an
event type or a field that stops being persisted, leaving a trajectory that
*looks* complete (rows exist) but has lost the cause, the cost, or the order.
Existence tests can't see that; payload tests can.

---

## Primary diagram

The full picture — every event variant in, every column out, ordering pinned.

```
  Full-signal trace capture — emit all types, assert all columns

  ┌─ Test (supabase-trace-sink.test.ts:37-67) ─────────────────┐
  │  emit tool_call_start { args }            ts ...:01         │
  │  emit tool_call_end   { result, error, durationMs } ...:02 │
  │  emit model_usage     { inputTokens, outputTokens } ...:03 │
  │  emit warning         { message }         ts ...:04         │
  │  emit error           { message }         ts ...:05         │
  │  await flush()                                              │
  └──────────────────────────┬─────────────────────────────────┘
                             │  Promise.all(pending) → inserts
  ┌─ SupabaseTraceSink.emit (supabase-trace-sink.ts:53-84) ────┐
  │  switch(type): maps each variant → persistMessage columns  │
  └──────────────────────────┬─────────────────────────────────┘
                             │  insert into agents.messages
  ┌─ Storage (real Postgres) ▼─────────────────────────────────┐
  │  read role, content, tool_calls, tool_results, model,      │
  │       tokens_used, created_at                              │
  │  ◄ assert: args=={query:'rag'} · durationMs==42 · error    │
  │    =='boom' · tokens_used==123 · model~/gemma2:9b/ ·       │
  │    warning/error content · order==[tool_call,tool,         │
  │    model_usage,warning,error]                              │
  └──────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Reached for once, in `supabase-trace-sink.test.ts`, to pin the
sink's completeness after it was fixed to stop dropping events. The sink it
tests is the production trace capture wired into every chat turn
(`session.ts:56-57`, `session.ts:63` flushes it). When a real `RagQueryAgent`
run fires these events, this test is the guarantee they all reach
`agents.messages` intact.

The emit-one-of-each + read-every-column body, annotated:

```
  test/supabase-trace-sink.test.ts  (lines 41-66)

  sink.emit({ type: 'tool_call_start', ..., args: { query: 'rag' }, ts:01 });
  sink.emit({ type: 'tool_call_end',   ..., error: 'boom', durationMs: 42, ts:02 });
  sink.emit({ type: 'model_usage',     inputTokens: 100, outputTokens: 23, ts:03 });
  sink.emit({ type: 'warning', message: 'low confidence', ts:04 });
  sink.emit({ type: 'error',   message: 'tool failed',   ts:05 });
  await sink.flush();                          ← drains queued inserts

  const { rows } = await pool.query(
    `select role, content, tool_calls, tool_results, model, tokens_used,
            created_at from agents.messages where conversation_id = $1
     order by created_at`, [conversationId]);   ← every column, ordered
  const byRole = Object.fromEntries(rows.map((r) => [r.role, r]));

  byRole.tool_call.tool_calls   == { toolName, args: { query: 'rag' } }  ← cause
  byRole.tool.tool_results.durationMs == 42                              ← cost
  byRole.tool.tool_results.error      == 'boom'                          ← failure
  byRole.model_usage.tokens_used      == 123   (100 + 23)                ← orphan col filled
  byRole.model_usage.model            ~ /gemma2:9b/
  byRole.warning.content == 'low confidence'   byRole.error.content == 'tool failed'
  order == ['tool_call','tool','model_usage','warning','error']          ← replay order
```

The sink mapping these assertions pin:

```
  src/supabase-trace-sink.ts  (lines 56-84)

  case 'tool_call_start':                       ← was MISSING before the fix
    persistMessage(..., 'tool_call', toolName,
      { toolCalls: { toolName, args }, createdAt: at });   ← captures the cause
  case 'tool_call_end':
    persistMessage(..., 'tool', toolName,
      { toolResults: { result, error, durationMs }, ... }); ← error + duration kept
  case 'model_usage':
    persistMessage(..., 'model_usage', '',
      { tokensUsed: (inputTokens ?? 0) + (outputTokens ?? 0), ... }); ← fills the column
  case 'warning': case 'error':                 ← were DROPPED before the fix
    persistMessage(..., event.type, event.message, { createdAt: at });
```

And the `created_at` plumbing that makes ordering deterministic:

```
  src/supabase-trace-sink.ts  (lines 26, 30)

  const createdAt = extra?.createdAt && extra.createdAt.length > 0
    ? extra.createdAt : null;                   ← event ts when present...
  values (..., coalesce($8::timestamptz, now())) ← ...else fall back to now()
       │
       └─ the test passes distinct event timestamps so the order-by is
          deterministic; without persisting event.timestamp, replay order
          would be the race order of concurrent inserts (load-bearing)
```

---

## Elaborate

This is a contract test over an event sink — the same instinct as testing a
logger by asserting every field of a structured log line survives, or testing a
serializer by round-tripping a fully-populated object. The bug it defends
against is specific and was *real* here: the first sink kept only
`step+assistant` and `tool_call_end.result`, so token usage, tool args, timing,
failures, and warning/error events all vanished. The `tokens_used` column sat
unwritten — schema present, data absent. The fix widened the sink; this test is
what stops a future refactor from quietly re-narrowing it.

Why it earns a pattern file: strip it out and the suite stops catching *dropped
signal* — an event type or payload field silently no longer persisted. A
trajectory with missing causes or scrambled order looks fine to an
existence-only test (the rows are there) but is useless for debugging or replay.
That's a concrete, nameable class of regression, which is the bar for a Pass-2
pattern. → the trajectory itself is the observability surface; see
`.aipe/study-debugging-observability/`.

What it does NOT cover, named honestly: the *negative* filter. A `step` with
empty content is dropped (`supabase-trace-sink.ts:58`), but no test emits one
and asserts zero rows. The drop is `not yet exercised` → see `audit.md` lens 5.

---

## Interview defense

**Q: You already had a test asserting the assistant and tool rows land. Why add
a second one?**

Because the first only checks *existence* — that a row with the right `role`
exists. It's blind to dropped *fields*. The sink had been silently throwing away
tool args, timing, token usage, and warning/error events — the rows existed but
the payload was gutted. The second test emits one of every event variant and
reads every column back, so it catches a field going missing, not just a row.

```
  existence test               full-signal test
  ──────────────               ────────────────
  assert role IN rows          assert every column of every event
  passes if payload gutted     fails if any field is dropped
  "a tool ran"                 "the tool ran with THESE args, took
                               42ms, and failed with 'boom'"
```

**Anchor:** "Assert the whole payload of every event variant, not just that a
row landed."

**Q: Why give each emitted event a distinct timestamp?**

To pin replay order. The sink persists `created_at` from the *event's*
timestamp, not `now()`. With distinct timestamps the `order by created_at`
assertion is deterministic and proves the trajectory replays in emit order —
not the race order of concurrent flush inserts. Same-timestamp events would make
that assertion meaningless.

**Anchor:** "Event timestamp drives created_at, so replay order is emit order,
not insert-race order."

---

## Validate

1. **Reconstruct:** Name the six `CapabilityEvent` variants the sink handles and
   the `messages` column each one fills.
   (`supabase-trace-sink.ts:56-83`: step→content, tool_call_start→tool_calls,
   tool_call_end→tool_results, model_usage→tokens_used+model,
   warning/error→content.)
2. **Explain:** Why does `model_usage` assert `tokens_used == 123` rather than
   100 or 23? (The sink sums `inputTokens + outputTokens`,
   `supabase-trace-sink.ts:76`.)
3. **Apply:** A new `retry` event variant is added to the agent loop. What's the
   minimum to keep this test honest? (A `case 'retry'` in the sink + an emit and
   a payload assertion in the test.)
4. **Defend:** Someone says "the existence test is enough, the payload test is
   redundant." Argue the cost. (The existence test passes even when every field
   but `role` is dropped; the payload test is the only thing pinning that token
   usage, tool args, timing, and ordering survive.)

---

## See also

- `audit.md` — lens 5 (full-signal capture, now covered; the empty-`step` drop
  still uncovered), lens 6 (the agent seam whose run produces these events).
- `02-fake-embedder-injection.md` — the other half of the agent seam; a fake
  `ModelProvider` would let `session.ts` produce these events under test.
- `01-env-gated-integration-tests.md` — this test runs only when the gate opens.
- `.aipe/study-debugging-observability/` — the trajectory in `agents.messages`
  as the observability surface this test guards.

---

Updated: 2026-06-24 — new Pass-2 pattern file: the trace sink grew a second `it`
asserting all 6 `CapabilityEvent` types and full payloads (tool args, durationMs
+ error, tokens_used sum, warning/error rows, created_at replay ordering).
