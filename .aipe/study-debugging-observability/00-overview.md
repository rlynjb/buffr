# Overview — what buffr can and can't explain about itself

The verdict first: **buffr has exactly one observability mechanism, and it's a
side effect of trajectory capture.** The `agents.messages` table — built to
remember conversation turns — doubles as the trace store. Everything else
(latency, token cost, log levels, metrics, traces, alerts, health checks) is
either thrown away at the sink or `not yet exercised`.

That's not a criticism of the phase. This is a single-device laptop brain, run
by hand from the CLI, one query at a time. There's no production, no concurrent
load, no on-call. The observability surface matches the deployment. But knowing
*which* evidence exists — and which is silently discarded — is the whole point
of this guide.

## The evidence map

Where you can observe what, at each boundary buffr crosses.

```
  buffr observability surface — what's watchable, what's blind

  ┌─ CLI layer (src/cli/*) ──────────────────────────────────────┐
  │  stdout only:  "indexed X" · the printed answer · P@1/R@3     │
  │  no log levels · no timestamps · no correlation id            │  ← 04
  └───────────────────────────┬──────────────────────────────────┘
                              │  agent.answer(question)
  ┌─ Agent loop (aptkit-core) ▼──────────────────────────────────┐
  │  emits CapabilityEvent:  step · tool_call_start ·            │
  │     tool_call_end{durationMs,timestamp} · model_usage ·      │  ← the
  │     warning · error                                          │  source
  └───────────────────────────┬──────────────────────────────────┘
                              │  trace.emit()  (sync)
  ┌─ SupabaseTraceSink ───────▼──────────────────────────────────┐
  │  keeps:  step(assistant).content · tool_call_end.toolName    │
  │  DROPS:  durationMs · timestamp · model_usage · warning ·    │  ← 02
  │          error · args · capabilityId                         │
  └───────────────────────────┬──────────────────────────────────┘
                              │  insert into messages  (no ts column set)
  ┌─ Storage (agents.messages) ▼─────────────────────────────────┐
  │  the trace store:  role · content · tool_results · model?    │  ← 01
  │  created_at = server now()  → replay order can scramble      │  ← 03
  └──────────────────────────────────────────────────────────────┘
```

## Ranked findings

**1. The `messages` table is the only trace store — and it's lossy by design.**
`SupabaseTraceSink.emit` (`src/supabase-trace-sink.ts:27-35`) handles exactly two
of the six `CapabilityEvent` types: `step` (assistant) and `tool_call_end`. The
other four — `tool_call_start`, `model_usage`, `warning`, `error` — hit the sink
and vanish. → `01`, `02`.

**2. Every latency and cost number arrives, then is discarded.** The aptkit event
contract puts `durationMs: number` on `tool_call_end` and a full `model_usage`
event (input/output tokens) on every model call
(`node_modules/@rlynjb/aptkit-core/node_modules/@aptkit/runtime/dist/src/events.d.ts`).
The sink reads `event.result` and `event.toolName` and ignores `event.durationMs`.
The `messages` schema even has a `tokens_used int` column (`sql/001_agents_schema.sql`)
that nothing ever writes. The evidence exists upstream; the sink is the leak. → `02`.

**3. Replay-by-`created_at` can scramble turn order.** The sink queues writes and
fires them with `Promise.all` in `flush()` (`src/supabase-trace-sink.ts:37-39`).
None of the inserts set a timestamp — `messages.created_at` defaults to server-side
`now()` (`sql/001_agents_schema.sql`). Concurrent flush means N inserts land at
near-identical `now()` values with no guaranteed order. The one test that exists
replays with `order by created_at` (`test/supabase-trace-sink.test.ts:31`), so the
gap is baked into how the repo reads its own traces. → `03`.

**4. `process.stdout.write` is the entire logging story.** No logger, no levels, no
structured fields, no correlation id. `index-cmd.ts:25` prints `indexed X`,
`ask-cmd.ts:37` prints the answer, `eval-cmd.ts:31` prints scores, `migrate.ts:31`
prints `migration applied`. Errors are bare `throw new Error(...)` that surface as
unhandled Node stack traces. → `04`.

**5. P@1 / R@3 are the only quality signal — and they don't measure the answer.**
`eval-cmd.ts` scores *retrieval* precision/recall against a labeled set
(`eval/queries.json`). It never runs the agent, never reads `messages`, never
scores the generated answer. It's a real signal, but for the vector store, not the
RAG output. → `05`.

## Not yet exercised

Named honestly, with when each becomes relevant:

- **Metrics / SLIs / SLOs / Prometheus** — no counters, gauges, histograms, or
  `/metrics` endpoint. Relevant the moment this runs as a long-lived service
  instead of a one-shot CLI.
- **Distributed tracing** — no spans, no trace IDs, no OpenTelemetry. The
  `capabilityId` on every event is the natural span/correlation key and is dropped
  at the sink. Relevant when more than one agent or service is in the call path.
- **Log levels / structured logs** — no `debug`/`info`/`warn`/`error`, no JSON log
  lines, no redaction. Relevant the first time you need to grep a log instead of
  re-reading the `messages` table.
- **Error tracking (Sentry et al.)** — `warning` and `error` events are emitted by
  the loop and silently dropped by the sink; nothing aggregates or alerts on them.
- **Health checks / readiness probes** — no `/healthz`, no DB-ping, no Ollama
  reachability check. A dead Ollama or Postgres surfaces only as a thrown query
  error mid-command.
- **Alerts / thresholds** — nothing watches the eval scores or latency over time;
  a P@1 regression is visible only if a human re-runs `npm run eval` and reads it.

## Reading order

`audit.md` next (the full 8-lens walk), then the pattern files `01`→`05`.
