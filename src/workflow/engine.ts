import { AppError } from '../core/errors.js';
import {
  NormalizedListingEvidenceSchema,
  type NormalizedListingEvidence,
} from '../contracts/evidence.js';
import {
  MerchGridWorkflowEvidenceSchema,
  type MerchGridWorkflowEvidence,
} from '../contracts/merchgrid-workflow.js';
import {
  ExperimentApplicationSchema,
  MarketplaceProductIdentitySchema,
  MarketplaceVisibilityEvidenceSchema,
  PriorLearningContextSchema,
  type ExperimentApplication,
  type MarketplaceProductIdentity,
  type PriorLearningContext,
  type MarketplaceVisibilityEvidence,
} from '../contracts/marketplace-visibility.js';
import {
  ContextOutputSchema,
  DiagnosisOutputSchema,
  EvaluationOutputSchema,
  HypothesisOutputSchema,
  MetricsOutputSchema,
  ResearchOutputSchema,
  TestPlanOutputSchema,
  type ContextOutput,
  type DiagnosisOutput,
  type EvaluationOutput,
  type HypothesisOutput,
  type MetricsOutput,
  type ResearchOutput,
  type ResearchSearchSummary,
  type ResearchToolName,
  type TestPlanOutput,
} from '../contracts/modules.js';
import {
  parseWithSchema,
  type WorkflowEvent,
  type WorkflowEvidence,
  type WorkflowKind,
  type WorkflowRunState,
  WorkflowRunStateSchema,
  type WorkflowStage,
  type WorkflowStatus,
} from '../contracts/workflow.js';
import type { RunRepository } from '../storage/runs.js';
import { assertCanRunStage, assertNoCredentialKeys } from './guards.js';
import {
  routeAfterM2Initial,
  routeAfterM2Results,
  routeAfterM4ForWorkflowKind,
  routeAfterM5,
  routeAfterM6,
  routeAfterM7,
  type ResearchRequester,
  type RouteDecision,
} from './routes.js';
import { appendEvent, createInitialWorkflowState, evidenceRef, toWorkflowRunStateInput } from './state.js';

export type StartWorkflowInput = {
  runId: string;
  listingId: string;
  initialEvidence: NormalizedListingEvidence;
};

export type ResumeExperimentInput = {
  runId: string;
  resultEvidence: NormalizedListingEvidence | MerchGridWorkflowEvidence | MarketplaceVisibilityEvidence;
};

export type StartMerchGridWorkflowInput = {
  runId: string;
  subjectRef: string;
  workflowKind: Extract<WorkflowKind, 'merchgrid_daily' | 'merchgrid_weekly'>;
  initialEvidence: MerchGridWorkflowEvidence;
};

export type StartMarketplaceVisibilityInput = {
  runId: string;
  subjectRef: string;
  initialEvidence: MarketplaceVisibilityEvidence;
  marketplaceIdentity?: MarketplaceProductIdentity;
  previousRunRef?: string;
  priorLearning?: PriorLearningContext;
};

export type RecordExperimentApplicationInput = {
  runId: string;
  application: ExperimentApplication;
};

export type ResearchRequest = {
  requester: ResearchRequester;
  returnStage: WorkflowStage;
  question: string;
};

export type ResearchLimits = {
  maxToolCalls: number;
  maxWallClockMs: number;
  permittedTools?: readonly ResearchToolName[];
  costBudget: {
    maxTokens?: number;
    maxEstimatedCostUsd?: number;
  };
};

export type ModuleExecutor = {
  runM1(state: WorkflowRunState): Promise<ContextOutput>;
  runM2Initial(state: WorkflowRunState): Promise<MetricsOutput>;
  runM3(state: WorkflowRunState, request: ResearchRequest): Promise<ResearchOutput>;
  runM4(state: WorkflowRunState): Promise<DiagnosisOutput>;
  runM5(state: WorkflowRunState): Promise<HypothesisOutput>;
  runM6(state: WorkflowRunState): Promise<TestPlanOutput>;
  runM2Results(state: WorkflowRunState): Promise<MetricsOutput>;
  runM7(state: WorkflowRunState): Promise<EvaluationOutput>;
};

export type TraceSink = (event: WorkflowEvent) => void | Promise<void>;

