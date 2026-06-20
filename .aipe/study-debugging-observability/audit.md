# audit.md — the 8-lens observability walk

Pass 1. One `##` per lens. Each lens names what buffr actually does, grounded in
`file:line`, or emits `not yet exercised`. Significant findings cross-link to the
Pass 2 pattern files.

The repo under audit: `buffr-laptop`, a single-device TypeScript RAG agent.
Postgres + pgvector for storage, Ollama for models, `@rlynjb/aptkit-core` for the
agent loop. Run by hand from three CLI commands: `index`, `ask`, `eval`.

---

## 1. observability-map — what's watchable at each boundary

buffr crosses four boundaries, and the evidence thins out fast as you descend.

```
  the four boundaries and what each exposes

  CLI        →  stdout strings only (no levels, no ts, no ids)   src/cli/*
  Agent loop →  6 CapabilityEvent types (the rich source)        aptkit-core
  Sink       →  keeps 2 of 6 event types                          src/supabase-trace-sink.ts:27
  Storage    →  messages rows (role/content/tool_results/model)   sql/001_agents_schema.sql
```

The richest evidence is at the **agent-loop boundary** — the
`CapabilityEvent` union carries `step`, `tool_call_start`,
`tool_call_end{durationMs}`, `model_usage{inputTokens,outputTokens}`, `warning`,
and `error` (`@aptkit/runtime/dist/src/events.d.ts`). That's a full
trace-and-metrics feed. The **sink boundary is where the evidence collapses**:
`src/supabase-trace-sink.ts:27-35` reads only `step.content` and
`tool_call_end.toolName`/`.result`. Everything else is dropped before it reaches
storage. The map's load-bearing fact: *the observability ceiling isn't the schema,
it's the sink.* → `02-discarded-trace-signal.md`.

## 2. reproduction-and-evidence — repro, hypotheses, experiments

Partial. The repo has one genuine reproduction lever: the eval harness.
`src/cli/eval-cmd.ts` replays a fixed labeled query set (`eval/queries.json`)
through the retrieval pipeline and prints deterministic P@1/R@3 per query
(`eval-cmd.ts:24-32`). That's a controlled experiment for *retrieval* regressions —
change the chunker or embedding model, re-run, compare numbers. → `05-eval-numbers-as-quality-signal.md`.

For the **agent answer itself there is no reproduction path**. `ask-cmd.ts` is a
one-shot: it takes `process.argv`, runs `agent.answer`, prints, exits
(`ask-cmd.ts:16-38`). The model is Ollama-served and non-deterministic; nothing
captures the retrieved chunks, the prompt, or a seed alongside the answer. To
reproduce a bad answer you'd re-run and hope — the `messages` rows from the prior
run are the only artifact, and they omit the tool *args* (the actual search query)
because the sink drops `tool_call_start` (`src/supabase-trace-sink.ts:31`). You can
see *that* a tool was called and its result, never *what was asked of it*.

## 3. structured-logs-and-correlation — events, levels, context, IDs, redaction

`not yet exercised` as structured logging. What exists is unstructured stdout:
`process.stdout.write` with hand-formatted strings — `indexed ${path}`
(`index-cmd.ts:25`), the answer (`ask-cmd.ts:37`), per-query scores
(`eval-cmd.ts:31`), `migration applied` (`migrate.ts:31`). No log levels, no JSON
lines, no timestamps on the lines, no redaction pass. → `04-stdout-as-only-log.md`.

Correlation is the sharper miss. Every `CapabilityEvent` carries a `capabilityId`
(`@aptkit/runtime/dist/src/events.d.ts`) — the natural correlation/span key tying a
turn's events together — and the sink ignores it on every branch
(`src/supabase-trace-sink.ts:27-35`). The `conversations.id` (a UUID,
`sql/001_agents_schema.sql`) is the one correlation key that survives: all messages
for one `ask` share it (`ask-cmd.ts:29`, passed into the sink at `:31`). So you can
group a run's turns, but you can't correlate across the loop's internal events or
across runs.

## 4. metrics-slis-slos-and-alerts — signals, objectives, thresholds

`not yet exercised`. No counters, gauges, or histograms. No `/metrics` endpoint.
No SLI definitions, no SLO targets, no alerting. The two number-shaped signals that
exist are not metrics in the operational sense:

- **Eval scores** (`eval-cmd.ts:33`) — mean P@1 / R@3 printed once per manual run.
  No time series, no threshold, no alert. A regression is visible only if a human
  re-runs and eyeballs it. → `05-eval-numbers-as-quality-signal.md`.
- **`durationMs`** — emitted per tool call by the loop, the raw material for a
  latency histogram, discarded at the sink before it could become one
  (`src/supabase-trace-sink.ts:31`). → `02-discarded-trace-signal.md`.

The `messages.tokens_used` column (`sql/001_agents_schema.sql`) is the schema's one
nod toward a cost metric, and nothing writes it — the `model_usage` event that
carries token counts is never handled by the sink.

## 5. traces-and-request-lifecycles — spans, causal chains, latency attribution

This is buffr's strongest lens *and* its biggest gap, sitting in the same place.

What exists: the `messages` table is a real per-conversation trajectory store. One
`ask` run produces a `user` row (`ask-cmd.ts:30`), then `assistant` and `tool` rows
in emit order (`src/supabase-trace-sink.ts:30,33`). Reading those rows back
reconstructs the turn sequence — a trace, in the trajectory-capture sense.
→ `01-trajectory-capture-as-observability.md`.

