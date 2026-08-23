# MerchGrid Workflow Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Buffr turn validated local MerchGrid daily-health and weekly-review artifacts into deterministic, human-approved workflow runs and later evaluate an approved test against a later weekly artifact.

**Architecture:** Keep the existing source pack responsible for provider collection and local aggregate artifacts. Add a narrow MerchGrid workflow boundary that validates artifacts, applies deterministic readiness and metric qualification, and invokes the existing workflow engine through a product-specific profile. Preserve the Etsy/listing workflow APIs and reuse only engine mechanics that are genuinely shared: state, routing, persistence, tracing, bounded research, and the experiment-result lifecycle.

**Tech Stack:** TypeScript, Node.js, Zod, Vitest, existing local JSON repositories, existing Buffr workflow engine and structured agent runner.

**Spec:** [`docs/superpowers/specs/2026-08-23-merchgrid-workflow-integration-design.md`](../specs/2026-08-23-merchgrid-workflow-integration-design.md)

## Global Constraints

- Read only persisted aggregate MerchGrid review artifacts; workflow modules must never query PostHog, Fly, Shopify, or a provider dashboard.
- Persist no credentials, raw provider payloads, shop domains, catalog data, raw PostHog events, or provider URLs in workflow state, traces, or artifacts.
- Use fixed clocks, fakes, and fixtures in tests; never use a real `.env` or network request.
- Keep existing Etsy/listing workflow APIs and behavior valid; do not make existing listing fields optional to fit MerchGrid.
- Daily health is an operational triage path. It can wait, request data, or produce manual triage; it must never reach M5/M6 or write to production.
- Weekly recommendations require two adjacent completed seven-day UTC periods and deterministic metric qualification before M4–M6.
- The initial daily escalation policy is explicit: investigate only when Fly has at least `20` measured requests and `error_rate >= 0.05`; otherwise preserve the evidence and return `healthy_no_action` or `collect_more_data`.
- Human approval is mandatory before a weekly M6 test plan becomes `experiment_wait`; approval records intent only and grants no provider write capability.
- Commit each completed task after its focused tests pass. Keep `.env` ignored; commit only `.env.example` placeholders if configuration documentation changes.

---

## File Structure Map

```text
src/contracts/merchgrid-workflow.ts        # strict daily/weekly workflow-evidence union
src/metrics/evidence.ts                    # Zod validation for persisted source-pack artifact projection
src/jobs/merchgrid-source-pack.ts           # strict artifact load instead of JSON type assertion
src/workflow/merchgrid-readiness.ts         # daily/weekly gate and deterministic metric qualification
src/contracts/workflow.ts                   # evidence union plus approval checkpoint state
src/workflow/state.ts                       # evidence references that work for listing and MerchGrid runs
src/workflow/engine.ts                      # product-profile start, approval/rejection, result validation
src/workflow/merchgrid-profile.ts           # daily and weekly entry functions; no provider clients
src/agents/merchgrid/modules.ts             # MerchGrid M1/M2 bridge and typed structured-agent module wiring
src/cli/merchgrid-workflow.ts               # explicit daily-investigate, weekly-recommend, approve, and result commands
src/tests/contracts/merchgrid-workflow.test.ts
src/tests/workflow/merchgrid-readiness.test.ts
src/tests/workflow/merchgrid-profile.test.ts
src/tests/workflow/merchgrid-engine.test.ts
src/tests/cli/merchgrid-workflow.test.ts
```

`src/contracts/evidence.ts` remains Etsy/listing-specific. The new contract is parallel rather than a widened replacement. `src/contracts/workflow.ts` stores a discriminated union of product evidence, while the workflow engine keeps its generic lifecycle mechanics.

> **DDIA lens — schema evolution:** A discriminated evidence union lets Buffr add one new immutable input type without corrupting the meaning of historical Etsy runs. A persisted run always says what kind of evidence informed it.

## Shared Interfaces

