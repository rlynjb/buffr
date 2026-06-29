# Audit — Debugging & Observability (Pass 1)

The 8-lens walk over buffr-laptop. Each lens names what the code actually does,
grounded in `file:line`, or says `not yet exercised` and when it starts to
matter. Significant patterns cross-link to their Pass 2 file.

---

## 1. observability-map — what can be observed at each boundary

The evidence surface has exactly one durable store and three ephemeral edges.

```
  boundary                  what's observable            durability
  ─────────────────────────────────────────────────────────────────
  agent run → trace sink    all 6 event types → rows     DURABLE (Postgres)
  session → memory write    nothing (swallowed catch)    none
  Ink turn → screen         "error: <msg>" or answer     ephemeral (frame)
  index CLI → stdout        "indexed <path>"             ephemeral (terminal)
  eval CLI → stdout         per-query + mean P@1/R@3      ephemeral (terminal)
```

The durable one is `SupabaseTraceSink.emit()` (`src/supabase-trace-sink.ts:53`)
writing to `agents.messages` (`sql/001_agents_schema.sql:40`). That is the
observability map: if it isn't an event the agent loop emits, it leaves no trace.
→ `01-full-signal-trajectory-capture.md`.

## 2. reproduction-and-evidence — repro, hypotheses, evidence collection

Strong here, for one reason: the trajectory is replayable. Because every tool
call's **args** are persisted (`tool_call` role, `tool_calls` jsonb,
`src/supabase-trace-sink.ts:62-65`) alongside the **result/error/durationMs**
(`tool` role, `tool_results` jsonb, `:67-71`), you can answer "why did this answer
come out wrong?" from the rows alone: which passages were retrieved, what the tool
returned, whether it errored. The cause is captured next to the effect.

The repro gap is the **fallback path**: a question that yields empty model text
produces a `FALLBACK_ANSWER` the user sees, but *no* `step` row records it
(detail in lens 6). So one class of "the agent said it couldn't find anything"
incident has no row to start the repro from. Otherwise: evidence collection is
deterministic and ordered (lens 5).

No controlled-experiment harness for production behavior beyond the offline eval
(`src/cli/eval-cmd.ts`) — that's a fixed labeled set, not a live A/B. → lens 4,
`04-eval-numbers-as-quality-signal.md`.

## 3. structured-logs-and-correlation — events, levels, context, redaction

Split verdict.

**The trace sink is effectively structured logging done right** — events are
typed (`CapabilityEvent`), each carries context (`role`, `model`, `tokensUsed`),
and they share a correlation key: `conversation_id`
(`src/supabase-trace-sink.ts:51`, FK at `sql/001_agents_schema.sql:42`). Every
row of a session ties back to one `conversations` row. That's a correlation ID.

