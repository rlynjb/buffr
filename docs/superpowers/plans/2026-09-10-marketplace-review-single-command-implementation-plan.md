# Marketplace Review Single Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose one owner-facing `marketplace:review` command that prepares MerchGrid evidence internally, emits safe application-level trace events, and then runs the existing marketplace rolling recommendation workflow.

**Architecture:** Keep source-pack collection, weekly review derivation, marketplace evidence construction, and rolling workflow orchestration as separate internal boundaries. Add a review facade that owns operation-level tracing and handoff, while the CLI remains a thin parser/composition root and the existing workflow engine remains responsible for run state transitions.

**Tech Stack:** TypeScript 5.4 with NodeNext modules, Node.js 20 filesystem/readline/fetch APIs, Zod 3.25 runtime schemas, Vitest 2.1, local JSON/JSONL persistence with atomic file replacement, existing `TraceSink`/`WorkflowEvent` events, existing MerchGrid metric adapters, `npm test`, `npm run typecheck`, and `npm run build`.

**Spec:** `docs/superpowers/specs/2026-09-10-marketplace-review-single-command-design.md`

## Global Constraints

- Public owner-facing npm surface must contain exactly one review command: `marketplace:review`.
- Remove public npm scripts for `marketplace:next-review`, `merchgrid:collect`, and `merchgrid:weekly-review`.
- Keep `runDailyCollection`, `runWeeklyReview`, `collectSourcePack`, evidence schemas, source adapters, readiness checks, marketplace rolling review service, and workflow engine behavior as internal implementation details.
- `marketplace:review` must collect missing completed daily snapshots, build or reuse the weekly review artifact, then call the existing rolling marketplace recommendation workflow.
- Source-level `merchgrid.source.*` events remain in place; add application-level `marketplace_review.*` events around evidence preparation, weekly artifact reuse/generation, workflow handoff, completion, and failures.
- Trace event data may include lifecycle, source name, dates/window, status, artifact references, reuse/generated flags, and missing/reused/collected snapshot counts.
- Trace event data must not include raw provider payloads, raw CSV rows, raw private context, credentials, cookies, private dashboard URLs, full prompts, full model inputs, or unbounded module outputs.
- Pre-workflow evidence-preparation failures must leave reviewable bounded trace evidence.
- Retries with the same `profile + productRef + through` must reuse complete snapshots, reuse valid weekly artifacts, and rely on existing rolling-review idempotency for workflow runs and model calls.
- Do not rewrite or delete historical design/spec/plan records merely because they mention prior commands.
- Tests must use fake adapters, fake clocks, temporary directories, fake owner prompts, and fake agent runners. Tests must not call OpenAI, PostHog, Fly, Shopify, Etsy, or any network service.
- Each runtime-code task starts with a focused failing test, verifies the expected failure, implements the smallest passing behavior, then runs the listed focused tests plus `npm run typecheck`.

---

## File Structure Map

```text
package.json
  Modify: expose only marketplace:review among owner-facing review scripts.

README.md
  Modify: document one owner command and describe internal evidence prep at a high level.

src/tests/package-surface.test.ts
  Modify: guard that package scripts expose marketplace:review and no public MerchGrid evidence scripts.

src/cli/marketplace-visibility.ts
  Modify: parse review instead of next-review; keep terminal prompt and runtime composition thin.

src/tests/cli/marketplace-visibility.test.ts
  Modify: route review to the new review service, reject next-review, and assert safe output/errors.

src/storage/review-operations.ts
  Create: persist operation-level WorkflowEvent JSONL for pre-workflow review attempts.

src/tests/storage/review-operations.test.ts
  Create: verify operation event persistence, loading, stable path encoding, and safe event data.

src/workflow/marketplace-evidence-preparation.ts
  Create: prepare MerchGrid weekly marketplace evidence by collecting missing daily snapshots and reusing or generating weekly artifacts.

src/tests/workflow/marketplace-evidence-preparation.test.ts
  Create: cover snapshot reuse, collection, weekly artifact reuse/generation, failure, and safe trace events.

src/workflow/marketplace-review.ts
  Create: facade that emits operation-level events, persists them, calls evidence prep, and hands prepared evidence to rolling review.

src/tests/workflow/marketplace-review.test.ts
  Create: cover command-level lifecycle events, pre-workflow failures, workflow handoff, completion, and idempotent retries.

src/connectors/merchgrid/runtime.ts
  Create: shared runtime adapter factory for PostHog, Fly metrics, and Shopify Partner CSV.

src/cli/merchgrid-source-pack.ts
  Delete after moving runtime adapter construction out of the CLI and moving tests off public source-pack CLI helpers. Internal job functions remain in src/jobs/merchgrid-source-pack.ts.

src/tests/jobs/merchgrid-source-pack.test.ts
  Modify: keep job/function coverage and remove tests that exist only for the public source-pack CLI.

src/jobs/merchgrid-source-pack.ts
  Modify only if evidence prep needs exported date/source helpers or a weekly artifact ref helper.
```

