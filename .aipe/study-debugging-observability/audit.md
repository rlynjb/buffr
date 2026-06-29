# Audit — Debugging & Observability (Pass 1)

The 8-lens walk. Each lens names what buffr-laptop actually does, grounded in `file:line`, or emits `not yet exercised`. The final lens ranks the blind spots by consequence.

The through-line: *when behavior is wrong, what evidence exists to explain it quickly and prevent recurrence?* For buffr the honest answer is "one excellent table and stdout."

---

## 1. observability-map

The evidence map — what can be observed at each boundary.

```
  Signal availability by boundary

  boundary                     signal that exists              gap
  ───────────────────────────  ──────────────────────────────  ─────────────
  CLI → user (index/eval)      process.stdout.write text       no level/field
  chat UI → user               Ink render + caught error       not persisted
  session → agent              trace.emit() per event          —
  sink → agents.messages       one INSERT per CapabilityEvent  same-ms tie
  agent → Ollama (model)       model_usage tokens (in trace)   no span/latency
  pipeline → Postgres (pg)     none (pool errors uncaught)     no query log
```

The strong boundary is **session → sink → storage**: the trace / structured event stream (`CapabilityEvent` → `agents.messages`) gives one observable row per agent event. `src/session.ts:62-63` runs `agent.answer()` then `trace.flush()`; `src/supabase-trace-sink.ts:53` is where every event becomes a row.

The weak boundaries are the two *external* hops — agent→Ollama and pipeline→Postgres. Ollama latency exists only implicitly inside `model_usage` token counts; pg query timing and pool errors are not observed at all. → see `01-full-signal-trajectory-capture.md` for the deep walk of the strong boundary.

## 2. reproduction-and-evidence

Minimal reproduction, hypotheses, controlled experiments, evidence collection.

buffr's reproduction story is **replay from `agents.messages`**. Because `created_at` carries the event timestamp (`src/supabase-trace-sink.ts:54`, written through `persistMessage` at `:30` via `coalesce($8::timestamptz, now())`), you can `SELECT * FROM agents.messages WHERE conversation_id = $1 ORDER BY created_at` and see the exact trajectory in emit order: the user turn, each `tool_call` with its `args`, each `tool` result with `error`/`durationMs`, the `model_usage` token counts, and the assistant `step`. That's a real controlled-experiment substrate — you can diff a bad turn against a good one field by field.

The controlled experiment the repo *does* ship is the eval harness: `src/cli/eval-cmd.ts` runs a fixed labeled set (`eval/queries.json`) through `pipeline.query()` and scores P@1 / R@3 (`:24-33`). That's a reproducible retrieval experiment with a baseline. → `04-eval-numbers-as-quality-signal.md`.

The reproduction gap: the **FALLBACK_ANSWER turn doesn't reproduce from the table**. When `RagQueryAgent.answer()` returns the fallback string with no emitted `step` (aptkit `agent-rag-query/dist/src/rag-query-agent.js:51`), the replayed trajectory shows tool calls and then *nothing* — the answer the user saw is absent. → lens 6 and 8.

## 3. structured-logs-and-correlation

Events, levels, context, correlation IDs, redaction, searchable fields.

Two halves here, and they pull in opposite directions.

**The trace table is structured logging done right.** Every row in `agents.messages` is a typed event with searchable columns: `role`, `content`, `tool_calls`, `tool_results`, `model`, `tokens_used`, `created_at` (`sql/001_agents_schema.sql`, messages table). The correlation ID is real and load-bearing: `conversation_id` ties every event of a turn together, set once in `startConversation` (`src/supabase-trace-sink.ts:4-8`) and threaded through every `persistMessage`. You can `WHERE conversation_id = …` and get the whole story.

**Everything outside the table is unstructured.** `process.stdout.write` is the entire logger (`src/cli/index-cmd.ts:25`, `eval-cmd.ts:31-33`). No log levels (no `info`/`warn`/`error` severity), no JSON fields, no redaction pass. → `03-stdout-as-only-log.md`.

Redaction: `not yet exercised` — there is no redaction layer anywhere; the trace persists raw tool args and content verbatim. For a single-device personal agent that's acceptable, but it means the table is as sensitive as the conversation.

## 4. metrics-slis-slos-and-alerts

Signals, service-level indicators, objectives, alerts, thresholds.

`not yet exercised`. There are no counters, gauges, or histograms in the codebase — no Prometheus client, no StatsD, no metric emit of any kind. The closest thing to an SLI is the eval mean P@1 / R@3 printed by `eval-cmd.ts:33`, but it's a hand-run batch score, not a continuously-collected metric, and there's no objective or alert attached to it.

When it becomes relevant: the first time buffr runs unattended or you want "p95 turn latency" or "tool-error rate this week" without hand-replaying `agents.messages`. The raw material is already in the table (`durationMs`, `tokens_used`, `error`) — a metrics layer would aggregate what the trace already captures. → `study-performance-engineering` owns the budget side of `durationMs`.

## 5. traces-and-request-lifecycles

Request lifecycles, spans, causal chains, latency attribution.

This is buffr's strongest lens — with one sharp caveat about *what kind* of trace it is.

The `CapabilityEvent` stream **is** a request-lifecycle trace: one turn produces an ordered chain of events from user question → tool calls → tool results → model usage → assistant step, all persisted with a per-event `durationMs` on the tool side (`src/supabase-trace-sink.ts:67-72`). The causal chain is explicit — `tool_call_start` records the *cause* (`args`, `:62-66`) and `tool_call_end` records the *effect* (`result`/`error`, `:67-72`). That's real latency attribution at the tool granularity. → `01-full-signal-trajectory-capture.md`.

