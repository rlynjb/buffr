import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { NormalizedListingEvidenceSchema } from './evidence.js';
import { MerchGridWorkflowEvidenceSchema } from './merchgrid-workflow.js';
import {
  ExperimentApplicationSchema,
  MarketplaceProductIdentitySchema,
  MarketplaceVisibilityEvidenceSchema,
  PriorLearningContextSchema,
} from './marketplace-visibility.js';
import {
  ContextOutputSchema,
  DiagnosisOutputSchema,
  EvaluationOutputSchema,
  HypothesisOutputSchema,
  MetricsOutputSchema,
  ResearchOutputSchema,
  TestPlanOutputSchema,
} from './modules.js';

/**
 * Durable work-engine run state.
 *
 * This is the product-level execution record written to run.json. It captures
 * workflow status, evidence, module outputs, approval state, and chronological
 * events so a run can be inspected or resumed without replaying raw sources.
 */
export const WorkflowStageSchema = z.enum([
  'm1_context',
  'm2_metrics_initial',
  'm3_research',
  'm4_diagnosis',
  'm5_hypothesis',
  'm6_test_plan',
  'approval_wait',
  'experiment_wait',
  'm2_metrics_results',
  'm7_learning',
  'cycle_complete',
]);

export const WorkflowStatusSchema = z.enum([
  'analyzing',
  'researching',
  'waiting_for_data',
  'awaiting_approval',
  'ready_for_experiment',
  'experiment_running',
  'ready_for_evaluation',
  'cycle_complete',
  'stopped',
]);

export const WorkflowKindSchema = z.enum([
  'etsy_listing',
  'merchgrid_daily',
  'merchgrid_weekly',
  'marketplace_visibility_review',
]);

const EtsyWorkflowEvidenceSchema = z.object({
  product: z.literal('etsy'),
  evidence: NormalizedListingEvidenceSchema,
}).strict();

export const WorkflowEvidenceSchema = z.union([
  EtsyWorkflowEvidenceSchema,
  MerchGridWorkflowEvidenceSchema,
  MarketplaceVisibilityEvidenceSchema,
]);

export const WorkflowApprovalSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('approved'), decidedAt: z.string().datetime() }).strict(),
  z.object({ status: z.literal('rejected'), decidedAt: z.string().datetime(), reason: z.string().min(1).max(500) }).strict(),
]);

export const WorkflowEventSchema = z
  .object({
    eventId: z.string().min(1),
    runId: z.string().min(1),
    type: z.string().min(1),
    stage: WorkflowStageSchema.optional(),
    message: z.string().min(1),
    createdAt: z.string().datetime(),
    data: z.record(z.unknown()).default({}),
  })
  .strict();

export const WorkflowRunStateSchema = z
  .object({
    runId: z.string().min(1),
    subjectRef: z.string().min(1).optional(),
    marketplaceIdentity: MarketplaceProductIdentitySchema.optional(),
    experimentApplication: ExperimentApplicationSchema.optional(),
    previousRunRef: z.string().min(1).optional(),
    priorLearning: PriorLearningContextSchema.optional(),
    workflowKind: WorkflowKindSchema.default('etsy_listing'),
    listingId: z.string().min(1).optional(),
    status: WorkflowStatusSchema,
    stage: WorkflowStageSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    evidenceRefs: z.array(z.string()),
    evidenceSnapshots: z
      .object({
        initial: WorkflowEvidenceSchema.optional(),
        result: WorkflowEvidenceSchema.optional(),
      })
      .strict()
      .optional(),
    approval: WorkflowApprovalSchema.optional(),
    moduleOutputs: z
      .object({
        m1: ContextOutputSchema.optional(),
        m2Initial: MetricsOutputSchema.optional(),
        m3: z.array(ResearchOutputSchema).default([]),
        m4: DiagnosisOutputSchema.optional(),
        m5: HypothesisOutputSchema.optional(),
        m6: TestPlanOutputSchema.optional(),
        m2Results: MetricsOutputSchema.optional(),
        m7: EvaluationOutputSchema.optional(),
      })
      .strict(),
    events: z.array(WorkflowEventSchema),
  })
  .strict();

export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
export type WorkflowKind = z.infer<typeof WorkflowKindSchema>;
export type WorkflowEvidence = z.infer<typeof WorkflowEvidenceSchema>;
export type WorkflowApproval = z.infer<typeof WorkflowApprovalSchema>;
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
export type WorkflowRunStateInput = z.input<typeof WorkflowRunStateSchema>;
export type WorkflowRunState = z.infer<typeof WorkflowRunStateSchema>;

export function parseWithSchema<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
  label: string,
): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', `${label} failed validation`, { cause: result.error });
  }
  return result.data;
}