export type WorkflowEngine = {
  start(input: StartWorkflowInput): Promise<WorkflowRunState>;
  startMerchGrid(input: StartMerchGridWorkflowInput): Promise<WorkflowRunState>;
  startMarketplaceVisibility(input: StartMarketplaceVisibilityInput): Promise<WorkflowRunState>;
  step(runId: string): Promise<WorkflowRunState>;
  resumeWithExperimentResults(input: ResumeExperimentInput): Promise<WorkflowRunState>;
  recordExperimentApplication(input: RecordExperimentApplicationInput): Promise<WorkflowRunState>;
  approveExperiment(runId: string): Promise<WorkflowRunState>;
  rejectExperiment(input: { runId: string; reason: string }): Promise<WorkflowRunState>;
  waitForMoreData(input: { runId: string; reason: string }): Promise<WorkflowRunState>;
  requestResearch(runId: string, request: ResearchRequest): Promise<WorkflowRunState>;
  completeResearch(runId: string, output: ResearchOutput): Promise<WorkflowRunState>;
};

export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = {
  maxToolCalls: 3,
  maxWallClockMs: 120_000,
  costBudget: {},
};

export function createWorkflowEngine(deps: {
  repository: RunRepository;
  modules: ModuleExecutor;
  emit?: TraceSink;
  now?: () => Date;
  researchLimits?: ResearchLimits;
}): WorkflowEngine {
  const now = deps.now ?? (() => new Date());
  const researchLimits = deps.researchLimits ?? DEFAULT_RESEARCH_LIMITS;
  const experimentApplicationLocks = new Map<string, Promise<void>>();

  async function persist(state: WorkflowRunState, emitFromIndex = Math.max(0, state.events.length - 1)): Promise<WorkflowRunState> {
    await deps.repository.save(state);
    for (const event of state.events.slice(emitFromIndex)) {
      await deps.emit?.(event);
    }
    return state;
  }

  async function start(input: StartWorkflowInput): Promise<WorkflowRunState> {
    assertNoCredentialKeys(input.initialEvidence);
    const listingEvidence = parseWithSchema(
      NormalizedListingEvidenceSchema,
      input.initialEvidence,
      'initial listing evidence',
    );
    const evidence: WorkflowEvidence = { product: 'etsy', evidence: listingEvidence };
    const state = createInitialWorkflowState({
      runId: input.runId,
      listingId: input.listingId,
      subjectRef: `listing:${input.listingId}`,
      workflowKind: 'etsy_listing',
      initialEvidenceRef: evidenceRef('initial', evidence),
      now: now(),
    });
    const stateWithEvidence = {
      ...state,
      evidenceSnapshots: { initial: evidence },
    };

    await deps.repository.create(stateWithEvidence);
    const created = await deps.repository.load(input.runId);
    for (const event of created.events) {
      await deps.emit?.(event);
    }
    return created;
  }

  async function startMerchGrid(input: StartMerchGridWorkflowInput): Promise<WorkflowRunState> {
    assertNoCredentialKeys(input.initialEvidence);
    const evidence = parseWithSchema(
      MerchGridWorkflowEvidenceSchema,
      input.initialEvidence,
      'initial MerchGrid evidence',
    );
    const expectedEvidenceKind = input.workflowKind === 'merchgrid_daily' ? 'daily_health' : 'weekly_review';
    if (evidence.kind !== expectedEvidenceKind) {
      throw new AppError('validation_failed', `Workflow kind ${input.workflowKind} does not match ${evidence.kind} evidence`);
    }
    const state = createInitialWorkflowState({
      runId: input.runId,
      subjectRef: input.subjectRef,
      workflowKind: input.workflowKind,
      initialEvidenceRef: evidenceRef('initial', evidence),
      now: now(),
    });
    const stateWithEvidence = { ...state, evidenceSnapshots: { initial: evidence } };

    await deps.repository.create(stateWithEvidence);
    const created = await deps.repository.load(input.runId);
    for (const event of created.events) {
      await deps.emit?.(event);
    }
    return created;
  }

  async function startMarketplaceVisibility(input: StartMarketplaceVisibilityInput): Promise<WorkflowRunState> {
    assertNoCredentialKeys(input.initialEvidence);
    const evidence = parseWithSchema(
      MarketplaceVisibilityEvidenceSchema,
      input.initialEvidence,
      'initial marketplace visibility evidence',
    );
    const marketplaceIdentity = input.marketplaceIdentity === undefined
      ? undefined
      : parseWithSchema(MarketplaceProductIdentitySchema, input.marketplaceIdentity, 'marketplace product identity');
    const previousRunRef = input.previousRunRef === undefined
      ? undefined
      : parseWithSchema(WorkflowRunStateSchema.shape.previousRunRef, input.previousRunRef, 'previous run reference');
    const priorLearning = input.priorLearning === undefined
      ? undefined
      : parseWithSchema(PriorLearningContextSchema, input.priorLearning, 'prior learning context');
    const state = createInitialWorkflowState({
      runId: input.runId,
      subjectRef: input.subjectRef,
      workflowKind: 'marketplace_visibility_review',
      initialEvidenceRef: evidenceRef('initial', evidence),
      now: now(),
    });
    const stateWithEvidence = {
      ...state,
      evidenceSnapshots: { initial: evidence },
      ...(marketplaceIdentity === undefined ? {} : { marketplaceIdentity }),
      ...(previousRunRef === undefined ? {} : { previousRunRef }),
      ...(priorLearning === undefined ? {} : { priorLearning }),
    };

    await deps.repository.create(stateWithEvidence);
    const created = await deps.repository.load(input.runId);
    for (const event of created.events) {
      await deps.emit?.(event);
    }
    return created;
  }

  async function step(runId: string): Promise<WorkflowRunState> {
    const state = await deps.repository.load(runId);
    assertRunCanTransition(state);
    if (state.status === 'waiting_for_data') {
      throw new AppError('route_not_allowed', 'Cannot step workflow while waiting for more data');
    }

    switch (state.stage) {
      case 'm1_context':
        return runM1(state);
      case 'm2_metrics_initial':
        return runM2Initial(state);
      case 'm4_diagnosis':
        return runM4(state);
      case 'm5_hypothesis':
        return runM5(state);
      case 'm6_test_plan':
        return runM6(state);
      case 'm2_metrics_results':
        return runM2Results(state);
      case 'm7_learning':
        return runM7(state);
      case 'approval_wait':
        throw new AppError('route_not_allowed', 'Cannot step approval_wait before an owner approves or rejects the experiment');
      case 'experiment_wait':
        throw new AppError('route_not_allowed', 'Cannot step experiment_wait before result evidence is supplied');
      case 'm3_research':
        return runM3(state);
      case 'cycle_complete':
        throw new AppError('route_not_allowed', 'Workflow cycle is already complete');
    }
  }

  async function resumeWithExperimentResults(input: ResumeExperimentInput): Promise<WorkflowRunState> {
    const state = await deps.repository.load(input.runId);
    assertRunCanTransition(state);
    if (state.stage !== 'experiment_wait') {
      throw new AppError('route_not_allowed', `Cannot resume experiment results from ${state.stage}`);
    }

    assertNoCredentialKeys(input.resultEvidence);
    const evidence = parseResultEvidence(state, input.resultEvidence);
    const next = withEvent(
      {
        ...state,
        status: 'ready_for_evaluation',
        stage: 'm2_metrics_results',
        evidenceRefs: [...state.evidenceRefs, evidenceRef('result', evidence)],
        evidenceSnapshots: { ...state.evidenceSnapshots, result: evidence },
      },
      'workflow.experiment_results_supplied',
      'Experiment result evidence supplied',
      { resultEvidenceRef: evidenceRef('result', evidence) },
    );

    assertCanRunStage(next, 'm2_metrics_results');
    return persist(next);
  }

  async function approveExperiment(runId: string): Promise<WorkflowRunState> {
    const state = await deps.repository.load(runId);
    assertRunCanTransition(state);
    if (state.stage !== 'approval_wait' || state.status !== 'awaiting_approval') {
      throw new AppError('route_not_allowed', 'Experiment approval is only allowed while awaiting approval');
    }
    const next = withEvent(
      {
        ...state,
        stage: 'experiment_wait',
        status: 'ready_for_experiment',
        approval: { status: 'approved', decidedAt: now().toISOString() },
      },
      'workflow.experiment_approved',
      'Experiment plan approved for manual execution',
    );
    assertCanRunStage(next, 'experiment_wait');
    return persist(next);
  }

  async function recordExperimentApplication(input: RecordExperimentApplicationInput): Promise<WorkflowRunState> {
    const application = parseWithSchema(ExperimentApplicationSchema, input.application, 'experiment application');
    return withExperimentApplicationLock(input.runId, async () => {
      const state = await deps.repository.load(input.runId);
      assertRunCanTransition(state);
      if (state.stage !== 'approval_wait' || state.status !== 'awaiting_approval' || state.experimentApplication) {
        throw new AppError('route_not_allowed', 'Experiment application is only allowed while awaiting approval');
      }

      if (application.status === 'applied') {
        const next = withEvent(
          {
            ...state,
            stage: 'experiment_wait',
            status: 'ready_for_experiment',
            experimentApplication: application,
          },
          'experiment.applied',
          'Experiment application recorded',
          { status: application.status, appliedAt: application.appliedAt },
        );
        assertCanRunStage(next, 'experiment_wait');
        return persist(next);
      }

      return persist(
        withEvent(
          {
            ...state,
            status: 'stopped',
            experimentApplication: application,
          },
          'experiment.not_applied',
          'Experiment not applied',
          { status: application.status, decidedAt: application.decidedAt },
        ),
      );
    });
  }

  async function rejectExperiment(input: { runId: string; reason: string }): Promise<WorkflowRunState> {
    const state = await deps.repository.load(input.runId);
    assertRunCanTransition(state);
    if (state.stage !== 'approval_wait' || state.status !== 'awaiting_approval') {
      throw new AppError('route_not_allowed', 'Experiment rejection is only allowed while awaiting approval');
    }
    const reason = input.reason.trim();
    if (!reason || reason.length > 500) {
      throw new AppError('validation_failed', 'Experiment rejection reason must be between 1 and 500 characters');
    }
    return persist(
      withEvent(
        {
          ...state,
          status: 'stopped',
          approval: { status: 'rejected', decidedAt: now().toISOString(), reason },
        },
        'workflow.experiment_rejected',
        'Experiment plan rejected',
        { reason },
      ),
    );
  }

  async function waitForMoreData(input: { runId: string; reason: string }): Promise<WorkflowRunState> {
    const state = await deps.repository.load(input.runId);
    assertRunCanTransition(state);
    if (state.stage !== 'experiment_wait') {
      throw new AppError('route_not_allowed', `Cannot wait for data from ${state.stage}`);
    }
    return persist(
      withEvent(
        { ...state, status: 'waiting_for_data' },
        'workflow.waiting_for_data',
        input.reason,
      ),
    );
  }

  async function requestResearch(runId: string, request: ResearchRequest): Promise<WorkflowRunState> {
    const state = await deps.repository.load(runId);
    assertRunCanTransition(state);
    return requestResearchFromState(state, request);
  }

  async function completeResearch(runId: string, output: ResearchOutput): Promise<WorkflowRunState> {
    const state = await deps.repository.load(runId);
    assertRunCanTransition(state);
    return completeResearchFromState(state, output);
  }

  async function withExperimentApplicationLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = experimentApplicationLocks.get(runId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    experimentApplicationLocks.set(runId, current);
    await previous;

    try {
      return await operation();
    } finally {
      release();
      if (experimentApplicationLocks.get(runId) === current) {
        experimentApplicationLocks.delete(runId);
      }
    }
  }

  async function completeResearchFromState(
    state: WorkflowRunState,
    output: ResearchOutput,
    emitFromIndex = state.events.length,
  ): Promise<WorkflowRunState> {
    if (state.stage !== 'm3_research' || state.status !== 'researching') {
      throw new AppError('route_not_allowed', 'No active M3 research request is waiting for a result');
    }

    const activeRequest = findActiveResearchRequest(state);
    const researchOutput = parseWithSchema(ResearchOutputSchema, output, 'M3 research output');
    if (researchOutput.requester !== activeRequest.requester) {
      throw new AppError(
        'route_not_allowed',
        `M3 research result requester ${researchOutput.requester} does not match active requester ${activeRequest.requester}`,
      );
    }

    validateResearchPolicy(state, researchOutput, activeRequest.startedAt);
    const stateWithSearchEvents = withResearchSearchEvents(
      state,
      researchOutput.searchSummaries ?? [],
      activeRequest,
    );
    const m3Outputs = [...stateWithSearchEvents.moduleOutputs.m3, researchOutput];

    if (researchOutput.next_action === 'continue') {
      return persist(
        withEvent(
          {
            ...stateWithSearchEvents,
            moduleOutputs: { ...stateWithSearchEvents.moduleOutputs, m3: m3Outputs },
          },
          'research.continued',
          researchOutput.requestedLookup?.reason ?? 'M3 requested another lookup',
          {
            requester: activeRequest.requester,
            returnStage: activeRequest.returnStage,
            requestedLookup: researchOutput.requestedLookup,
          },
        ),
        emitFromIndex,
      );
    }

    return persist(
      withEvent(
        {
          ...stateWithSearchEvents,
          status: statusForStage(activeRequest.returnStage),
          stage: activeRequest.returnStage,
          moduleOutputs: { ...stateWithSearchEvents.moduleOutputs, m3: m3Outputs },
        },
        'research.returned',
        'M3 research returned to requester',
        {
          requester: activeRequest.requester,
          returnStage: activeRequest.returnStage,
          citationCount: researchOutput.evidence.length,
          researchStatus: researchOutput.status,
        },
      ),
      emitFromIndex,
    );
  }

  async function runM3(state: WorkflowRunState): Promise<WorkflowRunState> {
    assertCurrentStage(state, 'm3_research');
    if (state.status !== 'researching') {
      throw new AppError('route_not_allowed', 'M3 research can run only while research is active');
    }
    assertCanRunStage(state, 'm3_research');
    const emitFromIndex = state.events.length;
    const activeRequest = findActiveResearchRequest(state);
    const started = withModuleStarted(state, 'm3', 'M3 research started');
    const output = await deps.modules.runM3(started, {
      requester: activeRequest.requester,
      returnStage: activeRequest.returnStage,
      question: activeRequest.question,
    });
    const completed = withModuleCompleted(started, 'm3', 'M3 research completed');
    return completeResearchFromState(completed, output, emitFromIndex);
  }

  async function runM1(state: WorkflowRunState): Promise<WorkflowRunState> {
    assertCurrentStage(state, 'm1_context');
    assertCanRunStage(state, 'm1_context');
    const emitFromIndex = state.events.length;
    const started = withModuleStarted(state, 'm1', 'M1 context started');
    const output = parseWithSchema(ContextOutputSchema, await deps.modules.runM1(started), 'M1 context output');
    const completed = withModuleCompleted(
      {
        ...started,
        moduleOutputs: { ...started.moduleOutputs, m1: output },
      },
      'm1',
      'M1 context completed',
    );

    return applyRoute(completed, { type: 'advance', nextStage: 'm2_metrics_initial' }, emitFromIndex);
  }

  async function runM2Initial(state: WorkflowRunState): Promise<WorkflowRunState> {
    assertCurrentStage(state, 'm2_metrics_initial');
    assertCanRunStage(state, 'm2_metrics_initial');
    const emitFromIndex = state.events.length;
    const started = withModuleStarted(state, 'm2', 'M2 initial metrics started');
    const output = parseWithSchema(
      MetricsOutputSchema,
      await deps.modules.runM2Initial(started),
      'M2 initial metrics output',
    );
    const completed = withModuleCompleted(
      {
        ...started,
        moduleOutputs: { ...started.moduleOutputs, m2Initial: output },
      },
      'm2',
      'M2 initial metrics completed',
      { phase: 'initial' },
    );

    return applyRoute(
      completed,
      routeAfterM2Initial(output),
      emitFromIndex,
    );
  }

  async function runM4(state: WorkflowRunState): Promise<WorkflowRunState> {
    assertCurrentStage(state, 'm4_diagnosis');
    assertCanRunStage(state, 'm4_diagnosis');
    const emitFromIndex = state.events.length;
    const started = withModuleStarted(state, 'm4', 'M4 diagnosis started');
    const output = parseWithSchema(DiagnosisOutputSchema, await deps.modules.runM4(started), 'M4 diagnosis output');
    const completed = withModuleCompleted(
      { ...started, moduleOutputs: { ...started.moduleOutputs, m4: output } },
      'm4',
      'M4 diagnosis completed',
    );

    return applyRoute(completed, routeAfterM4ForWorkflowKind(state.workflowKind, output), emitFromIndex);
  }

  async function runM5(state: WorkflowRunState): Promise<WorkflowRunState> {
    assertCurrentStage(state, 'm5_hypothesis');
    assertCanRunStage(state, 'm5_hypothesis');
    const emitFromIndex = state.events.length;
    const started = withModuleStarted(state, 'm5', 'M5 hypothesis started');
    const output = parseWithSchema(HypothesisOutputSchema, await deps.modules.runM5(started), 'M5 hypothesis output');
    const completed = withModuleCompleted(
      { ...started, moduleOutputs: { ...started.moduleOutputs, m5: output } },
      'm5',
      'M5 hypothesis completed',
    );

    return applyRoute(completed, routeAfterM5(output), emitFromIndex);
  }

  async function runM6(state: WorkflowRunState): Promise<WorkflowRunState> {
    assertCurrentStage(state, 'm6_test_plan');
    assertCanRunStage(state, 'm6_test_plan');
    const emitFromIndex = state.events.length;
    const started = withModuleStarted(state, 'm6', 'M6 test plan started');
    const output = parseWithSchema(TestPlanOutputSchema, await deps.modules.runM6(started), 'M6 test plan output');
    const completed = withModuleCompleted(
      { ...started, moduleOutputs: { ...started.moduleOutputs, m6: output } },
      'm6',
      'M6 test plan completed',
    );

    return applyRoute(completed, routeAfterM6(output), emitFromIndex);
  }

  async function runM2Results(state: WorkflowRunState): Promise<WorkflowRunState> {
    assertCurrentStage(state, 'm2_metrics_results');
    assertCanRunStage(state, 'm2_metrics_results');
    const emitFromIndex = state.events.length;
    const started = withModuleStarted(state, 'm2', 'M2 result metrics started');
    const output = parseWithSchema(
      MetricsOutputSchema,
      await deps.modules.runM2Results(started),
      'M2 result metrics output',
    );
    const completed = withModuleCompleted(
      { ...started, moduleOutputs: { ...started.moduleOutputs, m2Results: output } },
      'm2',
      'M2 result metrics completed',
      { phase: 'post_experiment' },
    );

    return applyRoute(
      completed,
      routeAfterM2Results(output),
      emitFromIndex,
    );
  }

  async function runM7(state: WorkflowRunState): Promise<WorkflowRunState> {
    assertCurrentStage(state, 'm7_learning');
    assertCanRunStage(state, 'm7_learning');
    const emitFromIndex = state.events.length;
    const started = withModuleStarted(state, 'm7', 'M7 learning started');
    const output = parseWithSchema(EvaluationOutputSchema, await deps.modules.runM7(started), 'M7 learning output');
    const completed = withModuleCompleted(
      { ...started, moduleOutputs: { ...started.moduleOutputs, m7: output } },
      'm7',
      'M7 learning completed',
    );

    return applyRoute(completed, routeAfterM7(output), emitFromIndex);
  }

  async function applyRoute(
    state: WorkflowRunState,
    decision: RouteDecision,
    emitFromIndex = Math.max(0, state.events.length - 1),
  ): Promise<WorkflowRunState> {
    const decided = withEvent(state, 'route.decided', `Route decided: ${decision.type}`, {
      decisionType: decision.type,
      nextStage: 'nextStage' in decision ? decision.nextStage : undefined,
      reason: 'reason' in decision ? decision.reason : undefined,
    });

    if (decision.type === 'advance') {
      return persist(
        withEvent(
          { ...decided, status: statusForStage(decision.nextStage), stage: decision.nextStage },
          'workflow.advanced',
          `Workflow advanced to ${decision.nextStage}`,
        ),
        emitFromIndex,
      );
    }

    if (decision.type === 'research') {
      return requestResearchFromState(decided, decision, emitFromIndex);
    }

    if (decision.type === 'wait') {
      const nextStage = decision.nextStage ?? state.stage;
      const waiting = withEvent(
        {
          ...decided,
          status: nextStage === 'experiment_wait' ? 'ready_for_experiment' : 'waiting_for_data',
          stage: nextStage,
        },
        'workflow.waiting',
        decision.reason,
      );

      return persist(
        withEvent(
          waiting,
          nextStage === 'experiment_wait' ? 'workflow.waiting_for_experiment' : 'workflow.waiting_for_data',
          decision.reason,
        ),
        emitFromIndex,
      );
    }

    if (decision.type === 'complete') {
      return persist(
        withEvent(
          { ...decided, status: 'cycle_complete', stage: 'cycle_complete' },
          'workflow.completed',
          decision.reason,
        ),
        emitFromIndex,
      );
    }

    return persist(withEvent({ ...decided, status: 'stopped' }, 'workflow.stopped', decision.reason), emitFromIndex);
  }

  async function requestResearchFromState(
    state: WorkflowRunState,
    request: ResearchRequest,
    emitFromIndex = Math.max(0, state.events.length - 1),
  ): Promise<WorkflowRunState> {
    if (state.stage !== request.returnStage) {
      throw new AppError(
        'route_not_allowed',
        `M3 research return stage ${request.returnStage} does not match current stage ${state.stage}`,
      );
    }

    const currentEvidenceRef = state.evidenceRefs.at(-1) ?? 'none';
    if (state.moduleOutputs.m3.length >= researchLimits.maxToolCalls) {
      const limited = withEvent(
        { ...state, status: 'waiting_for_data' },
        'research.limit_reached',
        'Workflow research call cap reached',
        {
          requester: request.requester,
          returnStage: request.returnStage,
          evidenceRef: currentEvidenceRef,
          maxToolCalls: researchLimits.maxToolCalls,
        },
      );
      return persist(
        withEvent(
          limited,
          'workflow.waiting_for_data',
          'Research call cap reached; new evidence is required before continuing',
        ),
        emitFromIndex,
      );
    }

    if (isRepeatedUnresolvedResearch(state, request, currentEvidenceRef)) {
      const suppressed = withEvent(
        { ...state, status: 'waiting_for_data' },
        'research.repeated_suppressed',
        'Repeated unresolved research request suppressed',
        {
          requester: request.requester,
          returnStage: request.returnStage,
          evidenceRef: currentEvidenceRef,
        },
      );
      return persist(
        withEvent(
          suppressed,
          'workflow.waiting_for_data',
          'Research remains unresolved; new evidence is required before retrying',
        ),
        emitFromIndex,
      );
    }

    return persist(
      withEvent(
        {
          ...state,
          status: 'researching',
          stage: 'm3_research',
        },
        'research.requested',
        request.question,
        {
          requester: request.requester,
          returnStage: request.returnStage,
          startedAt: now().toISOString(),
          evidenceRef: currentEvidenceRef,
        },
      ),
      emitFromIndex,
    );
  }

  function validateResearchPolicy(
    state: WorkflowRunState,
    output: ResearchOutput,
    startedAt: string,
  ): void {
    if (output.next_action !== 'continue') {
      return;
    }

    if (state.moduleOutputs.m3.length >= researchLimits.maxToolCalls) {
      throw new AppError('research_limit_reached', `M3 research call cap reached: ${researchLimits.maxToolCalls}`);
    }

    if (now().getTime() - Date.parse(startedAt) >= researchLimits.maxWallClockMs) {
      throw new AppError('research_limit_reached', `M3 research time cap reached: ${researchLimits.maxWallClockMs}ms`);
    }

    const requestedTool = output.requestedLookup?.tool;
    const permittedTools = researchLimits.permittedTools ?? ALL_RESEARCH_TOOLS;
    if (!requestedTool || !permittedTools.includes(requestedTool)) {
      throw new AppError('route_not_allowed', `M3 requested tool is not permitted: ${requestedTool ?? 'none'}`);
    }
  }

  function findActiveResearchRequest(state: WorkflowRunState): {
    requester: ResearchRequester;
    returnStage: WorkflowStage;
    startedAt: string;
    question: string;
    evidenceRef?: string;
  } {
    const event = [...state.events].reverse().find((candidate) => candidate.type === 'research.requested');
    if (!event) {
      throw new AppError('route_not_allowed', 'No active M3 research request metadata was found');
    }

    const requester = event.data.requester;
    const returnStage = event.data.returnStage;
    const startedAt = event.data.startedAt;
    const evidenceRef = event.data.evidenceRef;
    if (!isResearchRequester(requester) || !isWorkflowStage(returnStage) || typeof startedAt !== 'string') {
      throw new AppError('validation_failed', 'Active M3 research request metadata failed validation');
    }

    return {
      requester,
      returnStage,
      startedAt,
      question: event.message,
      ...(typeof evidenceRef === 'string' ? { evidenceRef } : {}),
    };
  }

  function isRepeatedUnresolvedResearch(
    state: WorkflowRunState,
    request: ResearchRequest,
    evidenceReference: string,
  ): boolean {
    const latestOutput = state.moduleOutputs.m3.at(-1);
    if (!latestOutput || latestOutput.status === 'resolved' || latestOutput.next_action !== 'stop') return false;

    const latestRequestEvent = [...state.events]
      .reverse()
      .find((event) => event.type === 'research.requested');
    if (!latestRequestEvent || typeof latestRequestEvent.data.evidenceRef !== 'string') return false;

    return (
      latestOutput.requester === request.requester &&
      normalizeResearchQuestion(latestOutput.question) === normalizeResearchQuestion(request.question) &&
      latestRequestEvent.data.requester === request.requester &&
      latestRequestEvent.data.returnStage === request.returnStage &&
      latestRequestEvent.data.evidenceRef === evidenceReference
    );
  }

  function withResearchSearchEvents(
    state: WorkflowRunState,
    summaries: readonly ResearchSearchSummary[],
    request: { requester: ResearchRequester; returnStage: WorkflowStage },
  ): WorkflowRunState {
    return summaries.reduce((current, summary) => {
      const started = withEvent(
        current,
        'research.search.started',
        'Hosted web-search pass started',
        {
          requester: request.requester,
          returnStage: request.returnStage,
          pass: summary.pass,
          allowedDomainCount: summary.allowedDomainCount,
          startedAt: summary.startedAt,
        },
      );

      return withEvent(
        started,
        summary.status === 'completed' ? 'research.search.completed' : 'research.search.failed',
        summary.status === 'completed' ? 'Hosted web-search pass completed' : 'Hosted web-search pass failed',
        {
          requester: request.requester,
          returnStage: request.returnStage,
          pass: summary.pass,
          citationCount: summary.citationCount,
          officialCitationCount: summary.officialCitationCount,
          broaderCitationCount: summary.broaderCitationCount,
          allowedDomainCount: summary.allowedDomainCount,
          completedAt: summary.completedAt,
          ...(summary.failureCategory ? { failureCategory: summary.failureCategory } : {}),
          ...(summary.totalTokens !== undefined ? { totalTokens: summary.totalTokens } : {}),
          ...(summary.estimatedCostUsd !== undefined ? { estimatedCostUsd: summary.estimatedCostUsd } : {}),
        },
      );
    }, state);
  }

  function withEvent(
    state: WorkflowRunState,
    type: string,
    message: string,
    data: Record<string, unknown> = {},
  ): WorkflowRunState {
    return appendEvent(toWorkflowRunStateInput(state), {
      type,
      message,
      stage: state.stage,
      data,
      now: now(),
    }) as WorkflowRunState;
  }

  function withModuleStarted(state: WorkflowRunState, moduleId: string, message: string): WorkflowRunState {
    return withEvent(state, 'module.started', message, { moduleId });
  }

  function withModuleCompleted(
    state: WorkflowRunState,
    moduleId: string,
    message: string,
    data: Record<string, unknown> = {},
  ): WorkflowRunState {
    return withEvent(state, 'module.completed', message, { moduleId, ...data });
  }

  return {
    start,
    startMerchGrid,
    startMarketplaceVisibility,
    step,
    resumeWithExperimentResults,
    recordExperimentApplication,
    approveExperiment,
    rejectExperiment,
    waitForMoreData,
    requestResearch,
    completeResearch,
  };
}

