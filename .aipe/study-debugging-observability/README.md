# Study — Debugging & Observability (buffr-laptop)

How this repo reveals its own behavior. The whole observability surface here is
one thing: the **trace sink** that turns the agent's run into rows in
`agents.messages`. That table *is* the trace store. Everything else (stdout
prints from the CLIs, Ink's per-turn catch) is thinner than it looks.

## Reading order

1. `00-overview.md` — the map, the ranked findings, what's `not yet exercised`.
2. `audit.md` — Pass 1. The 8-lens walk. Read this to see every boundary checked
   and the honest blanks (no metrics, no log levels, no Sentry, no health checks).
3. The pattern files (Pass 2), each a full walkthrough of one mechanism the repo
   actually exercises:
   - `01-full-signal-trajectory-capture.md` — all 6 `CapabilityEvent` types
     persisted; `messages` becomes a replayable trajectory.
   - `02-client-timestamp-ordering.md` — `created_at` comes from the event, not
     `now()`, so replay order is deterministic. Plus the one-millisecond-tie edge.
   - `03-stdout-as-only-log.md` — the index/eval CLIs and Ink all log via
     `process.stdout.write`. No levels, no structure, no correlation.
   - `04-eval-numbers-as-quality-signal.md` — P@1 / R@3 as the repo's only
     numeric SLI, and why it's an offline batch metric, not a production signal.

## Cross-links to neighboring guides

- **study-testing** — catches *known* failure conditions before release; this
  guide explains *unknown* behavior after the fact. The eval set
  (`eval/queries.json`) is the seam they share: `04-eval-numbers-as-quality-signal.md`
  treats it as an observability signal; testing treats it as a regression gate.
- **study-performance-engineering** — owns the `durationMs` and token *budgets*;
  this guide only notes that those numbers are *captured*
  (`01-full-signal-trajectory-capture.md`) and where they live.
- **study-distributed-systems** — owns the timestamp-vs-sequence ordering problem
  in general; `02-client-timestamp-ordering.md` cross-links it for the
  same-millisecond-tie edge.
- **study-agent-architecture** — owns the agent loop itself (ReAct, tool policy,
  synthesis turn); this guide only reads the *events* that loop emits.
