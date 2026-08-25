import { describe, expect, it } from 'vitest';
import {
  MarketplaceListingContextSchema,
  MarketplaceVisibilityContextSchema,
  MarketplaceVisibilityEvidenceSchema,
  parseMarketplaceVisibilityEvidence,
} from '../../contracts/marketplace-visibility.js';

describe('marketplace visibility evidence contract', () => {
  const merchGridContext = (overrides: Record<string, unknown> = {}) => ({
    marketplace: 'shopify_app_store' as const,
    productName: 'MerchGrid',
    productType: 'shopify_app' as const,
    targetCustomer: 'Shopify merchants auditing catalog quality',
    customerProblem: 'Catalog issues can hurt trust before the merchant notices',
    currentPromise: 'Find catalog issues before they hurt sales or trust',
    currentSurfaceSummary: 'Shopify app listing for a catalog audit app',
    primaryDiscoverySurface: 'Shopify App Store search and category pages',
    primaryActionWanted: 'Open the app and run the first catalog audit',
    constraints: ['manual listing changes only'],
    availableAssets: ['listing copy', 'screenshots'],
    ownerGoal: 'increase qualified app opens and first scans',
    ...overrides,
  });

  const etsyContext = (overrides: Record<string, unknown> = {}) => ({
    marketplace: 'etsy' as const,
    productName: 'Printable Weekly Planner',
    productType: 'digital_product' as const,
    targetCustomer: 'Planner buyers organizing weekly routines',
    customerProblem: 'Busy buyers need a simple printable weekly planning layout',
    currentPromise: 'Plan the week with a clean printable planner',
    currentSurfaceSummary: 'Etsy listing with printable planner title and tags',
    primaryDiscoverySurface: 'Etsy search and listing recommendations',
    primaryActionWanted: 'Click the listing and save the printable planner',
    constraints: ['manual listing changes only'],
    availableAssets: ['listing title', 'listing images'],
    ownerGoal: 'increase qualified listing clicks',
    ...overrides,
  });

  const exploratoryReviewMode = () => ({
    mode: 'exploratory_visibility_test' as const,
    evidenceLevel: 'sparse' as const,
    confidenceBoundary: 'low' as const,
    reason: 'metrics_sparse_context_sufficient' as const,
  });

  const merchGridListingContext = (overrides: Record<string, unknown> = {}) => ({
    marketplace: 'shopify_app_store' as const,
    profile: 'merchgrid_shopify_app_store' as const,
    productName: 'MerchGrid',
    sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
    capturedAt: '2026-08-24T12:00:00.000Z',
    captureMode: 'manual_visual_review' as const,
    publicSurface: {
      title: 'MerchGrid Catalog Audit',
      headline: 'Scans your product catalog and shows exactly which items are priced below cost',
      category: 'Analytics',
      pricingLabel: 'Free',
      ratingSummary: '0 reviews',
      reviewCount: 0,
      launchDate: 'August 7, 2026',
    },
    gallery: {
      imageCount: 4,
      observedImageLabels: ['main image', 'onboarding image', 'progress image', 'result image'],
      visualNotes: ['screenshots show audit flow and result surface'],
    },
    trustSignals: {
      positive: ['free pricing', 'privacy policy visible'],
      friction: ['no reviews yet', 'data access disclosure may need safety copy'],
    },
    copyNotes: {
      clearClaims: ['detect below cost pricing', 'find duplicate and missing skus'],
      unclearClaims: ['read only safety is not prominent'],
      missingContext: ['first scan outcome could be clearer'],
    },
    visibilityRubricNotes: {
      promiseClarity: 'pricing issue promise is concrete',
      audienceSpecificity: 'merchant role is implied but not explicit',
      problemActionFit: 'catalog audit connects to first scan',
      discoveryFit: 'analytics category may require clearer catalog audit keywords',
      trustAndRiskReduction: 'read only safety should be easier to see',
      assetClarity: 'gallery shows screens but outcome hierarchy may need review',
    },
    limitations: ['manual public page review only'],
    ...overrides,
  });

  it('accepts a complete MerchGrid visibility brief', () => {
    expect(MarketplaceVisibilityContextSchema.parse({
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
      productType: 'shopify_app',
      targetCustomer: 'Shopify merchants reviewing catalog quality',
      customerProblem: 'Catalog issues can hurt trust before the merchant notices',
      currentPromise: 'Find catalog issues before they hurt sales or trust',
      currentSurfaceSummary: 'Shopify App Store listing for a catalog audit app',
      primaryDiscoverySurface: 'Shopify App Store search and category browsing',
      primaryActionWanted: 'Open the app and run the first catalog audit',
      constraints: ['manual listing changes only'],
      availableAssets: ['listing copy', 'screenshots'],
      ownerGoal: 'increase qualified app opens and first scans',
    })).toMatchObject({
      productType: 'shopify_app',
      primaryActionWanted: 'Open the app and run the first catalog audit',
    });
  });

  it('rejects a visibility brief without a target customer', () => {
    expect(() => MarketplaceVisibilityContextSchema.parse({
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
      productType: 'shopify_app',
      customerProblem: 'Catalog issues can hurt trust',
      currentPromise: 'Find catalog issues',
      currentSurfaceSummary: 'Shopify listing',
      primaryDiscoverySurface: 'Shopify App Store search',
      primaryActionWanted: 'Run the first catalog audit',
      constraints: ['manual listing changes only'],
      availableAssets: ['listing copy'],
      ownerGoal: 'increase qualified app opens',
    })).toThrow();
  });

  const sparseEvidence = () => ({
    product: 'marketplace_visibility' as const,
    profile: 'merchgrid_shopify_app_store' as const,
    subjectRef: 'merchgrid:visibility:2026-08-22',
    artifactRef: '.local/artifacts/daily-health/2026-08-22.json',
    evidenceLevel: 'sparse' as const,
    recommendationType: 'visibility_hypothesis' as const,
    reviewMode: exploratoryReviewMode(),
    marketplaceContext: {
      ...merchGridContext(),
    },
    measuredSignals: {},
    limitations: ['low request volume'],
    prohibitedClaims: ['Do not claim the listing caused low traffic'],
  });

  it('accepts sparse MerchGrid marketplace evidence', () => {
    expect(parseMarketplaceVisibilityEvidence({
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
        ...merchGridContext(),
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
      reviewMode: { mode: 'exploratory_visibility_test' },
    });
  });

  it('accepts the fixture-backed Etsy profile limitation', () => {
    expect(parseMarketplaceVisibilityEvidence({
      ...sparseEvidence(),
      profile: 'etsy_listing',
      subjectRef: 'etsy:visibility:listing-123',
      artifactRef: '.local/etsy-visibility-context.json',
      marketplaceContext: {
        ...etsyContext(),
      },
      limitations: ['etsy runtime profile is fixture-backed in this slice'],
    })).toMatchObject({ profile: 'etsy_listing' });
  });

  it('accepts public marketplace listing context', () => {
    expect(MarketplaceListingContextSchema.parse(merchGridListingContext())).toMatchObject({
      marketplace: 'shopify_app_store',
      sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
      gallery: { imageCount: 4 },
    });
  });

  it('allows marketplace visibility evidence to reference listing context', () => {
    expect(parseMarketplaceVisibilityEvidence({
      ...sparseEvidence(),
      artifactRef: '.local/merchgrid-metrics/artifacts/daily-health/2026-08-22.json',
      listingContext: merchGridListingContext(),
    })).toMatchObject({
      listingContext: {
        sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
        trustSignals: { friction: ['no reviews yet', 'data access disclosure may need safety copy'] },
      },
    });
  });

  it.each([
    { sourceUrl: 'http://apps.shopify.com/merchgrid-catalog-audit' },
    { sourceUrl: 'https://partners.shopify.com/123/apps/456' },
    { sourceUrl: 'file:///tmp/listing.html' },
    { rawHtml: '<html>listing</html>' },
    { cookies: 'sid=secret' },
    { trustSignals: { positive: ['free pricing'], friction: ['customer email jane@example.com'] } },
  ])('rejects unsafe listing context values %#', (unsafe) => {
    expect(() => MarketplaceListingContextSchema.parse({
      ...merchGridListingContext(),
      ...unsafe,
    })).toThrow();
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
        ...merchGridContext(),
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
        ...merchGridContext(),
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
        ...merchGridContext(),
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

  it.each([
    { currentSurfaceSummary: 'Customer Jane Doe order #ABC' },
    { currentSurfaceSummary: 'Merchant acme-shop customer list' },
    { currentSurfaceSummary: 'Raw marketplace listing: Buy now' },
  ])('rejects unsafe data variants in permitted summary strings', (unsafeSummary) => {
    expect(() => MarketplaceVisibilityEvidenceSchema.parse({
      product: 'marketplace_visibility',
      profile: 'merchgrid_shopify_app_store',
      subjectRef: 'merchgrid:visibility:2026-08-22',
      artifactRef: '.local/artifacts/daily-health/2026-08-22.json',
      evidenceLevel: 'sparse',
      recommendationType: 'visibility_hypothesis',
      marketplaceContext: {
        ...merchGridContext(unsafeSummary),
      },
      measuredSignals: {},
      limitations: [],
      prohibitedClaims: [],
    })).toThrow();
  });

  it.each([
    ['productName', (evidence: ReturnType<typeof sparseEvidence>) => ({
      ...evidence,
      marketplaceContext: { ...evidence.marketplaceContext, productName: 'Buyer Jane Doe purchase history' },
    })],
    ['currentSurfaceSummary', (evidence: ReturnType<typeof sparseEvidence>) => ({
      ...evidence,
      marketplaceContext: { ...evidence.marketplaceContext, currentSurfaceSummary: 'Marketplace listing data: title and price' },
    })],
    ['targetCustomer', (evidence: ReturnType<typeof sparseEvidence>) => ({
      ...evidence,
      marketplaceContext: { ...evidence.marketplaceContext, targetCustomer: 'Buyer Jane Doe purchase history' },
    })],
    ['primaryDiscoverySurface', (evidence: ReturnType<typeof sparseEvidence>) => ({
      ...evidence,
      marketplaceContext: { ...evidence.marketplaceContext, primaryDiscoverySurface: 'Marketplace listing data: title and price' },
    })],
    ['subjectRef', (evidence: ReturnType<typeof sparseEvidence>) => ({ ...evidence, subjectRef: 'Buyer Jane Doe purchase history' })],
    ['limitations', (evidence: ReturnType<typeof sparseEvidence>) => ({ ...evidence, limitations: ['Buyer Jane Doe purchase history'] })],
    ['prohibitedClaims', (evidence: ReturnType<typeof sparseEvidence>) => ({ ...evidence, prohibitedClaims: ['Marketplace listing data: title and price'] })],
  ])('rejects uncurated marketplace data in %s', (_field, unsafeEvidence) => {
    expect(() => MarketplaceVisibilityEvidenceSchema.parse(unsafeEvidence(sparseEvidence()))).toThrow();
  });

  it.each([
    ['currentSurfaceSummary', (evidence: ReturnType<typeof sparseEvidence>) => ({
      ...evidence,
      marketplaceContext: { ...evidence.marketplaceContext, currentSurfaceSummary: 'Customer-facing catalog app' },
    })],
    ['targetCustomer', (evidence: ReturnType<typeof sparseEvidence>) => ({
      ...evidence,
      marketplaceContext: { ...evidence.marketplaceContext, targetCustomer: 'Merchant data quality tools' },
    })],
  ])('accepts ordinary marketplace descriptions in %s', (_field, safeEvidence) => {
    expect(MarketplaceVisibilityEvidenceSchema.parse(safeEvidence(sparseEvidence()))).toMatchObject({
      product: 'marketplace_visibility',
    });
  });

  it.each([
    ['card details in a summary', (evidence: ReturnType<typeof sparseEvidence>) => ({
      ...evidence,
      marketplaceContext: {
        ...evidence.marketplaceContext,
        currentSurfaceSummary: 'Jane Doe credit card 4111111111111111',
      },
    })],
    ['a bare payment card number', (evidence: ReturnType<typeof sparseEvidence>) => ({
      ...evidence,
      limitations: ['4111111111111111'],
    })],
    ['an email address', (evidence: ReturnType<typeof sparseEvidence>) => ({
      ...evidence,
      marketplaceContext: {
        ...evidence.marketplaceContext,
        targetCustomer: 'Contact Jane Doe at jane@example.com',
      },
    })],
    ['a phone number', (evidence: ReturnType<typeof sparseEvidence>) => ({
      ...evidence,
      prohibitedClaims: ['Contact Jane Doe at 415-555-0123'],
    })],
  ])('rejects PII or payment-card-looking prose: %s', (_case, unsafeEvidence) => {
    expect(() => MarketplaceVisibilityEvidenceSchema.parse(unsafeEvidence(sparseEvidence()))).toThrow();
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
        ...etsyContext({
          productName: 'Printable Planner',
          currentSurfaceSummary: 'Etsy listing for a printable planner',
        }),
      },
      measuredSignals: {},
      limitations: [],
      prohibitedClaims: [],
    })).toThrow();
  });
});
