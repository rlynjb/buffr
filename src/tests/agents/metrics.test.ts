import { describe, expect, it } from 'vitest';
import { calculateMetricSnapshot } from '../../agents/metrics/agent.js';
import { makeFixtureListingEvidence } from '../fixtures/listing.js';

describe('deterministic M2 metrics', () => {
  it('calculates the initial metric snapshot from normalized listing evidence', () => {
    const output = calculateMetricSnapshot(makeFixtureListingEvidence());

    expect(output).toEqual({
      phase: 'initial',
      comparisonQuality: 'limited',
      unresolvedQualificationNeeds: [],
      metrics: [
        metric('conversion_rate', 0.02),
        metric('favorite_rate', 0.1),
        metric('click_through_rate', 0.1),
        metric('revenue_per_view_cents', 14),
        metric('average_order_value_cents', 700),
        metric('return_on_ad_spend', 1.4),
      ],
    });
  });

  it('marks metrics unavailable when required denominators are missing', () => {
    const output = calculateMetricSnapshot(
      makeFixtureListingEvidence({
        stats: {
          views: 0,
          favorites: 10,
          orders: 2,
          revenueCents: 1400,
          adImpressions: 0,
          adClicks: 20,
          adSpendCents: 0,
          adRevenueCents: 700,
        },
      }),
    );

    expect(output.metrics).toEqual([
      unavailableMetric('conversion_rate'),
      unavailableMetric('favorite_rate'),
      unavailableMetric('click_through_rate'),
      unavailableMetric('revenue_per_view_cents'),
      metric('average_order_value_cents', 700),
      unavailableMetric('return_on_ad_spend'),
    ]);
    expect(output.comparisonQuality).toBe('limited');
    expect(output.unresolvedQualificationNeeds).toEqual([
      'conversion_rate requires orders and views greater than zero',
      'favorite_rate requires favorites and views greater than zero',
      'click_through_rate requires ad clicks and ad impressions greater than zero',
      'revenue_per_view_cents requires revenue and views greater than zero',
      'return_on_ad_spend requires ad revenue and ad spend greater than zero',
    ]);
  });
});

function metric(name: string, current: number) {
  return {
    name,
    current,
    baseline: null,
    absoluteChange: null,
    percentageChange: null,
    qualification: 'inconclusive',
    confidence: 'moderate',
  };
}

function unavailableMetric(name: string) {
  return {
    name,
    current: null,
    baseline: null,
    absoluteChange: null,
    percentageChange: null,
    qualification: 'not_available',
    confidence: 'low',
  };
}
