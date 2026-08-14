import { z } from 'zod';
import { TestPlanOutputSchema } from './modules.js';

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
