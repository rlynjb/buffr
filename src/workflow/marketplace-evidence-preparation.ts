import { join } from 'node:path';
import {
  MarketplaceProductIdentitySchema,
  type MarketplaceVisibilityEvidence,
  type MarketplaceVisibilityProfile,
} from '../contracts/marketplace-visibility.js';
import {
  UtcDateSchema,
  isCompletedUtcDate,
  type DailyMetricSnapshot,
  type MetricSource,
} from '../contracts/metrics.js';
import { AppError } from '../core/errors.js';
import {
  loadMarketplaceListingContext,
  loadMarketplaceVisibilityContext,
} from '../connectors/marketplace/local-context.js';
import {
  runDailyCollection,
  runWeeklyReview,
  type MerchGridReviewArtifactRepository,
  type MerchGridSourcePackDependencies,
} from '../jobs/merchgrid-source-pack.js';
import { toMerchGridReviewEvidence } from '../metrics/evidence.js';
import type { MetricSnapshotRepository } from '../storage/metric-snapshots.js';
import { marketplaceReviewOperationId } from '../storage/review-operations.js';
import { createWorkflowEvent, type TraceSink } from '../tracing/events.js';
import { buildRollingVisibilityEvidence } from './marketplace-visibility-profile.js';

const SOURCES: readonly MetricSource[] = ['posthog', 'fly_metrics', 'shopify_partner'];

export type MarketplaceReviewInput = {
  profile: MarketplaceVisibilityProfile;
  productRef: string;
  through: string;
  contextPath: string;
  listingContextPath?: string;
};

export type PreparedMarketplaceEvidence = {
  profile: MarketplaceVisibilityProfile;
  productRef: string;
  through: string;
  windowStart: string;
  windowEnd: string;
  weeklyArtifactRef: string;
  weeklyArtifactStatus: 'reused' | 'generated';
  missingSnapshotCount: number;
  collectedSnapshotCount: number;
  reusedSnapshotCount: number;
  evidence: MarketplaceVisibilityEvidence;
};

export type MarketplaceEvidencePreparationService = {
  prepare(input: MarketplaceReviewInput): Promise<PreparedMarketplaceEvidence>;
};

export type MarketplaceEvidencePreparationDependencies = {
  sourcePack: MerchGridSourcePackDependencies;
  repository: MetricSnapshotRepository;
  artifacts: MerchGridReviewArtifactRepository;
  artifactRootRef?: string;
  now?: () => Date;
  emit?: TraceSink['emit'];
};

