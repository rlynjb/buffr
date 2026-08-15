import type { NormalizedListingEvidence } from '../../contracts/evidence.js';
import type { MetricsOutput } from '../../contracts/modules.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';

type MetricName =
  | 'conversion_rate'
  | 'favorite_rate'
  | 'click_through_rate'
  | 'revenue_per_view_cents'
  | 'average_order_value_cents'
  | 'return_on_ad_spend';

export function runMetricsModule(input: {
  phase: 'initial' | 'post_experiment';
  state: WorkflowRunState;
  evidence: NormalizedListingEvidence;
}): MetricsOutput {
  const output = calculateMetricSnapshot(input.evidence);
  if (input.phase === 'post_experiment') {
    return applyPostExperimentBaseline({ ...output, phase: input.phase }, input.state);
  }

  return { ...output, phase: input.phase };
}

export function calculateMetricSnapshot(evidence: NormalizedListingEvidence): MetricsOutput {
  const stats = evidence.stats;
  const metrics = [
    calculateMetric('conversion_rate', stats.orders, stats.views, 'orders', 'views'),
    calculateMetric('favorite_rate', stats.favorites, stats.views, 'favorites', 'views'),
    calculateMetric('click_through_rate', stats.adClicks, stats.adImpressions, 'ad clicks', 'ad impressions'),
    calculateMetric('revenue_per_view_cents', stats.revenueCents, stats.views, 'revenue', 'views'),
    calculateMetric('average_order_value_cents', stats.revenueCents, stats.orders, 'revenue', 'orders'),
    calculateMetric('return_on_ad_spend', stats.adRevenueCents, stats.adSpendCents, 'ad revenue', 'ad spend'),
  ];
  const unresolvedQualificationNeeds = metrics
    .filter((metric) => metric.qualification === 'not_available')
    .map((metric) => `${metric.name} requires ${metric.numeratorLabel} and ${metric.denominatorLabel} greater than zero`);

  return {
    phase: 'initial',
    metrics: metrics.map(({ numeratorLabel: _numeratorLabel, denominatorLabel: _denominatorLabel, ...metric }) => metric),
    comparisonQuality: metrics.every((metric) => metric.qualification === 'not_available') ? 'missing' : 'limited',
    unresolvedQualificationNeeds,
  };
}

function applyPostExperimentBaseline(output: MetricsOutput, state: WorkflowRunState): MetricsOutput {
  const plan = state.moduleOutputs.m6;
  if (!plan) {
    return {
      ...output,
      comparisonQuality: 'missing',
      unresolvedQualificationNeeds: [
        ...output.unresolvedQualificationNeeds,
        'post-experiment metrics require a frozen M6 test plan baseline',
      ],
    };
  }

  return {
    ...output,
    metrics: output.metrics.map((metric) => {
      if (metric.name !== plan.primaryMetric || metric.current === null) {
        return metric;
      }

      const baseline = plan.baselineValue;
      const absoluteChange = metric.current - baseline;
      const percentageChange = baseline === 0 ? null : (absoluteChange / baseline) * 100;

      return {
        ...metric,
        baseline,
        absoluteChange,
        percentageChange,
        qualification: qualifyChange(absoluteChange),
      };
    }),
  };
}

function qualifyChange(absoluteChange: number): MetricsOutput['metrics'][number]['qualification'] {
  if (absoluteChange > 0) {
    return 'improved';
  }

  if (absoluteChange < 0) {
    return 'declined';
  }

  return 'stable';
}

function calculateMetric(
  name: MetricName,
  numerator: number | undefined,
  denominator: number | undefined,
  numeratorLabel: string,
  denominatorLabel: string,
): MetricsOutput['metrics'][number] & { numeratorLabel: string; denominatorLabel: string } {
  if (!numerator || !denominator) {
    return {
      name,
      current: null,
      baseline: null,
      absoluteChange: null,
      percentageChange: null,
      qualification: 'not_available',
      confidence: 'low',
      numeratorLabel,
      denominatorLabel,
    };
  }

  return {
    name,
    current: numerator / denominator,
    baseline: null,
    absoluteChange: null,
    percentageChange: null,
    qualification: 'inconclusive',
    confidence: 'moderate',
    numeratorLabel,
    denominatorLabel,
  };
}
