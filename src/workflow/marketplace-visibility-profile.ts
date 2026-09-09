import { join } from 'node:path';
import {
  MarketplaceVisibilityEvidenceSchema,
  MarketplaceProductIdentitySchema,
  PriorLearningContextSchema,
  type MarketplaceListingContext,
  type MarketplaceVisibilityContext,
  type MarketplaceVisibilityEvidence,
  type MarketplaceVisibilityProfile,
  type MarketplaceProductIdentity,
  type PriorLearningContext,
  type VisibilityReviewMode,
} from '../contracts/marketplace-visibility.js';
import { UtcDateSchema } from '../contracts/metrics.js';
import type { WorkflowRunState } from '../contracts/workflow.js';
import { AppError } from '../core/errors.js';
import type { MerchGridReviewArtifactRepository } from '../jobs/merchgrid-source-pack.js';
import { MerchGridReviewEvidenceSchema, type MerchGridReviewEvidence } from '../metrics/evidence.js';
import type { MarketplaceRunHistoryRepository, RunRepository } from '../storage/runs.js';

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
    marketplaceIdentity?: MarketplaceProductIdentity;
    previousRunRef?: string;
    priorLearning?: PriorLearningContext;
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
      if (input.profile === 'merchgrid_shopify_app_store') {
        const through = UtcDateSchema.parse(input.date);
        const artifact = await deps.merchgridArtifacts.loadWeeklyReview(through);
        if (!artifact) {
          throw new AppError('storage_failed', `MerchGrid weekly review artifact not found: ${through}`);
        }
        const identity = marketplaceIdentityFromContext(input.profile, context);
        const evidence = buildRollingVisibilityEvidence({
          artifact,
          identity,
          through,
          context,
          listingContext,
          artifactRootRef: deps.merchgridArtifactRootRef,
        });
        const previous = await findPreviousRun(deps.runRepository, identity);
        return deps.engine.startMarketplaceVisibility({
          runId: input.runId,
          subjectRef: evidence.subjectRef,
          initialEvidence: evidence,
          marketplaceIdentity: identity,
          ...(previous ? { previousRunRef: previous.runId } : {}),
          ...(previous ? { priorLearning: priorLearningFromRun(previous) } : {}),
        });
      }

      const evidence = buildEtsyVisibilityEvidence({ input, context, listingContext });

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
      if (artifact.period.kind !== 'weekly') {
        throw new AppError('validation_failed', 'MerchGrid visibility result requires a weekly review artifact');
      }
      if (artifact.period.current.endDate !== through) {
        throw new AppError('validation_failed', 'MerchGrid weekly review artifact period does not match through date');
      }
      const freshEvidence = buildRollingVisibilityEvidence({
        artifact,
        identity: requireMarketplaceIdentity(state, input.profile),
        through,
        context: initial.marketplaceContext,
        listingContext: initial.listingContext,
        artifactRootRef: deps.merchgridArtifactRootRef,
      });
      assertValidMerchGridResultArtifact({ artifact, through, state, freshEvidence });

      const measuredSignals = numericMarketplaceSignals(artifact);
      if (Object.keys(measuredSignals).length === 0) {
        return deps.engine.waitForMoreData({
          runId: input.runId,
          reason: 'visibility result evidence has no measured signals',
        });
      }

      const evidence = buildResultEvidenceForRun({ state, freshEvidence });
      return deps.engine.resumeWithExperimentResults({ runId: input.runId, resultEvidence: evidence });
    },
  };
}