The new implementation should preserve existing boundaries: `src/workflow/marketplace-rolling-review.ts` continues to own previous-run resolution and new-run creation; `src/jobs/merchgrid-source-pack.ts` continues to own daily and weekly source-pack behavior; `src/cli/marketplace-visibility.ts` should not grow into the evidence-preparation service.

## Shared Interfaces

Use these names consistently across tasks.

```ts
export type MarketplaceReviewInput = {
  profile: MarketplaceVisibilityProfile;
  productRef: string;
  through: string;
  contextPath: string;
  listingContextPath?: string;
};

export type PreparedMarketplaceEvidence = {
  profile: MarketplaceVisibilityProfile;
  productRef: string;
  through: string;
  windowStart: string;
  windowEnd: string;
  weeklyArtifactRef: string;
  weeklyArtifactStatus: 'reused' | 'generated';
  missingSnapshotCount: number;
  collectedSnapshotCount: number;
  reusedSnapshotCount: number;
  evidence: MarketplaceVisibilityEvidence;
};

export type MarketplaceEvidencePreparationService = {
  prepare(input: MarketplaceReviewInput): Promise<PreparedMarketplaceEvidence>;
};

export type MarketplaceReviewResult = {
  operationId: string;
  weeklyArtifactRef: string;
  weeklyArtifactStatus: 'reused' | 'generated';
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

export type MarketplaceReviewService = {
  review(input: MarketplaceReviewInput): Promise<MarketplaceReviewResult>;
};

export type ReviewOperationEventRepository = {
  appendEvent(operationId: string, event: WorkflowEvent): Promise<void>;
  loadEvents(operationId: string): Promise<WorkflowEvent[]>;
};
```

Operation IDs are deterministic strings:

```ts
export function marketplaceReviewOperationId(input: {
  profile: MarketplaceVisibilityProfile;
  productRef: string;
  through: string;
}): string {
  return `marketplace-review:${input.profile}:${input.productRef}:${input.through}`;
}
```

When an operation ID becomes a filesystem segment, encode it with `encodeURIComponent(operationId)` and decode it only for display or tests.

## Tasks

### Task 1: Replace the Public Command Surface With `marketplace:review`

**Files:**
- Modify: `package.json`
- Modify: `src/tests/package-surface.test.ts`
- Modify: `src/cli/marketplace-visibility.ts`
- Test: `src/tests/cli/marketplace-visibility.test.ts`

**Interfaces:**
- Consumes: current `runMarketplaceVisibilityCli`, `MarketplaceVisibilityEntrypointInput`, `MarketplaceVisibilityProfileSchema`, existing owner prompt adapter.
- Produces: `MarketplaceReviewService`, CLI dependency field `reviews: MarketplaceReviewService`, accepted verb `review`, rejected verb `next-review`.

- [ ] **Step 1: Write the failing package-surface test**

Update `src/tests/package-surface.test.ts` so it asserts the exact owner-facing review scripts. Use literals derived from the design.

```ts
it('exposes one owner-facing marketplace review command', async () => {
  const manifest = JSON.parse(await readFile(packageUrl, 'utf8')) as PackageManifest;
  const scripts = manifest.scripts ?? {};

  expect(scripts['marketplace:review']).toBe('node dist/cli/marketplace-visibility.js review');
  expect(scripts).not.toHaveProperty('marketplace:next-review');
  expect(scripts).not.toHaveProperty('merchgrid:collect');
  expect(scripts).not.toHaveProperty('merchgrid:weekly-review');
});
```

- [ ] **Step 2: Write the failing CLI tests**

In `src/tests/cli/marketplace-visibility.test.ts`, add tests proving `review` calls `dependencies.reviews.review()`, `--through` is passed when supplied, omitted `--through` is resolved through `dependencies.resolveThrough()`, and `next-review` is rejected.

