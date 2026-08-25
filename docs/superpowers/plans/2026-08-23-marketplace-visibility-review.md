# Marketplace Visibility Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scarce-data marketplace visibility workflow that can produce a human-approved exploratory visibility test when metric-backed recommendations are not ready.

**Architecture:** Keep the existing source-pack and workflow engine intact. Add a new marketplace visibility evidence contract, product-specific visibility profiles, a workflow entry point, visibility-oriented module executor, and local CLI commands. MerchGrid is the first runtime profile; Etsy is represented by fixture-backed tests so the design remains marketplace-oriented rather than Shopify-only.

**Tech Stack:** TypeScript, Node.js ESM, Zod, Vitest, existing JSON repositories, existing Buffr workflow engine, existing structured agent runner.

**Spec:** [`docs/superpowers/specs/2026-08-23-marketplace-visibility-review-design.md`](../specs/2026-08-23-marketplace-visibility-review-design.md)

## Global Constraints

- Preserve the existing metric-backed weekly recommendation path.
- Label scarce evidence as `evidenceLevel: 'sparse'`; never promote it to measured proof.
- Do not query PostHog, Fly, Shopify, Etsy, or any provider from workflow modules.
- Do not persist credentials, raw provider payloads, raw marketplace pages, shop domains, merchant/customer data, catalog records, or raw PostHog events.
- Keep human approval mandatory before `experiment_wait`.
- No command edits Shopify App Store, Etsy, or any marketplace setting.
- Tests use fakes, fixtures, local temp directories, fixed clocks, and fake agent runners only.
- Keep `.env` ignored; commit only `.env.example` names and non-secret defaults if command configuration changes.

---

## File Structure Map

```text
src/contracts/marketplace-visibility.ts          # scarce-data visibility evidence contract
src/contracts/workflow.ts                        # add marketplace workflow kind/evidence union
src/connectors/marketplace/local-context.ts      # strict local JSON context loader; no provider calls
src/workflow/marketplace-visibility-profile.ts   # profile facade and readiness rules
src/workflow/engine.ts                           # generic marketplace start/result evidence entry
src/workflow/routes.ts                           # keep approval wait; no provider writes
src/workflow/state.ts                            # evidence references for visibility runs
src/agents/marketplace-visibility/modules.ts     # M1/M2 deterministic bridge and M4-M6 visibility prompts
src/cli/marketplace-visibility.ts                # visibility-review, approve, reject, record-result commands
src/tests/contracts/marketplace-visibility.test.ts
src/tests/connectors/marketplace-local-context.test.ts
src/tests/workflow/marketplace-visibility-profile.test.ts
src/tests/workflow/marketplace-visibility-engine.test.ts
src/tests/agents/marketplace-visibility.test.ts
src/tests/cli/marketplace-visibility.test.ts
README.md
.env.example
package.json
```

Keep `src/contracts/evidence.ts` Etsy/listing-specific. Keep `src/contracts/merchgrid-workflow.ts` MerchGrid source-pack-specific. `src/contracts/marketplace-visibility.ts` is the shared scarce-data recommendation contract.

> **DDIA lens — schema evolution:** The new visibility evidence is a new immutable input type, not a widened version of Etsy evidence or MerchGrid evidence. Persisted runs remain readable because each run records its evidence product and workflow kind.

## Execution and Data-Flow Diagram

```text
Implementation tasks
--------------------

Task 1
Contracts
  |
  | produces MarketplaceVisibilityEvidenceSchema
  v
Task 2
Local context loader + visibility profiles
  |
  | produces MarketplaceVisibilityService.startVisibilityReview()
  v
Task 3
Workflow engine entry + persistence
  |
  | stores workflowKind: marketplace_visibility_review
  v
Task 4
Visibility module executor
  |
  | runs M1/M2 deterministic + M4-M6 agent-assisted modules
  v
Task 5
CLI commands
  |
  | lets user run review, approve/reject, and record result locally
  v
Task 6
Result path + safety verification
  |
  | feeds later evidence back into the same run lifecycle
  v
Manual dry run
  npm run merchgrid:collect
  npm run marketplace:visibility-review
  npm run marketplace:approve
```

Runtime data flow after implementation:

```text
.local context JSON             .local MerchGrid daily artifact
        |                                      |
        +------------------+-------------------+
                           |
                           v
          src/workflow/marketplace-visibility-profile.ts
                           |
                           | builds strict sparse evidence
                           v
          src/contracts/marketplace-visibility.ts
                           |
                           | validates provider-safe evidence
                           v
          src/workflow/engine.ts
                           |
                           | persists run + routes lifecycle
                           v
          src/agents/marketplace-visibility/modules.ts
                           |
                           | M1 context
                           | M2 sparse evidence label
                           | M4 diagnosis
                           | M5 hypothesis
                           | M6 manual test plan
                           v
          .local/.../workflow-runs/<run-id>/
                           |
                           | owner approves/rejects via CLI
                           v
          approval_wait -> experiment_wait -> later M7 learning
```

The implementation seam is the same as the design seam:
`MarketplaceVisibilityEvidence`. Tasks 1-2 build evidence; Tasks 3-6 reuse the
existing workflow machinery to reason over it.

## Shared Interfaces

```ts
export type MarketplaceVisibilityProfile = 'merchgrid_shopify_app_store' | 'etsy_listing';
export type MarketplaceVisibilityEvidenceLevel = 'sparse';
export type MarketplaceVisibilityRecommendationType = 'visibility_hypothesis';

export type MarketplaceVisibilityContext = {
  marketplace: 'shopify_app_store' | 'etsy';
  productName: string;
  currentSurfaceSummary: string;
  targetAudience?: string;
  knownDiscoverySurface?: string;
};

export type MarketplaceVisibilityEvidence = {
  product: 'marketplace_visibility';
  profile: MarketplaceVisibilityProfile;
  subjectRef: string;
  artifactRef: string;
  evidenceLevel: MarketplaceVisibilityEvidenceLevel;
  recommendationType: MarketplaceVisibilityRecommendationType;
  marketplaceContext: MarketplaceVisibilityContext;
  measuredSignals: Record<string, number>;
  limitations: string[];
  prohibitedClaims: string[];
};

export type MarketplaceVisibilityStartInput =
  | {
      profile: 'merchgrid_shopify_app_store';
      runId: string;
      date: string;
      contextPath: string;
    }
  | {
      profile: 'etsy_listing';
      runId: string;
      contextPath: string;
    };

export type MarketplaceVisibilityService = {
  startVisibilityReview(input: MarketplaceVisibilityStartInput): Promise<WorkflowRunState>;
  supplyVisibilityResult(input: { runId: string; profile: MarketplaceVisibilityProfile; through?: string }): Promise<WorkflowRunState>;
};
```

