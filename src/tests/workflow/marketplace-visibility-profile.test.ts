import { describe, expect, it } from 'vitest';
import { FakeAgentRunner } from '../../agents/runner.js';
import type { DailyMetricSnapshot } from '../../contracts/metrics.js';
import { createMarketplaceVisibilityModuleExecutor } from '../../agents/marketplace-visibility/modules.js';
import type { MarketplaceVisibilityEvidence } from '../../contracts/marketplace-visibility.js';
import { WorkflowRunStateSchema, type WorkflowRunState, type WorkflowRunStateInput } from '../../contracts/workflow.js';
import type { MerchGridReviewArtifactRepository } from '../../jobs/merchgrid-source-pack.js';
import { MerchGridReviewEvidenceSchema, type MerchGridReviewEvidence } from '../../metrics/evidence.js';
import { toMerchGridReviewEvidence } from '../../metrics/evidence.js';
import { buildDailyHealthSummary } from '../../metrics/summaries.js';
import type { RunRepository } from '../../storage/runs.js';
import { createWorkflowEngine } from '../../workflow/engine.js';
import {
  createMarketplaceVisibilityService,
  selectMarketplaceVisibilityMode,
  type MarketplaceVisibilityEngine,
} from '../../workflow/marketplace-visibility-profile.js';

