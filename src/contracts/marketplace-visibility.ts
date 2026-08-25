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

const PublicMarketplaceUrlSchema = z.string()
  .url()
  .startsWith('https://')
  .refine((value) => !value.includes('partners.shopify.com'), 'must not reference private Partner Dashboard pages')
  .refine((value) => !value.includes('admin.shopify.com'), 'must not reference private admin pages')
  .refine((value) => !UncuratedDataPattern.test(value), 'must not include private or source data markers');

export const MarketplaceVisibilityProfileSchema = z.enum([
  'merchgrid_shopify_app_store',
  'etsy_listing',
]);

export const MarketplaceListingCaptureModeSchema = z.enum([
  'manual_visual_review',
  'browser_assisted_public_page',
]);

export const MarketplaceVisibilityProductTypeSchema = z.enum([
  'shopify_app',
  'digital_product',
  'physical_product',
  'service',
]);

export const MarketplaceVisibilityContextSchema = z.object({
  marketplace: z.enum(['shopify_app_store', 'etsy', 'meta_marketplace']),
  productName: safeMarketplaceText(120),
  productType: MarketplaceVisibilityProductTypeSchema,
  targetCustomer: safeMarketplaceText(300),
  customerProblem: safeMarketplaceText(500),
  currentPromise: safeMarketplaceText(300),
  currentSurfaceSummary: safeMarketplaceText(1_000),
  primaryDiscoverySurface: safeMarketplaceText(300),
  primaryActionWanted: safeMarketplaceText(300),
  constraints: z.array(safeMarketplaceText(300)).max(12),
  availableAssets: z.array(safeMarketplaceText(300)).max(12),
  ownerGoal: safeMarketplaceText(300),
}).strict();

export const ExploratoryVisibilityReviewModeSchema = z.object({
  mode: z.literal('exploratory_visibility_test'),
  evidenceLevel: z.literal('sparse'),
  confidenceBoundary: z.literal('low'),
  reason: z.literal('metrics_sparse_context_sufficient'),
}).strict();

export const VisibilityReviewModeSchema = z.discriminatedUnion('mode', [
  ExploratoryVisibilityReviewModeSchema,
  z.object({
    mode: z.literal('missing_context'),
    missingFields: z.array(z.string().min(1)).min(1),
    reason: z.literal('context_required_before_exploratory_test'),
  }).strict(),
]);

const ListingPublicSurfaceSchema = z.object({
  title: safeMarketplaceText(160).optional(),
  subtitle: safeMarketplaceText(240).optional(),
  headline: safeMarketplaceText(300).optional(),
  shortDescription: safeMarketplaceText(500).optional(),
  category: safeMarketplaceText(120).optional(),
  pricingLabel: safeMarketplaceText(80).optional(),
  ratingSummary: safeMarketplaceText(120).optional(),
  reviewCount: z.number().int().min(0).max(1_000_000).optional(),
  launchDate: safeMarketplaceText(80).optional(),
}).strict();

const ListingGallerySchema = z.object({
  imageCount: z.number().int().min(0).max(50),
  observedImageLabels: z.array(safeMarketplaceText(120)).max(20),
  visualNotes: z.array(safeMarketplaceText(500)).max(20),
}).strict();

const ListingTrustSignalsSchema = z.object({
  positive: z.array(safeMarketplaceText(200)).max(20),
  friction: z.array(safeMarketplaceText(200)).max(20),
}).strict();

const ListingCopyNotesSchema = z.object({
  clearClaims: z.array(safeMarketplaceText(240)).max(20),
  unclearClaims: z.array(safeMarketplaceText(240)).max(20),
  missingContext: z.array(safeMarketplaceText(240)).max(20),
}).strict();

const ListingVisibilityRubricNotesSchema = z.object({
  promiseClarity: safeMarketplaceText(500),
  audienceSpecificity: safeMarketplaceText(500),
  problemActionFit: safeMarketplaceText(500),
  discoveryFit: safeMarketplaceText(500),
  trustAndRiskReduction: safeMarketplaceText(500),
  assetClarity: safeMarketplaceText(500),
}).strict();

export const MarketplaceListingContextSchema = z.object({
  marketplace: z.enum(['shopify_app_store', 'etsy', 'meta_marketplace']),
  profile: MarketplaceVisibilityProfileSchema,
  productName: safeMarketplaceText(120),
  sourceUrl: PublicMarketplaceUrlSchema,
  capturedAt: z.string().datetime({ offset: true }),
  captureMode: MarketplaceListingCaptureModeSchema,
  publicSurface: ListingPublicSurfaceSchema,
  gallery: ListingGallerySchema,
  trustSignals: ListingTrustSignalsSchema,
  copyNotes: ListingCopyNotesSchema,
  visibilityRubricNotes: ListingVisibilityRubricNotesSchema,
  limitations: z.array(safeMarketplaceText(300)).max(20),
}).strict().superRefine((value, ctx) => {
  if (value.profile === 'merchgrid_shopify_app_store' && value.marketplace !== 'shopify_app_store') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['marketplace'],
      message: 'marketplace must match profile',
    });
  }
  if (value.profile === 'etsy_listing' && value.marketplace !== 'etsy') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['marketplace'],
      message: 'marketplace must match profile',
    });
  }
});

export const MarketplaceVisibilityEvidenceSchema = z.object({
  product: z.literal('marketplace_visibility'),
  profile: MarketplaceVisibilityProfileSchema,
  subjectRef: MarketplaceVisibilitySubjectRefSchema,
  artifactRef: MarketplaceVisibilityArtifactRefSchema,
  evidenceLevel: z.literal('sparse'),
  recommendationType: z.literal('visibility_hypothesis'),
  reviewMode: ExploratoryVisibilityReviewModeSchema,
  marketplaceContext: MarketplaceVisibilityContextSchema,
  listingContext: MarketplaceListingContextSchema.optional(),
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
  if (value.listingContext && value.listingContext.profile !== value.profile) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['listingContext', 'profile'],
      message: 'listingContext profile must match evidence profile',
    });
  }
});

export type MarketplaceVisibilityEvidence = z.infer<typeof MarketplaceVisibilityEvidenceSchema>;
export type MarketplaceVisibilityProfile = z.infer<typeof MarketplaceVisibilityProfileSchema>;
export type MarketplaceVisibilityContext = z.infer<typeof MarketplaceVisibilityContextSchema>;
export type MarketplaceVisibilityProductType = z.infer<typeof MarketplaceVisibilityProductTypeSchema>;
export type MarketplaceListingContext = z.infer<typeof MarketplaceListingContextSchema>;
export type MarketplaceListingCaptureMode = z.infer<typeof MarketplaceListingCaptureModeSchema>;
export type ExploratoryVisibilityReviewMode = z.infer<typeof ExploratoryVisibilityReviewModeSchema>;
export type VisibilityReviewMode = z.infer<typeof VisibilityReviewModeSchema>;

export function parseMarketplaceVisibilityEvidence(value: unknown): MarketplaceVisibilityEvidence {
  return MarketplaceVisibilityEvidenceSchema.parse(value);
}
