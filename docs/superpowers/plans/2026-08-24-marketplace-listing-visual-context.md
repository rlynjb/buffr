# Marketplace Listing Visual Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add public marketplace listing context as a validated qualitative input to Buffr's marketplace visibility review so sparse-data runs can reason about listing copy, visuals, trust signals, and first-action friction.

**Architecture:** Keep the existing marketplace visibility workflow and work engine. Add a strict `MarketplaceListingContext` contract and local loader, thread it into `MarketplaceVisibilityEvidence`, expose it through the visibility CLI as `--listing-context`, and make M4-M6 treat listing observations as exploratory evidence rather than proof.

**Tech Stack:** TypeScript, Zod contracts, Vitest, existing JSON-file workflow storage, existing marketplace visibility CLI, existing OpenAI-backed module executor.

**Spec:** `docs/superpowers/specs/2026-08-24-marketplace-listing-visual-context-design.md`

## Global Constraints

- Public listing URL must be explicit owner-provided `https`.
- Listing context must not include cookies, auth headers, storefront session data, private Partner Dashboard pages, private merchant data, raw HTML dumps, credentials, or marketplace edit actions.
- Screenshots are optional and must not be committed by default.
- M4 may use listing context to identify hypotheses, not proven bottlenecks.
- M5/M6 must keep recommendations manual, exploratory, low-confidence, and human-approved.
- Existing `--context` remains the product visibility brief; new `--listing-context` is additive.
- Future Etsy and Meta profiles must use the same `MarketplaceListingContext` seam rather than Shopify-specific workflow code.

---

## File Structure Map

```text
src/contracts/marketplace-visibility.ts
  Existing visibility context/evidence contract.
  Add MarketplaceListingContextSchema and attach optional listingContext to MarketplaceVisibilityEvidence.

src/connectors/marketplace/local-context.ts
  Existing product visibility context loader.
  Add loadMarketplaceListingContext() beside the existing loader.

src/workflow/marketplace-visibility-profile.ts
  Existing evidence builder for MerchGrid and Etsy visibility profiles.
  Accept optional listing context loader/path, validate profile alignment, and include listing context in evidence.

src/cli/marketplace-visibility.ts
  Existing visibility-review CLI.
  Add --listing-context and MERCHGRID_LISTING_CONTEXT_PATH support without changing existing commands.

src/agents/marketplace-visibility/modules.ts
  Existing M1-M7 module executor.
  Surface listing context to M1 and strengthen M4-M6 normalization notes.

docs/examples/merchgrid-listing-context.example.json
  Safe tracked example with public Shopify App Store listing observations.

README.md
  Document the optional listing-context file and command flag.

tests/contracts/marketplace-visibility.test.ts
tests/connectors/marketplace-local-context.test.ts
tests/workflow/marketplace-visibility-profile.test.ts
tests/cli/marketplace-visibility.test.ts
tests/agents/marketplace-visibility-modules.test.ts
  Focused TDD coverage for contract, loader, evidence threading, CLI forwarding, and module behavior.
```

Keep the reusable aggregate visibility contract in `src/contracts/marketplace-visibility.ts`. Do not create a Shopify-specific workflow module. Shopify-specific values belong in local context examples or in the MerchGrid profile branch inside `marketplace-visibility-profile.ts`.

---

## Spec Coverage Map

- Local listing-context contract: Task 1.
- Public listing URL field and captured-at provenance: Task 1 and Task 2.
- Browser-assisted/manual visual review workflow: Task 2 example plus Task 5 docs.
- Optional screenshot/gallery metadata: Task 1 contract, Task 2 example.
- M4 qualitative-not-proof behavior: Task 4 prompts and deterministic context.
- M5/M6 manual exploratory listing test behavior: Task 4 prompts and Task 5 end-to-end run.
- CLI and local run path: Task 3 and Task 5.
- Future Etsy/Meta seam: Task 1 profile-aware contract and Task 3 profile alignment.

No spec requirement is intentionally left outside this plan.

---

### Task 1: Listing Context Contract

**Purpose:** Give Buffr a strict schema for qualitative public listing observations before any workflow code consumes them.

**Why:** Without a contract, listing notes become loose prompt text. That makes it easy to mix raw page data, private dashboard details, or unsupported claims into M4.

**How:** Add `MarketplaceListingContextSchema`, `MarketplaceListingContext`, and optional `listingContext` on `MarketplaceVisibilityEvidenceSchema`.

> **DDIA concept — schema-on-write:** Validate the listing context when it enters Buffr, not when an agent happens to read it. The stored run then has a trustworthy, typed interpretation of the page observation.

**Files:**

- Modify: `src/contracts/marketplace-visibility.ts`
- Test: `src/tests/contracts/marketplace-visibility.test.ts`

**Interfaces:**

- Consumes: existing `MarketplaceVisibilityProfileSchema`, `MarketplaceVisibilityContextSchema`, `MarketplaceVisibilityEvidenceSchema`.
- Produces:
  - `MarketplaceListingContextSchema`
  - `MarketplaceListingContext`
  - `MarketplaceListingCaptureModeSchema`
  - optional `MarketplaceVisibilityEvidence.listingContext?: MarketplaceListingContext`

- [ ] **Step 1: Write the failing contract tests**

Append these tests inside `describe('marketplace visibility evidence contract', () => { ... })` in `src/tests/contracts/marketplace-visibility.test.ts`.