describe('marketplace visibility profile', () => {
  it('selects exploratory mode for complete context even when signals are empty', () => {
    expect(selectMarketplaceVisibilityMode({
      context: readyContext(),
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
      context: { ...readyContext(), constraints: [] },
      measuredSignals: {},
      limitations: [],
    })).toEqual({
      mode: 'missing_context',
      missingFields: ['constraints'],
      reason: 'context_required_before_exploratory_test',
    });
  });

  it('starts a MerchGrid visibility review from sparse daily evidence', async () => {
    const service = createService({
      dailyArtifact: dailyArtifact(),
      context: readyContext(),
    });

    const state = await service.startVisibilityReview({
      profile: 'merchgrid_shopify_app_store',
      runId: 'merchgrid-visibility-2026-08-22',
      date: '2026-08-22',
      contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
    });

    expect(state).toMatchObject({
      workflowKind: 'marketplace_visibility_review',
      subjectRef: 'merchgrid:visibility:2026-08-22',
      evidenceSnapshots: {
        initial: {
          product: 'marketplace_visibility',
          profile: 'merchgrid_shopify_app_store',
          evidenceLevel: 'sparse',
          measuredSignals: { app_opened_count: 12, request_count: 18 },
        },
      },
    });
  });

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

  it('projects Fly numeric signals when the daily artifact has no PostHog metrics', async () => {
    const service = createService({
      dailyArtifact: flyOnlyDailyArtifact(),
      context: readyContext(),
    });

    const state = await service.startVisibilityReview({
      profile: 'merchgrid_shopify_app_store',
      runId: 'merchgrid-visibility-2026-08-22-fly',
      date: '2026-08-22',
      contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
    });

    expect(state.evidenceSnapshots?.initial).toMatchObject({
      measuredSignals: { request_count: 18, error_rate: 0.1 },
    });
  });

  it('curates real source-pack limitation tokens before validating visibility evidence', async () => {
    const artifact = toMerchGridReviewEvidence(buildDailyHealthSummary({
      date: '2026-08-22',
      snapshots: [
        dailySnapshot('posthog', 'complete', { app_opened_count: 2 }),
        dailySnapshot('fly_metrics', 'complete', { request_count: 7 }),
        dailySnapshot('shopify_partner', 'unavailable'),
      ],
    }));
    const service = createService({
      dailyArtifact: artifact,
      context: readyContext(),
    });

    const state = await service.startVisibilityReview({
      profile: 'merchgrid_shopify_app_store',
      runId: 'visibility-source-pack-unavailable',
      date: '2026-08-22',
      contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
    });

    expect(state.evidenceSnapshots?.initial).toMatchObject({
      limitations: ['Shopify Partner metrics unavailable'],
    });
  });

  it('rejects thin product context before starting the workflow', async () => {
    const engine = new FakeMarketplaceVisibilityEngine();
    const service = createMarketplaceVisibilityService({
      engine,
      merchgridArtifacts: new InMemoryArtifacts(dailyArtifact()),
      runRepository: new InMemoryRunRepository(),
      loadContext: async () => ({
        ...readyContext(),
        constraints: [],
      }),
    });

    await expect(service.startVisibilityReview({
      profile: 'merchgrid_shopify_app_store',
      runId: 'visibility-thin-context',
      date: '2026-08-22',
      contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
    })).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'visibility_context_missing:constraints',
    });
    expect(engine.startCalls).toBe(0);
  });

  it('derives artifact references from the configured artifact root', async () => {
    const engine = new FakeMarketplaceVisibilityEngine();
    const service = createMarketplaceVisibilityService({
      engine,
      merchgridArtifacts: new InMemoryArtifacts(dailyArtifact()),
      merchgridArtifactRootRef: 'artifacts/custom-merchgrid/artifacts',
      runRepository: new InMemoryRunRepository(),
      loadContext: async () => readyContext(),
    });

    const state = await service.startVisibilityReview({
      profile: 'merchgrid_shopify_app_store',
      runId: 'visibility-custom-root',
      date: '2026-08-22',
      contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
    });

    expect(state.evidenceSnapshots?.initial).toMatchObject({
      artifactRef: 'artifacts/custom-merchgrid/artifacts/daily-health/2026-08-22.json',
    });
  });

  it('builds Etsy visibility evidence without Shopify or Fly fields', async () => {
    const service = createService({
      context: {
        marketplace: 'etsy',
        productName: 'Printable Weekly Planner',
        productType: 'digital_product',
        targetCustomer: 'Planner buyers organizing weekly routines',
        customerProblem: 'Busy buyers need a simple printable weekly planning layout',
        currentPromise: 'Plan the week with a clean printable planner',
        currentSurfaceSummary: 'Etsy listing with printable planner title and tags',
        primaryDiscoverySurface: 'Etsy search and listing recommendations',
        primaryActionWanted: 'Click the listing and save the printable planner',
        constraints: ['manual listing changes only'],
        availableAssets: ['listing title', 'listing images'],
        ownerGoal: 'increase qualified listing clicks',
      },
    });

    const state = await service.startVisibilityReview({
      profile: 'etsy_listing',
      runId: 'etsy-visibility-listing-123',
      contextPath: 'artifacts/etsy/context/etsy-visibility-context.json',
    });

    expect(JSON.stringify(state.evidenceSnapshots?.initial)).not.toMatch(/fly_metrics|shopify_partner|posthog/i);
    expect(state.evidenceSnapshots?.initial).toMatchObject({
      evidenceLevel: 'sparse',
      measuredSignals: {},
      limitations: ['etsy runtime profile is fixture-backed in this slice'],
    });
  });

  it('records a later MerchGrid weekly artifact as visibility result evidence', async () => {
    const service = createResultService({
      dailyArtifact: dailyArtifact(),
      weeklyArtifacts: {
        '2026-09-04': weeklyArtifact({ app_opened_count: 4, scan_started_count: 1 }),
      },
    });

    await startApprovedVisibilityReview(service, 'visibility-result');

    const result = await service.supplyVisibilityResult({
      runId: 'visibility-result',
      profile: 'merchgrid_shopify_app_store',
      through: '2026-09-04',
    });

    expect(result).toMatchObject({
      stage: 'm2_metrics_results',
      evidenceSnapshots: {
        result: {
          product: 'marketplace_visibility',
          evidenceLevel: 'sparse',
          subjectRef: 'merchgrid:visibility:2026-08-22',
          artifactRef: 'artifacts/merchgrid/metrics/artifacts/weekly-reviews/2026-09-04.json',
          measuredSignals: { app_opened_count: 4, scan_started_count: 1 },
          limitations: [
            'Previous period Shopify Partner metrics unavailable for 7 days',
            'Current period Shopify Partner metrics unavailable for 7 days',
          ],
        },
      },
    });

    const afterMetrics = await service.engine.step('visibility-result');
    expect(afterMetrics.moduleOutputs.m2Results).toMatchObject({
      phase: 'post_experiment',
      comparisonQuality: 'limited',
      metrics: [{
        name: 'app_opened_count',
        baseline: 12,
        current: 4,
        absoluteChange: -8,
        percentageChange: -2 / 3,
        qualification: 'declined',
        confidence: 'low',
      }],
      unresolvedQualificationNeeds: ['visibility result remains sparse and exploratory'],
    });
  });

  it('waits when visibility result evidence has no later measured signals', async () => {
    const service = createResultService({
      dailyArtifact: dailyArtifact(),
      weeklyArtifacts: { '2026-09-04': weeklyArtifact({}) },
    });
    await startApprovedVisibilityReview(service, 'visibility-wait');

    const result = await service.supplyVisibilityResult({
      runId: 'visibility-wait',
      profile: 'merchgrid_shopify_app_store',
      through: '2026-09-04',
    });

    expect(result).toMatchObject({ stage: 'experiment_wait', status: 'waiting_for_data' });
  });

  it('rejects a daily artifact supplied as a visibility result', async () => {
    const service = createResultService({
      dailyArtifact: dailyArtifact(),
      weeklyArtifacts: { '2026-09-04': dailyArtifact() },
    });
    await startApprovedVisibilityReview(service, 'visibility-non-weekly');

    await expect(service.supplyVisibilityResult({
      runId: 'visibility-non-weekly',
      profile: 'merchgrid_shopify_app_store',
      through: '2026-09-04',
    })).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'MerchGrid visibility result requires a weekly review artifact',
    });
  });

  it('rejects a weekly artifact whose end date does not match through', async () => {
    const service = createResultService({
      dailyArtifact: dailyArtifact(),
      weeklyArtifacts: {
        '2026-09-04': weeklyArtifact(
          { app_opened_count: 4 },
          { previous: { startDate: '2026-08-21', endDate: '2026-08-27' }, current: { startDate: '2026-08-28', endDate: '2026-09-03' } },
        ),
      },
    });
    await startApprovedVisibilityReview(service, 'visibility-mismatched-through');

    await expect(service.supplyVisibilityResult({
      runId: 'visibility-mismatched-through',
      profile: 'merchgrid_shopify_app_store',
      through: '2026-09-04',
    })).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'MerchGrid weekly review artifact period does not match through date',
    });
  });

  it('rejects coterminous visibility result evidence', async () => {
    const service = createResultService({
      dailyArtifact: dailyArtifact(),
      weeklyArtifacts: {
        '2026-08-22': weeklyArtifact(
          { app_opened_count: 4 },
          { previous: { startDate: '2026-08-09', endDate: '2026-08-15' }, current: { startDate: '2026-08-16', endDate: '2026-08-22' } },
        ),
      },
    });
    await startApprovedVisibilityReview(service, 'visibility-coterminous');

    await expect(service.supplyVisibilityResult({
      runId: 'visibility-coterminous',
      profile: 'merchgrid_shopify_app_store',
      through: '2026-08-22',
    })).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Visibility result through date must be later than the initial visibility date',
    });
  });

  it('rejects a result window that starts on the approval boundary', async () => {
    const service = createResultService({
      dailyArtifact: dailyArtifact(),
      weeklyArtifacts: {
        '2026-08-29': weeklyArtifact(
          { app_opened_count: 4 },
          { previous: { startDate: '2026-08-16', endDate: '2026-08-22' }, current: { startDate: '2026-08-23', endDate: '2026-08-29' } },
        ),
      },
    });
    await startApprovedVisibilityReview(service, 'visibility-overlapping-result');

    await expect(service.supplyVisibilityResult({
      runId: 'visibility-overlapping-result',
      profile: 'merchgrid_shopify_app_store',
      through: '2026-08-29',
    })).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Visibility result current window must begin after the approval boundary',
    });
  });
});

