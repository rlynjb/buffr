# Marketplace Visibility Zero-Data Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revise sparse marketplace visibility mode so zero or sparse metrics plus sufficient product context produces a safe exploratory visibility test instead of stopping at `collect_more_data`.

**Architecture:** Keep the existing marketplace visibility workflow and work engine. Add an explicit visibility-mode selector, expand the local visibility context contract into a curated product brief, and make M4-M6 consume that mode so sparse metrics block confident claims but not low-risk exploratory tests.

**Tech Stack:** TypeScript, Node.js ESM, Zod, Vitest, existing Buffr workflow engine, existing local JSON artifacts, existing structured agent runner.

**Spec:** [`docs/superpowers/specs/2026-08-24-marketplace-visibility-zero-data-review-design.md`](../specs/2026-08-24-marketplace-visibility-zero-data-review-design.md)

## Global Constraints

- Preserve the existing metric-backed weekly recommendation path.
- Keep `evidenceLevel: 'sparse'` for marketplace visibility reviews that are not metric-proven.
- Do not query PostHog, Fly, Shopify, Etsy, Meta, Google Analytics, or any provider from agent modules.
- Do not persist credentials, raw provider payloads, raw marketplace pages, emails, shop domains, customer data, catalog records, or raw PostHog events.
- Use local curated context only for product and marketplace surface descriptions.
- Keep human approval mandatory before any marketplace change is applied manually.
- Do not add automatic Shopify App Store, Etsy, or Meta Marketplace edits.
- Tests use fakes, fixtures, temp directories, fixed clocks, and fake agent runners only.
- Keep `.env` ignored; commit only `.env.example` names and non-secret defaults if command configuration changes.

---

## File Structure Map

```text
src/contracts/marketplace-visibility.ts
  Expand MarketplaceVisibilityContext into a curated visibility brief.
  Add VisibilityReviewMode schema and parser.

src/connectors/marketplace/local-context.ts
  Continue loading local JSON only.
  Return validation errors that name missing visibility-brief fields.

src/workflow/marketplace-visibility-profile.ts
  Add selectMarketplaceVisibilityMode().
  Start workflow when context is sufficient, even if measuredSignals is empty.
  Stop with waitForMoreData only when required context is missing.

src/agents/marketplace-visibility/modules.ts
  Add mode-aware M1/M2 context.
  Guard M4 normalization so sparse metrics alone cannot preserve collect_more_data.
  Keep M5/M6 exploratory and low confidence.

src/tests/contracts/marketplace-visibility.test.ts
  Contract tests for required brief fields, mode parsing, and unsafe data rejection.

src/tests/connectors/marketplace-local-context.test.ts
  Loader tests for complete brief, missing fields, and local-only path behavior.

src/tests/workflow/marketplace-visibility-profile.test.ts
  Profile tests for zero metrics plus complete context and missing-context stop.

src/tests/agents/marketplace-visibility.test.ts
  Module tests for M4 routing, M5 hypothesis language, and M6 manual test plan.

src/tests/workflow/marketplace-visibility-engine.test.ts
  End-to-end workflow test that reaches approval_wait with zero signals.

README.md
  Document the visibility brief and the expected zero-data behavior.
```

## Execution and Data-Flow Diagram

```text
User creates local visibility brief
        |
        v
npm run marketplace:visibility-review
        |
        v
loadMarketplaceVisibilityContext()
        |
        v
MarketplaceVisibilityContextSchema
        |
        v
selectMarketplaceVisibilityMode()
        |
        +------------------------------+
        |                              |
        v                              v
missing_context                 exploratory_visibility_test
        |                              |
        v                              v
engine.waitForMoreData()        engine.startMarketplaceVisibility()
        |                              |
        v                              v
waiting_for_data                M1 -> M2 -> M4 -> M5 -> M6
                                       |
                                       v
                                approval_wait
                                       |
                                       v
                                human approves or rejects
```

The implementation seam is `VisibilityReviewMode`. Everything before it decides
whether the run is responsible to start. Everything after it assumes sparse
data is allowed and must not reinterpret sparse metrics as a reason to stop.

