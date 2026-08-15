import { describe, expect, it } from 'vitest';
import type { EvaluationOutput, ResearchOutput } from '../../contracts/modules.js';
import type { WorkflowRunState, WorkflowRunStateInput } from '../../contracts/workflow.js';
import { FakeAgentRunner, type TraceContext } from '../../agents/runner.js';
import { runContextModule } from '../../agents/context/agent.js';
import { runMetricsModule } from '../../agents/metrics/agent.js';
import { runDiagnosisModule } from '../../agents/diagnosis/agent.js';
import { runHypothesisModule } from '../../agents/hypothesis/agent.js';
import { runTestDefinitionModule } from '../../agents/test-definition/agent.js';
import { createWorkflowEngine, type ModuleExecutor, type ResearchRequest } from '../../workflow/engine.js';
import type { RunRepository } from '../../storage/runs.js';
import { makeFixtureListingEvidence } from '../fixtures/listing.js';

describe('initial M1-M6 module lifecycle', () => {
  it('runs from M1 context through deterministic M2 metrics to a manual experiment wait', async () => {
    const repository = new InMemoryRunRepository();
    const engine = createWorkflowEngine({
      repository,
      modules: initialLifecycleExecutor(),
      now: fixedNow,
    });

    const started = await engine.start({
      runId: 'run-123',
      listingId: 'listing-123',
      initialEvidence: makeFixtureListingEvidence(),
    });
    const afterM1 = await engine.step(started.runId);
    const afterM2 = await engine.step(started.runId);
    const afterM4 = await engine.step(started.runId);
    const afterM5 = await engine.step(started.runId);
    const waiting = await engine.step(started.runId);

    expect([started.stage, afterM1.stage, afterM2.stage, afterM4.stage, afterM5.stage, waiting.stage]).toEqual([
      'm1_context',
      'm2_metrics_initial',
      'm4_diagnosis',
      'm5_hypothesis',
      'm6_test_plan',
      'experiment_wait',
    ]);
    expect(waiting).toMatchObject({
      status: 'ready_for_experiment',
      stage: 'experiment_wait',
      moduleOutputs: {
        m1: { product: 'Printable Weekly Planner' },
        m2Initial: { comparisonQuality: 'limited' },
        m4: { decision: 'proceed_to_hypothesis' },
        m5: { primaryVariable: 'title' },
        m6: { primaryMetric: 'conversion_rate' },
      },
    });
    expect(repository.savedStates.map((state) => state.stage)).toEqual([
      'm1_context',
      'm2_metrics_initial',
      'm4_diagnosis',
      'm5_hypothesis',
      'm6_test_plan',
      'experiment_wait',
    ]);
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

function initialLifecycleExecutor(): ModuleExecutor {
  const runner = new FakeAgentRunner({
    m1: {
      product: 'Printable Weekly Planner',
      likelyCustomer: 'Busy planner buyer',
      positioning: 'Printable planning download',
      availableEvidence: ['Listing evidence is available'],
      missingInformation: [],
      notes: [],
    },
    m4: {
      performancePath: 'conversion',
      primaryBottleneck: 'Buyer wording is probably unclear',
      competingExplanation: 'Low traffic may hide the true conversion pattern',
      confidence: 'moderate',
      decision: 'proceed_to_hypothesis',
      notes: [],
    },
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
  });

  return {
    runM1: (state) => runContextModule(runner, state, trace(state)),
    runM2Initial: (state) =>
      Promise.resolve(runMetricsModule({ phase: 'initial', state, evidence: makeFixtureListingEvidence() })),
    runM3: (_state, _request) => failUnexpectedResearch(),
    runM4: (state) => runDiagnosisModule(runner, state, trace(state)),
    runM5: (state) => runHypothesisModule(runner, state, trace(state)),
    runM6: (state) => runTestDefinitionModule(runner, state, trace(state)),
    runM2Results: (_state) => {
      throw new Error('M2 results are outside Task 6 scope');
    },
    runM7: (_state) => failUnexpectedEvaluation(),
  };
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
  return new Date('2026-08-12T00:00:00.000Z');
}

function failUnexpectedResearch(): Promise<ResearchOutput> {
  throw new Error('M3 research is outside Task 6 scope');
}

function failUnexpectedEvaluation(): Promise<EvaluationOutput> {
  throw new Error('M7 evaluation is outside Task 6 scope');
}
