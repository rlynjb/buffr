import { z } from 'zod';

const CuratedTextPattern = /^[\p{L}\p{N}][\p{L}\p{N} &'(),./-]*$/u;
const UncuratedDataPattern = /(?:\b(?:api[ _-]?key|access[ _-]?token|authorization|buyer|credential|customer[ _-]?(?:list|record|history)|domain|email|event(?:s)?|export(?:s|ed|ing)?|history|internal|listing[ _-]?data|order(?:s)?|password|payload|person(?:al)?|private|provider|purchase(?:s|d|ing)?|raw|record(?:s)?|secret|shop[ _-]?domain|source|token)\b|(?:^|[\s"'`])[\w.-]+\.myshopify\.com\b)/iu;
const SensitiveProseValuePatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?:^|\D)(?:\d[ -]?){12,18}\d(?:$|\D)/u,
  /(?:^|\D)(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?:$|\D)/u,
];
const LocalArtifactRefPattern = /^\.local\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SubjectRefPattern = /^(?:merchgrid:visibility:\d{4}-\d{2}-\d{2}|etsy:visibility:listing-[a-z0-9-]+)$/iu;

function safeMarketplaceText(max: number): z.ZodType<string> {
  return z.string()
    .min(1)
    .max(max)
    .regex(CuratedTextPattern, 'must be curated plain text')
    .refine((value) => !UncuratedDataPattern.test(value), 'must not include private or source data markers')
    .refine(
      (value) => !SensitiveProseValuePatterns.some((pattern) => pattern.test(value)),
      'must not include PII or payment-card-looking values',
    );
}

const MarketplaceVisibilitySubjectRefSchema = z.string()
  .regex(SubjectRefPattern, 'must identify a supported visibility review subject');

const MarketplaceVisibilityArtifactRefSchema = z.string()
  .max(500)
  .regex(LocalArtifactRefPattern, 'artifactRef must be a local artifact path')
  .refine((value) => !value.includes('..'), 'artifactRef must not traverse directories')
  .refine((value) => !UncuratedDataPattern.test(value), 'artifactRef must not name private or source data');

const MarketplaceVisibilitySignalKeySchema = z.string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/u, 'must be a normalized signal name')
  .refine((value) => !UncuratedDataPattern.test(value), 'must not name private or source data');

export const MarketplaceVisibilityProfileSchema = z.enum([
  'merchgrid_shopify_app_store',
  'etsy_listing',
]);

export const MarketplaceVisibilityContextSchema = z.object({
  marketplace: z.enum(['shopify_app_store', 'etsy']),
  productName: safeMarketplaceText(120),
  currentSurfaceSummary: safeMarketplaceText(1_000),
  targetAudience: safeMarketplaceText(300).optional(),
  knownDiscoverySurface: safeMarketplaceText(300).optional(),
}).strict();

export const MarketplaceVisibilityEvidenceSchema = z.object({
  product: z.literal('marketplace_visibility'),
  profile: MarketplaceVisibilityProfileSchema,
  subjectRef: MarketplaceVisibilitySubjectRefSchema,
  artifactRef: MarketplaceVisibilityArtifactRefSchema,
  evidenceLevel: z.literal('sparse'),
  recommendationType: z.literal('visibility_hypothesis'),
  marketplaceContext: MarketplaceVisibilityContextSchema,
  measuredSignals: z.record(MarketplaceVisibilitySignalKeySchema, z.number().finite()),
  limitations: z.array(safeMarketplaceText(300)),
  prohibitedClaims: z.array(safeMarketplaceText(300)),
}).strict().superRefine((value, ctx) => {
  const expectedSubjectPrefix = value.profile === 'merchgrid_shopify_app_store'
    ? 'merchgrid:visibility:'
    : 'etsy:visibility:listing-';
  if (!value.subjectRef.startsWith(expectedSubjectPrefix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subjectRef'],
      message: 'subjectRef must match the marketplace profile',
    });
  }
});

export type MarketplaceVisibilityEvidence = z.infer<typeof MarketplaceVisibilityEvidenceSchema>;
export type MarketplaceVisibilityProfile = z.infer<typeof MarketplaceVisibilityProfileSchema>;
export type MarketplaceVisibilityContext = z.infer<typeof MarketplaceVisibilityContextSchema>;

export function parseMarketplaceVisibilityEvidence(value: unknown): MarketplaceVisibilityEvidence {
  return MarketplaceVisibilityEvidenceSchema.parse(value);
}
