import {
  CollectionWindowSchema,
  isCompletedUtcDate,
  type CollectionWindow,
  type DailyMetricSnapshot,
} from '../../contracts/metrics.js';
import type { FlyMetricsConfig } from '../../core/config.js';
import {
  createMetricSourceFailureSnapshot,
  MetricSourceAdapterBase,
  type HttpClient,
} from './source.js';

export type FlyMetricsSourceAdapterOptions = {
  http: HttpClient;
  config: FlyMetricsConfig;
  now?: () => string;
};

export class FlyMetricsSourceAdapter extends MetricSourceAdapterBase {
  readonly source = 'fly_metrics' as const;

  private readonly http: HttpClient;
  private readonly config: FlyMetricsConfig;
  private readonly now: () => string;

  constructor(options: FlyMetricsSourceAdapterOptions) {
    super();
    this.http = options.http;
    this.config = options.config;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async collect(window: CollectionWindow): Promise<DailyMetricSnapshot> {
    const collectedAt = this.now();
    const validWindow = parseCompletedWindow(window, new Date(collectedAt));
    if (!validWindow) {
      return createMetricSourceFailureSnapshot({
        source: this.source,
        window: safeFailureWindow(new Date(collectedAt)),
        failure: { malformed: true },
        collectedAt,
      });
    }

    return super.collect(validWindow);
  }

  protected async collectMetrics(window: CollectionWindow): Promise<DailyMetricSnapshot> {
    const response = await this.http.request<unknown>({
      method: 'POST',
      url: this.config.metricsUrl,
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        query: aggregateQuery(this.config.appName),
        time: window.endExclusive,
      }).toString(),
    });

    if (response.status < 200 || response.status >= 300) {
      throw { status: response.status };
    }

    const counts = parseResponseCounts(response.body);
    if (!counts) {
      return {
        source: this.source,
        date: window.date,
        collectedAt: this.now(),
        status: 'unavailable',
        metrics: {},
        notes: ['no_metrics'],
      };
    }

    const metrics: Record<string, number> = {
      request_count: counts.requestCount,
      error_response_count: counts.errorResponseCount,
      availability_status: 1,
    };
    if (counts.requestCount > 0) {
      metrics.error_rate = counts.errorResponseCount / counts.requestCount;
    }

    return {
      source: this.source,
      date: window.date,
      collectedAt: this.now(),
      status: 'complete',
      metrics,
      notes: [],
    };
  }
}

function aggregateQuery(appName: string): string {
  return `sum by (status) (increase(fly_edge_http_responses_count{app="${escapePrometheusLabel(appName)}"}[1d]))`;
}

function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

function parseResponseCounts(body: unknown): { requestCount: number; errorResponseCount: number } | undefined {
  if (!isObject(body) || body.status !== 'success' || !isObject(body.data)) {
    throw { malformed: true };
  }
  if (body.data.resultType !== 'vector' || !Array.isArray(body.data.result)) {
    throw { malformed: true };
  }
  if (body.data.result.length === 0) {
    return undefined;
  }

  let requestCount = 0;
  let errorResponseCount = 0;
  const seenStatuses = new Set<string>();
  for (const row of body.data.result) {
    const parsed = parseResponseCount(row);
    if (!parsed || seenStatuses.has(parsed.status)) {
      throw { malformed: true };
    }
    seenStatuses.add(parsed.status);
    requestCount += parsed.count;
    if (parsed.status.startsWith('5')) {
      errorResponseCount += parsed.count;
    }
  }

  return { requestCount, errorResponseCount };
}

function parseResponseCount(value: unknown): { status: string; count: number } | undefined {
  if (!isObject(value) || !isObject(value.metric) || typeof value.metric.status !== 'string') {
    return undefined;
  }
  if (!/^\d{3}$/u.test(value.metric.status) || !Array.isArray(value.value) || value.value.length !== 2) {
    return undefined;
  }

  const count = typeof value.value[1] === 'number' ? value.value[1] : Number(value.value[1]);
  if (!Number.isFinite(count) || count < 0) {
    return undefined;
  }
  return { status: value.metric.status, count };
}

function parseCompletedWindow(value: unknown, now: Date): CollectionWindow | undefined {
  const parsed = CollectionWindowSchema.safeParse(value);
  if (!parsed.success || !isCompletedUtcDate(parsed.data.date, now)) {
    return undefined;
  }

  const start = new Date(`${parsed.data.date}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  if (parsed.data.startInclusive !== start.toISOString() || parsed.data.endExclusive !== end.toISOString()) {
    return undefined;
  }
  return parsed.data;
}

function safeFailureWindow(now: Date): CollectionWindow {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 1);
  return {
    date: start.toISOString().slice(0, 10),
    startInclusive: start.toISOString(),
    endExclusive: end.toISOString(),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
