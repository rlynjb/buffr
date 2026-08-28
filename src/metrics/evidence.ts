import { z } from 'zod';
import {
  MetricSourceSchema,
  OperationalNoteSchema,
  SnapshotStatusSchema,
  UtcDateSchema,
} from '../contracts/metrics.js';
import type { DailyHealthSummary, WeeklyBusinessReview } from './summaries.js';

/**
 * Summary-to-workflow evidence projection.
 *
 * The metrics layer can compute many implementation details, but the work
 * engine receives only this deterministic evidence view: source status,
 * freshness, aggregate values, and limitations.
 */
export const SourceStatusSchema = z.union([SnapshotStatusSchema, z.literal('missing')]);
export const SourceStatusesSchema = z.object({
  posthog: SourceStatusSchema,
  fly_metrics: SourceStatusSchema,
  shopify_partner: SourceStatusSchema,
}).strict();
export const SourceFreshnessItemSchema = z.object({
  date: UtcDateSchema,
  collectedAt: z.string().datetime(),
  status: SnapshotStatusSchema,
  notes: z.array(OperationalNoteSchema).max(12),
}).strict();
export const DailySourceFreshnessSchema = z.object({
  posthog: SourceFreshnessItemSchema.optional(),
  fly_metrics: SourceFreshnessItemSchema.optional(),
  shopify_partner: SourceFreshnessItemSchema.optional(),
}).strict();
export const WeeklySourceFreshnessSchema = z.object({
  posthog: z.array(SourceFreshnessItemSchema).max(7).optional(),
  fly_metrics: z.array(SourceFreshnessItemSchema).max(7).optional(),
  shopify_partner: z.array(SourceFreshnessItemSchema).max(7).optional(),
}).strict();
const MetricValueSchema = z.number().finite().nonnegative();
const PosthogMetricsSchema = z.object({
  app_opened_count: MetricValueSchema.optional(),
  scan_started_count: MetricValueSchema.optional(),
  scan_completed_count: MetricValueSchema.optional(),
  scan_failed_count: MetricValueSchema.optional(),
  scan_completion_rate: MetricValueSchema.optional(),
}).strict();
const FlyMetricsSchema = z.object({
  request_count: MetricValueSchema.optional(),
  error_response_count: MetricValueSchema.optional(),
  error_rate: MetricValueSchema.optional(),
}).strict();
const ShopifyPartnerMetricsSchema = z.object({
  active_merchants: MetricValueSchema.optional(),
  installs: MetricValueSchema.optional(),
  uninstalls: MetricValueSchema.optional(),
  earnings_amount: MetricValueSchema.optional(),
}).strict();
export const SourceMetricValuesSchema = z.object({
  posthog: PosthogMetricsSchema.optional(),
  fly_metrics: FlyMetricsSchema.optional(),
  shopify_partner: ShopifyPartnerMetricsSchema.optional(),
}).strict();
export const SourceCoverageSchema = z.object({
  posthog: z.record(SourceStatusSchema, z.number().int().nonnegative()),
  fly_metrics: z.record(SourceStatusSchema, z.number().int().nonnegative()),
  shopify_partner: z.record(SourceStatusSchema, z.number().int().nonnegative()),
}).strict();
export const DateRangeSchema = z.object({ startDate: UtcDateSchema, endDate: UtcDateSchema }).strict();

export const DailyMerchGridReviewEvidenceSchema = z.object({
  period: z.object({ kind: z.literal('daily'), date: UtcDateSchema }).strict(),
  sourceCoverage: SourceStatusesSchema,
  sourceFreshness: DailySourceFreshnessSchema,
  aggregateMetrics: SourceMetricValuesSchema,
  limitations: z.array(z.string().min(1).max(200)),
}).strict();

export const WeeklyMerchGridReviewEvidenceSchema = z.object({
  period: z.object({
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
  limitations: z.array(z.string().min(1).max(200)),
}).strict();

export const MerchGridReviewEvidenceSchema = z.union([
  DailyMerchGridReviewEvidenceSchema,
  WeeklyMerchGridReviewEvidenceSchema,
]);

export type MerchGridReviewEvidence = z.infer<typeof MerchGridReviewEvidenceSchema>;

/** Projects a deterministic summary into the only fields a workflow may consume. */
export function toMerchGridReviewEvidence(
  summary: DailyHealthSummary | WeeklyBusinessReview,
): MerchGridReviewEvidence {
  if ('date' in summary) {
    return MerchGridReviewEvidenceSchema.parse({
      period: { kind: 'daily', date: summary.date },
      sourceCoverage: summary.sourceStatuses,
      sourceFreshness: summary.sourceFreshness,
      aggregateMetrics: summary.aggregateMetrics,
      limitations: summary.limitations,
    });
  }

  return MerchGridReviewEvidenceSchema.parse({
    period: { kind: 'weekly', previous: summary.period.previous, current: summary.period.current },
    sourceCoverage: summary.sourceCoverage,
    sourceFreshness: summary.sourceFreshness,
    aggregateMetrics: summary.aggregateMetrics,
    limitations: summary.limitations,
  });
}
