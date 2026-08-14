import { z } from 'zod';

export const EvidenceSourceSchema = z.enum(['etsy', 'web', 'user', 'derived']);
export const IsoDateSchema = z.string().datetime();

export const ListingStatsSchema = z
  .object({
    impressions: z.number().int().nonnegative().optional(),
    views: z.number().int().nonnegative().optional(),
    visits: z.number().int().nonnegative().optional(),
    favorites: z.number().int().nonnegative().optional(),
    orders: z.number().int().nonnegative().optional(),
    revenueCents: z.number().int().nonnegative().optional(),
    adImpressions: z.number().int().nonnegative().optional(),
    adClicks: z.number().int().nonnegative().optional(),
    adSpendCents: z.number().int().nonnegative().optional(),
    adRevenueCents: z.number().int().nonnegative().optional(),
  })
  .strict();

export const NormalizedListingEvidenceSchema = z
  .object({
    listingId: z.string().min(1),
    shopId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
    priceCents: z.number().int().nonnegative().optional(),
    currency: z.string().min(3).max(3).optional(),
    state: z.string().optional(),
    url: z.string().url().optional(),
    stats: ListingStatsSchema.default({}),
    observedAt: IsoDateSchema,
    source: EvidenceSourceSchema,
  })
  .strict();

export type ListingStats = z.infer<typeof ListingStatsSchema>;
export type NormalizedListingEvidence = z.infer<typeof NormalizedListingEvidenceSchema>;
