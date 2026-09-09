import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarketplaceVisibilityModuleExecutor } from '../../agents/marketplace-visibility/modules.js';
import type { MarketplaceResearchConfig } from '../../agents/research/marketplace-config.js';
import type { ResearchTool } from '../../agents/research/agent.js';
import {
  FakeAgentRunner,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunner,
} from '../../agents/runner.js';
import type {
  MarketplaceProductIdentity,
  MarketplaceVisibilityContext,
  MarketplaceVisibilityEvidence,
} from '../../contracts/marketplace-visibility.js';
import type { CollectionWindow, DailyMetricSnapshot, MetricSource } from '../../contracts/metrics.js';
import type { WorkflowEvent } from '../../contracts/workflow.js';
import type { MetricSourceAdapter } from '../../connectors/merchgrid/source.js';
import {
  JsonFileMerchGridReviewArtifactRepository,
  runDailyCollection,
  runWeeklyReview,
  type MerchGridSourcePackDependencies,
} from '../../jobs/merchgrid-source-pack.js';
import { JsonFileMetricSnapshotRepository } from '../../storage/metric-snapshots.js';
import { JsonFileRunRepository } from '../../storage/runs.js';
import { createWorkflowEngine } from '../../workflow/engine.js';
import {
  createMarketplaceRollingReviewService,
  type OwnerApplicationPrompt,
} from '../../workflow/marketplace-rolling-review.js';
import { buildRollingVisibilityEvidence } from '../../workflow/marketplace-visibility-profile.js';

