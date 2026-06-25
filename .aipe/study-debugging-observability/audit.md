# audit.md — the 8-lens observability walk

Pass 1. One `##` per lens. Each lens names what buffr actually does, grounded in
`file:line`, or emits `not yet exercised`. Significant findings cross-link to the
Pass 2 pattern files.

> Updated: 2026-06-24 — reconciled against the current code. Two former blind spots are
> resolved: the sink now persists all six `CapabilityEvent` types (was two), and
> `created_at` now comes from `event.timestamp` (was server `now()`). The `ask` command
> is gone — replaced by the long-lived `session.ts` behind the `npm run chat` Ink TUI.
> Lenses, the red-flag ranking, and pattern cross-links updated accordingly.

The repo under audit: `buffr-laptop`, a single-device TypeScript RAG agent.
Postgres + pgvector for storage, Ollama for models, `@rlynjb/aptkit-core` (0.4.1) for
the agent loop. Run by hand from three CLI surfaces: `index`, `chat` (Ink TUI over a
long-lived `session.ts`), and `eval`.

---

## 1. observability-map — what's watchable at each boundary

buffr crosses four boundaries; the agent-loop signal now survives the sink intact.

```
  the four boundaries and what each exposes

  CLI/TUI    →  stdout (index/eval/migrate) · Ink render (chat)   src/cli/*
  Agent loop →  6 CapabilityEvent types (the rich source)         aptkit-core
  Sink       →  persists ALL 6 event types, one row each          src/supabase-trace-sink.ts:56
  Storage    →  messages rows (role/content/tool_calls/results/   sql/001_agents_schema.sql
                model/tokens_used/created_at=event.timestamp)
```

The richest evidence is at the **agent-loop boundary** — the
`CapabilityEvent` union carries `step`, `tool_call_start`,
`tool_call_end{durationMs}`, `model_usage{inputTokens,outputTokens}`, `warning`,
and `error` (`@aptkit/runtime/dist/src/events.d.ts`). That's a full
trace-and-metrics feed. As of 2026-06-24 the **sink preserves all of it**:
`src/supabase-trace-sink.ts:56-84` switches over every variant and writes one row
each — args, `durationMs`, `error`, token counts, warnings, and errors all reach
storage. The map's load-bearing fact flipped: *the sink is no longer the ceiling;
the remaining limits are schema shape (durationMs/tokens live in jsonb / a generic
int, not first-class numeric columns) and the absence of metrics/tracing tooling.*
→ `02-discarded-trace-signal.md`.

## 2. reproduction-and-evidence — repro, hypotheses, experiments

Partial. The repo has one genuine reproduction lever: the eval harness.
`src/cli/eval-cmd.ts` replays a fixed labeled query set (`eval/queries.json`)
through the retrieval pipeline and prints deterministic P@1/R@3 per query
(`eval-cmd.ts:24-32`). That's a controlled experiment for *retrieval* regressions —
change the chunker or embedding model, re-run, compare numbers. → `05-eval-numbers-as-quality-signal.md`.

For the **agent answer itself there is still no full reproduction path**, but the
evidence improved. Chat runs through a long-lived `session.ts` (`src/cli/chat.tsx` →
`session.ask`); the model is Ollama-served and non-deterministic, and nothing captures
the retrieved chunks, the prompt, or a seed alongside the answer. So to reproduce a bad
answer you'd re-run and hope. What changed: the `messages` rows from the prior run now
*include the tool args* — the sink captures `tool_call_start` into a `tool_call` row's
`tool_calls.args` (`src/supabase-trace-sink.ts:62-65`), so the actual search query is
recorded. You can now see both *what was asked of the tool* (the cause) and *what it
returned* (the effect), plus the `durationMs` and any `error`. The remaining repro gap
is upstream of the trace: the retrieved chunk set and the assembled prompt aren't
persisted, and there's no seed.

## 3. structured-logs-and-correlation — events, levels, context, IDs, redaction

