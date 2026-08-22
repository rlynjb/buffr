import type { CollectionWindow, DailyMetricSnapshot, MetricSource } from '../../contracts/metrics.js';

export type HttpRequest = {
  method: 'GET' | 'POST';
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
};

export type HttpResponse<T> = {
  status: number;
  body: T;
};

export type HttpClient = {
  request<T>(request: HttpRequest): Promise<HttpResponse<T>>;
};

export type FetchHttpClientOptions = {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/** Native-fetch boundary with a finite deadline and status-preserving error handling. */
export class FetchHttpClient implements HttpClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: FetchHttpClientOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) {
      throw new RangeError('HTTP timeout must be a finite nonnegative duration');
    }
  }

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body:
          request.body === undefined
            ? undefined
            : typeof request.body === 'string'
              ? request.body
              : JSON.stringify(request.body),
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        return { status: response.status, body: undefined as T };
      }
      try {
        return { status: response.status, body: (await response.json()) as T };
      } catch {
        throw { status: response.status, malformed: true };
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type MetricSourceFailureKind = 'authentication' | 'rate_limit' | 'transport' | 'schema' | 'unknown';

export type MetricSourceFailure = {
  status?: number;
  malformed?: boolean;
};

export type FailedMetricSnapshot = Omit<DailyMetricSnapshot, 'status' | 'metrics' | 'notes'> & {
  status: 'failed';
  metrics: Record<string, never>;
  notes: [MetricSourceFailureKind];
};

export type MetricSourceFailureSnapshotInput = {
  source: MetricSource;
  window: CollectionWindow;
  failure: unknown;
  collectedAt?: string;
};

export type MetricSourceAdapter = {
  readonly source: MetricSource;
  /** Source I/O failures resolve to a normalized non-complete snapshot and never expose the provider failure. */
  collect(window: CollectionWindow): Promise<DailyMetricSnapshot>;
};

export abstract class MetricSourceAdapterBase implements MetricSourceAdapter {
  abstract readonly source: MetricSource;

  async collect(window: CollectionWindow): Promise<DailyMetricSnapshot> {
    try {
      return await this.collectMetrics(window);
    } catch (failure) {
      return createMetricSourceFailureSnapshot({ source: this.source, window, failure });
    }
  }

  protected abstract collectMetrics(window: CollectionWindow): Promise<DailyMetricSnapshot>;
}

export function classifyMetricSourceFailure(failure: unknown): MetricSourceFailureKind {
  if (!isMetricSourceFailure(failure)) {
    return 'transport';
  }

  if (failure.malformed) {
    return 'schema';
  }

  if (failure.status === 401 || failure.status === 403) {
    return 'authentication';
  }

  if (failure.status === 429) {
    return 'rate_limit';
  }

  if (failure.status === undefined) {
    return 'transport';
  }

  return 'unknown';
}

export function createMetricSourceFailureSnapshot(
  input: MetricSourceFailureSnapshotInput,
): FailedMetricSnapshot {
  return {
    source: input.source,
    date: input.window.date,
    collectedAt: input.collectedAt ?? new Date().toISOString(),
    status: 'failed',
    metrics: {},
    notes: [classifyMetricSourceFailure(input.failure)],
  };
}

function isMetricSourceFailure(value: unknown): value is MetricSourceFailure {
  return Boolean(value) && typeof value === 'object';
}
