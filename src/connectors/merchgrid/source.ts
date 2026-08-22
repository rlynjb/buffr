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

export type MetricSourceFailureKind = 'authentication' | 'rate_limit' | 'transport' | 'schema' | 'unknown';

export type MetricSourceFailure = {
  status?: number;
  malformed?: boolean;
};

export type MetricSourceAdapter = {
  readonly source: MetricSource;
  collect(window: CollectionWindow): Promise<DailyMetricSnapshot>;
};

export function classifyMetricSourceFailure(failure: MetricSourceFailure): MetricSourceFailureKind {
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
