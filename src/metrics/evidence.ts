import type { DailyHealthSummary, WeeklyBusinessReview } from './summaries.js';

export type MerchGridReviewEvidence = {
  period: { kind: 'daily'; date: string } | { kind: 'weekly'; previous: { startDate: string; endDate: string }; current: { startDate: string; endDate: string } };
  sourceCoverage: DailyHealthSummary['sourceStatuses'] | WeeklyBusinessReview['sourceCoverage'];
  sourceFreshness: DailyHealthSummary['sourceFreshness'] | WeeklyBusinessReview['sourceFreshness'];
  aggregateMetrics: DailyHealthSummary['aggregateMetrics'] | WeeklyBusinessReview['aggregateMetrics'];
  limitations: readonly string[];
};

/** Projects a deterministic summary into the only fields a workflow may consume. */
export function toMerchGridReviewEvidence(
  summary: DailyHealthSummary | WeeklyBusinessReview,
): MerchGridReviewEvidence {
  if ('date' in summary) {
    return {
      period: { kind: 'daily', date: summary.date },
      sourceCoverage: summary.sourceStatuses,
      sourceFreshness: summary.sourceFreshness,
      aggregateMetrics: summary.aggregateMetrics,
      limitations: summary.limitations,
    };
  }

  return {
    period: { kind: 'weekly', previous: summary.period.previous, current: summary.period.current },
    sourceCoverage: summary.sourceCoverage,
    sourceFreshness: summary.sourceFreshness,
    aggregateMetrics: summary.aggregateMetrics,
    limitations: summary.limitations,
  };
}
