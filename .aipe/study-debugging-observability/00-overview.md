# Overview — Debugging & Observability in buffr-laptop

The question this guide answers: **when buffr behaves wrong, what evidence exists to explain it quickly and stop it recurring?**

The verdict first, then the map.

## Verdict

buffr-laptop has one serious *durable* observability investment and one serious *live* one, and they don't cover the same ground. The trace / structured event stream (`CapabilityEvent` → `agents.messages`) is genuinely good: it captures the *full* `/ask` agent trajectory, all six event variants, including the cause (tool-call `args`), the result (`result` + `error` + `durationMs`), and token usage. If an `/ask` turn goes wrong, you can replay it from a database table in emit order.

`/research` and `/investing` got a different investment this pass: a live per-step progress panel (`ProgressEvent` → a running/done/failed list in the chat UI) that shows each connector fetch and pipeline stage as it happens. It's a real, well-built mechanism — and it's the *only* observability those two pipelines have. Their Analyzer/Teacher model calls never reach `agents.messages` at all; once a `/research` turn ends, nothing about it survives except scrollback.

Outside those two mechanisms, the only logging is `process.stdout.write` — the CLIs print "indexed X", the answer, and the eval numbers, and that's the whole log surface. No metrics, no distributed tracing, no log levels, no error tracking, no health checks. This pass also surfaced real evidence of what that scope costs: three shipped concurrency bugs (a hang on exit, a dead SIGINT handler, swallowed promise rejections) that were each diagnosable only by watching the process stop responding — and none of the three fixes added a diagnostic, so the same class of bug can recur with the same lack of evidence.

## The evidence map — where you can observe behavior

This is the system as observability bands: where a signal exists, and where there's nothing to look at.

```
  buffr-laptop — the observability surface (two pipelines, diverging)

  ┌─ CLI layer (src/cli/) ──────────────────────────────────────┐
  │  index-cmd.ts   → process.stdout.write("indexed X")          │
  │  eval-cmd.ts    → process.stdout.write(P@1 / R@3)            │  ← stdout only
  │  chat.tsx       → OpenTUI render; CATCHES per-turn/flow errors │
  │                    LIVE progress panel for /research/investing│  ← new, live-only
  └───────────────────────────────┬──────────────────────────────┘
                    session.ask() │           onProgress (ProgressEvent)
  ┌─ Session layer (src/session.ts) ──────▼──────────────────────┐
  │  /ask:      agent.answer() → ★ trace.emit() per event ★     │  ← THE durable signal
  │  /research: researchEngine.collect()/evaluate() — NO trace   │  ← nothing durable
  └───────────────────────────────┬──────────────────────────────┘
                  CapabilityEvent  │  (step / tool_call_start /
                  ×6 variants,     │   tool_call_end / model_usage /
                  /ask ONLY        │   warning / error)
  ┌─ Sink (src/supabase-trace-sink.ts) ───▼──────────────────────┐
  │  SupabaseTraceSink.emit() → persistMessage() per event       │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  INSERT (created_at = event.timestamp)
  ┌─ Storage (agents.messages) ───▼──────────────────────────────┐
  │  the replayable /ask trajectory — one row per event           │
  │  /research and /investing write NOTHING here                  │
  └──────────────────────────────────────────────────────────────┘
```

The CLI band has stdout; the storage band has the trace table, but only for `/ask`. `/research`/`/investing` have a real live signal (the progress panel) that never reaches storage — a genuinely new, well-built mechanism with a genuinely new blind spot behind it. In between, still no metrics emitter, no span exporter, no structured logger.

## Ranked findings

Ordered by consequence — what to look at first.

1. **`/research` and `/investing` are structurally untraceable — a bigger blind spot than anything the prior pass found.** `AgentContext` carries only a `traceId: string`, no sink (`packages/contracts/src/index.ts:1`), and `Analyzer`/`Teacher` call `runAgentLoop` without a `trace` option (`packages/capabilities/src/analyzer/index.ts:115-123`, `.../teacher/index.ts:100-123`) — the identical kernel `RagQueryAgent` uses when it *is* traced. Nothing about a `/research` turn's model calls ever reaches `agents.messages`; the live token counter wired for it (`src/session.ts:729`) never fires because the `model_usage` event it depends on is never emitted. → `05-live-progress-panel.md`, `audit.md` lens 1.

2. **The live per-step progress panel is a genuinely good new mechanism — for watching, not for debugging after the fact.** A `ProgressEvent` fires per connector fetch and per pipeline stage (`packages/capabilities/src/collector/index.ts:35-52` → `packages/engines/market-research/src/engine.ts:76-178` → `src/cli/chat.tsx:273-293`), rendered live as a per-step running/done/failed list, and a copy sticks to the finished turn so it survives in scrollback (`chat.tsx:297,303`, fixed by `ebe1e65`). It's the strongest new observability investment this pass — and it's the mechanism that makes finding #1 visible while a turn runs, even though it can't fix what #1 is missing after. → `05-live-progress-panel.md`

