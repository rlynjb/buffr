import { describe, expect, it } from 'vitest';
import type { MarketplaceVisibilityEvidence } from '../../contracts/marketplace-visibility.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';
import { FakeAgentRunner } from '../../agents/runner.js';
import type { AgentRunInput, AgentRunResult, AgentRunner } from '../../agents/runner.js';
import type { MarketplaceResearchConfig } from '../../agents/research/marketplace-config.js';
import type { ResearchTool, ResearchToolResult } from '../../agents/research/agent.js';
import { parseWithSchema } from '../../contracts/workflow.js';
import {
  createMarketplaceVisibilityModuleExecutor,
  deterministicMarketplaceVisibilityContext,
  metricsFromMarketplaceVisibilityEvidence,
} from '../../agents/marketplace-visibility/modules.js';

describe('marketplace visibility modules', () => {
  it('builds deterministic M1 context from sparse visibility evidence', () => {
    expect(deterministicMarketplaceVisibilityContext(visibilityEvidence())).toMatchObject({
      product: 'MerchGrid',
      positioning: expect.stringContaining('Shopify App Store'),
      missingInformation: expect.arrayContaining(['low request volume']),
    });
  });

  it('surfaces listing context as curated M1 evidence', () => {
    const context = deterministicMarketplaceVisibilityContext({
      ...visibilityEvidence(),
      listingContext: listingContext(),
    });

    expect(context.availableEvidence).toContain('listing url: https://apps.shopify.com/merchgrid-catalog-audit');
    expect(context.availableEvidence).toContain('listing headline: Scans your product catalog and shows exactly which items are priced below cost');
    expect(context.availableEvidence).toContain('listing gallery images: 4');
    expect(context.missingInformation).toContain('listing friction: no reviews yet');
    expect(context.notes).toContain('Listing observations are qualitative context, not conversion proof.');
  });

  it('passes bounded prior learning to M1 and model modules without prior events or credentials', async () => {
    const runner = new RecordingRunner({
      m4: { performancePath: 'discovery', primaryBottleneck: 'The listing needs clearer value.', confidence: 'low', decision: 'proceed_to_hypothesis', notes: [] },
      m5: { hypothesis: 'A clearer value statement may help.', primaryVariable: 'listing copy', recommendedRevision: 'Lead with the first audit result.', keepConstant: [], expectedSignal: 'Later evidence is available.', notes: [] },
      m6: {
        primaryMetric: 'posthog_app_opened_count', secondaryMetrics: [], baselineValue: 0, baselinePeriod: 'weekly baseline',
        qualificationRequirements: [], expectedSupportingSignal: 'A later signal is available.', expectedWeakeningSignal: 'A later signal is flat.',
        inconclusiveCondition: 'Traffic is sparse.', contextToMonitor: [], unresolvedMeasurementRules: [],
      },
    });
    const executor = createMarketplaceVisibilityModuleExecutor({ agentRunner: runner });
    const state = {
      ...workflowState({ evidence: visibilityEvidence() }),
      priorLearning: {
        sourceRunId: 'previous-run', sourceEvidenceRef: 'artifacts/visibility/results/2026-09-04.json',
        experimentPlanRef: 'artifacts/workflow-runs/previous-run/experiment-plan.json', outcome: 'inconclusive',
        hypothesisEvaluation: 'inconclusive', learning: 'Observe another weekly window before changing the listing',
        confidence: 'low' as const, nextAction: 'wait' as const, nextActionRationale: 'One week is not enough',
      },
      events: [{ eventId: 'prior-event', runId: 'previous-run', type: 'provider.payload', message: 'apiKey secret', createdAt: '2026-09-05T00:00:00.000Z', data: { apiKey: 'secret' } }],
    } satisfies WorkflowRunState;

    await expect(executor.runM1(state)).resolves.toMatchObject({
      notes: expect.arrayContaining([
        'Prior learning outcome: inconclusive',
        'Prior learning: Observe another weekly window before changing the listing',
      ]),
    });
    await executor.runM4(state);
    await executor.runM5(state);
    await executor.runM6(state);

    expect(runner.inputs).toHaveLength(3);
    expect(runner.inputs.every((input) => (
      input.priorLearning as { sourceRunId?: string } | undefined
    )?.sourceRunId === 'previous-run')).toBe(true);
    expect(JSON.stringify(runner.inputs)).not.toMatch(/prior-event|apiKey|secret|provider\.payload|"events"/u);
  });

  it('labels M2 as limited sparse evidence without blocking M4', () => {
    expect(metricsFromMarketplaceVisibilityEvidence(visibilityEvidence())).toMatchObject({
      phase: 'initial',
      comparisonQuality: 'limited',
      metrics: expect.arrayContaining([
        expect.objectContaining({
          name: 'visibility.evidence_level',
          current: 1,
          baseline: null,
          qualification: 'inconclusive',
          confidence: 'low',
        }),
      ]),
      unresolvedQualificationNeeds: expect.arrayContaining(['measured marketplace traffic is sparse']),
    });
  });

  it('runs M4-M6 with visibility-specific structured outputs', async () => {
    const executor = createMarketplaceVisibilityModuleExecutor({
      agentRunner: new FakeAgentRunner({
        m4: {
          performancePath: 'discovery',
          primaryBottleneck: 'The listing may not communicate the first audit value quickly enough.',
          competingExplanation: 'The app may not yet have enough marketplace impressions.',
          confidence: 'low',
          decision: 'proceed_to_hypothesis',
          notes: ['Exploratory visibility review; evidence is sparse.'],
        },
        m5: {
          hypothesis: 'Clarifying the first-scan value proposition will improve app opens and scan starts.',
          primaryVariable: 'listing message',
          recommendedRevision: 'Lead screenshots and copy with the first audit outcome.',
          keepConstant: ['pricing', 'app functionality'],
          expectedSignal: 'App opens or scan starts increase after the manual listing update.',
          notes: ['Human approval required before changing the listing.'],
        },
        m6: {
          primaryMetric: 'posthog.app_opened_count',
          secondaryMetrics: ['posthog.scan_started_count'],
          baselineValue: 0,
          baselinePeriod: 'sparse baseline from initial visibility evidence',
          qualificationRequirements: ['Collect a later completed weekly review before evaluating.'],
          expectedSupportingSignal: 'App opens or scan starts increase.',
          expectedWeakeningSignal: 'App opens and scan starts stay flat.',
          inconclusiveCondition: 'Traffic remains too sparse to compare.',
          contextToMonitor: ['listing copy changed manually'],
          unresolvedMeasurementRules: [],
        },
      }),
    });

    const state = workflowState({ evidence: visibilityEvidence() });
    await expect(executor.runM4(state)).resolves.toMatchObject({ performancePath: 'discovery' });
    await expect(executor.runM5(state)).resolves.toMatchObject({ primaryVariable: 'listing message' });
    await expect(executor.runM6(state)).resolves.toMatchObject({ primaryMetric: 'posthog.app_opened_count' });
  });

  it('does not stop at collect_more_data when exploratory mode has complete context', async () => {
    const executor = createMarketplaceVisibilityModuleExecutor({
      agentRunner: new FakeAgentRunner({
        m4: {
          performancePath: 'insufficient_data',
          primaryBottleneck: 'Measured marketplace data is sparse.',
          competingExplanation: 'The listing may not yet have marketplace exposure.',
          confidence: 'low',
          decision: 'collect_more_data',
          notes: ['Metrics are sparse.'],
        },
      }),
    });

    await expect(executor.runM4(workflowState({ evidence: visibilityEvidence() }))).resolves.toMatchObject({
      performancePath: 'discovery',
      decision: 'proceed_to_hypothesis',
      confidence: 'low',
      notes: expect.arrayContaining([
        'Sparse metrics do not block a human-approved exploratory visibility test.',
      ]),
    });
  });

  it('adds exploratory safety notes to M5 and M6 outputs', async () => {
    const executor = createMarketplaceVisibilityModuleExecutor({
      agentRunner: new FakeAgentRunner({
        m5: {
          hypothesis: 'Clearer first-scan positioning may improve qualified opens.',
          primaryVariable: 'listing positioning',
          recommendedRevision: 'Lead the listing with the first audit outcome.',
          keepConstant: ['pricing', 'app behavior'],
          expectedSignal: 'App opens or scan starts become observable.',
          notes: [],
        },
        m6: {
          primaryMetric: 'posthog_app_opened_count',
          secondaryMetrics: ['posthog_scan_started_count'],
          baselineValue: 0,
          baselinePeriod: 'zero-data launch baseline',
          qualificationRequirements: [],
          expectedSupportingSignal: 'A later weekly review shows app opens.',
          expectedWeakeningSignal: 'Signals remain absent after the manual change.',
          inconclusiveCondition: 'Marketplace exposure remains too sparse to compare.',
          contextToMonitor: [],
          unresolvedMeasurementRules: [],
        },
      }),
    });

    await expect(executor.runM5(workflowState({ evidence: visibilityEvidence() }))).resolves.toMatchObject({
      notes: expect.arrayContaining(['Exploratory recommendation; not metric-proven.']),
    });
    await expect(executor.runM6(workflowState({ evidence: visibilityEvidence() }))).resolves.toMatchObject({
      qualificationRequirements: expect.arrayContaining(['Human approval and manual marketplace edit are required before measurement.']),
      contextToMonitor: expect.arrayContaining(['manual marketplace change applied by owner']),
    });
  });

  it('keeps research-producing module outputs on the provider-free visibility path', async () => {
    const executor = createMarketplaceVisibilityModuleExecutor({
      agentRunner: new FakeAgentRunner({
        m4: {
          performancePath: 'discovery',
          primaryBottleneck: 'The listing needs more context.',
          confidence: 'low',
          decision: 'research_domain_knowledge',
          researchQuestion: 'Which listing phrases improve discovery?',
          notes: [],
        },
        m5: {
          hypothesis: 'A clearer listing message may improve discovery.',
          primaryVariable: 'listing message',
          recommendedRevision: 'Lead with the audit outcome.',
          keepConstant: ['pricing'],
          expectedSignal: 'Later evidence becomes available.',
          researchNeed: 'Research marketplace listing phrasing.',
          notes: [],
        },
        m6: {
          primaryMetric: 'posthog.app_opened_count',
          secondaryMetrics: [],
          baselineValue: 0,
          baselinePeriod: 'sparse initial evidence',
          qualificationRequirements: [],
          expectedSupportingSignal: 'A later signal is available.',
          expectedWeakeningSignal: 'A later signal stays flat.',
          inconclusiveCondition: 'Traffic is sparse.',
          contextToMonitor: [],
          unresolvedMeasurementRules: ['Research whether the listing changed.'],
          researchNeed: 'Research the marketplace.',
        },
        m7: {
          outcome: 'inconclusive',
          hypothesisEvaluation: 'inconclusive',
          evidence: [],
          contextualFactors: [],
          learning: 'Sparse evidence cannot establish an outcome.',
          confidence: 'low',
          knowledgeSource: 'product_data',
          nextAction: 'research',
          researchQuestion: 'Research marketplace visibility.',
          nextActionRationale: 'More context would be useful.',
        },
      }),
    });
    const state = workflowState({ evidence: visibilityEvidence() });

    await expect(executor.runM4(state)).resolves.toMatchObject({ decision: 'collect_more_data' });
    await expect(executor.runM5(state)).resolves.not.toHaveProperty('researchNeed');
    await expect(executor.runM6(state)).resolves.toMatchObject({ unresolvedMeasurementRules: [] });
    await expect(executor.runM6(state)).resolves.not.toHaveProperty('researchNeed');
    await expect(executor.runM7(state)).resolves.toMatchObject({ nextAction: 'wait' });
    await expect(executor.runM3(state, {
      requester: 'm4',
      returnStage: 'm4_diagnosis',
      question: 'Research marketplace visibility.',
    })).resolves.toMatchObject({
      status: 'unresolved',
      next_action: 'stop',
      confidence: 'low',
      limitations: ['External research is disabled for marketplace visibility reviews.'],
    });
  });

  it('preserves concrete M4-M7 research signals when marketplace research is enabled', async () => {
    const tool = recordingResearchTool();
    const executor = createMarketplaceVisibilityModuleExecutor({
      agentRunner: researchSignalRunner(),
      research: { config: enabledConfig(), tool },
    });
    const state = workflowState({ evidence: visibilityEvidence() });

    await expect(executor.runM4(state)).resolves.toMatchObject({ decision: 'research_domain_knowledge' });
    await expect(executor.runM5(state)).resolves.toHaveProperty('researchNeed');
    await expect(executor.runM6(state)).resolves.toMatchObject({
      unresolvedMeasurementRules: ['Research whether the listing changed.'],
      researchNeed: 'Research the marketplace.',
    });
    await expect(executor.runM7(state)).resolves.toMatchObject({ nextAction: 'research' });
  });

  it('runs enabled M3 with only the injected hosted web-search tool', async () => {
    const citation = {
      source: 'web' as const,
      title: 'Official guide',
      url: 'https://docs.example.test/guide',
      excerpt: 'Synthetic guidance.',
      fetchedAt: '2026-08-31T00:00:00.000Z',
    };
    const tool = recordingResearchTool({ citations: [citation], data: {} });
    const runner = new SequenceRunner([researchOutput({ evidence: [citation] })]);
    const executor = createMarketplaceVisibilityModuleExecutor({
      agentRunner: runner,
      research: { config: enabledConfig(), tool, now: incrementingNow() },
    });

    await executor.runM3(workflowState({ evidence: visibilityEvidence() }), {
      requester: 'm4',
      returnStage: 'm4_diagnosis',
      question: 'Synthetic policy question',
    });

    expect(tool.calls).toEqual([{ query: 'Synthetic policy question' }]);
  });
});