```ts
it('routes review to the marketplace review service with safe output', async () => {
  const calls: unknown[] = [];
  const lines: string[] = [];

  await runMarketplaceVisibilityCli({
    args: ['review', '--profile', 'merchgrid_shopify_app_store', '--through', '2026-09-04'],
    dependencies: {
      reviews: {
        async review(input) {
          calls.push(input);
          return {
            operationId: 'marketplace-review:merchgrid_shopify_app_store:merchgrid-shopify-app:2026-09-04',
            weeklyArtifactRef: 'artifacts/weekly-reviews/2026-09-04.json',
            weeklyArtifactStatus: 'reused',
            currentRun: { runId: '2026-09-04-merchgrid_shopify_app_store-merchgrid-shopify-app', status: 'awaiting_approval', stage: 'approval_wait' },
          };
        },
      },
      resolveThrough: async () => 'unused',
      resolveProductRef: async () => 'merchgrid-shopify-app',
      defaultContextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
    },
    writeLine: (line) => lines.push(line),
  });

  expect(calls).toEqual([{
    profile: 'merchgrid_shopify_app_store',
    productRef: 'merchgrid-shopify-app',
    through: '2026-09-04',
    contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
  }]);
  expect(lines).toContain('weekly-artifact: artifacts/weekly-reviews/2026-09-04.json (reused)');
  expect(lines.join('\n')).not.toMatch(/OPENAI_API_KEY|POSTHOG_PERSONAL_API_KEY|FLY_ACCESS_TOKEN|SHOPIFY_PARTNER|prompt|raw/iu);
});
```

- [ ] **Step 3: Run the focused tests and confirm the expected red state**

Run: `npm test -- src/tests/package-surface.test.ts src/tests/cli/marketplace-visibility.test.ts`

Expected: FAIL because `package.json` still exposes `marketplace:next-review`, `merchgrid:collect`, and `merchgrid:weekly-review`, and the CLI still accepts `next-review` instead of `review`.

- [ ] **Step 4: Implement the command-surface change**

Change `package.json` to expose:

```json
"marketplace:review": "node dist/cli/marketplace-visibility.js review"
```

Remove `marketplace:next-review`, `merchgrid:collect`, and `merchgrid:weekly-review`.

Update `runMarketplaceVisibilityCli()` so it accepts only `review`. Keep `--profile` required. Add optional `--through`; when absent, call `resolveThrough()`. Resolve `productRef` from the configured context path. Print a weekly artifact line such as `weekly-artifact: artifacts/weekly-reviews/2026-09-04.json (reused)` before the current run summary.

- [ ] **Step 5: Run focused verification**

Run: `npm test -- src/tests/package-surface.test.ts src/tests/cli/marketplace-visibility.test.ts && npm run typecheck`

Expected: PASS. `review` routes to a mocked service, `next-review` fails validation, the package surface contains exactly the public command required by the design, and CLI output does not expose prohibited strings.

- [ ] **Step 6: Commit this task**

```bash
git add package.json src/tests/package-surface.test.ts src/cli/marketplace-visibility.ts src/tests/cli/marketplace-visibility.test.ts
git commit -m "feat: expose marketplace review command"
```

### Task 2: Persist Operation-Level Review Trace Events

**Files:**
- Create: `src/storage/review-operations.ts`
- Test: `src/tests/storage/review-operations.test.ts`

**Interfaces:**
- Consumes: `WorkflowEvent`, `createWorkflowEvent`, `assertNoCredentialKeys` through existing event creation, Node filesystem APIs.
- Produces: `ReviewOperationEventRepository`, `JsonFileReviewOperationEventRepository`, `marketplaceReviewOperationId(input)`.

- [ ] **Step 1: Write failing storage tests**

Cover deterministic operation IDs, encoded filesystem directory names, event append/load order, missing operation returning an empty array, JSON corruption surfacing as `AppError('storage_failed', ...)`, and credential-key rejection through `createWorkflowEvent()`.

```ts
it('appends and loads review operation events in order', async () => {
  const repository = new JsonFileReviewOperationEventRepository({ rootDir });
  const operationId = marketplaceReviewOperationId({
    profile: 'merchgrid_shopify_app_store',
    productRef: 'merchgrid-shopify-app',
    through: '2026-09-04',
  });

  await repository.appendEvent(operationId, createWorkflowEvent({
    runId: operationId,
    type: 'marketplace_review.started',
    message: 'Marketplace review started',
    data: { profile: 'merchgrid_shopify_app_store', productRef: 'merchgrid-shopify-app', through: '2026-09-04' },
    now: () => new Date('2026-09-05T00:00:00.000Z'),
  }));

  await expect(repository.loadEvents(operationId)).resolves.toMatchObject([
    { runId: operationId, type: 'marketplace_review.started' },
  ]);
});
```

- [ ] **Step 2: Run the focused test and confirm the expected red state**

Run: `npm test -- src/tests/storage/review-operations.test.ts`

Expected: FAIL because the review operation repository does not exist.

- [ ] **Step 3: Implement operation event persistence**

Implement JSONL persistence under:

```text
rootDir/review-operations/encodeURIComponent(operationId)/events.jsonl
```