## Shared Interfaces

```ts
export type MarketplaceVisibilityProductType =
  | 'shopify_app'
  | 'digital_product'
  | 'physical_product'
  | 'service';

export type MarketplaceVisibilityContext = {
  marketplace: 'shopify_app_store' | 'etsy' | 'meta_marketplace';
  productName: string;
  productType: MarketplaceVisibilityProductType;
  targetCustomer: string;
  customerProblem: string;
  currentPromise: string;
  currentSurfaceSummary: string;
  primaryDiscoverySurface: string;
  primaryActionWanted: string;
  constraints: string[];
  availableAssets: string[];
  ownerGoal: string;
};

export type VisibilityReviewMode =
  | {
      mode: 'exploratory_visibility_test';
      evidenceLevel: 'sparse';
      confidenceBoundary: 'low';
      reason: 'metrics_sparse_context_sufficient';
    }
  | {
      mode: 'missing_context';
      missingFields: string[];
      reason: 'context_required_before_exploratory_test';
    };

export function selectMarketplaceVisibilityMode(input: {
  context: MarketplaceVisibilityContext;
  measuredSignals: Record<string, number>;
  limitations: readonly string[];
}): VisibilityReviewMode;
```

> **DDIA lens — derived data:** `VisibilityReviewMode` is derived data. It records how Buffr interpreted evidence quality for this run so M4 does not have to guess from loose prose.

## Task 1: Expand the Visibility Brief Contract

**Purpose:** Give sparse mode enough product and marketplace context to recommend an exploratory test responsibly.

**Why:** Zero metrics alone cannot diagnose visibility. The review needs curated context about the product, target customer, current marketplace surface, and intended action.

**How:** Expand `MarketplaceVisibilityContextSchema` with required brief fields and keep the existing safety filters.

**DDIA concept:** schema-on-write. Buffr validates the local brief before the workflow stores or reasons over it.

**Files:**
- Modify: `src/contracts/marketplace-visibility.ts`
- Modify: `src/tests/contracts/marketplace-visibility.test.ts`

**Interfaces:**
- Consumes: existing `MarketplaceVisibilityContextSchema`.
- Produces: expanded `MarketplaceVisibilityContext`, `MarketplaceVisibilityProductTypeSchema`.

- [ ] **Step 1: Write failing contract tests**

Add tests:

```ts
it('accepts a complete MerchGrid visibility brief', () => {
  expect(MarketplaceVisibilityContextSchema.parse({
    marketplace: 'shopify_app_store',
    productName: 'MerchGrid',
    productType: 'shopify_app',
    targetCustomer: 'Shopify merchants reviewing catalog quality',
    customerProblem: 'Catalog issues can hurt trust before the merchant notices',
    currentPromise: 'Find catalog issues before they hurt sales or trust',
    currentSurfaceSummary: 'Shopify App Store listing for a catalog audit app',
    primaryDiscoverySurface: 'Shopify App Store search and category browsing',
    primaryActionWanted: 'Open the app and run the first catalog audit',
    constraints: ['manual listing changes only'],
    availableAssets: ['listing copy', 'screenshots'],
    ownerGoal: 'increase qualified app opens and first scans',
  })).toMatchObject({
    productType: 'shopify_app',
    primaryActionWanted: 'Open the app and run the first catalog audit',
  });
});

it('rejects a brief without a target customer', () => {
  expect(() => MarketplaceVisibilityContextSchema.parse({
    marketplace: 'shopify_app_store',
    productName: 'MerchGrid',
    productType: 'shopify_app',
    customerProblem: 'Catalog issues can hurt trust',
    currentPromise: 'Find catalog issues',
    currentSurfaceSummary: 'Shopify listing',
    primaryDiscoverySurface: 'Shopify App Store search',
    primaryActionWanted: 'Run the first catalog audit',
    constraints: ['manual listing changes only'],
    availableAssets: ['listing copy'],
    ownerGoal: 'increase qualified app opens',
  })).toThrow();
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm test -- src/tests/contracts/marketplace-visibility.test.ts
```

Expected: fails because the new required context fields are not yet in the schema.

