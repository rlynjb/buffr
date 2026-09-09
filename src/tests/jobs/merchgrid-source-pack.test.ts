import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionWindow, DailyMetricSnapshot, MetricSource } from '../../contracts/metrics.js';
import type { WorkflowEvent } from '../../contracts/workflow.js';
import {
  createMerchGridSourcePackDependencies,
  runMerchGridSourcePackCli,
  runMerchGridSourcePackEntrypoint,
} from '../../cli/merchgrid-source-pack.js';
import type { HttpClient, HttpRequest, MetricSourceAdapter } from '../../connectors/merchgrid/source.js';
import {
  JsonFileMerchGridReviewArtifactRepository,
  resolveLatestCompleteWeeklyThrough,
  runDailyCollection,
  runWeeklyReview,
  type MerchGridSourcePackDependencies,
} from '../../jobs/merchgrid-source-pack.js';
import { JsonFileMetricSnapshotRepository } from '../../storage/metric-snapshots.js';

describe('MerchGrid source-pack jobs', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('collects a completed UTC day and writes aggregate-only daily health evidence', async () => {
    const dependencies = await fakeDependencies();

    const result = await runDailyCollection({ date: '2026-08-21', dependencies });

    expect(result.sourceStatuses).toEqual({
      posthog: 'complete',
      fly_metrics: 'complete',
      shopify_partner: 'complete',
    });
    await expect(dependencies.artifacts.loadDailyHealth('2026-08-21')).resolves.toEqual({
      period: { kind: 'daily', date: '2026-08-21' },
      sourceCoverage: result.sourceStatuses,
      sourceFreshness: {
        posthog: {
          date: '2026-08-21',
          collectedAt: '2026-08-22T00:05:00.000Z',
          status: 'complete',
          notes: [],
        },
        fly_metrics: {
          date: '2026-08-21',
          collectedAt: '2026-08-22T00:05:00.000Z',
          status: 'complete',
          notes: [],
        },
        shopify_partner: {
          date: '2026-08-21',
          collectedAt: '2026-08-22T00:05:00.000Z',
          status: 'complete',
          notes: [],
        },
      },
      aggregateMetrics: {
        posthog: { app_opened_count: 8 },
        fly_metrics: { request_count: 100 },
        shopify_partner: { installs: 2 },
      },
      limitations: [],
    });
    expect(result.artifactPath).toContain('daily-health');
  });

  it('rejects an open or future date before collecting from any source', async () => {
    const dependencies = await fakeDependencies();

    await expect(runDailyCollection({ date: '2026-08-22', dependencies })).rejects.toThrow(
      'Metric window date must be before today in UTC: 2026-08-22',
    );
    await expect(dependencies.artifacts.loadDailyHealth('2026-08-22')).resolves.toBeUndefined();
  });

  it('reuses completed source snapshots when a daily command is retried', async () => {
    const baseDependencies = await fakeDependencies();
    let posthogCollections = 0;
    const dependencies: MerchGridSourcePackDependencies = {
      ...baseDependencies,
      adapters: [
      {
        source: 'posthog',
        async collect(window) {
          posthogCollections += 1;
          return {
            source: 'posthog',
            date: window.date,
            collectedAt: `2026-08-22T00:05:0${posthogCollections}.000Z`,
            status: 'complete',
            metrics: { app_opened_count: 8 },
            notes: [],
          };
        },
      },
      completeAdapter('fly_metrics', { request_count: 100 }),
      completeAdapter('shopify_partner', { installs: 2 }),
      ],
    };

    await runDailyCollection({ date: '2026-08-21', dependencies });
    await runDailyCollection({ date: '2026-08-21', dependencies });

    expect(posthogCollections).toBe(1);
  });

  it('marks newly collected historical snapshots as backfills while retaining source provenance', async () => {
    const baseDependencies = await fakeDependencies();
    const dependencies: MerchGridSourcePackDependencies = {
      ...baseDependencies,
      adapters: [
        completeAdapter('posthog', { app_opened_count: 8 }),
        completeAdapter('fly_metrics', { request_count: 100 }),
        completeAdapter('shopify_partner', { installs: 2 }, ['manual_import']),
      ],
    };

    const result = await runDailyCollection({ date: '2026-08-20', dependencies });

    await expect(dependencies.repository.load('posthog', '2026-08-20')).resolves.toMatchObject({
      collectedAt: '2026-08-22T00:05:00.000Z',
      notes: ['backfill'],
    });
    await expect(dependencies.repository.load('shopify_partner', '2026-08-20')).resolves.toMatchObject({
      notes: ['manual_import', 'backfill'],
    });
    expect(result.health.sourceFreshness.shopify_partner?.notes).toEqual(['manual_import', 'backfill']);
  });

  it('does not rewrite an existing complete historical snapshot merely to add backfill provenance', async () => {
    const dependencies = await fakeDependencies();
    const historical: DailyMetricSnapshot = {
      source: 'posthog',
      date: '2026-08-20',
      collectedAt: '2026-08-21T00:05:00.000Z',
      status: 'complete',
      metrics: { app_opened_count: 7 },
      notes: [],
    };
    await dependencies.repository.save(historical);

    await runDailyCollection({ date: '2026-08-20', dependencies });

    await expect(dependencies.repository.load('posthog', '2026-08-20')).resolves.toEqual(historical);
  });

  it('writes partial daily evidence and emits later-source events after an adapter stalls', async () => {
    const baseDependencies = await fakeDependencies();
    const events: WorkflowEvent[] = [];
    const dependencies: MerchGridSourcePackDependencies = {
      ...baseDependencies,
      adapters: [
        {
          source: 'posthog',
          async collect() {
            return new Promise<DailyMetricSnapshot>(() => undefined);
          },
        },
        completeAdapter('fly_metrics', { request_count: 100 }),
        completeAdapter('shopify_partner', { installs: 2 }),
      ],
      sourceTimeoutMs: 0,
      emit: (event) => {
        events.push(event);
      },
    };

    const result = await runDailyCollection({ date: '2026-08-21', dependencies });

    expect(result.sourceStatuses).toEqual({
      posthog: 'failed',
      fly_metrics: 'complete',
      shopify_partner: 'complete',
    });
    await expect(dependencies.artifacts.loadDailyHealth('2026-08-21')).resolves.toMatchObject({
      sourceCoverage: {
        posthog: 'failed',
        fly_metrics: 'complete',
        shopify_partner: 'complete',
      },
      limitations: ['posthog:failed'],
    });
    expect(events.map((event) => event.type)).toContain('merchgrid.source.failed');
    expect(events.map((event) => event.data.source)).toEqual([
      'posthog',
      'posthog',
      'fly_metrics',
      'fly_metrics',
      'shopify_partner',
      'shopify_partner',
    ]);
  });

  it('derives adjacent seven-day windows, loads stored snapshots, and writes a weekly review', async () => {
    const dependencies = await fakeDependencies();
    for (const date of datesThrough('2026-08-21', 14)) {
      await runDailyCollection({ date, dependencies });
    }

    const result = await runWeeklyReview({ through: '2026-08-21', dependencies });

    expect(result.review.period).toEqual({
      previous: { startDate: '2026-08-08', endDate: '2026-08-14' },
      current: { startDate: '2026-08-15', endDate: '2026-08-21' },
    });
    expect(result.sourceStatuses).toEqual({
      posthog: 'complete',
      fly_metrics: 'complete',
      shopify_partner: 'complete',
    });
    await expect(dependencies.artifacts.loadWeeklyReview('2026-08-21')).resolves.toMatchObject({
      period: {
        kind: 'weekly',
        previous: { startDate: '2026-08-08', endDate: '2026-08-14' },
        current: { startDate: '2026-08-15', endDate: '2026-08-21' },
      },
      sourceCoverage: result.review.sourceCoverage,
    });
    expect(result.artifactPath).toContain('weekly-reviews');
  });

  it('selects the newest completed date with two complete seven-day source windows', async () => {
    const dependencies = await fakeDependencies();
    for (const date of datesThrough('2026-08-21', 14)) {
      await runDailyCollection({ date, dependencies });
    }
    await dependencies.repository.save({
      source: 'posthog',
      date: '2026-08-22',
      collectedAt: '2026-08-23T00:05:00.000Z',
      status: 'complete',
      metrics: { app_opened_count: 9 },
      notes: [],
    });

    await expect(resolveLatestCompleteWeeklyThrough({
      repository: dependencies.repository,
      now: new Date('2026-08-24T00:05:00.000Z'),
    })).resolves.toBe('2026-08-21');
  });

  it('reports the latest window gaps when no complete evidence window exists', async () => {
    const dependencies = await fakeDependencies();

    await expect(resolveLatestCompleteWeeklyThrough({
      repository: dependencies.repository,
      now: new Date('2026-08-24T00:05:00.000Z'),
    })).rejects.toMatchObject({
      code: 'storage_failed',
      message: expect.stringContaining('Missing weekly metric snapshots (42): posthog/2026-08-10'),
    });
  });

  it('reports every exact missing weekly source-date before derivation or artifact writes', async () => {
    const dependencies = await fakeDependencies();
    const missing = new Set(['posthog/2026-08-10', 'fly_metrics/2026-08-20']);

    for (const source of ['posthog', 'fly_metrics', 'shopify_partner'] as const) {
      for (const date of datesThrough('2026-08-21', 14)) {
        if (missing.has(`${source}/${date}`)) continue;
        await dependencies.repository.save({
          source,
          date,
          collectedAt: '2026-08-22T00:05:00.000Z',
          status: 'complete',
          metrics: source === 'posthog'
            ? { app_opened_count: 8 }
            : source === 'fly_metrics'
              ? { request_count: 100 }
              : { installs: 2 },
          notes: [],
        });
      }
    }

    await expect(runWeeklyReview({ through: '2026-08-21', dependencies: { ...dependencies, adapters: [] } }))
      .rejects.toMatchObject({
        code: 'storage_failed',
        message: 'Missing weekly metric snapshots (2): posthog/2026-08-10, fly_metrics/2026-08-20',
      });
    await expect(dependencies.artifacts.loadWeeklyReview('2026-08-21')).resolves.toBeUndefined();
  });

  it('rejects a saved artifact that does not satisfy the aggregate evidence schema', async () => {
    const dependencies = await fakeDependencies();
    const result = await runDailyCollection({ date: '2026-08-21', dependencies });

    await writeFile(result.artifactPath, JSON.stringify({ rawEvents: [{ event: 'scan_started' }] }), 'utf8');

    await expect(dependencies.artifacts.loadDailyHealth('2026-08-21')).rejects.toThrow();
  });

  it('prints only the daily artifact path and normalized source statuses', async () => {
    const dependencies = await fakeDependencies();
    const lines: string[] = [];

    await runMerchGridSourcePackCli({
      args: ['collect', '--date', '2026-08-21'],
      dependencies,
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      expect.stringMatching(/^artifact: .+daily-health\/2026-08-21\.json$/u),
      'sources: posthog=complete fly_metrics=complete shopify_partner=complete',
    ]);
    expect(JSON.stringify(lines)).not.toContain('app_opened_count');
    expect(JSON.stringify(lines)).not.toContain('100');
  });

  it('accepts --through for the explicit weekly-review command', async () => {
    const dependencies = await fakeDependencies();
    for (const date of datesThrough('2026-08-21', 14)) {
      await runDailyCollection({ date, dependencies });
    }
    const lines: string[] = [];

    await runMerchGridSourcePackCli({
      args: ['weekly-review', '--through', '2026-08-21'],
      dependencies,
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      expect.stringMatching(/^artifact: .+weekly-reviews\/2026-08-21\.json$/u),
      'sources: posthog=complete fly_metrics=complete shopify_partner=complete',
    ]);
  });

  it('configures the Fly adapter with the Prometheus query endpoint', async () => {
    const requestedUrls: string[] = [];
    const http: HttpClient = {
      async request<T>(request: HttpRequest) {
        requestedUrls.push(request.url);
        return {
          status: 200,
          body: {
            status: 'success',
            data: { resultType: 'vector', result: [] },
          } as T,
        };
      },
    };
    const dependencies = createMerchGridSourcePackDependencies({ env: fakeRuntimeEnvironment(), http });
    const fly = dependencies.adapters.find((adapter) => adapter.source === 'fly_metrics')!;

    await fly.collect({
      date: '2026-08-21',
      startInclusive: '2026-08-21T00:00:00.000Z',
      endExclusive: '2026-08-22T00:00:00.000Z',
    });

    expect(requestedUrls).toEqual(['https://api.fly.io/prometheus/buffr-test/api/v1/query']);
  });

  it('reports missing runtime configuration through the bounded CLI error channel', async () => {
    const output: string[] = [];
    const errors: string[] = [];

    await runMerchGridSourcePackEntrypoint({
      args: ['collect', '--date', '2026-08-21'],
      env: {},
      writeLine: (line) => output.push(line),
      writeError: (line) => errors.push(line),
    });

    expect(output).toEqual([]);
    expect(errors).toEqual(['configuration_failed']);
  });

  async function fakeDependencies(): Promise<MerchGridSourcePackDependencies> {
    const rootDir = await mkdtemp(join(tmpdir(), 'merchgrid-source-pack-job-'));
    temporaryDirectories.push(rootDir);
    return {
      adapters: [
        completeAdapter('posthog', { app_opened_count: 8 }),
        completeAdapter('fly_metrics', { request_count: 100 }),
        completeAdapter('shopify_partner', { installs: 2 }),
      ],
      repository: new JsonFileMetricSnapshotRepository({ rootDir: join(rootDir, 'snapshots') }),
      artifacts: new JsonFileMerchGridReviewArtifactRepository({ rootDir: join(rootDir, 'artifacts') }),
      now: () => new Date('2026-08-22T00:05:00.000Z'),
    };
  }
});

function fakeRuntimeEnvironment(): NodeJS.ProcessEnv {
  return {
    POSTHOG_PROJECT_ID: 'test-project',
    POSTHOG_PERSONAL_API_KEY: 'test-key',
    POSTHOG_BASE_URL: 'https://posthog.example.test',
    FLY_ORG_SLUG: 'buffr-test',
    FLY_ACCESS_TOKEN: 'test-token',
    FLY_APP_NAME: 'buffr-test-app',
    MERCHGRID_METRICS_DATA_DIR: '/tmp/merchgrid-test-data',
    SHOPIFY_PARTNER_AGGREGATES_CSV_PATH: '/tmp/merchgrid-test.csv',
  };
}

function completeAdapter(
  source: MetricSource,
  metrics: Record<string, number>,
  notes: DailyMetricSnapshot['notes'] = [],
): MetricSourceAdapter {
  return {
    source,
    async collect(window: CollectionWindow): Promise<DailyMetricSnapshot> {
      return {
        source,
        date: window.date,
        collectedAt: '2026-08-22T00:05:00.000Z',
        status: 'complete',
        metrics,
        notes,
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
