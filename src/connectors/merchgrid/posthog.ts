import {
  CollectionWindowSchema,
  isCompletedUtcDate,
  type CollectionWindow,
  type DailyMetricSnapshot,
} from '../../contracts/metrics.js';
import type { PosthogMetricsConfig } from '../../core/config.js';
import {
  createMetricSourceFailureSnapshot,
  MetricSourceAdapterBase,
  type HttpClient,
} from './source.js';

const APPROVED_EVENTS = ['app_opened', 'scan_started', 'scan_completed', 'scan_failed'] as const;
type ApprovedEvent = (typeof APPROVED_EVENTS)[number];

export type PosthogMetricSourceAdapterOptions = {
  http: HttpClient;
  config: PosthogMetricsConfig;
  now?: () => string;
};

export class PosthogMetricSourceAdapter extends MetricSourceAdapterBase {
  readonly source = 'posthog' as const;

  private readonly http: HttpClient;
  private readonly config: PosthogMetricsConfig;
  private readonly now: () => string;

  constructor(options: PosthogMetricSourceAdapterOptions) {
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
      url: queryUrl(this.config),
      headers: {
        authorization: `Bearer ${this.config.personalApiKey}`,
        'content-type': 'application/json',
      },
      body: {
        query: {
          kind: 'HogQLQuery',
          query: aggregateQuery(window),
        },
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw { status: response.status };
    }

    const counts = parseApprovedEventCounts(response.body);
    const metrics: Record<string, number> = {
      app_opened_count: counts.app_opened,
      scan_started_count: counts.scan_started,
      scan_completed_count: counts.scan_completed,
      scan_failed_count: counts.scan_failed,
    };
    if (counts.scan_started > 0) {
      metrics.scan_completion_rate = counts.scan_completed / counts.scan_started;
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

function queryUrl(config: PosthogMetricsConfig): string {
  return new URL(`/api/projects/${encodeURIComponent(config.projectId)}/query/`, config.apiBaseUrl).toString();
}

function aggregateQuery(window: CollectionWindow): string {
  const eventNames = APPROVED_EVENTS.map((event) => `'${event}'`).join(', ');
  return [
    'SELECT event, count() AS count',
    'FROM events',
    `WHERE event IN (${eventNames})`,
    `AND timestamp >= toDateTime('${window.startInclusive}')`,
    `AND timestamp < toDateTime('${window.endExclusive}')`,
    'GROUP BY event',
  ].join(' ');
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

function parseApprovedEventCounts(body: unknown): Record<ApprovedEvent, number> {
  if (!isObject(body) || !Array.isArray(body.results)) {
    throw { malformed: true };
  }

  const counts: Record<ApprovedEvent, number> = {
    app_opened: 0,
    scan_started: 0,
    scan_completed: 0,
    scan_failed: 0,
  };
  const seenEvents = new Set<ApprovedEvent>();

  for (const row of body.results) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !isCount(row[1])) {
      throw { malformed: true };
    }
    if (isApprovedEvent(row[0])) {
      if (seenEvents.has(row[0])) {
        throw { malformed: true };
      }
      seenEvents.add(row[0]);
      counts[row[0]] = row[1];
    }
  }

  return counts;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isApprovedEvent(value: string): value is ApprovedEvent {
  return (APPROVED_EVENTS as readonly string[]).includes(value);
}
