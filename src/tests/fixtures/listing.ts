import type { NormalizedListingEvidence } from '../../contracts/evidence.js';

export function makeFixtureListingEvidence(
  overrides: Partial<NormalizedListingEvidence> = {},
): NormalizedListingEvidence {
  return {
    listingId: 'listing-123',
    shopId: 'shop-456',
    title: 'Printable Weekly Planner',
    description: 'A printable PDF planner for busy Etsy buyers.',
    tags: ['planner', 'printable', 'weekly'],
    priceCents: 700,
    currency: 'USD',
    state: 'active',
    url: 'https://www.etsy.com/listing/123/printable-weekly-planner',
    stats: {
      impressions: 1000,
      views: 100,
      favorites: 10,
      orders: 2,
      revenueCents: 1400,
      adImpressions: 200,
      adClicks: 20,
      adSpendCents: 500,
      adRevenueCents: 700,
    },
    observedAt: '2026-08-12T00:00:00.000Z',
    source: 'etsy',
    ...overrides,
  };
}
