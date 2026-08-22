import { z } from 'zod';

const SENSITIVE_KEY_PATTERN = /token|secret|authorization|email|shop|domain|customer|catalog|product|payload|response/i;

export const MetricSourceSchema = z.enum(['posthog', 'fly_metrics', 'shopify_partner']);
export const SnapshotStatusSchema = z.enum(['complete', 'partial', 'unavailable', 'failed']);
export const OperationalNoteSchema = z.enum([
  'authentication',
  'rate_limit',
  'transport',
  'schema',
  'unknown',
  'no_metrics',
  'manual_import',
  'backfill',
]);

export const UtcDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isUtcCalendarDate, 'Expected a valid UTC calendar date');

export const CollectionWindowSchema = z
  .object({
    date: UtcDateSchema,
    startInclusive: z.string().datetime(),
    endExclusive: z.string().datetime(),
  })
  .strict();

const DailyMetricSnapshotDataSchema = z
  .object({
    source: MetricSourceSchema,
    date: UtcDateSchema,
    collectedAt: z.string().datetime(),
    status: SnapshotStatusSchema,
    metrics: z.record(z.string().min(1).max(100), z.number().finite().nonnegative()),
    notes: z.array(OperationalNoteSchema).max(12),
  })
  .strict();

export const DailyMetricSnapshotSchema = z
  .unknown()
  .superRefine((value, context) => {
    for (const key of sensitiveKeys(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Sensitive key is not allowed in a metric snapshot: ${key}`,
      });
    }
  })
  .pipe(DailyMetricSnapshotDataSchema);

export type MetricSource = z.infer<typeof MetricSourceSchema>;
export type SnapshotStatus = z.infer<typeof SnapshotStatusSchema>;
export type CollectionWindow = z.infer<typeof CollectionWindowSchema>;
export type DailyMetricSnapshot = z.infer<typeof DailyMetricSnapshotSchema>;

export function createCompletedUtcWindow(date: string): CollectionWindow {
  const validDate = UtcDateSchema.parse(date);
  if (!isCompletedUtcDate(validDate)) {
    throw new RangeError(`Metric window date must be before today in UTC: ${validDate}`);
  }
  const start = new Date(`${validDate}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return {
    date: validDate,
    startInclusive: start.toISOString(),
    endExclusive: end.toISOString(),
  };
}

export function isCompletedUtcDate(date: string, now: Date = new Date()): boolean {
  const validDate = UtcDateSchema.safeParse(date);
  return validDate.success && validDate.data < now.toISOString().slice(0, 10);
}

function isUtcCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function sensitiveKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(sensitiveKeys);
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(SENSITIVE_KEY_PATTERN.test(key) ? [key] : []),
    ...sensitiveKeys(child),
  ]);
}