The exact implementation must use Zod `.strict()` schemas. `contextPath` is a local file path. `artifactRef` is a local evidence reference. Neither field may contain `://`.

> **APOSD lens — information hiding:** The profile facade exposes one simple operation: start a visibility review. It hides whether the context came from a MerchGrid daily artifact or an Etsy fixture.

## Task 1: Marketplace Visibility Evidence Contract

**Purpose:** Define the safe scarce-data evidence shape before any workflow can consume it.

**Why:** The work engine should not infer meaning from loose JSON. A visibility review needs a strict contract that names the marketplace, labels the evidence as sparse, and blocks private/source data.

**How:** Add a Zod-backed contract and parser that accepts only the fields needed for a scarce-data visibility hypothesis.

**Learning lenses:**
- **DDIA lens — missing-data semantics:** sparse evidence is represented explicitly rather than being converted to zero or healthy.
- **FODE lens — data-quality contract:** the contract carries limitations and prohibited claims as part of the data product.
- **AIAIA lens — bounded context:** agents receive only the curated sparse evidence, not provider access.

**Files:**
- Create: `src/contracts/marketplace-visibility.ts`
- Modify: `src/contracts/workflow.ts`
- Test: `src/tests/contracts/marketplace-visibility.test.ts`

**Interfaces:**
- Consumes: no new runtime dependencies.
- Produces: `MarketplaceVisibilityEvidenceSchema`, `MarketplaceVisibilityContextSchema`, `parseMarketplaceVisibilityEvidence(value): MarketplaceVisibilityEvidence`, and a `WorkflowEvidenceSchema` branch for `MarketplaceVisibilityEvidenceSchema`.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  MarketplaceVisibilityEvidenceSchema,
  parseMarketplaceVisibilityEvidence,
} from '../../contracts/marketplace-visibility.js';