**The CLI/Ink logging is not.** `process.stdout.write` lines
(`src/cli/index-cmd.ts:25`, `src/cli/eval-cmd.ts:31`, and Ink's rendered
`error: <msg>` at `src/cli/chat.tsx:31`) have **no level** (no info/warn/error
distinction — the sink's `warning`/`error` event types never reach stdout), **no
structure** (free text, not key-value), and **no correlation** beyond the current
terminal. → `03-stdout-as-only-log.md`.

**Redaction: `not yet exercised`, and worth flagging.** Tool args and results are
persisted raw into jsonb. On a single-user laptop with `me.md`-style personal
content, that's the point — but there's no redaction seam, so the day this store
is shared or backed up off-device, the trajectory contains everything verbatim.
Becomes relevant the moment `app_id` stops meaning "just me."

## 4. metrics-slis-slos-and-alerts — signals, SLIs, objectives, alerts

`not yet exercised` for live metrics. There are **no counters, no gauges, no
aggregation, no alert thresholds**. Nothing computes a rate-over-time.

The one numeric quality signal is **offline**: `scorePrecisionAtK` /
`scoreRecallAtK` over `eval/queries.json`, printed as `P@1` / `R@3` and their
means (`src/cli/eval-cmd.ts:22-33`). That's a retrieval-quality SLI measured in a
batch you run by hand, not a production objective with an alert. Treat it as the
seam with study-testing. → `04-eval-numbers-as-quality-signal.md`.

Raw material for real metrics *is* being captured — `durationMs` per tool call
and `tokens_used` per model call land in `messages`
(`src/supabase-trace-sink.ts:69`, `:76`) — but nothing rolls them into p50/p95
latency or a token-budget gauge. The numbers exist; the metric layer doesn't.
Becomes relevant when you want "is it slow *lately*" instead of "was this one run
slow."

## 5. traces-and-request-lifecycles — lifecycles, spans, causal chains, latency

This is the repo's strongest lens, within one process.

A single `ask()` (`src/session.ts:60`) is one request lifecycle, and the trace
captures its causal chain in order: `tool_call_start` (args) → `tool_call_end`
(result + `durationMs`) → `model_usage` (tokens) → `step` (assistant text). Each
event carries `event.timestamp`, persisted into `created_at` via
`coalesce($8::timestamptz, now())` (`src/supabase-trace-sink.ts:30`), so a `select
... order by created_at` replays the lifecycle in emit order — **not** in the
order the queued async inserts happened to land. That ordering guarantee is the
load-bearing detail. → `02-client-timestamp-ordering.md`,
`01-full-signal-trajectory-capture.md`.

Latency attribution per span exists at the tool level (`durationMs` from the
loop), but there's **no whole-request span** — nothing records "the full `ask()`
took N ms." And it's single-process: no distributed trace, no parent/child span
IDs crossing a network boundary. Distributed tracing is `not yet exercised`;
relevant once the loop runs behind a service boundary.

## 6. state-snapshots-and-debugging-boundaries — state inspection, before/after

The persisted trajectory *is* the state snapshot — you reconstruct what the agent
knew at each step by replaying `messages`. No separate snapshot mechanism is
needed because the event stream is the state.

**The honest finding lives here.** The fallback answer is a state the snapshot
never records. In the agent loop, the `step` event is gated:

```
  run-agent-loop.js:49   const text = textFromContent(response.content);
  run-agent-loop.js:50   if (text) {                         // ← gate
  run-agent-loop.js:51     trace?.emit({ type: 'step', ... })
  run-agent-loop.js:52   }
  ...
  rag-query-agent.js:51  return finalText.trim() || FALLBACK_ANSWER;
```

When the model returns empty text: `text` is falsy → no `step` emitted →
`finalText = ''` → `answer()` substitutes `FALLBACK_ANSWER`
(`@aptkit/agent-rag-query/dist/src/rag-query-agent.js:21,51`). The user sees "I
couldn't find anything in the knowledge base to answer that." but **the trace has
no row for that answer.** The before/after snapshot is missing its "after" for
exactly the failure case you'd most want to debug. This is an aptkit-side gate,
not a buffr bug — but buffr is what reads the empty trace.

Network/error output at the boundary: tool errors are captured (`tool_results.error`,
`src/supabase-trace-sink.ts:69`); the session's `memory.remember()` failure is
**swallowed by design** (`src/session.ts:66`, "best-effort, the turn already
succeeded") — a deliberate tradeoff that trades a memory-write incident for never
losing the answer, but it means a persistent memory-write failure is invisible.

## 7. incident-analysis-and-prevention — root cause, remediation, runbooks

`not yet exercised` as a *practice* — there are no runbooks, no post-incident
docs, no regression guards wired to observability. But the substrate for root
cause is unusually good: given a bad answer, the conversation's `messages` rows
give you retrieved passages, tool errors, token counts, and timing in order, so
root-causing is a `select ... where conversation_id = ... order by created_at`.

Prevention is offline-only: re-run `npm run eval` against `eval/queries.json` to
catch retrieval regressions (the study-testing seam). No alert prevents a live
regression; you find out at the next manual eval run. Becomes a real gap when the
agent runs unattended.

## 8. debugging-observability-red-flags-audit — ranked blind spots

Ranked by consequence for *this* repo at *this* scale.

1. **Fallback answers leave no trace (lens 6).** Highest-leverage blind spot:
   the one answer-class you'd most want to debug ("it said it found nothing") is
   the one with no row. Evidence: the `if (text)` gate at
   `run-agent-loop.js:50` vs the `|| FALLBACK_ANSWER` at `rag-query-agent.js:51`.
   Mitigation lives upstream in aptkit; buffr could persist a synthetic `step`
   when `answer === FALLBACK_ANSWER`.

2. **Same-millisecond timestamp tie has no tiebreaker (lens 5).** `created_at` is
   millisecond `timestamptz` and there's no monotonic `seq` column, so two events
   emitted in the same millisecond can replay out of order. Low probability on a
   single-device flow, real in principle. Evidence: `sql/001_agents_schema.sql:49`
   (no seq column), `src/supabase-trace-sink.ts:30`. →
   `02-client-timestamp-ordering.md`.

3. **No redaction on persisted args/results (lens 3).** Personal content stored
   verbatim in jsonb. Acceptable while `app_id='laptop'` means one private device;
   a sharing/backup blind spot the moment that changes.

4. **Swallowed memory-write failures (lens 6).** Deliberate, but a persistent
   failure is silent — episodic memory could be quietly broken for a whole
   session with no signal. Evidence: `src/session.ts:64-68`.

5. **No live metrics or alerts (lens 4).** You can't see "is it degrading"
   without manually querying or re-running eval. Lowest urgency at single-user
   scale; first thing to grow.

6. **stdout has no levels or correlation (lens 3).** CLI output can't be filtered
   or tied to a conversation. → `03-stdout-as-only-log.md`.