export function createMarketplaceEvidencePreparationService(
  deps: MarketplaceEvidencePreparationDependencies,
): MarketplaceEvidencePreparationService {
  return {
    async prepare(input) {
      const now = deps.now ?? (() => new Date());
      const through = UtcDateSchema.parse(input.through);
      if (!isCompletedUtcDate(through, now())) {
        throw new RangeError(`Metric window date must be before today in UTC: ${through}`);
      }
      const identity = MarketplaceProductIdentitySchema.parse({
        profile: input.profile,
        productRef: input.productRef,
      });
      const operationId = marketplaceReviewOperationId({ ...identity, through });
      const emitForOperation: TraceSink['emit'] = async (event) => {
        await deps.emit?.({ ...event, runId: operationId });
      };
      const windowStart = utcDateDaysBefore(through, 13);
      const windowEnd = through;
      let latestMissingCount = 0;

      try {
        await emit(deps, operationId, 'marketplace_review.evidence_preparation.started', 'Marketplace review evidence preparation started', {
          ...identity,
          through,
          windowStart,
          windowEnd,
        });

        const before = await loadRequiredSnapshots(deps.repository, windowStart, windowEnd);
        let reusedSnapshotCount = 0;
        let collectedSnapshotCount = 0;

        for (const date of datesBetween(windowStart, windowEnd)) {
          const missingForDate = SOURCES.filter((source) => before.get(`${source}/${date}`)?.status !== 'complete');
          for (const source of SOURCES) {
            const snapshot = before.get(`${source}/${date}`);
            if (snapshot?.status === 'complete') {
              reusedSnapshotCount += 1;
              await emit(deps, operationId, 'marketplace_review.daily_snapshot.reused', 'Marketplace review daily snapshot reused', {
                source,
                date,
                status: 'complete',
              });
            } else {
              await emit(deps, operationId, 'marketplace_review.daily_snapshot.collection_required', 'Marketplace review daily snapshot collection required', {
                source,
                date,
                ...(snapshot ? { status: snapshot.status } : {}),
              });
            }
          }

          if (missingForDate.length === 0) continue;

          await runDailyCollection({
            date,
            dependencies: {
              ...deps.sourcePack,
              now,
              emit: emitForOperation,
            },
          });

          const afterDate = await loadDateSnapshots(deps.repository, date);
          const missingSnapshotCount = SOURCES.filter((source) => afterDate.get(source)?.status !== 'complete').length;
          const newlyComplete = missingForDate.filter((source) => afterDate.get(source)?.status === 'complete').length;
          collectedSnapshotCount += newlyComplete;
          await emit(deps, operationId, 'marketplace_review.daily_collection.completed', 'Marketplace review daily collection completed', {
            date,
            reusedSnapshotCount: SOURCES.length - missingForDate.length,
            collectedSnapshotCount: newlyComplete,
            missingSnapshotCount,
          });
        }

        const incomplete = await incompleteSnapshotRefs(deps.repository, windowStart, windowEnd);
        latestMissingCount = incomplete.length;
        if (incomplete.length > 0) {
          throw new AppError('storage_failed', `Missing weekly metric snapshots (${incomplete.length}): ${incomplete.join(', ')}`);
        }

        let artifact = await deps.artifacts.loadWeeklyReview(through);
        let weeklyArtifactStatus: PreparedMarketplaceEvidence['weeklyArtifactStatus'] = 'reused';
        const weeklyArtifactRef = merchGridWeeklyReviewArtifactRef(deps.artifactRootRef, through);
        if (artifact) {
          await emit(deps, operationId, 'marketplace_review.weekly_artifact.reused', 'Marketplace review weekly artifact reused', {
            through,
            artifactRef: weeklyArtifactRef,
            reused: true,
          });
        } else {
          const result = await runWeeklyReview({
            through,
            dependencies: {
              ...deps.sourcePack,
              now,
              emit: emitForOperation,
            },
          });
          artifact = toMerchGridReviewEvidence(result.review);
          weeklyArtifactStatus = 'generated';
          await emit(deps, operationId, 'marketplace_review.weekly_artifact.generated', 'Marketplace review weekly artifact generated', {
            through,
            artifactRef: weeklyArtifactRef,
            generated: true,
          });
        }

        const context = await loadMarketplaceVisibilityContext(input.contextPath);
        const listingContext = input.listingContextPath
          ? await loadMarketplaceListingContext(input.listingContextPath)
          : undefined;
        const evidence = buildRollingVisibilityEvidence({
          artifact,
          identity,
          through,
          context,
          listingContext,
          artifactRootRef: deps.artifactRootRef,
        });

        await emit(deps, operationId, 'marketplace_review.evidence_preparation.completed', 'Marketplace review evidence preparation completed', {
          ...identity,
          through,
          windowStart,
          windowEnd,
          artifactRef: weeklyArtifactRef,
          [weeklyArtifactStatus]: true,
        });

        return {
          ...identity,
          through,
          windowStart,
          windowEnd,
          weeklyArtifactRef,
          weeklyArtifactStatus,
          missingSnapshotCount: latestMissingCount,
          collectedSnapshotCount,
          reusedSnapshotCount,
          evidence,
        };
      } catch (error) {
        await emit(deps, operationId, 'marketplace_review.evidence_preparation.failed', 'Marketplace review evidence preparation failed', {
          ...identity,
          through,
          windowStart,
          windowEnd,
          missingSnapshotCount: latestMissingCount,
          failureCode: error instanceof AppError ? error.code : 'unexpected_error',
        });
        throw error;
      }
    },
  };
}

export function merchGridWeeklyReviewArtifactRef(rootRef: string | undefined, through: string): string {
  return join(rootRef ?? 'artifacts/merchgrid/metrics/artifacts', 'weekly-reviews', `${UtcDateSchema.parse(through)}.json`);
}

async function loadRequiredSnapshots(
  repository: MetricSnapshotRepository,
  windowStart: string,
  windowEnd: string,
): Promise<Map<string, DailyMetricSnapshot>> {
  const entries = await Promise.all(SOURCES.map(async (source) => {
    const snapshots = await repository.list(source, windowStart, windowEnd);
    return snapshots.map((snapshot) => [`${source}/${snapshot.date}`, snapshot] as const);
  }));
  return new Map(entries.flat());
}

async function loadDateSnapshots(
  repository: MetricSnapshotRepository,
  date: string,
): Promise<Map<MetricSource, DailyMetricSnapshot>> {
  const snapshots = await Promise.all(SOURCES.map(async (source) => repository.load(source, date)));
  return new Map(snapshots
    .filter((snapshot): snapshot is DailyMetricSnapshot => snapshot !== undefined)
    .map((snapshot) => [snapshot.source, snapshot]));
}

async function incompleteSnapshotRefs(
  repository: MetricSnapshotRepository,
  windowStart: string,
  windowEnd: string,
): Promise<string[]> {
  const snapshots = await loadRequiredSnapshots(repository, windowStart, windowEnd);
  return SOURCES.flatMap((source) => datesBetween(windowStart, windowEnd)
    .filter((date) => snapshots.get(`${source}/${date}`)?.status !== 'complete')
    .map((date) => `${source}/${date}`));
}

async function emit(
  deps: Pick<MarketplaceEvidencePreparationDependencies, 'emit' | 'now'>,
  runId: string,
  type: string,
  message: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!deps.emit) return;
  await deps.emit(createWorkflowEvent({
    runId,
    type,
    message,
    data,
    now: deps.now,
  }));
}

function datesBetween(start: string, end: string): string[] {
  const cursor = new Date(`${UtcDateSchema.parse(start)}T00:00:00.000Z`);
  const final = UtcDateSchema.parse(end);
  const dates: string[] = [];
  while (cursor.toISOString().slice(0, 10) <= final) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function utcDateDaysBefore(date: string, days: number): string {
  const result = new Date(`${UtcDateSchema.parse(date)}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() - days);
  return result.toISOString().slice(0, 10);
}
