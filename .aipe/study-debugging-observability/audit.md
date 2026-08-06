# Audit — Debugging & Observability (Pass 1)

The 8-lens walk. Each lens names what buffr-laptop actually does, grounded in `file:line`, or emits `not yet exercised`. The final lens ranks the blind spots by consequence.

The through-line: *when behavior is wrong, what evidence exists to explain it quickly and prevent recurrence?* For buffr the honest answer got more interesting this pass: there are now **two** pipelines with genuinely different observability maturity running in the same codebase, plus a live case study in finding bugs *without* any evidence trail at all.

---

## 1. observability-map

The evidence map — what can be observed at each boundary.

```
  Signal availability by boundary

  boundary                     signal that exists              gap
  ───────────────────────────  ──────────────────────────────  ─────────────
  CLI → user (index/eval)      process.stdout.write text       no level/field
  chat UI → user                OpenTUI render + caught error   not persisted
  chat UI → spinner (live)      onStatus (tool name) · elapsed  —
                                 timer · onTokens (per model call)
  chat UI → progress panel      onProgress: per-connector +     —
  (/research, /investing)       per-stage running/done/failed
  session → agent (/ask)        trace.emit() per event          —
  mutable-slot → TUI            currentOnStatus/currentOnTokens swapped per ask
  sink → agents.messages        one INSERT per CapabilityEvent  same-ms tie
  agent → Ollama (/ask)         model_usage tokens (in trace)   no span/latency
  Analyzer/Teacher → Ollama     NOTHING — no trace param passed  zero durable
  (/research, /investing)                                       record, ever
  agent → web APIs (connectors) onEvent fires; result in trace  no latency span
  pipeline → Postgres (pg)      none (pool errors uncaught)     no query log
```

Two rows are new and change the shape of this map. **The progress panel** (`chat UI → progress panel`) is a genuinely new live signal — a typed `ProgressEvent` stream fired per connector and per pipeline stage, rendered as a per-step list that updates while `/research`/`/investing` run. **The Analyzer/Teacher row is the sharpest new finding this pass**: unlike `/ask`, which is fully traced end to end, `/research`'s and `/investing`'s LLM calls (Analyzer, Teacher) go through the identical `runAgentLoop` kernel *without* a `trace` option — `packages/capabilities/src/analyzer/index.ts:115-123` and `packages/capabilities/src/teacher/index.ts:100-123` both omit it. `AgentContext` (`packages/contracts/src/index.ts:1`) carries only a `traceId: string` — a label, not a sink — so there is structurally no way for these capabilities to reach `agents.messages` even if someone wanted them to. → see `05-live-progress-panel.md` for the deep walk, including the dead-token-counter consequence of this same gap.

The strong boundary remains **session → sink → storage** for the `/ask` path: `src/session.ts:62-63` runs `agent.answer()` then `trace.flush()`; `src/supabase-trace-sink.ts:53` is where every event becomes a row. That boundary hasn't changed this pass. → `01-full-signal-trajectory-capture.md`.

The weak boundaries are now three, not two: the two external hops (agent→Ollama for `/ask`, pipeline→Postgres) plus the entire `/research`/`/investing` model-call surface, which isn't "weak" so much as structurally absent.

## 2. reproduction-and-evidence

Minimal reproduction, hypotheses, controlled experiments, evidence collection.

buffr's reproduction story is **replay from `agents.messages` — for `/ask` only.** Because `created_at` carries the event timestamp (`src/supabase-trace-sink.ts:54`, written through `persistMessage` at `:26,30` via `coalesce($8::timestamptz, now())`), you can `SELECT * FROM agents.messages WHERE conversation_id = $1 ORDER BY created_at` and see the exact trajectory in emit order. That's a real controlled-experiment substrate for `/ask` — you can diff a bad turn against a good one field by field.

**`/research` and `/investing` do not reproduce from any table.** No `agents.messages` rows are written for their Analyzer/Teacher calls (lens 1), so a bad research turn leaves nothing to `SELECT`. The only reproduction path is re-running the same topic and hoping the model's answer is similar enough — a materially weaker guarantee than `/ask`'s replay. The progress panel (`05-`) helps you see *that* a stage was slow or failed while it's running, but once the turn ends, that too is gone unless it's still visible in scrollback.

