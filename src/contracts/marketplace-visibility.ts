import { z } from 'zod';

const UnsafeKeyPattern = /(token|secret|authorization|password|email|shopDomain|rawEvents|payload|providerUrl)/iu;
const UnsafeValuePattern = /(https?:\/\/|(?:^|[\s"'`])[\w.-]+\.myshopify\.com\b|(?:api[_ -]?key|access[_ -]?token|personal[_ -]?api[_ -]?key)\s*[:=]|raw[_ -]?(?:events?|payload)|\{\s*["']?(?:events?|payload|data)["']?\s*:|customer\s+.+?\s+order\s*#?\d+|merchant\s+\S+\s+internal\s+catalog\s+export|raw\s+marketplace\s+listing)/iu;

export const MarketplaceVisibilityProfileSchema = z.enum([
  'merchgrid_shopify_app_store',
  'etsy_listing',
]);

export const MarketplaceVisibilityContextSchema = z.object({
  marketplace: z.enum(['shopify_app_store', 'etsy']),
  productName: z.string().min(1).max(120),
  currentSurfaceSummary: z.string().min(1).max(1_000),
  targetAudience: z.string().min(1).max(300).optional(),
  knownDiscoverySurface: z.string().min(1).max(300).optional(),
}).strict();

export const MarketplaceVisibilityEvidenceSchema = z.object({
  product: z.literal('marketplace_visibility'),
  profile: MarketplaceVisibilityProfileSchema,
  subjectRef: z.string().min(1).max(200),
  artifactRef: z.string().min(1).max(500).refine((value) => !value.includes('://'), 'artifactRef must be local'),
  evidenceLevel: z.literal('sparse'),
  recommendationType: z.literal('visibility_hypothesis'),
  marketplaceContext: MarketplaceVisibilityContextSchema,
  measuredSignals: z.record(z.string().min(1), z.number().finite()),
  limitations: z.array(z.string().min(1).max(300)),
  prohibitedClaims: z.array(z.string().min(1).max(300)),
}).strict().superRefine((value, ctx) => {
  assertNoUnsafeKeys(value, ctx);
});

export type MarketplaceVisibilityEvidence = z.infer<typeof MarketplaceVisibilityEvidenceSchema>;
export type MarketplaceVisibilityProfile = z.infer<typeof MarketplaceVisibilityProfileSchema>;
export type MarketplaceVisibilityContext = z.infer<typeof MarketplaceVisibilityContextSchema>;

export function parseMarketplaceVisibilityEvidence(value: unknown): MarketplaceVisibilityEvidence {
  return MarketplaceVisibilityEvidenceSchema.parse(value);
}

function assertNoUnsafeKeys(value: unknown, ctx: z.RefinementCtx, path: (string | number)[] = []): void {
  if (typeof value === 'string') {
    if (UnsafeValuePattern.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'unsafe value' });
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (UnsafeKeyPattern.test(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, key], message: `unsafe key: ${key}` });
    }
    assertNoUnsafeKeys(child, ctx, [...path, key]);
  }
}