describe('marketplace rolling review persisted lifecycle', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('closes one run, carries bounded learning, and creates one idempotent next run', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'marketplace-rolling-review-e2e-'));
    temporaryDirectories.push(rootDir);
    const snapshotRoot = join(rootDir, 'snapshots');
    const artifactRoot = join(rootDir, 'artifacts');
    const runRoot = join(rootDir, 'runs');
    const metricSnapshots = new JsonFileMetricSnapshotRepository({ rootDir: snapshotRoot });
    const weeklyArtifacts = new JsonFileMerchGridReviewArtifactRepository({ rootDir: artifactRoot });
    const sourcePack: MerchGridSourcePackDependencies = {
      adapters: [
        fakeAdapter('posthog', { app_opened_count: 2, scan_started_count: 1 }),
        fakeAdapter('fly_metrics', { request_count: 10 }),
        fakeAdapter('shopify_partner', { installs: 1 }),
      ],
      repository: metricSnapshots,
      artifacts: weeklyArtifacts,
      now: fixedNow,
    };

    for (const date of datesBetween('2026-08-08', '2026-09-04')) {
      await runDailyCollection({ date, dependencies: sourcePack });
    }
    await runWeeklyReview({ through: '2026-08-21', dependencies: sourcePack });
    const sharedWeekly = await runWeeklyReview({ through: '2026-09-04', dependencies: sourcePack });
    const priorWeeklyEvidence = await weeklyArtifacts.loadWeeklyReview('2026-08-21');
    if (!priorWeeklyEvidence) throw new Error('Missing persisted prior weekly artifact');

    const runs = new JsonFileRunRepository({ rootDir: runRoot });
    const agent = new RecordingFakeAgentRunner();
    let workflowNow = new Date('2026-08-22T00:05:00.000Z');
    const engine = createWorkflowEngine({
      repository: runs,
      modules: createMarketplaceVisibilityModuleExecutor({ agentRunner: agent }),
      now: () => workflowNow,
    });
    const previousEvidence = buildRollingVisibilityEvidence({
      artifact: priorWeeklyEvidence,
      identity: productIdentity,
      through: '2026-08-21',
      context: marketplaceContext,
      artifactRootRef: logicalArtifactRoot,
    });
    await engine.startMarketplaceVisibility({
      runId: 'previous-run',
      subjectRef: previousEvidence.subjectRef,
      initialEvidence: previousEvidence,
      marketplaceIdentity: productIdentity,
    });
    for (let step = 0; step < 5; step += 1) await engine.step('previous-run');
    workflowNow = fixedNow();

    const prompt = new AppliedOwnerPrompt();
    const rollingReviews = createMarketplaceRollingReviewService({
      history: runs,
      engine,
      prompt,
      now: fixedNow,
      prepareWeeklyEvidence: async ({ identity, through }) => {
        const artifact = await weeklyArtifacts.loadWeeklyReview(through);
        if (!artifact) throw new Error(`Missing test weekly artifact: ${through}`);
        return buildRollingVisibilityEvidence({
          artifact,
          identity,
          through,
          context: marketplaceContext,
          artifactRootRef: logicalArtifactRoot,
        });
      },
    });
    const input = {
      profile: 'merchgrid_shopify_app_store' as const,
      productRef: 'merchgrid-shopify-app',
      through: '2026-09-04',
      contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
      listingContextPath: 'artifacts/merchgrid/context/merchgrid-listing-context.json',
    };

    const first = await rollingReviews.nextReview(input);
    const previous = await runs.load('previous-run');
    const current = await runs.load(first.currentRun.runId);
    const firstProjection = await readProjectionTree(runRoot);
    const firstAgentCallCount = agent.calls.length;

    expect(first).toMatchObject({
      previousRun: { runId: 'previous-run', resolution: 'evaluated' },
      currentRun: { status: 'awaiting_approval', stage: 'approval_wait' },
    });
    expect(previous).toMatchObject({
      runId: 'previous-run',
      status: 'cycle_complete',
      stage: 'cycle_complete',
      experimentApplication: { status: 'applied', appliedAt: '2026-08-22' },
      moduleOutputs: {
        m2Results: { phase: 'post_experiment' },
        m7: { learning: 'Keep measuring one bounded weekly window before changing another variable.' },
      },
    });
    expect(current).toMatchObject({
      runId: '2026-09-04-merchgrid_shopify_app_store-merchgrid-shopify-app',
      previousRunRef: 'previous-run',
      priorLearning: {
        sourceRunId: 'previous-run',
        sourceEvidenceRef: 'artifacts/merchgrid/metrics/artifacts/weekly-reviews/2026-09-04.json',
        experimentPlanRef: 'artifacts/workflow-runs/previous-run/experiment-plan.json',
        outcome: 'inconclusive',
        nextAction: 'wait',
      },
      moduleOutputs: {
        m6: {
          qualificationRequirements: expect.arrayContaining([
            'Human approval and manual marketplace edit are required before measurement.',
          ]),
        },
      },
    });
    expect(Object.keys(current.priorLearning ?? {}).sort()).toEqual([
      'confidence',
      'experimentPlanRef',
      'hypothesisEvaluation',
      'learning',
      'nextAction',
      'nextActionRationale',
      'outcome',
      'sourceEvidenceRef',
      'sourceRunId',
    ]);
    expect(current.evidenceSnapshots?.initial?.product).toBe('marketplace_visibility');
    expect(previous.evidenceSnapshots?.result?.product).toBe('marketplace_visibility');
    if (
      current.evidenceSnapshots?.initial?.product !== 'marketplace_visibility'
      || previous.evidenceSnapshots?.result?.product !== 'marketplace_visibility'
    ) {
      throw new Error('Expected persisted marketplace visibility evidence');
    }
    expect(current.evidenceSnapshots.initial.artifactRef).toBe(
      previous.evidenceSnapshots.result.artifactRef,
    );
    expect(current.evidenceSnapshots.initial.artifactRef).toBe(
      'artifacts/merchgrid/metrics/artifacts/weekly-reviews/2026-09-04.json',
    );
    await expect(readFile(sharedWeekly.artifactPath, 'utf8')).resolves.toContain('"kind": "weekly"');

    expect(eventTokens(previous.events).slice(-10)).toEqual([
      'experiment.applied',
      'workflow.experiment_results_supplied',
      'module.started:m2',
      'module.completed:m2',
      'route.decided',
      'workflow.advanced',
      'module.started:m7',
      'module.completed:m7',
      'route.decided',
      'workflow.completed',
    ]);
    expect(eventTokens(current.events).slice(-6)).toEqual([
      'rolling_review.started',
      'rolling_review.previous_run_found',
      'rolling_review.previous_run_evaluated',
      'rolling_review.prior_learning_selected',
      'rolling_review.next_run_created',
      'rolling_review.completed',
    ]);
    expect(prompt.calls).toEqual([{
      previousRunId: 'previous-run',
      experimentSummary: 'Lead with the first catalog audit outcome.',
    }]);
    const currentAgentInputs = agent.calls
      .filter((call) => call.trace.runId === current.runId)
      .map((call) => JSON.stringify(call.input));
    expect(currentAgentInputs).toHaveLength(3);
    expect(currentAgentInputs.every((value) => value.includes('"priorLearning"'))).toBe(true);
    expect(currentAgentInputs.join('\n')).not.toMatch(/"events"|experiment\.applied|workflow\.completed/u);

    const retry = await rollingReviews.nextReview(input);
    const retryProjection = await readProjectionTree(runRoot);

    expect(retry.currentRun.runId).toBe(first.currentRun.runId);
    expect(await countRunDirectories(runRoot)).toBe(2);
    expect(retryProjection).toEqual(firstProjection);
    expect(agent.calls).toHaveLength(firstAgentCallCount);
    expect(prompt.calls).toHaveLength(1);
  });

  it('returns bounded M3 research from M7 to M7 without leaking tool payload data', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'marketplace-rolling-review-m7-research-'));
    temporaryDirectories.push(rootDir);
    const runs = new JsonFileRunRepository({ rootDir });
    const runner = new ResearchingEvaluationRunner();
    let workflowNow = new Date('2026-08-22T00:05:00.000Z');
    const tool: ResearchTool = {
      name: 'hosted_web_search',
      async call() {
        return {
          citations: [researchCitation],
          data: { providerPayload: { responseBody: 'must-not-reach-m7' } },
        };
      },
    };
    const engine = createWorkflowEngine({
      repository: runs,
      modules: createMarketplaceVisibilityModuleExecutor({
        agentRunner: runner,
        research: { config: enabledResearchConfig, tool, now: incrementingClock() },
      }),
      researchLimits: {
        maxToolCalls: 1,
        maxWallClockMs: 120_000,
        permittedTools: ['hosted_web_search'],
        costBudget: {},
      },
      now: () => workflowNow,
    });
    const previousEvidence = rollingEvidence('2026-08-21', 2);
    await engine.startMarketplaceVisibility({
      runId: 'previous-run',
      subjectRef: previousEvidence.subjectRef,
      initialEvidence: previousEvidence,
      marketplaceIdentity: productIdentity,
    });
    for (let step = 0; step < 5; step += 1) await engine.step('previous-run');
    workflowNow = fixedNow();

    const rollingReviews = createMarketplaceRollingReviewService({
      history: runs,
      engine,
      prompt: new AppliedOwnerPrompt(),
      now: fixedNow,
      prepareWeeklyEvidence: async ({ through }) => rollingEvidence(through, 4),
    });

    const result = await rollingReviews.nextReview({
      profile: productIdentity.profile,
      productRef: productIdentity.productRef,
      through: '2026-09-04',
      contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
    });
    const previous = await runs.load('previous-run');
    const m7Calls = runner.calls.filter((call) => call.moduleId === 'm7');
    const resumedM7Input = JSON.stringify(m7Calls[1]?.input);

    expect(result.previousRun).toEqual({ runId: 'previous-run', resolution: 'evaluated' });
    expect(previous).toMatchObject({
      stage: 'cycle_complete',
      status: 'cycle_complete',
      moduleOutputs: {
        m3: [{ requester: 'm7', evidence: [{ title: 'Public measurement guide' }] }],
      },
    });
    expect(m7Calls).toHaveLength(2);
    expect(resumedM7Input).toContain('Public measurement guide');
    expect(resumedM7Input).not.toMatch(/providerPayload|responseBody|must-not-reach-m7|searchSummaries|"events"/u);
  });
});

