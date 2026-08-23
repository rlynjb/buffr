import { describe, expect, it } from 'vitest';
import type { ModuleExecutor } from '../../workflow/engine.js';
import { createWorkflowEngine } from '../../workflow/engine.js';
import type { WorkflowRunState, WorkflowRunStateInput } from '../../contracts/workflow.js';
import type { RunRepository } from '../../storage/runs.js';
import type { MarketplaceVisibilityEvidence } from '../../contracts/marketplace-visibility.js';

describe('marketplace visibility workflow engine entry', () => {
  it('starts a marketplace visibility run with sparse evidence', async () => {
    const repository = new InMemoryRunRepository();
    const engine = createWorkflowEngine({ repository, modules: moduleExecutor(), now: fixedNow });

    const state = await engine.startMarketplaceVisibility({
      runId: 'visibility-1',
      subjectRef: 'marketplace_visibility:merchgrid_shopify_app_store:2026-08-22',
      initialEvidence: visibilityEvidence(),
    });

    expect(state).toMatchObject({
      runId: 'visibility-1',
      workflowKind: 'marketplace_visibility_review',
      stage: 'm1_context',
      evidenceSnapshots: { initial: { product: 'marketplace_visibility', evidenceLevel: 'sparse' } },
    });
    expect(repository.created[0]?.evidenceRefs[0]).toContain('marketplace_visibility');
  });

  it('routes a completed M6 visibility plan to approval wait', async () => {
    const repository = new InMemoryRunRepository();
    const engine = createWorkflowEngine({ repository, modules: moduleExecutor(), now: fixedNow });
    await engine.startMarketplaceVisibility({
      runId: 'visibility-approval',
      subjectRef: 'marketplace_visibility:merchgrid_shopify_app_store:2026-08-22',
      initialEvidence: visibilityEvidence(),
    });

    for (let index = 0; index < 5; index += 1) await engine.step('visibility-approval');
    const state = await repository.load('visibility-approval');

    expect(state).toMatchObject({ stage: 'approval_wait', status: 'awaiting_approval' });
  });

  it('accepts sparse marketplace visibility evidence when an approved experiment resumes', async () => {
    const repository = new InMemoryRunRepository();
    const engine = createWorkflowEngine({ repository, modules: moduleExecutor(), now: fixedNow });
    await engine.startMarketplaceVisibility({
      runId: 'visibility-results',
      subjectRef: 'marketplace_visibility:merchgrid_shopify_app_store:2026-08-22',
      initialEvidence: visibilityEvidence(),
    });
    for (let index = 0; index < 5; index += 1) await engine.step('visibility-results');
    await engine.approveExperiment('visibility-results');

    const resumed = await engine.resumeWithExperimentResults({
      runId: 'visibility-results',
      resultEvidence: visibilityEvidence({ artifactRef: '.local/visibility/results/2026-08-23.json' }),
    });

    expect(resumed).toMatchObject({
      stage: 'm2_metrics_results',
      status: 'ready_for_evaluation',
      evidenceSnapshots: { result: { product: 'marketplace_visibility', evidenceLevel: 'sparse' } },
    });
    expect(resumed.evidenceRefs).toContain(
      'result:marketplace_visibility:merchgrid_shopify_app_store:merchgrid:visibility:2026-08-22',
    );
  });

  it('rejects result evidence from a different marketplace visibility subject', async () => {
    const repository = new InMemoryRunRepository();
    const engine = createWorkflowEngine({ repository, modules: moduleExecutor(), now: fixedNow });
    await engine.startMarketplaceVisibility({
      runId: 'visibility-mismatched-results',
      subjectRef: 'marketplace_visibility:merchgrid_shopify_app_store:2026-08-22',
      initialEvidence: visibilityEvidence(),
    });
    for (let index = 0; index < 5; index += 1) await engine.step('visibility-mismatched-results');
    await engine.approveExperiment('visibility-mismatched-results');

    await expect(engine.resumeWithExperimentResults({
      runId: 'visibility-mismatched-results',
      resultEvidence: visibilityEvidence({
        profile: 'etsy_listing',
        subjectRef: 'etsy:visibility:listing-123',
        artifactRef: '.local/visibility/results/etsy-listing-123.json',
        marketplaceContext: {
          marketplace: 'etsy',
          productName: 'Weekly Planner',
          currentSurfaceSummary: 'Etsy listing for a printable weekly planner',
        },
      }),
    })).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Result marketplace visibility evidence must match the initial profile and subject',
    });
  });
});