- [ ] **Step 3: Expand the schema minimally**

In `src/contracts/marketplace-visibility.ts`, add:

```ts
export const MarketplaceVisibilityProductTypeSchema = z.enum([
  'shopify_app',
  'digital_product',
  'physical_product',
  'service',
]);
```

Replace `MarketplaceVisibilityContextSchema` with the expanded strict object:

```ts
export const MarketplaceVisibilityContextSchema = z.object({
  marketplace: z.enum(['shopify_app_store', 'etsy', 'meta_marketplace']),
  productName: safeMarketplaceText(120),
  productType: MarketplaceVisibilityProductTypeSchema,
  targetCustomer: safeMarketplaceText(300),
  customerProblem: safeMarketplaceText(500),
  currentPromise: safeMarketplaceText(300),
  currentSurfaceSummary: safeMarketplaceText(1_000),
  primaryDiscoverySurface: safeMarketplaceText(300),
  primaryActionWanted: safeMarketplaceText(300),
  constraints: z.array(safeMarketplaceText(300)).min(1).max(12),
  availableAssets: z.array(safeMarketplaceText(300)).max(12),
  ownerGoal: safeMarketplaceText(300),
}).strict();
```

Export:

```ts
export type MarketplaceVisibilityProductType = z.infer<typeof MarketplaceVisibilityProductTypeSchema>;
```

- [ ] **Step 4: Update existing tests and fixtures**

Find fixtures using the old shorter context shape:

```bash
rg -n "currentSurfaceSummary|knownDiscoverySurface|targetAudience" src/tests src
```

Update each marketplace visibility fixture with concrete curated values from Step 1. Remove `targetAudience` and `knownDiscoverySurface` unless a compatibility layer is intentionally kept.

- [ ] **Step 5: Verify the contract slice**

Run:

```bash
npm test -- src/tests/contracts/marketplace-visibility.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/marketplace-visibility.ts src/tests/contracts/marketplace-visibility.test.ts
git commit -m "feat: expand marketplace visibility brief"
```

## Task 2: Add Explicit Visibility Mode Selection

**Purpose:** Make sparse mode a deterministic workflow mode instead of a prompt-level suggestion.

**Why:** The agent should not decide whether sparse metrics are allowed to proceed. Code should decide whether the context is sufficient for a low-risk exploratory test.

**How:** Add `VisibilityReviewModeSchema` and `selectMarketplaceVisibilityMode()`.

**DDIA concept:** provenance. The selected mode becomes part of the evidence trail for why Buffr proceeded or stopped.

**Files:**
- Modify: `src/contracts/marketplace-visibility.ts`
- Modify: `src/workflow/marketplace-visibility-profile.ts`
- Modify: `src/tests/workflow/marketplace-visibility-profile.test.ts`

**Interfaces:**
- Consumes: expanded `MarketplaceVisibilityContext`, measured signals, limitations.
- Produces: `VisibilityReviewMode`, `selectMarketplaceVisibilityMode(input)`.

- [ ] **Step 1: Write failing mode-selector tests**

Add tests:

```ts
it('selects exploratory mode for complete context even when signals are empty', () => {
  expect(selectMarketplaceVisibilityMode({
    context: completeVisibilityContext(),
    measuredSignals: {},
    limitations: ['PostHog metrics unavailable'],
  })).toEqual({
    mode: 'exploratory_visibility_test',
    evidenceLevel: 'sparse',
    confidenceBoundary: 'low',
    reason: 'metrics_sparse_context_sufficient',
  });
});

it('returns missing context when the brief lacks required decision context', () => {
  expect(selectMarketplaceVisibilityMode({
    context: { ...completeVisibilityContext(), constraints: [] },
    measuredSignals: {},
    limitations: [],
  })).toEqual({
    mode: 'missing_context',
    missingFields: ['constraints'],
    reason: 'context_required_before_exploratory_test',
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm test -- src/tests/workflow/marketplace-visibility-profile.test.ts
```

Expected: fails because `selectMarketplaceVisibilityMode` does not exist.

- [ ] **Step 3: Implement mode schema and selector**