function enabledConfig(): MarketplaceResearchConfig {
  return {
    enabled: true,
    allowedDomains: ['docs.example.test'],
    searchContextSize: 'low',
    limits: { maxToolCalls: 3, maxWallClockMs: 120_000 },
  };
}

function researchSignalRunner(): AgentRunner {
  return new FakeAgentRunner({
    m4: {
      performancePath: 'discovery',
      primaryBottleneck: 'The listing needs more context.',
      confidence: 'low',
      decision: 'research_domain_knowledge',
      researchQuestion: 'Which listing phrases improve discovery?',
      notes: [],
    },
    m5: {
      hypothesis: 'A clearer listing message may improve discovery.',
      primaryVariable: 'listing message',
      recommendedRevision: 'Lead with the audit outcome.',
      keepConstant: ['pricing'],
      expectedSignal: 'Later evidence becomes available.',
      researchNeed: 'Research marketplace listing phrasing.',
      notes: [],
    },
    m6: {
      primaryMetric: 'posthog.app_opened_count',
      secondaryMetrics: [],
      baselineValue: 0,
      baselinePeriod: 'sparse initial evidence',
      qualificationRequirements: [],
      expectedSupportingSignal: 'A later signal is available.',
      expectedWeakeningSignal: 'A later signal stays flat.',
      inconclusiveCondition: 'Traffic is sparse.',
      contextToMonitor: [],
      unresolvedMeasurementRules: ['Research whether the listing changed.'],
      researchNeed: 'Research the marketplace.',
    },
    m7: {
      outcome: 'inconclusive',
      hypothesisEvaluation: 'inconclusive',
      evidence: [],
      contextualFactors: [],
      learning: 'Sparse evidence cannot establish an outcome.',
      confidence: 'low',
      knowledgeSource: 'product_data',
      nextAction: 'research',
      researchQuestion: 'Research marketplace visibility.',
      nextActionRationale: 'More context would be useful.',
    },
  });
}

