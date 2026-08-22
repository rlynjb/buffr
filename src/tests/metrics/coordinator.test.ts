import { describe, expect, it } from 'vitest';
import type { DailyMetricSnapshot } from '../../contracts/metrics.js';
import type { MetricSourceAdapter } from '../../connectors/merchgrid/source.js';
import { collectSourcePack } from '../../metrics/coordinator.js';
import type { MetricSnapshotRepository } from '../../storage/metric-snapshots.js';

const window = {
  date: '2026-08-21',
  startInclusive: '2026-08-21T00:00:00.000Z',
  endExclusive: '2026-08-22T00:00:00.000Z',
} as const;

describe('collectSourcePack', () => {
  it('saves PostHog and Fly results when Shopify throws', async () => {
    const repository = new MemoryMetricSnapshotRepository();
    const collectedSources: string[] = [];
    const adapters: MetricSourceAdapter[] = [
      completeAdapter('shopify_partner', { installs: 2 }, collectedSources, new Error('partner export failed: secret')),
      completeAdapter('fly_metrics', { request_count: 100 }, collectedSources),
      completeAdapter('posthog', { app_opened_count: 8 }, collectedSources),
    ];

    const snapshots = await collectSourcePack({ adapters, repository, window });

    expect(collectedSources).toEqual(['posthog', 'fly_metrics', 'shopify_partner']);
    expect(snapshots.map((snapshot) => snapshot.source)).toEqual(['posthog', 'fly_metrics', 'shopify_partner']);
    await expect(repository.load('posthog', window.date)).resolves.toMatchObject({ status: 'complete' });
    await expect(repository.load('fly_metrics', window.date)).resolves.toMatchObject({ status: 'complete' });
    await expect(repository.load('shopify_partner', window.date)).resolves.toMatchObject({
      status: 'failed',
      metrics: {},
      notes: ['transport'],
    });
    expect(JSON.stringify(snapshots)).not.toContain('partner export failed');
  });
});

function completeAdapter(
  source: MetricSourceAdapter['source'],
  metrics: Record<string, number>,
  collectedSources: string[],
  failure?: Error,
): MetricSourceAdapter {
  return {
    source,
    async collect(collectionWindow) {
      collectedSources.push(source);
      if (failure) {
        throw failure;
      }
      return {
        source,
        date: collectionWindow.date,
        collectedAt: '2026-08-22T00:05:00.000Z',
        status: 'complete',
        metrics,
        notes: [],
      };
    },
  };
}

class MemoryMetricSnapshotRepository implements MetricSnapshotRepository {
  private readonly snapshots = new Map<string, DailyMetricSnapshot>();

  async load(source: DailyMetricSnapshot['source'], date: string): Promise<DailyMetricSnapshot | undefined> {
    return this.snapshots.get(`${source}:${date}`);
  }

  async save(snapshot: DailyMetricSnapshot): Promise<'created' | 'unchanged' | 'replaced_noncomplete'> {
    this.snapshots.set(`${snapshot.source}:${snapshot.date}`, snapshot);
    return 'created';
  }

  async list(): Promise<DailyMetricSnapshot[]> {
    return [...this.snapshots.values()];
  }
}
