import { describe, expect, it } from 'vitest';
import { evidenceRef } from '../../workflow/state.js';
import type { MarketplaceVisibilityEvidence } from '../../contracts/marketplace-visibility.js';

describe('workflow evidence references', () => {
  it('builds a stable reference for marketplace visibility evidence', () => {
    const evidence: MarketplaceVisibilityEvidence = {
      product: 'marketplace_visibility',
      profile: 'merchgrid_shopify_app_store',
      subjectRef: 'merchgrid:visibility:2026-08-22',
      artifactRef: '.local/merchgrid-metrics/artifacts/daily-health/2026-08-22.json',
      evidenceLevel: 'sparse',
      recommendationType: 'visibility_hypothesis',
      reviewMode: {
        mode: 'exploratory_visibility_test',
        evidenceLevel: 'sparse',
        confidenceBoundary: 'low',
        reason: 'metrics_sparse_context_sufficient',
      },
      marketplaceContext: {
        marketplace: 'shopify_app_store',
        productName: 'MerchGrid',
        productType: 'shopify_app',
        targetCustomer: 'Shopify merchants auditing catalog quality',
        customerProblem: 'Catalog issues can hurt trust before the merchant notices',
        currentPromise: 'Find catalog issues before they hurt sales or trust',
        currentSurfaceSummary: 'Shopify app listing for a catalog audit app',
        primaryDiscoverySurface: 'Shopify App Store search and category pages',
        primaryActionWanted: 'Open the app and run the first catalog audit',
        constraints: ['manual listing changes only'],
        availableAssets: ['listing copy', 'screenshots'],
        ownerGoal: 'increase qualified app opens and first scans',
      },
      measuredSignals: { request_count: 2 },
      limitations: ['low request volume'],
      prohibitedClaims: ['Do not claim the listing caused low traffic'],
    };

    expect(evidenceRef('initial', evidence)).toBe(
      'initial:marketplace_visibility:merchgrid_shopify_app_store:merchgrid:visibility:2026-08-22',
    );
  });
});
