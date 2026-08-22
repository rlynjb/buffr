import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DailyMetricSnapshotSchema } from '../../contracts/metrics.js';
import { FlyMetricsSourceAdapter } from '../../connectors/merchgrid/fly-metrics.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../../connectors/merchgrid/source.js';
import { JsonFileMetricSnapshotRepository } from '../../storage/metric-snapshots.js';
import { completedMerchGridWindow } from '../fixtures/merchgrid-metrics.js';

describe('Fly reliability metrics adapter', () => {
  it('derives an error rate from completed-window edge response totals', async () => {
    const fakeHttp = new SequentialFakeHttpClient();
    fakeHttp.respond(prometheusStatusVector([['200', 97], ['503', 3]]));

    await expect(adapterFor(fakeHttp).collect(completedMerchGridWindow)).resolves.toEqual({
      source: 'fly_metrics',
      date: '2026-08-21',
      collectedAt: '2026-08-22T00:05:00.000Z',
      status: 'complete',
      metrics: { request_count: 100, error_response_count: 3, error_rate: 0.03 },
      notes: [],
    });
    expect(fakeHttp.requests).toEqual([{
      method: 'POST',
      url: 'https://api.fly.example.test/prometheus/acme/api/v1/query',
      headers: {
        authorization: 'Bearer fly-access-token',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body:
        'query=sum+by+%28status%29+%28increase%28fly_edge_http_responses_count%7Bapp%3D%22merchgrid%22%7D%5B1d%5D%29%29&time=2026-08-22T00%3A00%3A00.000Z',
    }]);
  });

  it('produces a complete snapshot accepted by the schema and repository', async () => {
    const fakeHttp = new SequentialFakeHttpClient();
    fakeHttp.respond(prometheusStatusVector([['200', 97], ['503', 3]]));
    const snapshot = await adapterFor(fakeHttp).collect(completedMerchGridWindow);
    const rootDir = await mkdtemp(join(tmpdir(), 'buffr-fly-metrics-'));
    const repository = new JsonFileMetricSnapshotRepository({ rootDir });

    try {
      expect(DailyMetricSnapshotSchema.parse(snapshot)).toEqual(snapshot);
      await expect(repository.save(snapshot)).resolves.toBe('created');
      await expect(repository.load('fly_metrics', '2026-08-21')).resolves.toEqual(snapshot);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('treats an empty successful query result as unavailable, not zero traffic', async () => {
    const fakeHttp = new SequentialFakeHttpClient();
    fakeHttp.respond(prometheusStatusVector([]));

    await expect(adapterFor(fakeHttp).collect(completedMerchGridWindow)).resolves.toEqual({
      source: 'fly_metrics',
      date: '2026-08-21',
      collectedAt: '2026-08-22T00:05:00.000Z',
      status: 'unavailable',
      metrics: {},
      notes: ['no_metrics'],
    });
  });

  it('omits the error rate when the measured request total is zero', async () => {
    const fakeHttp = new SequentialFakeHttpClient();
    fakeHttp.respond(prometheusStatusVector([['200', 0]]));

    const snapshot = await adapterFor(fakeHttp).collect(completedMerchGridWindow);

    expect(snapshot).toMatchObject({
      status: 'complete',
      metrics: { request_count: 0, error_response_count: 0 },
    });
    expect(snapshot).not.toHaveProperty('metrics.error_rate');
  });

  it('reports only measured response counts and error rate for an all-5xx day', async () => {
    const fakeHttp = new SequentialFakeHttpClient();
    fakeHttp.respond(prometheusStatusVector([['503', 12]]));

    const snapshot = await adapterFor(fakeHttp).collect(completedMerchGridWindow);

    expect(snapshot).toMatchObject({
      status: 'complete',
      metrics: { request_count: 12, error_response_count: 12, error_rate: 1 },
    });
    expect(snapshot).not.toHaveProperty('metrics.availability_status');
  });

  it('resolves a bounded failed snapshot when the Prometheus provider fails', async () => {
    const fakeHttp = new SequentialFakeHttpClient();
    fakeHttp.reject({ status: 429, providerMessage: 'fly-access-token rejected' });

    const snapshot = await adapterFor(fakeHttp).collect(completedMerchGridWindow);

    expect(snapshot).toEqual({
      source: 'fly_metrics',
      date: '2026-08-21',
      collectedAt: expect.any(String),
      status: 'failed',
      metrics: {},
      notes: ['rate_limit'],
    });
    expect(JSON.stringify(snapshot)).not.toContain('fly-access-token rejected');
  });
});

function adapterFor(http: SequentialFakeHttpClient): FlyMetricsSourceAdapter {
  return new FlyMetricsSourceAdapter({
    http,
    config: {
      accessToken: 'fly-access-token',
      appName: 'merchgrid',
      metricsUrl: 'https://api.fly.example.test/prometheus/acme/api/v1/query',
    },
    now: () => '2026-08-22T00:05:00.000Z',
  });
}

function prometheusStatusVector(rows: readonly [string, number][]) {
  return {
    status: 200,
    body: {
      status: 'success',
      data: {
        resultType: 'vector',
        result: rows.map(([status, value]) => ({ metric: { status }, value: [1_724_256_000, String(value)] })),
      },
    },
  };
}

class SequentialFakeHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private readonly responses: HttpResponse<unknown>[] = [];
  private failure: unknown;

  respond(...responses: HttpResponse<unknown>[]): void {
    this.responses.push(...responses);
  }

  reject(failure: unknown): void {
    this.failure = failure;
  }

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const response = this.responses.shift();
    if (!response) {
      throw new Error('Fake HTTP response was not configured');
    }
    return response as HttpResponse<T>;
  }
}