export function buildRollingVisibilityEvidence(input: {
  artifact: MerchGridReviewEvidence;
  identity: MarketplaceProductIdentity;
  through: string;
  context: MarketplaceVisibilityContext;
  listingContext?: MarketplaceListingContext;
  artifactRootRef?: string;
}): MarketplaceVisibilityEvidence {
  const identity = MarketplaceProductIdentitySchema.parse(input.identity);
  const through = UtcDateSchema.parse(input.through);
  const artifact = MerchGridReviewEvidenceSchema.parse(input.artifact);
  if (identity.profile !== 'merchgrid_shopify_app_store') {
    throw new AppError('validation_failed', 'Rolling visibility evidence requires the MerchGrid profile');
  }
  if (input.context.marketplace !== 'shopify_app_store') {
    throw new AppError('validation_failed', 'MerchGrid visibility profile requires Shopify App Store context');
  }
  if (input.context.productRef !== identity.productRef) {
    throw new AppError('validation_failed', 'MerchGrid visibility context productRef must match product identity');
  }
  if (artifact.period.kind !== 'weekly') {
    throw new AppError('validation_failed', 'Rolling visibility evidence requires a weekly review artifact');
  }
  if (artifact.period.current.endDate !== through) {
    throw new AppError('validation_failed', 'MerchGrid weekly review artifact period does not match through date');
  }
  const weeklyArtifact = artifact as Extract<MerchGridReviewEvidence, { period: { kind: 'weekly' } }>;
  assertReusableWeeklyArtifact(weeklyArtifact);
  const measuredSignals = numericMarketplaceSignals(weeklyArtifact);
  const reviewMode = selectMarketplaceVisibilityMode({
    context: input.context,
    measuredSignals,
    limitations: weeklyArtifact.limitations,
  });
  assertExploratoryMode(reviewMode);

  return MarketplaceVisibilityEvidenceSchema.parse({
    product: 'marketplace_visibility',
    profile: 'merchgrid_shopify_app_store',
    productRef: identity.productRef,
    subjectRef: `merchgrid:visibility:${through}`,
    artifactRef: merchgridArtifactRef(input.artifactRootRef, 'weekly-reviews', through),
    evidenceLevel: 'sparse',
    recommendationType: 'visibility_hypothesis',
    reviewMode,
    marketplaceContext: input.context,
    listingContext: input.listingContext,
    measuredSignals,
    limitations: curatedMerchGridLimitations(weeklyArtifact.limitations),
    prohibitedClaims: PROHIBITED_CLAIMS,
  });
}

export function buildResultEvidenceForRun(input: {
  state: WorkflowRunState;
  freshEvidence: MarketplaceVisibilityEvidence;
}): MarketplaceVisibilityEvidence {
  const initial = requireInitialVisibilityEvidence(input.state, input.freshEvidence.profile);
  const fresh = MarketplaceVisibilityEvidenceSchema.parse(input.freshEvidence);
  if (initial.profile !== fresh.profile || initial.subjectRef === fresh.subjectRef) {
    throw new AppError('validation_failed', 'Visibility result requires matching initial marketplace visibility evidence');
  }
  const identity = requireMarketplaceIdentity(input.state, fresh.profile);
  if (fresh.productRef !== identity.productRef || initial.productRef && initial.productRef !== identity.productRef) {
    throw new AppError('validation_failed', 'Visibility result product identity must match the applied marketplace run');
  }
  return MarketplaceVisibilityEvidenceSchema.parse({ ...fresh, subjectRef: initial.subjectRef });
}

