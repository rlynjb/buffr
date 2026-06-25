# Overview — what buffr can and can't explain about itself

> Updated: 2026-06-24 — the sink was rewritten to persist all six `CapabilityEvent`
> types and to stamp `created_at` from `event.timestamp`. The verdict, the evidence map,
> and the ranked findings below are updated: latency, token cost, tool args, warnings,
> and errors are now captured (not discarded), and replay order is sound for the common
> case. The `ask` command is gone — replaced by `npm run chat` over `session.ts`.

The verdict first: **buffr has exactly one observability mechanism, and it's a
side effect of trajectory capture — but as of 2026-06-24 that mechanism is
full-signal.** The `agents.messages` table — built to remember conversation turns —
doubles as the trace store, and the sink now records every event the agent loop emits:
latency, token cost, tool args, warnings, and errors all land in rows. What's still
`not yet exercised` is the *operational tooling* on top: metrics/SLOs, distributed
tracing, structured logs/levels, error tracking, health checks, alerts.

That's not a criticism of the phase. This is a single-device laptop brain, run
by hand from the CLI, one query at a time. There's no production, no concurrent
load, no on-call. The observability surface matches the deployment. The 2026-06-24
work closed the gap between "instrumented" (the loop) and "recorded" (the store);
what's left is the gap between "recorded" and "aggregated/alertable," which the phase
doesn't yet need.

## The evidence map

Where you can observe what, at each boundary buffr crosses.

```
  buffr observability surface — what's watchable, what's blind

  ┌─ CLI/TUI layer (src/cli/*) ──────────────────────────────────┐
  │  stdout (index/eval/migrate) · Ink render (chat)             │
  │  no log levels · no timestamps · no capabilityId             │  ← 04
  └───────────────────────────┬──────────────────────────────────┘
                              │  session.ask(question)
  ┌─ Agent loop (aptkit-core) ▼──────────────────────────────────┐
  │  emits CapabilityEvent:  step · tool_call_start ·            │
  │     tool_call_end{durationMs,timestamp} · model_usage ·      │  ← the
  │     warning · error                                          │  source
  └───────────────────────────┬──────────────────────────────────┘
                              │  trace.emit()  (sync)
  ┌─ SupabaseTraceSink ───────▼──────────────────────────────────┐
  │  KEEPS ALL 6:  step.content · tool_call_start.args ·         │
  │     tool_call_end{result,error,durationMs} ·                │  ← 02
  │     model_usage{tokens} · warning · error · event.timestamp │
  │  still drops: capabilityId (no column)                      │
  └───────────────────────────┬──────────────────────────────────┘
                              │  insert into messages (created_at = event.timestamp)
  ┌─ Storage (agents.messages) ▼─────────────────────────────────┐
  │  trace store: role·content·tool_calls·tool_results·model·    │  ← 01
  │     tokens_used·created_at                                   │
  │  created_at = event.timestamp → replay = emit order          │  ← 03
  │  residual: same-ms ties undefined (no seq column)            │
  └──────────────────────────────────────────────────────────────┘
```

## Ranked findings

**1. The `messages` table is the only trace store — and as of 2026-06-24 it's
full-signal.** `SupabaseTraceSink.emit` (`src/supabase-trace-sink.ts:56-84`) now
switches over all six `CapabilityEvent` types and writes one row each: `step`,
`tool_call_start` (args), `tool_call_end` (result/error/durationMs), `model_usage`
(tokens), `warning`, `error`. Nothing falls through to a silent drop. → `01`, `02`.

**2. Every latency and cost number is now captured.** The aptkit event contract puts
`durationMs: number` on `tool_call_end` and a full `model_usage` event (input/output
tokens) on every model call (`@aptkit/runtime/dist/src/events.d.ts`). The sink writes
`durationMs` (and `error`) into `tool_results` (`:68-71`) and sums tokens into the
`tokens_used` column (`:73-78`) — the column that used to sit empty is filled on every
model call. The remaining limit is shape, not loss: these live in jsonb / a generic int
with no histogram or rollup. → `02`, `../study-performance-engineering/`.

**3. Replay-by-`created_at` now reflects emit order.** The sink stamps each row's
`created_at` from `event.timestamp` (`src/supabase-trace-sink.ts:54-55`, insert
`coalesce($8::timestamptz, now())` at `:26-30`), so the concurrent `Promise.all` flush
(`:91-93`) no longer decides order — the sort key is fixed at emit, upstream of the
insert race. The test asserts replay order equals emit order
(`test/supabase-trace-sink.test.ts:64-66`). Residual: same-millisecond ties (or empty
timestamps falling back to `now()`) are undefined, with no `seq` tiebreaker yet. → `03`.

**4. `process.stdout.write` / Ink render is the entire logging story.** No logger, no
levels, no structured fields, no correlation id. `index-cmd.ts:25` prints `indexed X`,
`eval-cmd.ts:31` prints scores, `migrate.ts:31` prints `migration applied`; the chat
answer renders via Ink (`chat.tsx`). Batch-command errors are bare `throw` that surface
as Node stack traces; chat catches per-turn errors and renders `error: <message>`. → `04`.

**5. P@1 / R@3 are the only quality signal — and they don't measure the answer.**
`eval-cmd.ts` scores *retrieval* precision/recall against a labeled set
(`eval/queries.json`). It never runs the agent, never reads `messages`, never
scores the generated answer. It's a real signal, but for the vector store, not the
RAG output. → `05`.

## Not yet exercised

Named honestly, with when each becomes relevant:

- **Metrics / SLIs / SLOs / Prometheus** — no counters, gauges, histograms, or
  `/metrics` endpoint. The raw material (`durationMs`, `tokens_used`) is now captured
  per row but unaggregated. Relevant the moment this runs as a long-lived service
  instead of a one-shot CLI.
- **Distributed tracing** — no spans, no trace IDs, no OpenTelemetry. The
  `capabilityId` on every event is the natural span/correlation key and is *still*
  dropped at the sink (no column for it). Relevant when more than one agent or service
  is in the call path.
- **Log levels / structured logs** — no `debug`/`info`/`warn`/`error`, no JSON log
  lines, no redaction. Relevant the first time you need to grep a log instead of
  re-reading the `messages` table.
- **Error tracking (Sentry et al.)** — `warning` and `error` events are now *recorded*
  as rows by the sink (`src/supabase-trace-sink.ts:80-83`), but nothing aggregates,
  groups, or alerts on them. Capture exists; alerting doesn't.
- **Health checks / readiness probes** — no `/healthz`, no DB-ping, no Ollama
  reachability check. A dead Ollama or Postgres surfaces only as a thrown query
  error mid-command (caught and rendered in chat, raw in the batch commands).
- **Alerts / thresholds** — nothing watches the eval scores, latency, or token cost
  over time; a P@1 regression is visible only if a human re-runs `npm run eval`.

## Reading order

`audit.md` next (the full 8-lens walk), then the pattern files `01`→`05`.