```ts
export type MerchGridWorkflowEvidence = {
  product: 'merchgrid';
  kind: 'daily_health' | 'weekly_review';
  artifactRef: string;
  observedPeriod:
    | { kind: 'daily'; date: string }
    | { kind: 'weekly'; previous: DateRange; current: DateRange };
  sourceCoverage: SourceCoverage;
  sourceFreshness: SourceFreshness;
  aggregateMetrics: SourceMetricValues;
  limitations: string[];
};

export type DateRange = { startDate: string; endDate: string };
export type SourceCoverage = import('../metrics/summaries.js').SourceCoverage;
export type SourceFreshness =
  | import('../metrics/summaries.js').DailySourceFreshness
  | { previous: import('../metrics/summaries.js').WeeklySourceFreshness; current: import('../metrics/summaries.js').WeeklySourceFreshness };

export type DailyReadiness =
  | { outcome: 'healthy_no_action'; reason: string }
  | { outcome: 'investigate'; reason: string }
  | { outcome: 'collect_more_data'; reason: string }
  | { outcome: 'manual_triage'; reason: string };

export type WeeklyReadiness =
  | { outcome: 'ready'; metrics: MetricsOutput }
  | { outcome: 'collect_more_data'; reason: string; metrics: MetricsOutput };

export type MerchGridWorkflowService = {
  startDailyInvestigation(input: { runId: string; date: string }): Promise<DailyReadiness | WorkflowRunState>;
  startWeeklyRecommendation(input: { runId: string; through: string }): Promise<WorkflowRunState>;
  supplyWeeklyResult(input: { runId: string; through: string }): Promise<WorkflowRunState>;
};
```

The exact TypeScript definitions must be Zod-backed and `.strict()`. `artifactRef` is a local repository reference, not an arbitrary provider URL. The public result of `startDailyInvestigation` makes “no run was created” explicit instead of representing no concern as a fake workflow.

> **Fundamentals of Data Engineering lens — data-quality contract:** Readiness is a consumer-side quality check. It preserves missingness, freshness, and coverage as first-class information instead of allowing a downstream model to treat partial input as fact.

## Tasks

### Task 1: Validate the persisted MerchGrid evidence boundary

**Purpose:** Make a review artifact safe and unambiguous before it enters a workflow run.

**Why:** The source pack already creates local JSON, but its repository currently casts parsed JSON to a TypeScript type. Runtime validation is needed because JSON is untrusted at the storage boundary.

**How:** Add strict Zod schemas for the source-pack projection and workflow-facing evidence. Validate on artifact save/load, allowlist only aggregate metrics, and derive the workflow evidence from the validated artifact plus its local path.

**Learning lenses:**
- **DDIA lens — dataflow boundary and provenance:** validate the artifact where it crosses from storage into decision-making, so every recommendation can name its historical input.
- **FODE lens — curated consumption:** treat the source-pack artifact as a data product with an explicit quality contract, rather than allowing every consumer to reinterpret raw inputs.
- **AIAIA lens — bounded agent context:** give downstream agents only safe, validated aggregate evidence; the agent never receives credentials or provider payloads.

**Files:**
- Create: `src/contracts/merchgrid-workflow.ts`
- Modify: `src/metrics/evidence.ts`
- Modify: `src/jobs/merchgrid-source-pack.ts`
- Test: `src/tests/contracts/merchgrid-workflow.test.ts`
- Test: `src/tests/jobs/merchgrid-source-pack.test.ts`

**Interfaces:**
- Consumes: `MerchGridReviewEvidence`, `DailyHealthSummary`, `WeeklyBusinessReview`.
- Produces: `MerchGridWorkflowEvidenceSchema`, `parseMerchGridWorkflowEvidence(artifact, artifactRef)`, and a strict `MerchGridReviewEvidenceSchema` used by the artifact repository.

- [ ] **Step 1: Write focused failing contract tests**

```ts
it('accepts a closed weekly aggregate artifact and preserves its local reference', () => {
  const evidence = parseMerchGridWorkflowEvidence(validWeeklyArtifact, '.local/artifacts/weekly-reviews/2026-08-22.json');
  expect(evidence).toMatchObject({ product: 'merchgrid', kind: 'weekly_review' });
});

it.each([
  { POSTHOG_PERSONAL_API_KEY: 'secret' },
  { rawEvents: [{ event: 'scan_started' }] },
  { shopDomain: 'private-shop.myshopify.com' },
])('rejects workflow evidence containing unsafe provider data', (unsafe) => {
  expect(() => MerchGridWorkflowEvidenceSchema.parse({ ...validEvidence, ...unsafe })).toThrow();
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- src/tests/contracts/merchgrid-workflow.test.ts`

Expected: FAIL because the MerchGrid workflow schemas and parser do not exist.

- [ ] **Step 3: Implement strict schemas and strict artifact parsing**

```ts
export const MerchGridWorkflowEvidenceSchema = z.object({
  product: z.literal('merchgrid'),
  kind: z.enum(['daily_health', 'weekly_review']),
  artifactRef: z.string().min(1).refine((value) => !value.includes('://'), 'artifactRef must be local'),
  observedPeriod: ObservedPeriodSchema,
  sourceCoverage: SourceCoverageSchema,
  sourceFreshness: SourceFreshnessSchema,
  aggregateMetrics: SourceMetricValuesSchema,
  limitations: z.array(z.string()),
}).strict();

private async loadArtifact(path: string): Promise<MerchGridReviewEvidence | undefined> {
  // retain existing ENOENT handling, JSON parsing, and AppError mapping
  return parseWithSchema(MerchGridReviewEvidenceSchema, JSON.parse(raw), 'MerchGrid review artifact');
}
```