```ts
  const merchGridListingContext = (overrides: Record<string, unknown> = {}) => ({
    marketplace: 'shopify_app_store' as const,
    profile: 'merchgrid_shopify_app_store' as const,
    productName: 'MerchGrid',
    sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
    capturedAt: '2026-08-24T12:00:00.000Z',
    captureMode: 'manual_visual_review' as const,
    publicSurface: {
      title: 'MerchGrid Catalog Audit',
      headline: 'Scans your product catalog and shows exactly which items are priced below cost',
      category: 'Analytics',
      pricingLabel: 'Free',
      ratingSummary: '0 reviews',
      reviewCount: 0,
      launchDate: 'August 7, 2026',
    },
    gallery: {
      imageCount: 4,
      observedImageLabels: ['main image', 'onboarding image', 'progress image', 'result image'],
      visualNotes: ['screenshots show audit flow and result surface'],
    },
    trustSignals: {
      positive: ['free pricing', 'privacy policy visible'],
      friction: ['no reviews yet', 'data access disclosure may need safety copy'],
    },
    copyNotes: {
      clearClaims: ['detect below cost pricing', 'find duplicate and missing skus'],
      unclearClaims: ['read only safety is not prominent'],
      missingContext: ['first scan outcome could be clearer'],
    },
    visibilityRubricNotes: {
      promiseClarity: 'pricing issue promise is concrete',
      audienceSpecificity: 'merchant role is implied but not explicit',
      problemActionFit: 'catalog audit connects to first scan',
      discoveryFit: 'analytics category may require clearer catalog audit keywords',
      trustAndRiskReduction: 'read only safety should be easier to see',
      assetClarity: 'gallery shows screens but outcome hierarchy may need review',
    },
    limitations: ['manual public page review only'],
    ...overrides,
  });

  it('accepts public marketplace listing context', () => {
    expect(MarketplaceListingContextSchema.parse(merchGridListingContext())).toMatchObject({
      marketplace: 'shopify_app_store',
      sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
      gallery: { imageCount: 4 },
    });
  });

  it('allows marketplace visibility evidence to reference listing context', () => {
    expect(parseMarketplaceVisibilityEvidence({
      ...sparseEvidence(),
      artifactRef: 'artifacts/merchgrid/metrics/artifacts/daily-health/2026-08-22.json',
      listingContext: merchGridListingContext(),
    })).toMatchObject({
      listingContext: {
        sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
        trustSignals: { friction: ['no reviews yet', 'data access disclosure may need safety copy'] },
      },
    });
  });

  it.each([
    { sourceUrl: 'http://apps.shopify.com/merchgrid-catalog-audit' },
    { sourceUrl: 'https://partners.shopify.com/123/apps/456' },
    { sourceUrl: 'file:///tmp/listing.html' },
    { rawHtml: '<html>listing</html>' },
    { cookies: 'sid=secret' },
    { trustSignals: { positive: ['free pricing'], friction: ['customer email jane@example.com'] } },
  ])('rejects unsafe listing context values %#', (unsafe) => {
    expect(() => MarketplaceListingContextSchema.parse({
      ...merchGridListingContext(),
      ...unsafe,
    })).toThrow();
  });
```

Also update the import at the top:

```ts
import {
  MarketplaceListingContextSchema,
  MarketplaceVisibilityContextSchema,
  MarketplaceVisibilityEvidenceSchema,
  parseMarketplaceVisibilityEvidence,
} from '../../contracts/marketplace-visibility.js';
```

- [ ] **Step 2: Run the focused contract test and verify RED**

Run:

```bash
npm test -- marketplace-visibility.test.ts
```

Expected: FAIL because `MarketplaceListingContextSchema` is not exported and `listingContext` is not accepted on evidence.

- [ ] **Step 3: Add the minimal contract implementation**

In `src/contracts/marketplace-visibility.ts`, add helper schemas near the existing safe-text helpers:

```ts
const PublicMarketplaceUrlSchema = z.string()
  .url()
  .startsWith('https://')
  .refine((value) => !value.includes('partners.shopify.com'), 'must not reference private Partner Dashboard pages')
  .refine((value) => !value.includes('admin.shopify.com'), 'must not reference private admin pages')
  .refine((value) => !UncuratedDataPattern.test(value), 'must not include private or source data markers');

export const MarketplaceListingCaptureModeSchema = z.enum([
  'manual_visual_review',
  'browser_assisted_public_page',
]);

const ListingPublicSurfaceSchema = z.object({
  title: safeMarketplaceText(160).optional(),
  subtitle: safeMarketplaceText(240).optional(),
  headline: safeMarketplaceText(300).optional(),
  shortDescription: safeMarketplaceText(500).optional(),
  category: safeMarketplaceText(120).optional(),
  pricingLabel: safeMarketplaceText(80).optional(),
  ratingSummary: safeMarketplaceText(120).optional(),
  reviewCount: z.number().int().min(0).max(1_000_000).optional(),
  launchDate: safeMarketplaceText(80).optional(),
}).strict();

const ListingGallerySchema = z.object({
  imageCount: z.number().int().min(0).max(50),
  observedImageLabels: z.array(safeMarketplaceText(120)).max(20),
  visualNotes: z.array(safeMarketplaceText(500)).max(20),
}).strict();

const ListingTrustSignalsSchema = z.object({
  positive: z.array(safeMarketplaceText(200)).max(20),
  friction: z.array(safeMarketplaceText(200)).max(20),
}).strict();

const ListingCopyNotesSchema = z.object({
  clearClaims: z.array(safeMarketplaceText(240)).max(20),
  unclearClaims: z.array(safeMarketplaceText(240)).max(20),
  missingContext: z.array(safeMarketplaceText(240)).max(20),
}).strict();

const ListingVisibilityRubricNotesSchema = z.object({
  promiseClarity: safeMarketplaceText(500),
  audienceSpecificity: safeMarketplaceText(500),
  problemActionFit: safeMarketplaceText(500),
  discoveryFit: safeMarketplaceText(500),
  trustAndRiskReduction: safeMarketplaceText(500),
  assetClarity: safeMarketplaceText(500),
}).strict();
```

