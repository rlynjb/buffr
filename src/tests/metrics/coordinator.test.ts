import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DailyMetricSnapshot } from '../../contracts/metrics.js';
import type { WorkflowEvent } from '../../contracts/workflow.js';
import type { MetricSourceAdapter } from '../../connectors/merchgrid/source.js';
import { collectSourcePack } from '../../metrics/coordinator.js';
import type { MetricSnapshotRepository } from '../../storage/metric-snapshots.js';

const window = {
  date: '2026-08-21',
  startInclusive: '2026-08-21T00:00:00.000Z',
  endExclusive: '2026-08-22T00:00:00.000Z',
} as const;

describe('collectSourcePack', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('continues to Fly and Shopify when the first PostHog source throws', async () => {
    const repository = new MemoryMetricSnapshotRepository();
    const collectedSources: string[] = [];
    const adapters: MetricSourceAdapter[] = [
      completeAdapter('shopify_partner', { installs: 2 }, collectedSources),
      completeAdapter('fly_metrics', { request_count: 100 }, collectedSources),
      completeAdapter('posthog', { app_opened_count: 8 }, collectedSources, new Error('query failed: secret')),
    ];

    const snapshots = await collectSourcePack({ adapters, repository, window });

    expect(collectedSources).toEqual(['posthog', 'fly_metrics', 'shopify_partner']);
    expect(snapshots.map((snapshot) => snapshot.source)).toEqual(['posthog', 'fly_metrics', 'shopify_partner']);
    await expect(repository.load('posthog', window.date)).resolves.toMatchObject({
      status: 'failed',
      metrics: {},
      notes: ['transport'],
    });
    await expect(repository.load('fly_metrics', window.date)).resolves.toMatchObject({ status: 'complete' });
    await expect(repository.load('shopify_partner', window.date)).resolves.toMatchObject({ status: 'complete' });
    expect(JSON.stringify(snapshots)).not.toContain('query failed');
  });

  it('classifies malformed adapter output as a schema failure', async () => {
    const repository = new MemoryMetricSnapshotRepository();
    const adapter: MetricSourceAdapter = {
      source: 'posthog',
      async collect() {
        return {
          source: 'posthog',
          date: window.date,
          metrics: { app_opened_count: Number.NaN },
        } as unknown as DailyMetricSnapshot;
      },
    };

    const [snapshot] = await collectSourcePack({ adapters: [adapter], repository, window });

    expect(snapshot).toMatchObject({ status: 'failed', metrics: {}, notes: ['schema'] });
  });

  it('bounds a stalled source and continues to later sources without a real wait', async () => {
    vi.useFakeTimers();
    const repository = new MemoryMetricSnapshotRepository();
    const collectedSources: string[] = [];
    const adapters: MetricSourceAdapter[] = [
      {
        source: 'posthog',
        async collect() {
          collectedSources.push('posthog');
          return new Promise<DailyMetricSnapshot>(() => undefined);
        },
      },
      completeAdapter('fly_metrics', { request_count: 100 }, collectedSources),
      completeAdapter('shopify_partner', { installs: 2 }, collectedSources),
    ];

    let result: DailyMetricSnapshot[] | undefined;
    void collectSourcePack({ adapters, repository, window, sourceTimeoutMs: 50 }).then((snapshots) => {
      result = snapshots;
    });
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(collectedSources).toEqual(['posthog', 'fly_metrics', 'shopify_partner']);
    expect(result).toEqual([
      expect.objectContaining({ source: 'posthog', status: 'failed', notes: ['transport'] }),
      expect.objectContaining({ source: 'fly_metrics', status: 'complete' }),
      expect.objectContaining({ source: 'shopify_partner', status: 'complete' }),
    ]);
  });

  it('emits privacy-safe source start, completion, partial, and failure events', async () => {
    const repository = new MemoryMetricSnapshotRepository();
    const events: WorkflowEvent[] = [];
    const adapters: MetricSourceAdapter[] = [
      completeAdapter('posthog', { app_opened_count: 8 }, []),
      {
        source: 'fly_metrics',
        async collect(collectionWindow) {
          return {
            source: 'fly_metrics',
            date: collectionWindow.date,
            collectedAt: '2026-08-22T00:05:00.000Z',
            status: 'unavailable',
            metrics: {},
            notes: ['no_metrics'],
          };
        },
      },
      completeAdapter('shopify_partner', {}, [], new Error('merchant@example.com secret token')),
    ];

    await collectSourcePack({
      adapters,
      repository,
      window,
      runId: 'merchgrid-source-pack:2026-08-21',
      emit: (event) => {
        events.push(event);
      },
      now: () => new Date('2026-08-22T00:05:00.000Z'),
    });

    expect(events.map((event) => event.type)).toEqual([
      'merchgrid.source.started',
      'merchgrid.source.completed',
      'merchgrid.source.started',
      'merchgrid.source.partial',
      'merchgrid.source.started',
      'merchgrid.source.failed',
    ]);
    expect(events.map((event) => event.data)).toEqual([
      { source: 'posthog', date: window.date },
      { source: 'posthog', date: window.date, status: 'complete' },
      { source: 'fly_metrics', date: window.date },
      { source: 'fly_metrics', date: window.date, status: 'unavailable' },
      { source: 'shopify_partner', date: window.date },
      { source: 'shopify_partner', date: window.date, status: 'failed' },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/merchant@example\.com|secret|token/iu);
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