What's missing: it's a trace with no timing and a fragile clock. `durationMs`
(latency attribution per span) is dropped at the sink. The per-event `timestamp`
the loop stamps (`@aptkit/runtime` emits `timestamp: timestamp()` on every event) is
dropped too — so replay order falls back to `messages.created_at`, which is
server-side `now()` set at insert, not event time. Under the concurrent `Promise.all`
flush (`src/supabase-trace-sink.ts:38`), near-simultaneous inserts can reorder, and
the only test reads them back with `order by created_at`
(`test/supabase-trace-sink.test.ts:31`). → `03-created-at-replay-ordering-gap.md`.

No distributed tracing (no spans, no OTel, no trace propagation) — `not yet
exercised`, and not needed on one device until a second service enters the path.

## 6. state-snapshots-and-debugging-boundaries — state, network traces, error output

Thin. The inspectable state is the database itself: `agents.documents`,
`agents.chunks` (with embeddings), `agents.conversations`, `agents.messages`. You
can `psql` into `reindb` and read any of it directly — that's the de-facto state
snapshot. The dimension guard is the one explicit before/it-breaks boundary:
`PgVectorStore.assertDim` throws `dimension mismatch: got X, store is 768` on any
vector of the wrong width (`src/pg-vector-store.ts:32-36`), called before every
upsert and search (`:39`, `:68`). That's a deliberate fail-loud debugging boundary —
a 768/other mismatch surfaces as a clear thrown message, never a silent truncation.

No network-level trace capture (no request/response logging for the Ollama HTTP
calls or the Postgres wire). A failed Ollama embed or a dead Postgres surfaces as a
raw thrown error from inside `pg` or the embedding provider, with no buffr-side
context wrapping it. Error *output* is therefore an unhandled Node stack trace —
honest, but uncontextualized.

## 7. incident-analysis-and-prevention — root cause, remediation, regression guards

`not yet exercised` as incident process (no runbooks, no postmortems, no on-call —
correct for a hand-run laptop tool). What exists is **regression prevention**, and
it's real:

- The eval set (`eval/queries.json` + `eval-cmd.ts`) is a retrieval-quality
  regression guard: change retrieval, re-run, catch a P@1/R@3 drop. → `05`.
- The `node:test` suite (`test/*.test.ts`) guards the persistence and config layers.
  DB-touching tests gate on `DATABASE_URL` and skip when unset
  (`test/supabase-trace-sink.test.ts:12`) — so the guard degrades gracefully off-box.
- The dimension guard (`src/pg-vector-store.ts:32`) prevents the specific incident
  of a wrong-dim embedding silently corrupting the index.

The prevention gap that maps to a real latent incident: the sink drops `warning`
and `error` events (`src/supabase-trace-sink.ts:27-35`). When the loop emits an
`error` event — a tool failing, a model refusing — nothing records it. The incident
leaves no trace in the store; you'd only know from a stdout stack trace if it
bubbled that far. → `02-discarded-trace-signal.md`.

## 8. debugging-observability-red-flags-audit — ranked blind spots

Ranked by consequence, each with its evidence.

**R1 — `error`/`warning` events are silently dropped (highest).** The loop emits
both (`@aptkit/runtime/dist/src/run-agent-loop.js`, `events.d.ts`); the sink handles
neither (`src/supabase-trace-sink.ts:27-35`). A failed tool call or model warning
during an `ask` leaves zero record in `messages`. The most diagnostically valuable
events are the ones thrown away. → `02`.

**R2 — replay order is non-deterministic under concurrent flush.** `Promise.all`
over the pending writes (`src/supabase-trace-sink.ts:38`) with no per-row ordering
column means `created_at = now()` is the only sort key, and ties/reorders are
possible. The test cements the flawed read path with `order by created_at`
(`test/supabase-trace-sink.test.ts:31`). A scrambled trace is worse than no trace —
it's confidently wrong. → `03`.

**R3 — latency and token cost are unrecoverable.** `durationMs` and `model_usage`
arrive on every run and are dropped (`src/supabase-trace-sink.ts:31`); the
`tokens_used` column is never written. You cannot answer "why was that answer slow"
or "how much did it cost" from any stored evidence. → `02`.

**R4 — the final answer's persistence is conditional, and the fallback is invisible.**
The returned answer is `finalText.trim() || FALLBACK_ANSWER` in the agent
(`@aptkit/agent-rag-query/dist/src/rag-query-agent.js`). The loop only emits the
final `step` when its text is truthy (`run-agent-loop.js` guards `if (text)`), so a
real answer *is* persisted via that step — but when the model returns empty and the
agent substitutes `FALLBACK_ANSWER`, no row is written. The user sees a fallback the
trace store never recorded. → `01`.

**R5 — no liveness signal for Ollama or Postgres.** No health check, no ping. A dead
dependency surfaces only as a thrown query/HTTP error mid-command (`not yet
exercised` for health probes). Low consequence on one device; flagged for honesty.

**R6 — tool args are not captured.** Dropping `tool_call_start`
(`src/supabase-trace-sink.ts`, no branch for it) means the *search query* sent to
`search_knowledge_base` is never stored — only that the tool ran and what it
returned. You can see the effect, never the cause. → `01`.
