import { describe, expect, it } from 'vitest';
import type { DailyMetricSnapshot } from '../../contracts/metrics.js';
import {
  loadFlyMetricsConfig,
  loadPosthogMetricsConfig,
  loadShopifyPartnerCsvConfig,
} from '../../core/config.js';
import {
  classifyMetricSourceFailure,
  createMetricSourceFailureSnapshot,
  MetricSourceAdapterBase,
} from '../../connectors/merchgrid/source.js';

describe('MerchGrid metric source boundary', () => {
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
    expect(loadShopifyPartnerCsvConfig({ SHOPIFY_PARTNER_CSV_PATH: '.local/partner.csv' })).toEqual({
      csvPath: '.local/partner.csv',
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
});