function createService(input: {
  context: Parameters<typeof createMarketplaceVisibilityService>[0] extends { loadContext: (path: string) => Promise<infer T> } ? T : never;
  dailyArtifact?: MerchGridReviewEvidence;
}) {
  const engine = new FakeMarketplaceVisibilityEngine();
  return createMarketplaceVisibilityService({
    engine,
    merchgridArtifacts: new InMemoryArtifacts(input.dailyArtifact),
    runRepository: new InMemoryRunRepository(),
    loadContext: async () => input.context,
  });
}

function createResultService(input: {
  dailyArtifact: MerchGridReviewEvidence;
  weeklyArtifacts: Record<string, MerchGridReviewEvidence>;
}) {
  const runs = new InMemoryRunRepository();
  const engine = createWorkflowEngine({
    repository: runs,
    modules: createMarketplaceVisibilityModuleExecutor({
      agentRunner: new FakeAgentRunner({
        m4: { performancePath: 'discovery', primaryBottleneck: 'Sparse evidence', confidence: 'low', decision: 'proceed_to_hypothesis', notes: [] },
        m5: { hypothesis: 'Clarify listing value', primaryVariable: 'listing copy', recommendedRevision: 'Clarify the app value', keepConstant: [], expectedSignal: 'App opens increase', notes: [] },
        m6: { primaryMetric: 'app_opened_count', secondaryMetrics: [], baselineValue: 12, baselinePeriod: '2026-08-22', qualificationRequirements: [], expectedSupportingSignal: 'App opens increase', expectedWeakeningSignal: 'App opens decrease', inconclusiveCondition: 'No meaningful change', contextToMonitor: [], unresolvedMeasurementRules: [] },
      }),
    }),
    now: fixedNow,
  });
  const service = createMarketplaceVisibilityService({
    engine,
    merchgridArtifacts: new InMemoryArtifacts(input.dailyArtifact, input.weeklyArtifacts),
    runRepository: runs,
    loadContext: async () => readyContext(),
  });
  return { ...service, engine };
}

