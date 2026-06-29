# Full-Signal Trajectory Test

**Industry names:** event-completeness test · trajectory / trace-capture test ·
deterministic-replay-ordering test · observability contract test. **Type:**
Project-specific (the *completeness + replay-order* contract); event-sink testing
is Industry standard.

## Zoom out, then zoom in

The agent loop emits six kinds of `CapabilityEvent` as it runs — a step, a
tool-call start, a tool-call end, a model-usage report, a warning, an error.
`SupabaseTraceSink` turns each into a row in `agents.messages`. The test asserts
**all six are captured with their full payload, and they replay in emit order** —
because the trajectory is the only record of what the agent actually did, and a
record that drops events or scrambles their order is worse than no record.

```
  Zoom out — where the trajectory test sits

  ┌─ Agent loop (aptkit) ────────────────────────────────────────┐
  │  emits: step · tool_call_start · tool_call_end · model_usage  │
  │         · warning · error                                     │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ trace.emit(event)  (sync)
  ┌─ SupabaseTraceSink (★ HERE) ──▼──────────────────────────────┐
  │  switch(event.type) → persistMessage(...) queued in `pending` │
  │  flush() awaits all queued writes                            │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
  ┌─ Postgres ────────────────────▼──────────────────────────────┐
  │  agents.messages: role · content · tool_calls · tool_results  │
  │  · model · tokens_used · created_at                          │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: this test defends two contracts at once. **Completeness** — every event
variant, including the `warning`/`error` ones that "were previously dropped on
the floor" (`supabase-trace-sink.ts:48`), reaches a row with its full payload
(args, durationMs, error, token count). **Replay order** — `created_at` is set
from the *event* timestamp, not server `now()`, so reading the rows back `order
by created_at` reproduces emit order even though the writes race. The question:
*if I read this conversation back tomorrow, do I see exactly what the agent did,
in the order it did it?*

## The structure pass

**Layers.** Agent loop → trace sink (queue) → Postgres rows.

**Axis — trace "what determines row order?" down the stack:**

```
  "what determines the order rows replay in?" — down the layers

  ┌─────────────────────────────────────────┐
  │ agent loop: emits in a definite order    │  → emit order (the truth)
  └─────────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ sink: push() queues, flush() races   │  → INSERT order is nondeterministic
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ Postgres: order by created_at    │  → event timestamp (restores truth)
          └─────────────────────────────────┘

  the middle layer SCRAMBLES order; created_at RESTORES it — that's the contract
```

**Seam.** The seam is `created_at`. The *ordering-guarantee* axis flips across
it: above it (the racing `flush`) order is lost; below it (`order by created_at`
where `created_at` came from the event) order is recovered. The test plants
explicit timestamps precisely to pin that recovery.

## How it works

#### Move 1 — the mental model

You've hit this with `Promise.all` over several `fetch`es: they resolve in
whatever order the network returns, not the order you fired them. If you need the
original order, you carry an index and sort by it afterward. The trace sink is
that exact problem — `flush()` is `Promise.all(this.pending)`
(`supabase-trace-sink.ts:91-93`), so inserts complete in race order — and the
fix is the same: carry the event timestamp into `created_at` and sort by it on
read.

```
  The completeness + ordering contract

  emit order:   tool_call → tool → model_usage → warning → error
                  │         │         │            │         │
       (each → persistMessage with createdAt = event.timestamp)
                  │         │         │            │         │
  flush races →  inserts complete in SOME order (nondeterministic)
                  │         │         │            │         │
  read back  →   order by created_at  ──restores──►  emit order
                  │
  assert:       all 6 present + full payload + order == emit order
```

The kernel: **one row per event variant + the event timestamp persisted into a
sortable column + a read that sorts by it.** Drop the timestamp-into-`created_at`
step and `created_at` defaults to `now()` (`supabase-trace-sink.ts` /
`persistMessage` `coalesce($8, now())`), so concurrent inserts get near-identical
clock times and replay order becomes the race order. Drop a `case` in the switch
and that event variant vanishes from the record.

#### Move 2 — the walkthrough

**The sync-emit / async-flush split.** `supabase-trace-sink.ts:53-93`:

```ts
emit(event: CapabilityEvent): void {        // SYNC — aptkit's contract
  switch (event.type) {
    case 'tool_call_start':
      this.push(persistMessage(pool, conversationId, 'tool_call', event.toolName, {
        toolCalls: { toolName: event.toolName, args: event.args },  // the CAUSE
        createdAt: event.timestamp,                                 // ← order key
      }));
      return;
    /* ... one case per variant ... */
  }
}
private push(p) { this.pending.push(p); }   // queue the write, don't await
async flush() { await Promise.all(this.pending); }  // drain AFTER the run
```

`emit` can't be async (aptkit calls it synchronously inside the loop), so each
write is a promise pushed onto `pending` and awaited later in `flush`. That's the
source of the ordering race — and the reason `created_at` has to carry the order.

**Test part 1 — the basic capture.** `supabase-trace-sink.test.ts:23-35` emits a
`step` and a `tool_call_end`, flushes, and asserts the `messages` table has rows
with `role` `assistant` and `tool`. Smoke-level: the sink writes *something*.

**Test part 2 — full signal + ordering (the real test).**
`supabase-trace-sink.test.ts:37-67`. It emits one of *every* variant with explicit
ISO timestamps one second apart:

```ts
sink.emit({ type:'tool_call_start', ..., args:{query:'rag'},  timestamp:'...01.000Z' });
sink.emit({ type:'tool_call_end',   ..., error:'boom', durationMs:42, timestamp:'...02.000Z' });
sink.emit({ type:'model_usage',     ..., inputTokens:100, outputTokens:23, timestamp:'...03.000Z' });
sink.emit({ type:'warning',         ..., message:'low confidence', timestamp:'...04.000Z' });
sink.emit({ type:'error',           ..., message:'tool failed',    timestamp:'...05.000Z' });
await sink.flush();
```

Then it reads back `order by created_at` and asserts the full payload survived:

```ts
// the CAUSE — tool_call_start args captured, not just the tool name
assert.deepEqual(byRole.tool_call.tool_calls, { toolName:'search_knowledge_base', args:{query:'rag'} });
// tool_call_end keeps durationMs + error (previously discarded)
assert.equal(byRole.tool.tool_results.durationMs, 42);
assert.equal(byRole.tool.tool_results.error, 'boom');
// model_usage fills the orphaned tokens_used column: 100 + 23
assert.equal(byRole.model_usage.tokens_used, 123);
// warning + error recorded at all (previously dropped)
assert.equal(byRole.warning.content, 'low confidence');
assert.equal(byRole.error.content, 'tool failed');
// THE ORDERING CONTRACT — replay order == emit order
assert.deepEqual(rows.map(r => r.role),
                 ['tool_call','tool','model_usage','warning','error']);
