import { join } from 'node:path';
import {
  MarketplaceVisibilityEvidenceSchema,
  type MarketplaceListingContext,
  type MarketplaceVisibilityContext,
  type MarketplaceVisibilityEvidence,
  type MarketplaceVisibilityProfile,
  type VisibilityReviewMode,
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
    listingContextPath?: string;
  }): Promise<WorkflowRunState>;
  supplyVisibilityResult(input: { profile: MarketplaceVisibilityProfile; runId: string; through?: string }): Promise<WorkflowRunState>;
};

/** Builds sparse, safe marketplace-visibility evidence without querying providers. */
export function createMarketplaceVisibilityService(deps: {
  engine: MarketplaceVisibilityEngine;
  merchgridArtifacts: MerchGridReviewArtifactRepository;
  merchgridArtifactRootRef?: string;
  runRepository: RunRepository;
  loadContext: (path: string) => Promise<MarketplaceVisibilityContext>;
  loadListingContext?: (path: string) => Promise<MarketplaceListingContext>;
}): MarketplaceVisibilityService {
  return {
    async startVisibilityReview(input) {
      const context = await deps.loadContext(input.contextPath);
      const listingContext = input.listingContextPath
        ? await requireListingContextLoader(deps.loadListingContext)(input.listingContextPath)
        : undefined;
      const evidence = input.profile === 'merchgrid_shopify_app_store'
        ? await buildMerchGridVisibilityEvidence({
            input,
            context,
            listingContext,
            artifacts: deps.merchgridArtifacts,
            artifactRootRef: deps.merchgridArtifactRootRef,
          })
        : buildEtsyVisibilityEvidence({ input, context, listingContext });

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
      assertValidMerchGridResultArtifact({
        artifact,
        through,
        initialSubjectRef: initial.subjectRef,
        approvalDate: state.approval?.status === 'approved' ? state.approval.decidedAt.slice(0, 10) : undefined,
      });

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
        artifactRef: merchgridArtifactRef(deps.merchgridArtifactRootRef, 'weekly-reviews', through),
        evidenceLevel: 'sparse',
        recommendationType: 'visibility_hypothesis',
        reviewMode: initial.reviewMode,
        marketplaceContext: initial.marketplaceContext,
        measuredSignals,
        limitations: curatedMerchGridLimitations(artifact.limitations),
        prohibitedClaims: initial.prohibitedClaims,
      });
      return deps.engine.resumeWithExperimentResults({ runId: input.runId, resultEvidence: evidence });
    },
  };
}

async function buildMerchGridVisibilityEvidence(input: {
  input: { date?: string; contextPath: string };
  context: MarketplaceVisibilityContext;
  listingContext?: MarketplaceListingContext;
  artifacts: MerchGridReviewArtifactRepository;
  artifactRootRef?: string;
}): Promise<MarketplaceVisibilityEvidence> {
  if (input.context.marketplace !== 'shopify_app_store') {
    throw new AppError('validation_failed', 'MerchGrid visibility profile requires Shopify App Store context');
  }
  const date = UtcDateSchema.parse(input.input.date);
  const artifact = await input.artifacts.loadDailyHealth(date);
  if (!artifact) {
    throw new AppError('storage_failed', `MerchGrid daily health artifact not found: ${date}`);
  }
  const measuredSignals = numericMarketplaceSignals(artifact);
  const reviewMode = selectMarketplaceVisibilityMode({
    context: input.context,
    measuredSignals,
    limitations: artifact.limitations,
  });
  assertExploratoryMode(reviewMode);

  return MarketplaceVisibilityEvidenceSchema.parse({
    product: 'marketplace_visibility',
    profile: 'merchgrid_shopify_app_store',
    subjectRef: `merchgrid:visibility:${date}`,
    artifactRef: merchgridArtifactRef(input.artifactRootRef, 'daily-health', date),
    evidenceLevel: 'sparse',
    recommendationType: 'visibility_hypothesis',
    reviewMode,
    marketplaceContext: input.context,
    listingContext: input.listingContext,
    measuredSignals,
    limitations: curatedMerchGridLimitations(artifact.limitations),
    prohibitedClaims: PROHIBITED_CLAIMS,
  });
}