`not yet exercised` as structured logging. What exists is unstructured stdout on the
batch commands: `process.stdout.write` with hand-formatted strings — `indexed ${path}`
(`index-cmd.ts:25`), per-query scores (`eval-cmd.ts:31`), `migration applied`
(`migrate.ts:31`); the chat answer is Ink-rendered, not printed (`chat.tsx:44-46`). No
log levels, no JSON lines, no timestamps on the lines, no redaction pass.
→ `04-stdout-as-only-log.md`.

Correlation is the sharper miss, and it's only half-closed. Every `CapabilityEvent`
carries a `capabilityId` (`@aptkit/runtime/dist/src/events.d.ts`) — the natural
correlation/span key tying a turn's events together — and the sink still ignores it on
every branch (`src/supabase-trace-sink.ts:56-84`); there's no `capability_id` column to
write it to. What the sink *now* preserves per row is the event `timestamp`
(`created_at`), which orders the turn but doesn't correlate across runs. The
`conversations.id` (a UUID, `sql/001_agents_schema.sql`) remains the one correlation key
that survives: all messages for one chat session share it (`session.ts:55`, passed into
the sink at `:56`). So you can group a session's turns, but you can't correlate across
the loop's internal events (the `capabilityId` is still dropped).

## 4. metrics-slis-slos-and-alerts — signals, objectives, thresholds

`not yet exercised` as operational metrics. No counters, gauges, or histograms. No
`/metrics` endpoint. No SLI definitions, no SLO targets, no alerting. The number-shaped
signals that exist are now *captured* but still not metric-shaped:

- **Eval scores** (`eval-cmd.ts:33`) — mean P@1 / R@3 printed once per manual run.
  No time series, no threshold, no alert. A regression is visible only if a human
  re-runs and eyeballs it. → `05-eval-numbers-as-quality-signal.md`.
- **`durationMs`** — emitted per tool call by the loop and **now persisted** into the
  `tool_results` jsonb (`src/supabase-trace-sink.ts:68-71`). The raw material for a
  latency histogram now lands in the database — but inside jsonb, not an indexed
  numeric column, so there's no histogram yet. → `02-discarded-trace-signal.md`.
- **`tokens_used`** — the `model_usage` event is now handled
  (`src/supabase-trace-sink.ts:73-78`), so the `messages.tokens_used` column
  (`sql/001_agents_schema.sql:48`) is **filled** on every model call (summed
  input+output). It's a captured cost number, not yet an aggregated metric or alert.

So the gap moved: the cost/latency evidence is no longer *lost*, it's *unaggregated* —
captured per row, with no rollup, time series, or threshold over it.

## 5. traces-and-request-lifecycles — spans, causal chains, latency attribution

This is buffr's strongest lens, and as of 2026-06-24 it's a trace with timing and a
sound clock.

What exists: the `messages` table is a real per-conversation trajectory store. One chat
turn produces a `user` row (`session.ts:61`), then `tool_call`, `tool`, `model_usage`,
`assistant`, and (on failure) `warning`/`error` rows in emit order
(`src/supabase-trace-sink.ts:56-84`). Reading those rows back reconstructs the turn
sequence — a trace, in the trajectory-capture sense, now with latency attribution per
tool span via `tool_results.durationMs`. → `01-trajectory-capture-as-observability.md`.

What's now sound: the per-event `timestamp` the loop stamps (`@aptkit/runtime` emits
`timestamp: timestamp()` on every event) is **persisted** into `created_at`
(`src/supabase-trace-sink.ts:54-55`, insert `coalesce($8::timestamptz, now())` at
`:26-30`). So replay order reflects *emit* time, not server insert time, and survives
the concurrent `Promise.all` flush (`:91-93`) — the test now asserts replay order equals
emit order (`test/supabase-trace-sink.test.ts:64-66`). The residual: two events in the
same millisecond (or an empty event timestamp falling back to `now()`) tie, and a tie is
undefined under `order by created_at`, with no `seq` tiebreaker column yet.
→ `03-created-at-replay-ordering-gap.md`.

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