```

`tokens_used` summing to 123 is the nice tell — it proves the previously-orphaned
column is now populated by summing `inputTokens + outputTokens`
(`supabase-trace-sink.ts:76`). The final `deepEqual` on the role order is the
ordering contract — and it would *only* hold because each row's `created_at` came
from the planted timestamp, not from a racing `now()`.

```
  Layers-and-hops — timestamp carries order across the racing writes

  ┌─ emit (sync) ────────┐  push promise   ┌─ pending[] queue ────────────┐
  │ 5 events, ts 01..05  │ ──────────────► │ 5 unresolved writes          │
  └──────────────────────┘                 └──────────────┬───────────────┘
                                       flush: Promise.all │ (race)
                                                          ▼
  ┌─ agents.messages ────────────────────────────────────────────────────┐
  │ rows inserted in race order BUT created_at = event ts (01..05)        │
  │ → select ... order by created_at  recovers  01,02,03,04,05            │
  └──────────────────────────────────────────────────────────────────────┘
```

#### Move 3 — the principle

A trajectory record has two failure modes a naive test misses: **dropping** an
event type, and **scrambling** order under concurrent writes. This test plants
one of every type with known timestamps and asserts both completeness and replay
order — so it catches a future `case` someone deletes *and* a future change that
lets `created_at` fall back to `now()`. **When the record is the only evidence of
what happened, the test has to defend that the evidence is complete and in
order — not just that something got written.**

## Primary diagram

```
  Full-signal trajectory test — full picture

  ┌─ emit() · sync, one case per variant ────────────────────────┐
  │ step · tool_call_start · tool_call_end · model_usage ·        │
  │ warning · error    →  persistMessage(createdAt = event.ts)    │
  │                       pushed onto pending[]                    │
  └───────────────────────────────┬──────────────────────────────┘
                  flush(): Promise.all(pending)  ← writes RACE
                                  ▼
  ┌─ agents.messages ────────────────────────────────────────────┐
  │ tool_calls(args) · tool_results(durationMs,error) ·          │
  │ tokens_used(=123) · content(warning/error) · created_at      │
  └───────────────────────────────┬──────────────────────────────┘
              select ... order by created_at
                                  ▼
  ┌─ assertions ─────────────────────────────────────────────────┐
  │ COMPLETENESS: every payload field survived                    │
  │ ORDERING:     roles == [tool_call,tool,model_usage,warning,   │
  │               error]  ← only holds via event-ts created_at    │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

This is an observability contract test — it pins the shape and order of the
audit trail the agent produces. The pattern matters most where the artifact under
test *is* the debugging tool: the `agents.messages` trajectory is what you'd open
to answer "why did the agent give that answer?" If the trace silently drops
`warning`/`error` events (which it did before this change, per
`supabase-trace-sink.ts:48`), your post-mortem is missing exactly the events that
explain the failure. The deterministic-replay-order half connects directly to
`study-debugging-observability`: a trajectory you can't replay in order is a
trajectory you can't reason about. The sync-emit/async-flush split is also a
small concurrency lesson — the ordering guarantee is *recovered* at read time, not
*preserved* at write time, and the test is what proves the recovery works.

## Interview defense

**Q: Your trace writes race under `Promise.all`. How do you guarantee replay
order?** I don't preserve order at write time — I recover it at read time. `emit`
is sync (aptkit's contract), so each write is queued and `flush` drains them with
`Promise.all`, which completes in race order. The guarantee comes from persisting
the *event* timestamp into `created_at` and reading back `order by created_at`.
The test plants five events one second apart and asserts the roles replay in emit
order — which only passes because `created_at` carries the event time, not a
racing `now()`.

```
  the load-bearing part people forget:
  order is RECOVERED at read (order by created_at), not PRESERVED at write.
  drop the event-ts → created_at falls back to now() → replay order = race order
```

**Anchor:** "Sync emit, async flush, event-timestamp into `created_at` — the test
asserts both that no event type was dropped and that replay order survives the
write race."

## See also

- `audit.md` lens 4 — the timestamp-into-`created_at` move as a determinism win.
- `audit.md` lens 1 — `session.ts`'s `trace.flush()` ordering, which this sink
  feeds and which has no test.
- `study-debugging-observability` — the trajectory this test pins is the
  replay-based debugging artifact.
- `study-ai-engineering` — `model_usage` token capture as the basis for cost /
  usage evals.