Use only `period`, coverage, freshness, aggregate numeric metrics, and limitations from the existing summary projection. Reject unknown keys and recursively assert that no credential-like key reaches the result.

- [ ] **Step 4: Run focused contract and source-pack tests**

Run: `npm test -- src/tests/contracts/merchgrid-workflow.test.ts src/tests/jobs/merchgrid-source-pack.test.ts`

Expected: PASS, including corrupt JSON, malformed period, and unsafe-key rejection coverage.

- [ ] **Step 5: Commit the contract boundary**

```bash
git add src/contracts/merchgrid-workflow.ts src/metrics/evidence.ts src/jobs/merchgrid-source-pack.ts src/tests/contracts/merchgrid-workflow.test.ts src/tests/jobs/merchgrid-source-pack.test.ts
git commit -m "feat: validate MerchGrid workflow evidence"
```

### Task 2: Add deterministic daily and weekly readiness policies

**Purpose:** Decide whether evidence is sufficient before any agent interprets it.

**Why:** A missing source, zero request count, and measured high error rate mean different things. The policy must calculate that distinction deterministically rather than leaving it to M1–M6.

**How:** Build pure readiness functions. Daily policy uses only complete Fly request/error aggregates and the explicit `20` request / `5%` error-rate policy. Weekly policy validates adjacent seven-day periods, produces comparison metrics only when each required numerator/denominator is complete, and waits when no metric is interpretable.

**Learning lenses:**
- **DDIA lens — missing-data semantics and derived data:** distinguish missing, zero, and measured error values before deriving a workflow outcome.
- **FODE lens — data-quality gate:** block an analytical consumer when completeness and denominator rules are not met; record limitations rather than manufacturing certainty.
- **AIAIA lens — deterministic orchestration:** readiness is code, not an agent judgment, so a model cannot escalate an outage or weak signal into a recommendation.

**Files:**
- Create: `src/workflow/merchgrid-readiness.ts`
- Test: `src/tests/workflow/merchgrid-readiness.test.ts`

**Interfaces:**
- Consumes: `MerchGridWorkflowEvidence` from Task 1.
- Produces: `evaluateDailyReadiness(evidence): DailyReadiness`, `evaluateWeeklyReadiness(evidence): WeeklyReadiness`, `DAILY_MINIMUM_REQUEST_COUNT = 20`, `DAILY_MATERIAL_ERROR_RATE = 0.05`.

- [ ] **Step 1: Write failing policy tests with a fixed fixture matrix**

```ts
it('starts investigation only for at least 20 Fly requests and a measured error rate at or above 5%', () => {
  expect(evaluateDailyReadiness(daily({ request_count: 20, error_response_count: 1, error_rate: 0.05 })))
    .toEqual({ outcome: 'investigate', reason: 'fly_error_rate_material' });
});

it('does not infer health from zero requests or missing Fly metrics', () => {
  expect(evaluateDailyReadiness(daily({ request_count: 0 }))).toMatchObject({ outcome: 'collect_more_data' });
});

it('waits when weekly periods are incomplete and qualifies only complete comparable metrics', () => {
  expect(evaluateWeeklyReadiness(incompleteWeekly)).toMatchObject({ outcome: 'collect_more_data' });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- src/tests/workflow/merchgrid-readiness.test.ts`

Expected: FAIL because readiness functions and constants do not exist.

- [ ] **Step 3: Implement pure policies without I/O or agent calls**

```ts
export function evaluateDailyReadiness(evidence: MerchGridWorkflowEvidence): DailyReadiness {
  requireDailyEvidence(evidence);
  if (hasMissingOrStaleReliabilityEvidence(evidence)) return { outcome: 'collect_more_data', reason: 'reliability_evidence_incomplete' };
  const requests = evidence.aggregateMetrics.fly_metrics?.request_count;
  const errorRate = evidence.aggregateMetrics.fly_metrics?.error_rate;
  if (requests === undefined || errorRate === undefined || requests === 0) return { outcome: 'collect_more_data', reason: 'reliability_denominator_unavailable' };
  if (requests >= DAILY_MINIMUM_REQUEST_COUNT && errorRate >= DAILY_MATERIAL_ERROR_RATE) return { outcome: 'investigate', reason: 'fly_error_rate_material' };
  return { outcome: 'healthy_no_action', reason: 'no_material_reliability_concern' };
}
```