`appendEvent()` should load current events, append the new event, validate no credential-like keys through already-created `WorkflowEvent` data, and write the full JSONL file through atomic rename. `loadEvents()` should return `[]` for a missing file, parse one JSON object per non-empty line, and validate each event with `WorkflowEventSchema`.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- src/tests/storage/review-operations.test.ts && npm run typecheck`

Expected: PASS. Operation IDs are deterministic, event order is preserved, missing operations are empty, and corrupt JSONL is visible as a storage failure.

- [ ] **Step 5: Commit this task**

```bash
git add src/storage/review-operations.ts src/tests/storage/review-operations.test.ts
git commit -m "feat: persist marketplace review trace events"
```

### Task 3: Build the Evidence Preparation Boundary

**Files:**
- Create: `src/workflow/marketplace-evidence-preparation.ts`
- Modify: `src/jobs/merchgrid-source-pack.ts`
- Test: `src/tests/workflow/marketplace-evidence-preparation.test.ts`

**Interfaces:**
- Consumes: `MetricSnapshotRepository`, `MerchGridSourcePackDependencies`, `MerchGridReviewArtifactRepository`, `runDailyCollection`, `runWeeklyReview`, `loadMarketplaceVisibilityContext`, `loadMarketplaceListingContext`, `buildRollingVisibilityEvidence`, `TraceSink`.
- Produces: `MarketplaceEvidencePreparationService`, `createMarketplaceEvidencePreparationService(deps)`, `PreparedMarketplaceEvidence`, optional helper `merchGridWeeklyReviewArtifactRef(artifactRootRef, through)`.

- [ ] **Step 1: Write failing evidence-preparation tests**

Test these behaviors with a memory snapshot repository, memory artifact repository, fake adapters, fixed `now`, and captured events:

- all required snapshots complete and weekly artifact exists: no adapter calls, `weeklyArtifactStatus: 'reused'`;
- missing completed source/date snapshots: calls `runDailyCollection()` through fake adapters, emits collection-required and daily-collection-completed events;
- weekly artifact missing after complete snapshots: calls `runWeeklyReview()`, returns `weeklyArtifactStatus: 'generated'`;
- a required source/date remains non-complete: throws `AppError('storage_failed', ...)` before rolling workflow work;
- requested through date is not completed in UTC: throws validation/range error before adapter calls;
- event data omits credential-like and raw-provider strings.

```ts
it('reuses complete snapshots and an existing weekly artifact without collecting sources', async () => {
  const fixture = await createEvidenceFixture({ weeklyArtifact: weeklyArtifact('2026-09-04') });
  await fixture.seedCompleteWindow('2026-08-22', '2026-09-04');

  const prepared = await fixture.service.prepare(reviewInput({ through: '2026-09-04' }));

  expect(prepared).toMatchObject({
    through: '2026-09-04',
    weeklyArtifactStatus: 'reused',
    reusedSnapshotCount: 42,
    collectedSnapshotCount: 0,
    missingSnapshotCount: 0,
  });
  expect(fixture.adapterCalls).toEqual([]);
  expect(fixture.events.map((event) => event.type)).toContain('marketplace_review.weekly_artifact.reused');
});
```

- [ ] **Step 2: Run the focused test and confirm the expected red state**

Run: `npm test -- src/tests/workflow/marketplace-evidence-preparation.test.ts`

Expected: FAIL because the evidence-preparation service and weekly artifact ref helper are absent.

- [ ] **Step 3: Implement date-window and snapshot preparation**

Create a service that computes `windowStart = through - 13 days` and `windowEnd = through`. For each required date and each source in `['posthog', 'fly_metrics', 'shopify_partner']`, load the snapshot. Emit `marketplace_review.daily_snapshot.reused` for complete snapshots and `marketplace_review.daily_snapshot.collection_required` for missing or non-complete snapshots.

For each date with at least one required collection, call:

```ts
await runDailyCollection({
  date,
  dependencies: {
    ...deps.sourcePack,
    emit: deps.emit,
    now: deps.now,
  },
});
```

After each date, reload required snapshots and compute per-date counts for `marketplace_review.daily_collection.completed`.

- [ ] **Step 4: Implement weekly artifact reuse/generation**

Call `artifacts.loadWeeklyReview(through)`. If it returns evidence, emit `marketplace_review.weekly_artifact.reused`. If it returns `undefined`, call `runWeeklyReview({ through, dependencies })`, emit `marketplace_review.weekly_artifact.generated`, and use the returned review evidence. If `loadWeeklyReview()` throws for corrupt JSON, emit no generated event and let the storage error propagate.

Build marketplace visibility evidence:

```ts
const evidence = buildRollingVisibilityEvidence({
  artifact,
  identity: { profile: input.profile, productRef: input.productRef },
  through,
  context: await loadMarketplaceVisibilityContext(input.contextPath),
  listingContext: input.listingContextPath ? await loadMarketplaceListingContext(input.listingContextPath) : undefined,
  artifactRootRef: deps.artifactRootRef,
});
```

- [ ] **Step 5: Emit preparation completion/failure events**

Emit `marketplace_review.evidence_preparation.started` before loading snapshots. Emit `marketplace_review.evidence_preparation.completed` after `MarketplaceVisibilityEvidence` is built. When preparation fails after the started event, emit `marketplace_review.evidence_preparation.failed` with `through`, `windowStart`, `windowEnd`, `missingSnapshotCount` when known, and `failureCode` for `AppError.code`.

- [ ] **Step 6: Run focused verification**

Run: `npm test -- src/tests/workflow/marketplace-evidence-preparation.test.ts src/tests/jobs/merchgrid-source-pack.test.ts src/tests/metrics/merchgrid-source-pack.e2e.test.ts && npm run typecheck`

Expected: PASS. Evidence prep reuses complete snapshots, collects only missing/non-complete source/date entries, reuses or generates weekly artifacts, emits safe app-level events, preserves source-pack job behavior, and fails before workflow mutation when required evidence remains incomplete.

- [ ] **Step 7: Commit this task**

```bash
git add src/workflow/marketplace-evidence-preparation.ts src/jobs/merchgrid-source-pack.ts src/tests/workflow/marketplace-evidence-preparation.test.ts src/tests/jobs/merchgrid-source-pack.test.ts src/tests/metrics/merchgrid-source-pack.e2e.test.ts
git commit -m "feat: prepare marketplace review evidence"
```

### Task 4: Add the Marketplace Review Facade and Failure Trace Boundary

**Files:**
- Create: `src/workflow/marketplace-review.ts`
- Test: `src/tests/workflow/marketplace-review.test.ts`

**Interfaces:**
- Consumes: `MarketplaceEvidencePreparationService`, `MarketplaceRollingReviewService`, `ReviewOperationEventRepository`, `TraceSink`, `createWorkflowEvent`, `marketplaceReviewOperationId`.
- Produces: `createMarketplaceReviewService(deps)`, `MarketplaceReviewService`, `MarketplaceReviewResult`.

- [ ] **Step 1: Write failing facade tests**

Use fake evidence-prep, fake rolling-review service, fake operation repository, fixed clock, and emitted-event capture. Cover:

- successful review emits and persists `marketplace_review.started`, evidence-prep events passed through from Task 3, `marketplace_review.workflow.started`, `marketplace_review.workflow.completed`;
- evidence-prep failure persists `marketplace_review.failed` and does not call rolling review;
- rolling-review failure persists `marketplace_review.failed` after evidence prep;
- retry with the same input produces the same `operationId`;
- event JSON contains no raw context, credential keys, prompt text, or provider payload strings.

```ts
it('persists bounded failure events when evidence prep fails before workflow start', async () => {
  const fixture = createReviewFixture({
    prepare: async () => {
      throw new AppError('storage_failed', 'Missing weekly metric snapshots (1): posthog/2026-09-04');
    },
  });

  await expect(fixture.service.review(reviewInput())).rejects.toMatchObject({ code: 'storage_failed' });

  expect(fixture.rollingCalls).toEqual([]);
  expect(fixture.persistedEvents.map((event) => event.type)).toEqual([
    'marketplace_review.started',
    'marketplace_review.failed',
  ]);
  expect(JSON.stringify(fixture.persistedEvents)).not.toMatch(/secret|token|rawEvents|prompt/iu);
});
```

- [ ] **Step 2: Run the focused test and confirm the expected red state**

Run: `npm test -- src/tests/workflow/marketplace-review.test.ts`

Expected: FAIL because the review facade does not exist.

- [ ] **Step 3: Implement event creation and persistence**

`review(input)` should validate the deterministic operation ID, create `WorkflowEvent` objects with `runId: operationId`, append each event to `ReviewOperationEventRepository`, and also forward events to optional `emit`. Use one helper:

```ts
async function record(type: string, message: string, data: Record<string, unknown>): Promise<void> {
  const event = createWorkflowEvent({ runId: operationId, type, message, data, now: deps.now });
  await deps.operations.appendEvent(operationId, event);
  await deps.emit?.(event);
}
```

- [ ] **Step 4: Implement successful orchestration**

Call `evidence.prepare(input)`. Record `marketplace_review.workflow.started` with `through` and `weeklyArtifactRef`. Call `rollingReviews.nextReview(input)`. Record `marketplace_review.workflow.completed` with current run ID, status, stage, and previous run ID when present. Return `MarketplaceReviewResult` with operation ID, weekly artifact ref/status, previous run result, and current run result.

- [ ] **Step 5: Implement bounded failure recording**

Wrap evidence prep and rolling workflow calls. On failure, record `marketplace_review.failed` with `failureCode` for `AppError` or `unexpected_error` for unknown errors, plus `stage: 'evidence_preparation'` or `stage: 'workflow'`. Re-throw the original error after recording. If recording the failure event itself fails, throw an `AppError('storage_failed', 'Marketplace review failure event could not be persisted', { cause })` whose cause includes the original failure and persistence failure.

- [ ] **Step 6: Run focused verification**

Run: `npm test -- src/tests/workflow/marketplace-review.test.ts && npm run typecheck`

Expected: PASS. Successful and failed review attempts have durable bounded events, pre-workflow failures do not call rolling workflow, and results preserve weekly artifact and current run summaries.

- [ ] **Step 7: Commit this task**

```bash
git add src/workflow/marketplace-review.ts src/tests/workflow/marketplace-review.test.ts
git commit -m "feat: orchestrate marketplace review"
```

### Task 5: Wire Runtime Source Adapters Into `marketplace:review`

**Files:**
- Create: `src/connectors/merchgrid/runtime.ts`
- Modify: `src/cli/marketplace-visibility.ts`
- Modify: `src/cli/merchgrid-source-pack.ts`
- Test: `src/tests/cli/marketplace-visibility.test.ts`
- Test: `src/tests/jobs/merchgrid-source-pack.test.ts`

**Interfaces:**
- Consumes: `PosthogMetricSourceAdapter`, `FlyMetricsSourceAdapter`, `ShopifyPartnerCsvMetricSource`, `FetchHttpClient`, `loadPosthogMetricsConfig`, `loadFlyMetricsConfig`, `loadShopifyPartnerCsvConfig`, `JsonFileMetricSnapshotRepository`, `JsonFileMerchGridReviewArtifactRepository`, `JsonFileReviewOperationEventRepository`, `createMarketplaceEvidencePreparationService`, `createMarketplaceReviewService`, current `createMarketplaceRollingReviewService`.
- Produces: `createMerchGridMetricSourceAdapters({ env, http })`, runtime `MarketplaceReviewService` dependency graph, and removal of `adapters: []` from marketplace review evidence prep.

- [ ] **Step 1: Write failing runtime-wiring tests**

In CLI tests, inject a fake HTTP client and fake CSV path through environment. Assert `createMarketplaceVisibilityDependencies(env, { http })` or the chosen options signature wires three adapters into evidence prep, not an empty adapter list. Also assert missing PostHog/Fly/Shopify settings fail with the existing bounded `configuration_failed` channel when a review needs collection.

```ts
it('wires MerchGrid source adapters into marketplace review preparation', async () => {
  const dependencies = createMarketplaceVisibilityDependencies(fakeRuntimeEnvironment(), { http: fakeHttp });

  expect(dependencies.reviews).toBeDefined();
  expect(dependencies.resolveThrough).toBeDefined();
});
```

Use a focused collaborator fake or exported adapter factory test to assert sources exactly:

```ts
expect(createMerchGridMetricSourceAdapters({ env: fakeRuntimeEnvironment(), http: fakeHttp }).map((adapter) => adapter.source))
  .toEqual(['posthog', 'fly_metrics', 'shopify_partner']);
