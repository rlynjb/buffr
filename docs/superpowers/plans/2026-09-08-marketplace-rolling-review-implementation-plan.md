# Marketplace Rolling Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the repository's normal implementation workflow. If this environment supports `superpowers`, use `superpowers:subagent-driven-development` for independent task execution or `superpowers:executing-plans` for sequential execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four marketplace visibility lifecycle commands with one recurring `marketplace:next-review` command that safely resolves the previous experiment, retains M7 learning, and starts the next product-specific review from fresh weekly evidence plus a bounded prior-learning snapshot.

**Architecture:** Preserve the existing source-pack, Zod contract, deterministic workflow engine, M1-M7 module, JSON repository, M3, tracing, and manual marketplace-action boundaries. Add a rolling-review coordinator as a facade over those boundaries, a stable `profile + productRef` identity for history lookup, an injected owner-confirmation port for applied/not-applied facts, and a legacy-compatible prior-learning seam between separate immutable runs.

**Tech Stack:** TypeScript 5.4 with NodeNext modules, Node.js 20 APIs including `readline/promises`, Zod 3.25 runtime schemas, Vitest 2.1, `@openai/agents` 0.1.x, local JSON/JSONL file persistence with atomic rename, existing MerchGrid daily snapshots and weekly-review artifacts, `tsc`, `npm test`, `npm run typecheck`, and `npm run build`.

**Spec:** `docs/superpowers/specs/2026-09-08-marketplace-rolling-review-design.md`

## Global Constraints

- Replace only the marketplace visibility command surface. Keep `merchgrid:collect`, `merchgrid:weekly-review`, `merchgrid:daily-investigate`, `merchgrid:weekly-recommend`, `merchgrid:approve`, and `merchgrid:record-result` unchanged.
- Remove `marketplace:visibility-review`, `marketplace:approve`, `marketplace:reject`, and `marketplace:record-result` from `package.json`, the marketplace CLI parser, active operational documentation, and command-focused tests. Do not remove shared engine methods still used by other profiles.
- Expose one new package script, `marketplace:next-review`, backed by the existing `src/cli/marketplace-visibility.ts` composition root.
- Keep every experiment in a separate workflow-run directory. Do not append multiple experiment cycles to one `run.json` and do not rewrite or delete historical run folders or smoke artifacts.
- Keep `run.json` authoritative for a run. Evidence files, `events.jsonl`, and `experiment-plan.json` remain derived projections.
- Treat `profile + productRef` as the stable product-history identity. Treat the date-based `subjectRef` as an evidence-instance reference, not product identity.
- Accept absent rolling fields when parsing historical runs, contexts, and evidence. Require `productRef` at the new rolling-review input boundary before lookup or run creation.
- The JSON repository must derive latest-run lookup from validated `run.json` files; do not add a persisted secondary index in this slice.
- Ask the owner whether the prior plan was applied and, if yes, its `appliedAt` UTC date. There is no default answer, and cancellation mutates no workflow state.
- Never infer application from changed metrics or from a model response. Application decisions, dates, identity matching, readiness, routing, and idempotence are deterministic.
- If the prior plan was applied, close that run through existing M2 Results and M7 exactly once before creating the next run. If it was not applied, persist `not_applied`, stop it without M2 Results or M7, and start the next run without fabricated learning.
- Reuse the same immutable weekly artifact by reference as prior-run result evidence and next-run baseline evidence. Record its role independently in each run.
- Give new-run modules only the validated `PriorLearningContext`; never inject an entire previous `run.json`, event history, or arbitrary historical prompt content.
- Marketplace actions remain manual. Neither `next-review`, an agent, M3, nor M7 may edit Shopify, Etsy, or any other external system.
- Automated tests must use fixed clocks, injected owner-prompt answers, fake agent runners, temporary directories, synthetic references, and local fixtures. They must not call OpenAI, Shopify, PostHog, Fly, Etsy, or any network service and must not require a real `.env`.
- Never persist, log, trace, display, or commit credentials, tokens, cookies, private customer data, shop domains, raw provider payloads, private dashboard URLs, full prompts, or production URLs in new examples and fixtures.
- Preserve current M3 hosted-search allowlists, structured output validation, limits, requester return behavior, and human-controlled marketplace boundary.
- Retry with the same `profile + productRef + through` must return the existing new run and must not duplicate M2, M7, research calls, events, artifacts, or model calls.
- Keep the currently uncommitted README feedback-loop and tracing edits intact when Task 7 updates the operational documentation.
- Each task begins with focused failing tests, ends with its exact focused verification plus `npm run typecheck`, and commits only the files listed for that task after those checks pass.

## Current Behavior and Planned Behavior

Current marketplace operation exposes the workflow state machine directly. `visibility-review` creates a date-keyed run, `approve` records an approval timestamp, `reject` stops the run, and `record-result` loads a later weekly artifact and advances M2 Results and M7. The run repository cannot query product history, visibility context has no stable product key, and a new run does not receive prior M7 learning.

After this plan, the owner runs only `marketplace:next-review`. The command validates a stable product identity and fresh weekly evidence, locates the latest matching run, asks one applied/not-applied question only when needed, resolves the previous run deterministically, and starts one new run. The new run keeps its own evidence and outputs while retaining a bounded, provenance-carrying snapshot of the latest eligible M7 learning.

**Planning assumptions:**

- Implement history lookup as `MarketplaceRunHistoryRepository extends RunRepository`, rather than adding a query required by every engine-only fake. This realizes the spec's repository query while preventing unrelated tests and engine consumers from depending on marketplace history.
- `next-review` calls the existing `runWeeklyReview()` over persisted snapshots when the weekly artifact is absent and otherwise reuses the saved artifact. It never invokes `runDailyCollection()` or provider adapters.
- Base persisted schemas use optional rolling fields for legacy readability. A separate `RollingMarketplaceVisibilityContextSchema` and rolling evidence parser require `productRef` for new cycles.
- New rolling marketplace runs use `experimentApplication`; the existing `approval` field and `approveExperiment()`/`rejectExperiment()` methods remain available for legacy data and non-marketplace workflows.
- Only the latest completed M7 output is eligible for `PriorLearningContext`. A `not_applied` run supplies lineage through `previousRunRef` but no outcome learning.

## File Structure Map