Create `MetricsOutput` with only validated, comparable metrics. For each metric, compute `absoluteChange = current - baseline` and `percentageChange = baseline === 0 ? null : absoluteChange / baseline`; mark unmeasurable metrics `not_available` and keep limitations in `unresolvedQualificationNeeds`.

- [ ] **Step 4: Run policy tests and typecheck**

Run: `npm test -- src/tests/workflow/merchgrid-readiness.test.ts && npm run typecheck`

Expected: PASS, including stale/partial source, zero denominator, exact threshold, and incomplete-week coverage cases.

- [ ] **Step 5: Commit the readiness policy**

```bash
git add src/workflow/merchgrid-readiness.ts src/tests/workflow/merchgrid-readiness.test.ts
git commit -m "feat: add MerchGrid workflow readiness policies"
```

### Task 3: Generalize only the workflow evidence seam and add explicit approval

**Purpose:** Let the existing engine persist both Etsy and MerchGrid evidence while adding the required human approval checkpoint.

**Why:** The engine is reusable, but its persisted state currently requires a `listingId` and listing-shaped evidence. A narrow discriminated union avoids fake Etsy records and preserves existing listing behavior. The engine currently reaches `experiment_wait` immediately after M6; that is too early for a human-in-the-loop boundary.

**How:** Add a product evidence union and a stable `subjectRef` while retaining `listingId` on listing runs. Add `approval_wait` stage, `awaiting_approval` status, and explicit approve/reject methods. Etsy routes remain valid but now also wait for an owner decision after M6.

**Learning lenses:**
- **DDIA lens — immutable run provenance:** persist the evidence kind, reference, and approval decision with the run so later learning has a stable history.
- **FODE lens — separation of analytical concerns:** keep evidence-model evolution isolated from collection and from product-specific interpretation.
- **AIAIA lens — human-in-the-loop governance:** a generated test plan stays a proposal until an owner explicitly approves it; approval never grants provider write authority.

**Files:**
- Modify: `src/contracts/workflow.ts`
- Modify: `src/workflow/state.ts`
- Modify: `src/workflow/engine.ts`
- Modify: `src/workflow/routes.ts`
- Modify: `src/storage/runs.ts`
- Test: `src/tests/workflow/engine.test.ts`
- Test: `src/tests/workflow/routes.test.ts`
- Test: `src/tests/workflow/end-to-end.test.ts`

**Interfaces:**
- Consumes: `NormalizedListingEvidence` and `MerchGridWorkflowEvidence`.
- Produces: `WorkflowEvidenceSchema`, `WorkflowKind = 'etsy_listing' | 'merchgrid_daily' | 'merchgrid_weekly'`, the existing listing `StartWorkflowInput`, a parallel `StartMerchGridWorkflowInput`, `approveExperiment(runId)`, `rejectExperiment({ runId, reason })`, and a run state that persists `approval` metadata.

- [ ] **Step 1: Add failing Etsy-regression and approval tests**

```ts
it('keeps the existing Etsy start API valid while storing a discriminated workflow input', async () => {
  const state = await engine.start({ runId: 'etsy-1', listingId: '123', initialEvidence: listingEvidence });
  expect(state.subjectRef).toBe('listing:123');
});

it('holds a completed M6 plan for explicit approval', async () => {
  const state = await stepUntilM6(engine, 'merchgrid-weekly-1');
  expect(state).toMatchObject({ stage: 'approval_wait', status: 'awaiting_approval' });
});

it('records rejection without invoking a provider write', async () => {
  const rejected = await engine.rejectExperiment({ runId: 'merchgrid-weekly-1', reason: 'not enough confidence' });
  expect(rejected.status).toBe('stopped');
  expect(fakeProviderWrite.calls).toEqual([]);
});
```

- [ ] **Step 2: Run the workflow tests to verify they fail**

Run: `npm test -- src/tests/workflow/engine.test.ts src/tests/workflow/routes.test.ts src/tests/workflow/end-to-end.test.ts`

Expected: FAIL because state lacks the evidence union and approval checkpoint.

- [ ] **Step 3: Implement the narrow state and engine changes**

```ts
export const WorkflowEvidenceSchema = z.discriminatedUnion('product', [
  z.object({ product: z.literal('etsy'), evidence: NormalizedListingEvidenceSchema }).strict(),
  MerchGridWorkflowEvidenceSchema,
]);

export type WorkflowEngine = {
  start(input: StartWorkflowInput): Promise<WorkflowRunState>;
  startMerchGrid(input: StartMerchGridWorkflowInput): Promise<WorkflowRunState>;
  approveExperiment(runId: string): Promise<WorkflowRunState>;
  rejectExperiment(input: { runId: string; reason: string }): Promise<WorkflowRunState>;
  // retain step, research, and result methods
};
```

