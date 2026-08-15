import { AppError } from '../core/errors.js';
import {
  NormalizedListingEvidenceSchema,
  type NormalizedListingEvidence,
} from '../contracts/evidence.js';
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
  type ResearchToolName,
  type TestPlanOutput,
} from '../contracts/modules.js';
import {
  parseWithSchema,
  type WorkflowEvent,
  type WorkflowRunState,
  type WorkflowStage,
  type WorkflowStatus,
} from '../contracts/workflow.js';
import type { RunRepository } from '../storage/runs.js';
import { assertCanRunStage, assertNoCredentialKeys } from './guards.js';
import {
  routeAfterM2Initial,
  routeAfterM2Results,
  routeAfterM4,
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
  resultEvidence: NormalizedListingEvidence;
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
  step(runId: string): Promise<WorkflowRunState>;
  resumeWithExperimentResults(input: ResumeExperimentInput): Promise<WorkflowRunState>;
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

  async function persist(state: WorkflowRunState, emitFromIndex = Math.max(0, state.events.length - 1)): Promise<WorkflowRunState> {
    await deps.repository.save(state);
    for (const event of state.events.slice(emitFromIndex)) {
      await deps.emit?.(event);
    }
    return state;
  }

  async function start(input: StartWorkflowInput): Promise<WorkflowRunState> {
    assertNoCredentialKeys(input.initialEvidence);
    const evidence = parseWithSchema(
      NormalizedListingEvidenceSchema,
      input.initialEvidence,
      'initial listing evidence',
    );
    const state = createInitialWorkflowState({
      runId: input.runId,
      listingId: input.listingId,
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

  async function step(runId: string): Promise<WorkflowRunState> {
    const state = await deps.repository.load(runId);
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
      case 'experiment_wait':
        throw new AppError('route_not_allowed', 'Cannot step experiment_wait before result evidence is supplied');
      case 'm3_research':
        throw new AppError('route_not_allowed', 'M3 research must return through completeResearch');
      case 'cycle_complete':
        throw new AppError('route_not_allowed', 'Workflow cycle is already complete');
    }
  }

  async function resumeWithExperimentResults(input: ResumeExperimentInput): Promise<WorkflowRunState> {
    const state = await deps.repository.load(input.runId);
    if (state.stage !== 'experiment_wait') {
      throw new AppError('route_not_allowed', `Cannot resume experiment results from ${state.stage}`);
    }

    assertNoCredentialKeys(input.resultEvidence);
    const evidence = parseWithSchema(
      NormalizedListingEvidenceSchema,
      input.resultEvidence,
      'result listing evidence',
    );
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

  async function requestResearch(runId: string, request: ResearchRequest): Promise<WorkflowRunState> {
    const state = await deps.repository.load(runId);
    return requestResearchFromState(state, request);
  }

  async function completeResearch(runId: string, output: ResearchOutput): Promise<WorkflowRunState> {
    const state = await deps.repository.load(runId);
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
    const m3Outputs = [...state.moduleOutputs.m3, researchOutput];

    if (researchOutput.next_action === 'continue') {
      return persist(
        withEvent(
          {
            ...state,
            moduleOutputs: { ...state.moduleOutputs, m3: m3Outputs },
          },
          'research.continued',
          researchOutput.requestedLookup?.reason ?? 'M3 requested another lookup',
          {
            requester: activeRequest.requester,
            returnStage: activeRequest.returnStage,
            requestedLookup: researchOutput.requestedLookup,
          },
        ),
      );
    }

    return persist(
      withEvent(
        {
          ...state,
          status: 'analyzing',
          stage: activeRequest.returnStage,
          moduleOutputs: { ...state.moduleOutputs, m3: m3Outputs },
        },
        'research.returned',
        'M3 research returned to requester',
        { requester: activeRequest.requester, returnStage: activeRequest.returnStage },
      ),
    );
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

    return applyRoute(completed, routeAfterM4(output), emitFromIndex);
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
  } {
    const event = [...state.events].reverse().find((candidate) => candidate.type === 'research.requested');
    if (!event) {
      throw new AppError('route_not_allowed', 'No active M3 research request metadata was found');
    }

    const requester = event.data.requester;
    const returnStage = event.data.returnStage;
    const startedAt = event.data.startedAt;
    if (!isResearchRequester(requester) || !isWorkflowStage(returnStage) || typeof startedAt !== 'string') {
      throw new AppError('validation_failed', 'Active M3 research request metadata failed validation');
    }

    return { requester, returnStage, startedAt };
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
    step,
    resumeWithExperimentResults,
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

const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  'm1_context',
  'm2_metrics_initial',
  'm3_research',
  'm4_diagnosis',
  'm5_hypothesis',
  'm6_test_plan',
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

function statusForStage(stage: WorkflowStage): WorkflowStatus {
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
