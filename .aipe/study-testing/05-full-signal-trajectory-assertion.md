# Full-signal trajectory assertion

**Industry name:** observability / trace-completeness test · synthetic-event-stream assertion. *Project-specific pattern, built on aptkit's `CapabilityEvent` contract.*

**Determinism seam:** testing (deterministic) — and this is the file where the seam *meets* its eval twin. The test wraps a deterministic harness (the trace sink) around what is in production a probabilistic core (the Gemma agent), by feeding the harness a hand-built event stream instead of running the model. Every assertion is `==`.

---

## Zoom out, then zoom in

When the agent runs, aptkit emits a stream of `CapabilityEvent`s — six types: `step`, `tool_call_start`, `tool_call_end`, `model_usage`, `warning`, `error`. The `SupabaseTraceSink` persists each into `agents.messages` so the conversation is a complete, replayable trajectory. The risk: it's easy to capture *some* events (assistant steps, tool results) and silently drop the rest (the tool-call args, the durations, the token counts, the warnings). A dropped event type is invisible until you go looking for data that was never written. This test asserts **all six types land, with their full signal, in the right order.**

```
  Zoom out — where the sink sits

  ┌─ Agent loop (aptkit, probabilistic) ─────────────────────────┐
  │  RagQueryAgent.answer() → Gemma → emits CapabilityEvent[]     │
  └───────────────────────────┬───────────────────────────────────┘
                              │ emit(event)  (sync)
  ┌─ supabase-trace-sink.ts ─▼───────────────────────────────────┐
  │  SupabaseTraceSink: switch(event.type) → persistMessage(...)  │ ← ★ under test ★
  │  pending[] queued, awaited by flush()                        │
  └───────────────────────────┬───────────────────────────────────┘
                              │ insert
  ┌─ Storage ────────────────▼───────────────────────────────────┐
  │  agents.messages (role, content, tool_calls, tool_results,    │
  │  model, tokens_used, created_at)                             │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **synthetic-event-stream assertion** — instead of running the agent to *produce* events (slow, non-deterministic), the test *constructs* one event of every type by hand and asserts the sink translates each into the right row with no field dropped. This is the deterministic-harness-over-probabilistic-core shape from the README, made concrete.

---

## The structure pass

**Layers:** (1) the agent that would emit events (replaced by the test), (2) the sink's `emit` switch, (3) `persistMessage`'s column mapping, (4) `agents.messages`.

**Axis traced — *what signal survives each layer?*** The agent layer carries the full event (args, durations, tokens, timestamps). The sink's `switch` decides which fields to forward per type. `persistMessage` maps them to columns. The storage layer is the final record. The question "does the full signal survive?" is answered at the sink's `switch` — that's where fields get kept or dropped.

**The seam:** the `CapabilityEvent` → `messages` boundary in `emit`. It's load-bearing because it's a *lossy translation* — six event shapes collapse into one row shape. The test exists to prove the translation is lossless for the fields that matter, and to pin the second flip: emit order vs persisted order. Concurrent flush inserts could race, so the sink threads the event timestamp into `created_at` to make replay order deterministic — and the test asserts exactly that.

---

## How it works

### Move 1 — the mental model

Think of a request logger that's supposed to capture method, path, status, *and* latency — but someone wired it to log only method and path. Everything looks fine until you need latency for a p99 dashboard and discover it was never written. This test is the guard against that: it feeds the logger one of everything and checks every field came through.

```
  The trajectory-completeness kernel

   for each of the 6 event types:
        emit(synthetic event with all fields set)
                    │
                    ▼
        persistMessage → row in agents.messages
                    │
                    ▼
   assert: every field that mattered is in the row
   assert: the rows come back in EMIT order (created_at)
