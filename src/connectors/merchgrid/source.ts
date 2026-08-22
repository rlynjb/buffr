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