class SequenceRunner implements AgentRunner {
  constructor(private readonly outputs: unknown[]) {}

  async runStructured<TOutput>(input: AgentRunInput<TOutput>): Promise<AgentRunResult<TOutput>> {
    return {
      output: parseWithSchema(input.outputSchema, this.outputs.shift(), `${input.moduleId} output`) as TOutput,
    };
  }
}

class RecordingRunner implements AgentRunner {
  readonly inputs: Array<Record<string, unknown>> = [];

  constructor(private readonly outputs: Record<string, unknown>) {}

  async runStructured<TOutput>(input: AgentRunInput<TOutput>): Promise<AgentRunResult<TOutput>> {
    this.inputs.push(input.input as Record<string, unknown>);
    return { output: parseWithSchema(input.outputSchema, this.outputs[input.moduleId], `${input.moduleId} output`) };
  }
}

function recordingResearchTool(
  result: ResearchToolResult = { citations: [], data: {} },
): ResearchTool & { calls: Record<string, unknown>[] } {
  return {
    name: 'hosted_web_search',
    calls: [],
    async call(input) {
      this.calls.push(input);
      return result;
    },
  };
}

function researchOutput(overrides: Record<string, unknown>) {
  return {
    status: 'partly_resolved',
    next_action: 'stop',
    requester: 'm4',
    question: 'Synthetic policy question',
    evidence: [],
    confidence: 'low',
    limitations: [],
    ...overrides,
  };
}