describe('marketplace visibility evidence contract', () => {
  it('accepts sparse MerchGrid marketplace evidence', () => {
    expect(parseMarketplaceVisibilityEvidence({
      product: 'marketplace_visibility',
      profile: 'merchgrid_shopify_app_store',
      subjectRef: 'merchgrid:visibility:2026-08-22',
      artifactRef: 'artifacts/merchgrid/metrics/artifacts/daily-health/2026-08-22.json',
      evidenceLevel: 'sparse',
      recommendationType: 'visibility_hypothesis',
      marketplaceContext: {
        marketplace: 'shopify_app_store',
        productName: 'MerchGrid',
        currentSurfaceSummary: 'Shopify app listing for a catalog audit app',
        targetAudience: 'Shopify merchants auditing catalog quality',
        knownDiscoverySurface: 'Shopify App Store search and category pages',
      },
      measuredSignals: {
        app_opened_count: 0,
        request_count: 2,
      },
      limitations: ['low request volume'],
      prohibitedClaims: ['Do not claim the listing caused low traffic'],
    })).toMatchObject({
      product: 'marketplace_visibility',
      evidenceLevel: 'sparse',
      recommendationType: 'visibility_hypothesis',
    });
  });

  it.each([
    { POSTHOG_PERSONAL_API_KEY: 'secret' },
    { FLY_ACCESS_TOKEN: 'secret' },
    { rawEvents: [{ event: 'app_opened' }] },
    { shopDomain: 'private-shop.myshopify.com' },
    { providerUrl: 'https://api.posthog.com/query' },
  ])('rejects unsafe provider details', (unsafe) => {
    expect(() => MarketplaceVisibilityEvidenceSchema.parse({
      product: 'marketplace_visibility',
      profile: 'merchgrid_shopify_app_store',
      subjectRef: 'merchgrid:visibility:2026-08-22',
      artifactRef: 'artifacts/daily-health/2026-08-22.json',
      evidenceLevel: 'sparse',
      recommendationType: 'visibility_hypothesis',
      marketplaceContext: {
        marketplace: 'shopify_app_store',
        productName: 'MerchGrid',
        currentSurfaceSummary: 'Shopify app listing',
      },
      measuredSignals: {},
      limitations: [],
      prohibitedClaims: [],
      ...unsafe,
    })).toThrow();
  });

  it('rejects provider URLs as artifact references', () => {
    expect(() => MarketplaceVisibilityEvidenceSchema.parse({
      product: 'marketplace_visibility',
      profile: 'etsy_listing',
      subjectRef: 'etsy:visibility:listing-123',
      artifactRef: 'https://etsy.com/listing/123',
      evidenceLevel: 'sparse',
      recommendationType: 'visibility_hypothesis',
      marketplaceContext: {
        marketplace: 'etsy',
        productName: 'Printable Planner',
        currentSurfaceSummary: 'Etsy listing for a printable planner',
      },
      measuredSignals: {},
      limitations: [],
      prohibitedClaims: [],
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run RED tests**

Run: `npm test -- src/tests/contracts/marketplace-visibility.test.ts`

Expected: FAIL because `src/contracts/marketplace-visibility.ts` does not exist.

- [ ] **Step 3: Implement strict marketplace visibility schemas**

```ts
import { z } from 'zod';

const UnsafeKeyPattern = /(token|secret|authorization|password|email|shopDomain|rawEvents|payload|providerUrl)/iu;

export const MarketplaceVisibilityProfileSchema = z.enum([
  'merchgrid_shopify_app_store',
  'etsy_listing',
]);

export const MarketplaceVisibilityContextSchema = z.object({
  marketplace: z.enum(['shopify_app_store', 'etsy']),
  productName: z.string().min(1).max(120),
  currentSurfaceSummary: z.string().min(1).max(1_000),
  targetAudience: z.string().min(1).max(300).optional(),
  knownDiscoverySurface: z.string().min(1).max(300).optional(),
}).strict();

export const MarketplaceVisibilityEvidenceSchema = z.object({
  product: z.literal('marketplace_visibility'),
  profile: MarketplaceVisibilityProfileSchema,
  subjectRef: z.string().min(1).max(200),
  artifactRef: z.string().min(1).max(500).refine((value) => !value.includes('://'), 'artifactRef must be local'),
  evidenceLevel: z.literal('sparse'),
  recommendationType: z.literal('visibility_hypothesis'),
  marketplaceContext: MarketplaceVisibilityContextSchema,
  measuredSignals: z.record(z.string().min(1), z.number().finite()),
  limitations: z.array(z.string().min(1).max(300)),
  prohibitedClaims: z.array(z.string().min(1).max(300)),
}).strict().superRefine((value, ctx) => {
  assertNoUnsafeKeys(value, ctx);
});

export type MarketplaceVisibilityEvidence = z.infer<typeof MarketplaceVisibilityEvidenceSchema>;
export type MarketplaceVisibilityProfile = z.infer<typeof MarketplaceVisibilityProfileSchema>;
export type MarketplaceVisibilityContext = z.infer<typeof MarketplaceVisibilityContextSchema>;

export function parseMarketplaceVisibilityEvidence(value: unknown): MarketplaceVisibilityEvidence {
  return MarketplaceVisibilityEvidenceSchema.parse(value);
}

function assertNoUnsafeKeys(value: unknown, ctx: z.RefinementCtx, path: (string | number)[] = []): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (UnsafeKeyPattern.test(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, key], message: `unsafe key: ${key}` });
    }
    assertNoUnsafeKeys(child, ctx, [...path, key]);
  }
}
```

Modify `src/contracts/workflow.ts`:

```ts
import { MarketplaceVisibilityEvidenceSchema } from './marketplace-visibility.js';

export const WorkflowKindSchema = z.enum([
  'etsy_listing',
  'merchgrid_daily',
  'merchgrid_weekly',
  'marketplace_visibility_review',
]);

export const WorkflowEvidenceSchema = z.union([
  EtsyWorkflowEvidenceSchema,
  MerchGridWorkflowEvidenceSchema,
  MarketplaceVisibilityEvidenceSchema,
]);
```

- [ ] **Step 4: Run GREEN tests and workflow contract regressions**

Run: `npm test -- src/tests/contracts/marketplace-visibility.test.ts src/tests/contracts/merchgrid-workflow.test.ts src/tests/workflow/engine.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```bash
git add src/contracts/marketplace-visibility.ts src/contracts/workflow.ts src/tests/contracts/marketplace-visibility.test.ts
git commit -m "feat: add marketplace visibility evidence contract"
```

## Task 2: Local Context Loader and Visibility Profiles

**Purpose:** Create product-specific adapters that build sparse visibility evidence from safe local context and existing artifacts.

**Why:** The recommendation should be grounded in a real product surface, not a generic marketing prompt. MerchGrid needs Shopify App Store context and safe collected signals; Etsy later needs listing context without Shopify/Fly assumptions.

**How:** Add a strict local JSON context loader and a profile service that builds `MarketplaceVisibilityEvidence` for MerchGrid and fixture-backed Etsy.

**Learning lenses:**
- **DDIA lens — anti-corruption layer:** Shopify App Store and Etsy terms are translated into one internal visibility evidence shape.
- **APOSD lens — deep module:** the profile hides context loading, artifact loading, and sparse signal extraction behind one small API.

**Files:**
- Create: `src/connectors/marketplace/local-context.ts`
- Create: `src/workflow/marketplace-visibility-profile.ts`
- Test: `src/tests/connectors/marketplace-local-context.test.ts`
- Test: `src/tests/workflow/marketplace-visibility-profile.test.ts`

**Interfaces:**
- Consumes: `JsonFileMerchGridReviewArtifactRepository`, `MarketplaceVisibilityContextSchema`, `MarketplaceVisibilityEvidenceSchema`.
- Produces: `loadMarketplaceVisibilityContext(path): Promise<MarketplaceVisibilityContext>`, `createMarketplaceVisibilityService(deps): MarketplaceVisibilityService`, `startVisibilityReview(input): Promise<WorkflowRunState>`.

- [ ] **Step 1: Write failing local-context tests**

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMarketplaceVisibilityContext } from '../../connectors/marketplace/local-context.js';

describe('marketplace visibility local context loader', () => {
  it('loads a strict local context JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'visibility-context-'));
    const file = join(dir, 'merchgrid.json');
    await writeFile(file, JSON.stringify({
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
      currentSurfaceSummary: 'Shopify app listing for catalog audits',
      targetAudience: 'Shopify merchants',
      knownDiscoverySurface: 'Shopify App Store',
    }), 'utf8');

    await expect(loadMarketplaceVisibilityContext(file)).resolves.toMatchObject({
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
    });
  });

  it('rejects non-local references and unsafe keys', async () => {
    await expect(loadMarketplaceVisibilityContext('https://example.com/context.json')).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});
```

- [ ] **Step 2: Run RED local-context tests**

Run: `npm test -- src/tests/connectors/marketplace-local-context.test.ts`

Expected: FAIL because the loader file does not exist.

- [ ] **Step 3: Implement local context loader**

```ts
import { readFile } from 'node:fs/promises';
import { MarketplaceVisibilityContextSchema } from '../../contracts/marketplace-visibility.js';
import { AppError } from '../../core/errors.js';

export async function loadMarketplaceVisibilityContext(path: string) {
  if (!path || path.includes('://')) {
    throw new AppError('validation_failed', 'Marketplace visibility context path must be a local file');
  }
  try {
    return MarketplaceVisibilityContextSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('validation_failed', 'Marketplace visibility context could not be loaded', { cause: error });
  }
}
```

- [ ] **Step 4: Write failing profile tests**

```ts
import { describe, expect, it } from 'vitest';
import type { MerchGridReviewArtifactRepository } from '../../jobs/merchgrid-source-pack.js';
import { MerchGridReviewEvidenceSchema } from '../../metrics/evidence.js';
import { createMarketplaceVisibilityService } from '../../workflow/marketplace-visibility-profile.js';

describe('marketplace visibility profile', () => {
  it('starts a MerchGrid visibility review from sparse daily evidence', async () => {
    const service = createService({
      dailyArtifact: dailyArtifact(),
      context: {
        marketplace: 'shopify_app_store',
        productName: 'MerchGrid',
        currentSurfaceSummary: 'Shopify app listing for catalog audits',
        targetAudience: 'Shopify merchants',
        knownDiscoverySurface: 'Shopify App Store',
      },
    });

    const state = await service.startVisibilityReview({
      profile: 'merchgrid_shopify_app_store',
      runId: 'merchgrid-visibility-2026-08-22',
      date: '2026-08-22',
      contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
    });

    expect(state).toMatchObject({
      workflowKind: 'marketplace_visibility_review',
      subjectRef: 'marketplace_visibility:merchgrid_shopify_app_store:2026-08-22',
      evidenceSnapshots: {
        initial: {
          product: 'marketplace_visibility',
          profile: 'merchgrid_shopify_app_store',
          evidenceLevel: 'sparse',
        },
      },
    });
  });

  it('builds Etsy visibility evidence without Shopify or Fly fields', async () => {
    const service = createService({
      context: {
        marketplace: 'etsy',
        productName: 'Printable Weekly Planner',
        currentSurfaceSummary: 'Etsy listing with printable planner title and tags',
        targetAudience: 'Planner buyers',
        knownDiscoverySurface: 'Etsy search',
      },
    });

    const state = await service.startVisibilityReview({
      profile: 'etsy_listing',
      runId: 'etsy-visibility-listing-123',
      contextPath: 'artifacts/etsy/context/etsy-visibility-context.json',
    });

    expect(JSON.stringify(state.evidenceSnapshots?.initial)).not.toMatch(/fly_metrics|shopify_partner|posthog/i);
  });
});
```

- [ ] **Step 5: Run RED profile tests**

Run: `npm test -- src/tests/workflow/marketplace-visibility-profile.test.ts`

Expected: FAIL because `createMarketplaceVisibilityService` does not exist.

- [ ] **Step 6: Implement the profile facade**

```ts
export function createMarketplaceVisibilityService(deps: {
  engine: WorkflowEngine;
  merchgridArtifacts: MerchGridReviewArtifactRepository;
  loadContext: (path: string) => Promise<MarketplaceVisibilityContext>;
}): MarketplaceVisibilityService {
  return {
    async startVisibilityReview(input) {
      const context = await deps.loadContext(input.contextPath);
      const evidence = input.profile === 'merchgrid_shopify_app_store'
        ? await buildMerchGridVisibilityEvidence({ input, context, artifacts: deps.merchgridArtifacts })
        : buildEtsyVisibilityEvidence({ input, context });

      return deps.engine.startMarketplaceVisibility({
        runId: input.runId,
        subjectRef: evidence.subjectRef,
        initialEvidence: evidence,
      });
    },
    async supplyVisibilityResult(input) {
      throw new AppError('route_not_allowed', `Visibility result support for ${input.profile} is added in Task 6`);
    },
  };
}
```

`buildMerchGridVisibilityEvidence` loads the saved daily artifact, copies only numeric aggregate metrics from `posthog` and `fly_metrics`, keeps limitations, and adds prohibited claims:

```ts
[
  'Do not claim sparse evidence proves a marketplace visibility bottleneck',
  'Do not claim a visibility change will increase installs',
  'Do not recommend automatic marketplace edits',
]
```

`buildEtsyVisibilityEvidence` uses context only and returns empty `measuredSignals` with limitation `etsy runtime profile is fixture-backed in this slice`.

- [ ] **Step 7: Run focused profile tests**

Run: `npm test -- src/tests/connectors/marketplace-local-context.test.ts src/tests/workflow/marketplace-visibility-profile.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit profiles**

```bash
git add src/connectors/marketplace/local-context.ts src/workflow/marketplace-visibility-profile.ts src/tests/connectors/marketplace-local-context.test.ts src/tests/workflow/marketplace-visibility-profile.test.ts
git commit -m "feat: add marketplace visibility profiles"
```

## Task 3: Workflow Engine Entry and Persistence

**Purpose:** Let the existing engine persist and route marketplace visibility runs without creating another engine.

**Why:** The visibility review should use the same lifecycle, approval gate, run repository, traces, and result loop as other Buffr workflows.

**How:** Add a `startMarketplaceVisibility` engine entry point and update result-evidence parsing so marketplace visibility evidence can enter and re-enter the engine safely.

**Learning lenses:**
- **DDIA lens — immutable provenance:** the run records the exact sparse evidence and limitations used for the recommendation.
- **AIAIA lens — deterministic orchestration:** the engine owns route transitions; the model cannot skip approval.

**Files:**
- Modify: `src/workflow/engine.ts`
- Modify: `src/workflow/state.ts`
- Modify: `src/workflow/routes.ts`
- Modify: `src/workflow/guards.ts`
- Test: `src/tests/workflow/marketplace-visibility-engine.test.ts`
- Test: `src/tests/workflow/engine.test.ts`
- Test: `src/tests/storage/runs.test.ts`

**Interfaces:**
- Consumes: `MarketplaceVisibilityEvidence` from Task 1.
- Produces: `StartMarketplaceVisibilityInput`, `WorkflowEngine.startMarketplaceVisibility(input)`, and result parsing for marketplace visibility evidence.

- [ ] **Step 1: Write failing engine tests**

```ts
import { describe, expect, it } from 'vitest';
import { createWorkflowEngine } from '../../workflow/engine.js';
import { WorkflowRunStateSchema } from '../../contracts/workflow.js';

describe('marketplace visibility workflow engine entry', () => {
  it('starts a marketplace visibility run with sparse evidence', async () => {
    const repository = new InMemoryRunRepository();
    const engine = createWorkflowEngine({ repository, modules: moduleExecutor(), now: fixedNow });

    const state = await engine.startMarketplaceVisibility({
      runId: 'visibility-1',
      subjectRef: 'marketplace_visibility:merchgrid_shopify_app_store:2026-08-22',
      initialEvidence: visibilityEvidence(),
    });

    expect(state).toMatchObject({
      runId: 'visibility-1',
      workflowKind: 'marketplace_visibility_review',
      stage: 'm1_context',
      evidenceSnapshots: { initial: { product: 'marketplace_visibility', evidenceLevel: 'sparse' } },
    });
    expect(repository.created[0].evidenceRefs[0]).toContain('marketplace_visibility');
  });

  it('routes a completed M6 visibility plan to approval wait', async () => {
    const repository = new InMemoryRunRepository();
    const engine = createWorkflowEngine({ repository, modules: moduleExecutor(), now: fixedNow });
    await engine.startMarketplaceVisibility({
      runId: 'visibility-approval',
      subjectRef: 'marketplace_visibility:merchgrid_shopify_app_store:2026-08-22',
      initialEvidence: visibilityEvidence(),
    });

    for (let index = 0; index < 5; index += 1) await engine.step('visibility-approval');
    const state = await repository.load('visibility-approval');

    expect(state).toMatchObject({ stage: 'approval_wait', status: 'awaiting_approval' });
  });
});
```

- [ ] **Step 2: Run RED engine tests**

Run: `npm test -- src/tests/workflow/marketplace-visibility-engine.test.ts`

Expected: FAIL because `startMarketplaceVisibility` does not exist.

- [ ] **Step 3: Add engine input and start method**

In `src/workflow/engine.ts`:

```ts
export type StartMarketplaceVisibilityInput = {
  runId: string;
  subjectRef: string;
  initialEvidence: MarketplaceVisibilityEvidence;
};

export type WorkflowEngine = {
  start(input: StartWorkflowInput): Promise<WorkflowRunState>;
  startMerchGrid(input: StartMerchGridWorkflowInput): Promise<WorkflowRunState>;
  startMarketplaceVisibility(input: StartMarketplaceVisibilityInput): Promise<WorkflowRunState>;
  // existing methods stay unchanged
};
```

Implement:

```ts
async function startMarketplaceVisibility(input: StartMarketplaceVisibilityInput): Promise<WorkflowRunState> {
  assertNoCredentialKeys(input.initialEvidence);
  const evidence = parseWithSchema(
    MarketplaceVisibilityEvidenceSchema,
    input.initialEvidence,
    'initial marketplace visibility evidence',
  );
  const state = createInitialWorkflowState({
    runId: input.runId,
    subjectRef: input.subjectRef,
    workflowKind: 'marketplace_visibility_review',
    initialEvidenceRef: evidenceRef('initial', evidence),
    now: now(),
  });
  const stateWithEvidence = { ...state, evidenceSnapshots: { initial: evidence } };
  await deps.repository.create(stateWithEvidence);
  const created = await deps.repository.load(input.runId);
  for (const event of created.events) await deps.emit?.(event);
  return created;
}
```

Update `parseResultEvidence`:

```ts
if (state.workflowKind === 'marketplace_visibility_review') {
  return parseWithSchema(MarketplaceVisibilityEvidenceSchema, value, 'result marketplace visibility evidence');
}
```

Update `return { ... }` to include `startMarketplaceVisibility`.

- [ ] **Step 4: Ensure evidence refs are stable**

Modify `src/workflow/state.ts` so `evidenceRef('initial', evidence)` returns:

```ts
if (input.product === 'marketplace_visibility') {
  return `${kind}:marketplace_visibility:${input.profile}:${input.subjectRef}`;
}
```

Keep existing Etsy and MerchGrid references unchanged.

- [ ] **Step 5: Run focused engine and storage tests**

Run: `npm test -- src/tests/workflow/marketplace-visibility-engine.test.ts src/tests/workflow/engine.test.ts src/tests/storage/runs.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the workflow entry**

```bash
git add src/workflow/engine.ts src/workflow/state.ts src/workflow/routes.ts src/workflow/guards.ts src/tests/workflow/marketplace-visibility-engine.test.ts src/tests/workflow/engine.test.ts src/tests/storage/runs.test.ts
git commit -m "feat: add marketplace visibility workflow entry"
```

## Task 4: Marketplace Visibility Module Executor

**Purpose:** Reuse the existing M1-M6 lifecycle while giving the modules sparse-data visibility instructions.

**Why:** The workflow engine already knows how to coordinate M1-M6. The difference is the profile and prompts: this path produces exploratory visibility hypotheses, not metric-proven optimizations.

**How:** Add a module executor that makes M1 and M2 deterministic, then uses bounded structured agent calls for M4-M6 and M7.

**Learning lenses:**
- **AIAIA lens — bounded specialist modules:** agents interpret and propose, while deterministic code labels evidence quality and preserves approval gates.
- **APOSD lens — separating policy from mechanism:** M2 enforces the sparse-data label before an agent can reason from the evidence.

**Files:**
- Create: `src/agents/marketplace-visibility/modules.ts`
- Test: `src/tests/agents/marketplace-visibility.test.ts`

**Interfaces:**
- Consumes: `MarketplaceVisibilityEvidence`, `AgentRunner`, `ModuleExecutor`.
- Produces: `createMarketplaceVisibilityModuleExecutor(deps): ModuleExecutor`, `deterministicMarketplaceVisibilityContext(evidence): ContextOutput`, `metricsFromMarketplaceVisibilityEvidence(evidence): MetricsOutput`.

- [ ] **Step 1: Write failing module tests**

```ts
import { describe, expect, it } from 'vitest';
import { FakeAgentRunner } from '../../agents/runner.js';
import {
  createMarketplaceVisibilityModuleExecutor,
  deterministicMarketplaceVisibilityContext,
  metricsFromMarketplaceVisibilityEvidence,
} from '../../agents/marketplace-visibility/modules.js';

describe('marketplace visibility modules', () => {
  it('builds deterministic M1 context from sparse visibility evidence', () => {
    expect(deterministicMarketplaceVisibilityContext(visibilityEvidence())).toMatchObject({
      product: 'MerchGrid',
      positioning: expect.stringContaining('Shopify App Store'),
      missingInformation: ['low request volume'],
    });
  });

  it('labels M2 as limited sparse evidence without blocking M4', () => {
    expect(metricsFromMarketplaceVisibilityEvidence(visibilityEvidence())).toMatchObject({
      phase: 'initial',
      comparisonQuality: 'limited',
      metrics: [
        expect.objectContaining({
          name: 'visibility.evidence_level',
          current: 1,
          baseline: null,
          qualification: 'inconclusive',
          confidence: 'low',
        }),
      ],
      unresolvedQualificationNeeds: expect.arrayContaining(['measured marketplace traffic is sparse']),
    });
  });

  it('runs M4-M6 with visibility-specific structured outputs', async () => {
    const executor = createMarketplaceVisibilityModuleExecutor({
      agentRunner: new FakeAgentRunner({
        m4: {
          performancePath: 'discovery',
          primaryBottleneck: 'The listing may not communicate the first audit value quickly enough.',
          competingExplanation: 'The app may not yet have enough marketplace impressions.',
          confidence: 'low',
          decision: 'proceed_to_hypothesis',
          notes: ['Exploratory visibility review; evidence is sparse.'],
        },
        m5: {
          hypothesis: 'Clarifying the first-scan value proposition will improve app opens and scan starts.',
          primaryVariable: 'listing message',
          recommendedRevision: 'Lead screenshots and copy with the first audit outcome.',
          keepConstant: ['pricing', 'app functionality'],
          expectedSignal: 'App opens or scan starts increase after the manual listing update.',
          notes: ['Human approval required before changing the listing.'],
        },
        m6: {
          primaryMetric: 'posthog.app_opened_count',
          secondaryMetrics: ['posthog.scan_started_count'],
          baselineValue: 0,
          baselinePeriod: 'sparse baseline from initial visibility evidence',
          qualificationRequirements: ['Collect a later completed weekly review before evaluating.'],
          expectedSupportingSignal: 'App opens or scan starts increase.',
          expectedWeakeningSignal: 'App opens and scan starts stay flat.',
          inconclusiveCondition: 'Traffic remains too sparse to compare.',
          contextToMonitor: ['listing copy changed manually'],
          unresolvedMeasurementRules: [],
        },
      }),
    });

    const state = workflowState({ evidence: visibilityEvidence() });
    await expect(executor.runM4(state)).resolves.toMatchObject({ performancePath: 'discovery' });
    await expect(executor.runM5(state)).resolves.toMatchObject({ primaryVariable: 'listing message' });
    await expect(executor.runM6(state)).resolves.toMatchObject({ primaryMetric: 'posthog.app_opened_count' });
  });
});
```

- [ ] **Step 2: Run RED module tests**

Run: `npm test -- src/tests/agents/marketplace-visibility.test.ts`

Expected: FAIL because the module executor does not exist.

- [ ] **Step 3: Implement deterministic M1 and M2**

```ts
export function deterministicMarketplaceVisibilityContext(evidence: MarketplaceVisibilityEvidence): ContextOutput {
  return {
    product: evidence.marketplaceContext.productName,
    likelyCustomer: evidence.marketplaceContext.targetAudience,
    positioning: `${evidence.marketplaceContext.marketplace} visibility review: ${evidence.marketplaceContext.currentSurfaceSummary}`,
    availableEvidence: [
      `profile: ${evidence.profile}`,
      `evidence level: ${evidence.evidenceLevel}`,
      `artifact: ${evidence.artifactRef}`,
    ],
    missingInformation: evidence.limitations,
    notes: evidence.prohibitedClaims,
  };
}

export function metricsFromMarketplaceVisibilityEvidence(evidence: MarketplaceVisibilityEvidence): MetricsOutput {
  return {
    phase: 'initial',
    comparisonQuality: 'limited',
    metrics: [
      {
        name: 'visibility.evidence_level',
        current: 1,
        baseline: null,
        absoluteChange: null,
        percentageChange: null,
        qualification: 'inconclusive',
        confidence: 'low',
      },
      ...Object.entries(evidence.measuredSignals).sort(([left], [right]) => left.localeCompare(right)).map(([name, current]) => ({
        name,
        current,
        baseline: null,
        absoluteChange: null,
        percentageChange: null,
        qualification: 'inconclusive' as const,
        confidence: 'low' as const,
      })),
    ],
    unresolvedQualificationNeeds: [
      'measured marketplace traffic is sparse',
      ...evidence.limitations,
    ],
  };
}
```

- [ ] **Step 4: Implement visibility-specific agent wrappers**

Use `runStructuredModule` with the existing output schemas and prompt strings:

```ts
const VISIBILITY_DIAGNOSIS_PROMPT = [
  'M4 Marketplace Visibility Diagnosis.',
  'Use sparse evidence honestly. Identify one likely visibility bottleneck.',
  'Do not claim proof. Choose proceed_to_hypothesis only for a manual exploratory test.',
].join('\n');
```

Define equivalent prompt strings for M5 and M6. M6 must include:

```text
The output is a manual test plan. It must not claim the system will edit an external marketplace.
```

- [ ] **Step 5: Run focused module tests**

Run: `npm test -- src/tests/agents/marketplace-visibility.test.ts src/tests/agents/runner.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit module executor**

```bash
git add src/agents/marketplace-visibility/modules.ts src/tests/agents/marketplace-visibility.test.ts
git commit -m "feat: add marketplace visibility modules"
```

## Task 5: Marketplace Visibility CLI Commands

**Purpose:** Provide explicit local commands that turn sparse evidence into a workflow run and let the owner approve or reject it.

**Why:** The current source-pack commands create evidence; the user needs a deliberate command to consume that evidence for a visibility recommendation.

**How:** Add a CLI with `visibility-review`, `approve`, `reject`, and `record-result` commands. Add package scripts and README usage.

**Learning lenses:**
- **Head First Design Patterns lens — Command:** each CLI verb represents one intentional owner action.
- **AIAIA lens — human-controlled execution:** the CLI can record approval, but it cannot apply the marketplace change.

**Files:**
- Create: `src/cli/marketplace-visibility.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `.env.example`
- Test: `src/tests/cli/marketplace-visibility.test.ts`

**Interfaces:**
- Consumes: `MarketplaceVisibilityService`, `WorkflowEngine`, `MERCHGRID_METRICS_DATA_DIR`, `MERCHGRID_VISIBILITY_CONTEXT_PATH`, `OPENAI_API_KEY`.
- Produces scripts: `marketplace:visibility-review`, `marketplace:approve`, `marketplace:reject`, `marketplace:record-result`.

- [ ] **Step 1: Write failing CLI tests**

```ts
import { describe, expect, it } from 'vitest';
import { runMarketplaceVisibilityCli } from '../../cli/marketplace-visibility.js';

describe('marketplace visibility CLI', () => {
  it('prints only bounded run details for a visibility review', async () => {
    const lines: string[] = [];
    const state = {
      runId: 'visibility-1',
      status: 'awaiting_approval',
      stage: 'approval_wait',
      evidenceRefs: ['initial:marketplace_visibility:merchgrid_shopify_app_store:merchgrid:visibility:2026-08-22'],
    };

    await runMarketplaceVisibilityCli({
      args: [
        'visibility-review',
        '--profile', 'merchgrid_shopify_app_store',
        '--date', '2026-08-22',
        '--run-id', 'visibility-1',
        '--context', 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
      ],
      dependencies: {
        service: { startVisibilityReview: async () => state },
        engine: { step: async () => state },
      },
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      'run: visibility-1',
      'status: awaiting_approval',
      'stage: approval_wait',
      'artifact: initial:marketplace_visibility:merchgrid_shopify_app_store:merchgrid:visibility:2026-08-22',
    ]);
    expect(lines.join('\n')).not.toMatch(/OPENAI_API_KEY|POSTHOG_PERSONAL_API_KEY|FLY_ACCESS_TOKEN|myshopify/i);
  });

  it('accepts reject with a reason', async () => {
    const lines: string[] = [];
    await runMarketplaceVisibilityCli({
      args: ['reject', '--run-id', 'visibility-1', '--reason', 'Too broad'],
      dependencies: {
        service: {},
        engine: { rejectExperiment: async () => ({ runId: 'visibility-1', status: 'stopped', stage: 'approval_wait', evidenceRefs: [] }) },
      },
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toContain('status: stopped');
  });
});
```

- [ ] **Step 2: Run RED CLI tests**

Run: `npm test -- src/tests/cli/marketplace-visibility.test.ts`

Expected: FAIL because the CLI does not exist.

- [ ] **Step 3: Implement CLI command parser**

Create `runMarketplaceVisibilityCli` with exact options:

```text
visibility-review --profile PROFILE --run-id RUN_ID --context PATH [--date YYYY-MM-DD]
approve --run-id RUN_ID
reject --run-id RUN_ID --reason REASON
record-result --profile PROFILE --run-id RUN_ID [--through YYYY-MM-DD]
```

`--date` is required for `merchgrid_shopify_app_store` visibility reviews. It is not accepted for `etsy_listing`.

The command loops through engine stages:

```ts
while (['m1_context', 'm2_metrics_initial', 'm4_diagnosis', 'm5_hypothesis', 'm6_test_plan'].includes(state.stage)) {
  state = await input.dependencies.engine.step(runId);
}
```

Print only:

```text
run: RUN_ID
status: STATUS
stage: STAGE
artifact: LAST_EVIDENCE_REF
```

- [ ] **Step 4: Implement runtime dependencies**

`createMarketplaceVisibilityDependencies(env = loadLocalEnvironment())` builds:

```ts
const dataDir = required(env, 'MERCHGRID_METRICS_DATA_DIR');
const contextPath = env.MERCHGRID_VISIBILITY_CONTEXT_PATH;
const runs = new JsonFileRunRepository({ rootDir: join(dataDir, 'workflow-runs') });
const engine = createWorkflowEngine({
  repository: runs,
  modules: createMarketplaceVisibilityModuleExecutor({ agentRunner: new OpenAiAgentRunner() }),
});
```

Use `contextPath` only as a default when the CLI call omits `--context`. The CLI must prefer an explicit `--context` value.

- [ ] **Step 5: Add package scripts**

Modify `package.json`:

```json
{
  "scripts": {
    "marketplace:visibility-review": "node dist/cli/marketplace-visibility.js visibility-review",
    "marketplace:approve": "node dist/cli/marketplace-visibility.js approve",
    "marketplace:reject": "node dist/cli/marketplace-visibility.js reject",
    "marketplace:record-result": "node dist/cli/marketplace-visibility.js record-result"
  }
}
```

- [ ] **Step 6: Update `.env.example` and README**

Add to `.env.example`:

```text
# Marketplace visibility review: local product context used for sparse-data recommendations.
MERCHGRID_VISIBILITY_CONTEXT_PATH=artifacts/merchgrid/context/merchgrid-visibility-context.json
```

Add README commands:

```text
npm run marketplace:visibility-review -- --profile merchgrid_shopify_app_store --date YYYY-MM-DD --run-id RUN_ID --context artifacts/merchgrid/context/merchgrid-visibility-context.json
npm run marketplace:approve -- --run-id RUN_ID
npm run marketplace:reject -- --run-id RUN_ID --reason "Reason"
npm run marketplace:record-result -- --profile merchgrid_shopify_app_store --run-id RUN_ID --through YYYY-MM-DD
```

Add a sample local context JSON to README:

```json
{
  "marketplace": "shopify_app_store",
  "productName": "MerchGrid",
  "currentSurfaceSummary": "Shopify app listing for a catalog audit app that helps merchants find catalog quality issues.",
  "targetAudience": "Shopify merchants who want a fast catalog audit before fixing product data.",
  "knownDiscoverySurface": "Shopify App Store search, category browsing, listing screenshots, and app onboarding."
}
```

- [ ] **Step 7: Run CLI and docs checks**

Run: `npm test -- src/tests/cli/marketplace-visibility.test.ts && npm run typecheck && npm run build && git diff --check`

Expected: PASS.

- [ ] **Step 8: Commit CLI**

```bash
git add src/cli/marketplace-visibility.ts package.json README.md .env.example src/tests/cli/marketplace-visibility.test.ts
git commit -m "feat: add marketplace visibility commands"
```

## Task 6: Result Path and Full Safety Verification

**Purpose:** Complete the feedback loop and verify the path does not leak secrets or perform provider writes.

**Why:** A visibility recommendation is useful only if Buffr can later compare the approved test against later evidence and record learning.

**How:** Implement result support for MerchGrid using later weekly review evidence. Keep Etsy result support fixture-backed in tests until Etsy runtime collection is ready.

**Learning lenses:**
- **DDIA lens — derived-data comparison:** the result path compares a later frozen evidence artifact against the baseline recorded in M6.
- **AIAIA lens — controlled feedback loop:** Buffr learns from approved manual experiments but does not apply changes automatically.

**Files:**
- Modify: `src/workflow/marketplace-visibility-profile.ts`
- Modify: `src/agents/marketplace-visibility/modules.ts`
- Test: `src/tests/workflow/marketplace-visibility-profile.test.ts`
- Test: `src/tests/workflow/marketplace-visibility-engine.test.ts`
- Test: `src/tests/cli/marketplace-visibility.test.ts`

**Interfaces:**
- Consumes: later MerchGrid weekly review artifacts through `MerchGridReviewArtifactRepository`.
- Produces: `supplyVisibilityResult(input)` for `merchgrid_shopify_app_store`, plus `metricsFromMarketplaceVisibilityResult(state, evidence): MetricsOutput`.

- [ ] **Step 1: Write failing result tests**

```ts
it('records a later MerchGrid weekly artifact as visibility result evidence', async () => {
  const service = createService({
    dailyArtifact: sparseDailyArtifact(),
    weeklyArtifacts: {
      '2026-09-04': weeklyArtifact({ app_opened_count: 4, scan_started_count: 1 }),
    },
  });

  await service.startVisibilityReview({
    profile: 'merchgrid_shopify_app_store',
    runId: 'visibility-result',
    date: '2026-08-22',
    contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
  });
  for (let index = 0; index < 5; index += 1) await service.engine.step('visibility-result');
  await service.engine.approveExperiment('visibility-result');

  const result = await service.supplyVisibilityResult({
    runId: 'visibility-result',
    profile: 'merchgrid_shopify_app_store',
    through: '2026-09-04',
  });

  expect(result).toMatchObject({
    stage: 'm2_metrics_results',
    evidenceSnapshots: { result: { product: 'marketplace_visibility', evidenceLevel: 'sparse' } },
  });
});

it('waits when visibility result evidence has no later measured signals', async () => {
  const result = await service.supplyVisibilityResult({
    runId: 'visibility-wait',
    profile: 'merchgrid_shopify_app_store',
    through: '2026-09-04',
  });
  expect(result).toMatchObject({ stage: 'experiment_wait', status: 'waiting_for_data' });
});
```

- [ ] **Step 2: Run RED result tests**

Run: `npm test -- src/tests/workflow/marketplace-visibility-profile.test.ts src/tests/workflow/marketplace-visibility-engine.test.ts`

Expected: FAIL because `supplyVisibilityResult` still rejects result support.

- [ ] **Step 3: Implement result evidence builder**

For `merchgrid_shopify_app_store`, load the later weekly review artifact using `through`, convert safe aggregate values into `measuredSignals`, and preserve limitations:

```ts
const evidence = MarketplaceVisibilityEvidenceSchema.parse({
  product: 'marketplace_visibility',
  profile: 'merchgrid_shopify_app_store',
  subjectRef: `marketplace_visibility:merchgrid_shopify_app_store:${through}`,
  artifactRef: `artifacts/merchgrid/metrics/artifacts/weekly-reviews/${through}.json`,
  evidenceLevel: 'sparse',
  recommendationType: 'visibility_hypothesis',
  marketplaceContext: initial.marketplaceContext,
  measuredSignals: weeklySignals,
  limitations: weeklyArtifact.limitations,
  prohibitedClaims: initial.prohibitedClaims,
});
```

If `weeklySignals` is empty, call:

```ts
return deps.engine.waitForMoreData({
  runId: input.runId,
  reason: 'visibility result evidence has no measured signals',
});
```

- [ ] **Step 4: Implement M2 result metrics**

Add:

```ts
export function metricsFromMarketplaceVisibilityResult(
  state: WorkflowRunState,
  evidence: MarketplaceVisibilityEvidence,
): MetricsOutput {
  const plan = state.moduleOutputs.m6;
  if (!plan) return missingVisibilityResult('visibility result requires an approved M6 plan');

  const current = evidence.measuredSignals[plan.primaryMetric];
  if (current === undefined) return missingVisibilityResult(`visibility result does not contain ${plan.primaryMetric}`);

  return {
    phase: 'post_experiment',
    metrics: [{
      name: plan.primaryMetric,
      baseline: plan.baselineValue,
      current,
      absoluteChange: current - plan.baselineValue,
      percentageChange: plan.baselineValue === 0 ? null : (current - plan.baselineValue) / plan.baselineValue,
      qualification: current === plan.baselineValue ? 'stable' : current > plan.baselineValue ? 'improved' : 'declined',
      confidence: 'low',
    }],
    comparisonQuality: 'limited',
    unresolvedQualificationNeeds: ['visibility result remains sparse and exploratory'],
  };
}
```

Wire `createMarketplaceVisibilityModuleExecutor().runM2Results` to use this function when result evidence product is `marketplace_visibility`.

- [ ] **Step 5: Run result and E2E tests**

Run: `npm test -- src/tests/workflow/marketplace-visibility-profile.test.ts src/tests/workflow/marketplace-visibility-engine.test.ts src/tests/cli/marketplace-visibility.test.ts`

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: PASS.

- [ ] **Step 7: Run privacy scan**

Run:

```bash
rg -n "POSTHOG_PERSONAL_API_KEY|FLY_ACCESS_TOKEN|OPENAI_API_KEY|shopDomain|rawEvents|providerUrl|myshopify" src/contracts src/workflow src/agents/marketplace-visibility src/cli/marketplace-visibility.ts src/storage
```

Expected: only deliberate test strings or schema rejection examples appear. No runtime code persists or prints secret values.

- [ ] **Step 8: Commit result path**

```bash
git add src/workflow/marketplace-visibility-profile.ts src/agents/marketplace-visibility/modules.ts src/tests/workflow/marketplace-visibility-profile.test.ts src/tests/workflow/marketplace-visibility-engine.test.ts src/tests/cli/marketplace-visibility.test.ts
git commit -m "feat: support marketplace visibility results"
```

## End-to-End Manual Dry Run After Implementation

After all tasks are implemented and built, use this local sequence:

```bash
npm run build
npm run merchgrid:collect -- --date 2026-08-22
npm run marketplace:visibility-review -- --profile merchgrid_shopify_app_store --date 2026-08-22 --run-id merchgrid-visibility-2026-08-22 --context artifacts/merchgrid/context/merchgrid-visibility-context.json
npm run marketplace:approve -- --run-id merchgrid-visibility-2026-08-22
```

Expected first review output:

```text
run: merchgrid-visibility-2026-08-22
status: awaiting_approval
stage: approval_wait
artifact: initial:marketplace_visibility:merchgrid_shopify_app_store:marketplace_visibility:merchgrid_shopify_app_store:2026-08-22
```

Expected local files:

```text
artifacts/merchgrid/metrics/workflow-runs/merchgrid-visibility-2026-08-22/run.json
artifacts/merchgrid/metrics/workflow-runs/merchgrid-visibility-2026-08-22/evidence/initial.json
artifacts/merchgrid/metrics/workflow-runs/merchgrid-visibility-2026-08-22/experiment-plan.json
artifacts/merchgrid/metrics/workflow-runs/merchgrid-visibility-2026-08-22/events.jsonl
```

No command in this dry run edits Shopify, Etsy, MerchGrid, PostHog, Fly, or any marketplace.

## Acceptance Checklist

| Requirement | Covered by |
| --- | --- |
| Generic marketplace visibility review, not MerchGrid-only | Tasks 1-2 |
| Scarce data labeled as sparse | Tasks 1 and 4 |
| MerchGrid starts from daily `collect_more_data` style evidence | Task 2 |
| Etsy compatibility proof | Task 2 |
| Existing engine reused | Task 3 |
| M1-M6 visibility hypothesis and test plan | Task 4 |
| Human approval required | Tasks 3 and 5 |
| Later evidence loop | Task 6 |
| No external provider writes | Tasks 5-6 |
| No credentials or raw provider data persisted | Tasks 1, 5, and 6 |

## Final Self-Review

This plan implements the approved spec as a new scarce-data workflow path. It does not alter the source collection queries, does not weaken the weekly metric-backed recommendation gate, and does not add autonomous marketplace writes. The first runnable slice is MerchGrid visibility from local context plus saved aggregate evidence; Etsy is protected by contract and fixture tests so the shared shape is not Shopify-only.
