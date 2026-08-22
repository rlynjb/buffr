import { describe, expect, it } from 'vitest';
import {
  loadFlyMetricsConfig,
  loadPosthogMetricsConfig,
  loadShopifyPartnerCsvConfig,
} from '../../core/config.js';
import { classifyMetricSourceFailure } from '../../connectors/merchgrid/source.js';

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
});
