import { describe, expect, it } from 'vitest';
import type { ResearchOutput } from '../../contracts/modules.js';
import type { WorkflowRunState, WorkflowRunStateInput } from '../../contracts/workflow.js';
import type { RunRepository } from '../../storage/runs.js';
import { makeFixtureListingEvidence } from '../fixtures/listing.js';
import { createWorkflowEngine, type ModuleExecutor } from '../../workflow/engine.js';

describe('workflow engine', () => {
  it('starts a run through RunRepository and advances one deterministic stage at a time', async () => {
    const repository = new InMemoryRunRepository();
    const engine = createWorkflowEngine({
      repository,
      modules: moduleExecutor(),
      now: fixedNow,
    });

    const started = await engine.start({
      runId: 'run-123',
      listingId: 'listing-123',
      initialEvidence: makeFixtureListingEvidence(),
    });
    const afterM1 = await engine.step(started.runId);
    const afterM2 = await engine.step(started.runId);

    expect(started).toMatchObject({
      runId: 'run-123',
      listingId: 'listing-123',
      status: 'analyzing',
      stage: 'm1_context',
      evidenceRefs: ['initial:listing-123:2026-08-12T00:00:00.000Z'],
    });
    expect(started.events).toContainEqual(expect.objectContaining({ type: 'workflow.started' }));
    expect(afterM1).toMatchObject({ stage: 'm2_metrics_initial', moduleOutputs: { m1: { product: 'Planner' } } });
    expect(afterM2).toMatchObject({ stage: 'm4_diagnosis', moduleOutputs: { m2Initial: { comparisonQuality: 'valid' } } });
    expect(repository.savedStates.map((state) => state.stage)).toEqual([
      'm1_context',
      'm2_metrics_initial',
      'm4_diagnosis',
    ]);
  });

  it('pauses deterministically when M2 reports missing evidence', async () => {
    const repository = new InMemoryRunRepository();
    const engine = createWorkflowEngine({
      repository,
      modules: moduleExecutor({
        runM2Initial: async () => ({
          phase: 'initial',
          comparisonQuality: 'missing',
          unresolvedQualificationNeeds: ['Need baseline traffic'],
          metrics: [
            {
              name: 'conversion_rate',
              current: null,
              baseline: null,
              absoluteChange: null,
              percentageChange: null,
              qualification: 'not_available',
              confidence: 'low',
            },
          ],
        }),
      }),
      now: fixedNow,
    });

    await engine.start({ runId: 'run-123', listingId: 'listing-123', initialEvidence: makeFixtureListingEvidence() });
    await engine.step('run-123');
    const paused = await engine.step('run-123');

    expect(paused).toMatchObject({ status: 'waiting_for_data', stage: 'm2_metrics_initial' });
    expect(paused.events).toContainEqual(
      expect.objectContaining({ type: 'workflow.waiting_for_data', message: 'metrics evidence is missing' }),
    );
  });

  it('rejects steps that do not originate from the expected current state', async () => {
    const repository = new InMemoryRunRepository();
    await repository.create({
      ...baseState(),
      stage: 'm5_hypothesis',
      moduleOutputs: { m3: [] },
    });
    const engine = createWorkflowEngine({ repository, modules: moduleExecutor(), now: fixedNow });

    await expect(engine.step('run-123')).rejects.toMatchObject({
      code: 'route_not_allowed',
      message: 'Cannot run m5_hypothesis unless M4 decided to proceed to hypothesis',
    });
  });

  it('records M3 as a side-route and returns research only to the requesting module', async () => {
    const repository = new InMemoryRunRepository();
    const engine = createWorkflowEngine({ repository, modules: moduleExecutor(), now: fixedNow });

    await repository.create({
      ...baseState(),
      stage: 'm5_hypothesis',
      moduleOutputs: {
        m3: [],
        m4: {
          performancePath: 'conversion',
          primaryBottleneck: 'Title mismatch',
          confidence: 'moderate',
          decision: 'proceed_to_hypothesis',
          notes: [],
        },
      },
    });

    const researching = await engine.requestResearch('run-123', {
      requester: 'm5',
      returnStage: 'm5_hypothesis',
      question: 'Check buyer language',
    });

    expect(researching).toMatchObject({ status: 'researching', stage: 'm3_research' });
    await expect(
      engine.completeResearch('run-123', researchOutput({ requester: 'm4', question: 'Check buyer language' })),
    ).rejects.toMatchObject({
      code: 'route_not_allowed',
      message: 'M3 research result requester m4 does not match active requester m5',
    });

    const returned = await engine.completeResearch(
      'run-123',
      researchOutput({ requester: 'm5', question: 'Check buyer language' }),
    );
    expect(returned).toMatchObject({ status: 'analyzing', stage: 'm5_hypothesis' });
    expect(returned.moduleOutputs.m3).toHaveLength(1);
  });

  it('prevents M3 continue when the configured call cap has been reached', async () => {
    const repository = new InMemoryRunRepository();
    const engine = createWorkflowEngine({
      repository,
      modules: moduleExecutor(),
      researchLimits: { maxToolCalls: 3, maxWallClockMs: 120_000, costBudget: { maxTokens: 1_000 } },
      now: fixedNow,
    });
    await repository.create({
      ...baseState(),
      stage: 'm3_research',
      status: 'researching',
      moduleOutputs: {
        m3: [
          researchOutput({ requester: 'm5' }),
          researchOutput({ requester: 'm5' }),
          researchOutput({ requester: 'm5' }),
        ],
        m4: {
          performancePath: 'conversion',
          primaryBottleneck: 'Title mismatch',
          confidence: 'moderate',
          decision: 'proceed_to_hypothesis',
          notes: [],
        },
      },
      events: [
        {
          eventId: 'event-1',
          runId: 'run-123',
          type: 'research.requested',
          stage: 'm3_research',
          message: 'Check buyer language',
          createdAt: '2026-08-12T00:00:00.000Z',
          data: { requester: 'm5', returnStage: 'm5_hypothesis', startedAt: '2026-08-12T00:00:00.000Z' },
        },
      ],
    });

    await expect(
      engine.completeResearch(
        'run-123',
        researchOutput({
          requester: 'm5',
          next_action: 'continue',
          requestedLookup: {
            tool: 'hosted_web_search',
            reason: 'Need one more citation',
            input: { query: 'etsy planner buyer wording' },
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'research_limit_reached',
      message: 'M3 research call cap reached: 3',
    });
  });

  it('resumes an existing experiment wait with result evidence through the repository', async () => {
    const repository = new InMemoryRunRepository();
    const engine = createWorkflowEngine({ repository, modules: moduleExecutor(), now: fixedNow });
    await repository.create({
      ...baseState(),
      stage: 'experiment_wait',
      status: 'ready_for_experiment',
      evidenceRefs: ['initial:listing-123:2026-08-12T00:00:00.000Z'],
      moduleOutputs: {
        m3: [],
        m6: {
          primaryMetric: 'conversion_rate',
          secondaryMetrics: [],
          baselineValue: 0.02,
          baselinePeriod: 'last 30 days',
          qualificationRequirements: [],
          expectedSupportingSignal: 'Conversion improves',
          expectedWeakeningSignal: 'Conversion declines',
          inconclusiveCondition: 'Traffic too low',
          contextToMonitor: [],
          unresolvedMeasurementRules: [],
        },
      },
    });

    const resumed = await engine.resumeWithExperimentResults({
      runId: 'run-123',
      resultEvidence: makeFixtureListingEvidence({ observedAt: '2026-08-19T00:00:00.000Z' }),
    });

    expect(resumed).toMatchObject({
      status: 'ready_for_evaluation',
      stage: 'm2_metrics_results',
      evidenceRefs: [
        'initial:listing-123:2026-08-12T00:00:00.000Z',
        'result:listing-123:2026-08-19T00:00:00.000Z',
      ],
    });
  });
});

class InMemoryRunRepository implements RunRepository {
  readonly savedStates: WorkflowRunState[] = [];
  private readonly states = new Map<string, WorkflowRunState>();

  async create(state: WorkflowRunStateInput): Promise<void> {
    const normalized = normalizeState(state);
    this.states.set(normalized.runId, normalized);
    this.savedStates.push(normalized);
  }

  async load(runId: string): Promise<WorkflowRunState> {
    const state = this.states.get(runId);
    if (!state) {
      throw new Error(`Missing test run: ${runId}`);
    }
    return structuredClone(state);
  }

  async save(state: WorkflowRunStateInput): Promise<void> {
    const normalized = normalizeState(state);
    this.states.set(normalized.runId, normalized);
    this.savedStates.push(normalized);
  }
}

function normalizeState(state: WorkflowRunStateInput): WorkflowRunState {
  return {
    ...state,
    moduleOutputs: { m3: [], ...state.moduleOutputs },
  } as WorkflowRunState;
}

function fixedNow(): Date {
  return new Date('2026-08-12T00:00:00.000Z');
}

function baseState(): WorkflowRunState {
  return {
    runId: 'run-123',
    listingId: 'listing-123',
    status: 'analyzing',
    stage: 'm1_context',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    evidenceRefs: [],
    moduleOutputs: { m3: [] },
    events: [],
  };
}

function moduleExecutor(overrides: Partial<ModuleExecutor> = {}): ModuleExecutor {
  return {
    runM1: async () => ({
      product: 'Planner',
      availableEvidence: ['listing'],
      missingInformation: [],
      notes: [],
    }),
    runM2Initial: async () => ({
      phase: 'initial',
      comparisonQuality: 'valid',
      unresolvedQualificationNeeds: [],
      metrics: [
        {
          name: 'conversion_rate',
          current: 0.02,
          baseline: 0.01,
          absoluteChange: 0.01,
          percentageChange: 100,
          qualification: 'improved',
          confidence: 'moderate',
        },
      ],
    }),
    runM3: async (_state, request) => researchOutput({ requester: request.requester, question: request.question }),
    runM4: async () => ({
      performancePath: 'conversion',
      primaryBottleneck: 'Title mismatch',
      confidence: 'moderate',
      decision: 'proceed_to_hypothesis',
      notes: [],
    }),
    runM5: async () => ({
      hypothesis: 'Clearer buyer language will improve conversion.',
      primaryVariable: 'title',
      recommendedRevision: 'Printable Weekly Planner for Busy Moms',
      keepConstant: ['price', 'photos'],
      expectedSignal: 'Conversion improves',
      notes: [],
    }),
    runM6: async () => ({
      primaryMetric: 'conversion_rate',
      secondaryMetrics: [],
      baselineValue: 0.02,
      baselinePeriod: 'last 30 days',
      qualificationRequirements: [],
      expectedSupportingSignal: 'Conversion improves',
      expectedWeakeningSignal: 'Conversion declines',
      inconclusiveCondition: 'Traffic too low',
      contextToMonitor: [],
      unresolvedMeasurementRules: [],
    }),
    runM2Results: async () => ({
      phase: 'post_experiment',
      comparisonQuality: 'valid',
      unresolvedQualificationNeeds: [],
      metrics: [
        {
          name: 'conversion_rate',
          current: 0.03,
          baseline: 0.02,
          absoluteChange: 0.01,
          percentageChange: 50,
          qualification: 'improved',
          confidence: 'moderate',
        },
      ],
    }),
    runM7: async () => ({
      outcome: 'win',
      hypothesisEvaluation: 'supported',
      evidence: ['Conversion improved'],
      contextualFactors: [],
      learning: 'The title change helped.',
      confidence: 'moderate',
      knowledgeSource: 'experiment',
      nextAction: 'keep',
      nextActionRationale: 'Keep the change.',
    }),
    ...overrides,
  };
}

function researchOutput(overrides: Partial<ResearchOutput> = {}): ResearchOutput {
  return {
    status: 'resolved',
    next_action: 'stop',
    requester: 'm5',
    question: 'Check buyer language',
    evidence: [
      {
        source: 'web',
        title: 'Buyer wording',
        url: 'https://example.com/buyer-wording',
        excerpt: 'Planner buyers often search for weekly planning terms.',
        fetchedAt: '2026-08-12T00:00:00.000Z',
      },
    ],
    confidence: 'moderate',
    limitations: [],
    ...overrides,
  };
}
