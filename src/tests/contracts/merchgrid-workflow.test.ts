import { describe, expect, it } from 'vitest';
import { MerchGridReviewEvidenceSchema } from '../../metrics/evidence.js';
import { parseMerchGridWorkflowEvidence } from '../../contracts/merchgrid-workflow.js';

const weeklyArtifact = {
  period: {
    kind: 'weekly',
    previous: { startDate: '2026-08-08', endDate: '2026-08-14' },
    current: { startDate: '2026-08-15', endDate: '2026-08-21' },
  },
  sourceCoverage: {
    previous: {
      posthog: { complete: 7 },
      fly_metrics: { complete: 7 },
      shopify_partner: { complete: 7 },
    },
    current: {
      posthog: { complete: 7 },
      fly_metrics: { complete: 7 },
      shopify_partner: { complete: 7 },
    },
  },
  sourceFreshness: {
    previous: {},
    current: {},
  },
  aggregateMetrics: {
    previous: { posthog: { app_opened_count: 8 } },
    current: { posthog: { app_opened_count: 10 } },
    change: { posthog: { app_opened_count: 2 } },
  },
  limitations: [],
};

describe('MerchGrid workflow evidence contract', () => {
  it('projects a valid weekly artifact into workflow evidence with a local reference', () => {
    expect(
      parseMerchGridWorkflowEvidence(
        weeklyArtifact,
        'artifacts/merchgrid/metrics/artifacts/weekly-reviews/2026-08-21.json',
      ),
    ).toMatchObject({
      product: 'merchgrid',
      kind: 'weekly_review',
      artifactRef: 'artifacts/merchgrid/metrics/artifacts/weekly-reviews/2026-08-21.json',
    });
  });

  it.each([
    { POSTHOG_PERSONAL_API_KEY: 'secret' },
    { rawEvents: [{ event: 'scan_started' }] },
    { shopDomain: 'private-shop.myshopify.com' },
  ])('rejects an unsafe artifact field', (unsafe) => {
    expect(() => MerchGridReviewEvidenceSchema.parse({ ...weeklyArtifact, ...unsafe })).toThrow();
  });

  it('rejects a provider URL as an artifact reference', () => {
    expect(() => parseMerchGridWorkflowEvidence(weeklyArtifact, 'https://api.posthog.com/query')).toThrow();
  });

  it('rejects an unapproved metric key even when it is nested in aggregate metrics', () => {
    expect(() => MerchGridReviewEvidenceSchema.parse({
      ...weeklyArtifact,
      aggregateMetrics: {
        ...weeklyArtifact.aggregateMetrics,
        current: { posthog: { raw_events: 1 } },
      },
    })).toThrow();
  });

  it('rejects an approved metric when it is assigned to the wrong source', () => {
    expect(() => MerchGridReviewEvidenceSchema.parse({
      ...weeklyArtifact,
      aggregateMetrics: {
        ...weeklyArtifact.aggregateMetrics,
        current: { fly_metrics: { installs: 1 } },
      },
    })).toThrow();
  });
});