The caveat: this is a **local, single-process trace, not a distributed one**. There are no propagating trace/span IDs across the Ollama or Postgres hops — `model_usage` gives you tokens but not the model-call wall-clock as a span, and pg queries aren't traced at all. OpenTelemetry / distributed tracing: `not yet exercised`. The ordering of the local trace is itself a pattern worth its own file because of the same-millisecond tie. → `02-client-timestamp-ordering.md`.

## 6. state-snapshots-and-debugging-boundaries

State inspection, network traces, error output, before/after snapshots.

The before/after snapshot mechanism is, again, `agents.messages`: each turn appends an immutable run of rows, so the table *is* a sequence of state snapshots you can diff across turns.

Two debugging boundaries are worth naming precisely:

- **The chat UI error boundary.** `src/cli/chat.tsx:30-31` catches any error from `session.ask()` and renders `error: <message>` inline as a buffr turn. Good UX — one bad turn doesn't crash the session — but the caught error is **not persisted**; it lives only in the terminal scrollback. If the failure was thrown *before* `trace.flush()`, the trace table has no record of it either.
- **The silent memory-write swallow.** `src/session.ts:64-69` wraps `memory.remember()` in `try { } catch { }` with an empty catch, deliberately, so a memory failure never loses the answer. Correct call — but it's a state-change that vanishes with zero evidence. The episodic memory silently didn't get written and nothing anywhere knows.

The honest finding for this lens is the **FALLBACK_ANSWER snapshot gap**: the user-visible answer state (`"I couldn't find anything…"`) has no corresponding row, because the fallback is returned past the trace, not emitted through it (aptkit `agent-rag-query/dist/src/rag-query-agent.js:51`). The before/after snapshot is missing its "after."

## 7. incident-analysis-and-prevention

Root cause, contributing conditions, remediation, regression guards, runbooks.

Root-cause capability is **high for in-trajectory failures, zero for everything else**. If a tool threw, the `error` field on the `tool` row (`src/supabase-trace-sink.ts:69`) plus the preceding `args` give you cause-and-effect directly — that's a real post-mortem substrate. A `warning`/`error` `CapabilityEvent` also lands as its own row (`:80-83`).

The regression guard the repo ships is the eval set: `eval/queries.json` scored by `eval-cmd.ts` is a retrieval-quality guard you can re-run after a change. → `study-testing` owns this seam; `04-eval-numbers-as-quality-signal.md` covers the observability read of it.

Runbooks, incident records, alerting on a guard: `not yet exercised`. There's no runbook, and nothing pages — the eval guard only guards if a human remembers to run it. Contributing conditions that currently have *no* incident trail: a pg pool exhaustion (uncaught, `src/db.ts`), an Ollama outage (surfaces as a thrown error caught by the chat UI and rendered, then lost), and a silent memory-write failure (`session.ts:66-68`).

## 8. debugging-observability-red-flags-audit

Ranked blind spots by consequence, with the evidence for each verdict.

```
  Red flags — ranked by what they cost you

  rank  blind spot                         evidence              cost
  ────  ─────────────────────────────────  ────────────────────  ───────────────
   1    FALLBACK_ANSWER fires no step       rag-query-agent.js:51 trace lies: an
        event → no assistant row            (no trace.emit)       answered turn
                                                                  looks unanswered
   2    same-millisecond timestamp tie,     events.js:2 (ISO ms;  replay order
        no seq tiebreaker                    no counter)           non-deterministic
                                            sink.ts:54             within a ms
   3    errors caught but never persisted   chat.tsx:30-31         a failed turn
                                            session.ts:66-68       leaves no trail
   4    no metrics / SLIs / alerts          (absent)              no unattended
                                                                  health signal
   5    stdout is the only log surface      index-cmd.ts:25       no level, field,
                                            eval-cmd.ts:31         or filter
   6    external hops untraced              (no pg/Ollama span)   can't attribute
                                                                  cross-service lat.
```

**1 — FALLBACK_ANSWER fires no `step` event.** The highest-consequence flag because it makes a *good* observability surface *lie*. Everywhere else the trace is silent (no row); here the user got a real answer and the table says the agent produced nothing. Evidence: `finalText.trim() || FALLBACK_ANSWER` at `agent-rag-query/dist/src/rag-query-agent.js:51` returns past the trace. The fix lives in aptkit, not buffr (aptkit is consumed, never edited — `context.md`), so the buffr-side remediation is to emit a synthetic `step` for the fallback in the sink's caller, or persist `answer` in `session.ask()` after `agent.answer()` returns. → `01-`.

**2 — same-millisecond ordering tie.** The trace's deterministic-replay claim holds *across* milliseconds but not *within* one. `timestamp()` is `new Date().toISOString()` (aptkit `runtime/dist/src/events.js:2`) — millisecond resolution, no monotonic sequence. Two events emitted in the same millisecond sort arbitrarily on `created_at`. For a fast local loop this is reachable. → `02-`.

**3 — caught errors leave no durable trail.** `chat.tsx:30-31` and `session.ts:66-68` both swallow-or-render and move on. Correct for resilience, wrong for forensics — neither path persists the error.

**4 — no metrics.** Covered in lens 4. Defensible at current scope, first thing you need when buffr goes unattended.

**5 — stdout-only logging.** Covered in lens 3. → `03-`.

**6 — external hops untraced.** Covered in lens 5. The `CapabilityEvent` trace stops at the buffr/aptkit boundary; the Ollama and Postgres legs are dark.