In `src/contracts/marketplace-visibility.ts`, add:

```ts
export const VisibilityReviewModeSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('exploratory_visibility_test'),
    evidenceLevel: z.literal('sparse'),
    confidenceBoundary: z.literal('low'),
    reason: z.literal('metrics_sparse_context_sufficient'),
  }).strict(),
  z.object({
    mode: z.literal('missing_context'),
    missingFields: z.array(z.string().min(1)).min(1),
    reason: z.literal('context_required_before_exploratory_test'),
  }).strict(),
]);

export type VisibilityReviewMode = z.infer<typeof VisibilityReviewModeSchema>;
```

In `src/workflow/marketplace-visibility-profile.ts`, add:

```ts
export function selectMarketplaceVisibilityMode(input: {
  context: MarketplaceVisibilityContext;
  measuredSignals: Record<string, number>;
  limitations: readonly string[];
}): VisibilityReviewMode {
  const missingFields = [
    input.context.productName ? undefined : 'productName',
    input.context.productType ? undefined : 'productType',
    input.context.targetCustomer ? undefined : 'targetCustomer',
    input.context.customerProblem ? undefined : 'customerProblem',
    input.context.currentPromise ? undefined : 'currentPromise',
    input.context.currentSurfaceSummary ? undefined : 'currentSurfaceSummary',
    input.context.primaryDiscoverySurface ? undefined : 'primaryDiscoverySurface',
    input.context.primaryActionWanted ? undefined : 'primaryActionWanted',
    input.context.constraints.length > 0 ? undefined : 'constraints',
  ].filter((field): field is string => Boolean(field));

  if (missingFields.length > 0) {
    return {
      mode: 'missing_context',
      missingFields,
      reason: 'context_required_before_exploratory_test',
    };
  }

  return {
    mode: 'exploratory_visibility_test',
    evidenceLevel: 'sparse',
    confidenceBoundary: 'low',
    reason: 'metrics_sparse_context_sufficient',
  };
}
```

- [ ] **Step 4: Verify selector tests**

Run:

```bash
npm test -- src/tests/workflow/marketplace-visibility-profile.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/marketplace-visibility.ts src/workflow/marketplace-visibility-profile.ts src/tests/workflow/marketplace-visibility-profile.test.ts
git commit -m "feat: add marketplace visibility mode selector"
```

## Task 3: Persist Mode in Marketplace Visibility Evidence

**Purpose:** Make the selected mode available to M1-M6 and future audit trails.

**Why:** If the run later says "exploratory," reviewers need to see that this was a deliberate mode decision, not an agent improvisation.

**How:** Add `reviewMode` to `MarketplaceVisibilityEvidence` and populate it when building MerchGrid and Etsy visibility evidence.

**DDIA concept:** lineage. The output carries its decision context along with the source evidence.

**Files:**
- Modify: `src/contracts/marketplace-visibility.ts`
- Modify: `src/workflow/marketplace-visibility-profile.ts`
- Modify: `src/tests/contracts/marketplace-visibility.test.ts`
- Modify: `src/tests/workflow/marketplace-visibility-profile.test.ts`
- Modify: `src/tests/workflow/marketplace-visibility-engine.test.ts`
- Modify: `src/tests/agents/marketplace-visibility.test.ts`

**Interfaces:**
- Consumes: `VisibilityReviewMode`.
- Produces: `MarketplaceVisibilityEvidence.reviewMode`.

- [ ] **Step 1: Write failing evidence tests**

Assert evidence includes review mode:

```ts
expect(parseMarketplaceVisibilityEvidence(completeEvidence())).toMatchObject({
  reviewMode: {
    mode: 'exploratory_visibility_test',
    evidenceLevel: 'sparse',
    confidenceBoundary: 'low',
  },
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- src/tests/contracts/marketplace-visibility.test.ts src/tests/workflow/marketplace-visibility-profile.test.ts
```

Expected: fails because `reviewMode` is not accepted or populated.

- [ ] **Step 3: Add `reviewMode` to the schema**

In `MarketplaceVisibilityEvidenceSchema`, add:

```ts
reviewMode: VisibilityReviewModeSchema,
```