const ALL_RESEARCH_TOOLS: readonly ResearchToolName[] = [
  'etsy_listing_details',
  'etsy_transactions',
  'normalized_evidence',
  'hosted_web_search',
];

function parseResultEvidence(
  state: WorkflowRunState,
  value: NormalizedListingEvidence | MerchGridWorkflowEvidence | MarketplaceVisibilityEvidence,
): WorkflowEvidence {
  if (state.workflowKind === 'etsy_listing') {
    return {
      product: 'etsy',
      evidence: parseWithSchema(NormalizedListingEvidenceSchema, value, 'result listing evidence'),
    };
  }

  if (state.workflowKind === 'marketplace_visibility_review') {
    const evidence = parseWithSchema(MarketplaceVisibilityEvidenceSchema, value, 'result marketplace visibility evidence');
    const initialEvidence = state.evidenceSnapshots?.initial;
    if (
      initialEvidence?.product === 'marketplace_visibility'
      && (initialEvidence.profile !== evidence.profile || initialEvidence.subjectRef !== evidence.subjectRef)
    ) {
      throw new AppError(
        'validation_failed',
        'Result marketplace visibility evidence must match the initial profile and subject',
      );
    }
    return evidence;
  }

  const evidence = parseWithSchema(MerchGridWorkflowEvidenceSchema, value, 'result MerchGrid evidence');
  const expectedEvidenceKind = state.workflowKind === 'merchgrid_daily' ? 'daily_health' : 'weekly_review';
  if (evidence.kind !== expectedEvidenceKind) {
    throw new AppError('validation_failed', `Workflow kind ${state.workflowKind} does not match ${evidence.kind} result evidence`);
  }
  return evidence;
}

