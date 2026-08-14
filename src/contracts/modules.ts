import { z } from 'zod';
import { IsoDateSchema } from './evidence.js';

export const ModuleIdSchema = z.enum(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
export const RequesterModuleIdSchema = z.enum(['m1', 'm2', 'm4', 'm5', 'm6', 'm7']);
export const ConfidenceSchema = z.enum(['low', 'moderate', 'high']);
export const ResearchToolNameSchema = z.enum([
  'etsy_listing_details',
  'etsy_transactions',
  'normalized_evidence',
  'hosted_web_search',
]);

export const CitationSchema = z
  .object({
    source: z.enum(['etsy', 'web', 'user', 'derived']),
    title: z.string().min(1),
    url: z.string().url().optional(),
    excerpt: z.string().min(1),
    fetchedAt: IsoDateSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source === 'web' && !value.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'web citations require url',
      });
    }
  });

export const ResearchOutputSchema = z
  .object({
    status: z.enum(['resolved', 'partly_resolved', 'unresolved']),
    next_action: z.enum(['continue', 'stop']),
    requester: RequesterModuleIdSchema,
    question: z.string().min(1),
    evidence: z.array(CitationSchema),
    confidence: ConfidenceSchema,
    limitations: z.array(z.string()),
    requestedLookup: z
      .object({
        tool: ResearchToolNameSchema,
        reason: z.string().min(1),
        input: z.record(z.unknown()).default({}),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.next_action === 'continue' && !value.requestedLookup) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedLookup'],
        message: 'requestedLookup is required when next_action is continue',
      });
    }
  });

export const ContextOutputSchema = z
  .object({
    product: z.string().min(1),
    likelyCustomer: z.string().optional(),
    positioning: z.string().optional(),
    availableEvidence: z.array(z.string()),
    missingInformation: z.array(z.string()),
    notes: z.array(z.string()),
  })
  .strict();

export const MetricValueSchema = z
  .object({
    name: z.string().min(1),
    current: z.number().nullable(),
    baseline: z.number().nullable(),
    absoluteChange: z.number().nullable(),
    percentageChange: z.number().nullable(),
    qualification: z.enum(['improved', 'declined', 'stable', 'inconclusive', 'not_available']),
    confidence: ConfidenceSchema,
  })
  .strict();

export const MetricsOutputSchema = z
  .object({
    phase: z.enum(['initial', 'post_experiment']),
    metrics: z.array(MetricValueSchema),
    comparisonQuality: z.enum(['valid', 'limited', 'invalid', 'missing']),
    unresolvedQualificationNeeds: z.array(z.string()),
    researchNeed: z.string().optional(),
  })
  .strict();

export const DiagnosisOutputSchema = z
  .object({
    performancePath: z.enum([
      'discovery',
      'click_through',
      'interest',
      'conversion',
      'profitability',
      'insufficient_data',
    ]),
    primaryBottleneck: z.string(),
    competingExplanation: z.string().optional(),
    confidence: ConfidenceSchema,
    decision: z.enum(['proceed_to_hypothesis', 'research_domain_knowledge', 'collect_more_data']),
    researchQuestion: z.string().optional(),
    notes: z.array(z.string()),
  })
  .strict();

export const HypothesisOutputSchema = z
  .object({
    hypothesis: z.string().min(1),
    primaryVariable: z.string().min(1),
    recommendedRevision: z.string().min(1),
    keepConstant: z.array(z.string()),
    expectedSignal: z.string().min(1),
    researchNeed: z.string().optional(),
    notes: z.array(z.string()),
  })
  .strict();

export const TestPlanOutputSchema = z
  .object({
    primaryMetric: z.string().min(1),
    secondaryMetrics: z.array(z.string()),
    baselineValue: z.number(),
    baselinePeriod: z.string().min(1),
    qualificationRequirements: z.array(z.string()),
    expectedSupportingSignal: z.string().min(1),
    expectedWeakeningSignal: z.string().min(1),
    inconclusiveCondition: z.string().min(1),
    contextToMonitor: z.array(z.string()),
    unresolvedMeasurementRules: z.array(z.string()),
    researchNeed: z.string().optional(),
  })
  .strict();

export const EvaluationOutputSchema = z
  .object({
    outcome: z.enum(['win', 'loss', 'inconclusive']),
    hypothesisEvaluation: z.enum(['supported', 'partly_supported', 'not_supported', 'inconclusive']),
    evidence: z.array(z.string()),
    contextualFactors: z.array(z.string()),
    learning: z.string().min(1),
    confidence: ConfidenceSchema,
    knowledgeSource: z.enum(['product_data', 'experiment', 'external_research', 'combination']),
    nextAction: z.enum(['keep', 'revert', 'iterate', 'new_test', 'research', 'wait']),
    researchQuestion: z.string().optional(),
    nextActionRationale: z.string().min(1),
  })
  .strict();

export type ModuleId = z.infer<typeof ModuleIdSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type ResearchToolName = z.infer<typeof ResearchToolNameSchema>;
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;
export type ContextOutput = z.infer<typeof ContextOutputSchema>;
export type MetricsOutput = z.infer<typeof MetricsOutputSchema>;
export type DiagnosisOutput = z.infer<typeof DiagnosisOutputSchema>;
export type HypothesisOutput = z.infer<typeof HypothesisOutputSchema>;
export type TestPlanOutput = z.infer<typeof TestPlanOutputSchema>;
export type EvaluationOutput = z.infer<typeof EvaluationOutputSchema>;