```

### Move 2 — the walkthrough

**Emit one synthetic event of every type.** No agent, no Gemma — the test hand-builds the stream with explicit timestamps so order is controllable.

```ts
// test/supabase-trace-sink.test.ts:41-46
sink.emit({ type: 'tool_call_start', toolName: 'search_knowledge_base', args: { query: 'rag' }, timestamp: '2026-06-20T00:00:01.000Z', … });
sink.emit({ type: 'tool_call_end',   toolName: 'search_knowledge_base', result: { results: [] }, error: 'boom', durationMs: 42, timestamp: '…:02.000Z', … });
sink.emit({ type: 'model_usage',     provider: 'gemma', model: 'gemma2:9b', inputTokens: 100, outputTokens: 23, timestamp: '…:03.000Z', … });
sink.emit({ type: 'warning',         message: 'low confidence', timestamp: '…:04.000Z', … });
sink.emit({ type: 'error',           message: 'tool failed',    timestamp: '…:05.000Z', … });
await sink.flush();
```

The timestamps are spaced one second apart and deliberately *out of insert-race order* — they're the controlled variable that makes the ordering assertion meaningful. `flush()` awaits the queued inserts (the sink's `emit` is sync per aptkit's contract; writes are queued in `pending[]` and awaited later — `supabase-trace-sink.ts:50,87-93`).

**Assert each type kept its full signal — the fields that were previously dropped.** This is the heart of the test: it doesn't just check "a row exists," it checks the *lossy* fields survived.

```ts
// test/supabase-trace-sink.test.ts:51-63
const byRole = Object.fromEntries(rows.map((r) => [r.role, r]));

assert.deepEqual(byRole.tool_call.tool_calls, { toolName: 'search_knowledge_base', args: { query: 'rag' } }); // the CAUSE
assert.equal(byRole.tool.tool_results.durationMs, 42);    // duration kept
assert.equal(byRole.tool.tool_results.error, 'boom');     // error kept
assert.equal(byRole.model_usage.tokens_used, 123);        // 100 + 23, the orphaned column filled
assert.match(byRole.model_usage.model, /gemma2:9b/);      // model recorded
assert.equal(byRole.warning.content, 'low confidence');   // warning recorded at all
assert.equal(byRole.error.content, 'tool failed');        // error recorded at all
```

Each assertion maps to a field the sink could have dropped and a `persistMessage` mapping that keeps it:
- **`tool_calls` = the tool-call args** — the *cause* of a tool invocation. `emit`'s `tool_call_start` case stores `{ toolName, args }` (`supabase-trace-sink.ts:62-65`). Without this, you'd see a tool ran but not *why*.
- **`durationMs` + `error` on `tool_call_end`** — latency and failure of the tool. Previously discarded; now in `tool_results` (`supabase-trace-sink.ts:67-71`).
- **`tokens_used = 123`** — `inputTokens + outputTokens` summed in the `model_usage` case (`supabase-trace-sink.ts:73-78`), filling the otherwise-orphaned `tokens_used` column. The `123` is the deterministic proof the sum happened.
- **`warning` / `error` content** — events that were dropped entirely before; the test asserts they're recorded at all (`supabase-trace-sink.ts:80-83`).

**Assert replay order matches emit order via `created_at`.** The last assertion is the determinism guard:

```ts
// test/supabase-trace-sink.test.ts:64-66
const order = rows.map((r) => r.role);
assert.deepEqual(order, ['tool_call', 'tool', 'model_usage', 'warning', 'error']);
```

The query orders by `created_at` (`supabase-trace-sink.test.ts:48-50`). Because the sink writes each event's *own* timestamp into `created_at` (`persistMessage` coalesces the event timestamp, falling back to `now()` only when empty — `supabase-trace-sink.ts:26,30`), the rows come back in emit order regardless of which concurrent insert committed first. This converts a latent flake (insert race) into a deterministic assertion. **This is the load-bearing part people forget:** the timestamp isn't cosmetic — it's what makes the trajectory *replayable in order*.

```
  Execution trace — emit order vs commit order vs query order

  emit order:    tool_call_start, tool_call_end, model_usage, warning, error
  timestamps:    :01            :02            :03          :04      :05
  commit race:   (any order — concurrent inserts via Promise.all in flush)
  created_at:    :01            :02            :03          :04      :05   ← pinned to event ts
  query order by created_at:  tool_call, tool, model_usage, warning, error  ✓ == emit order