Then export the listing context schema before `MarketplaceVisibilityEvidenceSchema`:

```ts
export const MarketplaceListingContextSchema = z.object({
  marketplace: z.enum(['shopify_app_store', 'etsy', 'meta_marketplace']),
  profile: MarketplaceVisibilityProfileSchema,
  productName: safeMarketplaceText(120),
  sourceUrl: PublicMarketplaceUrlSchema,
  capturedAt: z.string().datetime({ offset: true }),
  captureMode: MarketplaceListingCaptureModeSchema,
  publicSurface: ListingPublicSurfaceSchema,
  gallery: ListingGallerySchema,
  trustSignals: ListingTrustSignalsSchema,
  copyNotes: ListingCopyNotesSchema,
  visibilityRubricNotes: ListingVisibilityRubricNotesSchema,
  limitations: z.array(safeMarketplaceText(300)).max(20),
}).strict().superRefine((value, ctx) => {
  if (value.profile === 'merchgrid_shopify_app_store' && value.marketplace !== 'shopify_app_store') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['marketplace'], message: 'marketplace must match profile' });
  }
  if (value.profile === 'etsy_listing' && value.marketplace !== 'etsy') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['marketplace'], message: 'marketplace must match profile' });
  }
});
```

Add `listingContext` to `MarketplaceVisibilityEvidenceSchema`:

```ts
  listingContext: MarketplaceListingContextSchema.optional(),
```

Add the profile alignment check inside the existing evidence `superRefine`:

```ts
  if (value.listingContext && value.listingContext.profile !== value.profile) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['listingContext', 'profile'],
      message: 'listingContext profile must match evidence profile',
    });
  }
```

Export the types:

```ts
export type MarketplaceListingContext = z.infer<typeof MarketplaceListingContextSchema>;
export type MarketplaceListingCaptureMode = z.infer<typeof MarketplaceListingCaptureModeSchema>;
```

- [ ] **Step 4: Run focused contract test and verify GREEN**

Run:

```bash
npm test -- marketplace-visibility.test.ts
```

Expected: PASS for the marketplace visibility contract tests.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/marketplace-visibility.ts src/tests/contracts/marketplace-visibility.test.ts
git commit -m "feat: add marketplace listing context contract"
```

---

### Task 2: Local Listing Context Loader and Example

**Purpose:** Let Buffr read public listing observations from a local JSON file, just like it already reads the product visibility brief.

**Why:** This keeps the first slice simple and owner-curated. Buffr should not become a scraper before the contract proves useful.

**How:** Add `loadMarketplaceListingContext(path)` beside `loadMarketplaceVisibilityContext(path)` and create a safe tracked example for MerchGrid.

> **DDIA concept — provenance and batch input:** The listing context is a small batch input. The loader records a typed snapshot of what was observed at a capture time rather than live-querying a marketplace inside M4.

**Files:**

- Modify: `src/connectors/marketplace/local-context.ts`
- Modify: `src/tests/connectors/marketplace-local-context.test.ts`
- Create: `docs/examples/merchgrid-listing-context.example.json`

**Interfaces:**

- Consumes: `MarketplaceListingContextSchema`.
- Produces: `loadMarketplaceListingContext(path: string): Promise<MarketplaceListingContext>`.

- [ ] **Step 1: Write the failing loader tests**

Append these tests in `src/tests/connectors/marketplace-local-context.test.ts`.

```ts
  it('loads a local marketplace listing context file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'listing-context-'));
    const file = join(dir, 'merchgrid-listing-context.json');
    await writeFile(file, JSON.stringify({
      marketplace: 'shopify_app_store',
      profile: 'merchgrid_shopify_app_store',
      productName: 'MerchGrid',
      sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
      capturedAt: '2026-08-24T12:00:00.000Z',
      captureMode: 'manual_visual_review',
      publicSurface: {
        title: 'MerchGrid Catalog Audit',
        headline: 'Scans your product catalog and shows exactly which items are priced below cost',
        category: 'Analytics',
        pricingLabel: 'Free',
        ratingSummary: '0 reviews',
        reviewCount: 0,
        launchDate: 'August 7, 2026',
      },
      gallery: {
        imageCount: 4,
        observedImageLabels: ['main image', 'onboarding image', 'progress image', 'result image'],
        visualNotes: ['screenshots show audit flow and result surface'],
      },
      trustSignals: {
        positive: ['free pricing', 'privacy policy visible'],
        friction: ['no reviews yet', 'data access disclosure may need safety copy'],
      },
      copyNotes: {
        clearClaims: ['detect below cost pricing'],
        unclearClaims: ['read only safety is not prominent'],
        missingContext: ['first scan outcome could be clearer'],
      },
      visibilityRubricNotes: {
        promiseClarity: 'pricing issue promise is concrete',
        audienceSpecificity: 'merchant role is implied but not explicit',
        problemActionFit: 'catalog audit connects to first scan',
        discoveryFit: 'analytics category may require clearer catalog audit keywords',
        trustAndRiskReduction: 'read only safety should be easier to see',
        assetClarity: 'gallery shows screens but outcome hierarchy may need review',
      },
      limitations: ['manual public page review only'],
    }));

    await expect(loadMarketplaceListingContext(file)).resolves.toMatchObject({
      sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
      gallery: { imageCount: 4 },
    });
  });

  it('rejects remote listing context paths', async () => {
    await expect(loadMarketplaceListingContext('https://example.com/context.json')).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Marketplace listing context path must be a local file',
    });
  });
