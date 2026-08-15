import { z } from 'zod';
import {
  NormalizedListingEvidenceSchema,
  type NormalizedListingEvidence,
} from '../../contracts/evidence.js';
import { parseWithSchema } from '../../contracts/workflow.js';
import { assertNoCredentialKeys } from '../../workflow/guards.js';

const EtsyListingSchema = z
  .object({
    listing_id: z.union([z.string(), z.number()]),
    user_id: z.union([z.string(), z.number()]),
    title: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
    price: z
      .object({
        amount: z.number().int().nonnegative(),
        divisor: z.number().int().positive().optional(),
        currency_code: z.string().min(3).max(3),
      })
      .optional(),
    state: z.string().optional(),
    url: z.string().url().optional(),
  })
  .passthrough();

export function mapEtsyListingToEvidence(input: unknown, observedAt: string): NormalizedListingEvidence {
  assertNoCredentialKeys(input);
  const listing = parseWithSchema(EtsyListingSchema, input, 'Etsy listing response');

  return parseWithSchema(
    NormalizedListingEvidenceSchema,
    {
      listingId: String(listing.listing_id),
      shopId: String(listing.user_id),
      title: listing.title,
      description: listing.description,
      tags: listing.tags,
      priceCents: listing.price?.amount,
      currency: listing.price?.currency_code,
      state: listing.state,
      url: listing.url,
      observedAt,
      source: 'etsy',
      stats: {},
    },
    'normalized Etsy listing evidence',
  );
}