class InMemoryRunRepository implements RunRepository {
  readonly created: WorkflowRunState[] = [];
  private readonly states = new Map<string, WorkflowRunState>();

  async create(state: WorkflowRunStateInput): Promise<void> {
    const parsed = normalize(state);
    this.states.set(parsed.runId, parsed);
    this.created.push(parsed);
  }

  async load(runId: string): Promise<WorkflowRunState> {
    const state = this.states.get(runId);
    if (!state) throw new Error(`Missing test run: ${runId}`);
    return structuredClone(state);
  }

  async save(state: WorkflowRunStateInput): Promise<void> {
    this.states.set(state.runId, normalize(state));
  }
}

function normalize(state: WorkflowRunStateInput): WorkflowRunState {
  return { ...state, moduleOutputs: { m3: [], ...state.moduleOutputs } } as WorkflowRunState;
}

function fixedNow(): Date {
  return new Date('2026-08-23T00:00:00.000Z');
}

function visibilityEvidence(overrides: Partial<MarketplaceVisibilityEvidence> = {}): MarketplaceVisibilityEvidence {
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
      currentSurfaceSummary: 'Shopify app listing for catalog audits',
    },
    measuredSignals: { request_count: 18 },
    limitations: ['Evidence is sparse'],
    prohibitedClaims: ['Do not claim the listing caused traffic'],
    ...overrides,
  };
}

function moduleExecutor(): ModuleExecutor {
  return {
    runM1: async () => ({ product: 'MerchGrid', availableEvidence: ['sparse visibility evidence'], missingInformation: [], notes: [] }),
    runM2Initial: async () => ({
      phase: 'initial', comparisonQuality: 'valid', unresolvedQualificationNeeds: [],
      metrics: [{ name: 'request_count', current: 18, baseline: 18, absoluteChange: 0, percentageChange: 0, qualification: 'stable', confidence: 'low' }],
    }),
    runM3: async () => ({ status: 'resolved', next_action: 'stop', requester: 'm4', question: 'unused', evidence: [], confidence: 'low', limitations: [] }),
    runM4: async () => ({ performancePath: 'discovery', primaryBottleneck: 'Sparse evidence', confidence: 'low', decision: 'proceed_to_hypothesis', notes: [] }),
    runM5: async () => ({ hypothesis: 'Clarifying the listing may improve discovery', primaryVariable: 'listing copy', recommendedRevision: 'Clarify the app value', keepConstant: [], expectedSignal: 'Request count increases', notes: [] }),
    runM6: async () => ({ primaryMetric: 'request_count', secondaryMetrics: [], baselineValue: 18, baselinePeriod: '2026-08-22', qualificationRequirements: [], expectedSupportingSignal: 'Request count increases', expectedWeakeningSignal: 'Request count decreases', inconclusiveCondition: 'No meaningful change', contextToMonitor: [], unresolvedMeasurementRules: [] }),
    runM2Results: async () => ({ phase: 'post_experiment', comparisonQuality: 'valid', unresolvedQualificationNeeds: [], metrics: [] }),
    runM7: async () => ({ outcome: 'inconclusive', hypothesisEvaluation: 'inconclusive', evidence: [], contextualFactors: [], learning: 'Sparse evidence remains', confidence: 'low', knowledgeSource: 'product_data', nextAction: 'wait', nextActionRationale: 'Sparse evidence remains' }),
  };
}