async function startApprovedVisibilityReview(
  service: ReturnType<typeof createResultService>,
  runId: string,
): Promise<void> {
  await service.startVisibilityReview({
    profile: 'merchgrid_shopify_app_store',
    runId,
    date: '2026-08-22',
    contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
  });
  for (let index = 0; index < 5; index += 1) await service.engine.step(runId);
  await service.engine.approveExperiment(runId);
}

class FakeMarketplaceVisibilityEngine implements MarketplaceVisibilityEngine {
  startCalls = 0;

  async startMarketplaceVisibility(input: {
    runId: string;
    subjectRef: string;
    initialEvidence: MarketplaceVisibilityEvidence;
  }): Promise<WorkflowRunState> {
    this.startCalls += 1;
    return WorkflowRunStateSchema.parse({
      runId: input.runId,
      subjectRef: input.subjectRef,
      workflowKind: 'marketplace_visibility_review',
      status: 'analyzing',
      stage: 'm1_context',
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
      evidenceRefs: [`initial:${input.initialEvidence.subjectRef}`],
      evidenceSnapshots: { initial: input.initialEvidence },
      moduleOutputs: { m3: [] },
      events: [],
    });
  }

  async resumeWithExperimentResults(): Promise<WorkflowRunState> { throw new Error('not used'); }
  async waitForMoreData(): Promise<WorkflowRunState> { throw new Error('not used'); }
}

function readyContext() {
  return {
    marketplace: 'shopify_app_store' as const,
    productName: 'MerchGrid',
    productType: 'shopify_app' as const,
    targetCustomer: 'Shopify merchants auditing catalog quality',
    customerProblem: 'Catalog issues can hurt trust before the merchant notices',
    currentPromise: 'Find catalog issues before they hurt sales or trust',
    currentSurfaceSummary: 'Shopify app listing for catalog audits',
    primaryDiscoverySurface: 'Shopify App Store search and category pages',
    primaryActionWanted: 'Open the app and run the first catalog audit',
    constraints: ['manual listing changes only'],
    availableAssets: ['listing copy', 'screenshots'],
    ownerGoal: 'increase qualified app opens and first scans',
  };
}

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