Only the `exploratory_visibility_test` branch should appear in persisted evidence. `missing_context` is returned before a run starts.

- [ ] **Step 4: Populate `reviewMode` in profile builders**

In `buildMerchGridVisibilityEvidence()`:

```ts
const measuredSignals = numericMarketplaceSignals(artifact);
const reviewMode = selectMarketplaceVisibilityMode({
  context: input.context,
  measuredSignals,
  limitations: artifact.limitations,
});
if (reviewMode.mode === 'missing_context') {
  throw new AppError('validation_failed', `visibility_context_missing:${reviewMode.missingFields.join(',')}`);
}
```

Then set:

```ts
measuredSignals,
reviewMode,
```

Apply the same pattern to `buildEtsyVisibilityEvidence()`.

- [ ] **Step 5: Update all test fixtures**

Every `MarketplaceVisibilityEvidence` fixture must include:

```ts
reviewMode: {
  mode: 'exploratory_visibility_test',
  evidenceLevel: 'sparse',
  confidenceBoundary: 'low',
  reason: 'metrics_sparse_context_sufficient',
},
```

- [ ] **Step 6: Verify persisted evidence tests**

Run:

```bash
npm test -- src/tests/contracts/marketplace-visibility.test.ts src/tests/workflow/marketplace-visibility-profile.test.ts src/tests/workflow/marketplace-visibility-engine.test.ts src/tests/agents/marketplace-visibility.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/contracts/marketplace-visibility.ts src/workflow/marketplace-visibility-profile.ts src/tests/contracts/marketplace-visibility.test.ts src/tests/workflow/marketplace-visibility-profile.test.ts src/tests/workflow/marketplace-visibility-engine.test.ts src/tests/agents/marketplace-visibility.test.ts
git commit -m "feat: persist marketplace visibility review mode"
```

## Task 4: Make M4 Sparse-Aware Instead of Stop-First

**Purpose:** Ensure sparse metrics do not stop a visibility review when product context is sufficient.

**Why:** This is the observed bug. M4 can currently return `collect_more_data`, and `normalizeDiagnosis()` preserves it unless the agent asked for research.

**How:** Update M4 prompt and normalization so `exploratory_visibility_test` mode converts sparse-only `collect_more_data` into a low-confidence `proceed_to_hypothesis`.

**DDIA concept:** separating uncertainty from absence. The system preserves uncertainty while still allowing a safe exploratory action.

**Files:**
- Modify: `src/agents/marketplace-visibility/modules.ts`
- Modify: `src/tests/agents/marketplace-visibility.test.ts`

**Interfaces:**
- Consumes: `MarketplaceVisibilityEvidence.reviewMode`.
- Produces: M4 `DiagnosisOutput` with `decision: 'proceed_to_hypothesis'` for sparse-but-context-complete visibility reviews.

- [ ] **Step 1: Write failing M4 regression test**

Add:

```ts
it('does not stop at collect_more_data when exploratory mode has complete context', async () => {
  const executor = createMarketplaceVisibilityModuleExecutor({
    agentRunner: new FakeAgentRunner({
      m4: {
        performancePath: 'insufficient_data',
        primaryBottleneck: 'Measured marketplace data is sparse.',
        competingExplanation: 'The listing may not yet have marketplace exposure.',
        confidence: 'low',
        decision: 'collect_more_data',
        notes: ['Metrics are sparse.'],
      },
    }),
  });

  await expect(executor.runM4(workflowState({ evidence: visibilityEvidence() }))).resolves.toMatchObject({
    performancePath: 'discovery',
    decision: 'proceed_to_hypothesis',
    confidence: 'low',
    notes: expect.arrayContaining([
      'Sparse metrics do not block a human-approved exploratory visibility test.',
    ]),
  });
});
```

- [ ] **Step 2: Run failing M4 test**

Run:

```bash
npm test -- src/tests/agents/marketplace-visibility.test.ts
```

Expected: fails because M4 still returns `collect_more_data`.

- [ ] **Step 3: Pass evidence into normalization**

Change `runM4()`:

