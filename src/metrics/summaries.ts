import type { DailyMetricSnapshot, MetricSource, SnapshotStatus } from '../contracts/metrics.js';

const SOURCES: readonly MetricSource[] = ['posthog', 'fly_metrics', 'shopify_partner'];
const NONCOMPLETE_STATUSES: readonly SnapshotStatus[] = ['partial', 'unavailable', 'failed'];

export type SourceStatus = SnapshotStatus | 'missing';
export type SourceMetricValues = Partial<Record<MetricSource, Record<string, number>>>;
export type DailyHealthSummary = {
  date: string;
  sourceStatuses: Record<MetricSource, SourceStatus>;
  aggregateMetrics: SourceMetricValues;
  limitations: string[];
};

export type SourceCoverage = Record<MetricSource, Partial<Record<SourceStatus, number>>>;
export type WeeklyBusinessReview = {
  period: {
    previous: WeeklyPeriod;
    current: WeeklyPeriod;
  };
  sourceCoverage: {
    previous: SourceCoverage;
    current: SourceCoverage;
  };
  aggregateMetrics: {
    previous: SourceMetricValues;
    current: SourceMetricValues;
    change: SourceMetricValues;
  };
  limitations: string[];
};

export type WeeklyPeriod = {
  startDate: string;
  endDate: string;
};

export function buildDailyHealthSummary(input: {
  date: string;
  snapshots: readonly DailyMetricSnapshot[];
}): DailyHealthSummary {
  const snapshots = snapshotsBySource(input.snapshots, input.date);
  const sourceStatuses = {} as Record<MetricSource, SourceStatus>;
  const aggregateMetrics: SourceMetricValues = {};
  const limitations: string[] = [];

  for (const source of SOURCES) {
    const snapshot = snapshots.get(source);
    const status = snapshot?.status ?? 'missing';
    sourceStatuses[source] = status;
    if (status === 'complete') {
      aggregateMetrics[source] = { ...snapshot!.metrics };
    } else {
      limitations.push(`${source}:${status}`);
    }
  }

  return { date: input.date, sourceStatuses, aggregateMetrics, limitations };
}

export function buildWeeklyBusinessReview(input: {
  previous: readonly DailyMetricSnapshot[];
  current: readonly DailyMetricSnapshot[];
}): WeeklyBusinessReview {
  const previous = buildWeeklyPeriod(input.previous);
  const current = buildWeeklyPeriod(input.current);
  if (nextUtcDate(previous.period.endDate) !== current.period.startDate) {
    throw new RangeError('Weekly windows must be adjacent seven-date periods');
  }

  return {
    period: { previous: previous.period, current: current.period },
    sourceCoverage: { previous: previous.sourceCoverage, current: current.sourceCoverage },
    aggregateMetrics: {
      previous: previous.aggregateMetrics,
      current: current.aggregateMetrics,
      change: calculateChanges(previous.aggregateMetrics, current.aggregateMetrics),
    },
    limitations: [...previous.limitations.map((value) => `previous:${value}`), ...current.limitations.map((value) => `current:${value}`)],
  };
}

function buildWeeklyPeriod(snapshots: readonly DailyMetricSnapshot[]): {
  period: WeeklyPeriod;
  sourceCoverage: SourceCoverage;
  aggregateMetrics: SourceMetricValues;
  limitations: string[];
} {
  const dates = [...new Set(snapshots.map((snapshot) => snapshot.date))].sort();
  if (dates.length !== 7 || !isConsecutiveDates(dates)) {
    throw new RangeError('Weekly windows must contain exactly seven consecutive dates');
  }

  const snapshotsByDate = new Map<string, Map<MetricSource, DailyMetricSnapshot>>();
  for (const date of dates) {
    snapshotsByDate.set(date, snapshotsBySource(snapshots.filter((snapshot) => snapshot.date === date), date));
  }

  const sourceCoverage = {} as SourceCoverage;
  const aggregateMetrics: SourceMetricValues = {};
  const limitations: string[] = [];
  for (const source of SOURCES) {
    const coverage: Partial<Record<SourceStatus, number>> = {};
    const metrics: Record<string, number> = {};
    for (const date of dates) {
      const snapshot = snapshotsByDate.get(date)!.get(source);
      const status = snapshot?.status ?? 'missing';
      coverage[status] = (coverage[status] ?? 0) + 1;
      if (status === 'complete') {
        for (const [metric, value] of Object.entries(snapshot!.metrics)) {
          metrics[metric] = (metrics[metric] ?? 0) + value;
        }
      }
    }
    sourceCoverage[source] = coverage;
    if (Object.keys(metrics).length > 0) {
      aggregateMetrics[source] = metrics;
    }
    for (const status of ['missing', ...NONCOMPLETE_STATUSES] as const) {
      if (coverage[status]) {
        limitations.push(`${source}:${status}:${coverage[status]}`);
      }
    }
  }

  return {
    period: { startDate: dates[0]!, endDate: dates[6]! },
    sourceCoverage,
    aggregateMetrics,
    limitations,
  };
}

function snapshotsBySource(
  snapshots: readonly DailyMetricSnapshot[],
  expectedDate: string,
): Map<MetricSource, DailyMetricSnapshot> {
  const result = new Map<MetricSource, DailyMetricSnapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.date !== expectedDate) {
      throw new RangeError(`Snapshot date does not match summary date: ${snapshot.date}`);
    }
    if (result.has(snapshot.source)) {
      throw new RangeError(`Duplicate source snapshot for summary date: ${snapshot.source}/${expectedDate}`);
    }
    result.set(snapshot.source, snapshot);
  }
  return result;
}

function calculateChanges(previous: SourceMetricValues, current: SourceMetricValues): SourceMetricValues {
  const changes: SourceMetricValues = {};
  for (const source of SOURCES) {
    const previousMetrics = previous[source];
    const currentMetrics = current[source];
    if (!previousMetrics || !currentMetrics) {
      continue;
    }
    const sourceChanges: Record<string, number> = {};
    for (const [metric, currentValue] of Object.entries(currentMetrics)) {
      const previousValue = previousMetrics[metric];
      if (previousValue !== undefined) {
        sourceChanges[metric] = currentValue - previousValue;
      }
    }
    if (Object.keys(sourceChanges).length > 0) {
      changes[source] = sourceChanges;
    }
  }
  return changes;
}

function isConsecutiveDates(dates: readonly string[]): boolean {
  return dates.every((date, index) => index === 0 || date === nextUtcDate(dates[index - 1]!));
}

function nextUtcDate(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}
