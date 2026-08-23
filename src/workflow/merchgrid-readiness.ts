import type { MetricsOutput } from '../contracts/modules.js';
import type { MerchGridWorkflowEvidence } from '../contracts/merchgrid-workflow.js';

export const DAILY_MINIMUM_REQUEST_COUNT = 20;
export const DAILY_MATERIAL_ERROR_RATE = 0.05;

export type DailyReadiness =
  | { outcome: 'healthy_no_action'; reason: 'no_material_reliability_concern' }
  | { outcome: 'investigate'; reason: 'fly_error_rate_material' }
  | {
      outcome: 'collect_more_data';
      reason: 'reliability_evidence_incomplete' | 'reliability_denominator_unavailable' | 'reliability_sample_too_small';
    }
  | { outcome: 'manual_triage'; reason: string };

export type WeeklyReadiness =
  | { outcome: 'ready'; metrics: MetricsOutput }
  | { outcome: 'collect_more_data'; reason: 'weekly_period_invalid' | 'no_comparable_weekly_metrics'; metrics: MetricsOutput };

/** Applies the fixed daily reliability policy without inspecting a provider or invoking an agent. */
export function evaluateDailyReadiness(evidence: MerchGridWorkflowEvidence): DailyReadiness {
  if (evidence.kind !== 'daily_health') {
    throw new RangeError('Daily readiness requires daily health evidence');
  }

  if (evidence.sourceCoverage.fly_metrics !== 'complete') {
    return { outcome: 'collect_more_data', reason: 'reliability_evidence_incomplete' };
  }

  const requests = evidence.aggregateMetrics.fly_metrics?.request_count;
  const errors = evidence.aggregateMetrics.fly_metrics?.error_response_count;
  if (requests === undefined || errors === undefined || requests === 0) {
    return { outcome: 'collect_more_data', reason: 'reliability_denominator_unavailable' };
  }
  if (requests < DAILY_MINIMUM_REQUEST_COUNT) {
    return { outcome: 'collect_more_data', reason: 'reliability_sample_too_small' };
  }
  if (errors / requests >= DAILY_MATERIAL_ERROR_RATE) {
    return { outcome: 'investigate', reason: 'fly_error_rate_material' };
  }
  return { outcome: 'healthy_no_action', reason: 'no_material_reliability_concern' };
}

/** Qualifies only closed, comparable product/business metrics for the weekly workflow path. */
export function evaluateWeeklyReadiness(evidence: MerchGridWorkflowEvidence): WeeklyReadiness {
  if (evidence.kind !== 'weekly_review') {
    throw new RangeError('Weekly readiness requires weekly review evidence');
  }

  if (!hasAdjacentSevenDayPeriods(evidence)) {
    return { outcome: 'collect_more_data', reason: 'weekly_period_invalid', metrics: missingMetricsOutput(['weekly periods are not adjacent closed seven-day ranges']) };
  }

  if (!hasCompleteSourceCoverage(evidence, 'posthog')) {
    return { outcome: 'collect_more_data', reason: 'no_comparable_weekly_metrics', metrics: missingMetricsOutput(['posthog coverage is incomplete']) };
  }

  const metrics = [
    ...qualifySourceMetrics(evidence, 'posthog'),
    ...qualifySourceMetrics(evidence, 'shopify_partner'),
  ];
  if (metrics.length === 0) {
    return { outcome: 'collect_more_data', reason: 'no_comparable_weekly_metrics', metrics: missingMetricsOutput(['no complete comparable product or business metric is available']) };
  }

  return {
    outcome: 'ready',
    metrics: {
      phase: 'initial',
      metrics,
      comparisonQuality: hasCompleteSourceCoverage(evidence, 'shopify_partner') ? 'valid' : 'limited',
      unresolvedQualificationNeeds: hasCompleteSourceCoverage(evidence, 'shopify_partner') ? [] : ['shopify partner aggregates are incomplete'],
    },
  };
}

function hasAdjacentSevenDayPeriods(evidence: Extract<MerchGridWorkflowEvidence, { kind: 'weekly_review' }>): boolean {
  const { previous, current } = evidence.observedPeriod;
  const previousStart = utcDay(previous.startDate);
  const previousEnd = utcDay(previous.endDate);
  const currentStart = utcDay(current.startDate);
  const currentEnd = utcDay(current.endDate);
  if (!previousStart || !previousEnd || !currentStart || !currentEnd) {
    return false;
  }
  return (
    dayDifference(previousStart, previousEnd) === 6
    && dayDifference(currentStart, currentEnd) === 6
    && dayDifference(previousEnd, currentStart) === 1
  );
}

function hasCompleteSourceCoverage(
  evidence: Extract<MerchGridWorkflowEvidence, { kind: 'weekly_review' }>,
  source: 'posthog' | 'shopify_partner',
): boolean {
  return evidence.sourceCoverage.previous[source].complete === 7
    && evidence.sourceCoverage.current[source].complete === 7;
}

function qualifySourceMetrics(
  evidence: Extract<MerchGridWorkflowEvidence, { kind: 'weekly_review' }>,
  source: 'posthog' | 'shopify_partner',
): MetricsOutput['metrics'] {
  if (!hasCompleteSourceCoverage(evidence, source)) {
    return [];
  }
  const baselineMetrics = evidence.aggregateMetrics.previous[source];
  const currentMetrics = evidence.aggregateMetrics.current[source];
  if (!baselineMetrics || !currentMetrics) {
    return [];
  }

  return Object.keys(currentMetrics)
    .sort()
    .flatMap((metricName) => {
      const baseline = baselineMetrics[metricName as keyof typeof baselineMetrics];
      const current = currentMetrics[metricName as keyof typeof currentMetrics];
      if (baseline === undefined || current === undefined) {
        return [];
      }
      const absoluteChange = current - baseline;
      const percentageChange = baseline === 0 ? null : absoluteChange / baseline;
      return [{
        name: `${source}.${metricName}`,
        baseline,
        current,
        absoluteChange,
        percentageChange,
        qualification: qualificationForChange(absoluteChange, percentageChange),
        confidence: 'high' as const,
      }];
    });
}

function qualificationForChange(
  absoluteChange: number,
  percentageChange: number | null,
): 'improved' | 'declined' | 'stable' | 'inconclusive' {
  if (absoluteChange === 0) {
    return 'stable';
  }
  if (percentageChange === null) {
    return 'inconclusive';
  }
  return absoluteChange > 0 ? 'improved' : 'declined';
}

function missingMetricsOutput(needs: string[]): MetricsOutput {
  return {
    phase: 'initial',
    metrics: [],
    comparisonQuality: 'missing',
    unresolvedQualificationNeeds: needs,
  };
}

function utcDay(date: string): Date | undefined {
  const value = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(value.getTime()) ? undefined : value;
}

function dayDifference(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}
