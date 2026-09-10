import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MarketplaceProductIdentity } from '../../contracts/marketplace-visibility.js';
import type { CollectionWindow, DailyMetricSnapshot, MetricSource } from '../../contracts/metrics.js';
import type { WorkflowEvent } from '../../contracts/workflow.js';
import type { MetricSourceAdapter } from '../../connectors/merchgrid/source.js';
import {
  JsonFileMerchGridReviewArtifactRepository,
  runWeeklyReview,
  type MerchGridSourcePackDependencies,
} from '../../jobs/merchgrid-source-pack.js';
import { JsonFileMetricSnapshotRepository } from '../../storage/metric-snapshots.js';
import { createMarketplaceEvidencePreparationService } from '../../workflow/marketplace-evidence-preparation.js';

describe('marketplace evidence preparation', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('reuses complete snapshots and an existing weekly artifact without collecting sources', async () => {
    const fixture = await createFixture();
    await fixture.seedCompleteWindow('2026-08-22', '2026-09-04');
    await runWeeklyReview({ through: '2026-09-04', dependencies: fixture.sourcePack });

    const prepared = await fixture.service.prepare(reviewInput({ through: '2026-09-04', contextPath: fixture.contextPath }));

    expect(prepared).toMatchObject({
      through: '2026-09-04',
      weeklyArtifactStatus: 'reused',
      reusedSnapshotCount: 42,
      collectedSnapshotCount: 0,
      missingSnapshotCount: 0,
    });
    expect(fixture.adapterCalls).toEqual([]);
    expect(fixture.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'marketplace_review.evidence_preparation.started',
      'marketplace_review.weekly_artifact.reused',
      'marketplace_review.evidence_preparation.completed',
    ]));
  });

  it('collects only missing completed source snapshots before generating the weekly artifact', async () => {
    const fixture = await createFixture();
    await fixture.seedCompleteWindow('2026-08-22', '2026-09-04', new Set(['posthog/2026-09-04']));

    const prepared = await fixture.service.prepare(reviewInput({ through: '2026-09-04', contextPath: fixture.contextPath }));

    expect(fixture.adapterCalls).toEqual(['posthog/2026-09-04']);
    expect(prepared.weeklyArtifactStatus).toBe('generated');
    expect(prepared).toMatchObject({
      reusedSnapshotCount: 41,
      collectedSnapshotCount: 1,
      missingSnapshotCount: 0,
    });
    expect(fixture.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'marketplace_review.daily_snapshot.collection_required',
        data: { source: 'posthog', date: '2026-09-04' },
      }),
      expect.objectContaining({
        type: 'marketplace_review.daily_collection.completed',
        data: expect.objectContaining({ date: '2026-09-04', missingSnapshotCount: 0 }),
      }),
      expect.objectContaining({ type: 'marketplace_review.weekly_artifact.generated' }),
    ]));
  });

  it('fails before weekly evidence is prepared when required coverage stays incomplete', async () => {
    const fixture = await createFixture({ failPosthog: true });
    await fixture.seedCompleteWindow('2026-08-22', '2026-09-04', new Set(['posthog/2026-09-04']));

    await expect(fixture.service.prepare(reviewInput({ through: '2026-09-04', contextPath: fixture.contextPath })))
      .rejects.toMatchObject({
        code: 'storage_failed',
        message: expect.stringContaining('Missing weekly metric snapshots (1): posthog/2026-09-04'),
      });
    expect(fixture.events.map((event) => event.type)).toContain('marketplace_review.evidence_preparation.failed');
  });

  it('rejects an open UTC through date before collecting sources', async () => {
    const fixture = await createFixture();

    await expect(fixture.service.prepare(reviewInput({ through: '2026-09-08', contextPath: fixture.contextPath })))
      .rejects.toThrow('Metric window date must be before today in UTC: 2026-09-08');
    expect(fixture.adapterCalls).toEqual([]);
  });

  it('does not put raw or credential-shaped values into trace events', async () => {
    const fixture = await createFixture();
    await fixture.seedCompleteWindow('2026-08-22', '2026-09-04', new Set(['posthog/2026-09-04']));

    await fixture.service.prepare(reviewInput({ through: '2026-09-04', contextPath: fixture.contextPath }));

    expect(JSON.stringify(fixture.events)).not.toMatch(/OPENAI_API_KEY|POSTHOG_PERSONAL_API_KEY|FLY_ACCESS_TOKEN|rawEvents|providerPayload|merchant@example\.com|prompt/iu);
  });

  async function createFixture(input: { failPosthog?: boolean } = {}) {
    const rootDir = await mkdtemp(join(tmpdir(), 'marketplace-evidence-prep-'));
    temporaryDirectories.push(rootDir);
    const contextPath = join(rootDir, 'context.json');
    await writeFile(contextPath, `${JSON.stringify(marketplaceContext, null, 2)}\n`, 'utf8');
    const repository = new JsonFileMetricSnapshotRepository({ rootDir: join(rootDir, 'snapshots') });
    const artifacts = new JsonFileMerchGridReviewArtifactRepository({ rootDir: join(rootDir, 'artifacts') });
    const adapterCalls: string[] = [];
    const sourcePack: MerchGridSourcePackDependencies = {
      adapters: [
        input.failPosthog
          ? failedAdapter('posthog', adapterCalls)
          : completeAdapter('posthog', { app_opened_count: 8 }, adapterCalls),
        completeAdapter('fly_metrics', { request_count: 100 }, adapterCalls),
        completeAdapter('shopify_partner', { installs: 2 }, adapterCalls),
      ],
      repository,
      artifacts,
      now: fixedNow,
    };
    const events: WorkflowEvent[] = [];
    const service = createMarketplaceEvidencePreparationService({
      sourcePack,
      repository,
      artifacts,
      artifactRootRef: 'artifacts/merchgrid/metrics/artifacts',
      now: fixedNow,
      emit: (event) => {
        events.push(event);
      },
    });

    return {
      contextPath,
      adapterCalls,
      sourcePack,
      service,
      events,
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

const productIdentity: MarketplaceProductIdentity = {
  profile: 'merchgrid_shopify_app_store',
  productRef: 'merchgrid-shopify-app',
};

const marketplaceContext = {
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

function reviewInput(input: { through: string; contextPath: string }) {
  return {
    profile: productIdentity.profile,
    productRef: productIdentity.productRef,
    through: input.through,
    contextPath: input.contextPath,
  };
}

function completeAdapter(source: MetricSource, metrics: Record<string, number>, calls: string[]): MetricSourceAdapter {
  return {
    source,
    async collect(window: CollectionWindow): Promise<DailyMetricSnapshot> {
      calls.push(`${source}/${window.date}`);
      return { ...completeSnapshot(source, window.date), metrics };
    },
  };
}

function failedAdapter(source: MetricSource, calls: string[]): MetricSourceAdapter {
  return {
    source,
    async collect(window: CollectionWindow): Promise<DailyMetricSnapshot> {
      calls.push(`${source}/${window.date}`);
      return {
        source,
        date: window.date,
        collectedAt: fixedNow().toISOString(),
        status: 'failed',
        metrics: {},
        notes: ['transport'],
      };
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