```

Update the import:

```ts
import {
  loadMarketplaceListingContext,
  loadMarketplaceVisibilityContext,
} from '../../connectors/marketplace/local-context.js';
```

- [ ] **Step 2: Run focused loader test and verify RED**

Run:

```bash
npm test -- marketplace-local-context.test.ts
```

Expected: FAIL because `loadMarketplaceListingContext` is not exported.

- [ ] **Step 3: Implement the loader**

Modify `src/connectors/marketplace/local-context.ts`:

```ts
import {
  MarketplaceListingContextSchema,
  MarketplaceVisibilityContextSchema,
} from '../../contracts/marketplace-visibility.js';
```

Add this function below `loadMarketplaceVisibilityContext`:

```ts
/** Loads a strictly validated marketplace listing context from a local JSON file. */
export async function loadMarketplaceListingContext(path: string) {
  if (!path || path.includes('://')) {
    throw new AppError('validation_failed', 'Marketplace listing context path must be a local file');
  }
  try {
    return MarketplaceListingContextSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('validation_failed', 'Marketplace listing context could not be loaded', { cause: error });
  }
}
```

- [ ] **Step 4: Add the safe MerchGrid example file**

Create `docs/examples/merchgrid-listing-context.example.json`:

```json
{
  "marketplace": "shopify_app_store",
  "profile": "merchgrid_shopify_app_store",
  "productName": "MerchGrid",
  "sourceUrl": "https://apps.shopify.com/merchgrid-catalog-audit",
  "capturedAt": "2026-08-24T12:00:00.000Z",
  "captureMode": "manual_visual_review",
  "publicSurface": {
    "title": "MerchGrid Catalog Audit",
    "headline": "Scans your product catalog and shows exactly which items are priced below cost",
    "category": "Analytics",
    "pricingLabel": "Free",
    "ratingSummary": "0 reviews",
    "reviewCount": 0,
    "launchDate": "August 7, 2026"
  },
  "gallery": {
    "imageCount": 4,
    "observedImageLabels": [
      "main image",
      "onboarding image",
      "progress image",
      "result image"
    ],
    "visualNotes": [
      "screenshots show audit flow and result surface"
    ]
  },
  "trustSignals": {
    "positive": [
      "free pricing",
      "privacy policy visible",
      "support provider visible"
    ],
    "friction": [
      "no reviews yet",
      "read only safety is not prominent near data access context"
    ]
  },
  "copyNotes": {
    "clearClaims": [
      "detect below cost pricing",
      "catch compare at price issues",
      "find duplicate and missing skus"
    ],
    "unclearClaims": [
      "buyer trust outcome could be sharper",
      "first scan action could be more explicit"
    ],
    "missingContext": [
      "what happens after opening the app",
      "why read only access is safe"
    ]
  },
  "visibilityRubricNotes": {
    "promiseClarity": "pricing issue promise is concrete",
    "audienceSpecificity": "merchant role is implied but not explicit",
    "problemActionFit": "catalog audit connects to first scan",
    "discoveryFit": "analytics category may require clearer catalog audit keywords",
    "trustAndRiskReduction": "read only safety should be easier to see",
    "assetClarity": "gallery shows screens but outcome hierarchy may need review"
  },
  "limitations": [
    "manual public page review only",
    "listing may change after capturedAt"
  ]
}
```

- [ ] **Step 5: Run loader and contract tests**

Run:

```bash
npm test -- marketplace-local-context.test.ts marketplace-visibility.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/marketplace/local-context.ts src/tests/connectors/marketplace-local-context.test.ts docs/examples/merchgrid-listing-context.example.json
git commit -m "feat: load marketplace listing context"
```

---

### Task 3: Evidence Builder and CLI Flag

**Purpose:** Thread listing context from the command line into the initial marketplace visibility evidence.

**Why:** The work engine should receive one coherent evidence object containing sparse metrics, product brief, and optional listing context.

**How:** Add optional `listingContextPath` to the service and CLI. If present, load the listing context, require profile alignment, and persist it on `MarketplaceVisibilityEvidence`.

> **DDIA concept — anti-corruption layer:** Shopify listing fields do not flow directly into the workflow. They are translated into `MarketplaceListingContext`, then attached to normalized evidence.

**Files:**

- Modify: `src/workflow/marketplace-visibility-profile.ts`
- Modify: `src/cli/marketplace-visibility.ts`
- Modify: `src/tests/workflow/marketplace-visibility-profile.test.ts`
- Modify: `src/tests/cli/marketplace-visibility.test.ts`

**Interfaces:**

- Consumes:
  - `MarketplaceListingContext`
  - `loadMarketplaceListingContext(path)`
- Produces:
  - `MarketplaceVisibilityService.startVisibilityReview(input: { profile; runId; date?; contextPath; listingContextPath? })`
  - `MarketplaceVisibilityCliDependencies.defaultListingContextPath?: string`
  - CLI option `--listing-context`

- [ ] **Step 1: Write the failing workflow service test**

In `src/tests/workflow/marketplace-visibility-profile.test.ts`, add this test near the existing `starts a MerchGrid visibility review from sparse daily evidence` test:

```ts
  it('includes optional listing context in initial visibility evidence', async () => {
    const service = createMarketplaceVisibilityService({
      engine: new FakeMarketplaceVisibilityEngine(),
      merchgridArtifacts: new InMemoryArtifacts(dailyArtifact()),
      runRepository: new InMemoryRunRepository(),
      loadContext: async () => readyContext(),
      loadListingContext: async () => readyListingContext(),
    });

    const state = await service.startVisibilityReview({
      profile: 'merchgrid_shopify_app_store',
      runId: 'visibility-with-listing-context',
      date: '2026-08-22',
      contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
      listingContextPath: 'artifacts/merchgrid/context/merchgrid-listing-context.json',
    });

    expect(state.evidenceSnapshots?.initial).toMatchObject({
      listingContext: {
        sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
        trustSignals: {
          friction: ['no reviews yet', 'read only safety is not prominent near data access context'],
        },
      },
    });
  });