3. **Full-signal trajectory capture is still the load-bearing durable win — for `/ask`.** `SupabaseTraceSink.emit()` (`src/supabase-trace-sink.ts:53-85`) persists all six `CapabilityEvent` types. Crucially it captures the *cause* — `tool_call_start` writes `args` (`:62-66`) — and the *result* — `tool_call_end` writes `result` + `error` + `durationMs` (`:67-72`). Most agent loggers drop the args and keep only the answer; this one keeps the why. → `01-full-signal-trajectory-capture.md`

4. **Three shipped concurrency bugs prove the stdout-only thesis, and their fixes added zero new diagnostics.** A hang on `/exit` (`64f822f`), a dead SIGINT handler because raw-terminal mode swallows the signal before it fires (`9c1b1e6`), and swallowed promise rejections that froze the research/review flows (`26f0e4b`) were all diagnosable only by watching the process stop responding — no log line pointed at any of them. None of the three fixes logs *why* it fired, so the same bug class can recur with the same lack of evidence. → `03-stdout-as-only-log.md`, `audit.md` lens 7 Case study B.

5. **A whole-branch code review found 5 bugs with zero prior evidence trail — a debugging discipline distinct from reproduction.** `41ecce8` fixed an unreachable guard, an unguarded startup promise, an unguarded array reduce, a dual-implementation contract-parity drift, and a spec-compliance gap — none had ever executed to produce a symptom; all were found by reading the diff against its own spec and sibling code. → `audit.md` lens 7 Case study A.

6. **Replay order is deterministic by design — with one residual tie.** `created_at` comes from `event.timestamp`, not server `now()` (`src/supabase-trace-sink.ts:54`, `persistMessage` `:26,30`), so replay order matches emit order even though `flush()` races concurrent inserts. The residual: `timestamp()` is millisecond-resolution ISO with no sequence counter (`packages/kernel/src/tracing.ts:32-34`), so two same-millisecond events tie with no tiebreaker. → `02-client-timestamp-ordering.md`

7. **The FALLBACK_ANSWER path fires no `step` event — an answer the trace never records.** `RagQueryAgent.answer()` returns `finalText.trim() || FALLBACK_ANSWER` (`packages/kernel/src/agents/rag-query-agent.ts:86`). When synthesis comes back empty, the user sees `"I couldn't find anything…"` but the agent loop emitted no `step` for it (`run-agent-loop.ts:103`'s `if (text)` guard) — so `agents.messages` has no assistant row for that turn. → `audit.md` lens 6, and `01-`.

8. **stdout is still the only log surface outside the trace table, and more call sites now share that shape.** No log levels, no structured fields, no correlation IDs in the CLI output (`src/cli/index-cmd.ts:25`, `eval-cmd.ts:33`). The chat UI catches per-turn *and* per-flow errors and renders them inline (`chat.tsx`, 6+ sites after `26f0e4b`) — good for the user, but none of it is persisted. → `03-stdout-as-only-log.md`

9. **Eval numbers are still the only retrieval-quality signal.** `eval-cmd.ts` prints per-query P@1 / R@3 and a mean (`:33-35`). That's the repo's entire "is retrieval healthy" instrument — run by hand, printed to stdout, compared by eyeball. → `04-eval-numbers-as-quality-signal.md`

## not yet exercised

Named honestly, with when each becomes relevant:

- **Metrics / SLIs / SLOs (Prometheus, StatsD).** No counters, gauges, or histograms anywhere. The progress panel's per-run counts (connector result counts, stage detail strings) are ephemeral UI props, not aggregated metrics. Relevant the moment buffr runs unattended or multi-user and you need "p95 turn latency" or "connector failure rate this week" without replaying anything by hand.
- **Distributed tracing / OpenTelemetry.** The `CapabilityEvent` stream is a *local* trace, not a distributed one — no trace/span IDs propagate across the Ollama or Postgres hops, and it only exists for `/ask` in the first place. Relevant when buffr grows a second service, an Edge Function tier, or when `/research`'s model calls get traced at all.
- **Log levels / structured logging.** `process.stdout.write` is the whole logger; no `debug`/`info`/`warn`/`error` severity, no JSON log lines, no redaction. Relevant once logs are shipped somewhere and need filtering.
- **Error tracking (Sentry, etc.).** The chat UI swallows-and-renders across 6+ call sites now; the memory write swallows silently (`session.ts:64-69`); the three concurrency fixes mask their symptoms without logging them. No error reaches a tracker with a stack trace and a fingerprint. Relevant the first time a bug only reproduces on someone else's machine.
- **Health checks / readiness probes.** No `/healthz`, no pool-liveness check, no Ollama-reachability probe. Relevant when something other than a human at a terminal needs to know buffr is up.
- **A durable trace for `/research`/`/investing`.** The single biggest new gap this pass — the progress panel proves the team knows how to build good observability for this pipeline; it just hasn't been made durable yet. Relevant now, given `/research` and `/investing` are primary features, not experiments.

## Cross-links

`study-testing` (the eval seam), `study-performance-engineering` (`durationMs` as a budget), `study-distributed-systems` (the ordering tie), `study-agent-architecture` (the loop that emits the events).