```ts
const evidence = requireInitialEvidence(state);
return normalizeDiagnosis(result.output, evidence);
```

Change the function:

```ts
function normalizeDiagnosis(output: DiagnosisOutput, evidence: MarketplaceVisibilityEvidence): DiagnosisOutput {
  if (
    evidence.reviewMode.mode === 'exploratory_visibility_test'
    && output.decision === 'collect_more_data'
  ) {
    return {
      ...output,
      performancePath: 'discovery',
      decision: 'proceed_to_hypothesis',
      notes: [
        ...output.notes,
        'Sparse metrics do not block a human-approved exploratory visibility test.',
        'Recommendation remains low-confidence and not metric-proven.',
      ],
    };
  }
  if (output.decision !== 'research_domain_knowledge') return output;
  const { researchQuestion: _researchQuestion, ...withoutResearchQuestion } = output;
  return { ...withoutResearchQuestion, decision: 'collect_more_data' };
}
```

- [ ] **Step 4: Strengthen the M4 prompt**

Replace `VISIBILITY_DIAGNOSIS_PROMPT` with:

```ts
const VISIBILITY_DIAGNOSIS_PROMPT = [
  'M4 Marketplace Visibility Diagnosis.',
  'Use sparse evidence honestly. Do not claim proof.',
  'If reviewMode.mode is exploratory_visibility_test, sparse or zero metrics alone are not a reason to stop.',
  'Use product context and marketplace context to identify one likely visibility bottleneck hypothesis.',
  'Choose proceed_to_hypothesis for one manual exploratory test unless the product context is contradictory or unsafe.',
].join('\n');
```

- [ ] **Step 5: Verify M4 tests**

Run:

```bash
npm test -- src/tests/agents/marketplace-visibility.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/agents/marketplace-visibility/modules.ts src/tests/agents/marketplace-visibility.test.ts
git commit -m "fix: keep sparse visibility reviews exploratory"
```

## Task 5: Require Exploratory Language in M5 and M6

**Purpose:** Make the output useful without overclaiming.

**Why:** Once M4 proceeds, M5 and M6 must stay inside the low-confidence product-decision lane.

**How:** Normalize M5/M6 notes and plan fields so outputs explicitly say exploratory, manual, and not metric-proven.

**DDIA concept:** confidence metadata. The evidence level and confidence boundary travel into the recommendation text.

**Files:**
- Modify: `src/agents/marketplace-visibility/modules.ts`
- Modify: `src/tests/agents/marketplace-visibility.test.ts`

**Interfaces:**
- Consumes: M5/M6 agent outputs.
- Produces: M5/M6 outputs that preserve exploratory safety language.

- [ ] **Step 1: Write failing M5/M6 safety tests**

Add:

```ts
it('adds exploratory safety notes to M5 and M6 outputs', async () => {
  const executor = createMarketplaceVisibilityModuleExecutor({
    agentRunner: new FakeAgentRunner({
      m5: {
        hypothesis: 'Clearer first-scan positioning may improve qualified opens.',
        primaryVariable: 'listing positioning',
        recommendedRevision: 'Lead the listing with the first audit outcome.',
        keepConstant: ['pricing', 'app behavior'],
        expectedSignal: 'App opens or scan starts become observable.',
        notes: [],
      },
      m6: {
        primaryMetric: 'posthog_app_opened_count',
        secondaryMetrics: ['posthog_scan_started_count'],
        baselineValue: 0,
        baselinePeriod: 'zero-data launch baseline',
        qualificationRequirements: [],
        expectedSupportingSignal: 'A later weekly review shows app opens.',
        expectedWeakeningSignal: 'Signals remain absent after the manual change.',
        inconclusiveCondition: 'Marketplace exposure remains too sparse to compare.',
        contextToMonitor: [],
        unresolvedMeasurementRules: [],
      },
    }),
  });

  await expect(executor.runM5(workflowState({ evidence: visibilityEvidence() }))).resolves.toMatchObject({
    notes: expect.arrayContaining(['Exploratory recommendation; not metric-proven.']),
  });
  await expect(executor.runM6(workflowState({ evidence: visibilityEvidence() }))).resolves.toMatchObject({
    qualificationRequirements: expect.arrayContaining(['Human approval and manual marketplace edit are required before measurement.']),
    contextToMonitor: expect.arrayContaining(['manual marketplace change applied by owner']),
  });
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- src/tests/agents/marketplace-visibility.test.ts
```