The controlled experiment the repo *does* ship, unchanged this pass, is the eval harness: `src/cli/eval-cmd.ts` runs a fixed labeled set (`eval/queries.json`) through `pipeline.query()` and scores P@1 / R@3 (`:26-33`). That's a reproducible retrieval experiment with a baseline. → `04-eval-numbers-as-quality-signal.md`.

**A new reproduction *method* shows up this pass, and it's worth naming as its own category: whole-branch code review.** `41ecce8` closed 5 bugs found by reading the entire branch's diff against its own spec and sibling code — none of the 5 had a stack trace, a user report, or a log line pointing at them; they were caught before ever executing. That's a different discipline than "reproduce a reported failure" — it's "find the failure before anyone reports it." → lens 7 has the full case study.

## 3. structured-logs-and-correlation

Events, levels, context, correlation IDs, redaction, and searchable fields.

Unchanged in shape from the prior pass, with one relevant addition: the number of call sites that catch-and-render-without-persisting has grown. `26f0e4b` added two-arg `.then(success, error)` handling to three more call sites in `chat.tsx` (the active-flow interceptor, `/research` start, `/review` start) — each renders `error: ${err.message}` into the transcript on failure, same shape as the original `/ask` error path, still not persisted anywhere durable. More surface area running the same non-structured pattern, not a new pattern.

**The trace table is still structured logging done right — for `/ask`.** Every row in `agents.messages` is a typed event with searchable columns: `role`, `content`, `tool_calls`, `tool_results`, `model`, `tokens_used`, `created_at` (`sql/001_agents_schema.sql`). The correlation ID is real and load-bearing: `conversation_id`, set once in `startConversation` (`src/supabase-trace-sink.ts:4-8`).

**Everything outside that table is unstructured**, and that surface now includes the entire `/research`/`/investing` model-call path (lens 1), not just the CLI stdout the prior audit flagged. `process.stdout.write` is still the CLI logger (`src/cli/index-cmd.ts:25`, `eval-cmd.ts:33`). No log levels, no JSON fields, no redaction pass. → `03-stdout-as-only-log.md`.

## 4. metrics-slis-slos-and-alerts

Signals, service-level indicators, objectives, alerts, thresholds.

`not yet exercised`. Still no counters, gauges, or histograms anywhere. The progress panel adds per-run counts (`connector-done` carries `count`, `stage-done` carries a score/finding count) but these are ephemeral UI props, not aggregated metrics — nothing sums "connector failure rate this week" or "mean Analyzer stage duration" across runs. The closest thing to an SLI remains the eval mean P@1 / R@3 printed by `eval-cmd.ts:35`, still a hand-run batch score with no objective or alert attached.

When it becomes relevant: unchanged from the prior audit — the first time buffr runs unattended or you want "p95 turn latency" or "tool-error rate this week" without hand-replaying a table (and, now, without the `/research` path having a table to replay at all). → `study-performance-engineering` owns the budget side of `durationMs`.

## 5. traces-and-request-lifecycles

Request lifecycles, spans, causal chains, latency attribution.

This lens now has to answer for two pipelines, and they diverge sharply.

**`/ask` is still buffr's strongest trace.** The `CapabilityEvent` stream is a real request-lifecycle trace: one turn produces an ordered chain from user question → tool calls → tool results → model usage → assistant step, persisted with a per-event `durationMs` on the tool side (`src/supabase-trace-sink.ts:67-72`). `tool_call_start` records the cause (`args`, `:62-66`); `tool_call_end` records the effect (`result`/`error`, `:67-72`). → `01-full-signal-trajectory-capture.md`.

**`/research` and `/investing` have a *live* trace and no *durable* one.** The `ProgressEvent` stream built this pass (`03e3dbd`, `4b18408`, `ff3cf19`, `ebe1e65`, `6031286`) gives real per-stage latency attribution *while the pipeline runs* — you can watch Analyzer take longer than Scorer in real time — but the moment the turn ends, none of it persists. Structurally, this is the same `runAgentLoop` kernel as `/ask` (`packages/kernel/src/workflow-runtime/run-agent-loop.ts`), wired two different ways: `RagQueryAgent` passes `trace` into it; `Analyzer`/`Teacher` don't (`packages/capabilities/src/analyzer/index.ts:115-123`). → `05-live-progress-panel.md` is the deep walk of the live half; the durable gap is named there too.