Add required `subjectRef` to every persisted run and preserve optional `listingId` for old Etsy runs. `start()` continues to accept its existing listing-shaped input and wraps it with `product: 'etsy'`; `startMerchGrid()` accepts the new product evidence. Change `routeAfterM6` to advance to `approval_wait`. `approveExperiment` must only accept `approval_wait`, append `workflow.experiment_approved`, set `experiment_wait` / `ready_for_experiment`, and persist the decision timestamp. `rejectExperiment` must append `workflow.experiment_rejected`, set `stopped`, and preserve M6 output. Continue asserting credential-free state before each write.

Add `workflowKind` to state and route M4 by that stored kind: `etsy_listing` and `merchgrid_weekly` continue through the existing `routeAfterM4`; `merchgrid_daily` converts a `proceed_to_hypothesis` diagnosis into `{ type: 'wait', reason: 'manual triage required' }`, retains bounded research, and maps `collect_more_data` to its existing wait. This is the enforced reason daily runs cannot reach M5/M6.

- [ ] **Step 4: Run focused workflow regression tests**

Run: `npm test -- src/tests/workflow/engine.test.ts src/tests/workflow/routes.test.ts src/tests/workflow/end-to-end.test.ts src/tests/workflow/guards.test.ts`

Expected: PASS; existing Etsy path reaches an approval boundary, and neither approval path writes to a provider.

- [ ] **Step 5: Commit the engine seam**

```bash
git add src/contracts/workflow.ts src/workflow/state.ts src/workflow/engine.ts src/workflow/routes.ts src/storage/runs.ts src/tests/workflow/engine.test.ts src/tests/workflow/routes.test.ts src/tests/workflow/end-to-end.test.ts
git commit -m "feat: add workflow evidence profiles and approval gate"
```

### Task 4: Build the MerchGrid profile and module executor

**Purpose:** Translate a ready MerchGrid artifact into the existing M1–M7 lifecycle without allowing modules to read providers.

**Why:** The engine only coordinates. This profile supplies product-specific context and deterministic metrics while leaving interpretation to typed M4–M7 modules and keeping daily runs bounded before hypothesis/test planning.

**How:** Create a profile service that loads a validated artifact, evaluates readiness, builds `ContextOutput` and `MetricsOutput` from immutable evidence, and composes `ModuleExecutor`. Reuse the existing structured agent runner for M1/M4–M7 schemas; pass only the normalized workflow state and never credential-bearing configuration.

**Learning lenses:**
- **DDIA lens — stable derived data:** M1/M2 consume the saved aggregate artifact, not a mutable dashboard or live provider response.
- **FODE lens — preparation before consumption:** deterministic context and metric qualification prepare clean analytical inputs before any interpretive module runs.
- **AIAIA lens — bounded specialist pattern:** the engine routes work, deterministic code measures, and typed agent modules interpret; no one component owns every responsibility.

**Files:**
- Create: `src/agents/merchgrid/modules.ts`
- Create: `src/workflow/merchgrid-profile.ts`
- Test: `src/tests/workflow/merchgrid-profile.test.ts`

**Interfaces:**
- Consumes: strict artifact repository, `evaluateDailyReadiness`, `evaluateWeeklyReadiness`, `WorkflowEngine`, `AgentRunner`.
- Produces: `createMerchGridWorkflowService(deps): MerchGridWorkflowService` and `createMerchGridModuleExecutor(deps): ModuleExecutor`.

- [ ] **Step 1: Write failing profile tests**

```ts
it('returns healthy_no_action without creating a run for a healthy daily artifact', async () => {
  const result = await service.startDailyInvestigation({ runId: 'daily-healthy', date: '2026-08-22' });
  expect(result).toEqual({ outcome: 'healthy_no_action', reason: 'no_material_reliability_concern' });
  expect(runs.created).toEqual([]);
});

it('starts a daily run that can reach M4 but never M5 or M6', async () => {
  const run = await service.startDailyInvestigation({ runId: 'daily-incident', date: '2026-08-22' });
  const settled = await stepThroughDailyInvestigation(engine, run.runId);
  expect(settled.moduleOutputs.m5).toBeUndefined();
  expect(settled.moduleOutputs.m6).toBeUndefined();
});
```

- [ ] **Step 2: Run the profile test to verify it fails**

Run: `npm test -- src/tests/workflow/merchgrid-profile.test.ts`

