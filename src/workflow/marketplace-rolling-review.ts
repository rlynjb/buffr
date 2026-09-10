import { z } from 'zod';
import {
  ExperimentApplicationSchema,
  MarketplaceProductIdentitySchema,
  MarketplaceVisibilityEvidenceSchema,
  ProductRefSchema,
  type ExperimentApplication,
  type MarketplaceProductIdentity,
  type MarketplaceVisibilityEvidence,
  type MarketplaceVisibilityProfile,
  type PriorLearningContext,
} from '../contracts/marketplace-visibility.js';
import { UtcDateSchema } from '../contracts/metrics.js';
import {
  parseWithSchema,
  type WorkflowRunState,
  type WorkflowStage,
  type WorkflowStatus,
} from '../contracts/workflow.js';
import { AppError } from '../core/errors.js';
import type { MarketplaceRunHistoryRepository } from '../storage/runs.js';
import type { TraceSink } from '../tracing/events.js';
import type { WorkflowEngine } from './engine.js';
import { buildResultEvidenceForRun, priorLearningFromRun } from './marketplace-visibility-profile.js';
import { appendEvent } from './state.js';

const OwnerApplicationResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), appliedAt: z.string() }).strict(),
  z.object({ status: z.literal('not_applied') }).strict(),
  z.object({ status: z.literal('cancelled') }).strict(),
]);

const NEW_REVIEW_STAGES: ReadonlySet<WorkflowStage> = new Set([
  'm1_context',
  'm2_metrics_initial',
  'm3_research',
  'm4_diagnosis',
  'm5_hypothesis',
  'm6_test_plan',
]);

const EVALUATION_STAGES: ReadonlySet<WorkflowStage> = new Set([
  'm2_metrics_results',
  'm7_learning',
]);

const OWNER_PROMPT_SUMMARY_MAX_LENGTH = 240;

export type OwnerApplicationPrompt = {
  confirm(input: {
    previousRunId: string;
    experimentSummary: string;
  }): Promise<
    | { status: 'applied'; appliedAt: string }
    | { status: 'not_applied' }
    | { status: 'cancelled' }
  >;
};

/** The narrow engine surface the rolling facade needs; it owns all workflow transitions. */
export type MarketplaceRollingReviewEngine = Pick<
  WorkflowEngine,
  'startMarketplaceVisibility' | 'step' | 'resumeWithExperimentResults' | 'recordExperimentApplication'
>;

export type RollingReviewInput = {
  profile: MarketplaceVisibilityProfile;
  productRef: string;
  through: string;
  contextPath: string;
  listingContextPath?: string;
  preparedEvidence?: MarketplaceVisibilityEvidence;
};

export type RollingReviewResult = {
  previousRun?: {
    runId: string;
    resolution: 'evaluated' | 'not_applied' | 'already_resolved';
  };
  currentRun: {
    runId: string;
    status: WorkflowStatus;
    stage: WorkflowStage;
    experimentPlanRef?: string;
  };
};

export type RollingReviewDependencies = {
  history: MarketplaceRunHistoryRepository;
  engine: MarketplaceRollingReviewEngine;
  prompt: OwnerApplicationPrompt;
  prepareWeeklyEvidence(input: RollingReviewInput & { identity: MarketplaceProductIdentity }): Promise<MarketplaceVisibilityEvidence>;
  now: () => Date;
  runRootRef?: string;
  emit?: TraceSink['emit'];
};

export type MarketplaceRollingReviewService = {
  nextReview(input: RollingReviewInput): Promise<RollingReviewResult>;
};

type PreparedReview = {
  identity: MarketplaceProductIdentity;
  through: string;
  cycleRunId: string;
  freshEvidence: MarketplaceVisibilityEvidence;
};

type ResolvedPreviousRun = {
  state: WorkflowRunState;
  resolution: NonNullable<RollingReviewResult['previousRun']>['resolution'];
  priorLearning?: PriorLearningContext;
};

/**
 * Creates the single product operation that closes one marketplace review and
 * starts the next. It deliberately delegates stage transitions to WorkflowEngine.
 */
