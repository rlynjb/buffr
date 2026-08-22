# MerchGrid Source Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Build Buffr's first source pack: deterministic daily collection of MerchGrid product, reliability, and business aggregates; privacy-safe snapshot storage; and daily/weekly review evidence.

**Architecture:** PostHog, Fly Metrics, and Shopify Partner adapters sit at the I/O edge. Shared contracts, atomic JSON snapshot storage, and deterministic coordinators own validation, idempotence, partial-source behavior, and summary artifacts. Shopify begins with an aggregate-only CSV adapter; do not build a Partner API client until its exact usable fields are verified.

**Tech Stack:** Existing TypeScript + Node.js ESM; Zod 3; native \`fetch\`; atomic JSON-file persistence; Vitest 2 with fake HTTP clients and fixed clocks.

**Spec:** \`docs/superpowers/specs/2026-08-20-merchgrid-business-review-aggregation-design.md\`

## Global Constraints

- Buffr owns collection, normalization, snapshots, and summaries. MerchGrid stays the operational app and PostHog telemetry producer.
- Store aggregate numbers and bounded collection metadata only. Never persist credentials, raw source responses/events, shop domains, merchant identities, catalog data, emails, or source payloads.
- Use completed UTC dates only. Complete source/date snapshots are immutable; later collection may replace only \`partial\`, \`unavailable\`, or \`failed\` data.
- A source failure never blocks another source or hides a limitation.
- Outputs are deterministic; an LLM may later consume evidence but never choose source queries or alter metrics.
- Query Fly's Prometheus-compatible API, not Grafana. Do not scrape Shopify Partner Dashboard.
- Tests use fakes/fixtures only; never commit an \`.env\` file.
- Every task follows TDD: focused RED test, expected failure, minimum GREEN implementation, focused verification, commit.

## File Structure Map

\`\`\`text
src/
  contracts/metrics.ts                         # aggregate schemas
  connectors/merchgrid/source.ts               # adapter port, HTTP client, failures
  connectors/merchgrid/posthog.ts              # approved event-count adapter
  connectors/merchgrid/fly-metrics.ts          # MetricsQL adapter
  connectors/merchgrid/shopify-partner-csv.ts  # manual aggregate CSV adapter
  storage/metric-snapshots.ts                  # atomic source/date repository
  metrics/coordinator.ts                       # isolated source collection
  metrics/summaries.ts                         # daily/weekly calculations
  metrics/evidence.ts                          # workflow-readable artifact
  jobs/merchgrid-source-pack.ts                # daily and weekly operations
  cli/merchgrid-source-pack.ts                 # explicit local commands
  tests/contracts/metrics.test.ts
  tests/connectors/merchgrid-*.test.ts
  tests/storage/metric-snapshots.test.ts
  tests/metrics/{coordinator,summaries,merchgrid-source-pack.e2e}.test.ts
  tests/jobs/merchgrid-source-pack.test.ts
\`\`\`

Keep \`src/contracts/evidence.ts\` Etsy/listing-specific. Put the reusable aggregate contract in \`src/contracts/metrics.ts\`.

## Shared Interfaces

\`\`\`ts
export type MetricSource = 'posthog' | 'fly_metrics' | 'shopify_partner';
export type SnapshotStatus = 'complete' | 'partial' | 'unavailable' | 'failed';

export type CollectionWindow = {
  date: string;
  startInclusive: string;
  endExclusive: string;
};

export type DailyMetricSnapshot = {
  source: MetricSource;
  date: string;
  collectedAt: string;
  status: SnapshotStatus;
  metrics: Record<string, number>;
  notes: string[];
};

export type MetricSourceAdapter = {
  readonly source: MetricSource;
  collect(window: CollectionWindow): Promise<DailyMetricSnapshot>;
};

export type MetricSnapshotRepository = {
  load(source: MetricSource, date: string): Promise<DailyMetricSnapshot | undefined>;
  save(snapshot: DailyMetricSnapshot): Promise<'created' | 'unchanged' | 'replaced_noncomplete'>;
  list(source: MetricSource, fromDate: string, throughDate: string): Promise<DailyMetricSnapshot[]>;
};
\`\`\`

### Task 1: Metric Contracts and Atomic Snapshot Storage

**Files:**
- Create: \`src/contracts/metrics.ts\`
- Create: \`src/storage/metric-snapshots.ts\`
- Create: \`src/tests/contracts/metrics.test.ts\`
- Create: \`src/tests/storage/metric-snapshots.test.ts\`

**Consumes:** Existing Zod patterns, \`AppError\`, and \`src/storage/runs.ts\` atomic writes.

**Produces:** \`DailyMetricSnapshotSchema\`, \`createCompletedUtcWindow\`, and \`JsonFileMetricSnapshotRepository\` at \`<rootDir>/<source>/<date>.json\`.

- [ ] **Step 1: Write failing tests**

\`\`\`ts
it('creates an exact completed UTC window', () => {
  expect(createCompletedUtcWindow('2026-08-21')).toEqual({
    date: '2026-08-21',
    startInclusive: '2026-08-21T00:00:00.000Z',
    endExclusive: '2026-08-22T00:00:00.000Z',
  });
});

it('does not duplicate a successful source/date snapshot', async () => {
  await repository.save(completePosthogSnapshot);
  await expect(repository.save(completePosthogSnapshot)).resolves.toBe('unchanged');
});
\`\`\`

- [ ] **Step 2: Run RED tests**

Run: \`npm test -- src/tests/contracts/metrics.test.ts src/tests/storage/metric-snapshots.test.ts\`  
Expected: FAIL because the contracts and repository do not exist.

- [ ] **Step 3: Implement minimum behavior**

Create strict schemas: exact date, ISO timestamp, finite nonnegative values, and at most twelve bounded notes. Recursively reject keys matching \`token\`, \`secret\`, \`authorization\`, \`email\`, \`shop\`, \`domain\`, \`customer\`, \`catalog\`, \`product\`, \`payload\`, or \`response\`.

Reuse temporary-write plus rename from \`runs.ts\`. A different complete snapshot for an existing complete source/date throws \`AppError('storage_failed', ...)\`; complete input replaces only a previous noncomplete snapshot.

- [ ] **Step 4: Run GREEN tests**

Run: \`npm test -- src/tests/contracts/metrics.test.ts src/tests/storage/metric-snapshots.test.ts\`  
Expected: PASS.

- [ ] **Step 5: Commit**

\`\`\`bash
git add src/contracts/metrics.ts src/storage/metric-snapshots.ts src/tests/contracts/metrics.test.ts src/tests/storage/metric-snapshots.test.ts
git commit -m "feat: add metric snapshot contracts"
\`\`\`

### Task 2: Source-Adapter Boundary and Sanitized Configuration

**Files:**
- Create: \`src/connectors/merchgrid/source.ts\`
- Modify: \`src/core/config.ts\`
- Create: \`src/tests/connectors/merchgrid-source.test.ts\`

**Consumes:** Task 1 and \`src/core/errors.ts\`.

**Produces:** \`HttpClient\`, \`MetricSourceFailureKind\`, \`MetricSourceAdapter\`, and typed loaders for PostHog, Fly Metrics, and Shopify CSV configuration.

- [ ] **Step 1: Write failing tests**

\`\`\`ts
it('loads PostHog query config without exposing its API key', () => {
  expect(loadPosthogMetricsConfig({
    POSTHOG_PROJECT_ID: '7', POSTHOG_PERSONAL_API_KEY: 'secret',
  })).toMatchObject({ projectId: '7' });
});

it('classifies HTTP 429 as a rate limit', () => {
  expect(classifyMetricSourceFailure({ status: 429 })).toBe('rate_limit');
});
\`\`\`

- [ ] **Step 2: Run RED test**

Run: \`npm test -- src/tests/connectors/merchgrid-source.test.ts\`  
Expected: FAIL because the source boundary does not exist.

- [ ] **Step 3: Implement the I/O edge**

Define \`HttpClient.request()\` to return status and parsed JSON. Define only \`authentication\`, \`rate_limit\`, \`transport\`, \`schema\`, and \`unknown\`. Add config loaders in \`core/config.ts\`; missing-setting errors name variables but never values. Do not read or create an \`.env\` file.

- [ ] **Step 4: Run GREEN test**

Run: \`npm test -- src/tests/connectors/merchgrid-source.test.ts\`  
Expected: PASS.

- [ ] **Step 5: Commit**

\`\`\`bash
git add src/connectors/merchgrid/source.ts src/core/config.ts src/tests/connectors/merchgrid-source.test.ts
git commit -m "feat: add MerchGrid source boundaries"
\`\`\`

### Task 3: PostHog Aggregate Adapter

**Files:**
- Create: \`src/connectors/merchgrid/posthog.ts\`
- Create: \`src/tests/connectors/merchgrid-posthog.test.ts\`
- Create: \`src/tests/fixtures/merchgrid-metrics.ts\`

**Consumes:** Tasks 1-2.

**Produces:** \`PosthogMetricSourceAdapter\` with source \`posthog\`.

- [ ] **Step 1: Write failing tests**

\`\`\`ts
it('maps only four approved event totals into a snapshot', async () => {
  await expect(adapter.collect(window)).resolves.toMatchObject({
    status: 'complete',
    metrics: {
      app_opened_count: 8, scan_started_count: 4,
      scan_completed_count: 3, scan_failed_count: 1,
      scan_completion_rate: 0.75,
    },
  });
});

it('returns a bounded failed snapshot on rejected access', async () => {
  fakeHttp.respond({ status: 401, body: {} });
  await expect(adapter.collect(window)).resolves.toMatchObject({
    status: 'failed', notes: ['authentication'], metrics: {},
  });
});
\`\`\`

- [ ] **Step 2: Run RED test**

Run: \`npm test -- src/tests/connectors/merchgrid-posthog.test.ts\`  
Expected: FAIL because the PostHog adapter does not exist.

- [ ] **Step 3: Implement aggregate-only collection**

Use a bounded POST to the configured PostHog project query endpoint, authenticated only by the personal query API key. Request counts only for \`app_opened\`, \`scan_started\`, \`scan_completed\`, and \`scan_failed\` in the supplied window. Keep request/response details inside the adapter; persist numeric totals only. Emit \`scan_completion_rate\` only when starts are positive. Map non-2xx and malformed data to an empty-metric failed snapshot with a bounded note.

- [ ] **Step 4: Run GREEN test**

Run: \`npm test -- src/tests/connectors/merchgrid-posthog.test.ts\`  
Expected: PASS.

- [ ] **Step 5: Commit**

\`\`\`bash
git add src/connectors/merchgrid/posthog.ts src/tests/connectors/merchgrid-posthog.test.ts src/tests/fixtures/merchgrid-metrics.ts
git commit -m "feat: collect PostHog aggregate metrics"
\`\`\`

### Task 4: Fly Reliability Adapter

**Files:**
- Create: \`src/connectors/merchgrid/fly-metrics.ts\`
- Create: \`src/tests/connectors/merchgrid-fly-metrics.test.ts\`

**Consumes:** Tasks 1-2.

**Produces:** \`FlyMetricsSourceAdapter\` with source \`fly_metrics\`.

- [ ] **Step 1: Write failing tests**

\`\`\`ts
it('derives error rate from edge response totals', async () => {
  await expect(adapter.collect(window)).resolves.toMatchObject({
    metrics: { request_count: 100, error_response_count: 3, error_rate: 0.03 },
  });
});

it('treats empty successful data as unavailable, not zero traffic', async () => {
  fakeHttp.respond({ status: 200, body: { data: { result: [] } } });
  await expect(adapter.collect(window)).resolves.toMatchObject({
    status: 'unavailable', notes: ['no_metrics'], metrics: {},
  });
});
\`\`\`

- [ ] **Step 2: Run RED test**

Run: \`npm test -- src/tests/connectors/merchgrid-fly-metrics.test.ts\`  
Expected: FAIL because the Fly adapter does not exist.

- [ ] **Step 3: Implement MetricsQL collection**

Call Fly's Prometheus query endpoint with the Fly access token. Query completed-window totals filtered to the configured app for all edge responses and 5xx edge responses. Derive error rate only if requests are positive. Do not query Grafana. Map empty results to \`unavailable\`; map external failures to bounded failed snapshots.

- [ ] **Step 4: Run GREEN test**

Run: \`npm test -- src/tests/connectors/merchgrid-fly-metrics.test.ts\`  
Expected: PASS.

- [ ] **Step 5: Commit**

\`\`\`bash
git add src/connectors/merchgrid/fly-metrics.ts src/tests/connectors/merchgrid-fly-metrics.test.ts
git commit -m "feat: collect Fly reliability metrics"
\`\`\`

### Task 5: Shopify Partner Aggregate CSV Adapter

**Files:**
- Create: \`src/connectors/merchgrid/shopify-partner-csv.ts\`
- Create: \`src/tests/connectors/merchgrid-shopify-csv.test.ts\`
- Modify: \`README.md\`

**Consumes:** Task 1 and Task 2 configuration.

**Produces:** \`ShopifyPartnerCsvMetricSource\` with source \`shopify_partner\`.

- [ ] **Step 1: Write failing test**

\`\`\`ts
it('reads the matching aggregate day and labels it manual import', async () => {
  await expect(importer.collect(window)).resolves.toMatchObject({
    source: 'shopify_partner', status: 'complete',
    metrics: { active_merchants: 4, installs: 2, uninstalls: 1, earnings_amount: 19.99 },
    notes: ['manual_import'],
  });
});
\`\`\`

- [ ] **Step 2: Run RED test**

Run: \`npm test -- src/tests/connectors/merchgrid-shopify-csv.test.ts\`  
Expected: FAIL because the CSV adapter does not exist.

- [ ] **Step 3: Implement strict aggregate import**

Require \`date\`, \`active_merchants\`, \`installs\`, \`uninstalls\`, and \`earnings_amount\`. Read only the selected-date row, parse finite nonnegative values, and discard every other column. Missing file/header, duplicate date row, or invalid cells produce a bounded noncomplete snapshot and never add CSV content to notes. Document a git-ignored aggregate-only input file.

- [ ] **Step 4: Run GREEN test**

Run: \`npm test -- src/tests/connectors/merchgrid-shopify-csv.test.ts\`  
Expected: PASS.

- [ ] **Step 5: Commit**

\`\`\`bash
git add src/connectors/merchgrid/shopify-partner-csv.ts src/tests/connectors/merchgrid-shopify-csv.test.ts README.md
git commit -m "feat: import Shopify Partner aggregates"
\`\`\`

### Task 6: Collection Coordinator and Deterministic Summaries

**Files:**
- Create: \`src/metrics/coordinator.ts\`
- Create: \`src/metrics/summaries.ts\`
- Create: \`src/metrics/evidence.ts\`
- Create: \`src/tests/metrics/coordinator.test.ts\`
- Create: \`src/tests/metrics/summaries.test.ts\`

**Consumes:** Tasks 1-5.

**Produces:** \`collectSourcePack\`, \`buildDailyHealthSummary\`, \`buildWeeklyBusinessReview\`, and \`toMerchGridReviewEvidence\`.

- [ ] **Step 1: Write failing tests**

\`\`\`ts
it('saves PostHog and Fly results when Shopify throws', async () => {
  await collectSourcePack({ adapters, repository, window });
  expect(await repository.load('fly_metrics', window.date)).toMatchObject({ status: 'complete' });
  expect(await repository.load('shopify_partner', window.date)).toMatchObject({ status: 'failed' });
});

it('does not turn missing source data into zero activity', () => {
  expect(buildDailyHealthSummary({ date: '2026-08-21', snapshots: [completeFly] }))
    .toMatchObject({ sourceStatuses: { posthog: 'missing' }, limitations: ['posthog:missing'] });
});
\`\`\`

- [ ] **Step 2: Run RED tests**

Run: \`npm test -- src/tests/metrics/coordinator.test.ts src/tests/metrics/summaries.test.ts\`  
Expected: FAIL because the coordinator and summaries do not exist.

- [ ] **Step 3: Implement source isolation and deterministic views**

Collect in stable source order. Convert unexpected adapter throws into that source's failed snapshot and save every source result. The daily summary exposes only complete values and lists every missing/noncomplete source. The weekly builder requires exactly two complete seven-date windows, sums available values, and calculates \`current - previous\` only if both values exist. The evidence artifact contains period, source coverage, aggregate metrics, and limitations only.

- [ ] **Step 4: Run GREEN tests**

Run: \`npm test -- src/tests/metrics/coordinator.test.ts src/tests/metrics/summaries.test.ts\`  
Expected: PASS.

- [ ] **Step 5: Commit**

\`\`\`bash
git add src/metrics src/tests/metrics/coordinator.test.ts src/tests/metrics/summaries.test.ts
git commit -m "feat: build MerchGrid review evidence"
\`\`\`

### Task 7: Explicit Commands and End-to-End Proof

**Files:**
- Create: \`src/jobs/merchgrid-source-pack.ts\`
- Create: \`src/cli/merchgrid-source-pack.ts\`
- Modify: \`package.json\`
- Modify: \`README.md\`
- Create: \`src/tests/jobs/merchgrid-source-pack.test.ts\`
- Create: \`src/tests/metrics/merchgrid-source-pack.e2e.test.ts\`

**Consumes:** Tasks 1-6.

**Produces:** \`npm run merchgrid:collect -- --date YYYY-MM-DD\` and \`npm run merchgrid:weekly-review -- --through YYYY-MM-DD\`.

- [ ] **Step 1: Write failing tests**

\`\`\`ts
it('collects a completed day and writes daily evidence', async () => {
  await runDailyCollection({ date: '2026-08-21', dependencies: fakeDependencies });
  expect(await artifacts.loadDailyHealth('2026-08-21')).toMatchObject({ date: '2026-08-21' });
});

it('builds a weekly review from all three fake sources', async () => {
  const review = await runWeeklyReview({ through: '2026-08-21', dependencies: fakeDependencies });
  expect(review.sourceCoverage).toEqual({
    posthog: 'complete', fly_metrics: 'complete', shopify_partner: 'complete',
  });
});
\`\`\`

- [ ] **Step 2: Run RED tests**

Run: \`npm test -- src/tests/jobs/merchgrid-source-pack.test.ts src/tests/metrics/merchgrid-source-pack.e2e.test.ts\`  
Expected: FAIL because job commands do not exist.

- [ ] **Step 3: Implement jobs, CLI, and operator guidance**

Reject today/future collection dates. Daily collection builds one completed UTC window, runs the coordinator, and writes a health artifact. Weekly review derives current and preceding seven-day windows, loads snapshots, and writes a review artifact. The CLI prints artifact paths and source statuses only.

Document these variable names only: \`POSTHOG_PROJECT_ID\`, \`POSTHOG_PERSONAL_API_KEY\`, \`POSTHOG_BASE_URL\`, \`FLY_ORG_SLUG\`, \`FLY_ACCESS_TOKEN\`, \`FLY_APP_NAME\`, \`MERCHGRID_METRICS_DATA_DIR\`, and \`SHOPIFY_PARTNER_AGGREGATES_CSV_PATH\`. An external scheduler runs the daily command after UTC midnight and the weekly command after Sunday closes. Do not add an in-process scheduler.

- [ ] **Step 4: Run complete verification**

Run: \`npm test && npm run typecheck && npm run build && git diff --check\`  
Expected: all tests, typecheck, and build pass; no whitespace errors.

- [ ] **Step 5: Commit**

\`\`\`bash
git add src/jobs src/cli package.json README.md src/tests/jobs src/tests/metrics/merchgrid-source-pack.e2e.test.ts
git commit -m "feat: add MerchGrid source pack commands"
\`\`\`

## Review Pace

Pause after each task. Recommended checkpoints:

1. **Tasks 1-2:** contract, idempotence, and credentials boundary.
2. **Tasks 3-5:** each source adapter and its privacy behavior.
3. **Task 6:** source isolation and review calculations.
4. **Task 7:** operator commands and end-to-end proof.

This plan intentionally ends before deployment or scheduler activation. Those actions require choosing Buffr's execution host and secret store; they require no change to MerchGrid.
