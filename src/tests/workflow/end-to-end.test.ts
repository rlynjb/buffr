import { access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvaluationOutput, ResearchOutput } from '../../contracts/modules.js';
import { FakeAgentRunner, type TraceContext } from '../../agents/runner.js';
import { runContextModule } from '../../agents/context/agent.js';
import { runMetricsModule } from '../../agents/metrics/agent.js';
import { runDiagnosisModule } from '../../agents/diagnosis/agent.js';
import { runHypothesisModule } from '../../agents/hypothesis/agent.js';
import { runTestDefinitionModule } from '../../agents/test-definition/agent.js';
import { runEvaluationModule } from '../../agents/evaluation/agent.js';
import { createWorkflowEngine, type ModuleExecutor } from '../../workflow/engine.js';
import { JsonFileRunRepository } from '../../storage/runs.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';
import { makeFixtureListingEvidence } from '../fixtures/listing.js';

let rootDir: string;

beforeEach(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  rootDir = await mkdtemp(join(tmpdir(), 'buffr-e2e-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('mocked workflow end to end', () => {
  it('runs the full cycle with fakes and persists run artifacts without credentials', async () => {
    const repository = new JsonFileRunRepository({ rootDir });
    const engine = createWorkflowEngine({
      repository,
      modules: mockedModuleExecutor(),
      now: fixedNow,
    });

    const started = await engine.start({
      runId: 'run-123',
      listingId: 'listing-123',
      initialEvidence: initialEvidence(),
    });
    const afterM1 = await engine.step(started.runId);
    const afterM2Initial = await engine.step(started.runId);
    const afterM4 = await engine.step(started.runId);
    const afterM5 = await engine.step(started.runId);
    const waiting = await engine.step(started.runId);
    const resumed = await engine.resumeWithExperimentResults({
      runId: started.runId,
      resultEvidence: resultEvidence(),
    });
    const afterM2Results = await engine.step(started.runId);
    const completed = await engine.step(started.runId);

    expect([
      started.stage,
      afterM1.stage,
      afterM2Initial.stage,
      afterM4.stage,
      afterM5.stage,
      waiting.stage,
      resumed.stage,
      afterM2Results.stage,
      completed.stage,
    ]).toEqual([
      'm1_context',
      'm2_metrics_initial',
      'm4_diagnosis',
      'm5_hypothesis',
      'm6_test_plan',
      'experiment_wait',
      'm2_metrics_results',
      'm7_learning',
      'cycle_complete',
    ]);
    expect(completed).toMatchObject({
      status: 'cycle_complete',
      stage: 'cycle_complete',
      moduleOutputs: {
        m7: { outcome: 'win', nextAction: 'keep' },
      },
    });

    await expectFile(join(rootDir, 'run-123', 'run.json'));
    await expectFile(join(rootDir, 'run-123', 'evidence', 'initial.json'));
    await expectFile(join(rootDir, 'run-123', 'evidence', 'result.json'));
    await expectFile(join(rootDir, 'run-123', 'experiment-plan.json'));
    await expectFile(join(rootDir, 'run-123', 'events.jsonl'));

    const runJson = await readFile(join(rootDir, 'run-123', 'run.json'), 'utf8');
    const initialJson = await readFile(join(rootDir, 'run-123', 'evidence', 'initial.json'), 'utf8');
    const resultJson = await readFile(join(rootDir, 'run-123', 'evidence', 'result.json'), 'utf8');
    const experimentPlanJson = await readFile(join(rootDir, 'run-123', 'experiment-plan.json'), 'utf8');
    const eventsJsonl = await readFile(join(rootDir, 'run-123', 'events.jsonl'), 'utf8');
    const events = eventsJsonl.trim().split('\n').map((line) => JSON.parse(line) as unknown);

    expect(JSON.parse(initialJson)).toMatchObject({ listingId: 'listing-123', source: 'etsy' });
    expect(JSON.parse(resultJson)).toMatchObject({ listingId: 'listing-123', source: 'etsy' });
    expect(JSON.parse(experimentPlanJson)).toMatchObject({ primaryMetric: 'conversion_rate' });
    expect(events.length).toBeGreaterThanOrEqual(8);
    expect(`${runJson}\n${eventsJsonl}`).not.toMatch(/apiKey|secret|token|refresh/iu);
  });
});

function mockedModuleExecutor(): ModuleExecutor {
  const runner = new FakeAgentRunner({
    m1: {
      product: 'Printable Weekly Planner',
      availableEvidence: ['Listing title, tags, and stats are available'],
      missingInformation: [],
      notes: [],
    },
    m4: {
      performancePath: 'conversion',
      primaryBottleneck: 'Title wording does not match buyer intent',
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
    m7: {
      outcome: 'win',
      hypothesisEvaluation: 'supported',
      evidence: ['Conversion rate improved from 0.02 to 0.04'],
      contextualFactors: [],
      learning: 'The title wording experiment improved conversion in this mocked run.',
      confidence: 'moderate',
      knowledgeSource: 'experiment',
      nextAction: 'keep',
      nextActionRationale: 'The primary metric met the supporting signal.',
    },
  });

  return {
    runM1: (state) => runContextModule(runner, state, trace(state)),
    runM2Initial: (state) => Promise.resolve(runMetricsModule({ phase: 'initial', state, evidence: initialEvidence() })),
    runM3: (_state, _request) => failUnexpectedResearch(),
    runM4: (state) => runDiagnosisModule(runner, state, trace(state)),
    runM5: (state) => runHypothesisModule(runner, state, trace(state)),
    runM6: (state) => runTestDefinitionModule(runner, state, trace(state)),
    runM2Results: (state) => Promise.resolve(runMetricsModule({ phase: 'post_experiment', state, evidence: resultEvidence() })),
    runM7: (state) => runEvaluationModule(runner, state, trace(state)),
  };
}

function initialEvidence() {
  return makeFixtureListingEvidence();
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

function fixedNow(): Date {
  return new Date('2026-08-19T00:00:00.000Z');
}

function failUnexpectedResearch(): Promise<ResearchOutput> {
  throw new Error('M3 research should not run in happy-path E2E test');
}

async function expectFile(path: string): Promise<void> {
  await expect(access(path)).resolves.toBeUndefined();
}