const productIdentity: MarketplaceProductIdentity = {
  profile: 'merchgrid_shopify_app_store',
  productRef: 'merchgrid-shopify-app',
};

const marketplaceContext: MarketplaceVisibilityContext = {
  productRef: 'merchgrid-shopify-app',
  marketplace: 'shopify_app_store',
  productName: 'MerchGrid',
  productType: 'shopify_app',
  targetCustomer: 'Shopify merchants auditing catalog quality',
  customerProblem: 'Catalog issues can hurt trust before merchants notice',
  currentPromise: 'Find catalog issues before they hurt sales or trust',
  currentSurfaceSummary: 'Shopify app listing for catalog audits',
  primaryDiscoverySurface: 'Shopify App Store search and category pages',
  primaryActionWanted: 'Open the app and run a catalog audit',
  constraints: ['manual listing changes only'],
  availableAssets: ['listing copy', 'screenshots'],
  ownerGoal: 'increase qualified app opens and first scans',
};

const logicalArtifactRoot = 'artifacts/merchgrid/metrics/artifacts';

const enabledResearchConfig: MarketplaceResearchConfig = {
  enabled: true,
  allowedDomains: ['docs.example.test'],
  searchContextSize: 'low',
  limits: { maxToolCalls: 1, maxWallClockMs: 120_000 },
};

