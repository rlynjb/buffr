import {
  MarketplaceVisibilityEvidenceSchema,
  type MarketplaceVisibilityContext,
  type MarketplaceVisibilityEvidence,
  type MarketplaceVisibilityProfile,
} from '../contracts/marketplace-visibility.js';
import { UtcDateSchema } from '../contracts/metrics.js';
import type { WorkflowRunState } from '../contracts/workflow.js';
import { AppError } from '../core/errors.js';
import type { MerchGridReviewArtifactRepository } from '../jobs/merchgrid-source-pack.js';
import type { MerchGridReviewEvidence } from '../metrics/evidence.js';
import type { RunRepository } from '../storage/runs.js';

const PROHIBITED_CLAIMS = [
  'Do not claim sparse evidence proves a marketplace visibility bottleneck',
  'Do not claim a visibility change will increase installs',
  'Do not recommend automatic marketplace edits',
] as const;

export type MarketplaceVisibilityEngine = {
  startMarketplaceVisibility(input: {
    runId: string;
    subjectRef: string;
    initialEvidence: MarketplaceVisibilityEvidence;
  }): Promise<WorkflowRunState>;
  resumeWithExperimentResults(input: {
    runId: string;
    resultEvidence: MarketplaceVisibilityEvidence;
  }): Promise<WorkflowRunState>;
  waitForMoreData(input: { runId: string; reason: string }): Promise<WorkflowRunState>;
};

export type MarketplaceVisibilityService = {
  startVisibilityReview(input: {
    profile: MarketplaceVisibilityProfile;
    runId: string;
    date?: string;
    contextPath: string;
  }): Promise<WorkflowRunState>;
  supplyVisibilityResult(input: { profile: MarketplaceVisibilityProfile; runId: string; through?: string }): Promise<WorkflowRunState>;
};

/** Builds sparse, safe marketplace-visibility evidence without querying providers. */
export function createMarketplaceVisibilityService(deps: {
  engine: MarketplaceVisibilityEngine;
  merchgridArtifacts: MerchGridReviewArtifactRepository;
  runRepository: RunRepository;
  loadContext: (path: string) => Promise<MarketplaceVisibilityContext>;
}): MarketplaceVisibilityService {
  return {
    async startVisibilityReview(input) {
      const context = await deps.loadContext(input.contextPath);
      const evidence = input.profile === 'merchgrid_shopify_app_store'
        ? await buildMerchGridVisibilityEvidence({ input, context, artifacts: deps.merchgridArtifacts })
        : buildEtsyVisibilityEvidence({ input, context });

      return deps.engine.startMarketplaceVisibility({
        runId: input.runId,
        subjectRef: evidence.subjectRef,
        initialEvidence: evidence,
      });
    },

    async supplyVisibilityResult(input) {
      if (input.profile !== 'merchgrid_shopify_app_store') {
        throw new AppError('route_not_allowed', `Visibility result support for ${input.profile} is unavailable`);
      }
      const through = UtcDateSchema.parse(input.through);
      const state = await deps.runRepository.load(input.runId);
      const initial = requireInitialVisibilityEvidence(state, input.profile);
      const artifact = await deps.merchgridArtifacts.loadWeeklyReview(through);
      if (!artifact) {
        throw new AppError('storage_failed', `MerchGrid weekly review artifact not found: ${through}`);
      }
      assertValidMerchGridResultArtifact({ artifact, through, initialSubjectRef: initial.subjectRef });

      const measuredSignals = numericMarketplaceSignals(artifact);
      if (Object.keys(measuredSignals).length === 0) {
        return deps.engine.waitForMoreData({
          runId: input.runId,
          reason: 'visibility result evidence has no measured signals',
        });
      }

      const evidence = MarketplaceVisibilityEvidenceSchema.parse({
        product: 'marketplace_visibility',
        profile: 'merchgrid_shopify_app_store',
        subjectRef: initial.subjectRef,
        artifactRef: `.local/merchgrid-metrics/artifacts/weekly-reviews/${through}.json`,
        evidenceLevel: 'sparse',
        recommendationType: 'visibility_hypothesis',
        marketplaceContext: initial.marketplaceContext,
        measuredSignals,
        limitations: artifact.limitations,
        prohibitedClaims: initial.prohibitedClaims,
      });
      return deps.engine.resumeWithExperimentResults({ runId: input.runId, resultEvidence: evidence });
    },
  };
}