function buildEtsyVisibilityEvidence(input: {
  input: { runId: string; contextPath: string };
  context: MarketplaceVisibilityContext;
  listingContext?: MarketplaceListingContext;
}): MarketplaceVisibilityEvidence {
  if (input.context.marketplace !== 'etsy') {
    throw new AppError('validation_failed', 'Etsy visibility profile requires Etsy context');
  }
  const listingRef = input.input.runId.replace(/^etsy-visibility-/u, '');
  const reviewMode = selectMarketplaceVisibilityMode({
    context: input.context,
    measuredSignals: {},
    limitations: ['etsy runtime profile is fixture-backed in this slice'],
  });
  assertExploratoryMode(reviewMode);

  return MarketplaceVisibilityEvidenceSchema.parse({
    product: 'marketplace_visibility',
    profile: 'etsy_listing',
    subjectRef: `etsy:visibility:${listingRef}`,
    artifactRef: input.input.contextPath,
    evidenceLevel: 'sparse',
    recommendationType: 'visibility_hypothesis',
    reviewMode,
    marketplaceContext: input.context,
    listingContext: input.listingContext,
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

export function selectMarketplaceVisibilityMode(input: {
  context: MarketplaceVisibilityContext;
  measuredSignals: Record<string, number>;
  limitations: readonly string[];
}): VisibilityReviewMode {
  const missingFields = [
    input.context.productName ? undefined : 'productName',
    input.context.productType ? undefined : 'productType',
    input.context.targetCustomer ? undefined : 'targetCustomer',
    input.context.customerProblem ? undefined : 'customerProblem',
    input.context.currentPromise ? undefined : 'currentPromise',
    input.context.currentSurfaceSummary ? undefined : 'currentSurfaceSummary',
    input.context.primaryDiscoverySurface ? undefined : 'primaryDiscoverySurface',
    input.context.primaryActionWanted ? undefined : 'primaryActionWanted',
    input.context.constraints.length > 0 ? undefined : 'constraints',
    input.context.ownerGoal ? undefined : 'ownerGoal',
  ].filter((field): field is string => Boolean(field));

  if (missingFields.length > 0) {
    return {
      mode: 'missing_context',
      missingFields,
      reason: 'context_required_before_exploratory_test',
    };
  }

  return {
    mode: 'exploratory_visibility_test',
    evidenceLevel: 'sparse',
    confidenceBoundary: 'low',
    reason: 'metrics_sparse_context_sufficient',
  };
}

function assertExploratoryMode(mode: VisibilityReviewMode): asserts mode is Extract<VisibilityReviewMode, { mode: 'exploratory_visibility_test' }> {
  if (mode.mode === 'missing_context') {
    throw new AppError('validation_failed', `visibility_context_missing:${mode.missingFields.join(',')}`);
  }
}

function requireListingContextLoader(
  loader: ((path: string) => Promise<MarketplaceListingContext>) | undefined,
): (path: string) => Promise<MarketplaceListingContext> {
  if (!loader) throw new AppError('configuration_failed', 'Marketplace listing context loader is unavailable');
  return loader;
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
  approvalDate?: string;
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
  const boundary = input.approvalDate && input.approvalDate > initialDate ? input.approvalDate : initialDate;
  if (input.artifact.period.current.startDate <= boundary) {
    throw new AppError('validation_failed', 'Visibility result current window must begin after the approval boundary');
  }
}

function merchgridArtifactRef(
  rootRef: string | undefined,
  collection: 'daily-health' | 'weekly-reviews',
  date: string,
): string {
  return join(rootRef ?? 'artifacts/merchgrid/metrics/artifacts', collection, `${date}.json`);
}

function curatedMerchGridLimitations(limitations: readonly string[]): string[] {
  return limitations.map((limitation) => {
    const token = /^(?:(previous|current):)?(posthog|fly_metrics|shopify_partner):(missing|partial|unavailable|failed)(?::([1-7]))?$/u.exec(limitation);
    if (!token) return limitation;

    const [, period, source, status, days] = token;
    const sourceLabel = source === 'posthog' ? 'PostHog' : source === 'fly_metrics' ? 'Fly' : 'Shopify Partner';
    const periodLabel = period === 'previous' ? 'Previous period ' : period === 'current' ? 'Current period ' : '';
    const coverageLabel = days ? ` for ${days} ${days === '1' ? 'day' : 'days'}` : '';
    return `${periodLabel}${sourceLabel} metrics ${status}${coverageLabel}`;
  });
}