const researchCitation = {
  source: 'web' as const,
  title: 'Public measurement guide',
  url: 'https://docs.example.test/measurement',
  excerpt: 'Use a completed observation window.',
  fetchedAt: '2026-09-04T00:00:00.000Z',
};

class AppliedOwnerPrompt implements OwnerApplicationPrompt {
  readonly calls: Array<{ previousRunId: string; experimentSummary: string }> = [];

  async confirm(input: { previousRunId: string; experimentSummary: string }) {
    this.calls.push(input);
    return { status: 'applied' as const, appliedAt: '2026-08-22' };
  }
}

class RecordingFakeAgentRunner implements AgentRunner {
  readonly calls: Array<AgentRunInput<unknown>> = [];
  private readonly fake = new FakeAgentRunner({
    m4: {
      performancePath: 'discovery',
      primaryBottleneck: 'The first listing line may not state the catalog audit outcome quickly enough.',
      competingExplanation: 'Marketplace exposure may remain too sparse to distinguish copy effects.',
      confidence: 'low',
      decision: 'proceed_to_hypothesis',
      notes: ['Treat this as an exploratory review.'],
    },
    m5: {
      hypothesis: 'A clearer first listing line may improve qualified app opens.',
      primaryVariable: 'listing opening line',
      recommendedRevision: 'Lead with the first catalog audit outcome.',
      keepConstant: ['pricing', 'app behavior'],
      expectedSignal: 'More qualified app opens appear in a later weekly review.',
      notes: [],
    },
    m6: {
      primaryMetric: 'app_opened_count',
      secondaryMetrics: ['scan_started_count'],
      baselineValue: 14,
      baselinePeriod: 'persisted weekly baseline',
      qualificationRequirements: ['Use one later complete weekly review.'],
      expectedSupportingSignal: 'Qualified app opens increase.',
      expectedWeakeningSignal: 'Qualified app opens stay flat or decline.',
      inconclusiveCondition: 'Marketplace exposure remains sparse.',
      contextToMonitor: ['listing copy changed manually'],
      unresolvedMeasurementRules: [],
    },
    m7: {
      outcome: 'inconclusive',
      hypothesisEvaluation: 'inconclusive',
      evidence: ['The persisted weekly comparison remains exploratory.'],
      contextualFactors: ['Marketplace exposure remains sparse.'],
      learning: 'Keep measuring one bounded weekly window before changing another variable.',
      confidence: 'low',
      knowledgeSource: 'experiment',
      nextAction: 'wait',
      nextActionRationale: 'One sparse weekly comparison is not enough to isolate the listing change.',
    },
  });

  async runStructured<TOutput>(input: AgentRunInput<TOutput>): Promise<AgentRunResult<TOutput>> {
    this.calls.push(input as AgentRunInput<unknown>);
    return this.fake.runStructured(input);
  }
}

class ResearchingEvaluationRunner implements AgentRunner {
  readonly calls: Array<AgentRunInput<unknown>> = [];
  private m7CallCount = 0;

