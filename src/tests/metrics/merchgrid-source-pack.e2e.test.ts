import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CollectionWindow, DailyMetricSnapshot, MetricSource } from '../../contracts/metrics.js';
import type { MetricSourceAdapter } from '../../connectors/merchgrid/source.js';
import {
  JsonFileMerchGridReviewArtifactRepository,
  runDailyCollection,
  runWeeklyReview,
  type MerchGridSourcePackDependencies,
} from '../../jobs/merchgrid-source-pack.js';
import { JsonFileMetricSnapshotRepository } from '../../storage/metric-snapshots.js';

describe('MerchGrid source pack end to end', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('persists fourteen fake daily collections and an aggregate-only weekly review', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'merchgrid-source-pack-e2e-'));
    temporaryDirectories.push(rootDir);
    const dependencies: MerchGridSourcePackDependencies = {
      adapters: [
        fakeAdapter('posthog', { app_opened_count: 8 }),
        fakeAdapter('fly_metrics', { request_count: 100 }),
        fakeAdapter('shopify_partner', { installs: 2 }),
      ],
      repository: new JsonFileMetricSnapshotRepository({ rootDir: join(rootDir, 'snapshots') }),
      artifacts: new JsonFileMerchGridReviewArtifactRepository({ rootDir: join(rootDir, 'artifacts') }),
      now: () => new Date('2026-08-22T00:05:00.000Z'),
    };

    for (const date of datesThrough('2026-08-21', 14)) {
      await runDailyCollection({ date, dependencies });
    }
    const weekly = await runWeeklyReview({ through: '2026-08-21', dependencies });
    const persistedReview = await readFile(weekly.artifactPath, 'utf8');

    expect(weekly.sourceStatuses).toEqual({
      posthog: 'complete',
      fly_metrics: 'complete',
      shopify_partner: 'complete',
    });
    expect(weekly.review.aggregateMetrics).toEqual({
      previous: {
        posthog: { app_opened_count: 56 },
        fly_metrics: { request_count: 700 },
        shopify_partner: { installs: 14 },
      },
      current: {
        posthog: { app_opened_count: 56 },
        fly_metrics: { request_count: 700 },
        shopify_partner: { installs: 14 },
      },
      change: {
        posthog: { app_opened_count: 0 },
        fly_metrics: { request_count: 0 },
        shopify_partner: { installs: 0 },
      },
    });
    expect(persistedReview).not.toContain('token');
    expect(persistedReview).not.toContain('merchant');
    expect(persistedReview).not.toContain('payload');
  });
});

function fakeAdapter(source: MetricSource, metrics: Record<string, number>): MetricSourceAdapter {
  return {
    source,
    async collect(window: CollectionWindow): Promise<DailyMetricSnapshot> {
      return {
        source,
        date: window.date,
        collectedAt: '2026-08-22T00:05:00.000Z',
        status: 'complete',
        metrics,
        notes: [],
      };
    },
  };
}

function datesThrough(through: string, count: number): string[] {
  const end = new Date(`${through}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - (count - index - 1));
    return date.toISOString().slice(0, 10);
  });
}
