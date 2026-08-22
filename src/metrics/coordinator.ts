import {
  DailyMetricSnapshotSchema,
  type CollectionWindow,
  type DailyMetricSnapshot,
  type MetricSource,
} from '../contracts/metrics.js';
import {
  createMetricSourceFailureSnapshot,
  type MetricSourceAdapter,
} from '../connectors/merchgrid/source.js';
import type { MetricSnapshotRepository } from '../storage/metric-snapshots.js';
import { createWorkflowEvent, type TraceSink } from '../tracing/events.js';

const SOURCE_ORDER: readonly MetricSource[] = ['posthog', 'fly_metrics', 'shopify_partner'];

export type CollectSourcePackInput = {
  adapters: readonly MetricSourceAdapter[];
  repository: MetricSnapshotRepository;
  window: CollectionWindow;
  sourceTimeoutMs?: number;
  runId?: string;
  emit?: TraceSink['emit'];
  now?: () => Date;
  backfill?: boolean;
};

/** Collects each configured source in a fixed order, persisting its bounded result before continuing. */
export async function collectSourcePack(input: CollectSourcePackInput): Promise<DailyMetricSnapshot[]> {
  const adapters = [...input.adapters].sort((left, right) => sourceIndex(left.source) - sourceIndex(right.source));
  const snapshots: DailyMetricSnapshot[] = [];

  for (const adapter of adapters) {
    await emitSourceEvent(input, adapter.source, 'started');
    const snapshot = await collectOne(adapter, input.window, input.sourceTimeoutMs ?? 30_000, input.backfill ?? false);
    await input.repository.save(snapshot);
    snapshots.push(snapshot);
    await emitSourceEvent(input, adapter.source, resultEvent(snapshot), snapshot.status);
  }

  return snapshots;
}

async function collectOne(
  adapter: MetricSourceAdapter,
  window: CollectionWindow,
  timeoutMs: number,
  backfill: boolean,
): Promise<DailyMetricSnapshot> {
  try {
    const collected = await withinDeadline(adapter.collect(window), timeoutMs);
    const parsed = DailyMetricSnapshotSchema.safeParse(collected);
    if (!parsed.success) {
      throw { malformed: true };
    }
    const snapshot = parsed.data;
    if (snapshot.source !== adapter.source || snapshot.date !== window.date) {
      throw { malformed: true };
    }
    return markBackfill(snapshot, backfill);
  } catch (failure) {
    return markBackfill(createMetricSourceFailureSnapshot({ source: adapter.source, window, failure }), backfill);
  }
}

function markBackfill(snapshot: DailyMetricSnapshot, backfill: boolean): DailyMetricSnapshot {
  if (!backfill || snapshot.notes.includes('backfill')) {
    return snapshot;
  }
  return DailyMetricSnapshotSchema.parse({ ...snapshot, notes: [...snapshot.notes, 'backfill'] });
}

async function withinDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('Source timeout must be a finite nonnegative duration');
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Metric source collection timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

type SourceEventResult = 'completed' | 'partial' | 'failed';

function resultEvent(snapshot: DailyMetricSnapshot): SourceEventResult {
  if (snapshot.status === 'complete') {
    return 'completed';
  }
  if (snapshot.status === 'failed') {
    return 'failed';
  }
  return 'partial';
}

async function emitSourceEvent(
  input: CollectSourcePackInput,
  source: MetricSource,
  event: 'started' | SourceEventResult,
  status?: DailyMetricSnapshot['status'],
): Promise<void> {
  if (!input.emit) {
    return;
  }
  await input.emit(
    createWorkflowEvent({
      runId: input.runId ?? `merchgrid-source-pack:${input.window.date}`,
      type: `merchgrid.source.${event}`,
      message: `MerchGrid metric source ${event}`,
      data: {
        source,
        date: input.window.date,
        ...(status ? { status } : {}),
      },
      now: input.now,
    }),
  );
}

function sourceIndex(source: MetricSource): number {
  return SOURCE_ORDER.indexOf(source);
}