export function createMarketplaceRollingReviewService(
  dependencies: RollingReviewDependencies,
): MarketplaceRollingReviewService {
  return {
    async nextReview(input): Promise<RollingReviewResult> {
      const prepared = await prepareAndValidate(input, dependencies);
      const existing = await findExistingCycle(prepared, dependencies.history);
      if (existing) {
        const advanced = await advanceNewReview(existing, dependencies);
        const recorded = await ensureRollingReviewEvents(advanced, prepared, dependencies);
        return resultForExisting(recorded, dependencies.runRootRef);
      }

      const previous = await dependencies.history.findLatestByProduct(prepared.identity);
      if (previous) assertRunMatchesIdentity(previous, prepared.identity, 'Previous marketplace review');

      const resolved = previous
        ? await resolvePreviousRun(previous, prepared, dependencies)
        : undefined;
      const current = await startAndAdvanceNextRun(prepared, resolved, dependencies);
      const recorded = await ensureRollingReviewEvents(current, prepared, dependencies, resolved);

      return {
        ...(resolved ? { previousRun: { runId: resolved.state.runId, resolution: resolved.resolution } } : {}),
        currentRun: toCurrentRunResult(recorded, dependencies.runRootRef),
      };
    },
  };
}

/** Derives the durable, retry-safe run identifier for one marketplace review cycle. */
export function rollingVisibilityRunId(identity: MarketplaceProductIdentity, through: string): string {
  const validIdentity = parseWithSchema(MarketplaceProductIdentitySchema, identity, 'marketplace product identity');
  const validThrough = parseWithSchema(UtcDateSchema, through, 'rolling review through date');
  return `${validThrough}-${validIdentity.profile}-${validIdentity.productRef}`;
}

async function prepareAndValidate(
  input: RollingReviewInput,
  dependencies: RollingReviewDependencies,
): Promise<PreparedReview> {
  const identity = parseWithSchema(MarketplaceProductIdentitySchema, {
    profile: input.profile,
    productRef: parseWithSchema(ProductRefSchema, input.productRef, 'rolling marketplace product reference'),
  }, 'rolling marketplace product identity');
  const through = parseWithSchema(UtcDateSchema, input.through, 'rolling review through date');
  assertLocalArtifactPath(input.contextPath, 'Marketplace visibility context');
  if (input.listingContextPath !== undefined) {
    assertLocalArtifactPath(input.listingContextPath, 'Marketplace listing context');
  }

  const freshEvidence = parseWithSchema(
    MarketplaceVisibilityEvidenceSchema,
    input.preparedEvidence ?? await dependencies.prepareWeeklyEvidence({ ...input, identity, through }),
    'prepared marketplace weekly evidence',
  );
  if (
    freshEvidence.profile !== identity.profile
    || freshEvidence.productRef !== identity.productRef
    || freshEvidence.marketplaceContext.productRef !== identity.productRef
  ) {
    throw new AppError('validation_failed', 'Prepared marketplace weekly evidence must match rolling product identity');
  }
  if (
    identity.profile === 'merchgrid_shopify_app_store'
    && freshEvidence.subjectRef !== `merchgrid:visibility:${through}`
  ) {
    throw new AppError('validation_failed', 'Prepared marketplace weekly evidence must match the requested through date');
  }

  return {
    identity,
    through,
    cycleRunId: rollingVisibilityRunId(identity, through),
    freshEvidence,
  };
}

async function findExistingCycle(
  prepared: PreparedReview,
  history: MarketplaceRunHistoryRepository,
): Promise<WorkflowRunState | undefined> {
  let existing: WorkflowRunState;
  try {
    existing = await history.load(prepared.cycleRunId);
  } catch (error) {
    if (isMissingRun(error, prepared.cycleRunId)) return undefined;
    throw error;
  }

  assertRunMatchesIdentity(existing, prepared.identity, 'Existing rolling review');
  const initial = existing.evidenceSnapshots?.initial;
  if (
    !initial
    || initial.product !== 'marketplace_visibility'
    || initial.profile !== prepared.identity.profile
    || initial.productRef !== prepared.identity.productRef
    || (
      prepared.identity.profile === 'merchgrid_shopify_app_store'
      && initial.subjectRef !== `merchgrid:visibility:${prepared.through}`
    )
  ) {
    throw new AppError('validation_failed', 'Existing rolling review does not match the requested cycle evidence');
  }
  return existing;
}