function incrementingNow(): () => number {
  let value = 0;
  return () => value++;
}

function visibilityEvidence(): MarketplaceVisibilityEvidence {
  return {
    product: 'marketplace_visibility',
    profile: 'merchgrid_shopify_app_store',
    subjectRef: 'merchgrid:visibility:2026-08-22',
    artifactRef: 'artifacts/visibility/initial/2026-08-22.json',
    evidenceLevel: 'sparse',
    recommendationType: 'visibility_hypothesis',
    reviewMode: {
      mode: 'exploratory_visibility_test',
      evidenceLevel: 'sparse',
      confidenceBoundary: 'low',
      reason: 'metrics_sparse_context_sufficient',
    },
    marketplaceContext: {
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
      productType: 'shopify_app',
      targetCustomer: 'Shopify merchants reviewing catalog quality',
      customerProblem: 'Catalog issues can hurt trust before the merchant notices',
      currentPromise: 'Find catalog issues before they hurt sales or trust',
      currentSurfaceSummary: 'Shopify App Store listing for catalog audits',
      primaryDiscoverySurface: 'Shopify App Store search and category pages',
      primaryActionWanted: 'Open the app and run the first catalog audit',
      constraints: ['manual listing changes only'],
      availableAssets: ['listing copy', 'screenshots'],
      ownerGoal: 'increase qualified app opens and first scans',
    },
    measuredSignals: { posthog_app_opened_count: 0 },
    limitations: ['low request volume'],
    prohibitedClaims: ['Do not claim the listing caused traffic'],
  };
}