const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  'm1_context',
  'm2_metrics_initial',
  'm3_research',
  'm4_diagnosis',
  'm5_hypothesis',
  'm6_test_plan',
  'approval_wait',
  'experiment_wait',
  'm2_metrics_results',
  'm7_learning',
  'cycle_complete',
];

function assertCurrentStage(state: WorkflowRunState, expected: WorkflowStage): void {
  if (state.stage !== expected) {
    throw new AppError('route_not_allowed', `Expected workflow stage ${expected}, got ${state.stage}`);
  }
}

function assertRunCanTransition(state: WorkflowRunState): void {
  if (state.status === 'stopped') {
    throw new AppError('route_not_allowed', 'Stopped workflows cannot transition');
  }
}

function statusForStage(stage: WorkflowStage): WorkflowStatus {
  if (stage === 'approval_wait') {
    return 'awaiting_approval';
  }
  if (stage === 'm2_metrics_results' || stage === 'm7_learning') {
    return 'ready_for_evaluation';
  }
  if (stage === 'cycle_complete') {
    return 'cycle_complete';
  }
  return 'analyzing';
}

function isResearchRequester(value: unknown): value is ResearchRequester {
  return value === 'm2' || value === 'm4' || value === 'm5' || value === 'm6' || value === 'm7';
}

function isWorkflowStage(value: unknown): value is WorkflowStage {
  return typeof value === 'string' && WORKFLOW_STAGES.includes(value as WorkflowStage);
}

function normalizeResearchQuestion(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
