import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DailyMetricSnapshot } from '../../contracts/metrics.js';
import { PosthogMetricSourceAdapter } from '../../connectors/merchgrid/posthog.js';
import {
  loadFlyMetricsConfig,
  loadPosthogMetricsConfig,
  loadShopifyPartnerCsvConfig,
} from '../../core/config.js';
import {
  classifyMetricSourceFailure,
  createMetricSourceFailureSnapshot,
  FetchHttpClient,
  MetricSourceAdapterBase,
} from '../../connectors/merchgrid/source.js';

describe('MerchGrid metric source boundary', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads PostHog query config without exposing its API key in configuration errors', () => {
    const config = loadPosthogMetricsConfig({
      POSTHOG_PROJECT_ID: '7',
      POSTHOG_PERSONAL_API_KEY: 'secret',
    });

    expect(config).toMatchObject({ projectId: '7' });
    expect(() => loadPosthogMetricsConfig({ POSTHOG_PROJECT_ID: '7' })).toThrow(
      expect.objectContaining({
        code: 'configuration_failed',
        message: 'Missing required MerchGrid metrics configuration: POSTHOG_PERSONAL_API_KEY',
      }),
    );
  });

  it('loads only the Fly and Shopify adapter settings they need', () => {
    expect(
      loadFlyMetricsConfig({
        FLY_ACCESS_TOKEN: 'fly-secret',
        FLY_APP_NAME: 'merchgrid',
        FLY_METRICS_URL: 'https://metrics.fly.example.test/api/v1/query',
        UNRELATED_SECRET: 'do-not-return',
      }),
    ).toEqual({
      accessToken: 'fly-secret',
      appName: 'merchgrid',
      metricsUrl: 'https://metrics.fly.example.test/api/v1/query',
    });
    expect(loadShopifyPartnerCsvConfig({ SHOPIFY_PARTNER_CSV_PATH: 'artifacts/merchgrid/sources/partner.csv' })).toEqual({
      csvPath: 'artifacts/merchgrid/sources/partner.csv',
    });
  });

  it('classifies HTTP 429 as a rate limit', () => {
    expect(classifyMetricSourceFailure({ status: 429 })).toBe('rate_limit');
  });

  it('classifies rejected access, malformed data, and transport errors without error content', () => {
    expect(classifyMetricSourceFailure({ status: 401 })).toBe('authentication');
    expect(classifyMetricSourceFailure({ malformed: true })).toBe('schema');
    expect(classifyMetricSourceFailure({})).toBe('transport');
  });

  it('classifies HTTP 403 as an authentication failure', () => {
    expect(classifyMetricSourceFailure({ status: 403 })).toBe('authentication');
  });

  it('classifies an unrecognized status-bearing response as unknown', () => {
    expect(classifyMetricSourceFailure({ status: 500 })).toBe('unknown');
  });

  it('normalizes a provider error into a bounded failed snapshot', () => {
    const providerError = new Error('provider rejected credential: secret');

    const snapshot = createMetricSourceFailureSnapshot({
      source: 'posthog',
      window: {
        date: '2026-08-21',
        startInclusive: '2026-08-21T00:00:00.000Z',
        endExclusive: '2026-08-22T00:00:00.000Z',
      },
      failure: providerError,
      collectedAt: '2026-08-22T00:05:00.000Z',
    });

    expect(snapshot).toEqual({
      source: 'posthog',
      date: '2026-08-21',
      collectedAt: '2026-08-22T00:05:00.000Z',
      status: 'failed',
      metrics: {},
      notes: ['transport'],
    });
    expect(JSON.stringify(snapshot)).not.toContain(providerError.message);
  });

  it('resolves a bounded failed snapshot when an adapter provider operation throws', async () => {
    class ThrowingPosthogAdapter extends MetricSourceAdapterBase {
      readonly source = 'posthog';

      protected async collectMetrics(): Promise<DailyMetricSnapshot> {
        throw { status: 401, body: { providerMessage: 'credential secret' } };
      }
    }

    const snapshot = await new ThrowingPosthogAdapter().collect({
      date: '2026-08-21',
      startInclusive: '2026-08-21T00:00:00.000Z',
      endExclusive: '2026-08-22T00:00:00.000Z',
    });

    expect(snapshot).toEqual({
      source: 'posthog',
      date: '2026-08-21',
      collectedAt: expect.any(String),
      status: 'failed',
      metrics: {},
      notes: ['authentication'],
    });
    expect(JSON.stringify(snapshot)).not.toContain('credential secret');
  });

  it.each([
    [401, 'authentication'],
    [429, 'rate_limit'],
  ] as const)('preserves HTTP %i classification when the error body is not JSON', async (status, note) => {
    const http = new FetchHttpClient({
      fetch: async () => new Response('not JSON', { status }),
    });
    const adapter = posthogAdapter(http);

    await expect(adapter.collect(completedWindow)).resolves.toMatchObject({
      status: 'failed',
      notes: [note],
    });
  });

  it('classifies malformed JSON from a successful HTTP response as schema failure', async () => {
    const http = new FetchHttpClient({
      fetch: async () => new Response('provider payload was not JSON', { status: 200 }),
    });

    await expect(posthogAdapter(http).collect(completedWindow)).resolves.toMatchObject({
      status: 'failed',
      notes: ['schema'],
    });
  });

  it('aborts a stalled fetch at the configured HTTP deadline without a real wait', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    );
    const http = new FetchHttpClient({ fetch: fetch as typeof globalThis.fetch, timeoutMs: 50 });

    const request = http.request({ method: 'GET', url: 'https://metrics.example.test' });
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(fetch.mock.calls[0]?.[1]?.signal).toMatchObject({ aborted: true });
  });
});

const completedWindow = {
  date: '2026-08-21',
  startInclusive: '2026-08-21T00:00:00.000Z',
  endExclusive: '2026-08-22T00:00:00.000Z',
} as const;

function posthogAdapter(http: FetchHttpClient): PosthogMetricSourceAdapter {
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