The event-timestamp mechanism underneath `/ask`'s trace (`event.timestamp` from `timestamp()`, `packages/kernel/src/tracing.ts:32-34`, threaded into every emit call in `run-agent-loop.ts:97,103,111,126`) is unchanged this pass. OpenTelemetry / distributed tracing across the Ollama or Postgres hops: still `not yet exercised`. → `02-client-timestamp-ordering.md`.

## 6. state-snapshots-and-debugging-boundaries

State inspection, network traces, error output, before/after snapshots.

The before/after snapshot mechanism for `/ask` is still `agents.messages` — each turn appends an immutable run of rows. For `/research`/`/investing`, the closest thing to a snapshot is the progress panel's frozen step list, attached to the completed turn (`chat.tsx:297,303`) so it survives in scrollback — a real improvement over the prior pass's total silence, but it's a UI artifact, not a queryable state snapshot (lens 1, lens 5).

**A new debugging boundary worth naming precisely: the freeze-on-exit bugs left no state snapshot of what was actually stuck.** Before `64f822f`, `/exit` or Ctrl+C could hang the CLI indefinitely if `pool.end()` didn't resolve — and there was no way to inspect *why* it was hanging: no pending-connection count, no query-in-flight log, nothing. The fix (`Promise.race([pool.end(), timeout])`, `src/session.ts:876-880`) makes the process exit reliably, but it still doesn't produce a snapshot of what was blocking — if the pool hangs again for a different reason, the operator gets the same "it just exits after N seconds" behavior with zero diagnostic content. This is the sharpest instance of `03-stdout-as-only-log.md`'s thesis showing up as a real, shipped bug rather than a hypothetical.

