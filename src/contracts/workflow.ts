import { z } from 'zod';
import { AppError } from '../core/errors.js';
import {
  ContextOutputSchema,
  DiagnosisOutputSchema,
  EvaluationOutputSchema,
  HypothesisOutputSchema,
  MetricsOutputSchema,
  ResearchOutputSchema,
  TestPlanOutputSchema,
} from './modules.js';

export const WorkflowStageSchema = z.enum([
  'm1_context',
  'm2_metrics_initial',
  'm3_research',
  'm4_diagnosis',
  'm5_hypothesis',
  'm6_test_plan',
  'experiment_wait',
  'm2_metrics_results',
  'm7_learning',
  'cycle_complete',
]);

export const WorkflowStatusSchema = z.enum([
  'analyzing',
  'researching',
  'waiting_for_data',
  'ready_for_experiment',
  'experiment_running',
  'ready_for_evaluation',
  'cycle_complete',
  'stopped',
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
    listingId: z.string().min(1),
    status: WorkflowStatusSchema,
    stage: WorkflowStageSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    evidenceRefs: z.array(z.string()),
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