Expected: FAIL because no MerchGrid profile service exists.

- [ ] **Step 3: Implement profile-specific functions and deterministic M1/M2**

```ts
export function createMerchGridModuleExecutor(deps: { agentRunner: AgentRunner }): ModuleExecutor {
  return {
    async runM1(state) { return deterministicMerchGridContext(state); },
    async runM2Initial(state) { return metricsFromQualifiedMerchGridEvidence(state); },
    async runM3(state, request) { return runMerchGridStructuredModule(deps.agentRunner, 'm3', ResearchOutputSchema, { state, request }); },
    async runM4(state) { return runMerchGridStructuredModule(deps.agentRunner, 'm4', DiagnosisOutputSchema, state); },
    async runM5(state) { return runMerchGridStructuredModule(deps.agentRunner, 'm5', HypothesisOutputSchema, state); },
    async runM6(state) { return runMerchGridStructuredModule(deps.agentRunner, 'm6', TestPlanOutputSchema, state); },
    async runM2Results(state) { return metricsFromQualifiedMerchGridResult(state); },
    async runM7(state) { return runMerchGridStructuredModule(deps.agentRunner, 'm7', EvaluationOutputSchema, state); },
  };
}
```

For a daily run, profile routing must stop after M4 with `manual_triage` or `waiting_for_data`; do not call M5/M6. For a weekly run, start only from `WeeklyReadiness.outcome === 'ready'`, persist the qualifier output, and use existing M4–M6 routing and schema validation.

- [ ] **Step 4: Run focused profile and engine tests**

Run: `npm test -- src/tests/workflow/merchgrid-profile.test.ts src/tests/workflow/engine.test.ts`

Expected: PASS; modules receive only normalized state and a healthy daily artifact creates no run.

- [ ] **Step 5: Commit the MerchGrid profile**

```bash
git add src/agents/merchgrid/modules.ts src/workflow/merchgrid-profile.ts src/tests/workflow/merchgrid-profile.test.ts
git commit -m "feat: add MerchGrid workflow profile"
```

### Task 5: Support later weekly evidence as a bounded experiment result

**Purpose:** Close the weekly decision loop by comparing a later review with the frozen M6 plan and proceeding through M2-results and M7.

**Why:** A recommendation is useful only if its proposed test can later be evaluated against new evidence. Reusing a persisted later weekly review preserves immutable periods and avoids live dashboard recomputation.

**How:** Add `supplyWeeklyResult`, verify the run is in `experiment_wait`, validate a weekly artifact, require the M6 baseline period and primary metric to be comparable, then hand the result to the engine’s existing result lifecycle.

**Learning lenses:**
- **DDIA lens — immutable history and idempotent derived data:** compare a later closed weekly artifact with the M6 baseline frozen at approval time.
- **FODE lens — batch comparison:** evaluate two well-defined analytical windows instead of comparing against a live, shifting dashboard.
- **AIAIA lens — controlled feedback loop:** the system can learn from a human-approved experiment, but it cannot retroactively alter the measured evidence or its baseline.

**Files:**
- Modify: `src/workflow/merchgrid-profile.ts`
- Modify: `src/agents/merchgrid/modules.ts`
- Test: `src/tests/workflow/merchgrid-profile.test.ts`
- Test: `src/tests/workflow/merchgrid-engine.test.ts`

**Interfaces:**
- Consumes: approved `experiment_wait` run with `moduleOutputs.m6`, validated later weekly artifact.
- Produces: `supplyWeeklyResult({ runId, through })` that transitions to `m2_metrics_results` only when frozen measurement requirements are met.

- [ ] **Step 1: Write failing post-experiment tests**

```ts
it('uses the saved M6 baseline rather than recomputing the original period', async () => {
  const state = await service.supplyWeeklyResult({ runId: 'weekly-approved', through: '2026-09-05' });
  expect(state.evidenceSnapshots?.result).toMatchObject({ product: 'merchgrid', kind: 'weekly_review' });
  expect(state.moduleOutputs.m6?.baselinePeriod).toBe('2026-08-16..2026-08-22');
});

it('waits when the later review cannot qualify the frozen primary metric', async () => {
  await expect(service.supplyWeeklyResult({ runId: 'weekly-approved', through: '2026-09-05' }))
    .resolves.toMatchObject({ status: 'waiting_for_data' });
});
```

- [ ] **Step 2: Run the result-path tests to verify they fail**

Run: `npm test -- src/tests/workflow/merchgrid-engine.test.ts src/tests/workflow/merchgrid-profile.test.ts`

Expected: FAIL because result ingestion is not yet exposed for MerchGrid artifacts.