```

### Move 3 — the principle

A trace that drops a field is worse than no trace, because it lies by omission — you trust the record until the one time you need the missing field. The completeness test is the antidote: feed the recorder one of everything and assert nothing fell on the floor. And the ordering half generalizes past this repo — any system that records events asynchronously and replays them must derive order from the *event's* logical time, not the *write's* physical time, or the replay reorders under concurrency. Pinning `created_at` to the event timestamp, and asserting it, is that principle made testable.

---

## Primary diagram

```
  Full-signal trajectory assertion — full picture

  ┌─ test: synthetic event stream (no Gemma) ──────────────────────┐
  │  emit × 6 types, timestamps :01…:05, all fields set            │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ SupabaseTraceSink.emit → persistMessage
  ┌─ agents.messages ───────────▼─────────────────────────────────┐
  │  role            content        kept signal                    │
  │  tool_call       toolName       tool_calls={toolName,args}      │ ← cause
  │  tool            toolName       tool_results={durationMs,error} │ ← latency+failure
  │  model_usage     ''             tokens_used=123, model=gemma…   │ ← orphaned col filled
  │  warning         'low conf…'    (recorded at all)               │
  │  error           'tool failed'  (recorded at all)               │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ order by created_at (= event ts)
  ┌─ assert ─────────────────────▼─────────────────────────────────┐
  │  every field present  +  replay order == emit order            │
  └─────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is where the testing guide touches `study-debugging-observability`: the trace sink is the production *observability* mechanism (it's how you'd debug a bad agent turn after the fact), and this test is the guarantee that the observability is *complete*. The two guides describe the same file — one asks "does it record everything?" (here), the other asks "what do you do with the recording?" (there).

It also touches `study-ai-engineering`, the *other* side of the determinism seam. The agent that emits these events is probabilistic — you can't assert what Gemma *says*. But the trajectory *structure* around it (every event type, every field, the order) is fully deterministic and is asserted exactly here. The eval guide picks up where this stops: judging the *content* of the model's output, not the completeness of the record. This file is the clean example of "deterministic harness, probabilistic core" the whole README is built on.

---

## Interview defense

**Q: Why feed synthetic events instead of running the agent?**
Because the agent is non-deterministic — it calls Gemma, and I can't assert on what Gemma produces. But the sink's job is deterministic: translate each event type into the right row with no field dropped. So I replace the probabilistic source with a hand-built stream of one event per type, and assert the translation exactly. That's a deterministic harness around a probabilistic core — I test the part I can pin and hand the model-output-quality question to the eval suite.

```
  the seam, made testable

  probabilistic:  Gemma → events   (can't assert content → eval)
  deterministic:  events → rows     (can assert every field → THIS test)
                  ↑ replace the source with synthetic events, keep the sink real
```

*Anchor:* "Synthetic events let me assert the sink deterministically without depending on what Gemma says."

**Q: What's the load-bearing part people forget?**
The `created_at`-from-event-timestamp. The inserts happen concurrently inside `flush()` via `Promise.all`, so physical commit order is a race. If `created_at` defaulted to `now()`, replay order would be non-deterministic and the trajectory would reorder under load. Threading the event's own timestamp into `created_at` — and asserting the queried order equals the emit order — is what makes the trajectory replayable. It's the easiest field to treat as cosmetic and the one that breaks replay if you do.

*Anchor:* "created_at is the event's timestamp, not now() — that's what makes the trajectory replay in order under concurrent inserts."

---

## See also

- `01-env-gated-integration-tests.md` — this test is DATABASE_URL-gated; it writes real rows.
- `audit.md` lens 6 — the AI-testing seam this pattern is the clean example of.
- `study-debugging-observability` — the same trace sink as a production observability mechanism.
- `study-ai-engineering` — the eval side of the seam: judging Gemma's output, which this test deliberately doesn't.
- `00-overview.md` gap 1 — `session.ts` calls `trace.flush()`; that the flush *happens* per turn is itself untested.