async function resolvePreviousRun(
  previous: WorkflowRunState,
  prepared: PreparedReview,
  dependencies: RollingReviewDependencies,
): Promise<ResolvedPreviousRun> {
  if (isCompletedWithLearning(previous)) {
    return {
      state: previous,
      resolution: 'already_resolved',
      priorLearning: priorLearningFromRun(previous, dependencies.runRootRef),
    };
  }

  if (isNotApplied(previous)) {
    return { state: previous, resolution: 'not_applied' };
  }

  if (previous.stage === 'approval_wait' && previous.status === 'awaiting_approval') {
    const application = await confirmApplication(previous, dependencies);
    if (application.status === 'not_applied') {
      const stopped = await dependencies.engine.recordExperimentApplication({
        runId: previous.runId,
        application,
      });
      return { state: stopped, resolution: 'not_applied' };
    }

    assertApplicationAfterPriorBoundaries(previous, application);
    assertQualifiedResultEvidence(previous, prepared, application);
    const applied = await dependencies.engine.recordExperimentApplication({
      runId: previous.runId,
      application,
    });
    return closeAppliedPreviousRun(applied, prepared, dependencies, 'evaluated');
  }

  if (
    previous.stage === 'experiment_wait'
    && previous.status === 'ready_for_experiment'
    && previous.experimentApplication?.status === 'applied'
  ) {
    return closeAppliedPreviousRun(previous, prepared, dependencies, 'evaluated');
  }

  if (
    EVALUATION_STAGES.has(previous.stage)
    && previous.experimentApplication?.status === 'applied'
  ) {
    assertQualifiedResultEvidence(previous, prepared, previous.experimentApplication);
    const completed = await advanceEvaluation(previous, dependencies);
    return {
      state: completed,
      resolution: 'evaluated',
      priorLearning: priorLearningFromRun(completed, dependencies.runRootRef),
    };
  }

  throw new AppError(
    'route_not_allowed',
    `Previous marketplace review ${previous.runId} is unresolved at ${previous.stage}/${previous.status}`,
  );
}

async function confirmApplication(
  previous: WorkflowRunState,
  dependencies: RollingReviewDependencies,
): Promise<ExperimentApplication> {
  const response = parseWithSchema(
    OwnerApplicationResponseSchema,
    await dependencies.prompt.confirm({
      previousRunId: previous.runId,
      experimentSummary: experimentSummary(previous),
    }),
    'owner application response',
  );
  if (response.status === 'cancelled') {
    throw new AppError('route_not_allowed', 'Rolling review was cancelled before workflow mutation');
  }
  if (response.status === 'not_applied') {
    return parseWithSchema(ExperimentApplicationSchema, {
      status: 'not_applied',
      decidedAt: dependencies.now().toISOString(),
    }, 'owner experiment application');
  }

  const application = parseWithSchema(ExperimentApplicationSchema, response, 'owner experiment application');
  if (application.status !== 'applied') {
    throw new AppError('validation_failed', 'Owner application response must include an applied date');
  }
  if (application.appliedAt > dependencies.now().toISOString().slice(0, 10)) {
    throw new AppError('validation_failed', 'Experiment application date cannot be in the future');
  }
  return application;
}

async function closeAppliedPreviousRun(
  applied: WorkflowRunState,
  prepared: PreparedReview,
  dependencies: RollingReviewDependencies,
  resolution: 'evaluated',
): Promise<ResolvedPreviousRun> {
  const application = applied.experimentApplication;
  if (application?.status !== 'applied') {
    throw new AppError('validation_failed', 'Previous marketplace review must record an applied experiment before evaluation');
  }
  assertQualifiedResultEvidence(applied, prepared, application);
  const resultEvidence = buildResultEvidenceForRun({ state: applied, freshEvidence: prepared.freshEvidence });
  const evaluationReady = await dependencies.engine.resumeWithExperimentResults({
    runId: applied.runId,
    resultEvidence,
  });
  const completed = await advanceEvaluation(evaluationReady, dependencies);
  return {
    state: completed,
    resolution,
    priorLearning: priorLearningFromRun(completed, dependencies.runRootRef),
  };
}