```

Add this helper near `readyContext()`:

```ts
function readyListingContext() {
  return {
    marketplace: 'shopify_app_store' as const,
    profile: 'merchgrid_shopify_app_store' as const,
    productName: 'MerchGrid',
    sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
    capturedAt: '2026-08-24T12:00:00.000Z',
    captureMode: 'manual_visual_review' as const,
    publicSurface: {
      title: 'MerchGrid Catalog Audit',
      headline: 'Scans your product catalog and shows exactly which items are priced below cost',
      category: 'Analytics',
      pricingLabel: 'Free',
      ratingSummary: '0 reviews',
      reviewCount: 0,
      launchDate: 'August 7, 2026',
    },
    gallery: {
      imageCount: 4,
      observedImageLabels: ['main image', 'onboarding image', 'progress image', 'result image'],
      visualNotes: ['screenshots show audit flow and result surface'],
    },
    trustSignals: {
      positive: ['free pricing', 'privacy policy visible'],
      friction: ['no reviews yet', 'read only safety is not prominent near data access context'],
    },
    copyNotes: {
      clearClaims: ['detect below cost pricing'],
      unclearClaims: ['first scan action could be more explicit'],
      missingContext: ['why read only access is safe'],
    },
    visibilityRubricNotes: {
      promiseClarity: 'pricing issue promise is concrete',
      audienceSpecificity: 'merchant role is implied but not explicit',
      problemActionFit: 'catalog audit connects to first scan',
      discoveryFit: 'analytics category may require clearer catalog audit keywords',
      trustAndRiskReduction: 'read only safety should be easier to see',
      assetClarity: 'gallery shows screens but outcome hierarchy may need review',
    },
    limitations: ['manual public page review only'],
  };
}
```

- [ ] **Step 2: Write the failing CLI forwarding test**

In `src/tests/cli/marketplace-visibility.test.ts`, add:

```ts
  it('forwards optional listing context path for a visibility review', async () => {
    const calls: unknown[] = [];
    const state = {
      runId: 'visibility-1',
      status: 'awaiting_approval',
      stage: 'approval_wait',
      evidenceRefs: ['initial-ref'],
    };

    await runMarketplaceVisibilityCli({
      args: [
        'visibility-review',
        '--profile', 'merchgrid_shopify_app_store',
        '--date', '2026-08-22',
        '--run-id', 'visibility-1',
        '--context', 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
        '--listing-context', 'artifacts/merchgrid/context/merchgrid-listing-context.json',
      ],
      dependencies: {
        service: {
          startVisibilityReview: async (input) => {
            calls.push(input);
            return state;
          },
        },
        engine: { step: async () => state },
      },
      writeLine: () => undefined,
    });

    expect(calls).toEqual([{
      profile: 'merchgrid_shopify_app_store',
      runId: 'visibility-1',
      date: '2026-08-22',
      contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
      listingContextPath: 'artifacts/merchgrid/context/merchgrid-listing-context.json',
    }]);
  });
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npm test -- marketplace-visibility-profile.test.ts marketplace-visibility.test.ts
```

Expected: FAIL because `listingContextPath` and `loadListingContext` are not defined or forwarded.

- [ ] **Step 4: Update service types and evidence builder**

In `src/workflow/marketplace-visibility-profile.ts`, update imports:

```ts
  type MarketplaceListingContext,
```

Update the service input type:

```ts
    listingContextPath?: string;
```

Update `createMarketplaceVisibilityService` dependencies:

```ts
  loadListingContext?: (path: string) => Promise<MarketplaceListingContext>;
```

Inside `startVisibilityReview`, load optional listing context:

```ts
      const listingContext = input.listingContextPath
        ? await requireListingContextLoader(deps.loadListingContext)(input.listingContextPath)
        : undefined;
```

Pass `listingContext` into both builders:

```ts
            listingContext,