```

- [ ] **Step 2: Run focused tests and confirm the expected red state**

Run: `npm test -- src/tests/cli/marketplace-visibility.test.ts src/tests/jobs/merchgrid-source-pack.test.ts`

Expected: FAIL because marketplace runtime still wires `adapters: []` and adapter construction is private to the source-pack CLI.

- [ ] **Step 3: Extract shared adapter construction**

Create `src/connectors/merchgrid/runtime.ts`:

```ts
export function createMerchGridMetricSourceAdapters(input: {
  env: NodeJS.ProcessEnv;
  http?: HttpClient;
}): MetricSourceAdapter[] {
  const http = input.http ?? new FetchHttpClient();
  return [
    new PosthogMetricSourceAdapter({ http, config: loadPosthogMetricsConfig(input.env) }),
    new FlyMetricsSourceAdapter({ http, config: loadFlyMetricsConfig(input.env) }),
    new ShopifyPartnerCsvMetricSource({ config: loadShopifyPartnerCsvConfig(input.env) }),
  ];
}
```

Keep environment variable names aligned with `src/core/config.ts`: `POSTHOG_API_BASE_URL`, `FLY_METRICS_URL`, and `SHOPIFY_PARTNER_CSV_PATH`.

- [ ] **Step 4: Update marketplace runtime composition**

In `createMarketplaceVisibilityDependencies()`, create the snapshot repository, artifact repository, review operation repository, source adapters, evidence-prep service, rolling-review service, and review facade. Pass the same `emit` path into evidence prep and review facade so source-level and application-level events can be captured in tests.

```ts
const evidence = createMarketplaceEvidencePreparationService({
  sourcePack: {
    adapters: createMerchGridMetricSourceAdapters({ env, http: options.http }),
    repository: snapshotRepository,
    artifacts,
    now: () => new Date(),
  },
  artifacts,
  repository: snapshotRepository,
  artifactRootRef: layout.artifactRoot,
  now: () => new Date(),
});
```

Then:

```ts
reviews: createMarketplaceReviewService({
  evidence,
  rollingReviews,
  operations: new JsonFileReviewOperationEventRepository({ rootDir: layout.operationRoot }),
  now: () => new Date(),
});
```

- [ ] **Step 5: Retire public source-pack CLI tests and keep job tests**

Delete `src/cli/merchgrid-source-pack.ts` after adapter construction is available through `src/connectors/merchgrid/runtime.ts`. Remove only tests that call `runMerchGridSourcePackCli()` or `runMerchGridSourcePackEntrypoint()`. Keep tests for `runDailyCollection()`, `runWeeklyReview()`, source adapters, summaries, repositories, and `collectSourcePack()`.

- [ ] **Step 6: Run focused verification**

Run: `npm test -- src/tests/cli/marketplace-visibility.test.ts src/tests/jobs/merchgrid-source-pack.test.ts src/tests/workflow/marketplace-evidence-preparation.test.ts && npm run typecheck`

Expected: PASS. Runtime dependency creation wires real source adapters for review prep, tests use fake HTTP/CSV/local repositories, no real network is called, and source-pack job coverage remains intact.

- [ ] **Step 7: Commit this task**

```bash
git add src/connectors/merchgrid/runtime.ts src/cli/marketplace-visibility.ts src/cli/merchgrid-source-pack.ts src/tests/cli/marketplace-visibility.test.ts src/tests/jobs/merchgrid-source-pack.test.ts
git commit -m "feat: wire review evidence sources"
```

### Task 6: Add End-to-End Review Coverage and Active Documentation

**Files:**
- Create: `src/tests/workflow/marketplace-review.e2e.test.ts`
- Modify: `README.md`
- Modify: `src/contracts/README.md`
- Modify: `src/tests/package-surface.test.ts`

**Interfaces:**
- Consumes: public `marketplace:review` package surface, `MarketplaceReviewService`, operation events, source-pack jobs, rolling review service, JSON repositories.
- Produces: one persisted end-to-end proof from missing daily snapshots through weekly artifact creation and rolling workflow result.

- [ ] **Step 1: Write failing end-to-end tests**

Create a temp-dir integration test that uses fake source adapters, fake agent runner/module outputs, fake owner prompt, fixed clock, and local JSON repositories. Seed no weekly artifact and only part of the required daily window. Run the review service for `through: '2026-09-04'`.

Assert:

- missing daily snapshots are collected;
- complete existing snapshots are reused;
- weekly artifact is generated once;
- operation events include evidence prep, weekly artifact generation, workflow handoff, and completion;
- the current workflow run exists and has marketplace identity;
- repeating the same review returns the same current run and reuses the weekly artifact.

```ts
it('collects missing evidence, generates weekly review, and starts one rolling workflow run', async () => {
  const first = await fixture.review.review(reviewInput({ through: '2026-09-04' }));
  const second = await fixture.review.review(reviewInput({ through: '2026-09-04' }));

  expect(first.currentRun.runId).toBe(second.currentRun.runId);
  expect(first.weeklyArtifactStatus).toBe('generated');
  expect(second.weeklyArtifactStatus).toBe('reused');
  expect(await fixture.operations.loadEvents(first.operationId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'marketplace_review.evidence_preparation.started' }),
      expect.objectContaining({ type: 'marketplace_review.weekly_artifact.generated' }),
      expect.objectContaining({ type: 'marketplace_review.workflow.completed' }),
    ]),
  );
});
```

- [ ] **Step 2: Run the end-to-end test and confirm the expected red state**

Run: `npm test -- src/tests/workflow/marketplace-review.e2e.test.ts`

Expected: FAIL until Tasks 3-5 are implemented and wired together.

- [ ] **Step 3: Complete implementation details exposed by the end-to-end test**

Fix any integration gaps by editing only files already introduced in Tasks 3-5. Acceptable examples are mismatched artifact refs, missing operation-root layout, duplicate event recording, or dependency factory signatures. Do not change public scope beyond the one-command design.

- [ ] **Step 4: Update active documentation**

Update README operational sections so the owner sees:

```bash
npm run marketplace:review
```

Describe that the command internally prepares MerchGrid evidence, reuses complete snapshots, collects missing completed daily snapshots, reuses or generates the weekly artifact, then runs the rolling marketplace review. Keep the privacy language: aggregate metrics only, no raw provider payloads, no private context, manual marketplace edits only.

Update `src/contracts/README.md` only where it describes active evidence preparation, operation trace events, product identity, or artifact lineage. Do not edit historical specs/plans.

- [ ] **Step 5: Run focused verification**

Run: `npm test -- src/tests/workflow/marketplace-review.e2e.test.ts src/tests/package-surface.test.ts && npm run typecheck`

Expected: PASS. The integration test proves the single command's internal evidence prep and rolling workflow handoff, and package-surface tests prove old public scripts are absent.

- [ ] **Step 6: Commit this task**

```bash
git add src/tests/workflow/marketplace-review.e2e.test.ts README.md src/contracts/README.md src/tests/package-surface.test.ts
git commit -m "test: cover marketplace review flow"
```

### Task 7: Final Removal Search and Full Verification

**Files:**
- Modify only files required by failed verification from earlier tasks.
- Inspect: `package.json`, `README.md`, `src`, `docs/superpowers/specs`, `docs/superpowers/plans`, `dist/cli`.

**Interfaces:**
- Consumes: all tasks above.
- Produces: final proof that active public command surface is one command and all implementation checks pass.

- [ ] **Step 1: Run full test suite**

Run: `npm test`

Expected: PASS with all Vitest files green. No test should call real external services or require real credentials.

- [ ] **Step 2: Run TypeScript verification**

Run: `npm run typecheck`

Expected: PASS with no missing exports, stale CLI imports, or signature mismatches.

- [ ] **Step 3: Run build verification**

Run: `npm run build`

Expected: PASS. `dist/cli/marketplace-visibility.js` is generated and supports the `review` verb. Removed public CLI entry points are not regenerated from deleted source files.

- [ ] **Step 4: Search active public surface for removed commands**

Run:

```bash
rg -n "marketplace:next-review|merchgrid:collect|merchgrid:weekly-review|next-review|runMerchGridSourcePackCli|runMerchGridSourcePackEntrypoint" package.json README.md src dist/cli --glob '!docs/superpowers/**'
```

Expected: exit code 1, meaning no active public command references remain. If source-pack CLI is intentionally retained as an internal debugging helper, narrow the search to `package.json README.md src/cli/marketplace-visibility.ts src/tests/package-surface.test.ts dist/cli` and document that decision in the final report.

- [ ] **Step 5: Search trace safety test fixtures**

Run:

```bash
rg -n "OPENAI_API_KEY|POSTHOG_PERSONAL_API_KEY|FLY_ACCESS_TOKEN|SHOPIFY_PARTNER|Authorization|cookie|rawEvents|providerPayload|prompt" src/tests/workflow/marketplace-review*.test.ts src/tests/workflow/marketplace-evidence-preparation.test.ts src/storage/review-operations.ts
```

Expected: Either exit code 1 or matches only inside negative assertions such as `not.toMatch(...)`. Any persisted fixture containing a prohibited value must be rewritten to a safe synthetic token and the negative assertion must remain.

- [ ] **Step 6: Inspect built CLI files**

Run: `find dist/cli -maxdepth 1 -type f | sort`

Expected: includes `dist/cli/marketplace-visibility.js`. Does not include deleted CLI outputs when their source files were removed.

- [ ] **Step 7: Commit final verification fixes**

If Step 1-6 required edits, commit them:

```bash
git add -A package.json README.md src/contracts/README.md src/cli src/connectors/merchgrid src/jobs src/storage src/workflow src/tests
git commit -m "chore: finish marketplace review verification"
```

If no edits were required, do not create an empty commit.

## Self-Review Results

**Spec coverage:** Covered one public `marketplace:review` command in Task 1, removal of public `marketplace:next-review`/`merchgrid:*` scripts in Tasks 1 and 7, internal source-pack preservation in Tasks 3 and 5, missing snapshot collection and weekly artifact reuse/generation in Task 3, application-level trace taxonomy in Tasks 2-4, pre-workflow failure auditability in Tasks 2 and 4, runtime adapter wiring in Task 5, documentation/migration notes in Task 6, and full implementation verification in Task 7.

**Placeholder scan:** The plan uses concrete file paths, interface names, event names, commands, and expected outcomes. A scan for forbidden marker tokens and vague stock phrases returned no matches after review.

**Type/signature consistency:** `MarketplaceReviewInput`, `PreparedMarketplaceEvidence`, `MarketplaceEvidencePreparationService`, `MarketplaceReviewResult`, `MarketplaceReviewService`, `ReviewOperationEventRepository`, `marketplaceReviewOperationId`, and `createMerchGridMetricSourceAdapters` are defined before task use and referenced with the same names throughout the plan. `weeklyArtifactStatus` consistently uses `'reused' | 'generated'`; operation events consistently use existing `WorkflowEvent` and `TraceSink` concepts.
