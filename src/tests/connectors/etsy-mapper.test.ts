import { describe, expect, it } from 'vitest';
import { mapEtsyListingToEvidence } from '../../connectors/etsy/mapper.js';

describe('Etsy evidence mapper', () => {
  it('maps Etsy listing response fields into normalized listing evidence', () => {
    const evidence = mapEtsyListingToEvidence(
      {
        listing_id: 123,
        user_id: 456,
        title: 'Printable Weekly Planner',
        description: 'A printable PDF planner',
        tags: ['planner'],
        price: { amount: 700, divisor: 100, currency_code: 'USD' },
        state: 'active',
        url: 'https://www.etsy.com/listing/123/printable-weekly-planner',
      },
      '2026-08-12T00:00:00.000Z',
    );

    expect(evidence).toMatchObject({
      listingId: '123',
      shopId: '456',
      title: 'Printable Weekly Planner',
      description: 'A printable PDF planner',
      tags: ['planner'],
      priceCents: 700,
      currency: 'USD',
      state: 'active',
      url: 'https://www.etsy.com/listing/123/printable-weekly-planner',
      observedAt: '2026-08-12T00:00:00.000Z',
      source: 'etsy',
    });
  });

  it('rejects Etsy payloads containing credential-like fields', () => {
    expect(() =>
      mapEtsyListingToEvidence(
        {
          listing_id: 123,
          user_id: 456,
          title: 'Printable Weekly Planner',
          api_key: 'secret-value',
        },
        '2026-08-12T00:00:00.000Z',
      ),
    ).toThrow('Credential-like key is not allowed in workflow data: api_key');
  });
});