- [ ] **Step 3: Implement frozen-baseline validation and result handoff**

```ts
async function supplyWeeklyResult(input: { runId: string; through: string }): Promise<WorkflowRunState> {
  const state = await deps.runRepository.load(input.runId);
  const artifact = await requireWeeklyArtifact(input.through);
  const evidence = parseMerchGridWorkflowEvidence(artifact.value, artifact.ref);
  const resultMetrics = qualifyWeeklyResultAgainstPlan(evidence, requireTestPlan(state));
  if (resultMetrics.comparisonQuality !== 'valid') return waitForData(state, resultMetrics.unresolvedQualificationNeeds);
  return engine.resumeWithExperimentResults({ runId: input.runId, resultEvidence: evidence });
}
```

The comparison helper must use `TestPlanOutput.primaryMetric`, `baselineValue`, and `baselinePeriod` from stored M6. It must not recompute or replace the baseline using a provider request or mutable file.

- [ ] **Step 4: Run result-path, workflow, and credential-guard tests**

Run: `npm test -- src/tests/workflow/merchgrid-engine.test.ts src/tests/workflow/merchgrid-profile.test.ts src/tests/workflow/guards.test.ts`

Expected: PASS; valid later evidence advances to M2 results then M7, invalid comparison waits safely.

- [ ] **Step 5: Commit result integration**

```bash
git add src/workflow/merchgrid-profile.ts src/agents/merchgrid/modules.ts src/tests/workflow/merchgrid-profile.test.ts src/tests/workflow/merchgrid-engine.test.ts
git commit -m "feat: evaluate MerchGrid weekly results"
```

### Task 6: Add explicit local workflow commands and an end-to-end fake journey

**Purpose:** Give the owner a clear way to use the new seam without making it a scheduler or dashboard.

**Why:** The source-pack commands produce evidence; this task adds the deliberate next commands that consume that evidence for investigation, recommendation, approval, and later evaluation.

**How:** Add one separate CLI with explicit verbs. It loads source-pack and run repositories from the existing local data directory, has no provider client of its own, prints only run IDs/status/artifact references, and maps failures to existing bounded error codes.

**Learning lenses:**
- **DDIA lens — explicit batch boundaries:** each command consumes one completed UTC date or review period and writes an auditable local artifact/run.
- **FODE lens — operationalized pipeline:** explicit collect, review, recommend, and result commands make each stage observable before scheduling is introduced.
- **AIAIA lens — human-controlled execution:** the CLI records approval and evidence; it never performs the external production change on the user’s behalf.

**Files:**
- Create: `src/cli/merchgrid-workflow.ts`
- Modify: `package.json`
- Modify: `README.md`
- Test: `src/tests/cli/merchgrid-workflow.test.ts`
- Test: `src/tests/workflow/merchgrid-engine.test.ts`

**Interfaces:**
- Consumes: `MerchGridWorkflowService` from Task 4 and the JSON run/artifact repositories.
- Produces: `npm run merchgrid:daily-investigate -- --date YYYY-MM-DD --run-id ID`, `npm run merchgrid:weekly-recommend -- --through YYYY-MM-DD --run-id ID`, `npm run merchgrid:approve -- --run-id ID`, `npm run merchgrid:record-result -- --through YYYY-MM-DD --run-id ID`.

- [ ] **Step 1: Write failing CLI and end-to-end tests**

```ts
it('prints a weekly recommendation run ID without exposing credentials or raw source data', async () => {
  await runMerchGridWorkflowCli({ args: ['weekly-recommend', '--through', '2026-08-22', '--run-id', 'weekly-1'], dependencies, writeLine });
  expect(lines).toContain('run: weekly-1');
  expect(lines.join('\n')).not.toMatch(/POSTHOG|FLY_ACCESS_TOKEN|myshopify/i);
});

it('completes the faked weekly path only after explicit approval and later evidence', async () => {
  await weeklyRecommend(); await approve(); await recordResult();
  expect(await runs.load('weekly-1')).toMatchObject({ stage: 'cycle_complete', status: 'cycle_complete' });
});
```

- [ ] **Step 2: Run the CLI test to verify it fails**

Run: `npm test -- src/tests/cli/merchgrid-workflow.test.ts src/tests/workflow/merchgrid-engine.test.ts`

Expected: FAIL because the workflow CLI and scripts do not exist.

- [ ] **Step 3: Implement explicit commands and documentation**

