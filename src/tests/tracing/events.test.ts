import { describe, expect, it } from 'vitest';
import type { EvaluationOutput, ResearchOutput } from '../../contracts/modules.js';
import type { WorkflowEvent, WorkflowRunState, WorkflowRunStateInput } from '../../contracts/workflow.js';
import { FakeAgentRunner, type TraceContext } from '../../agents/runner.js';
import { runContextModule } from '../../agents/context/agent.js';
import { runMetricsModule } from '../../agents/metrics/agent.js';
import { runDiagnosisModule } from '../../agents/diagnosis/agent.js';
import { runHypothesisModule } from '../../agents/hypothesis/agent.js';
import { runTestDefinitionModule } from '../../agents/test-definition/agent.js';
import { createWorkflowEvent } from '../../tracing/events.js';
import { createWorkflowEngine, type ModuleExecutor } from '../../workflow/engine.js';
import type { RunRepository } from '../../storage/runs.js';
import { makeFixtureListingEvidence } from '../fixtures/listing.js';

describe('workflow tracing events', () => {
  it('creates workflow events with ISO timestamps and stable type/message fields', () => {
    const event = createWorkflowEvent({
      runId: 'run-123',
      type: 'workflow.started',
      stage: 'm1_context',
      message: 'Workflow run started',
      data: { initialEvidenceRef: 'initial:listing-123:2026-08-12T00:00:00.000Z' },
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });

    expect(event).toMatchObject({
      runId: 'run-123',
      type: 'workflow.started',
      stage: 'm1_context',
      message: 'Workflow run started',
      createdAt: '2026-08-12T00:00:00.000Z',
      data: { initialEvidenceRef: 'initial:listing-123:2026-08-12T00:00:00.000Z' },
    });
    expect(event.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });

  it('rejects trace event data with credential-like key names', () => {
    expect(() =>
      createWorkflowEvent({
        runId: 'run-123',
        type: 'workflow.started',
        message: 'Workflow run started',
        data: { apiKey: 'secret-value' },
      }),
    ).toThrow('Credential-like key is not allowed in workflow data: apiKey');
  });

  it('emits started, module, route, and waiting events during the initial lifecycle', async () => {
    const emitted: WorkflowEvent[] = [];
    const engine = createWorkflowEngine({
      repository: new InMemoryRunRepository(),
      modules: initialLifecycleExecutor(),
      emit: (event) => {
        emitted.push(event);
      },
      now: fixedNow,
    });

    const started = await engine.start({
      runId: 'run-123',
      listingId: 'listing-123',
      initialEvidence: makeFixtureListingEvidence(),
    });
    await engine.step(started.runId);
    await engine.step(started.runId);
    await engine.step(started.runId);
    await engine.step(started.runId);
    await engine.step(started.runId);

    expect(emitted.map((event) => event.type)).toEqual([
      'workflow.started',
      'module.started',
      'module.completed',
      'route.decided',
      'workflow.advanced',
      'module.started',
      'module.completed',
      'route.decided',
      'workflow.advanced',
      'module.started',
      'module.completed',
      'route.decided',
      'workflow.advanced',
      'module.started',
      'module.completed',
      'route.decided',
      'workflow.advanced',
      'module.started',
      'module.completed',
      'route.decided',
      'workflow.waiting',
      'workflow.waiting_for_experiment',
    ]);
    expect(JSON.stringify(emitted)).not.toMatch(/apiKey|secret|token|refresh/iu);
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

function initialLifecycleExecutor(): ModuleExecutor {
  const runner = new FakeAgentRunner({
    m1: {
      product: 'Printable Weekly Planner',
      availableEvidence: ['Listing evidence is available'],
      missingInformation: [],
      notes: [],
    },
    m4: {
      performancePath: 'conversion',
      primaryBottleneck: 'Buyer wording is probably unclear',
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
      throw new Error('M2 results are outside Task 9 scope');
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
  throw new Error('M3 research is outside Task 9 scope');
}

function failUnexpectedEvaluation(): Promise<EvaluationOutput> {
  throw new Error('M7 evaluation is outside Task 9 scope');
}