```text
src/contracts/marketplace-visibility.ts                         # modify: product identity, rolling input, application, and prior-learning schemas
src/contracts/workflow.ts                                       # modify: optional persisted rolling fields for legacy-compatible state evolution
src/tests/contracts/marketplace-visibility.test.ts               # modify: focused identity/application/learning contract coverage
src/tests/contracts/contracts.test.ts                            # modify: historical and new workflow-state parsing
src/connectors/marketplace/local-context.ts                      # modify: expose strict rolling-context loading without weakening legacy loading
src/tests/connectors/marketplace-local-context.test.ts            # modify: rolling context boundary tests
docs/examples/merchgrid-visibility-context.example.json           # modify: safe documented productRef example
artifacts/merchgrid/context/merchgrid-visibility-context.json      # modify: stable identity for the tracked MerchGrid context

src/storage/runs.ts                                               # modify: marketplace history query over validated run files
src/tests/storage/runs.test.ts                                    # modify: exact-match, ordering, legacy, and corrupt-run tests

src/workflow/engine.ts                                            # modify: persist applied/not-applied facts and rolling-run lineage
src/tests/workflow/engine.test.ts                                 # modify: deterministic application transitions and compatibility
src/tests/workflow/marketplace-visibility-engine.test.ts          # modify: marketplace start metadata and result-resume invariants

src/workflow/marketplace-visibility-profile.ts                    # modify: weekly evidence projections for result and next baseline
src/agents/marketplace-visibility/modules.ts                      # modify: bounded prior-learning context in M1/M4/M5/M6 inputs
src/tests/workflow/marketplace-visibility-profile.test.ts         # modify: weekly reuse, application boundary, and lineage tests
src/tests/agents/marketplace-visibility.test.ts                   # modify: prior-learning prompt/input coverage

src/workflow/marketplace-rolling-review.ts                        # create: deterministic rolling-cycle coordinator and owner prompt port
src/tests/workflow/marketplace-rolling-review.test.ts             # create: coordinator branch, retry, and failure tests

src/cli/marketplace-visibility.ts                                 # modify: single command, interactive prompt adapter, and runtime composition
src/tests/cli/marketplace-visibility.test.ts                      # modify: replace old command tests with next-review tests
package.json                                                      # modify: replace four marketplace scripts with marketplace:next-review

src/tests/workflow/marketplace-rolling-review.e2e.test.ts         # create: persisted two-run lifecycle test
README.md                                                         # modify: one-command operations and accurate rolling feedback loop
src/contracts/README.md                                           # modify: identity, application, prior-learning, and lineage contracts
TODO.md                                                           # modify: align review checklist with rolling lifecycle
```

`src/jobs/merchgrid-source-pack.ts`, `src/storage/metric-snapshots.ts`, and all provider connectors are intentionally left behaviorally unchanged: the existing weekly builder and snapshot reader already provide the ingestion boundary. Historical files under `artifacts/merchgrid/metrics/workflow-runs/` and historical specs/plans remain untouched because they are records of prior behavior, not active command documentation.

> **DDIA lens - schema evolution and derived lookup:** Optional persisted fields preserve the meaning of old run files, while the strict rolling boundary requires complete identity for new data. The JSON adapter derives product history from authoritative runs instead of introducing a second file that could drift.

> **FODE lens - curated reuse:** The weekly artifact is the curated analytical product between the source pipeline and workflow. The plan reuses that artifact by reference in two roles without re-querying providers or copying raw data.

> **AIAIA lens - bounded memory:** Agents receive one schema-validated M7 learning projection with provenance. The deterministic coordinator—not the model—selects the prior run, confirms application, and controls lifecycle transitions.

> **APOSD lens - information hiding:** A dedicated coordinator hides lookup, closure, lineage, and retry mechanics behind one operation while leaving the engine, storage, profile, and agent boundaries independently testable.

> **HFDP lens - Facade:** `marketplace:next-review` is a Facade over existing lifecycle capabilities. The pattern clarifies why one user command can coexist with several internal domain operations.

## End-to-End Execution/Data Flow

This execution/data flow shows how the implementation-plan tasks connect at runtime. Each numbered box maps to a task below.

```text
OWNER + LOCAL CONFIG
profile, productRef, through date, curated context
        |
        v
+----------------------------------------------------------------+
| [Task 6] marketplace:next-review CLI                            |
| Runtime-validate arguments; prompt applied/no only when needed  |
| HUMAN FACT BOUNDARY: no default, cancellation writes nothing    |
+-------------------------------+--------------------------------+
                                |
                                v
+----------------------------------------------------------------+
| [Task 4] Weekly evidence/profile boundary                       |
| Reuse/build from local completed snapshots; validate period,    |
| coverage, safe aggregate signals, context, and product identity |
+-------------------------------+--------------------------------+
                                |
                                v
+----------------------------------------------------------------+
| [Task 2] Run-history repository                                 |
| Scan validated run.json records; exact profile + productRef;    |
| newest createdAt/runId wins; legacy runs without identity skip  |
+-------------------------------+--------------------------------+
                                |
                                v
+----------------------------------------------------------------+
| [Task 5] Rolling coordinator                                    |
| Check cycle idempotence; resolve prior run before new creation  |
+----------------+-------------------------------+---------------+
                 |                               |
        applied + date                    not_applied
                 |                               |
                 v                               v
+-------------------------------+   +----------------------------+
| [Task 3] Same-run closure      |   | [Task 3] Stop prior run    |
| application -> result evidence|   | no M2/M7 fabricated        |
| -> M2 Results -> M7           |   +--------------+-------------+
+---------------+---------------+                  |
                +-----------------------+-----------+
                                        |
                                        v
+----------------------------------------------------------------+
| [Task 1 + 4] Cross-run handoff                                  |
| Fresh weekly evidence + optional validated PriorLearningContext |
| References only; no historical run/event/prompt payload         |
+-------------------------------+--------------------------------+
                                |
                                v
+----------------------------------------------------------------+
| [Task 3 + 4] New immutable run                                  |
| Existing engine: M1/M2/M4/M5/M6 with bounded M3 side routes     |
| AGENT BOUNDARY: structured outputs; engine owns legal routing    |
+-------------------------------+--------------------------------+
                                |
                                v
+----------------------------------------------------------------+
| [Task 7] Local persistence and owner-visible result             |
| run.json source of record; derived plan/evidence/events files   |
| HUMAN ACTION GATE: owner alone may edit Shopify                 |
+----------------------------------------------------------------+
```

Only validated aggregate evidence, safe curated context, stable product identity, and the owner-supplied application fact cross into the coordinator. The previous run is persisted before the new run is created; retry logic uses the deterministic cycle key to recover if the second write fails. `run.json` and daily snapshots remain sources of record. Weekly reviews, experiment plans, evidence files, and event streams remain derived. Model behavior is allowed inside existing structured modules and bounded M3 research; it cannot select history, assert application, alter dates, route stages, or perform marketplace writes. No code path in this plan contacts a marketplace to mutate it.

## Shared Interfaces

