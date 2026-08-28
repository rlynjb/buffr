import { z } from 'zod';
import { TestPlanOutputSchema } from './modules.js';

/**
 * Human-gated recommendation output.
 *
 * This is the concrete experiment Buffr believes is ready for a person to
 * review, approve, run, or cancel. It is intentionally smaller than run.json:
 * run.json records the whole workflow; this records the proposed test.
 */
export const ExperimentPlanSchema = z
  .object({
    experimentId: z.string().min(1),
    listingId: z.string().min(1),
    hypothesis: z.string().min(1),
    revision: z.string().min(1),
    testPlan: TestPlanOutputSchema,
    status: z.enum(['ready', 'running', 'completed', 'cancelled']),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

export type ExperimentPlan = z.infer<typeof ExperimentPlanSchema>;
