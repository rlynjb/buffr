import { describe, expect, it } from 'vitest';
import type { ResearchOutput } from '../../contracts/modules.js';
import type { WorkflowRunState, WorkflowRunStateInput } from '../../contracts/workflow.js';
import { FakeAgentRunner, type TraceContext } from '../../agents/runner.js';
import { runMetricsModule } from '../../agents/metrics/agent.js';
import { runEvaluationModule } from '../../agents/evaluation/agent.js';
import { createWorkflowEngine, type ModuleExecutor } from '../../workflow/engine.js';
import type { RunRepository } from '../../storage/runs.js';
import { makeFixtureListingEvidence } from '../fixtures/listing.js';

describe('post-experiment M2 and M7 lifecycle', () => {
  it('resumes from experiment wait, evaluates frozen-baseline results, and completes the cycle', async () => {
    const repository = new InMemoryRunRepository();
    await repository.create(experimentWaitState());
    const engine = createWorkflowEngine({
      repository,
      modules: postExperimentExecutor(),
      now: fixedNow,
    });

    const resumed = await engine.resumeWithExperimentResults({
      runId: 'run-123',
      resultEvidence: resultEvidence(),
    });
    const afterM2Results = await engine.step(resumed.runId);
    const completed = await engine.step(resumed.runId);

    expect([resumed.stage, afterM2Results.stage, completed.stage]).toEqual([
      'm2_metrics_results',
      'm7_learning',
      'cycle_complete',
    ]);
    expect(afterM2Results.moduleOutputs.m2Results?.metrics).toContainEqual({
      name: 'conversion_rate',
      current: 0.04,
      baseline: 0.02,
      absoluteChange: 0.02,
      percentageChange: 100,
      qualification: 'improved',
      confidence: 'moderate',
    });
    expect(completed).toMatchObject({
      status: 'cycle_complete',
      stage: 'cycle_complete',
      moduleOutputs: {
        m7: {
          outcome: 'win',
          hypothesisEvaluation: 'supported',
          nextAction: 'keep',
        },
      },
    });
  });
});

class InMemoryRunRepository implements RunRepository {
  private readonly states = new Map<string, WorkflowRunState>();

  async create(state: WorkflowRunStateInput): Promise<void> {
    const normalized = normalizeState(state);
    this.states.set(normalized.runId, normalized);
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
  }
}

function postExperimentExecutor(): ModuleExecutor {
  const runner = new FakeAgentRunner({
    m7: {
      outcome: 'win',
      hypothesisEvaluation: 'supported',
      evidence: ['Conversion rate improved from 0.02 to 0.04'],
      contextualFactors: [],
      learning: 'Clearer title wording improved conversion in this run.',
      confidence: 'moderate',
      knowledgeSource: 'experiment',
      nextAction: 'keep',
      nextActionRationale: 'The primary metric met the expected supporting signal.',
    },
  });

  return {
    runM1: unexpectedModule('M1'),
    runM2Initial: unexpectedModule('M2 initial'),
    runM3: (_state, _request) => failUnexpectedResearch(),
    runM4: unexpectedModule('M4'),
    runM5: unexpectedModule('M5'),
    runM6: unexpectedModule('M6'),
    runM2Results: (state) =>
      Promise.resolve(runMetricsModule({ phase: 'post_experiment', state, evidence: resultEvidence() })),
    runM7: (state) => runEvaluationModule(runner, state, trace(state)),
  };
}

function experimentWaitState(): WorkflowRunState {
  return {
    runId: 'run-123',
    listingId: 'listing-123',
    status: 'ready_for_experiment',
    stage: 'experiment_wait',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    evidenceRefs: ['initial:listing-123:2026-08-12T00:00:00.000Z'],
    moduleOutputs: {
      m3: [],
      m5: {
        hypothesis: 'Clearer buyer-language in the title will improve conversion.',
        primaryVariable: 'title',
        recommendedRevision: 'Printable Weekly Planner for Busy Moms',
        keepConstant: ['price', 'photos', 'tags'],
        expectedSignal: 'Conversion rate improves against the baseline',
        notes: [],
      },
      m6: {
        primaryMetric: 'conversion_rate',
        secondaryMetrics: ['favorite_rate'],
        baselineValue: 0.02,
        baselinePeriod: 'current listing evidence window',
        qualificationRequirements: ['Keep price and photos constant'],
        expectedSupportingSignal: 'Conversion rate rises above 0.02',
        expectedWeakeningSignal: 'Conversion rate stays at or below 0.02',
        inconclusiveCondition: 'Fewer than 100 views during the experiment window',
        contextToMonitor: ['traffic source mix'],
        unresolvedMeasurementRules: [],
      },
    },
    events: [],
  };
}

function resultEvidence() {
  return makeFixtureListingEvidence({
    observedAt: '2026-08-19T00:00:00.000Z',
    stats: {
      impressions: 1000,
      views: 100,
      favorites: 12,
      orders: 4,
      revenueCents: 2800,
      adImpressions: 200,
      adClicks: 20,
      adSpendCents: 500,
      adRevenueCents: 900,
    },
  });
}

function trace(state: WorkflowRunState): TraceContext {
  return { runId: state.runId, stage: state.stage };
}

function normalizeState(state: WorkflowRunStateInput): WorkflowRunState {
  return {
    ...state,
    moduleOutputs: { m3: [], ...state.moduleOutputs },
  } as WorkflowRunState;
}

function fixedNow(): Date {
  return new Date('2026-08-19T00:00:00.000Z');
}

function failUnexpectedResearch(): Promise<ResearchOutput> {
  throw new Error('M3 research is outside Task 8 scope');
}

function unexpectedModule(name: string) {
  return () => {
    throw new Error(`${name} is outside Task 8 scope`);
  };
}