```

Add `listingContext?: MarketplaceListingContext` to each builder input type.

In each evidence object, add:

```ts
    listingContext: input.listingContext,
```

Add this helper near other helpers:

```ts
function requireListingContextLoader(
  loader: ((path: string) => Promise<MarketplaceListingContext>) | undefined,
): (path: string) => Promise<MarketplaceListingContext> {
  if (!loader) throw new AppError('configuration_failed', 'Marketplace listing context loader is unavailable');
  return loader;
}
```

The contract from Task 1 will reject mismatched profile or marketplace.

- [ ] **Step 5: Update CLI types and option parsing**

In `src/cli/marketplace-visibility.ts`, import the listing loader:

```ts
import {
  loadMarketplaceListingContext,
  loadMarketplaceVisibilityContext,
} from '../connectors/marketplace/local-context.js';
```

Update `MarketplaceVisibilityCliDependencies.service.startVisibilityReview`:

```ts
startVisibilityReview?: (input: {
  profile: MarketplaceVisibilityProfile;
  runId: string;
  date?: string;
  contextPath: string;
  listingContextPath?: string;
}) => Promise<RunState>;
```

Add:

```ts
  defaultListingContextPath?: string;
```

Update `assertOptions` for `visibility-review`:

```ts
    assertOptions(options, ['--profile', '--run-id'], ['--date', '--context', '--listing-context']);
```

Read the optional listing context:

```ts
    const listingContextPath = optionalOption(options, '--listing-context') ?? input.dependencies.defaultListingContextPath;
```

Forward it:

```ts
      listingContextPath,
```

In `createMarketplaceVisibilityDependencies`, wire the loader and env default:

```ts
      loadListingContext: loadMarketplaceListingContext,
```

```ts
    defaultListingContextPath: env.MERCHGRID_LISTING_CONTEXT_PATH,
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npm test -- marketplace-visibility-profile.test.ts marketplace-visibility.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/marketplace-visibility-profile.ts src/cli/marketplace-visibility.ts src/tests/workflow/marketplace-visibility-profile.test.ts src/tests/cli/marketplace-visibility.test.ts
git commit -m "feat: attach listing context to visibility reviews"
```

---

### Task 4: Module Prompts and Deterministic Context

**Purpose:** Make the work engine actually use listing context during M1-M6 without changing the workflow lifecycle.

**Why:** If the context is only persisted but never summarized into module input, M4 cannot use it to reason about visual/copy bottlenecks.

**How:** Extend deterministic M1 context with listing facts and strengthen M4-M6 normalization so outputs remain exploratory and manually approved.

> **APOSD concept — information hiding:** M4 does not need raw listing data. It needs a small set of facts: source URL, headline, gallery count, trust friction, copy gaps, and rubric notes.

**Files:**

- Modify: `src/agents/marketplace-visibility/modules.ts`
- Modify: `src/tests/agents/marketplace-visibility-modules.test.ts`

**Interfaces:**

- Consumes: `MarketplaceVisibilityEvidence.listingContext`.
- Produces: M1 `ContextOutput.availableEvidence`, `missingInformation`, and `notes` entries that mention listing context safely.

- [ ] **Step 1: Write the failing module test**

In `src/tests/agents/marketplace-visibility-modules.test.ts`, add:

```ts
  it('surfaces listing context as curated M1 evidence', async () => {
    const context = deterministicMarketplaceVisibilityContext({
      ...visibilityEvidence(),
      listingContext: listingContext(),
    });

    expect(context.availableEvidence).toContain('listing url: https://apps.shopify.com/merchgrid-catalog-audit');
    expect(context.availableEvidence).toContain('listing headline: Scans your product catalog and shows exactly which items are priced below cost');
    expect(context.availableEvidence).toContain('listing gallery images: 4');
    expect(context.missingInformation).toContain('listing friction: no reviews yet');
    expect(context.notes).toContain('Listing observations are qualitative context, not conversion proof.');
  });
