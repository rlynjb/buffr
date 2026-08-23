import { describe, expect, it } from 'vitest';
import {
  MarketplaceVisibilityEvidenceSchema,
  parseMarketplaceVisibilityEvidence,
} from '../../contracts/marketplace-visibility.js';

describe('marketplace visibility evidence contract', () => {
  it('accepts sparse MerchGrid marketplace evidence', () => {
    expect(parseMarketplaceVisibilityEvidence({
      product: 'marketplace_visibility',
      profile: 'merchgrid_shopify_app_store',
      subjectRef: 'merchgrid:visibility:2026-08-22',
      artifactRef: '.local/merchgrid-metrics/artifacts/daily-health/2026-08-22.json',
      evidenceLevel: 'sparse',
      recommendationType: 'visibility_hypothesis',
      marketplaceContext: {
        marketplace: 'shopify_app_store',
        productName: 'MerchGrid',
        currentSurfaceSummary: 'Shopify app listing for a catalog audit app',
        targetAudience: 'Shopify merchants auditing catalog quality',
        knownDiscoverySurface: 'Shopify App Store search and category pages',
      },
      measuredSignals: {
        app_opened_count: 0,
        request_count: 2,
      },
      limitations: ['low request volume'],
      prohibitedClaims: ['Do not claim the listing caused low traffic'],
    })).toMatchObject({
      product: 'marketplace_visibility',
      evidenceLevel: 'sparse',
      recommendationType: 'visibility_hypothesis',
    });
  });

  it.each([
    { POSTHOG_PERSONAL_API_KEY: 'secret' },
    { FLY_ACCESS_TOKEN: 'secret' },
    { rawEvents: [{ event: 'app_opened' }] },
    { shopDomain: 'private-shop.myshopify.com' },
    { providerUrl: 'https://api.posthog.com/query' },
  ])('rejects unsafe provider details', (unsafe) => {
    expect(() => MarketplaceVisibilityEvidenceSchema.parse({
      product: 'marketplace_visibility',
      profile: 'merchgrid_shopify_app_store',
      subjectRef: 'merchgrid:visibility:2026-08-22',
      artifactRef: '.local/artifacts/daily-health/2026-08-22.json',
      evidenceLevel: 'sparse',
      recommendationType: 'visibility_hypothesis',
      marketplaceContext: {
        marketplace: 'shopify_app_store',
        productName: 'MerchGrid',
        currentSurfaceSummary: 'Shopify app listing',
      },
      measuredSignals: {},
      limitations: [],
      prohibitedClaims: [],
      ...unsafe,
    })).toThrow();
  });

  it.each([
    {
      marketplaceContext: {
        marketplace: 'shopify_app_store' as const,
        productName: 'MerchGrid',
        currentSurfaceSummary: 'Observed shop at my-shop.myshopify.com',
      },
    },
    { limitations: ['POSTHOG_PERSONAL_API_KEY=secret'] },
    { marketplaceContext: {
      marketplace: 'shopify_app_store' as const,
      productName: 'MerchGrid',
      currentSurfaceSummary: 'Provider response https://api.posthog.com/query: {"events":[]}',
    } },
  ])('rejects unsafe provider or private data embedded in allowed strings', (unsafeValues) => {
    expect(() => MarketplaceVisibilityEvidenceSchema.parse({
      product: 'marketplace_visibility',
      profile: 'merchgrid_shopify_app_store',
      subjectRef: 'merchgrid:visibility:2026-08-22',
      artifactRef: '.local/artifacts/daily-health/2026-08-22.json',
      evidenceLevel: 'sparse',
      recommendationType: 'visibility_hypothesis',
      marketplaceContext: {
        marketplace: 'shopify_app_store',
        productName: 'MerchGrid',
        currentSurfaceSummary: 'Shopify app listing',
      },
      measuredSignals: {},
      limitations: [],
      prohibitedClaims: [],
      ...unsafeValues,
    })).toThrow();
  });

  it.each([
    { marketplaceContext: {
      marketplace: 'shopify_app_store' as const,
      productName: 'MerchGrid',
      currentSurfaceSummary: 'Customer Jane Doe order #123',
    } },
    { marketplaceContext: {
      marketplace: 'shopify_app_store' as const,
      productName: 'MerchGrid',
      currentSurfaceSummary: 'Merchant acme-shop internal catalog export',
    } },
    { marketplaceContext: {
      marketplace: 'shopify_app_store' as const,
      productName: 'MerchGrid',
      currentSurfaceSummary: 'Raw marketplace listing text: Buy now, free shipping',
    } },
  ])('rejects merchant, customer, catalog, or raw listing text in allowed strings', (unsafeValues) => {
    const baseEvidence = {
      product: 'marketplace_visibility' as const,
      profile: 'merchgrid_shopify_app_store' as const,
      subjectRef: 'merchgrid:visibility:2026-08-22',
      artifactRef: '.local/artifacts/daily-health/2026-08-22.json',
      evidenceLevel: 'sparse' as const,
      recommendationType: 'visibility_hypothesis' as const,
      marketplaceContext: {
        marketplace: 'shopify_app_store' as const,
        productName: 'MerchGrid',
        currentSurfaceSummary: 'Shopify app listing',
      },
      measuredSignals: {},
      limitations: [],
      prohibitedClaims: [],
    };
    expect(() => MarketplaceVisibilityEvidenceSchema.parse({
      ...baseEvidence,
      ...unsafeValues,
    })).toThrow();
  });

  it('rejects provider URLs as artifact references', () => {
    expect(() => MarketplaceVisibilityEvidenceSchema.parse({
      product: 'marketplace_visibility',
      profile: 'etsy_listing',
      subjectRef: 'etsy:visibility:listing-123',
      artifactRef: 'https://etsy.com/listing/123',
      evidenceLevel: 'sparse',
      recommendationType: 'visibility_hypothesis',
      marketplaceContext: {
        marketplace: 'etsy',
        productName: 'Printable Planner',
        currentSurfaceSummary: 'Etsy listing for a printable planner',
      },
      measuredSignals: {},
      limitations: [],
      prohibitedClaims: [],
    })).toThrow();
  });
});
