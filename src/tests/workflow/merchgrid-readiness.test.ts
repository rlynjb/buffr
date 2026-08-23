import { describe, expect, it } from 'vitest';
import { MerchGridWorkflowEvidenceSchema } from '../../contracts/merchgrid-workflow.js';
import {
  DAILY_MATERIAL_ERROR_RATE,
  DAILY_MINIMUM_REQUEST_COUNT,
  evaluateDailyReadiness,
  evaluateWeeklyReadiness,
} from '../../workflow/merchgrid-readiness.js';

describe('MerchGrid readiness policies', () => {
  it('starts an investigation at the explicit Fly request and error-rate thresholds', () => {
    expect(DAILY_MINIMUM_REQUEST_COUNT).toBe(20);
    expect(DAILY_MATERIAL_ERROR_RATE).toBe(0.05);
    expect(evaluateDailyReadiness(dailyEvidence({ request_count: 20, error_response_count: 1, error_rate: 0.05 })))
      .toEqual({ outcome: 'investigate', reason: 'fly_error_rate_material' });
  });

  it('does not infer health from zero or insufficient request counts', () => {
    expect(evaluateDailyReadiness(dailyEvidence({ request_count: 0 })))
      .toEqual({ outcome: 'collect_more_data', reason: 'reliability_denominator_unavailable' });
    expect(evaluateDailyReadiness(dailyEvidence({ request_count: 19, error_response_count: 19, error_rate: 1 })))
      .toEqual({ outcome: 'collect_more_data', reason: 'reliability_sample_too_small' });
  });

  it('does not investigate when the required Fly evidence is unavailable', () => {
    const evidence = dailyEvidence({ request_count: 100, error_response_count: 12, error_rate: 0.12 }, 'partial');

    expect(evaluateDailyReadiness(evidence))
      .toEqual({ outcome: 'collect_more_data', reason: 'reliability_evidence_incomplete' });
  });

  it('qualifies a complete pair of adjacent weekly periods deterministically', () => {
    const result = evaluateWeeklyReadiness(weeklyEvidence());

    expect(result.outcome).toBe('ready');
    if (result.outcome === 'ready') {
      expect(result.metrics).toMatchObject({
        phase: 'initial',
        comparisonQuality: 'valid',
        unresolvedQualificationNeeds: [],
      });
      expect(result.metrics.metrics).toContainEqual({
        name: 'posthog.app_opened_count',
        baseline: 8,
        current: 10,
        absoluteChange: 2,
        percentageChange: 0.25,
        qualification: 'improved',
        confidence: 'high',
      });
    }
  });

  it('waits when no metric has complete comparable weekly coverage', () => {
    const result = evaluateWeeklyReadiness(weeklyEvidence('partial'));

    expect(result).toMatchObject({
      outcome: 'collect_more_data',
      reason: 'no_comparable_weekly_metrics',
      metrics: { comparisonQuality: 'missing' },
    });
  });
});

function dailyEvidence(flyMetrics: Record<string, number>, flyStatus: 'complete' | 'partial' = 'complete') {
  return MerchGridWorkflowEvidenceSchema.parse({
    product: 'merchgrid',
    kind: 'daily_health',
    artifactRef: '.local/artifacts/daily-health/2026-08-21.json',
    observedPeriod: { kind: 'daily', date: '2026-08-21' },
    sourceCoverage: { posthog: 'complete', fly_metrics: flyStatus, shopify_partner: 'unavailable' },
    sourceFreshness: {},
    aggregateMetrics: { fly_metrics: flyMetrics },
    limitations: flyStatus === 'complete' ? [] : ['fly_metrics:partial'],
  });
}

function weeklyEvidence(posthogStatus: 'complete' | 'partial' = 'complete') {
  const coverage = posthogStatus === 'complete' ? { complete: 7 } : { complete: 6, partial: 1 };
  return MerchGridWorkflowEvidenceSchema.parse({
    product: 'merchgrid',
    kind: 'weekly_review',
    artifactRef: '.local/artifacts/weekly-reviews/2026-08-21.json',
    observedPeriod: {
      kind: 'weekly',
      previous: { startDate: '2026-08-08', endDate: '2026-08-14' },
      current: { startDate: '2026-08-15', endDate: '2026-08-21' },
    },
    sourceCoverage: {
      previous: { posthog: coverage, fly_metrics: { complete: 7 }, shopify_partner: { complete: 7 } },
      current: { posthog: coverage, fly_metrics: { complete: 7 }, shopify_partner: { complete: 7 } },
    },
    sourceFreshness: { previous: {}, current: {} },
    aggregateMetrics: {
      previous: { posthog: { app_opened_count: 8 }, fly_metrics: { request_count: 100 }, shopify_partner: { installs: 2 } },
      current: { posthog: { app_opened_count: 10 }, fly_metrics: { request_count: 120 }, shopify_partner: { installs: 3 } },
      change: { posthog: { app_opened_count: 2 }, fly_metrics: { request_count: 20 }, shopify_partner: { installs: 1 } },
    },
    limitations: posthogStatus === 'complete' ? [] : ['posthog:partial:1'],
  });
}