```

Add a local helper in that test file:

```ts
function listingContext() {
  return {
    marketplace: 'shopify_app_store' as const,
    profile: 'merchgrid_shopify_app_store' as const,
    productName: 'MerchGrid',
    sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
    capturedAt: '2026-08-24T12:00:00.000Z',
    captureMode: 'manual_visual_review' as const,
    publicSurface: {
      headline: 'Scans your product catalog and shows exactly which items are priced below cost',
      category: 'Analytics',
      pricingLabel: 'Free',
      ratingSummary: '0 reviews',
      reviewCount: 0,
    },
    gallery: {
      imageCount: 4,
      observedImageLabels: ['main image', 'onboarding image', 'progress image', 'result image'],
      visualNotes: ['screenshots show audit flow and result surface'],
    },
    trustSignals: {
      positive: ['free pricing'],
      friction: ['no reviews yet'],
    },
    copyNotes: {
      clearClaims: ['detect below cost pricing'],
      unclearClaims: ['read only safety is not prominent'],
      missingContext: ['first scan outcome could be clearer'],
    },
    visibilityRubricNotes: {
      promiseClarity: 'pricing issue promise is concrete',
      audienceSpecificity: 'merchant role is implied but not explicit',
      problemActionFit: 'catalog audit connects to first scan',
      discoveryFit: 'analytics category may require clearer catalog audit keywords',
      trustAndRiskReduction: 'read only safety should be easier to see',
      assetClarity: 'gallery shows screens but outcome hierarchy may need review',
    },
    limitations: ['manual public page review only'],
  };
}
```

- [ ] **Step 2: Run focused module tests and verify RED**

Run:

```bash
npm test -- marketplace-visibility-modules.test.ts
```

Expected: FAIL because `deterministicMarketplaceVisibilityContext()` does not surface listing context.

- [ ] **Step 3: Update M1 context builder**

In `src/agents/marketplace-visibility/modules.ts`, update `deterministicMarketplaceVisibilityContext`:

```ts
export function deterministicMarketplaceVisibilityContext(evidence: MarketplaceVisibilityEvidence): ContextOutput {
  const listing = evidence.listingContext;
  return {
    product: evidence.marketplaceContext.productName,
    likelyCustomer: evidence.marketplaceContext.targetCustomer,
    positioning: `${marketplaceName(evidence.marketplaceContext.marketplace)} visibility review: ${evidence.marketplaceContext.currentSurfaceSummary}`,
    availableEvidence: [
      `profile: ${evidence.profile}`,
      `evidence level: ${evidence.evidenceLevel}`,
      `artifact: ${evidence.artifactRef}`,
      ...(listing ? [
        `listing url: ${listing.sourceUrl}`,
        ...(listing.publicSurface.headline ? [`listing headline: ${listing.publicSurface.headline}`] : []),
        ...(listing.publicSurface.category ? [`listing category: ${listing.publicSurface.category}`] : []),
        `listing gallery images: ${listing.gallery.imageCount}`,
        ...listing.copyNotes.clearClaims.map((claim) => `listing clear claim: ${claim}`),
      ] : ['listing context: unavailable']),
    ],
    missingInformation: [
      ...evidence.limitations,
      ...(listing ? [
        ...listing.trustSignals.friction.map((item) => `listing friction: ${item}`),
        ...listing.copyNotes.unclearClaims.map((item) => `listing unclear claim: ${item}`),
        ...listing.copyNotes.missingContext.map((item) => `listing missing context: ${item}`),
        ...listing.limitations.map((item) => `listing limitation: ${item}`),
      ] : ['listing context unavailable']),
    ],
    notes: [
      ...evidence.prohibitedClaims,
      ...(listing ? [
        'Listing observations are qualitative context, not conversion proof.',
        `listing captured at: ${listing.capturedAt}`,
        `promise clarity: ${listing.visibilityRubricNotes.promiseClarity}`,
        `trust and risk reduction: ${listing.visibilityRubricNotes.trustAndRiskReduction}`,
      ] : []),
    ],
  };
}
```

- [ ] **Step 4: Strengthen M4-M6 prompts**

Update prompt constants in `src/agents/marketplace-visibility/modules.ts`:

```ts
const VISIBILITY_DIAGNOSIS_PROMPT = [
  'M4 Marketplace Visibility Diagnosis.',
  'Use sparse evidence honestly. Do not claim proof.',
  'If reviewMode.mode is exploratory_visibility_test, sparse or zero metrics alone are not a reason to stop.',
  'Use product context, marketplace context, and listing context to identify one likely visibility bottleneck hypothesis.',
  'Listing observations are qualitative evidence only.',
  'Choose proceed_to_hypothesis for one manual exploratory test unless the product or listing context is contradictory or unsafe.',
].join('\n');
```

```ts
const VISIBILITY_HYPOTHESIS_PROMPT = [
  'M5 Marketplace Visibility Hypothesis.',
  'Use sparse evidence honestly. Propose one manual, exploratory listing revision.',
  'The hypothesis may use listing copy or visual context, but must not claim the revision will improve marketplace outcomes.',
].join('\n');
```

```ts
const VISIBILITY_TEST_PLAN_PROMPT = [
  'M6 Marketplace Visibility Test Plan.',
  'Use sparse evidence honestly. Define a manual exploratory test and its later measurement needs.',
  'The output is a manual test plan. It must not claim the system will edit an external marketplace.',
  'Change one listing element at a time so the result remains interpretable.',
].join('\n');
```

- [ ] **Step 5: Run focused module tests and verify GREEN**

Run:

```bash
npm test -- marketplace-visibility-modules.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agents/marketplace-visibility/modules.ts src/tests/agents/marketplace-visibility-modules.test.ts
git commit -m "feat: use listing context in visibility modules"
```

---

### Task 5: Docs, Environment, and End-to-End Verification

**Purpose:** Make the new listing-context input usable from local commands and prove the full path works.

**Why:** The feature is only useful if the owner can copy the example, pass the file to the command, and see the work engine reach `approval_wait`.

**How:** Document `MERCHGRID_LISTING_CONTEXT_PATH` and `--listing-context`, add a CLI integration test with the example path, then run the full verification suite.

> **DDIA concept — reproducible batch run:** The same date, profile, product brief, and listing context should produce a repeatable local workflow artifact. That makes the result inspectable through `run.json` and `experiment-plan.json`.

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: `src/tests/cli/marketplace-visibility.test.ts`
- Existing example: `docs/examples/merchgrid-listing-context.example.json`

**Interfaces:**

- Consumes:
  - `MERCHGRID_LISTING_CONTEXT_PATH`
  - CLI option `--listing-context`
- Produces: documented owner workflow for `artifacts/merchgrid/context/merchgrid-listing-context.json`.

- [ ] **Step 1: Add env example**

In `.env.example`, add below `MERCHGRID_VISIBILITY_CONTEXT_PATH`:

```dotenv
MERCHGRID_LISTING_CONTEXT_PATH=artifacts/merchgrid/context/merchgrid-listing-context.json
```

- [ ] **Step 2: Update README command docs**

In `README.md`, update the marketplace visibility command list:

```md
- `npm run marketplace:visibility-review -- --profile merchgrid_shopify_app_store --date YYYY-MM-DD --run-id RUN_ID --context artifacts/merchgrid/context/merchgrid-visibility-context.json --listing-context artifacts/merchgrid/context/merchgrid-listing-context.json`
```

Replace the context explanation paragraph with:

```md
The `--context` argument overrides `MERCHGRID_VISIBILITY_CONTEXT_PATH`; use a
local, curated JSON file with only the product-facing context required for the
sparse recommendation. The optional `--listing-context` argument overrides
`MERCHGRID_LISTING_CONTEXT_PATH`; use it for public marketplace listing
observations such as headline, gallery count, trust signals, and visual-review
notes. Do not put private dashboard pages, cookies, raw HTML, credentials, or
merchant data in either file.
```

Add this after the existing visibility context copy instruction:

```md
For listing context, copy
`docs/examples/merchgrid-listing-context.example.json` to
`artifacts/merchgrid/context/merchgrid-listing-context.json`, refresh the `capturedAt` value after
reviewing the public listing, then include `--listing-context` in the visibility
review command.
```

- [ ] **Step 3: Add CLI default env test**

In `src/tests/cli/marketplace-visibility.test.ts`, add:

```ts
  it('uses the default listing context path when the flag is omitted', async () => {
    const calls: unknown[] = [];
    const state = {
      runId: 'visibility-1',
      status: 'awaiting_approval',
      stage: 'approval_wait',
      evidenceRefs: ['initial-ref'],
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
        service: {
          startVisibilityReview: async (input) => {
            calls.push(input);
            return state;
          },
        },
        engine: { step: async () => state },
        defaultListingContextPath: 'artifacts/merchgrid/context/merchgrid-listing-context.json',
      },
      writeLine: () => undefined,
    });

    expect(calls).toEqual([{
      profile: 'merchgrid_shopify_app_store',
      runId: 'visibility-1',
      date: '2026-08-22',
      contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
      listingContextPath: 'artifacts/merchgrid/context/merchgrid-listing-context.json',
    }]);
  });