The prevention gap that *was* a latent incident is now closed: the sink persists
`warning` and `error` events (`src/supabase-trace-sink.ts:80-83`). When the loop emits
an `error` event — a tool failing, a model refusing — it now writes an `error`-role row
with the message, so a failed turn leaves a durable record in `messages`. The test pins
this (`test/supabase-trace-sink.test.ts:62-63`). The chat TUI additionally catches the
throw and renders `error: <message>` (`chat.tsx:30-31`), so the session survives too.
→ `02-discarded-trace-signal.md`.

## 8. debugging-observability-red-flags-audit — ranked blind spots

Ranked by consequence, each with its evidence. Four of the original six blind spots
were closed by the 2026-06-24 sink rewrite; they're listed as RESOLVED so the history is
visible, with the still-open risks ranked first.

**R1 — the `FALLBACK_ANSWER` is invisible in the trace (highest open).** The returned
answer is `finalText.trim() || FALLBACK_ANSWER` in the agent
(`@aptkit/agent-rag-query/dist/src/rag-query-agent.js`). The loop only emits the final
`step` when its text is truthy, so a real answer *is* persisted via that step — but when
the model returns empty and the agent substitutes `FALLBACK_ANSWER`, no `step` fires and
no row is written. The user sees a fallback the trace store never recorded, even now
that every emitted event is captured — because no event is emitted for it. → `01`.

**R2 — same-millisecond replay ties have no tiebreaker (open, low).** Replay now orders
by the persisted `event.timestamp` (`created_at`), which fixed the old insert-race
scramble. The residual: two events in the same millisecond, or an event with an empty
timestamp falling back to `now()` (`src/supabase-trace-sink.ts:26,30`), tie — and a tie
is undefined under `order by created_at`. No `seq` column exists to break it. Narrow on
one device, one turn at a time. → `03`.

**R3 — captured cost/latency is unaggregated (open, low).** `durationMs` and
`tokens_used` are now persisted per row (`src/supabase-trace-sink.ts:68-78`) but live in
jsonb / a generic int with no rollup, histogram, time series, or alert. You *can* answer
"why was that answer slow / how much did it cost" by querying a row; you can't yet trend
it. → `02`, `../study-performance-engineering/`.

**R4 — no liveness signal for Ollama or Postgres (open, low).** No health check, no
ping. A dead dependency surfaces only as a thrown query/HTTP error mid-command (caught
and rendered in chat, raw stack trace in the batch commands). `not yet exercised` for
health probes; low consequence on one device. → `04`.

**R5 — the `capabilityId` correlation key is still dropped (open, low).** Every event
carries `capabilityId` (`events.d.ts`), the natural span key for correlating a turn's
internal events, and no branch reads it / no column stores it
(`src/supabase-trace-sink.ts:56-84`). `conversations.id` correlates a session; nothing
correlates within a turn's event subtree. Relevant when more than one agent/service
enters the path.

**RESOLVED (2026-06-24) — `error`/`warning` events now recorded.** The sink handles both
(`src/supabase-trace-sink.ts:80-83`); a failed turn leaves an `error` row. Was the
highest blind spot (false-negative "clean run"); now closed. → `02`.

**RESOLVED (2026-06-24) — replay order is deterministic for the common case.** Persisting
`event.timestamp` into `created_at` (`src/supabase-trace-sink.ts:54-55`) replaced the
server-`now()` race. Only the same-ms tie (R2) remains. → `03`.

**RESOLVED (2026-06-24) — latency and token cost are captured.** `durationMs` →
`tool_results`, `model_usage` → `tokens_used` (`src/supabase-trace-sink.ts:68-78`). The
evidence exists in the store now; only aggregation (R3) is outstanding. → `02`.

**RESOLVED (2026-06-24) — tool args are captured.** The `tool_call_start` branch writes
`tool_calls = { toolName, args }` (`src/supabase-trace-sink.ts:62-65`), so the search
query (the cause) is stored alongside the result (the effect). → `01`, `02`.