  async runStructured<TOutput>(input: AgentRunInput<TOutput>): Promise<AgentRunResult<TOutput>> {
    this.calls.push(input as AgentRunInput<unknown>);
    let output: unknown;
    switch (input.moduleId) {
      case 'm3':
        output = {
          status: 'resolved',
          next_action: 'stop',
          requester: 'm7',
          question: 'How should this sparse result be interpreted?',
          evidence: [researchCitation],
          confidence: 'low',
          limitations: ['One public source only.'],
        };
        break;
      case 'm4':
        output = {
          performancePath: 'discovery',
          primaryBottleneck: 'The first listing line may be unclear.',
          confidence: 'low',
          decision: 'proceed_to_hypothesis',
          notes: [],
        };
        break;
      case 'm5':
        output = {
          hypothesis: 'A clearer first line may improve qualified opens.',
          primaryVariable: 'listing opening line',
          recommendedRevision: 'Lead with the first catalog audit outcome.',
          keepConstant: ['pricing'],
          expectedSignal: 'Qualified app opens increase.',
          notes: [],
        };
        break;
      case 'm6':
        output = {
          primaryMetric: 'app_opened_count',
          secondaryMetrics: [],
          baselineValue: 999,
          baselinePeriod: 'provider proposed baseline',
          qualificationRequirements: [],
          expectedSupportingSignal: 'Qualified app opens increase.',
          expectedWeakeningSignal: 'Qualified app opens stay flat or decline.',
          inconclusiveCondition: 'Evidence remains sparse.',
          contextToMonitor: [],
          unresolvedMeasurementRules: [],
        };
        break;
      case 'm7':
        this.m7CallCount += 1;
        output = this.m7CallCount === 1
          ? {
              outcome: 'inconclusive',
              hypothesisEvaluation: 'inconclusive',
              evidence: ['The weekly result remains sparse.'],
              contextualFactors: [],
              learning: 'Public measurement guidance is needed.',
              confidence: 'low',
              knowledgeSource: 'experiment',
              nextAction: 'research',
              researchQuestion: 'How should this sparse result be interpreted?',
              nextActionRationale: 'Use one bounded public lookup.',
            }
          : {
              outcome: 'inconclusive',
              hypothesisEvaluation: 'inconclusive',
              evidence: ['The public guide supports waiting for another completed window.'],
              contextualFactors: [],
              learning: 'Wait for another completed weekly window.',
              confidence: 'low',
              knowledgeSource: 'combination',
              nextAction: 'wait',
              nextActionRationale: 'The bounded research does not make sparse evidence causal.',
            };
        break;
      default:
        throw new Error(`Unexpected module in research lifecycle: ${input.moduleId}`);
    }
    return { output: input.outputSchema.parse(output) };
  }
}

function fakeAdapter(source: MetricSource, metrics: Record<string, number>): MetricSourceAdapter {
  return {
    source,
    async collect(window: CollectionWindow): Promise<DailyMetricSnapshot> {
      return {
        source,
        date: window.date,
        collectedAt: fixedNow().toISOString(),
        status: 'complete',
        metrics,
        notes: [],
      };
    },
  };
}

function datesBetween(start: string, end: string): string[] {
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const final = new Date(`${end}T00:00:00.000Z`);
  const dates: string[] = [];
  while (cursor <= final) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function fixedNow(): Date {
  return new Date('2026-09-08T00:00:00.000Z');
}

function incrementingClock(): () => number {
  let value = 0;
  return () => value++;
}

function rollingEvidence(through: string, appOpenedCount: number): MarketplaceVisibilityEvidence {
  return {
    product: 'marketplace_visibility',
    profile: productIdentity.profile,
    productRef: productIdentity.productRef,
    subjectRef: `merchgrid:visibility:${through}`,
    artifactRef: `${logicalArtifactRoot}/weekly-reviews/${through}.json`,
    evidenceLevel: 'sparse',
    recommendationType: 'visibility_hypothesis',
    reviewMode: {
      mode: 'exploratory_visibility_test',
      evidenceLevel: 'sparse',
      confidenceBoundary: 'low',
      reason: 'metrics_sparse_context_sufficient',
    },
    marketplaceContext,
    measuredSignals: { app_opened_count: appOpenedCount },
    limitations: ['Evidence is sparse'],
    prohibitedClaims: ['Do not claim the listing caused traffic'],
  };
}

function eventTokens(events: readonly WorkflowEvent[]): string[] {
  return events.map((event) => {
    const moduleId = event.data.moduleId;
    return typeof moduleId === 'string' ? `${event.type}:${moduleId}` : event.type;
  });
}

async function countRunDirectories(rootDir: string): Promise<number> {
  return (await readdir(rootDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
}

async function readProjectionTree(rootDir: string): Promise<Record<string, string>> {
  const files = await listFiles(rootDir);
  return Object.fromEntries(await Promise.all(files.map(async (path) => [
    path.slice(rootDir.length + 1),
    await readFile(path, 'utf8'),
  ])));
}

async function listFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(rootDir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return files.flat().sort();
}
