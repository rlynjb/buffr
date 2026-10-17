# Agent Implementation Mechanism Explainer

**Scope:** latest code-changing commit `b6352d3`, “feat: add single marketplace review command.” Later commits only modify documentation.

**Verification:** 43 focused tests pass across six files, and `npm run typecheck` passes.

## Table of Contents

1. [What Did The Agent Implement?](#1-what-did-the-agent-implement)
2. [FODE Data Engineering Lifecycle View](#2-fode-data-engineering-lifecycle-view)
3. [ASCII Data Flow Diagram](#3-ascii-data-flow-diagram)
4. [DDIA Mechanism Explanation](#4-ddia-mechanism-explanation)
5. [Functional Requirements Recovered From The Code](#5-functional-requirements-recovered-from-the-code)
6. [Nonfunctional Requirements Recovered From The Code](#6-nonfunctional-requirements-recovered-from-the-code)
7. [System Design View](#7-system-design-view)
8. [Algorithmic Thinking View](#8-algorithmic-thinking-view)
9. [Read Path and Write Path](#9-read-path-and-write-path)
10. [Failure and Concurrency Walkthrough](#10-failure-and-concurrency-walkthrough)
11. [Concept Glossary](#11-concept-glossary)
12. [Learning Summary](#12-learning-summary)

## 1. What Did The Agent Implement?

### Plain explanation

The agent replaced several owner-facing operational commands with one command:

```bash
npm run marketplace:review -- --profile merchgrid_shopify_app_store
```

That command now:

1. Resolves the product and target review date.
2. Determines the required 14-day evidence window.
3. Reuses complete daily snapshots.
4. Collects missing or incomplete snapshots from PostHog, Fly metrics, and Shopify Partner CSV.
5. Reuses or generates a weekly review artifact.
6. Combines that artifact with curated product/listing context.
7. Resolves the previous marketplace review cycle.
8. Creates or resumes the deterministic current workflow run.
9. Advances M1–M6 until the human approval boundary.
10. Persists a safe operation-level audit trail.

The main entry boundary is `src/cli/marketplace-visibility.ts`. The new orchestration façade is `src/workflow/marketplace-review.ts`, while evidence preparation lives in `src/workflow/marketplace-evidence-preparation.ts`.

### Files and modules involved

- `package.json`: replaces old commands with `marketplace:review`.
- `src/cli/marketplace-visibility.ts`: CLI parsing and runtime composition.
- `src/connectors/merchgrid/runtime.ts`: constructs the three metric-source adapters.
- `src/workflow/marketplace-evidence-preparation.ts`: fills the required snapshot window and builds evidence.
- `src/workflow/marketplace-review.ts`: operation-level coordinator and trace boundary.
- `src/workflow/marketplace-rolling-review.ts`: closes/resumes prior cycles and starts/resumes the current one.
- `src/storage/review-operations.ts`: persists pre-workflow and command-level JSONL events.
- `src/storage/metric-snapshots.ts`: existing snapshot store with per-file locking and immutable completed snapshots.
- `src/storage/runs.ts`: existing workflow-run persistence.
- Multiple unit, integration, end-to-end, and package-surface tests.

### Main data movement

```text
External metrics / local CSV
        -> normalized daily snapshots
        -> two adjacent seven-day aggregates
        -> weekly review artifact
        -> marketplace visibility evidence
        -> M1–M6 workflow modules
        -> run.json + experiment-plan.json
        -> safe CLI summary
```

### Main state changes

The command may write:

- Daily source snapshots.
- Daily health projections.
- A weekly review artifact.
- Operation-level `events.jsonl`.
- Workflow `run.json`.
- Workflow evidence projections.
- Workflow `events.jsonl`.
- An experiment plan.

### Deliberately not changed

The commit did not:

- Replace the deterministic workflow engine.
- Change the M1–M7 stage semantics.
- Delete internal source-pack functions.
- Add a database, queue, scheduler, dashboard, or distributed worker.
- Apply changes automatically to Shopify, Etsy, or another marketplace.
- Migrate or rewrite existing workflow runs.
- Store raw provider payloads, credentials, or full prompts.

### PR-style summary

This change consolidates Buffr’s marketplace-review lifecycle behind one owner command. It adds a synchronous evidence-preparation boundary that fills a bounded 14-day metric window, reuses or generates a weekly artifact, records safe operation-level events, and then delegates to the existing rolling-review coordinator and workflow engine. Deterministic source/date, operation, artifact, and run identifiers make ordinary sequential retries converge on the same durable records, while preserving manual approval and existing M1–M7 behavior.

---

## 2. FODE Data Engineering Lifecycle View

| Stage | Status | How it appears |
|---|---|---|
| Generation | Depends on existing sources; command trigger changed | Metrics originate in PostHog, Fly, and Shopify Partner CSV. The owner generates the review request through the new CLI command. |
| Ingestion | Changed | The marketplace command now constructs real source adapters and invokes them when snapshots are missing. |
| Storage | Changed and reused | Existing snapshot/run stores remain; operation-level JSONL persistence was added. |
| Transformation | Changed | A new service identifies missing snapshots, derives a 14-day window, builds/reuses a weekly aggregate, and combines it with product context. |
| Serving | Changed | One CLI command now serves the final run status, stage, artifact reference, and experiment-plan reference. |

### Lifecycle undercurrents

| Undercurrent | Effect |
|---|---|
| Security | Changed: trace fields are bounded, credential-shaped keys are rejected, and CLI errors avoid provider details. |
| Data management | Changed: deterministic lineage connects source/date snapshots, weekly artifacts, operation IDs, and run IDs. |
| DataOps | Changed: collection, preparation, audit events, and workflow execution become one operator action. Scheduling remains external. |
| Data architecture | Changed at the orchestration boundary; filesystem storage and contract-first design remain. |
| Orchestration | Significantly changed: the new façade coordinates collection, derivation, prior-run resolution, and workflow execution. |
| Software engineering | Changed: dependency-injected services and focused tests separate CLI, orchestration, storage, and provider I/O. |

---

## 3. ASCII Data Flow Diagram

```text
[Owner / Generation]
npm run marketplace:review -- --profile ... [--through ...]
                  |
                  v  synchronous call
[CLI Boundary]
runMarketplaceVisibilityCli()
  - validates options/profile
  - loads configured context path
  - resolves productRef and through
                  |
                  v
[Operation Coordinator]
createMarketplaceReviewService().review()
  - operationId =
    marketplace-review:<profile>:<productRef>:<through>
  - writes bounded operation events
                  |
                  v
[Evidence Preparation]
createMarketplaceEvidencePreparationService().prepare()
  - validates UTC date and product identity
  - derives window: through-13 ... through
                  |
                  v
[Snapshot Read Path]
JsonFileMetricSnapshotRepository.list()
  snapshots/<source>/<date>.json
  SOURCE OF TRUTH: complete daily source/date records
                  |
             missing/noncomplete?
              /             \
            no               yes
            |                 |
            |                 v  synchronous external I/O
            |        [Source Adapters]
            |        PostHog API
            |        Fly Metrics API
            |        Shopify Partner CSV
            |                 |
            |                 v
            |        collectSourcePack()
            |        fixed source order + timeout
            |                 |
            |                 v
            |        JsonFileMetricSnapshotRepository.save()
            |        per-file lock + atomic rename
            +-----------------+
                  |
                  v
[Weekly Transformation]
runWeeklyReview()
  - previous seven days
  - current seven days
  - sums count metrics
  - derives rates
  - calculates comparable changes
                  |
                  v
[Weekly Artifact]
artifacts/weekly-reviews/<through>.json
DERIVED DATA: reused if already valid; generated only if absent
                  |
                  v
[Read-Time Composition]
buildRollingVisibilityEvidence()
  weekly artifact
  + product context
  + optional listing context
  -> MarketplaceVisibilityEvidence
                  |
                  v
[Rolling Review Coordinator]
nextReview(preparedEvidence)
  - deterministic cycle run ID
  - resolve previous run
  - create or resume current run
                  |
                  v
[Workflow Engine]
M1 -> M2 -> optional M3 -> M4 -> M5 -> M6
                  |
                  v
[Workflow Storage]
workflow-runs/<runId>/run.json       SOURCE OF TRUTH
workflow-runs/<runId>/events.jsonl   derived projection
workflow-runs/<runId>/experiment-plan.json
                  |
                  v
[Serving]
CLI prints artifact, prior-run resolution,
run ID, status, stage, and plan reference

Separate observability write path:
all preparation/source events
        -> review-operations/<encoded-operationId>/events.jsonl

No database, cache, secondary index, queue, topic, or background worker.
```

### Step-by-step flow

1. The CLI accepts only `review`, requires `--profile`, and optionally accepts `--through`.
2. If `--through` is absent, the snapshot repository is scanned for the newest complete 14-day window.
3. The façade creates a deterministic operation ID and records `marketplace_review.started`.
4. Evidence preparation validates the date and derives 14 dates.
5. Existing snapshots are loaded into a `Map<source/date, snapshot>`.
6. Each missing or noncomplete source/date is collected.
7. Source failures become bounded failed snapshots rather than leaked provider errors.
8. Preparation rechecks the entire 42-snapshot requirement: 14 dates × 3 sources.
9. The weekly artifact is loaded or generated.
10. Product context and optional listing context are joined in memory with the weekly artifact.
11. The resulting evidence is handed directly to the rolling review, avoiding duplicate preparation.
12. The rolling coordinator resolves prior state and advances the current deterministic run.
13. The CLI receives a compact result; the full state stays in artifacts.

### Representative field trace: `through`

1. **Origin:** `--through 2026-09-04`, or `resolveLatestCompleteWeeklyThrough()`.
2. **CLI:** passed as an unrenamed `through` field from `src/cli/marketplace-visibility.ts`.
3. **Validation:** parsed by `UtcDateSchema` and rejected unless it represents a completed UTC day in `src/workflow/marketplace-evidence-preparation.ts`.
4. **Window derivation:** transformed into `windowStart = through - 13 days` and `windowEnd = through`.
5. **Operation identity:** embedded in `marketplace-review:<profile>:<productRef>:<through>` by `src/storage/review-operations.ts`.
6. **Artifact key:** mapped to `weekly-reviews/<through>.json`.
7. **Evidence identity:** mapped to `subjectRef = merchgrid:visibility:<through>` in `src/workflow/marketplace-visibility-profile.ts`.
8. **Workflow identity:** mapped to `<through>-<profile>-<productRef>` by `rollingVisibilityRunId()`.
9. **Serving:** represented indirectly through the weekly artifact path and current run ID.

The product/listing context is a **read-time join** with the weekly artifact. The weekly artifact itself is a **persisted derived copy** of daily snapshots. Its refresh mechanism is “generate when absent, otherwise reuse”; there is no automatic invalidation or recomputation of an existing valid artifact.

---

## 4. DDIA Mechanism Explanation

### Mechanism: Data model and query shape

**Where it appears in the code:** Snapshot keys are `source/date`; weekly artifacts are keyed by `through`; operations use `profile/productRef/through`; runs use deterministic cycle IDs.

**What guarantee it provides:** Logical identities map predictably to filesystem records.

**What it does NOT guarantee:** Efficient ad hoc queries or multi-dimensional filtering.

**Failure mode:** `findLatestByProduct()` scans and parses every run directory; performance declines as run count grows.

**Developer vocabulary to remember:** Composite key, access pattern, point lookup, full scan.

### Mechanism: Filesystem storage and atomic replacement

**Where it appears:** `src/storage/metric-snapshots.ts`, `src/storage/runs.ts`, and `src/storage/review-operations.ts`.

**What guarantee it provides:** A reader generally sees either the previous complete file or the newly renamed file, not a partially written JSON document.

**What it does NOT guarantee:** Atomicity across snapshots, artifacts, operation events, workflow state, and external calls.

**Failure mode:** A crash can leave a durable prefix of the operation—for example, snapshots and a weekly artifact without a completed workflow.

**Developer vocabulary to remember:** Atomic file replacement, crash consistency, multi-record transaction.

### Mechanism: Runtime schemas and serialization

**Where it appears:** Zod contracts such as `UtcDateSchema`, `DailyMetricSnapshotSchema`, `WorkflowEventSchema`, and `WorkflowRunStateSchema`.

**What guarantee it provides:** Persisted and boundary-crossing values conform to expected shapes and identities.

**What it does NOT guarantee:** Backward-compatible schema evolution. There is no explicit schema version or migration framework.

**Failure mode:** A deployment with an incompatible schema may reject previously persisted JSON.

**Developer vocabulary to remember:** Runtime validation, serialization contract, backward compatibility, schema migration.

### Mechanism: Idempotency through deterministic identities

**Where it appears:** Deterministic operation IDs, immutable source/date snapshots, weekly artifact reuse, and deterministic workflow run IDs.

**What guarantee it provides:** An ordinary sequential retry converges on the same snapshot keys, weekly artifact, and workflow run.

**What it does NOT guarantee:** Exactly-once external calls or exactly-once operation events. Repeated command attempts append repeated operation-level events.

**Failure mode:** A crash after an external/model call but before durable run state can cause that call to run again.

**Developer vocabulary to remember:** Idempotent state transition, deterministic key, at-least-once side effect, exactly-once illusion.

### Mechanism: Concurrency control

**Where it appears:** Snapshot files use lock directories; experiment-application mutation uses an in-memory per-run promise lock.

**What guarantee it provides:** Local snapshot writers serialize by source/date. Application decisions serialize within one engine process.

**What it does NOT guarantee:** Multi-process workflow serialization or distributed locking. Operation JSONL appends have no lock.

**Failure mode:** Concurrent CLI processes can overwrite workflow progress or lose operation events through read-modify-write races.

**Developer vocabulary to remember:** Critical section, local mutex, process-local lock, lost update.

### Mechanism: Derived data and materialized projections

**Where it appears:** Weekly review artifacts, `events.jsonl`, evidence files, and `experiment-plan.json`.

**What guarantee it provides:** Expensive or complex transformations become inspectable and reusable.

**What it does NOT guarantee:** Automatic refresh after transformation logic changes.

**Failure mode:** A valid existing weekly artifact remains reused even if a newer version of aggregation code would produce a different projection.

**Developer vocabulary to remember:** Materialized view, source of truth, projection, invalidation.

### Mechanism: Bounded batch/backfill processing

**Where it appears:** Evidence preparation traverses exactly 14 dates and three sources.

**What guarantee it provides:** The command repairs only the finite window required by the requested review.

**What it does NOT guarantee:** Arbitrary historical backfill or continuous ingestion.

**Failure mode:** Large historical gaps outside the current window remain untouched.

**Developer vocabulary to remember:** Bounded backfill, batch window, completeness check.

### Mechanism: Fault containment

**Where it appears:** Provider failures are converted into normalized failed snapshots, then preparation performs a final completeness gate.

**What guarantee it provides:** One provider’s raw exception does not leak through contracts or traces; other source attempts can still run.

**What it does NOT guarantee:** Availability of the review when any required source remains incomplete.

**Failure mode:** A single required failed snapshot prevents the weekly artifact and workflow mutation.

**Developer vocabulary to remember:** Failure normalization, fail closed, partial result.

### Mechanism: Observability

**Where it appears:** `marketplace_review.*`, `merchgrid.source.*`, `rolling_review.*`, and workflow events.

**What guarantee it provides:** The local operator can reconstruct which evidence was reused, collected, generated, or rejected.

**What it does NOT guarantee:** Centralized monitoring, alerting, metrics, distributed tracing, or immutable event history.

**Failure mode:** Concurrent event writers may lose events; a corrupt JSONL file makes the operation log unreadable.

**Developer vocabulary to remember:** Audit trail, structured event, trace correlation, observability projection.

### Mechanism: Maintainability through narrow boundaries

**Where it appears:** Separate CLI, review façade, evidence-preparation service, rolling coordinator, workflow engine, repositories, and adapters.

**What guarantee it provides:** Each layer can be tested with fake clocks, adapters, prompts, and repositories.

**What it does NOT guarantee:** Low conceptual complexity across the whole workflow.

**Failure mode:** Similar identity/date validation across layers can drift if contracts change inconsistently.

**Developer vocabulary to remember:** Dependency inversion, composition root, façade, information hiding.

Replication, replica lag, sharding, CDC, queues, and distributed coordination are not implemented.

---

## 5. Functional Requirements Recovered From The Code

### FR1 — One public marketplace review command

- **Status:** Confirmed
- **Evidence:** `marketplace:review` exists; old marketplace/source-pack commands are removed.
- **Responsible module:** CLI and `package.json`.
- **Input:** `review --profile ... [--through ...]`.
- **Output:** Safe run/artifact summary.
- **State change:** Delegates to the review service.
- **Error behavior:** Unknown verbs/options fail validation.
- **Tests:** Package-surface and 27 CLI tests.

### FR2 — Prepare a complete two-week evidence window

- **Status:** Confirmed
- **Evidence:** `through - 13` through `through`, across three sources.
- **Responsible module:** `createMarketplaceEvidencePreparationService()`.
- **Input:** Product identity, date, and context paths.
- **Output:** `PreparedMarketplaceEvidence`.
- **State change:** Missing/noncomplete snapshots may be collected and saved.
- **Error behavior:** Any remaining gap throws `storage_failed`.
- **Tests:** Reuse, missing-source collection, incomplete coverage, and future-date cases.

### FR3 — Reuse or generate the weekly artifact

- **Status:** Confirmed
- **Evidence:** `loadWeeklyReview()` precedes `runWeeklyReview()`.
- **Responsible module:** Evidence-preparation service.
- **Input:** Complete 14-day snapshot set.
- **Output:** Weekly artifact and `reused | generated` status.
- **State change:** Writes the artifact only when absent.
- **Error behavior:** Corrupt stored artifacts fail during repository validation.
- **Tests:** Existing-artifact reuse and absent-artifact generation.

### FR4 — Hand prepared evidence to the rolling workflow

- **Status:** Confirmed
- **Evidence:** `preparedEvidence` was added to `RollingReviewInput`.
- **Responsible module:** Review façade and rolling coordinator.
- **Input:** Validated marketplace visibility evidence.
- **Output:** Prior-run resolution and current-run summary.
- **State change:** May close a prior run and create/resume the current run.
- **Error behavior:** Unresolved or invalid prior states produce `route_not_allowed`.
- **Tests:** Unit and persisted end-to-end review tests.

### FR5 — Preserve evidence-preparation failures before a workflow exists

- **Status:** Confirmed
- **Evidence:** Operation events use an ID independent of workflow run creation.
- **Responsible module:** `JsonFileReviewOperationEventRepository`.
- **Input:** Bounded `WorkflowEvent`.
- **Output:** Ordered JSONL records.
- **State change:** Appends command/preparation events.
- **Error behavior:** Corrupt JSONL becomes `storage_failed`.
- **Tests:** Missing operation, ordered append/load, corruption, and credential rejection.

### FR6 — Make sequential retries converge

- **Status:** Confirmed, with bounded semantics
- **Evidence:** E2E test invokes the same review twice and receives the same run ID; the second invocation reuses the artifact and does not recollect the missing source.
- **Responsible modules:** Snapshot repository, evidence preparation, and rolling coordinator.
- **Input:** Same `profile + productRef + through`.
- **Output:** Same workflow cycle.
- **State change:** Operation events may still be appended again.
- **Error behavior:** Conflicting completed snapshot content is rejected.
- **Tests:** Persisted E2E retry test.

### FR7 — Keep raw/private data outside traces and CLI output

- **Status:** Confirmed for tested key patterns
- **Evidence:** Credential-key guards, strict schemas, bounded event fields, and safe CLI errors.
- **Responsible modules:** Contracts, guards, event construction, CLI.
- **Input:** Events, snapshots, and exceptions.
- **Output:** Safe status codes and high-level fields.
- **State change:** Unsafe structured data is rejected.
- **Error behavior:** Validation failure.
- **Tests:** Prohibited key/string checks in CLI, preparation, façade, and storage tests.

---

## 6. Nonfunctional Requirements Recovered From The Code

| Requirement | Evidence and DDIA concept | Support | Risk or missing mechanism |
|---|---|---|---|
| Reliability | Reuse, final completeness gate, deterministic IDs | Good for sequential local execution | No command-wide transaction |
| Consistency | Immutable completed snapshots and identity checks | Strong per snapshot and run contract | Weak across multiple files |
| Durability | JSON/JSONL files with atomic rename | Appropriate for local operation | No fsync or replicated storage |
| Data freshness | Completed UTC dates only; explicit `through` | Clear time boundary | Existing artifact is reused without recalculation |
| Ordering | Source collection is fixed-order and awaited | Deterministic in one process | Concurrent event writers are unsafe |
| Security/privacy | Sensitive-key scanning and bounded traces | Strong defense-in-depth for structured data | Pattern-based controls cannot prove all semantic privacy |
| Operability | Single command and layered audit trail | Strong local inspectability | No scheduler, alerts, or centralized telemetry |
| Maintainability | Narrow services and dependency injection | Good testability | Cross-layer identity rules remain conceptually dense |
| Evolvability | Existing engine and source pack are reused | New sources/services can implement interfaces | Persisted schemas lack versions/migrations |
| Latency | Synchronous, sequential missing-source collection | Predictable control flow | No SLA; latency grows with missing source/date count |
| Throughput | Designed for one local operator | Adequate for current scope | Unsupported concurrent CLI writers |
| Scalability | Bounded 42-snapshot review window | Work per review is bounded | Run-history lookup scans all runs; no DB/index |
| Availability | Provider failure becomes a bounded snapshot | Failure is diagnosable | Required-source failure blocks the review |

Traffic volume, read/write ratio, latency targets, uptime targets, and maximum run count are not specified.

---

## 7. System Design View

### Requirements and constraints

The design solves an operator-experience problem: the owner should request “perform the next marketplace review,” not manually coordinate collection, aggregation, and workflow commands.

Visible constraints:

- Local, self-hosted, single-owner execution.
- TypeScript and filesystem persistence already exist.
- Three known source types.
- Exactly two adjacent seven-day windows are required.
- Human approval remains mandatory.
- The workflow engine owns legal lifecycle transitions.
- External source and model calls can fail.
- Concurrent CLI processes are explicitly unsupported.
- Scale and availability targets are not specified.

### Design decision: Synchronous façade over existing subsystems

**Evidence in code:** `MarketplaceReviewService.review()` awaits evidence preparation and then rolling review.

**Requirement it addresses:** One owner action with a clear result.

**Tradeoff:** Simple control flow and immediate errors, but command latency includes all source and model calls.

**When it stops working well:** Long-running collection, many products, or multiple operators.

**Alternative:** Queue a review operation and process it asynchronously with a worker.

**Review question:** Does the owner need immediate completion, or only an accepted operation ID and later status?

### Design decision: Prepare complete evidence before workflow mutation

**Evidence in code:** `evidence.prepare()` finishes before `rollingReviews.nextReview()`.

**Requirement it addresses:** Do not close or create workflow runs using incomplete weekly evidence.

**Tradeoff:** Clear invariant and simpler recovery, but evidence work may be wasted if the later workflow fails.

**When it stops working well:** Evidence preparation becomes expensive and workflow rejection is frequent.

**Alternative:** Persist an explicit operation state machine with resumable preparation and workflow phases.

**Review question:** Is “complete 42-snapshot coverage” always required, or should some profiles tolerate partial evidence?

### Design decision: Deterministic IDs instead of caller-provided IDs

**Evidence in code:** Operation and cycle IDs derive from `profile + productRef + through`.

**Requirement it addresses:** Retry safety and accidental duplicate prevention.

**Tradeoff:** Simple deduplication, but only one logical review can exist for that composite key.

**When it stops working well:** Multiple review variants need the same product/date combination.

**Alternative:** Add a review-version, policy-version, or explicit idempotency key.

**Review question:** Is `profile + productRef + through` permanently sufficient to distinguish logical reviews?

### Design decision: Local files rather than a database

**Evidence in code:** JSON snapshots, JSON artifacts, JSONL events, and directory scans.

**Requirement it addresses:** Inspectable, low-dependency local operation.

**Tradeoff:** Easy testing and debugging; limited concurrency, indexing, transactions, and schema migration.

**When it stops working well:** Hosted multi-user access, large run history, parallel workers, or account isolation.

**Alternative:** SQL database with unique constraints and transactional operation/run records.

**Review question:** What usage milestone would justify moving from local files to SQL?

### Design decision: Materialize weekly evidence

**Evidence in code:** Weekly artifacts are persisted and reused.

**Requirement it addresses:** Stable lineage, inspectability, and retry performance.

**Tradeoff:** Avoids recomputation but introduces invalidation/versioning questions.

**When it stops working well:** Aggregation logic changes while old artifact keys remain valid.

**Alternative:** Store an aggregation/schema version in artifact metadata and rebuild when versions differ.

**Review question:** What makes an existing weekly artifact valid after code or contract changes?

### Design decision: Separate operation events from workflow events

**Evidence in code:** Pre-workflow events use `review-operations/<operationId>/events.jsonl`; workflow events remain inside run storage.

**Requirement it addresses:** Preserve evidence of failures before `run.json` exists.

**Tradeoff:** Better auditability, but related history is split across two event stores.

**When it stops working well:** Operators need cross-operation search, global ordering, or centralized analytics.

**Alternative:** One append-only event table keyed by operation and workflow IDs.

**Review question:** Which record is authoritative when operation events and workflow state disagree?

### High-level walkthrough

This is a small local workflow system, not a distributed platform. A synchronous CLI command invokes a façade. The façade first constructs a complete, validated evidence package from immutable daily snapshots and a reusable weekly projection. It then gives that package to the existing rolling state machine. Deterministic identities provide sequential retry safety; local files provide inspectability; human approval remains the boundary before real-world action.

---

## 8. Algorithmic Thinking View

### Computational problem

**Input:** Product identity, completed UTC `through` date, context paths, existing snapshots/artifacts/runs, and potentially external source responses.

**Output:** One prepared weekly evidence packet and one current workflow-run summary.

**Constraints:**

- Three required sources.
- Fourteen consecutive dates.
- Every source/date must be complete.
- Completed snapshots are immutable.
- Dates must be closed in UTC.
- Product, evidence, and run identities must agree.
- Prior workflow state restricts legal transitions.

### Subproblem 1: Find and fill missing source/date coverage

**Code location:** `src/workflow/marketplace-evidence-preparation.ts`

**Approach/pattern:** Fixed-range traversal plus hash lookup.

**Pseudocode:**

```text
snapshots = map existing records by "source/date"

for each date in 14-day window:
    missing = sources whose snapshot is absent or noncomplete

    if missing is nonempty:
        collect that date
        reload the date

recheck all 42 required keys
fail if any is not complete
```

**Correctness invariant:** Before weekly aggregation begins, every required `source/date` key maps to a complete snapshot.

**Time complexity:** Let `D` be dates, `S` sources, `F` listed files, and `M` missing source/date pairs. Local inspection is approximately `O(F + D×S)`. External latency is proportional to the sequential collection of `M` missing pairs and cannot be treated as constant time.

**Space complexity:** `O(D×S)` snapshot references.

**Edge cases:** Future date, malformed date, partial snapshot, failed adapter, missing adapter, corrupt file.

**Alternative:** Issue `D×S` point loads instead of listing source directories, or batch source APIs by date range.

**Recognition cue:** Use a map when completeness is defined over a Cartesian product such as `sources × dates`.

### Subproblem 2: Aggregate and compare adjacent weekly windows

**Code location:** `src/metrics/summaries.ts`

**Approach/pattern:** Group by date and source, accumulate counts, derive rates, then compare equal metrics.

**Correctness invariant:** Both periods contain exactly seven consecutive dates, and change values are produced only when both periods have complete metric coverage.

**Time complexity:** `O(D×S×K)`, where `K` is the average metrics per snapshot.

**Space complexity:** `O(D×S + S×K)`.

**Edge cases:** Duplicate source/date snapshots, nonconsecutive dates, zero denominators, metrics missing in one period.

**Alternative:** Streaming aggregation could reduce intermediate maps, but the current bounded data size makes clarity more valuable.

**Recognition cue:** When comparing time windows, validate window shape before computing deltas.

### Subproblem 3: Converge retries on one workflow cycle

**Code location:** `src/workflow/marketplace-rolling-review.ts`

**Approach/pattern:** Deterministic key plus state-machine traversal.

**Pseudocode:**

```text
cycleId = through + profile + productRef

if cycleId already exists:
    validate its identity
    advance only legal unfinished stages
else:
    resolve previous run
    create cycleId
    advance legal stages
```

**Correctness invariant:** At most one durable run directory represents a product/date cycle during supported sequential execution.

**Time complexity:** Workflow-stage count is bounded, but each step may include file I/O, model calls, or web research. Latest-run discovery is `O(R log R)` plus parsing I/O for `R` stored runs.

**Space complexity:** `O(R)` during latest-run discovery; bounded state per workflow step.

**Edge cases:** Existing run with mismatched evidence, unresolved previous run, crash between model call and persistence, concurrent creation.

**Alternative:** A database unique constraint on the composite cycle key plus indexed latest-run lookup.

**Recognition cue:** Deterministic IDs are a practical algorithmic tool for converting “create” into “find-or-resume.”

### Subproblem 4: Append operation events

**Code location:** `src/storage/review-operations.ts`

**Approach/pattern:** Read-modify-rewrite append.

**Correctness invariant:** Under one sequential writer, loaded events preserve append order.

**Time complexity:** Appending event `i` rewrites `i` events, so `E` cumulative appends are `O(E²)` serialization work.

**Space complexity:** `O(E)` per append.

**Edge cases:** Corrupt JSONL and concurrent writers.

**Alternative:** True append-only file writes with locking, or a database event table.

**Recognition cue:** A method named “append” may still be a whole-file rewrite; inspect the physical operation before reasoning about complexity.

### Transferable heuristic

Convert every requirement into an invariant at the narrowest boundary possible. Here, “weekly evidence must be trustworthy” becomes “all 42 source/date keys are complete before aggregation.” Once the invariant is explicit, algorithm choice, tests, and failure handling become much easier to evaluate.

---

## 9. Read Path and Write Path

### Write path

- **Trigger:** `npm run marketplace:review`.
- **Validation:** CLI options/profile, configured context, UTC date, product identity, snapshot schemas, evidence identity, and workflow transition guards.
- **Writes:** Operation events, missing/noncomplete snapshots, daily projections, weekly artifact, prior/current workflow state, workflow events, evidence files, and experiment plan.
- **Location:** Local filesystem under the configured metrics and workflow roots.
- **Transactional?** No. Individual files use atomic rename; the command is not an atomic transaction.
- **Retry:** Complete snapshots and valid weekly artifacts are reused; the deterministic run is resumed.
- **Partial failure:** Successfully persisted earlier stages remain. A retry continues from those durable records.
- **Downstream effects:** External collection, optional hosted research/model calls, and human approval prompting. No marketplace mutation occurs.

### Read path

- **Trigger:** CLI date/product resolution, evidence preparation, or rolling-review history lookup.
- **Stores queried:** Context JSON, source snapshot directories, weekly artifact file, operation JSONL, and workflow-run directories.
- **Indexes/filters:** Filesystem path naming is the primary lookup mechanism. Run history has no secondary index and is scanned.
- **Freshness:** Snapshots are restricted to completed UTC dates. Existing valid weekly artifacts may be reused indefinitely for their `through` key.
- **Derived data:** Weekly artifacts, operation events, workflow events, evidence files, and experiment plans.
- **Missing data:** Missing snapshots trigger collection; remaining gaps fail preparation. Missing weekly artifacts trigger generation. Missing workflow cycles trigger creation.
- **Caller result:** Artifact status/reference plus previous/current run summary.

---

## 10. Failure and Concurrency Walkthrough

### Scenario: Two users run the command simultaneously

- **Sequence:** Both inspect the same missing evidence and current run.
- **Expected behavior:** Not supported by the documented architecture.
- **Handling mechanism:** Per-snapshot lock directories and exclusive run-directory creation provide limited protection.
- **Missing mechanism:** Command-wide lock, run save lock, operation-event lock, or database transaction.
- **Risk:** High outside the intended single-operator model.

### Scenario: Request is retried sequentially

- **Sequence:** The same composite review key is submitted again.
- **Expected behavior:** Reuse complete snapshots/artifact and resume or return the same run.
- **Mechanism:** Deterministic identities, snapshot immutability, artifact reuse, and stage guards.
- **Missing mechanism:** Operation-event deduplication.
- **Risk:** Low for durable state; repeated audit events are possible.

### Scenario: Job or command runs twice

- **Sequence:** Two sequential invocations target the same review date.
- **Expected behavior:** One logical workflow cycle; no repeated source collection after completion.
- **Mechanism:** Same as retry behavior.
- **Missing mechanism:** A scheduler-level uniqueness guarantee because there is no scheduler.
- **Risk:** Low sequentially, high concurrently.

### Scenario: File write succeeds but downstream workflow fails

- **Sequence:** Weekly artifact is persisted; rolling workflow then throws.
- **Expected behavior:** Artifact and preparation trace remain; failure event is recorded; retry reuses evidence.
- **Mechanism:** Durable staged files and façade catch block.
- **Missing mechanism:** Rollback across the operation.
- **Risk:** Medium but intentionally recoverable.

### Scenario: Cache is stale

- **Sequence:** Not directly applicable; no cache exists.
- **Expected behavior:** A valid existing weekly artifact is reused.
- **Mechanism:** Artifact keyed by `through`, backed by immutable completed snapshots.
- **Missing mechanism:** Aggregation-version invalidation.
- **Risk:** Medium after transformation-code changes.

### Scenario: Event arrives out of order

- **Sequence:** In supported single-process execution, events are awaited in order. Concurrent writers could both load the same old file and overwrite each other.
- **Expected behavior:** Ordered under one writer.
- **Mechanism:** Sequential `await` calls.
- **Missing mechanism:** Sequence numbers, compare-and-swap, or locked append.
- **Risk:** Low in intended operation; medium/high with concurrency.

### Scenario: Deployment occurs during schema change

- **Sequence:** New code reads old persisted JSON.
- **Expected behavior:** Compatible records parse; incompatible records fail visibly.
- **Mechanism:** Strict runtime schemas.
- **Missing mechanism:** Schema versions, dual-read compatibility, and migrations.
- **Risk:** Medium as the product evolves.

### Scenario: External service times out

- **Sequence:** HTTP or collection deadline expires.
- **Expected behavior:** Produce a failed normalized snapshot, continue other source attempts, then fail preparation if coverage remains incomplete.
- **Mechanism:** Abort timeout, coordinator deadline, failure normalization, and completeness gate.
- **Missing mechanism:** Automatic exponential retry/circuit breaker.
- **Risk:** Medium and observable.

### Scenario: Backfill is interrupted

- **Sequence:** Some source/date files are persisted before the process exits.
- **Expected behavior:** Retry reuses complete records and recollects missing/noncomplete ones.
- **Mechanism:** Per-key persistence and immutable completed snapshots.
- **Missing mechanism:** Explicit backfill-operation checkpoint state.
- **Risk:** Medium but mostly recoverable.

---

## 11. Concept Glossary

| Term | Plain meaning | Buffr example | Why it matters |
|---|---|---|---|
| Composite key | Identity made from multiple fields | `profile + productRef + through` | Defines retry and uniqueness semantics |
| Source of truth | Authoritative state | Complete daily snapshot; workflow `run.json` | Prevents projections from becoming accidentally authoritative |
| Projection | Derived representation for reading | Weekly artifact, `events.jsonl`, experiment plan | Improves serving and inspection |
| Materialized view | Persisted derived computation | Weekly review artifact | Avoids repeated aggregation |
| Idempotency | Retrying converges on the same state | Deterministic run ID and artifact reuse | Essential when failures can happen mid-operation |
| At-least-once semantics | An external action may repeat after a crash | Model/provider call before state persistence | Prevents false exactly-once claims |
| Atomic rename | Replace one file as a unit | Snapshot and run-file writes | Protects readers from partial JSON |
| Transaction | Several changes succeed or fail together | Not present across the command | Explains partial durable state |
| Lost update | One writer overwrites another’s work | Concurrent JSONL read-modify-write | Central concurrency risk |
| Backfill | Populate missing historical data | Collect missing dates in the 14-day window | Bridges operational gaps |
| Data lineage | Record where derived data came from | Snapshot dates → weekly artifact → evidence → run | Supports debugging and trust |
| Completeness invariant | Required records all exist and qualify | 42 complete snapshots | Drives correctness |
| State machine | Legal states and transitions | M1–M7 workflow engine | Keeps models from routing the lifecycle |
| Façade | Simple interface over several subsystems | `MarketplaceReviewService` | Reduces operator and caller complexity |
| Composition root | Place where concrete dependencies are wired | `createMarketplaceVisibilityDependencies()` | Keeps domain services testable |
| Fail closed | Refuse progress when required evidence is missing | No workflow mutation after incomplete coverage | Protects decision quality |
| Bounded context/data | Deliberately limited information | Safe event fields and normalized aggregates | Reduces privacy and prompt-leak risk |
| Access pattern | How data is looked up | Source/date files and run-directory scans | Determines storage suitability and scaling limits |

---

## 12. Learning Summary

1. **Core mechanism:** Deterministic, retry-aware orchestration over immutable source/date snapshots and a workflow state machine.
2. **Most important data flow:** External aggregates → daily snapshots → weekly artifact → marketplace evidence → rolling workflow run.
3. **Strongest guarantee:** Under sequential local execution, complete source/date snapshots are immutable and the same review key converges on the same workflow cycle.
4. **Weakest guarantee:** Cross-file atomicity and multi-process concurrency; exactly-once external execution is not provided.
5. **FODE stages touched:** Ingestion, storage, transformation, serving, orchestration, security, DataOps, and software engineering.
6. **DDIA topics to study next:** Idempotency, materialized views, crash consistency, transactions, concurrency control, and schema evolution.
7. **System-design tradeoff:** Local synchronous files maximize simplicity and inspectability but trade away concurrency, indexing, and transactional guarantees.
8. **Algorithmic lesson:** Model completeness as a finite key space—`dates × sources`—then use a map and a final invariant check.
9. **Code-review questions:**
   - Design: What event or scale threshold should trigger moving operation/run state to a transactional database?
   - Correctness: Can a valid weekly artifact become semantically stale after aggregation logic changes?
   - Failure modes: What state remains if the process crashes after a model call but before `run.json` is persisted?
10. **Hands-on exercise:** Add an `aggregationVersion` to weekly artifacts, reject or regenerate artifacts with an older version, and write tests proving reuse for matching versions and refresh for mismatches.
