# Study — Debugging & Observability (buffr-laptop)

How this repo reveals its own behavior in development and production: reproduction, evidence, structured logs, metrics, traces, state snapshots, incidents, and prevention. Every claim is grounded in a real `file:line`.

The one-line verdict: buffr-laptop has **two observability investments that cover different ground, and a widening gap between them**. The trace / structured event stream (`CapabilityEvent` → `agents.messages`) captures the full `/ask` agent trajectory — all six event variants — into a replayable table. `/research` and `/investing` got a genuinely good live per-step progress panel this pass, but it's live-only: their model calls never reach any durable table. Outside those two mechanisms, observability is `process.stdout.write` and nothing more — and this pass shipped real evidence of what that costs: three concurrency bugs diagnosable only by watching the process hang, fixed with zero new diagnostics.

## Reading order

1. **`00-overview.md`** — the repo-grounded evidence map, ranked findings, and the explicit `not yet exercised` list. Start here.
2. **`audit.md`** — Pass 1. The 8-lens audit. One `##` per lens; honest `not yet exercised` where a lens finds nothing. Includes two debugging case studies (a whole-branch code review, and three concurrency bugs) and ends with the ranked red-flags audit.
3. **Pass 2 — the discovered-pattern files** (each uses the full concept-file template):
   - `01-full-signal-trajectory-capture.md` — the load-bearing durable pattern, `/ask`-only. All 6 `CapabilityEvent` types persisted to `agents.messages`; the cause (`args`), the result (`result`/`error`/`durationMs`), and token usage all captured.
   - `02-client-timestamp-ordering.md` — replay order driven by `event.timestamp` written into `created_at`, not server `now()`. The deterministic-order win, and the same-millisecond tie residual.
   - `03-stdout-as-only-log.md` — `process.stdout.write` as the entire logging surface outside the trace table. What this costs you in production — now with three shipped concurrency bugs as evidence.
   - `04-eval-numbers-as-quality-signal.md` — P@1 / R@3 printed by the eval CLI as the only retrieval-quality observability the repo has.
   - `05-live-progress-panel.md` — the new pattern. A typed `ProgressEvent` stream fired per connector fetch and per pipeline stage, rendered live for `/research`/`/investing`. Genuinely good UX; also the file that names the gap it doesn't close — no durable trace for either pipeline's model calls.

## Cross-links to neighboring guides

This guide owns *explaining behavior with evidence*. Neighbors own the adjacent mechanisms — cross-linked, not re-taught:

- **`study-testing`** — catches *known* failure conditions before release; this guide explains *unknown* behavior after the fact. The eval set (`eval/queries.json`, scored in `04-`) is the seam where the two meet.
- **`study-performance-engineering`** — owns `durationMs` *as a latency budget and bottleneck signal*; this guide owns it as a *trace field that explains a slow turn*.
- **`study-distributed-systems`** — owns the ordering/consistency theory behind the same-millisecond tie in `02-`; this guide owns it as a *replay-fidelity* concern.
- **`study-agent-architecture`** — owns the agent loop (`RagQueryAgent`, `run-agent-loop`) that *emits* the events; this guide owns the *sink* that persists them (`/ask`) and the *panel* that shows them live (`/research`, `05-`).
- **`study-frontend-engineering`** — owns the React state-management mechanics `05-` documents (the ref-mirror-for-stale-closures technique) as a general pattern; this guide owns it as the fix for a specific observability bug.
