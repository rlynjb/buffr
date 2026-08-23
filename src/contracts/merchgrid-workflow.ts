import { z } from 'zod';
import {
  DailySourceFreshnessSchema,
  DateRangeSchema,
  MerchGridReviewEvidenceSchema,
  SourceCoverageSchema,
  SourceMetricValuesSchema,
  SourceStatusesSchema,
  WeeklySourceFreshnessSchema,
} from '../metrics/evidence.js';

const LocalArtifactReferenceSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('://'), 'Artifact reference must be a local path');

const BaseWorkflowEvidenceSchema = z.object({
  product: z.literal('merchgrid'),
  artifactRef: LocalArtifactReferenceSchema,
  limitations: z.array(z.string().min(1).max(200)),
});

export const MerchGridWorkflowEvidenceSchema = z.discriminatedUnion('kind', [
  BaseWorkflowEvidenceSchema.extend({
    kind: z.literal('daily_health'),
    observedPeriod: z.object({ kind: z.literal('daily'), date: z.string() }).strict(),
    sourceCoverage: SourceStatusesSchema,
    sourceFreshness: DailySourceFreshnessSchema,
    aggregateMetrics: SourceMetricValuesSchema,
  }).strict(),
  BaseWorkflowEvidenceSchema.extend({
    kind: z.literal('weekly_review'),
    observedPeriod: z.object({
      kind: z.literal('weekly'),
      previous: DateRangeSchema,
      current: DateRangeSchema,
    }).strict(),
    sourceCoverage: z.object({ previous: SourceCoverageSchema, current: SourceCoverageSchema }).strict(),
    sourceFreshness: z.object({ previous: WeeklySourceFreshnessSchema, current: WeeklySourceFreshnessSchema }).strict(),
    aggregateMetrics: z.object({
      previous: SourceMetricValuesSchema,
      current: SourceMetricValuesSchema,
      change: SourceMetricValuesSchema,
    }).strict(),
  }).strict(),
]);

export type MerchGridWorkflowEvidence = z.infer<typeof MerchGridWorkflowEvidenceSchema>;

export function parseMerchGridWorkflowEvidence(
  value: unknown,
  artifactRef: string,
): MerchGridWorkflowEvidence {
  const artifact = MerchGridReviewEvidenceSchema.parse(value);
  return MerchGridWorkflowEvidenceSchema.parse({
    product: 'merchgrid',
    kind: artifact.period.kind === 'daily' ? 'daily_health' : 'weekly_review',
    artifactRef,
    observedPeriod: artifact.period,
    sourceCoverage: artifact.sourceCoverage,
    sourceFreshness: artifact.sourceFreshness,
    aggregateMetrics: artifact.aggregateMetrics,
    limitations: artifact.limitations,
  });
}
