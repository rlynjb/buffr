import {
  loadFlyMetricsConfig,
  loadPosthogMetricsConfig,
  loadShopifyPartnerCsvConfig,
} from '../../core/config.js';
import { FlyMetricsSourceAdapter } from './fly-metrics.js';
import { PosthogMetricSourceAdapter } from './posthog.js';
import { ShopifyPartnerCsvMetricSource } from './shopify-partner-csv.js';
import {
  FetchHttpClient,
  type HttpClient,
  type MetricSourceAdapter,
} from './source.js';

export function createMerchGridMetricSourceAdapters(input: {
  env: NodeJS.ProcessEnv;
  http?: HttpClient;
}): MetricSourceAdapter[] {
  const http = input.http ?? new FetchHttpClient();
  return [
    new PosthogMetricSourceAdapter({ http, config: loadPosthogMetricsConfig(input.env) }),
    new FlyMetricsSourceAdapter({ http, config: loadFlyMetricsConfig(input.env) }),
    new ShopifyPartnerCsvMetricSource({ config: loadShopifyPartnerCsvConfig(input.env) }),
  ];
}
