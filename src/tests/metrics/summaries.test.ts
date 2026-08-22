import { describe, expect, it } from 'vitest';
import type { DailyMetricSnapshot } from '../../contracts/metrics.js';
import { toMerchGridReviewEvidence } from '../../metrics/evidence.js';
import { buildDailyHealthSummary, buildWeeklyBusinessReview } from '../../metrics/summaries.js';

const completeFly: DailyMetricSnapshot = {
  source: 'fly_metrics',
  date: '2026-08-21',
  collectedAt: '2026-08-22T00:05:00.000Z',
  status: 'complete',
  metrics: { request_count: 100, error_rate: 0.01 },
  notes: [],
};

describe('buildDailyHealthSummary', () => {
  it('does not turn missing source data into zero activity', () => {
    expect(buildDailyHealthSummary({ date: '2026-08-21', snapshots: [completeFly] })).toEqual({
      date: '2026-08-21',
      sourceStatuses: {
        posthog: 'missing',
        fly_metrics: 'complete',
        shopify_partner: 'missing',
      },
      aggregateMetrics: {
        fly_metrics: { request_count: 100, error_rate: 0.01 },
      },
      limitations: ['posthog:missing', 'shopify_partner:missing'],
    });
  });

  it('omits metric values from noncomplete snapshots while preserving their limitation', () => {
    const failedPosthog: DailyMetricSnapshot = {
      source: 'posthog',
      date: '2026-08-21',
      collectedAt: '2026-08-22T00:05:00.000Z',
      status: 'failed',
      metrics: {},
      notes: ['transport'],
    };

    expect(buildDailyHealthSummary({ date: '2026-08-21', snapshots: [completeFly, failedPosthog] })).toMatchObject({
      aggregateMetrics: { fly_metrics: { request_count: 100 } },
      limitations: ['posthog:failed', 'shopify_partner:missing'],
    });
  });
});

describe('buildWeeklyBusinessReview', () => {
  it('compares two exact seven-day windows and sums source-qualified complete values', () => {
    const previous = sevenPosthogSnapshots('2026-08-08', [1, 2, 3, 4, 5, 6, 7]);
    const current = sevenPosthogSnapshots('2026-08-15', [2, 3, 4, 5, 6, 7, 8]);

    expect(buildWeeklyBusinessReview({ previous, current })).toMatchObject({
      period: {
        previous: { startDate: '2026-08-08', endDate: '2026-08-14' },
        current: { startDate: '2026-08-15', endDate: '2026-08-21' },
      },
      aggregateMetrics: {
        previous: { posthog: { app_opened_count: 28 } },
        current: { posthog: { app_opened_count: 35 } },
        change: { posthog: { app_opened_count: 7 } },
      },
      sourceCoverage: {
        previous: { posthog: { complete: 7 } },
        current: { posthog: { complete: 7 } },
      },
    });
  });

  it('rejects a comparison that is not two adjacent seven-date windows', () => {
    const previous = sevenPosthogSnapshots('2026-08-08', [1, 2, 3, 4, 5, 6, 7]);
    const current = sevenPosthogSnapshots('2026-08-16', [2, 3, 4, 5, 6, 7, 8]);

    expect(() => buildWeeklyBusinessReview({ previous, current })).toThrow(
      'Weekly windows must be adjacent seven-date periods',
    );
  });

  it('leaves a week-over-week value absent when one comparison side has no complete value', () => {
    const previous = sevenPosthogSnapshots('2026-08-08', [1, 1, 1, 1, 1, 1, 1]);
    const current = sevenPosthogSnapshots('2026-08-15', [1, 1, 1, 1, 1, 1, 1]).map((snapshot) => ({
      ...snapshot,
      status: 'failed' as const,
      metrics: {},
      notes: ['transport' as const],
    }));

    expect(buildWeeklyBusinessReview({ previous, current }).aggregateMetrics.change.posthog).toBeUndefined();
  });
});

describe('toMerchGridReviewEvidence', () => {
  it('exposes only period, source coverage, aggregate metrics, and limitations', () => {
    const summary = buildDailyHealthSummary({ date: '2026-08-21', snapshots: [completeFly] });
    const evidence = toMerchGridReviewEvidence({
      ...summary,
      rawPayload: { token: 'secret' },
      sourceError: 'merchant@example.com',
      llmDecision: 'ship it',
    } as typeof summary);

    expect(evidence).toEqual({
      period: { kind: 'daily', date: '2026-08-21' },
      sourceCoverage: summary.sourceStatuses,
      aggregateMetrics: summary.aggregateMetrics,
      limitations: summary.limitations,
    });
    expect(Object.keys(evidence).sort()).toEqual(['aggregateMetrics', 'limitations', 'period', 'sourceCoverage']);
    expect(JSON.stringify(evidence)).not.toContain('secret');
    expect(JSON.stringify(evidence)).not.toContain('merchant@example.com');
    expect(JSON.stringify(evidence)).not.toContain('ship it');
  });
});

function sevenPosthogSnapshots(startDate: string, counts: readonly number[]): DailyMetricSnapshot[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  return counts.map((count, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return {
      source: 'posthog',
      date: date.toISOString().slice(0, 10),
      collectedAt: '2026-08-22T00:05:00.000Z',
      status: 'complete',
      metrics: { app_opened_count: count },
      notes: [],
    };
  });
}