```json
{
  "scripts": {
    "merchgrid:daily-investigate": "node dist/cli/merchgrid-workflow.js daily-investigate",
    "merchgrid:weekly-recommend": "node dist/cli/merchgrid-workflow.js weekly-recommend",
    "merchgrid:approve": "node dist/cli/merchgrid-workflow.js approve",
    "merchgrid:record-result": "node dist/cli/merchgrid-workflow.js record-result"
  }
}
```

Each command must require exactly its documented options, reject malformed IDs/dates, and print bounded fields only: `run`, `status`, `stage`, and `artifact`. Document the order: collect closed days → create weekly review → run recommendation → inspect proposal → approve manually → perform external change manually → collect next closed week → record result.

- [ ] **Step 4: Run focused CLI/e2e tests, full test suite, typecheck, build, and whitespace check**

Run: `npm test -- src/tests/cli/merchgrid-workflow.test.ts src/tests/workflow/merchgrid-engine.test.ts && npm test && npm run typecheck && npm run build && git diff --check`

Expected: all commands pass; the end-to-end test uses fakes only and proves no provider write occurs.

- [ ] **Step 5: Commit the runnable integration**

```bash
git add src/cli/merchgrid-workflow.ts package.json README.md src/tests/cli/merchgrid-workflow.test.ts src/tests/workflow/merchgrid-engine.test.ts
git commit -m "feat: add MerchGrid workflow commands"
```

### Task 7: Perform final compatibility and safety verification

**Purpose:** Prove the new vertical slice is safe for both existing Etsy runs and MerchGrid workflows before a human uses it.

**Why:** The integration deliberately touches central workflow state and routing. A complete verification pass must show that the new product profile did not leak secrets, introduce provider writes, or break the original listing flow.

**How:** Run all tests, static checks, and a focused artifact scan. Review persisted fake run files for the allowed evidence fields, then commit only documentation corrections discovered during verification.

**Learning lenses:**
- **DDIA lens — end-to-end correctness:** verify the whole dataflow from persisted artifact to run state to later learning, including failure states.
- **FODE lens — data observability:** inspect the persisted artifacts and quality metadata to ensure data remains usable, explainable, and bounded.
- **AIAIA lens — control-boundary verification:** prove tests and runtime artifacts contain no credential values and that approval produces no provider write.

**Files:**
- Modify only if verification finds a concrete documentation inconsistency: `README.md`
- Test: all existing `src/tests/**/*.test.ts`

**Interfaces:**
- Consumes: complete Tasks 1–6.
- Produces: evidence-backed verification record; no new runtime interface.

- [ ] **Step 1: Run the full automated verification set**

Run: `npm test && npm run typecheck && npm run build && git diff --check`

Expected: all tests pass, TypeScript exits `0`, build exits `0`, and whitespace check has no output.

- [ ] **Step 2: Run targeted safety scans**

Run: `rg -n "POSTHOG_PERSONAL_API_KEY|FLY_ACCESS_TOKEN|SHOPIFY_PARTNER_AGGREGATES_CSV_PATH|shopDomain|rawEvents" src/workflow src/agents/merchgrid src/cli/merchgrid-workflow.ts src/storage/runs.ts`

Expected: no runtime persistence or trace code serializes credential values, shop domains, or raw source events; allowed configuration-name references are limited to existing source-pack setup files.

- [ ] **Step 3: Inspect the faked persisted run artifacts**

Run: `find .local -path '*workflow*' -type f -name '*.json' -maxdepth 6 -print`

Expected: if fixture execution created artifacts, they contain only run state, allowed aggregate evidence, module outputs, and event records; otherwise, use the temporary fixture directory asserted by the end-to-end test.

- [ ] **Step 4: Commit any verification-only README correction, or record no-op verification**

```bash
git status --short
git add README.md
git commit -m "docs: clarify MerchGrid workflow commands"
```

Run the commit commands only if Task 7 changed `README.md`; otherwise do not create an empty commit.

## Spec Coverage Review

| Design requirement | Plan task |
| --- | --- |
| Strict daily/weekly artifact evidence | Task 1 |
| Daily and weekly deterministic readiness | Task 2 |
| One shared engine with parallel product evidence | Task 3 |
| Daily bounded before M5/M6; weekly M1–M6 path | Task 4 |
| Mandatory human approval | Task 3 and Task 6 |
| Frozen weekly post-experiment result path | Task 5 |
| Local commands and no dashboard/scheduler | Task 6 |
| Privacy, existing Etsy compatibility, no provider writes | Tasks 1, 3, 6, and 7 |

## Deferred After This Plan

- Scheduling daily collection or weekly recommendation.
- Notifications or dashboard UI.
- Additional source packs such as Etsy, Meta Marketplace, or another operational product.
- Automatic production changes. The approved command only records human approval; the actual external action remains manual.
