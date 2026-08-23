import { describe, expect, it } from 'vitest';
import type { MarketplaceVisibilityEvidence } from '../../contracts/marketplace-visibility.js';
import { WorkflowRunStateSchema, type WorkflowRunState } from '../../contracts/workflow.js';
import type { MerchGridReviewArtifactRepository } from '../../jobs/merchgrid-source-pack.js';
import { MerchGridReviewEvidenceSchema, type MerchGridReviewEvidence } from '../../metrics/evidence.js';
import {
  createMarketplaceVisibilityService,
  type MarketplaceVisibilityEngine,
} from '../../workflow/marketplace-visibility-profile.js';

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
      contextPath: '.local/merchgrid-visibility-context.json',
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

  it('projects Fly numeric signals when the daily artifact has no PostHog metrics', async () => {
    const service = createService({
      dailyArtifact: flyOnlyDailyArtifact(),
      context: {
        marketplace: 'shopify_app_store',
        productName: 'MerchGrid',
        currentSurfaceSummary: 'Shopify app listing for catalog audits',
      },
    });

    const state = await service.startVisibilityReview({
      profile: 'merchgrid_shopify_app_store',
      runId: 'merchgrid-visibility-2026-08-22-fly',
      date: '2026-08-22',
      contextPath: '.local/merchgrid-visibility-context.json',
    });

    expect(state.evidenceSnapshots?.initial).toMatchObject({
      measuredSignals: { request_count: 18, error_rate: 0.1 },
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
      contextPath: '.local/etsy-visibility-context.json',
    });

    expect(JSON.stringify(state.evidenceSnapshots?.initial)).not.toMatch(/fly_metrics|shopify_partner|posthog/i);
    expect(state.evidenceSnapshots?.initial).toMatchObject({
      evidenceLevel: 'sparse',
      measuredSignals: {},
      limitations: ['etsy runtime profile is fixture-backed in this slice'],
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
    loadContext: async () => input.context,
  });
}

class FakeMarketplaceVisibilityEngine implements MarketplaceVisibilityEngine {
  async startMarketplaceVisibility(input: {
    runId: string;
    subjectRef: string;
    initialEvidence: MarketplaceVisibilityEvidence;
  }): Promise<WorkflowRunState> {
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
}

class InMemoryArtifacts implements MerchGridReviewArtifactRepository {
  constructor(private readonly dailyArtifact?: MerchGridReviewEvidence) {}

  async saveDailyHealth(): Promise<string> { throw new Error('not used'); }
  async loadDailyHealth(): Promise<MerchGridReviewEvidence | undefined> { return this.dailyArtifact; }
  async saveWeeklyReview(): Promise<string> { throw new Error('not used'); }
  async loadWeeklyReview(): Promise<MerchGridReviewEvidence | undefined> { return undefined; }
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