The chat UI error boundary (`chat.tsx`'s `.then(success, error)` sites, lens 3) still renders-not-persists. The silent memory-write swallow (`src/session.ts:64-69` region) is unchanged: a state-change that vanishes with zero evidence, by design.

The FALLBACK_ANSWER snapshot gap is also unchanged and still real: `RagQueryAgent.answer()` returns `finalText.trim() || FALLBACK_ANSWER` (`packages/kernel/src/agents/rag-query-agent.ts:86`) past the point where a `step` event would be emitted — `run-agent-loop.ts:103`'s `if (text) trace?.emit(...)` only fires on non-empty text, so an empty-synthesis turn has a user-visible answer with no corresponding row.

## 7. incident-analysis-and-prevention

Root cause, contributing conditions, remediation, regression guards, runbooks.

This lens has the most new evidence this pass — two real case studies, found by two entirely different methods.

### Case study A — whole-branch code review found 5 bugs with zero evidence trail

`41ecce8` closed five integration-seam bugs. None had a stack trace or a bug report; all were caught by re-reading the branch's diff against its own spec and sibling implementations. Root-cause categories, by bug:

```
  5 bugs from one whole-branch review — root cause categories

  bug                                    root-cause category
  ──────────────────────────────────────  ───────────────────────────────────
  chat.tsx: empty input blocked when a    guard too broad — didn't account
  flow is active (review-flow's blank-    for a valid empty-input case
  note prompt was unreachable)
  ──────────────────────────────────────  ───────────────────────────────────
  chat.tsx: uncaught dueReviewCount()     unguarded promise at module-scope
  rejection could crash the CLI pre-      startup — no .catch() on a fallible
  render (fresh DB / transient hiccup)    async call before first render
  ──────────────────────────────────────  ───────────────────────────────────
  engine.evaluate(): findings[0]! crash   unguarded non-null assertion —
  on empty findings array                 inconsistent with the sibling
                                           fallback pattern in the same fn
  ──────────────────────────────────────  ───────────────────────────────────
  InMemoryJournalStore.listDue: missing   contract-parity drift — the doc
  userId/workspaceId scope filter         comment said "both implementations
  (PgJournalStore had it)                 must do this identically"; one didn't
  ──────────────────────────────────────  ───────────────────────────────────
  research-flow PREDICTION_PROMPT:        spec-compliance gap — a required
  missing required score explanation      line, caught by re-reading the spec
```

Two bugs are edge-case guards (empty input, empty findings), one is a startup fail-fast risk, one is a **dual-implementation contract drift** — `InMemoryJournalStore` and `PgJournalStore` both implement `JournalStore` (`packages/kernel/src/journal/contracts.ts:67-71`), and the contract's own doc comment names the exact invariant that broke (`:61-65`) — and one is pure spec compliance, not a runtime defect at all. The common thread: **this is a discovery method distinct from reproduction (lens 2).** None of these bugs had ever executed in a way that produced evidence; they were found by comparing code against its own promises. That's a real, complementary debugging discipline worth naming: reproduction-and-evidence answers "what happened," whole-branch review answers "what will happen, before it does."

### Case study B — three concurrency bugs, diagnosed from symptom alone, fixed with zero new diagnostics

`64f822f`, `9c1b1e6`, and `26f0e4b` fixed three separate hang/freeze bugs, each diagnosable only by *observing the process not respond* — none left a log line to point at the cause.

- **`64f822f`** — `/exit` (or letting the process idle) could hang forever if `pool.end()` never resolved. Fixed by racing it against a timeout (`src/session.ts:876-880`) and adding a SIGINT handler with its own hard deadline.
- **`9c1b1e6`** — the SIGINT handler from the previous fix never actually ran, because `createCliRenderer({ exitOnCtrlC: false })` puts the terminal in raw mode, which captures Ctrl+C as raw bytes before it ever becomes a SIGINT signal at the OS level. A correctly-written signal handler was dead code because a config flag two layers up swallowed the signal it depended on. Fixed by handling Ctrl+C inside OpenTUI's own `useKeyboard` hook (`e.ctrl && e.name === 'c'`, `src/cli/chat.tsx:380-383`) instead of relying on `process.on('SIGINT', …)`.
- **`26f0e4b`** — three `.then(result => …)` call sites in `chat.tsx` (research/review flow submit and start) had no rejection handler. An engine-side error left `busy` stuck `true` and `activeFlow` stuck set — the input box stayed hidden forever, with no error rendered, because the single-argument `.then()` silently swallows a rejection. Fixed by switching to the two-arg `.then(success, error)` form already used at every other call site in the file.

**All three share a root cause thread and a common remediation gap.** Root cause: each is a place where an async operation (a pool close, a raw keypress, a flow promise) could stop responding without the surrounding code accounting for "what if this never resolves / never fires / rejects." Remediation gap: **none of the three fixes added a diagnostic.** The pool-close fix doesn't log "pool.end() timed out after Nms, forcing exit"; the rejection-handler fix doesn't log "flow promise rejected: `<message>`" anywhere durable. They make the symptom go away without leaving a trail — so the next time a *different* promise forgets its rejection handler, or a *different* cleanup call hangs, the operator is back to "the process just doesn't respond," with the exact same lack of evidence that made these three bugs hard to explain in the first place. This directly confirms `03-stdout-as-only-log.md`'s standing thesis with real, shipped evidence rather than a hypothetical.

### The regression guard and what's still missing

The regression guard the repo ships is unchanged: `eval/queries.json` scored by `eval-cmd.ts`, a retrieval-quality guard you can re-run after a change. → `study-testing` owns this seam; `04-eval-numbers-as-quality-signal.md` covers the observability read.

Runbooks, incident records, alerting on a guard: still `not yet exercised`. Contributing conditions with no incident trail, updated for this pass: a pg pool exhaustion (uncaught, `src/db.ts`), an Ollama outage during `/research`/`/investing` (would surface as a caught-and-rendered error with zero durable record, per lens 1's Analyzer/Teacher gap — worse than the `/ask` case, which at least might have a partial trace up to the point of failure), and any future async operation that forgets a rejection handler (Case study B's exact bug class, now fixed at 3 sites but not systemically guarded against — nothing lints for a bare single-argument `.then()`).

## 8. debugging-observability-red-flags-audit

Ranked blind spots by consequence, with the evidence for each verdict.

```
  Red flags — ranked by what they cost you

  rank  blind spot                          evidence                    cost
  ────  ──────────────────────────────────  ──────────────────────────  ──────────────────
   1    /research & /investing model calls  analyzer/index.ts:115-123   a whole engine's
        are structurally untraceable —      teacher/index.ts:100-123    LLM calls leave zero
        no `trace` param reaches            AgentContext has traceId    durable evidence,
        runAgentLoop; live token counter    only, no sink; session.ts   ever — bigger blind
        is wired but never fires             :729 vs :612-617            spot than #2
   2    FALLBACK_ANSWER fires no step        rag-query-agent.ts:86       trace lies: an
        event → no assistant row             (no trace.emit)             answered turn
                                              run-agent-loop.ts:103       looks unanswered
   3    same-millisecond timestamp tie,      tracing.ts:32-34 (ISO ms;   replay order
        no seq tiebreaker                     no counter)                 non-deterministic
                                              sink.ts:54                   within a ms
   4    concurrency fixes shipped with       64f822f/9c1b1e6/26f0e4b —   the fixed bug class
        zero new diagnostics — a hang        no log line added by any     can recur invisibly;
        still leaves no evidence trail        of the three fixes           nothing points at it
   5    caught errors/rejections rendered    chat.tsx (6+ call sites     a failed turn or
        but never persisted                  now, lens 3)                flow leaves no trail
                                              session.ts:64-69 (memory)
   6    no metrics / SLIs / alerts           (absent)                    no unattended
                                                                          health signal
   7    stdout is the only log surface       index-cmd.ts:25              no level, field,
        outside any trace                     eval-cmd.ts:33                or filter
   8    external hops untraced (Ollama for   (no pg/Ollama span)          can't attribute
        /ask, Postgres for all paths)                                     cross-service lat.
```

**1 — `/research`/`/investing` are structurally untraceable.** New top flag, and it outranks the FALLBACK_ANSWER gap because the scope is larger: not one edge case in one turn type, but *every* Analyzer and Teacher call across two entire engines, permanently. `AgentContext` (`packages/contracts/src/index.ts:1`) has no `trace` field to pass — this isn't a bug in one call site, it's the contract itself not carrying a sink. The live progress panel (`05-`) is genuinely good UX but doesn't change this: it's a window while the pipeline runs, not a record after. Fix would mean either widening `AgentContext` to optionally carry a `CapabilityTraceSink` (mirroring how `RagQueryAgent` receives one directly) or wiring `trace` through `Analyzer`/`Teacher`'s constructors the way `session.ts` already wires it through `RagQueryAgent`.

**2 — FALLBACK_ANSWER fires no `step` event.** Unchanged from the prior audit, re-verified against current paths: `finalText.trim() || FALLBACK_ANSWER` at `packages/kernel/src/agents/rag-query-agent.ts:86` returns past the trace; `run-agent-loop.ts:103`'s `if (text)` guard means an empty `finalText` never emits `step`. Fix lives partly in `@buffr/kernel` (consumed, not edited per `context.md`) — buffr-side remediation is still to persist the fallback answer as an `error`-tagged row in the sink's caller.

**3 — same-millisecond ordering tie.** Unchanged. `timestamp()` is `new Date().toISOString()` (`packages/kernel/src/tracing.ts:32-34`) — millisecond resolution, no monotonic sequence. → `02-`.

**4 — concurrency fixes added zero new diagnostics.** New flag, evidenced by `64f822f`, `9c1b1e6`, `26f0e4b` (lens 7, Case study B). Each fix masks the symptom (force-exit after a timeout, handle the rejection) without leaving a breadcrumb — the exact failure mode `03-stdout-as-only-log.md` predicted, now confirmed with three shipped bugs instead of a hypothesis.

**5 — caught errors leave no durable trail.** Broader surface than the prior audit: the `/ask` error catch, plus (after `26f0e4b`) three more `chat.tsx` call sites for research/review flows, plus the unchanged silent memory-write swallow (`session.ts:64-69`). All correct for resilience, none persist.

**6 — no metrics.** Unchanged. Defensible at current scope, first thing needed when buffr goes unattended.

**7 — stdout-only logging.** Unchanged. → `03-`.

**8 — external hops untraced.** Unchanged, though now understood to be the *smaller* of the two "untraced" gaps next to flag #1 — Ollama/Postgres latency is invisible, but at least `/ask`'s trace captures that a call happened; `/research`'s Analyzer/Teacher calls aren't captured at all.