function dailySnapshot(
  source: DailyMetricSnapshot['source'],
  status: DailyMetricSnapshot['status'],
  metrics: Record<string, number> = {},
): DailyMetricSnapshot {
  return {
    source,
    date: '2026-08-22',
    collectedAt: '2026-08-23T00:05:00.000Z',
    status,
    metrics,
    notes: [],
  };
}

class InMemoryArtifacts implements MerchGridReviewArtifactRepository {
  constructor(
    private readonly dailyArtifact?: MerchGridReviewEvidence,
    private readonly weeklyArtifacts: Record<string, MerchGridReviewEvidence> = {},
  ) {}

  async saveDailyHealth(): Promise<string> { throw new Error('not used'); }
  async loadDailyHealth(): Promise<MerchGridReviewEvidence | undefined> { return this.dailyArtifact; }
  async saveWeeklyReview(): Promise<string> { throw new Error('not used'); }
  async loadWeeklyReview(through: string): Promise<MerchGridReviewEvidence | undefined> { return this.weeklyArtifacts[through]; }
}

class InMemoryRunRepository implements RunRepository {
  private readonly states = new Map<string, WorkflowRunState>();

  async create(state: WorkflowRunStateInput): Promise<void> {
    this.states.set(state.runId, WorkflowRunStateSchema.parse(state));
  }

  async load(runId: string): Promise<WorkflowRunState> {
    const state = this.states.get(runId);
    if (!state) throw new Error(`Missing run ${runId}`);
    return structuredClone(state);
  }

  async save(state: WorkflowRunStateInput): Promise<void> {
    this.states.set(state.runId, WorkflowRunStateSchema.parse(state));
  }
}

function dailyArtifact(): MerchGridReviewEvidence {
  return MerchGridReviewEvidenceSchema.parse({
    period: { kind: 'daily', date: '2026-08-22' },
    sourceCoverage: { posthog: 'complete', fly_metrics: 'complete', shopify_partner: 'unavailable' },
    sourceFreshness: {},
    aggregateMetrics: {
      posthog: { app_opened_count: 12 },
      fly_metrics: { request_count: 18 },
      shopify_partner: { installs: 4 },
    },
    limitations: ['Shopify partner metrics unavailable'],
  });
}

function flyOnlyDailyArtifact(): MerchGridReviewEvidence {
  return MerchGridReviewEvidenceSchema.parse({
    period: { kind: 'daily', date: '2026-08-22' },
    sourceCoverage: { posthog: 'unavailable', fly_metrics: 'complete', shopify_partner: 'unavailable' },
    sourceFreshness: {},
    aggregateMetrics: { fly_metrics: { request_count: 18, error_rate: 0.1 } },
    limitations: ['PostHog metrics unavailable'],
  });
}

function weeklyArtifact(
  posthog: Record<string, number>,
  period = {
    previous: { startDate: '2026-08-22', endDate: '2026-08-28' },
    current: { startDate: '2026-08-29', endDate: '2026-09-04' },
  },
): MerchGridReviewEvidence {
  return MerchGridReviewEvidenceSchema.parse({
    period: {
      kind: 'weekly',
      previous: period.previous,
      current: period.current,
    },
    sourceCoverage: {
      previous: { posthog: { complete: 7 }, fly_metrics: { complete: 7 }, shopify_partner: { unavailable: 7 } },
      current: { posthog: { complete: 7 }, fly_metrics: { complete: 7 }, shopify_partner: { unavailable: 7 } },
    },
    sourceFreshness: { previous: {}, current: {} },
    aggregateMetrics: { previous: {}, current: { posthog }, change: {} },
    limitations: ['previous:shopify_partner:unavailable:7', 'current:shopify_partner:unavailable:7'],
  });
}

function fixedNow(): Date {
  return new Date('2026-08-23T00:00:00.000Z');
}
