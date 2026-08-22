import { describe, expect, it } from 'vitest';
import { PosthogMetricSourceAdapter } from '../../connectors/merchgrid/posthog.js';
import {
  completedMerchGridWindow,
  FakeHttpClient,
  posthogAggregateResponse,
} from '../fixtures/merchgrid-metrics.js';

describe('PostHog aggregate metrics adapter', () => {
  it('maps only four approved event totals into a snapshot', async () => {
    const fakeHttp = new FakeHttpClient();
    fakeHttp.respond({
      status: 200,
      body: posthogAggregateResponse([
        ['app_opened', 8],
        ['scan_started', 4],
        ['scan_completed', 3],
        ['scan_failed', 1],
        ['unapproved_event', 99],
      ]),
    });
    const adapter = adapterFor(fakeHttp);

    await expect(adapter.collect(completedMerchGridWindow)).resolves.toEqual({
      source: 'posthog',
      date: '2026-08-21',
      collectedAt: expect.any(String),
      status: 'complete',
      metrics: {
        app_opened_count: 8,
        scan_started_count: 4,
        scan_completed_count: 3,
        scan_failed_count: 1,
        scan_completion_rate: 0.75,
      },
      notes: [],
    });
    expect(fakeHttp.requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: 'https://posthog.example.test/api/projects/7/query/',
        headers: { authorization: 'Bearer query-key', 'content-type': 'application/json' },
      }),
    ]);
    expect(JSON.stringify(fakeHttp.requests[0].body)).toContain('app_opened');
    expect(JSON.stringify(fakeHttp.requests[0].body)).toContain('scan_started');
    expect(JSON.stringify(fakeHttp.requests[0].body)).toContain('scan_completed');
    expect(JSON.stringify(fakeHttp.requests[0].body)).toContain('scan_failed');
    expect(JSON.stringify(fakeHttp.requests[0].body)).toContain(completedMerchGridWindow.startInclusive);
    expect(JSON.stringify(fakeHttp.requests[0].body)).toContain(completedMerchGridWindow.endExclusive);
  });

  it('omits the completion rate when no scans started', async () => {
    const fakeHttp = new FakeHttpClient();
    fakeHttp.respond({
      status: 200,
      body: posthogAggregateResponse([
        ['app_opened', 8],
        ['scan_started', 0],
        ['scan_completed', 0],
        ['scan_failed', 0],
      ]),
    });

    const snapshot = await adapterFor(fakeHttp).collect(completedMerchGridWindow);

    expect(snapshot).toMatchObject({
      status: 'complete',
      metrics: {
        app_opened_count: 8,
        scan_started_count: 0,
        scan_completed_count: 0,
        scan_failed_count: 0,
      },
    });
    expect(snapshot).not.toHaveProperty('metrics.scan_completion_rate');
  });

  it('returns a bounded failed snapshot on rejected access', async () => {
    const fakeHttp = new FakeHttpClient();
    fakeHttp.respond({ status: 401, body: {} });

    await expect(adapterFor(fakeHttp).collect(completedMerchGridWindow)).resolves.toEqual({
      source: 'posthog',
      date: '2026-08-21',
      collectedAt: expect.any(String),
      status: 'failed',
      metrics: {},
      notes: ['authentication'],
    });
  });

  it('normalizes rejected source I/O without retaining provider details', async () => {
    const fakeHttp = new FakeHttpClient();
    fakeHttp.reject({ providerMessage: 'query-key was rejected' });

    const snapshot = await adapterFor(fakeHttp).collect(completedMerchGridWindow);

    expect(snapshot).toMatchObject({ status: 'failed', metrics: {}, notes: ['transport'] });
    expect(JSON.stringify(snapshot)).not.toContain('query-key was rejected');
  });

  it('returns a schema failure instead of accepting malformed aggregate results', async () => {
    const fakeHttp = new FakeHttpClient();
    fakeHttp.respond({ status: 200, body: { columns: ['event', 'count'], results: [['app_opened', '8']] } });

    await expect(adapterFor(fakeHttp).collect(completedMerchGridWindow)).resolves.toMatchObject({
      status: 'failed',
      metrics: {},
      notes: ['schema'],
    });
  });

  it('returns a schema failure for duplicate aggregate rows', async () => {
    const fakeHttp = new FakeHttpClient();
    fakeHttp.respond({
      status: 200,
      body: posthogAggregateResponse([
        ['app_opened', 0],
        ['app_opened', 8],
      ]),
    });

    await expect(adapterFor(fakeHttp).collect(completedMerchGridWindow)).resolves.toMatchObject({
      status: 'failed',
      metrics: {},
      notes: ['schema'],
    });
  });
});

function adapterFor(http: FakeHttpClient): PosthogMetricSourceAdapter {
  return new PosthogMetricSourceAdapter({
    http,
    config: {
      projectId: '7',
      personalApiKey: 'query-key',
      apiBaseUrl: 'https://posthog.example.test/',
    },
    now: () => '2026-08-22T00:05:00.000Z',
  });
}