async function buildMerchGridVisibilityEvidence(input: {
  input: { date?: string; contextPath: string };
  context: MarketplaceVisibilityContext;
  artifacts: MerchGridReviewArtifactRepository;
}): Promise<MarketplaceVisibilityEvidence> {
  if (input.context.marketplace !== 'shopify_app_store') {
    throw new AppError('validation_failed', 'MerchGrid visibility profile requires Shopify App Store context');
  }
  const date = UtcDateSchema.parse(input.input.date);
  const artifact = await input.artifacts.loadDailyHealth(date);
  if (!artifact) {
    throw new AppError('storage_failed', `MerchGrid daily health artifact not found: ${date}`);
  }

  return MarketplaceVisibilityEvidenceSchema.parse({
    product: 'marketplace_visibility',
    profile: 'merchgrid_shopify_app_store',
    subjectRef: `merchgrid:visibility:${date}`,
    artifactRef: `.local/merchgrid-metrics/artifacts/daily-health/${date}.json`,
    evidenceLevel: 'sparse',
    recommendationType: 'visibility_hypothesis',
    marketplaceContext: input.context,
    measuredSignals: numericMarketplaceSignals(artifact),
    limitations: artifact.limitations,
    prohibitedClaims: PROHIBITED_CLAIMS,
  });
}

function buildEtsyVisibilityEvidence(input: {
  input: { runId: string; contextPath: string };
  context: MarketplaceVisibilityContext;
}): MarketplaceVisibilityEvidence {
  if (input.context.marketplace !== 'etsy') {
    throw new AppError('validation_failed', 'Etsy visibility profile requires Etsy context');
  }
  const listingRef = input.input.runId.replace(/^etsy-visibility-/u, '');

  return MarketplaceVisibilityEvidenceSchema.parse({
    product: 'marketplace_visibility',
    profile: 'etsy_listing',
    subjectRef: `etsy:visibility:${listingRef}`,
    artifactRef: input.input.contextPath,
    evidenceLevel: 'sparse',
    recommendationType: 'visibility_hypothesis',
    marketplaceContext: input.context,
    measuredSignals: {},
    limitations: ['etsy runtime profile is fixture-backed in this slice'],
    prohibitedClaims: PROHIBITED_CLAIMS,
  });
}

function numericMarketplaceSignals(artifact: MerchGridReviewEvidence): Record<string, number> {
  const metrics = 'current' in artifact.aggregateMetrics
    ? artifact.aggregateMetrics.current
    : artifact.aggregateMetrics;
  return Object.fromEntries(
    [metrics.posthog, metrics.fly_metrics]
      .flatMap((metrics) => Object.entries(metrics ?? {}))
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
  );
}

function requireInitialVisibilityEvidence(
  state: WorkflowRunState,
  profile: MarketplaceVisibilityProfile,
): MarketplaceVisibilityEvidence {
  const initial = state.evidenceSnapshots?.initial;
  if (!initial || initial.product !== 'marketplace_visibility' || initial.profile !== profile) {
    throw new AppError('validation_failed', 'Visibility result requires matching initial marketplace visibility evidence');
  }
  return initial;
}

function assertValidMerchGridResultArtifact(input: {
  artifact: MerchGridReviewEvidence;
  through: string;
  initialSubjectRef: string;
}): void {
  if (input.artifact.period.kind !== 'weekly') {
    throw new AppError('validation_failed', 'MerchGrid visibility result requires a weekly review artifact');
  }
  if (input.artifact.period.current.endDate !== input.through) {
    throw new AppError('validation_failed', 'MerchGrid weekly review artifact period does not match through date');
  }
  const initialDate = input.initialSubjectRef.slice('merchgrid:visibility:'.length);
  if (input.through <= initialDate) {
    throw new AppError('validation_failed', 'Visibility result through date must be later than the initial visibility date');
  }
}
