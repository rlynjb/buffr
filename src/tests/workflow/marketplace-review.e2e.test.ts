import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarketplaceVisibilityModuleExecutor } from '../../agents/marketplace-visibility/modules.js';
import { FakeAgentRunner } from '../../agents/runner.js';
import type { MarketplaceProductIdentity, MarketplaceVisibilityContext } from '../../contracts/marketplace-visibility.js';
import type { CollectionWindow, DailyMetricSnapshot, MetricSource } from '../../contracts/metrics.js';
import type { MetricSourceAdapter } from '../../connectors/merchgrid/source.js';
import { JsonFileMerchGridReviewArtifactRepository, type MerchGridSourcePackDependencies } from '../../jobs/merchgrid-source-pack.js';
import { JsonFileMetricSnapshotRepository } from '../../storage/metric-snapshots.js';
import { JsonFileReviewOperationEventRepository } from '../../storage/review-operations.js';
import { JsonFileRunRepository } from '../../storage/runs.js';
import { createWorkflowEngine } from '../../workflow/engine.js';
import { createMarketplaceEvidencePreparationService } from '../../workflow/marketplace-evidence-preparation.js';
import { createMarketplaceReviewService } from '../../workflow/marketplace-review.js';
import { createMarketplaceRollingReviewService, type OwnerApplicationPrompt } from '../../workflow/marketplace-rolling-review.js';

describe('marketplace review persisted command flow', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('collects missing evidence, generates a weekly review, and starts one rolling workflow run', async () => {
    const fixture = await createFixture();
    await fixture.seedCompleteWindow('2026-08-22', '2026-09-04', new Set(['posthog/2026-09-04']));

    const first = await fixture.review.review(reviewInput(fixture.contextPath));
    const second = await fixture.review.review(reviewInput(fixture.contextPath));
    const current = await fixture.runs.load(first.currentRun.runId);
    const events = await fixture.operations.loadEvents(first.operationId);

    expect(first.currentRun.runId).toBe(second.currentRun.runId);
    expect(first.weeklyArtifactStatus).toBe('generated');
    expect(second.weeklyArtifactStatus).toBe('reused');
    expect(fixture.adapterCalls).toEqual(['posthog/2026-09-04']);
    expect(current).toMatchObject({
      marketplaceIdentity: productIdentity,
      status: 'awaiting_approval',
      stage: 'approval_wait',
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'marketplace_review.evidence_preparation.started' }),
      expect.objectContaining({ type: 'marketplace_review.weekly_artifact.generated' }),
      expect.objectContaining({ type: 'marketplace_review.workflow.completed' }),
    ]));
    await expect(readFile(join(fixture.artifactRoot, 'weekly-reviews', '2026-09-04.json'), 'utf8'))
      .resolves.toContain('"kind": "weekly"');
    expect(JSON.stringify(events)).not.toMatch(/OPENAI_API_KEY|POSTHOG_PERSONAL_API_KEY|FLY_ACCESS_TOKEN|rawEvents|providerPayload|prompt/iu);
  });

  async function createFixture() {
    const rootDir = await mkdtemp(join(tmpdir(), 'marketplace-review-e2e-'));
    temporaryDirectories.push(rootDir);
    const artifactRoot = join(rootDir, 'artifacts');
    const contextPath = join(rootDir, 'context.json');
    await writeFile(contextPath, `${JSON.stringify(marketplaceContext, null, 2)}\n`, 'utf8');
    const repository = new JsonFileMetricSnapshotRepository({ rootDir: join(rootDir, 'snapshots') });
    const artifacts = new JsonFileMerchGridReviewArtifactRepository({ rootDir: artifactRoot });
    const operations = new JsonFileReviewOperationEventRepository({ rootDir });
    const adapterCalls: string[] = [];
    const sourcePack: MerchGridSourcePackDependencies = {
      adapters: [
        fakeAdapter('posthog', { app_opened_count: 8, scan_started_count: 2 }, adapterCalls),
        fakeAdapter('fly_metrics', { request_count: 100 }, adapterCalls),
        fakeAdapter('shopify_partner', { installs: 2 }, adapterCalls),
      ],
      repository,
      artifacts,
      now: fixedNow,
      emit: async (event) => {
        await operations.appendEvent(event.runId, event);
      },
    };
    const evidence = createMarketplaceEvidencePreparationService({
      sourcePack,
      repository,
      artifacts,
      artifactRootRef: logicalArtifactRoot,
      now: fixedNow,
      emit: async (event) => {
        await operations.appendEvent(event.runId, event);
      },
    });
    const runs = new JsonFileRunRepository({ rootDir: join(rootDir, 'runs') });
    const engine = createWorkflowEngine({
      repository: runs,
      modules: createMarketplaceVisibilityModuleExecutor({ agentRunner: fakeAgent() }),
      now: fixedNow,
    });
    const rollingReviews = createMarketplaceRollingReviewService({
      history: runs,
      engine,
      prompt: new CancelledPrompt(),
      now: fixedNow,
      prepareWeeklyEvidence: async (input) => (await evidence.prepare(input)).evidence,
    });
    const review = createMarketplaceReviewService({
      evidence,
      rollingReviews,
      operations,
      now: fixedNow,
    });

    return {
      artifactRoot,
      adapterCalls,
      contextPath,
      operations,
      review,
      runs,
      async seedCompleteWindow(start: string, end: string, omitted = new Set<string>()) {
        for (const source of sources) {
          for (const date of datesBetween(start, end)) {
            if (omitted.has(`${source}/${date}`)) continue;
            await repository.save(completeSnapshot(source, date));
          }
        }
      },
    };
  }
});

