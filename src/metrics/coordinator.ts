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

const SOURCE_ORDER: readonly MetricSource[] = ['posthog', 'fly_metrics', 'shopify_partner'];

export type CollectSourcePackInput = {
  adapters: readonly MetricSourceAdapter[];
  repository: MetricSnapshotRepository;
  window: CollectionWindow;
};

/** Collects each configured source in a fixed order, persisting its bounded result before continuing. */
export async function collectSourcePack(input: CollectSourcePackInput): Promise<DailyMetricSnapshot[]> {
  const adapters = [...input.adapters].sort((left, right) => sourceIndex(left.source) - sourceIndex(right.source));
  const snapshots: DailyMetricSnapshot[] = [];

  for (const adapter of adapters) {
    const snapshot = await collectOne(adapter, input.window);
    await input.repository.save(snapshot);
    snapshots.push(snapshot);
  }

  return snapshots;
}

async function collectOne(adapter: MetricSourceAdapter, window: CollectionWindow): Promise<DailyMetricSnapshot> {
  try {
    const snapshot = DailyMetricSnapshotSchema.parse(await adapter.collect(window));
    if (snapshot.source !== adapter.source || snapshot.date !== window.date) {
      throw { malformed: true };
    }
    return snapshot;
  } catch (failure) {
    return createMetricSourceFailureSnapshot({ source: adapter.source, window, failure });
  }
}

function sourceIndex(source: MetricSource): number {
  return SOURCE_ORDER.indexOf(source);
}