All untrusted input and all persisted additions must be runtime-validated with Zod. TypeScript types are inferred from those schemas rather than maintained independently.

```ts
const ProductRefSchema = z.string()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const MarketplaceProductIdentitySchema = z.object({
  profile: MarketplaceVisibilityProfileSchema,
  productRef: ProductRefSchema,
}).strict();

const ExperimentApplicationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), appliedAt: UtcDateSchema }).strict(),
  z.object({
    status: z.literal('not_applied'),
    decidedAt: z.string().datetime(),
  }).strict(),
]);

const PriorLearningContextSchema = z.object({
  sourceRunId: z.string().min(1),
  sourceEvidenceRef: z.string().min(1),
  experimentPlanRef: z.string().min(1),
  outcome: EvaluationOutputSchema.shape.outcome,
  hypothesisEvaluation: EvaluationOutputSchema.shape.hypothesisEvaluation,
  learning: EvaluationOutputSchema.shape.learning,
  confidence: EvaluationOutputSchema.shape.confidence,
  nextAction: EvaluationOutputSchema.shape.nextAction,
  nextActionRationale: EvaluationOutputSchema.shape.nextActionRationale,
}).strict();

// Legacy-readable base contracts:
type MarketplaceVisibilityContext = ExistingContext & { productRef?: ProductRef };
type MarketplaceVisibilityEvidence = ExistingEvidence & { productRef?: ProductRef };
type WorkflowRunState = ExistingRunState & {
  marketplaceIdentity?: MarketplaceProductIdentity;
  experimentApplication?: ExperimentApplication;
  previousRunRef?: string;
  priorLearning?: PriorLearningContext;
};

// New rolling boundary requires the optional legacy fields:
const RollingMarketplaceVisibilityContextSchema =
  MarketplaceVisibilityContextSchema.extend({ productRef: ProductRefSchema });

type MarketplaceRunHistoryRepository = RunRepository & {
  findLatestByProduct(identity: MarketplaceProductIdentity):
    Promise<WorkflowRunState | undefined>;
};

type OwnerApplicationPrompt = {
  confirm(input: {
    previousRunId: string;
    experimentSummary: string;
  }): Promise<
    | { status: 'applied'; appliedAt: string }
    | { status: 'not_applied' }
    | { status: 'cancelled' }
  >;
};

type RollingReviewInput = {
  profile: MarketplaceVisibilityProfile;
  productRef: ProductRef;
  through: string;
  contextPath: string;
  listingContextPath?: string;
};

type RollingReviewResult = {
  previousRun?: {
    runId: string;
    resolution: 'evaluated' | 'not_applied' | 'already_resolved';
  };
  currentRun: {
    runId: string;
    status: WorkflowStatus;
    stage: WorkflowStage;
    experimentPlanRef?: string;
  };
};

type MarketplaceRollingReviewService = {
  nextReview(input: RollingReviewInput): Promise<RollingReviewResult>;
};

type WorkflowEngine = ExistingWorkflowEngine & {
  recordExperimentApplication(input: {
    runId: string;
    application: ExperimentApplication;
  }): Promise<WorkflowRunState>;
};
```

`sourceRunId`, `sourceEvidenceRef`, `experimentPlanRef`, `previousRunRef`, and artifact paths are local references, not embedded provider data. `OwnerApplicationPrompt` is a human-input port; its result is re-parsed with `ExperimentApplicationSchema` after adding the deterministic `decidedAt` clock value for `not_applied`. `PriorLearningContext` contains only fields already validated by `EvaluationOutputSchema`. Raw provider payloads, full prior runs, event arrays, prompts, credentials, private URLs, customer records, and model-provider response objects are prohibited.

> **DDIA lens - lineage and idempotence:** Explicit previous-run and evidence references preserve how the new decision was derived. The deterministic cycle identity prevents retry from duplicating the logical review.

> **AIAIA lens - human fact versus model interpretation:** The owner supplies whether the experiment happened; M7 interprets measured results only after that fact and its date pass deterministic validation.

## Tasks

### Task 1: Define Stable Product, Application, and Prior-Learning Contracts

**Purpose:** Add the runtime-validated vocabulary required to link independent marketplace runs without breaking historical JSON.

**Why:** Current date-based subject references cannot identify one product across cycles, and the existing approval union cannot accurately represent the simplified applied/not-applied fact. These meanings must be fixed before storage or orchestration consumes them.

**How:** Add the schemas shown in Shared Interfaces, make their persisted appearances optional for legacy parsing, and require `productRef` through a strict rolling-context parser. Update the safe tracked MerchGrid context examples so the first real rolling invocation has stable identity. Do not alter historical run artifacts.

**Learning lenses:**

- **DDIA lens - schema evolution:** Optional fields let old records retain their original meaning, while a stricter write boundary prevents new rolling records from omitting identity.
- **AIAIA lens - bounded memory contract:** The prior-learning schema projects only the M7 fields needed by the next decision and excludes unbounded run history.

**Files:**

- Modify: `src/contracts/marketplace-visibility.ts`
- Modify: `src/contracts/workflow.ts`
- Modify: `src/connectors/marketplace/local-context.ts`
- Modify: `docs/examples/merchgrid-visibility-context.example.json`
- Modify: `artifacts/merchgrid/context/merchgrid-visibility-context.json`
- Test: `src/tests/contracts/marketplace-visibility.test.ts`
- Test: `src/tests/contracts/contracts.test.ts`
- Test: `src/tests/connectors/marketplace-local-context.test.ts`

**Interfaces:**

- Consumes: `MarketplaceVisibilityProfileSchema`, `UtcDateSchema`, `EvaluationOutputSchema`, `MarketplaceVisibilityContextSchema`, `MarketplaceVisibilityEvidenceSchema`, and `WorkflowRunStateSchema`.
- Produces: `ProductRefSchema`, `MarketplaceProductIdentitySchema`, `ExperimentApplicationSchema`, `PriorLearningContextSchema`, `RollingMarketplaceVisibilityContextSchema`, `parseRollingMarketplaceVisibilityContext(value)`, and optional rolling fields on persisted evidence/run state.

- [ ] **Step 1: Write focused failing tests**

Add tests proving legacy context/evidence/run fixtures still parse without rolling fields, new rolling context requires a safe product reference, identity mismatches fail, application variants are exclusive, prior learning accepts only M7 fields, and credential-like or path-like product references fail.