const sources: readonly MetricSource[] = ['posthog', 'fly_metrics', 'shopify_partner'];
const logicalArtifactRoot = 'artifacts/merchgrid/metrics/artifacts';

const productIdentity: MarketplaceProductIdentity = {
  profile: 'merchgrid_shopify_app_store',
  productRef: 'merchgrid-shopify-app',
};

const marketplaceContext: MarketplaceVisibilityContext = {
  productRef: productIdentity.productRef,
  marketplace: 'shopify_app_store',
  productName: 'MerchGrid',
  productType: 'shopify_app',
  targetCustomer: 'Shopify merchants auditing catalog quality',
  customerProblem: 'Catalog issues can hurt trust before merchants notice',
  currentPromise: 'Find catalog issues before they hurt sales or trust',
  currentSurfaceSummary: 'Shopify app listing for catalog audits',
  primaryDiscoverySurface: 'Shopify App Store search and category pages',
  primaryActionWanted: 'Open the app and run a catalog audit',
  constraints: ['manual listing changes only'],
  availableAssets: ['listing copy', 'screenshots'],
  ownerGoal: 'increase qualified app opens and first scans',
};

function reviewInput(contextPath: string) {
  return {
    profile: productIdentity.profile,
    productRef: productIdentity.productRef,
    through: '2026-09-04',
    contextPath,
  };
}

function fakeAgent() {
  return new FakeAgentRunner({
    m4: {
      performancePath: 'discovery',
      primaryBottleneck: 'The first listing line may not state the catalog audit outcome quickly enough.',
      competingExplanation: 'Marketplace exposure may remain too sparse to distinguish copy effects.',
      confidence: 'low',
      decision: 'proceed_to_hypothesis',
      notes: ['Treat this as an exploratory review.'],
    },
    m5: {
      hypothesis: 'A clearer first listing line may improve qualified app opens.',
      primaryVariable: 'listing opening line',
      recommendedRevision: 'Lead with the first catalog audit outcome.',
      keepConstant: ['pricing', 'app behavior'],
      expectedSignal: 'More qualified app opens appear in a later weekly review.',
      notes: [],
    },
    m6: {
      primaryMetric: 'app_opened_count',
      secondaryMetrics: ['scan_started_count'],
      baselineValue: 14,
      baselinePeriod: 'persisted weekly baseline',
      qualificationRequirements: ['Use one later complete weekly review.'],
      expectedSupportingSignal: 'Qualified app opens increase.',
      expectedWeakeningSignal: 'Qualified app opens stay flat or decline.',
      inconclusiveCondition: 'Marketplace exposure remains sparse.',
      contextToMonitor: ['listing copy changed manually'],
      unresolvedMeasurementRules: [],
    },
  });
}

class CancelledPrompt implements OwnerApplicationPrompt {
  async confirm() {
    return { status: 'cancelled' as const };
  }
}

function fakeAdapter(source: MetricSource, metrics: Record<string, number>, calls: string[]): MetricSourceAdapter {
  return {
    source,
    async collect(window: CollectionWindow): Promise<DailyMetricSnapshot> {
      calls.push(`${source}/${window.date}`);
      return { ...completeSnapshot(source, window.date), metrics };
    },
  };
}

function completeSnapshot(source: MetricSource, date: string): DailyMetricSnapshot {
  return {
    source,
    date,
    collectedAt: fixedNow().toISOString(),
    status: 'complete',
    metrics: source === 'posthog'
      ? { app_opened_count: 8, scan_started_count: 2 }
      : source === 'fly_metrics'
        ? { request_count: 100 }
        : { installs: 2 },
    notes: [],
  };
}

function datesBetween(start: string, end: string): string[] {
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const final = new Date(`${end}T00:00:00.000Z`);
  const dates: string[] = [];
  while (cursor <= final) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function fixedNow(): Date {
  return new Date('2026-09-08T00:05:00.000Z');
}
