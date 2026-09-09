import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadMarketplaceListingContext,
  loadRollingMarketplaceVisibilityContext,
  loadMarketplaceVisibilityContext,
} from '../../connectors/marketplace/local-context.js';

describe('marketplace visibility local context loader', () => {
  it('loads a strict local context JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'visibility-context-'));
    const file = join(dir, 'merchgrid.json');
    await writeFile(file, JSON.stringify({
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
      productType: 'shopify_app',
      targetCustomer: 'Shopify merchants auditing catalog quality',
      customerProblem: 'Catalog issues can hurt trust before the merchant notices',
      currentPromise: 'Find catalog issues before they hurt sales or trust',
      currentSurfaceSummary: 'Shopify app listing for catalog audits',
      primaryDiscoverySurface: 'Shopify App Store search and category pages',
      primaryActionWanted: 'Open the app and run the first catalog audit',
      constraints: ['manual listing changes only'],
      availableAssets: ['listing copy', 'screenshots'],
      ownerGoal: 'increase qualified app opens and first scans',
    }), 'utf8');

    await expect(loadMarketplaceVisibilityContext(file)).resolves.toMatchObject({
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
    });
  });

  it('keeps legacy loader compatible but requires productRef from the rolling loader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rolling-visibility-context-'));
    const file = join(dir, 'merchgrid.json');
    const legacyContext = {
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
      productType: 'shopify_app',
      targetCustomer: 'Shopify merchants auditing catalog quality',
      customerProblem: 'Catalog issues can hurt trust before the merchant notices',
      currentPromise: 'Find catalog issues before they hurt sales or trust',
      currentSurfaceSummary: 'Shopify app listing for catalog audits',
      primaryDiscoverySurface: 'Shopify App Store search and category pages',
      primaryActionWanted: 'Open the app and run the first catalog audit',
      constraints: ['manual listing changes only'],
      availableAssets: ['listing copy', 'screenshots'],
      ownerGoal: 'increase qualified app opens and first scans',
    };
    await writeFile(file, JSON.stringify(legacyContext), 'utf8');

    await expect(loadMarketplaceVisibilityContext(file)).resolves.toMatchObject({ productName: 'MerchGrid' });
    await expect(loadRollingMarketplaceVisibilityContext(file)).rejects.toMatchObject({ code: 'validation_failed' });

    await writeFile(file, JSON.stringify({ ...legacyContext, productRef: 'merchgrid-shopify-app' }), 'utf8');
    await expect(loadRollingMarketplaceVisibilityContext(file)).resolves.toMatchObject({
      productRef: 'merchgrid-shopify-app',
    });
  });

  it('rejects non-local references and unsafe keys', async () => {
    await expect(loadMarketplaceVisibilityContext('https://example.com/context.json')).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('loads a local marketplace listing context file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'listing-context-'));
    const file = join(dir, 'merchgrid-listing-context.json');
    await writeFile(file, JSON.stringify({
      marketplace: 'shopify_app_store',
      profile: 'merchgrid_shopify_app_store',
      productName: 'MerchGrid',
      sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
      capturedAt: '2026-08-24T12:00:00.000Z',
      captureMode: 'manual_visual_review',
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
        clearClaims: ['detect below cost pricing'],
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
    }), 'utf8');

    await expect(loadMarketplaceListingContext(file)).resolves.toMatchObject({
      sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
      gallery: { imageCount: 4 },
    });
  });

  it('rejects remote listing context paths', async () => {
    await expect(loadMarketplaceListingContext('https://example.com/context.json')).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Marketplace listing context path must be a local file',
    });
  });

  it('loads the committed MerchGrid listing context example', async () => {
    await expect(loadMarketplaceListingContext('docs/examples/merchgrid-listing-context.example.json')).resolves.toMatchObject({
      productName: 'MerchGrid',
      sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
    });
  });
});
