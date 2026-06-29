# Overview — Debugging & Observability in buffr-laptop

The question this guide answers: **when buffr behaves wrong, what evidence exists to explain it quickly and stop it recurring?**

The verdict first, then the map.

## Verdict

buffr-laptop has exactly one serious observability investment — the trace / structured event stream (`CapabilityEvent` → `agents.messages`) — and it's genuinely good: it captures the *full* agent trajectory, all six event variants, including the cause (tool-call `args`), the result (`result` + `error` + `durationMs`), and token usage. If a turn goes wrong, you can replay it from a database table in emit order.

Everything else is thin. Outside that table, the only logging is `process.stdout.write` — the CLIs print "indexed X", the answer, and the eval numbers, and that's the whole log surface. No metrics, no distributed tracing, no log levels, no error tracking, no health checks. For a single-device personal RAG agent that's a defensible scope, but you should know exactly where the blind spots are.

## The evidence map — where you can observe behavior

This is the system as observability bands: where a signal exists, and where there's nothing to look at.

```
  buffr-laptop — the observability surface

  ┌─ CLI layer (src/cli/) ──────────────────────────────────────┐
  │  index-cmd.ts   → process.stdout.write("indexed X")          │
  │  eval-cmd.ts    → process.stdout.write(P@1 / R@3)            │  ← stdout only
  │  chat.tsx       → Ink render; CATCHES per-turn errors (l.30) │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  session.ask()
  ┌─ Session layer (src/session.ts) ──────▼──────────────────────┐
  │  agent.answer() → ★ trace.emit() per event ★ → trace.flush() │  ← THE signal
  └───────────────────────────────┬──────────────────────────────┘
                  CapabilityEvent  │  (step / tool_call_start /
                  ×6 variants      │   tool_call_end / model_usage /
                                   │   warning / error)
  ┌─ Sink (src/supabase-trace-sink.ts) ───▼──────────────────────┐
  │  SupabaseTraceSink.emit() → persistMessage() per event       │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  INSERT (created_at = event.timestamp)
  ┌─ Storage (agents.messages) ───▼──────────────────────────────┐
  │  the replayable trajectory — one row per event, emit-ordered │
  └──────────────────────────────────────────────────────────────┘
```

The whole observability story is that vertical spine. The CLI band has stdout; the storage band has the trace table; in between there is no metrics emitter, no span exporter, no structured logger.

## Ranked findings

Ordered by consequence — what to look at first.

1. **Full-signal trajectory capture is the load-bearing win.** `SupabaseTraceSink.emit()` (`src/supabase-trace-sink.ts:53-85`) persists all six `CapabilityEvent` types. Crucially it captures the *cause* — `tool_call_start` writes `args` (`:62-66`) — and the *result* — `tool_call_end` writes `result` + `error` + `durationMs` (`:67-72`). Most agent loggers drop the args and keep only the answer; this one keeps the why. → `01-full-signal-trajectory-capture.md`

2. **Replay order is deterministic by design — with one residual tie.** `created_at` comes from `event.timestamp`, not server `now()` (`src/supabase-trace-sink.ts:54`, `persistMessage` `:30`), so replay order matches emit order even though `flush()` races concurrent inserts. The residual: `timestamp()` is millisecond-resolution ISO with no sequence counter (aptkit `runtime/dist/src/events.js:2`), so two same-millisecond events tie with no tiebreaker. → `02-client-timestamp-ordering.md`

3. **The FALLBACK_ANSWER path fires no `step` event — an answer the trace never records.** `RagQueryAgent.answer()` returns `finalText.trim() || FALLBACK_ANSWER` (aptkit `agent-rag-query/dist/src/rag-query-agent.js:51`). When synthesis comes back empty, the user sees `"I couldn't find anything…"` but the agent loop emitted no `step` for it — so `agents.messages` has no assistant row for that turn. The trace says the agent answered nothing; the user got an answer. This is the one place the full-signal table lies. → `audit.md` lens 6, and `01-`.

4. **stdout is the only log surface outside the trace table.** No log levels, no structured fields, no correlation IDs in the CLI output (`src/cli/index-cmd.ts:25`, `eval-cmd.ts:31`). The chat UI catches per-turn errors and renders them inline (`src/cli/chat.tsx:30-31`) — good for the user, but the caught error is never persisted or logged anywhere durable. → `03-stdout-as-only-log.md`

5. **Eval numbers are the only retrieval-quality signal.** `eval-cmd.ts` prints per-query P@1 / R@3 and a mean (`:31-33`). That's the repo's entire "is retrieval healthy" instrument — run by hand, printed to stdout, compared by eyeball. → `04-eval-numbers-as-quality-signal.md`

## not yet exercised

Named honestly, with when each becomes relevant:

- **Metrics / SLIs / SLOs (Prometheus, StatsD).** No counters, gauges, or histograms anywhere. Relevant the moment buffr runs unattended or multi-user and you need "p95 turn latency" without replaying the table by hand.
- **Distributed tracing / OpenTelemetry.** The `CapabilityEvent` stream is a *local* trace, not a distributed one — no trace/span IDs propagate across the Ollama or Postgres hops. Relevant when buffr grows a second service or an Edge Function tier.
- **Log levels / structured logging.** `process.stdout.write` is the whole logger; no `debug`/`info`/`warn`/`error` severity, no JSON log lines, no redaction. Relevant once logs are shipped somewhere and need filtering.
- **Error tracking (Sentry, etc.).** The chat UI swallows-and-renders (`chat.tsx:30`); the memory write swallows silently (`session.ts:66-68`). No error reaches a tracker with a stack trace and a fingerprint. Relevant the first time a bug only reproduces on someone else's machine.
- **Health checks / readiness probes.** No `/healthz`, no pool-liveness check, no Ollama-reachability probe. Relevant when something other than a human at a terminal needs to know buffr is up.

## Cross-links

`study-testing` (the eval seam), `study-performance-engineering` (`durationMs` as a budget), `study-distributed-systems` (the ordering tie), `study-agent-architecture` (the loop that emits the events).