export function priorLearningFromRun(state: WorkflowRunState): PriorLearningContext | undefined {
  if (state.experimentApplication?.status !== 'applied' || !state.moduleOutputs.m7) return undefined;
  const result = state.evidenceSnapshots?.result;
  if (!result || result.product !== 'marketplace_visibility') return undefined;
  return PriorLearningContextSchema.parse({
    sourceRunId: state.runId,
    sourceEvidenceRef: result.artifactRef,
    experimentPlanRef: `artifacts/workflow-runs/${state.runId}/experiment-plan.json`,
    outcome: state.moduleOutputs.m7.outcome,
    hypothesisEvaluation: state.moduleOutputs.m7.hypothesisEvaluation,
    learning: state.moduleOutputs.m7.learning,
    confidence: state.moduleOutputs.m7.confidence,
    nextAction: state.moduleOutputs.m7.nextAction,
    nextActionRationale: state.moduleOutputs.m7.nextActionRationale,
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

function assertReusableWeeklyArtifact(
  artifact: Extract<MerchGridReviewEvidence, { period: { kind: 'weekly' } }>,
): void {
  assertSevenDateRange(artifact.period.previous);
  assertSevenDateRange(artifact.period.current);
  if (nextUtcDate(artifact.period.previous.endDate) !== artifact.period.current.startDate) {
    throw new AppError('validation_failed', 'MerchGrid weekly review windows must be adjacent seven-date periods');
  }
  for (const period of [artifact.sourceCoverage.previous, artifact.sourceCoverage.current]) {
    for (const coverage of Object.values(period)) {
      if (Object.values(coverage).reduce((total, count) => total + count, 0) !== 7) {
        throw new AppError('validation_failed', 'MerchGrid weekly review source coverage must total seven dates');
      }
    }
  }
}

function assertSevenDateRange(range: { startDate: string; endDate: string }): void {
  if (nextUtcDate(range.startDate, 6) !== range.endDate) {
    throw new AppError('validation_failed', 'MerchGrid weekly review windows must contain exactly seven consecutive dates');
  }
}

function nextUtcDate(date: string, days = 1): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function assertValidMerchGridResultArtifact(input: {
  artifact: MerchGridReviewEvidence;
  through: string;
  state: WorkflowRunState;
  freshEvidence: MarketplaceVisibilityEvidence;
}): void {
  if (input.artifact.period.kind !== 'weekly') {
    throw new AppError('validation_failed', 'MerchGrid visibility result requires a weekly review artifact');
  }
  if (input.artifact.period.current.endDate !== input.through) {
    throw new AppError('validation_failed', 'MerchGrid weekly review artifact period does not match through date');
  }
  const initial = requireInitialVisibilityEvidence(input.state, input.freshEvidence.profile);
  const initialDate = initial.subjectRef.slice('merchgrid:visibility:'.length);
  if (input.through <= initialDate) {
    throw new AppError('validation_failed', 'Visibility result through date must be later than the initial visibility date');
  }
  const application = input.state.experimentApplication;
  if (application?.status === 'not_applied') {
    throw new AppError('route_not_allowed', 'Visibility result requires an applied marketplace experiment');
  }
  const appliedAt = application?.status === 'applied' ? application.appliedAt : undefined;
  const legacyApprovalDate = !application && input.state.approval?.status === 'approved'
    ? input.state.approval.decidedAt.slice(0, 10)
    : undefined;
  if (!appliedAt && !legacyApprovalDate) {
    throw new AppError('route_not_allowed', 'Visibility result requires an applied marketplace experiment');
  }
  const boundary = appliedAt ?? legacyApprovalDate!;
  if (input.artifact.period.current.startDate <= boundary) {
    throw new AppError('validation_failed', 'Visibility result current window must begin after the application boundary');
  }
}

function marketplaceIdentityFromContext(
  profile: MarketplaceVisibilityProfile,
  context: MarketplaceVisibilityContext,
): MarketplaceProductIdentity {
  if (!context.productRef) {
    throw new AppError('validation_failed', 'Rolling marketplace visibility context requires productRef');
  }
  return MarketplaceProductIdentitySchema.parse({ profile, productRef: context.productRef });
}

function requireMarketplaceIdentity(
  state: WorkflowRunState,
  profile: MarketplaceVisibilityProfile,
): MarketplaceProductIdentity {
  const identity = state.marketplaceIdentity;
  if (!identity || identity.profile !== profile) {
    throw new AppError('validation_failed', 'Visibility result requires matching marketplace product identity');
  }
  return identity;
}

async function findPreviousRun(
  repository: RunRepository,
  identity: MarketplaceProductIdentity,
): Promise<WorkflowRunState | undefined> {
  if (!('findLatestByProduct' in repository) || typeof repository.findLatestByProduct !== 'function') return undefined;
  return (repository as MarketplaceRunHistoryRepository).findLatestByProduct(identity);
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