async function advanceEvaluation(
  initial: WorkflowRunState,
  dependencies: RollingReviewDependencies,
): Promise<WorkflowRunState> {
  let current = initial;
  while (
    (EVALUATION_STAGES.has(current.stage) && current.status === 'ready_for_evaluation')
    || (current.stage === 'm3_research' && current.status === 'researching')
  ) {
    current = await dependencies.engine.step(current.runId);
  }
  if (!isCompletedWithLearning(current)) {
    throw new AppError(
      'route_not_allowed',
      `Previous marketplace review ${current.runId} is unresolved at ${current.stage}/${current.status}`,
    );
  }
  return current;
}

async function startAndAdvanceNextRun(
  prepared: PreparedReview,
  previous: ResolvedPreviousRun | undefined,
  dependencies: RollingReviewDependencies,
): Promise<WorkflowRunState> {
  const current = await dependencies.engine.startMarketplaceVisibility({
    runId: prepared.cycleRunId,
    subjectRef: prepared.freshEvidence.subjectRef,
    initialEvidence: prepared.freshEvidence,
    marketplaceIdentity: prepared.identity,
    ...(previous ? { previousRunRef: previous.state.runId } : {}),
    ...(previous?.priorLearning ? { priorLearning: previous.priorLearning } : {}),
  });
  return advanceNewReview(current, dependencies);
}

async function advanceNewReview(
  initial: WorkflowRunState,
  dependencies: RollingReviewDependencies,
): Promise<WorkflowRunState> {
  let current = initial;
  while (NEW_REVIEW_STAGES.has(current.stage) && isNewReviewStageReady(current.status)) {
    current = await dependencies.engine.step(current.runId);
  }
  return current;
}

async function ensureRollingReviewEvents(
  current: WorkflowRunState,
  prepared: PreparedReview,
  dependencies: RollingReviewDependencies,
  resolved?: ResolvedPreviousRun,
): Promise<WorkflowRunState> {
  if (current.events.some((event) => event.type === 'rolling_review.completed')) return current;

  const previous = resolved?.state
    ?? (current.previousRunRef ? await dependencies.history.load(current.previousRunRef) : undefined);
  const priorLearning = current.priorLearning;
  const eventInputs = [
    {
      type: 'rolling_review.started',
      message: 'Rolling marketplace review started',
      data: { ...prepared.identity, through: prepared.through },
    },
    ...(previous ? [{
      type: 'rolling_review.previous_run_found',
      message: 'Previous marketplace review found',
      data: { previousRunId: previous.runId },
    }] : []),
    ...(previous && isCompletedWithLearning(previous) ? [{
      type: 'rolling_review.previous_run_evaluated',
      message: 'Previous marketplace review evaluation available',
      data: { previousRunId: previous.runId },
    }] : []),
    ...(priorLearning ? [{
      type: 'rolling_review.prior_learning_selected',
      message: 'Bounded prior marketplace learning selected',
      data: {
        sourceRunId: priorLearning.sourceRunId,
        sourceEvidenceRef: priorLearning.sourceEvidenceRef,
        experimentPlanRef: priorLearning.experimentPlanRef,
      },
    }] : []),
    {
      type: 'rolling_review.next_run_created',
      message: 'Next marketplace review run created',
      data: { currentRunId: current.runId },
    },
    {
      type: 'rolling_review.completed',
      message: 'Rolling marketplace review completed',
      data: { currentRunId: current.runId },
    },
  ];
  const existingTypes = new Set(current.events.map((event) => event.type));
  let next = current;
  for (const eventInput of eventInputs) {
    if (existingTypes.has(eventInput.type)) continue;
    next = appendEvent(next, {
      ...eventInput,
      stage: current.stage,
      now: dependencies.now(),
    }) as WorkflowRunState;
  }
  if (next === current) return current;

  await dependencies.history.save(next);
  const persisted = await dependencies.history.load(current.runId);
  for (const event of persisted.events.slice(current.events.length)) {
    await dependencies.emit?.(event);
  }
  return persisted;
}

function resultForExisting(existing: WorkflowRunState, runRootRef?: string): RollingReviewResult {
  return { currentRun: toCurrentRunResult(existing, runRootRef) };
}

function toCurrentRunResult(
  state: WorkflowRunState,
  runRootRef = 'artifacts/workflow-runs',
): RollingReviewResult['currentRun'] {
  return {
    runId: state.runId,
    status: state.status,
    stage: state.stage,
    ...(state.moduleOutputs.m6 ? { experimentPlanRef: `${runRootRef}/${state.runId}/experiment-plan.json` } : {}),
  };
}

