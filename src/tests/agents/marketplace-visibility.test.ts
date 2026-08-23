import { describe, expect, it } from 'vitest';
import type { MarketplaceVisibilityEvidence } from '../../contracts/marketplace-visibility.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';
import { FakeAgentRunner } from '../../agents/runner.js';
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
      missingInformation: ['low request volume'],
    });
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
    });
  });
});

function visibilityEvidence(): MarketplaceVisibilityEvidence {
  return {
    product: 'marketplace_visibility',
    profile: 'merchgrid_shopify_app_store',
    subjectRef: 'merchgrid:visibility:2026-08-22',
    artifactRef: '.local/visibility/initial/2026-08-22.json',
    evidenceLevel: 'sparse',
    recommendationType: 'visibility_hypothesis',
    marketplaceContext: {
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
      currentSurfaceSummary: 'Shopify App Store listing for catalog audits',
      targetAudience: 'Shopify merchants reviewing catalog quality',
    },
    measuredSignals: { posthog_app_opened_count: 0 },
    limitations: ['low request volume'],
    prohibitedClaims: ['Do not claim the listing caused traffic'],
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
