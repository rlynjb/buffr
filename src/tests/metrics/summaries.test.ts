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
      sourceFreshness: {
        fly_metrics: {
          date: '2026-08-21',
          collectedAt: '2026-08-22T00:05:00.000Z',
          status: 'complete',
          notes: [],
        },
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

  it('derives weekly rates from weekly totals and uses the end-of-period active merchant count', () => {
    const previous = [
      ...sevenMetricSnapshots('posthog', '2026-08-08', (index) => ({
        scan_started_count: 2,
        scan_completed_count: 1,
        scan_completion_rate: index === 0 ? 0.5 : 99,
      })),
      ...sevenMetricSnapshots('fly_metrics', '2026-08-08', () => ({
        request_count: 20,
        error_response_count: 2,
        error_rate: 0.1,
      })),
      ...sevenMetricSnapshots('shopify_partner', '2026-08-08', (index) => ({
        active_merchants: 10 + index,
      })),
    ];
    const current = [
      ...sevenMetricSnapshots('posthog', '2026-08-15', () => ({
        scan_started_count: 4,
        scan_completed_count: 3,
        scan_completion_rate: 0.75,
      })),
      ...sevenMetricSnapshots('fly_metrics', '2026-08-15', () => ({
        request_count: 40,
        error_response_count: 1,
        error_rate: 0.025,
      })),
      ...sevenMetricSnapshots('shopify_partner', '2026-08-15', (index) => ({
        active_merchants: 20 + index,
      })),
    ];

    expect(buildWeeklyBusinessReview({ previous, current }).aggregateMetrics).toMatchObject({
      previous: {
        posthog: { scan_started_count: 14, scan_completed_count: 7, scan_completion_rate: 0.5 },
        fly_metrics: { request_count: 140, error_response_count: 14, error_rate: 0.1 },
        shopify_partner: { active_merchants: 16 },
      },
      current: {
        posthog: { scan_started_count: 28, scan_completed_count: 21, scan_completion_rate: 0.75 },
        fly_metrics: { request_count: 280, error_response_count: 7, error_rate: 0.025 },
        shopify_partner: { active_merchants: 26 },
      },
      change: {
        posthog: { scan_completion_rate: 0.25 },
        shopify_partner: { active_merchants: 10 },
      },
    });
    expect(
      buildWeeklyBusinessReview({ previous, current }).aggregateMetrics.change.fly_metrics?.error_rate,
    ).toBeCloseTo(-0.075);
  });

  it('omits source deltas when either week has fewer than seven complete source days', () => {
    const previous = sevenPosthogSnapshots('2026-08-08', [1, 1, 1, 1, 1, 1, 1]);
    const current = sevenPosthogSnapshots('2026-08-15', [1, 1, 1, 1, 1, 1, 1]);
    current[3] = { ...current[3]!, status: 'failed', metrics: {}, notes: ['transport'] };

    const review = buildWeeklyBusinessReview({ previous, current });

    expect(review.aggregateMetrics.current.posthog).toEqual({ app_opened_count: 6 });
    expect(review.aggregateMetrics.change.posthog).toBeUndefined();
  });

  it('omits a metric delta when a complete day does not contain that metric', () => {
    const previous = sevenMetricSnapshots('posthog', '2026-08-08', () => ({
      scan_started_count: 2,
      scan_completed_count: 1,
    }));
    const current = sevenMetricSnapshots('posthog', '2026-08-15', (index): Record<string, number> =>
      index === 3 ? { scan_started_count: 2 } : { scan_started_count: 2, scan_completed_count: 1 },
    );

    const review = buildWeeklyBusinessReview({ previous, current });

    expect(review.aggregateMetrics.change.posthog).toEqual({ scan_started_count: 0 });
    expect(review.aggregateMetrics.change.posthog).not.toHaveProperty('scan_completed_count');
    expect(review.aggregateMetrics.change.posthog).not.toHaveProperty('scan_completion_rate');
  });

  it('preserves per-source collection times and bounded notes for weekly provenance', () => {
    const previous = sevenMetricSnapshots('shopify_partner', '2026-08-08', () => ({ active_merchants: 4 }));
    const current = sevenMetricSnapshots(
      'shopify_partner',
      '2026-08-15',
      () => ({ active_merchants: 5 }),
      ['manual_import'],
    );

    const review = buildWeeklyBusinessReview({ previous, current });

    expect(review.sourceFreshness.current.shopify_partner).toHaveLength(7);
    expect(review.sourceFreshness.current.shopify_partner?.[6]).toEqual({
      date: '2026-08-21',
      collectedAt: '2026-08-22T00:05:00.000Z',
      status: 'complete',
      notes: ['manual_import'],
    });
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
      sourceFreshness: summary.sourceFreshness,
      aggregateMetrics: summary.aggregateMetrics,
      limitations: summary.limitations,
    });
    expect(Object.keys(evidence).sort()).toEqual([
      'aggregateMetrics',
      'limitations',
      'period',
      'sourceCoverage',
      'sourceFreshness',
    ]);
    expect(JSON.stringify(evidence)).not.toContain('secret');
    expect(JSON.stringify(evidence)).not.toContain('merchant@example.com');
    expect(JSON.stringify(evidence)).not.toContain('ship it');
  });

  it('whitelists weekly provenance while excluding injected source content', () => {
    const summary = buildWeeklyBusinessReview({
      previous: sevenMetricSnapshots('shopify_partner', '2026-08-08', () => ({ installs: 1 }), ['manual_import']),
      current: sevenMetricSnapshots('shopify_partner', '2026-08-15', () => ({ installs: 2 }), ['manual_import']),
    });

    const evidence = toMerchGridReviewEvidence({
      ...summary,
      providerResponse: { authorization: 'Bearer secret' },
    } as typeof summary);

    expect(evidence.sourceFreshness).toEqual(summary.sourceFreshness);
    expect(Object.keys(evidence).sort()).toEqual([
      'aggregateMetrics',
      'limitations',
      'period',
      'sourceCoverage',
      'sourceFreshness',
    ]);
    expect(JSON.stringify(evidence)).not.toContain('Bearer secret');
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

function sevenMetricSnapshots(
  source: DailyMetricSnapshot['source'],
  startDate: string,
  metrics: (index: number) => Record<string, number>,
  notes: DailyMetricSnapshot['notes'] = [],
): DailyMetricSnapshot[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return {
      source,
      date: date.toISOString().slice(0, 10),
      collectedAt: '2026-08-22T00:05:00.000Z',
      status: 'complete',
      metrics: metrics(index),
      notes,
    };
  });
}