Expected: fails because notes and requirements are not normalized yet.

- [ ] **Step 3: Normalize M5**

Change `normalizeHypothesis()`:

```ts
function normalizeHypothesis(output: HypothesisOutput): HypothesisOutput {
  const { researchNeed: _researchNeed, ...withoutResearchNeed } = output;
  return {
    ...withoutResearchNeed,
    notes: [
      ...withoutResearchNeed.notes,
      'Exploratory recommendation; not metric-proven.',
      'Human approval required before changing any marketplace surface.',
    ],
  };
}
```

- [ ] **Step 4: Normalize M6**

Change `normalizeTestPlan()`:

```ts
function normalizeTestPlan(output: TestPlanOutput): TestPlanOutput {
  const { researchNeed: _researchNeed, ...withoutResearchNeed } = output;
  return {
    ...withoutResearchNeed,
    qualificationRequirements: [
      ...withoutResearchNeed.qualificationRequirements,
      'Human approval and manual marketplace edit are required before measurement.',
      'Later evidence must be compared as exploratory and low confidence.',
    ],
    contextToMonitor: [
      ...withoutResearchNeed.contextToMonitor,
      'manual marketplace change applied by owner',
    ],
    unresolvedMeasurementRules: [],
  };
}
```

- [ ] **Step 5: Verify agent module tests**

Run:

```bash
npm test -- src/tests/agents/marketplace-visibility.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/agents/marketplace-visibility/modules.ts src/tests/agents/marketplace-visibility.test.ts
git commit -m "feat: label visibility recommendations exploratory"
```

## Task 6: End-to-End Zero-Data Workflow Coverage

**Purpose:** Prove the user-facing workflow now produces an approval-ready recommendation from zero metrics plus sufficient context.

**Why:** The previous real run stopped at M4. The final behavior must be verified at the workflow level, not only in module unit tests.

**How:** Add an end-to-end workflow or CLI test with empty measured signals and a complete brief.

**DDIA concept:** end-to-end dataflow validation. The test proves data moves from local context through normalized evidence into the work engine result.

**Files:**
- Modify: `src/tests/workflow/marketplace-visibility-engine.test.ts`
- Modify: `src/tests/cli/marketplace-visibility.test.ts`

**Interfaces:**
- Consumes: existing `createWorkflowEngine()`, marketplace visibility CLI runner, fake agent runner.
- Produces: tests that assert `approval_wait` for zero data.

- [ ] **Step 1: Add zero-data workflow test**

Add:

```ts
it('routes zero-data exploratory visibility review to approval wait', async () => {
  const repository = new InMemoryRunRepository();
  const engine = createWorkflowEngine({ repository, modules: moduleExecutor(), now: fixedNow });

  await engine.startMarketplaceVisibility({
    runId: 'visibility-zero-data',
    subjectRef: 'marketplace_visibility:merchgrid_shopify_app_store:2026-08-24',
    initialEvidence: visibilityEvidence({
      subjectRef: 'merchgrid:visibility:2026-08-24',
      measuredSignals: {},
      limitations: ['PostHog metrics unavailable', 'Shopify Partner metrics sparse'],
    }),
  });

  for (let index = 0; index < 5; index += 1) await engine.step('visibility-zero-data');
  await expect(repository.load('visibility-zero-data')).resolves.toMatchObject({
    status: 'awaiting_approval',
    stage: 'approval_wait',
    moduleOutputs: {
      m4: { decision: 'proceed_to_hypothesis' },
      m6: { primaryMetric: expect.any(String) },
    },
  });
});
```

- [ ] **Step 2: Add missing-context workflow or CLI test**

Add a test that starts from context with empty `constraints` and asserts:

```ts
await expect(service.startVisibilityReview({
  profile: 'merchgrid_shopify_app_store',
  runId: 'visibility-missing-context',
  date: '2026-08-24',
  contextPath,
})).rejects.toMatchObject({
  code: 'validation_failed',
  message: expect.stringContaining('visibility_context_missing:constraints'),
});
```

- [ ] **Step 3: Run focused workflow and CLI tests**

Run:

```bash
npm test -- src/tests/workflow/marketplace-visibility-engine.test.ts src/tests/cli/marketplace-visibility.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/tests/workflow/marketplace-visibility-engine.test.ts src/tests/cli/marketplace-visibility.test.ts
git commit -m "test: cover zero-data visibility workflow"
```

## Task 7: Documentation and Local Context Example

**Purpose:** Make the new behavior obvious the next time the owner starts from no data.

**Why:** Sparse mode is conceptually subtle. The docs should say that zero data is allowed when product context is complete, and should show the exact local JSON shape.

**How:** Update README usage and `.env.example` only if path names changed. Add a safe example visibility context.

**DDIA concept:** operational metadata. The local brief is metadata that makes the review usable, even when quantitative data is weak.

**Files:**
- Modify: `README.md`
- Modify: `.env.example` only if `MERCHGRID_VISIBILITY_CONTEXT_PATH` is missing
- Create or modify: `docs/examples/merchgrid-visibility-context.example.json`

**Interfaces:**
- Consumes: final context schema from Task 1.
- Produces: documented command path and example context.

- [ ] **Step 1: Add example JSON**

Create `docs/examples/merchgrid-visibility-context.example.json`:

```json
{
  "marketplace": "shopify_app_store",
  "productName": "MerchGrid",
  "productType": "shopify_app",
  "targetCustomer": "Shopify merchants reviewing catalog quality",
  "customerProblem": "Catalog issues can hurt sales or trust before the merchant notices",
  "currentPromise": "Find catalog issues before they hurt sales or trust",
  "currentSurfaceSummary": "Shopify App Store listing for a read-only catalog audit app",
  "primaryDiscoverySurface": "Shopify App Store search and category browsing",
  "primaryActionWanted": "Open the app and run the first catalog audit",
  "constraints": ["manual listing changes only", "do not change app behavior"],
  "availableAssets": ["listing copy", "screenshots", "setup documentation"],
  "ownerGoal": "increase qualified app opens and first scan starts"
}
```

- [ ] **Step 2: Update README**

Add a short section:

````md
### Marketplace visibility with zero or sparse data

Marketplace visibility reviews can run before there is enough traffic for a
metric-backed diagnosis. Buffr requires a local visibility brief so the work
engine can recommend one low-risk exploratory test without pretending the data
proves the change.

Copy `docs/examples/merchgrid-visibility-context.example.json` to
`artifacts/merchgrid/context/merchgrid-visibility-context.json`, edit the product context, then run:

```bash
npm run marketplace:visibility-review -- \
  --profile merchgrid_shopify_app_store \
  --date 2026-08-24 \
  --run-id merchgrid-visibility-2026-08-24 \
  --context artifacts/merchgrid/context/merchgrid-visibility-context.json
```

If the brief is complete, zero metrics can still produce an `approval_wait`
recommendation. If required context is missing, the command stops with the
specific missing fields.
````

- [ ] **Step 3: Verify docs are safe**

Run:

```bash
rg -n "api[_ -]?key|token|secret|password|myshopify\\.com|@" README.md docs/examples/merchgrid-visibility-context.example.json
```

Expected: no output.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example docs/examples/merchgrid-visibility-context.example.json
git commit -m "docs: explain zero-data visibility reviews"
```

## Final Verification

After all tasks:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected:

- all tests pass;
- typecheck passes;
- build passes;
- whitespace check has no output;
- a zero-data marketplace visibility run with complete context reaches `approval_wait`;
- a missing-context run stops with exact missing fields;
- no `.env`, raw Shopify Partner CSV, or local run artifacts are staged.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-24-marketplace-visibility-zero-data-review.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, with checkpoints for review.

The recommended path is subagent-driven because Tasks 1-7 have clear review boundaries and the existing marketplace visibility code is already modular enough for task-by-task implementation.
