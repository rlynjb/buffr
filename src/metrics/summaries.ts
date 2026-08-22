import type {
  DailyMetricSnapshot,
  MetricSource,
  SnapshotStatus,
} from '../contracts/metrics.js';

const SOURCES: readonly MetricSource[] = ['posthog', 'fly_metrics', 'shopify_partner'];
const NONCOMPLETE_STATUSES: readonly SnapshotStatus[] = ['partial', 'unavailable', 'failed'];

export type SourceStatus = SnapshotStatus | 'missing';
export type SourceMetricValues = Partial<Record<MetricSource, Record<string, number>>>;
export type SourceFreshness = Pick<DailyMetricSnapshot, 'date' | 'collectedAt' | 'status' | 'notes'>;
export type DailySourceFreshness = Partial<Record<MetricSource, SourceFreshness>>;
export type WeeklySourceFreshness = Partial<Record<MetricSource, SourceFreshness[]>>;
export type DailyHealthSummary = {
  date: string;
  sourceStatuses: Record<MetricSource, SourceStatus>;
  sourceFreshness: DailySourceFreshness;
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
  sourceFreshness: {
    previous: WeeklySourceFreshness;
    current: WeeklySourceFreshness;
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
  const sourceFreshness: DailySourceFreshness = {};
  const aggregateMetrics: SourceMetricValues = {};
  const limitations: string[] = [];

  for (const source of SOURCES) {
    const snapshot = snapshots.get(source);
    const status = snapshot?.status ?? 'missing';
    sourceStatuses[source] = status;
    if (snapshot) {
      sourceFreshness[source] = snapshotFreshness(snapshot);
    }
    if (status === 'complete') {
      aggregateMetrics[source] = { ...snapshot!.metrics };
    } else {
      limitations.push(`${source}:${status}`);
    }
  }

  return { date: input.date, sourceStatuses, sourceFreshness, aggregateMetrics, limitations };
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
    sourceFreshness: { previous: previous.sourceFreshness, current: current.sourceFreshness },
    aggregateMetrics: {
      previous: previous.aggregateMetrics,
      current: current.aggregateMetrics,
      change: calculateChanges(previous, current),
    },
    limitations: [...previous.limitations.map((value) => `previous:${value}`), ...current.limitations.map((value) => `current:${value}`)],
  };
}

function buildWeeklyPeriod(snapshots: readonly DailyMetricSnapshot[]): {
  period: WeeklyPeriod;
  sourceCoverage: SourceCoverage;
  sourceFreshness: WeeklySourceFreshness;
  aggregateMetrics: SourceMetricValues;
  metricCoverage: Partial<Record<MetricSource, Record<string, number>>>;
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
  const sourceFreshness: WeeklySourceFreshness = {};
  const aggregateMetrics: SourceMetricValues = {};
  const metricCoverage: Partial<Record<MetricSource, Record<string, number>>> = {};
  const limitations: string[] = [];
  for (const source of SOURCES) {
    const coverage: Partial<Record<SourceStatus, number>> = {};
    const metrics: Record<string, number> = {};
    const coverageByMetric: Record<string, number> = {};
    const freshness: SourceFreshness[] = [];
    for (const date of dates) {
      const snapshot = snapshotsByDate.get(date)!.get(source);
      const status = snapshot?.status ?? 'missing';
      coverage[status] = (coverage[status] ?? 0) + 1;
      if (snapshot) {
        freshness.push(snapshotFreshness(snapshot));
      }
      if (status === 'complete') {
        for (const [metric, value] of Object.entries(snapshot!.metrics)) {
          coverageByMetric[metric] = (coverageByMetric[metric] ?? 0) + 1;
          if (!isDerivedRate(metric) && metric !== 'active_merchants') {
            metrics[metric] = (metrics[metric] ?? 0) + value;
          }
        }
      }
    }

    const endSnapshot = snapshotsByDate.get(dates[6]!)!.get(source);
    if (endSnapshot?.status === 'complete' && endSnapshot.metrics.active_merchants !== undefined) {
      metrics.active_merchants = endSnapshot.metrics.active_merchants;
      coverageByMetric.active_merchants = 1;
    } else {
      delete coverageByMetric.active_merchants;
    }
    deriveRate(metrics, coverageByMetric, 'scan_completion_rate', 'scan_completed_count', 'scan_started_count');
    deriveRate(metrics, coverageByMetric, 'error_rate', 'error_response_count', 'request_count');

    sourceCoverage[source] = coverage;
    if (freshness.length > 0) {
      sourceFreshness[source] = freshness;
    }
    if (Object.keys(metrics).length > 0) {
      aggregateMetrics[source] = metrics;
      metricCoverage[source] = coverageByMetric;
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
    sourceFreshness,
    aggregateMetrics,
    metricCoverage,
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

type BuiltWeeklyPeriod = ReturnType<typeof buildWeeklyPeriod>;

function calculateChanges(previous: BuiltWeeklyPeriod, current: BuiltWeeklyPeriod): SourceMetricValues {
  const changes: SourceMetricValues = {};
  for (const source of SOURCES) {
    if (previous.sourceCoverage[source].complete !== 7 || current.sourceCoverage[source].complete !== 7) {
      continue;
    }
    const previousMetrics = previous.aggregateMetrics[source];
    const currentMetrics = current.aggregateMetrics[source];
    if (!previousMetrics || !currentMetrics) {
      continue;
    }
    const sourceChanges: Record<string, number> = {};
    for (const [metric, currentValue] of Object.entries(currentMetrics)) {
      const previousValue = previousMetrics[metric];
      if (
        previousValue !== undefined &&
        hasCompleteMetricCoverage(previous.metricCoverage[source], metric) &&
        hasCompleteMetricCoverage(current.metricCoverage[source], metric)
      ) {
        sourceChanges[metric] = currentValue - previousValue;
      }
    }
    if (Object.keys(sourceChanges).length > 0) {
      changes[source] = sourceChanges;
    }
  }
  return changes;
}

function deriveRate(
  metrics: Record<string, number>,
  coverage: Record<string, number>,
  rate: 'scan_completion_rate' | 'error_rate',
  numerator: 'scan_completed_count' | 'error_response_count',
  denominator: 'scan_started_count' | 'request_count',
): void {
  const numeratorValue = metrics[numerator];
  const denominatorValue = metrics[denominator];
  if (numeratorValue === undefined || denominatorValue === undefined || denominatorValue <= 0) {
    return;
  }
  metrics[rate] = numeratorValue / denominatorValue;
  coverage[rate] = Math.min(coverage[numerator] ?? 0, coverage[denominator] ?? 0);
}

function hasCompleteMetricCoverage(coverage: Record<string, number> | undefined, metric: string): boolean {
  return coverage?.[metric] === (metric === 'active_merchants' ? 1 : 7);
}

function isDerivedRate(metric: string): metric is 'scan_completion_rate' | 'error_rate' {
  return metric === 'scan_completion_rate' || metric === 'error_rate';
}

function snapshotFreshness(snapshot: DailyMetricSnapshot): SourceFreshness {
  return {
    date: snapshot.date,
    collectedAt: snapshot.collectedAt,
    status: snapshot.status,
    notes: [...snapshot.notes],
  };
}

function isConsecutiveDates(dates: readonly string[]): boolean {
  return dates.every((date, index) => index === 0 || date === nextUtcDate(dates[index - 1]!));
}

function nextUtcDate(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}