```

- [ ] **Step 4: Run focused docs-adjacent tests**

Run:

```bash
npm test -- marketplace-visibility.test.ts marketplace-local-context.test.ts marketplace-visibility-profile.test.ts marketplace-visibility-modules.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected:

- all tests pass;
- typecheck exits 0;
- build exits 0;
- `git diff --check` has no output.

- [ ] **Step 6: Secret and raw-data scan**

Run:

```bash
rg -n "api[_ -]?key|access[_ -]?token|authorization|cookie|password|secret|myshopify\\.com|raw html|partners\\.shopify\\.com" docs/examples/merchgrid-listing-context.example.json README.md .env.example src/contracts/marketplace-visibility.ts src/connectors/marketplace/local-context.ts
```

Expected:

- README and contract may mention banned categories only as prohibited examples.
- `docs/examples/merchgrid-listing-context.example.json` and `.env.example` contain no secret values, private dashboard URLs, or shop domains.

- [ ] **Step 7: Commit**

```bash
git add .env.example README.md src/tests/cli/marketplace-visibility.test.ts docs/examples/merchgrid-listing-context.example.json
git commit -m "docs: document marketplace listing context input"
```

---

## Final Review Checklist

- [ ] `MarketplaceListingContextSchema` rejects unsafe URL, raw HTML, cookie, credential, and private-dashboard fields.
- [ ] `loadMarketplaceListingContext()` accepts only local file paths.
- [ ] `--listing-context` and `MERCHGRID_LISTING_CONTEXT_PATH` both reach `startVisibilityReview()`.
- [ ] Initial `MarketplaceVisibilityEvidence` can preserve listing context.
- [ ] M1 exposes curated listing facts to M4-M6.
- [ ] M4-M6 prompt/normalization language keeps recommendations exploratory and manual.
- [ ] Example context is safe to commit.
- [ ] No screenshots or raw provider exports are committed.

## Manual Smoke Command

After implementation, a real local run should look like:

```bash
cp docs/examples/merchgrid-listing-context.example.json artifacts/merchgrid/context/merchgrid-listing-context.json
npm run marketplace:visibility-review -- \
  --profile merchgrid_shopify_app_store \
  --date 2026-08-07 \
  --run-id merchgrid-visibility-2026-08-07-listing-context \
  --context artifacts/merchgrid/context/merchgrid-visibility-context.json \
  --listing-context artifacts/merchgrid/context/merchgrid-listing-context.json
```

Expected terminal shape:

```text
run: merchgrid-visibility-2026-08-07-listing-context
status: awaiting_approval
stage: approval_wait
artifact: initial:marketplace_visibility:merchgrid_shopify_app_store:merchgrid:visibility:2026-08-07
```

Expected artifacts:

```text
artifacts/merchgrid/metrics/workflow-runs/merchgrid-visibility-2026-08-07-listing-context/run.json
artifacts/merchgrid/metrics/workflow-runs/merchgrid-visibility-2026-08-07-listing-context/experiment-plan.json
```