function experimentSummary(state: WorkflowRunState): string {
  const revision = state.moduleOutputs.m5?.recommendedRevision;
  if (!revision) {
    throw new AppError('validation_failed', 'Previous marketplace review cannot request application without a test hypothesis');
  }
  const sanitized = revision
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const bounded = [...sanitized].slice(0, OWNER_PROMPT_SUMMARY_MAX_LENGTH).join('');
  if (!bounded) {
    throw new AppError('validation_failed', 'Previous marketplace review test hypothesis is not safe to display');
  }
  return bounded;
}

function assertQualifiedResultEvidence(
  previous: WorkflowRunState,
  prepared: PreparedReview,
  application: Extract<ExperimentApplication, { status: 'applied' }>,
): void {
  const primaryMetric = previous.moduleOutputs.m6?.primaryMetric;
  if (!primaryMetric) {
    throw new AppError('validation_failed', 'Previous marketplace review requires an M6 primary metric before result evaluation');
  }
  const primarySignal = prepared.freshEvidence.measuredSignals[primaryMetric];
  if (typeof primarySignal !== 'number' || !Number.isFinite(primarySignal)) {
    throw new AppError(
      'route_not_allowed',
      `Waiting for qualified result evidence: required primary metric ${primaryMetric} is unavailable`,
    );
  }
  assertResultWindowAfterApplication(application.appliedAt, prepared.through);
}

function assertApplicationAfterPriorBoundaries(
  previous: WorkflowRunState,
  application: Extract<ExperimentApplication, { status: 'applied' }>,
): void {
  const planReadyEvent = [...previous.events]
    .reverse()
    .find((event) => event.type === 'workflow.advanced' && event.stage === 'approval_wait');
  const planDate = (planReadyEvent?.createdAt ?? previous.updatedAt).slice(0, 10);
  if (application.appliedAt < planDate) {
    throw new AppError(
      'validation_failed',
      `Experiment application date cannot precede experiment plan date ${planDate}`,
    );
  }

  const initial = previous.evidenceSnapshots?.initial;
  if (!initial || initial.product !== 'marketplace_visibility') {
    throw new AppError('validation_failed', 'Experiment application requires prior marketplace visibility evidence');
  }
  const priorEvidenceDate = initial.subjectRef.slice(initial.subjectRef.lastIndexOf(':') + 1);
  if (application.appliedAt <= priorEvidenceDate) {
    throw new AppError(
      'validation_failed',
      `Experiment application date must be later than prior evidence date ${priorEvidenceDate}`,
    );
  }
}

function assertResultWindowAfterApplication(appliedAt: string, through: string): void {
  const currentWindowStart = utcDateDaysBefore(through, 6);
  if (currentWindowStart <= appliedAt) {
    throw new AppError(
      'route_not_allowed',
      `Fresh weekly evidence must begin after application date ${appliedAt}; waiting for a qualified later window`,
    );
  }
}

function isNewReviewStageReady(status: WorkflowStatus): boolean {
  return status === 'analyzing' || status === 'researching';
}

function isCompletedWithLearning(state: WorkflowRunState): boolean {
  return state.stage === 'cycle_complete' && state.status === 'cycle_complete' && Boolean(state.moduleOutputs.m7);
}

function isNotApplied(state: WorkflowRunState): boolean {
  return state.status === 'stopped' && state.experimentApplication?.status === 'not_applied';
}

function assertRunMatchesIdentity(
  state: WorkflowRunState,
  identity: MarketplaceProductIdentity,
  label: string,
): void {
  if (
    state.marketplaceIdentity?.profile !== identity.profile
    || state.marketplaceIdentity.productRef !== identity.productRef
  ) {
    throw new AppError('validation_failed', `${label} does not match the requested marketplace product identity`);
  }
}

function assertLocalArtifactPath(path: string, label: string): void {
  if (!path.trim() || path.includes('://')) {
    throw new AppError('validation_failed', `${label} path must be a local file`);
  }
}

function utcDateDaysBefore(through: string, days: number): string {
  const date = new Date(`${through}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function isMissingRun(error: unknown, runId: string): boolean {
  return error instanceof AppError
    && error.code === 'storage_failed'
    && error.message === `Workflow run not found: ${runId}`;
}
