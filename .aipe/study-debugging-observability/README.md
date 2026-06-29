# Study — Debugging & Observability (buffr-laptop)

How this repo reveals its own behavior in development and production: reproduction, evidence, structured logs, metrics, traces, state snapshots, incidents, and prevention. Every claim is grounded in a real `file:line`.

The one-line verdict: buffr-laptop has **one strong observability surface and almost nothing else**. The trace / structured event stream (`CapabilityEvent` → `agents.messages`) captures the full agent trajectory — all six event variants — into a replayable table. Outside that table, observability is `process.stdout.write` and nothing more: no metrics, no distributed tracing, no log levels, no error tracking, no health checks.

## Reading order

1. **`00-overview.md`** — the repo-grounded evidence map, ranked findings, and the explicit `not yet exercised` list. Start here.
2. **`audit.md`** — Pass 1. The 8-lens audit. One `##` per lens; honest `not yet exercised` where a lens finds nothing. Ends with the ranked red-flags audit.
3. **Pass 2 — the discovered-pattern files** (each uses the full concept-file template):
   - `01-full-signal-trajectory-capture.md` — the load-bearing pattern. All 6 `CapabilityEvent` types persisted to `agents.messages`; the cause (`args`), the result (`result`/`error`/`durationMs`), and token usage all captured.
   - `02-client-timestamp-ordering.md` — replay order driven by `event.timestamp` written into `created_at`, not server `now()`. The deterministic-order win, and the same-millisecond tie residual.
   - `03-stdout-as-only-log.md` — `process.stdout.write` as the entire logging surface outside the trace table. What this costs you in production.
   - `04-eval-numbers-as-quality-signal.md` — P@1 / R@3 printed by the eval CLI as the only retrieval-quality observability the repo has.

## Cross-links to neighboring guides

This guide owns *explaining behavior with evidence*. Neighbors own the adjacent mechanisms — cross-linked, not re-taught:

- **`study-testing`** — catches *known* failure conditions before release; this guide explains *unknown* behavior after the fact. The eval set (`eval/queries.json`, scored in `04-`) is the seam where the two meet.
- **`study-performance-engineering`** — owns `durationMs` *as a latency budget and bottleneck signal*; this guide owns it as a *trace field that explains a slow turn*.
- **`study-distributed-systems`** — owns the ordering/consistency theory behind the same-millisecond tie in `02-`; this guide owns it as a *replay-fidelity* concern.
- **`study-agent-architecture`** — owns the agent loop (`RagQueryAgent`, `run-agent-loop`) that *emits* the events; this guide owns the *sink* that persists them.