function listingContext() {
  return {
    marketplace: 'shopify_app_store' as const,
    profile: 'merchgrid_shopify_app_store' as const,
    productName: 'MerchGrid',
    sourceUrl: 'https://apps.shopify.com/merchgrid-catalog-audit',
    capturedAt: '2026-08-24T12:00:00.000Z',
    captureMode: 'manual_visual_review' as const,
    publicSurface: {
      headline: 'Scans your product catalog and shows exactly which items are priced below cost',
      category: 'Analytics',
      pricingLabel: 'Free',
      ratingSummary: '0 reviews',
      reviewCount: 0,
    },
    gallery: {
      imageCount: 4,
      observedImageLabels: ['main image', 'onboarding image', 'progress image', 'result image'],
      visualNotes: ['screenshots show audit flow and result surface'],
    },
    trustSignals: {
      positive: ['free pricing'],
      friction: ['no reviews yet'],
    },
    copyNotes: {
      clearClaims: ['detect below cost pricing'],
      unclearClaims: ['read only safety is not prominent'],
      missingContext: ['first scan outcome could be clearer'],
    },
    visibilityRubricNotes: {
      promiseClarity: 'pricing issue promise is concrete',
      audienceSpecificity: 'merchant role is implied but not explicit',
      problemActionFit: 'catalog audit connects to first scan',
      discoveryFit: 'analytics category may require clearer catalog audit keywords',
      trustAndRiskReduction: 'read only safety should be easier to see',
      assetClarity: 'gallery shows screens but outcome hierarchy may need review',
    },
    limitations: ['manual public page review only'],
  };
}

function workflowState(input: { evidence: MarketplaceVisibilityEvidence }): WorkflowRunState {
  return {
    runId: 'visibility-run-123',
    subjectRef: input.evidence.subjectRef,
    workflowKind: 'marketplace_visibility_review',
    status: 'analyzing',
    stage: 'm4_diagnosis',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    evidenceRefs: ['initial:marketplace_visibility'],
    evidenceSnapshots: { initial: input.evidence },
    moduleOutputs: { m3: [] },
    events: [],
  };
}