```ts
it('requires safe stable identity at the rolling boundary while legacy context still parses', () => {
  expect(MarketplaceVisibilityContextSchema.parse(legacyContext())).not.toHaveProperty('productRef');
  expect(() => parseRollingMarketplaceVisibilityContext(legacyContext())).toThrow();
  expect(parseRollingMarketplaceVisibilityContext({
    ...legacyContext(),
    productRef: 'merchgrid-shopify-app',
  }).productRef).toBe('merchgrid-shopify-app');
});

it.each(['MerchGrid App', '../merchgrid', 'shop.example.test', 'api-key'])('rejects unsafe productRef %s', (productRef) => {
  expect(() => ProductRefSchema.parse(productRef)).toThrow();
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- src/tests/contracts/marketplace-visibility.test.ts src/tests/contracts/contracts.test.ts src/tests/connectors/marketplace-local-context.test.ts`

Expected: FAIL because the rolling schemas, parser, and persisted fields do not exist and the context loaders do not distinguish legacy from rolling validation.

- [ ] **Step 3: Implement the smallest behavior that satisfies the tests**

Implement the Zod schemas and inferred types in `src/contracts/marketplace-visibility.ts`, add optional fields to `WorkflowRunStateSchema`, and add a strict rolling loader beside `loadMarketplaceVisibilityContext()`. Add `"productRef": "merchgrid-shopify-app"` to the tracked current/example contexts. Keep `MarketplaceVisibilityContextSchema` and `MarketplaceVisibilityEvidenceSchema` legacy-readable; enforce the required field only in the rolling parser.

```ts
export async function loadRollingMarketplaceVisibilityContext(path: string) {
  const value = await loadLocalJson(path);
  return parseWithSchema(
    RollingMarketplaceVisibilityContextSchema,
    value,
    'rolling marketplace visibility context',
  );
}
```

Implementation rules:

- Keep the change scoped to the files named above.
- Preserve existing behavior unless this task explicitly changes it.
- Use runtime validation at untrusted boundaries.
- Use fakes, fixtures, and fixed clocks in tests.
- Do not call real external systems.
- Do not persist or log prohibited data.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- src/tests/contracts/marketplace-visibility.test.ts src/tests/contracts/contracts.test.ts src/tests/connectors/marketplace-local-context.test.ts && npm run typecheck`

Expected: PASS, including historical fixture parsing, strict rolling identity, discriminated application decisions, safe prior-learning projection, and unsafe-value rejection.

- [ ] **Step 5: Commit this task**

```bash
git add src/contracts/marketplace-visibility.ts src/contracts/workflow.ts src/connectors/marketplace/local-context.ts src/tests/contracts/marketplace-visibility.test.ts src/tests/contracts/contracts.test.ts src/tests/connectors/marketplace-local-context.test.ts docs/examples/merchgrid-visibility-context.example.json artifacts/merchgrid/context/merchgrid-visibility-context.json
git commit -m "feat: define rolling marketplace contracts"
```

### Task 2: Add Exact Product-History Lookup to JSON Run Storage

**Purpose:** Let the rolling coordinator find the latest valid run for one exact marketplace product identity without requiring owner-managed run IDs.

**Why:** `RunRepository` currently supports only create/load/save, and filename/date inference could link unrelated Shopify or Etsy runs. History lookup belongs behind the storage boundary.

**How:** Define `MarketplaceRunHistoryRepository` as an extension of the existing repository interface and implement `findLatestByProduct()` in `JsonFileRunRepository`. Enumerate directories under the configured run root, parse every discovered `run.json` through the existing schema, filter exact identity, and sort descending by `createdAt` then `runId`. Ignore valid legacy runs that lack identity; reject corrupt or schema-invalid records instead of silently hiding storage damage.

**Learning lenses:**

- **DDIA lens - secondary access path:** The query derives from authoritative records at current scale. A later database may index the same identity without changing coordinator semantics.
- **APOSD lens - interface segregation:** Engine consumers retain the small base repository interface; only the rolling coordinator depends on history lookup.

**Files:**

- Modify: `src/storage/runs.ts`
- Test: `src/tests/storage/runs.test.ts`

**Interfaces:**

- Consumes: `RunRepository`, `JsonFileRunRepository`, `WorkflowRunStateSchema`, and `MarketplaceProductIdentity` from Task 1.
- Produces: `MarketplaceRunHistoryRepository` and `JsonFileRunRepository.findLatestByProduct(identity)`.

- [ ] **Step 1: Write focused failing tests**

Add temporary-directory tests for no matches, exact Shopify match, profile isolation, product isolation, newest `createdAt`, deterministic `runId` tie-breaking, legacy omission, and corrupt candidate failure.

```ts
it('finds only the newest exact profile and productRef match', async () => {
  await repository.create(rollingRun('older', '2026-09-01T00:00:00.000Z'));
  await repository.create(rollingRun('newer', '2026-09-08T00:00:00.000Z'));
  await repository.create(rollingRun('other-product', '2026-09-09T00:00:00.000Z', 'other-app'));

  await expect(repository.findLatestByProduct({
    profile: 'merchgrid_shopify_app_store',
    productRef: 'merchgrid-shopify-app',
  })).resolves.toMatchObject({ runId: 'newer' });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- src/tests/storage/runs.test.ts`

Expected: FAIL because the history interface and JSON-file query are missing.

- [ ] **Step 3: Implement the smallest behavior that satisfies the tests**

Use `readdir(rootDir, { withFileTypes: true })`, sort directory names before loading for deterministic failure order, parse candidates with the existing `load()` path, then choose the latest exact identity.

```ts
export type MarketplaceRunHistoryRepository = RunRepository & {
  findLatestByProduct(identity: MarketplaceProductIdentity): Promise<WorkflowRunState | undefined>;
};
```

Return `undefined` when the root directory does not exist or no valid identified run matches. Do not cache or persist an index.

Implementation rules:

- Keep the change scoped to the files named above.
- Preserve existing behavior unless this task explicitly changes it.
- Use runtime validation at untrusted boundaries.
- Use fakes, fixtures, and fixed clocks in tests.
- Do not call real external systems.
- Do not persist or log prohibited data.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- src/tests/storage/runs.test.ts && npm run typecheck`

Expected: PASS with exact identity isolation, deterministic ordering, legacy omission, missing-root handling, and visible corruption failures.

- [ ] **Step 5: Commit this task**

```bash
git add src/storage/runs.ts src/tests/storage/runs.test.ts
git commit -m "feat: query marketplace run history"
```

### Task 3: Persist Experiment Application and Cross-Run Lineage in the Engine

**Purpose:** Give the deterministic engine explicit operations for recording applied/not-applied facts and starting a marketplace run with lineage.

**Why:** The rolling coordinator must not mutate run objects directly or reuse the old approval command's meaning. Engine-owned transitions keep invalid stages, duplicate application, and fabricated outcomes out of persisted state.

**How:** Add `recordExperimentApplication()` to the engine. Accept application only from `approval_wait/awaiting_approval`; `applied` moves to `experiment_wait/ready_for_experiment`, while `not_applied` records a terminal stopped state without M2/M7. Extend `startMarketplaceVisibility()` input to persist identity, optional `previousRunRef`, and optional `priorLearning`. Keep old approve/reject engine methods unchanged for non-marketplace consumers and legacy tests.

**Learning lenses:**

- **DDIA lens - state transition integrity:** One engine operation validates and persists each application fact with its event, preventing partial state that claims both applied and rejected.
- **AIAIA lens - deterministic control:** Human facts and legal stages are enforced by code; agent modules remain unable to approve, skip, or start experiments.

**Files:**

- Modify: `src/workflow/engine.ts`
- Test: `src/tests/workflow/engine.test.ts`
- Test: `src/tests/workflow/marketplace-visibility-engine.test.ts`

**Interfaces:**

- Consumes: `ExperimentApplication`, `MarketplaceProductIdentity`, `PriorLearningContext`, current `startMarketplaceVisibility()`, `approveExperiment()`, `rejectExperiment()`, `withEvent()`, and `persist()`.
- Produces: `recordExperimentApplication({ runId, application })` and extended marketplace start input with identity and lineage.

- [ ] **Step 1: Write focused failing tests**

Test applied transition/event/date persistence, not-applied terminal behavior, wrong-stage rejection, duplicate-decision rejection, no M2/M7 fabrication, and new-run identity/lineage persistence. Retain a test proving existing `approveExperiment()` still works.

```ts
it('records not_applied without fabricating result or learning outputs', async () => {
  const stopped = await engine.recordExperimentApplication({
    runId: 'prior-run',
    application: { status: 'not_applied', decidedAt: fixedNow.toISOString() },
  });

  expect(stopped).toMatchObject({ status: 'stopped', experimentApplication: { status: 'not_applied' } });
  expect(stopped.moduleOutputs.m2Results).toBeUndefined();
  expect(stopped.moduleOutputs.m7).toBeUndefined();
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- src/tests/workflow/engine.test.ts src/tests/workflow/marketplace-visibility-engine.test.ts`

Expected: FAIL because the application operation and rolling start metadata are absent.

- [ ] **Step 3: Implement the smallest behavior that satisfies the tests**

Add the engine method and emit `experiment.applied` or `experiment.not_applied` with bounded date/status data. Reuse `assertCanRunStage()` for the applied transition. Persist rolling metadata in the initial marketplace state, after re-parsing it through Task 1 schemas.

```ts
async function recordExperimentApplication(input: RecordExperimentApplicationInput) {
  const state = await repository.load(input.runId);
  assertAwaitingOwnerApplication(state);
  return input.application.status === 'applied'
    ? persistAppliedExperiment(state, input.application)
    : persistNotAppliedExperiment(state, input.application);
}
```

Implementation rules:

- Keep the change scoped to the files named above.
- Preserve existing behavior unless this task explicitly changes it.
- Use runtime validation at untrusted boundaries.
- Use fakes, fixtures, and fixed clocks in tests.
- Do not call real external systems.
- Do not persist or log prohibited data.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- src/tests/workflow/engine.test.ts src/tests/workflow/marketplace-visibility-engine.test.ts && npm run typecheck`

Expected: PASS for applied, not-applied, invalid-stage, duplicate-decision, lineage, event, and legacy approval behavior.

- [ ] **Step 5: Commit this task**

```bash
git add src/workflow/engine.ts src/tests/workflow/engine.test.ts src/tests/workflow/marketplace-visibility-engine.test.ts
git commit -m "feat: record marketplace experiment application"
```

### Task 4: Reuse Weekly Evidence and Bound Prior Learning at the Marketplace Profile

**Purpose:** Convert one validated weekly artifact into the two safe evidence projections needed to close the prior run and begin the next run, while exposing bounded prior learning to modules.

**Why:** Current marketplace start logic reads daily health, current result logic relies on the old approval date, and M1 does not describe prior learning. The rolling cycle needs one explicit profile seam that preserves evidence role and lineage without re-querying providers.

**How:** Refactor the marketplace profile around pure evidence builders: one result projection keeps the previous run's `subjectRef`; one next-baseline projection uses `merchgrid:visibility:<through>` and the same artifact reference. Validate result windows against `experimentApplication.appliedAt`, falling back only for legacy approved runs. Project M7 through `PriorLearningContextSchema`, and include that bounded snapshot in deterministic M1 notes and model-backed M4/M5/M6 state.

**Learning lenses:**

- **FODE lens - lineage-aware reuse:** The weekly review is a curated downstream data product. Each run records whether it consumed that artifact as a result or baseline instead of duplicating or reinterpreting raw sources.
- **AIAIA lens - scoped retrieval:** Only one validated prior-learning projection reaches agent context; model code does not search run folders or choose history.

**Files:**

- Modify: `src/workflow/marketplace-visibility-profile.ts`
- Modify: `src/agents/marketplace-visibility/modules.ts`
- Test: `src/tests/workflow/marketplace-visibility-profile.test.ts`
- Test: `src/tests/agents/marketplace-visibility.test.ts`

**Interfaces:**

- Consumes: Task 1 rolling schemas, Task 3 engine inputs, `MerchGridReviewEvidence`, `MarketplaceVisibilityEvidenceSchema`, `metricsFromMarketplaceVisibilityResult()`, and current M1/M4/M5/M6 module wiring.
- Produces: `buildRollingVisibilityEvidence({ artifact, identity, through, context, listingContext })`, `buildResultEvidenceForRun({ state, freshEvidence })`, `priorLearningFromRun(state)`, and refactored profile start/result methods used by Task 5.

- [ ] **Step 1: Write focused failing tests**

Test that one weekly artifact produces two projections with the same `artifactRef` but appropriate subject/evidence roles; application date, profile, and product mismatches fail; legacy approved runs still validate; prior learning contains only selected M7 fields; not-applied/no-M7 runs return no learning; and M1/model input contains the safe learning but no prior events or credentials.

```ts
it('reuses one weekly artifact as prior result and next baseline without copying history', () => {
  const fresh = buildRollingVisibilityEvidence(rollingEvidenceInput());
  const result = buildResultEvidenceForRun({ state: priorAppliedRun(), freshEvidence: fresh });

  expect(result.artifactRef).toBe(fresh.artifactRef);
  expect(result.subjectRef).toBe(priorAppliedRun().subjectRef);
  expect(fresh.subjectRef).toBe('merchgrid:visibility:2026-09-07');
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- src/tests/workflow/marketplace-visibility-profile.test.ts src/tests/agents/marketplace-visibility.test.ts`

Expected: FAIL because weekly baseline projection, experiment-application validation, M7 projection, and prior-learning module context do not exist.

- [ ] **Step 3: Implement the smallest behavior that satisfies the tests**

Extract pure builders from the existing profile instead of adding provider access. Update result validation to prefer `experimentApplication.appliedAt`, with the old approved date only as a legacy fallback. Construct `PriorLearningContext` only after M7 exists and validates. Keep current research suppression/enabled behavior and structured module output schemas unchanged.

```ts
export function priorLearningFromRun(state: WorkflowRunState): PriorLearningContext | undefined {
  if (!state.moduleOutputs.m7) return undefined;
  return PriorLearningContextSchema.parse({
    sourceRunId: state.runId,
    sourceEvidenceRef: requireResultEvidenceRef(state),
    experimentPlanRef: `workflow-runs/${state.runId}/experiment-plan.json`,
    ...pickEvaluationLearning(state.moduleOutputs.m7),
  });
}
```

Implementation rules:

- Keep the change scoped to the files named above.
- Preserve existing behavior unless this task explicitly changes it.
- Use runtime validation at untrusted boundaries.
- Use fakes, fixtures, and fixed clocks in tests.
- Do not call real external systems.
- Do not persist or log prohibited data.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- src/tests/workflow/marketplace-visibility-profile.test.ts src/tests/agents/marketplace-visibility.test.ts && npm run typecheck`

Expected: PASS for dual-role artifact lineage, applied-date boundaries, legacy fallback, bounded M7 projection, not-applied omission, and sanitized agent context.

- [ ] **Step 5: Commit this task**

```bash
git add src/workflow/marketplace-visibility-profile.ts src/agents/marketplace-visibility/modules.ts src/tests/workflow/marketplace-visibility-profile.test.ts src/tests/agents/marketplace-visibility.test.ts
git commit -m "feat: carry marketplace learning between runs"
```

### Task 5: Build the Idempotent Rolling-Review Coordinator

**Purpose:** Implement the deterministic facade that resolves the previous run and starts exactly one next run.

**Why:** Lookup, owner confirmation, previous-run closure, prior-learning selection, and new-run creation form one product transaction boundary. Scattering them across the CLI would expose temporal coupling and make retries unsafe.

**How:** Create a coordinator with injected run history, profile evidence preparation, workflow engine, owner prompt, and fixed clock. Prepare/validate fresh weekly evidence before prompting or mutating. Derive the cycle run ID from `profile + productRef + through`. Return an existing same-cycle run first; otherwise resolve only the latest exact-identity run, persist its terminal state, then create/advance the new run.

**Learning lenses:**

- **DDIA lens - idempotent workflow:** The operation uses a deterministic cycle identity and durable phase ordering so retry resumes missing work rather than duplicating completed work.
- **APOSD lens - temporal coupling:** One deep coordinator owns the required order—validate evidence, resolve old run, create new run—so callers cannot invoke those steps incorrectly.
- **HFDP lens - Facade:** The coordinator presents one product operation while delegating existing storage, profile, and engine responsibilities.

**Files:**

- Create: `src/workflow/marketplace-rolling-review.ts`
- Test: `src/tests/workflow/marketplace-rolling-review.test.ts`

**Interfaces:**

- Consumes: `MarketplaceRunHistoryRepository`, `OwnerApplicationPrompt`, Task 3 engine operations, Task 4 profile builders/services, `runWeeklyReview()` through an injected `prepareWeeklyEvidence(through)` function, and fixed `now()`.
- Produces: `createMarketplaceRollingReviewService(deps)`, `MarketplaceRollingReviewService.nextReview(input)`, and `rollingVisibilityRunId(identity, through)`.

- [ ] **Step 1: Write focused failing tests**

Cover first run/no prompt, applied prior plan, not-applied prior plan, already-completed prior run, same-cycle retry, cancelled prompt, invalid application date, missing weekly evidence, unresolved research/data wait, exact identity isolation, failure after prior closure, and no duplicate engine/module calls.

```ts
it('closes an applied prior run before starting one next run', async () => {
  const result = await service.nextReview(nextReviewInput());

  expect(callOrder).toEqual([
    'prepare-weekly-evidence',
    'find-latest-product-run',
    'prompt-owner',
    'record-applied',
    'supply-result',
    'run-m2-results',
    'run-m7',
    'start-next-run',
  ]);
  expect(result.previousRun?.resolution).toBe('evaluated');
});

it('returns the existing same-cycle run without prompting or evaluating again', async () => {
  await service.nextReview(nextReviewInput());
  await service.nextReview(nextReviewInput());
  expect(prompt.confirm).toHaveBeenCalledTimes(1);
  expect(engine.runM7).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- src/tests/workflow/marketplace-rolling-review.test.ts`

Expected: FAIL because the coordinator module and rolling-cycle functions do not exist.

- [ ] **Step 3: Implement the smallest behavior that satisfies the tests**

Implement the coordinator as an ordered service, not a second workflow engine. Reuse the existing stage-stepping loop for M2/M7 and M1-M6/M3 advancement through an injected helper or narrow engine port. Validate the owner response again inside the coordinator. If cancellation occurs, return a bounded cancellation result or error before calling Task 3 methods.

```ts
export function rollingVisibilityRunId(identity: MarketplaceProductIdentity, through: string): string {
  return `${through}-${identity.profile}-${identity.productRef}`;
}

export function createMarketplaceRollingReviewService(deps: RollingReviewDependencies) {
  return {
    async nextReview(input: RollingReviewInput): Promise<RollingReviewResult> {
      const prepared = await prepareAndValidate(input, deps);
      const existing = await findExistingCycle(prepared, deps.history);
      if (existing) return resultForExisting(existing);
      const previous = await deps.history.findLatestByProduct(prepared.identity);
      const learning = await resolvePrevious(previous, prepared, deps);
      return startNext(prepared, previous, learning, deps);
    },
  };
}
```

Implementation rules:

- Keep the change scoped to the files named above.
- Preserve existing behavior unless this task explicitly changes it.
- Use runtime validation at untrusted boundaries.
- Use fakes, fixtures, and fixed clocks in tests.
- Do not call real external systems.
- Do not persist or log prohibited data.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- src/tests/workflow/marketplace-rolling-review.test.ts && npm run typecheck`

Expected: PASS for every lifecycle branch, strict operation ordering, retry recovery, cancellation without mutation, exact identity, and call-count idempotence.

- [ ] **Step 5: Commit this task**

```bash
git add src/workflow/marketplace-rolling-review.ts src/tests/workflow/marketplace-rolling-review.test.ts
git commit -m "feat: orchestrate rolling marketplace reviews"
```

### Task 6: Replace the Marketplace CLI with One Interactive Command

**Purpose:** Make `marketplace:next-review` the only public marketplace visibility lifecycle command.

**Why:** The owner should not need to understand internal approval/result stages or manage run IDs. The CLI must translate one command and one conditional human prompt into the coordinator contract.

**How:** Replace old parser branches with `next-review`, add `--profile`, `--product-ref`, `--through`, optional `--context`, and optional `--listing-context`, and inject an `OwnerApplicationPrompt` into tests. The runtime prompt uses `node:readline/promises`, accepts only explicit yes/no and a valid UTC date, and closes its interface in `finally`. Compose weekly-review building from local snapshot/artifact repositories without provider adapters. Replace the four package scripts with one.

**Learning lenses:**

- **AIAIA lens - human approval boundary:** The prompt captures a real-world fact from the owner and returns a structured decision; it is not a model prompt and has no inferred default.
- **APOSD lens - error abstraction:** CLI errors remain bounded `AppError` codes rather than leaking filesystem, readline, or provider details.

**Files:**

- Modify: `src/cli/marketplace-visibility.ts`
- Modify: `src/tests/cli/marketplace-visibility.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: Task 5 `MarketplaceRollingReviewService`, `OwnerApplicationPrompt`, existing environment defaults, `JsonFileRunRepository`, `JsonFileMetricSnapshotRepository`, `JsonFileMerchGridReviewArtifactRepository`, and `runWeeklyReview()`.
- Produces: `runMarketplaceVisibilityCli()` accepting only `next-review`, runtime `createOwnerApplicationPrompt()`, and package script `marketplace:next-review`.

- [ ] **Step 1: Write focused failing tests**

Rewrite CLI tests to cover argument forwarding, generated run output, applied prompt sequence, not-applied response, invalid answer/date, cancellation, no prompt on first/already-resolved run, safe printed fields, and rejection of all four old command names.

```ts
it.each(['visibility-review', 'approve', 'reject', 'record-result'])('rejects removed command %s', async (command) => {
  await expect(runMarketplaceVisibilityCli(cliInput([command]))).rejects.toMatchObject({
    code: 'validation_failed',
    message: 'Expected next-review command',
  });
});

it('forwards one structured owner response to the rolling service', async () => {
  await runMarketplaceVisibilityCli(cliInput([
    'next-review', '--profile', 'merchgrid_shopify_app_store',
    '--product-ref', 'merchgrid-shopify-app', '--through', '2026-09-07',
  ]));
  expect(nextReview).toHaveBeenCalledWith(expect.objectContaining({
    productRef: 'merchgrid-shopify-app', through: '2026-09-07',
  }));
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- src/tests/cli/marketplace-visibility.test.ts`

Expected: FAIL because `next-review`, the prompt adapter, coordinator composition, and new package script are absent while old handlers still exist.

- [ ] **Step 3: Implement the smallest behavior that satisfies the tests**

Remove the old CLI dependency shape and handler branches. Add the rolling service as the CLI dependency. Keep terminal I/O at the composition boundary and pass only the structured prompt result to the coordinator. Use the existing JSON file classes and `runWeeklyReview()` to build from local snapshots when the requested weekly artifact is absent; do not construct PostHog, Fly, or Shopify adapters.

```ts
if (command !== 'next-review') {
  throw new AppError('validation_failed', 'Expected next-review command');
}

await dependencies.rollingReviews.nextReview({
  profile: parseProfile(option(options, '--profile')),
  productRef: ProductRefSchema.parse(option(options, '--product-ref')),
  through: UtcDateSchema.parse(option(options, '--through')),
  contextPath: optionalOption(options, '--context') ?? dependencies.defaultContextPath,
  listingContextPath: optionalOption(options, '--listing-context') ?? dependencies.defaultListingContextPath,
});
```

Implementation rules:

- Keep the change scoped to the files named above.
- Preserve existing behavior unless this task explicitly changes it.
- Use runtime validation at untrusted boundaries.
- Use fakes, fixtures, and fixed clocks in tests.
- Do not call real external systems.
- Do not persist or log prohibited data.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- src/tests/cli/marketplace-visibility.test.ts && npm run typecheck && npm run build`

Expected: PASS for the single command, conditional prompt, cancellation, safe output, removed-command rejection, local weekly preparation, and compiled package script.

- [ ] **Step 5: Commit this task**

```bash
git add src/cli/marketplace-visibility.ts src/tests/cli/marketplace-visibility.test.ts package.json
git commit -m "feat: replace marketplace lifecycle commands"
```

### Task 7: Verify the Two-Run Lifecycle and Update Active Documentation

**Purpose:** Prove the complete rolling cycle with persisted files and make all active guidance describe the new single-command interface.

**Why:** Unit tests can miss cross-boundary mistakes in evidence reuse, event ordering, lineage, and artifact projections. Active docs must not send the owner back to removed commands, while historical records must remain intact.

**How:** Add a network-free end-to-end test using temporary snapshot/artifact/run directories, fixed clock, fake owner prompt, and fake agent outputs. Exercise an applied prior run through M2/M7 and the next run through M6; assert two independent `run.json` files, one shared weekly artifact reference, bounded prior learning, and no duplicate work on retry. Update README, contracts documentation, and review checklist without modifying historical specs, plans, or run artifacts.

**Learning lenses:**

- **DDIA lens - recovery and lineage:** The end-to-end assertion proves durable ordering and traceable reuse across two independent aggregates, including retry after partial completion.
- **AIAIA lens - feedback-loop closure:** The test demonstrates that human-confirmed application and model-evaluated learning are separate boundaries joined by deterministic orchestration.

**Files:**

- Create: `src/tests/workflow/marketplace-rolling-review.e2e.test.ts`
- Modify: `README.md`
- Modify: `src/contracts/README.md`
- Modify: `TODO.md`

**Interfaces:**

- Consumes: all Tasks 1-6 interfaces, existing fake agent runner, JSON repositories, source-pack artifact builder, workflow event projections, and current README architecture sections.
- Produces: a persisted lifecycle regression test and active documentation containing only the supported marketplace command.

- [ ] **Step 1: Write the focused failing end-to-end test**

Create snapshots/weekly evidence and an awaiting prior plan under a temporary root. Run `nextReview()` with an injected applied date, then retry the identical cycle.

```ts
it('closes one run, carries bounded learning, and creates one idempotent next run', async () => {
  const first = await rollingReviews.nextReview(input);
  const retry = await rollingReviews.nextReview(input);

  const previous = await runs.load('previous-run');
  const current = await runs.load(first.currentRun.runId);
  expect(previous.moduleOutputs.m7).toBeDefined();
  expect(current.previousRunRef).toBe('previous-run');
  expect(current.priorLearning?.sourceRunId).toBe('previous-run');
  expect(current.evidenceSnapshots?.initial?.artifactRef)
    .toBe(previous.evidenceSnapshots?.result?.artifactRef);
  expect(retry.currentRun.runId).toBe(first.currentRun.runId);
  expect(await countRunDirectories(rootDir)).toBe(2);
});
```

- [ ] **Step 2: Run the end-to-end test to verify it fails**

Run: `npm test -- src/tests/workflow/marketplace-rolling-review.e2e.test.ts`

Expected: FAIL until the integrated composition persists both run roles, prior learning, event order, and idempotent retry exactly as designed.

- [ ] **Step 3: Complete the smallest integration and documentation changes**

Fix only integration defects exposed by the test in files already owned by Tasks 1-6, then update active documentation. Preserve the current uncommitted README tracing and systems-thinking edits while replacing its four old marketplace commands and manual run-ID instructions with the single command. Document the `productRef`, interactive application question, weekly evidence prerequisite, same-artifact/two-role lineage, M2/M7 closure, and manual marketplace boundary. Update `src/contracts/README.md` with the new schemas and `TODO.md` with the rolling-cycle review questions.

Use this active command example, with no production URL or secret values:

```bash
npm run marketplace:next-review -- \
  --profile merchgrid_shopify_app_store \
  --product-ref merchgrid-shopify-app \
  --through 2026-09-07 \
  --context artifacts/merchgrid/context/merchgrid-visibility-context.json \
  --listing-context artifacts/merchgrid/context/merchgrid-listing-context.json
```

Implementation rules:

- Keep implementation fixes scoped to files already named by Tasks 1-6.
- Preserve existing MerchGrid, Etsy, M3, persistence, and trace behavior.
- Use runtime validation at untrusted boundaries.
- Use fakes, fixtures, and fixed clocks in tests.
- Do not call real external systems.
- Do not persist or log prohibited data.

- [ ] **Step 4: Run focused and removal verification**

Run:

```bash
npm test -- src/tests/workflow/marketplace-rolling-review.e2e.test.ts
if rg -n 'marketplace:(visibility-review|approve|reject|record-result)' package.json README.md TODO.md src; then exit 1; fi
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: PASS with 0 occurrences of removed marketplace commands in active code/docs, all repository tests green, TypeScript clean, build output generated, no whitespace errors, two immutable run records, safe lineage, and no real network or provider writes.

- [ ] **Step 5: Commit this task**

Stage the new end-to-end test, documentation, and only the Task 1-6 files that required an integration correction:

```bash
git add src/tests/workflow/marketplace-rolling-review.e2e.test.ts README.md src/contracts/README.md TODO.md
git commit -m "docs: complete rolling marketplace workflow"
```

Before committing, run `git status --short` and add any integration-correction file explicitly; do not use `git add .`, and do not stage historical artifacts or unrelated user changes.

## Spec Coverage Review

| Design requirement | Plan task |
| --- | --- |
| One public `marketplace:next-review` command | Task 6 |
| Remove the four old marketplace lifecycle commands and obsolete surface | Tasks 6 and 7 |
| Stable owner-defined `productRef` | Task 1 |
| Exact `profile + productRef` history identity | Tasks 1 and 2 |
| Separate immutable run per experiment | Tasks 3, 5, and 7 |
| Derive local lookup from authoritative run files without a second index | Task 2 |
| Interactive applied/not-applied confirmation with no default | Tasks 5 and 6 |
| Applied prior experiment closes through M2 Results and M7 | Tasks 3, 4, 5, and 7 |
| Not-applied prior experiment stops without fabricated M2/M7 | Tasks 3, 5, and 7 |
| Fresh weekly artifact serves as prior result and next baseline | Tasks 4, 5, and 7 |
| Bounded, validated prior learning enters the new run | Tasks 1, 4, 5, and 7 |
| Entire historical run is excluded from agent context | Tasks 1, 4, and 7 |
| Existing M3/agent structured-output boundaries remain | Tasks 4 and 7 |
| Deterministic cycle idempotence and partial-failure recovery | Tasks 2, 5, and 7 |
| Legacy runs remain readable but are ignored for automatic rolling lookup | Tasks 1 and 2 |
| Existing historical run folders are not rewritten or deleted | Tasks 1 and 7 |
| Existing shared engine behavior remains available to other workflows | Tasks 3, 6, and 7 |
| Daily collection remains separate; weekly review uses persisted snapshots | Tasks 5, 6, and 7 |
| No automatic marketplace write | Global Constraints and Task 7 |
| Safe business events and authoritative `run.json` | Tasks 3, 5, and 7 |
| Etsy result collection | Deferred After This Plan: no implemented Etsy result-evidence path exists yet |
| Multi-run semantic learning retrieval | Deferred After This Plan: first slice carries only the latest validated M7 projection |
| Database-backed index | Deferred After This Plan: JSON scanning matches current local scale |
| Legacy productRef migration tool | Deferred After This Plan: automatic inference would be unsafe |
| Scheduler, dashboard, and notifications | Deferred After This Plan: outside the current CLI/local-runtime boundary |

## Deferred After This Plan

- Etsy rolling result collection and Etsy-specific outcome evidence.
- Retrieval, ranking, or summarization across more than one historical M7 record.
- A database-backed run repository and composite product-history index.
- A migration command that assigns `productRef` to legacy runs through explicit owner input.
- Scheduled daily collection, readiness notifications, or background execution.
- Dashboard or graphical owner-confirmation interfaces.
- OpenAI Agents SDK trace-ID correlation; the existing README records this as separate observability work.
- Automated Shopify, Etsy, or other marketplace writes.
- Performance tuning beyond deterministic directory scanning at the current single-owner scale.

## Final Self-Review

Before implementation begins, confirm:

1. Every task is independently implementable, testable, reviewable, and committable.
2. Contracts precede storage, storage precedes orchestration, and the public CLI comes after the coordinator.
3. Every implementation task starts with focused failing tests; final documentation shares a task with an end-to-end failing test.
4. Every named verification command exists in `package.json` or is the newly added script explicitly created by Task 6.
5. Lens notes explain concrete design decisions and are not applied to unrelated work.
6. The execution diagram matches the seven task boundaries and the existing source-pack, engine, module, repository, trace, and human-action seams.
7. Every file path exists today or is explicitly marked Create and follows current `src/workflow/` and `src/tests/workflow/` conventions.
8. No example or fixture introduces a credential, raw private value, provider payload, private dashboard link, or production URL.
9. Historical specs, plans, smoke artifacts, and workflow runs remain untouched.
10. This document authorizes planning only; runtime implementation remains deferred until the user chooses an execution workflow.
