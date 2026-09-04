import { AppError } from '../../core/errors.js';
import type { MarketplaceVisibilityEvidence } from '../../contracts/marketplace-visibility.js';
import {
  DiagnosisOutputSchema,
  EvaluationOutputSchema,
  HypothesisOutputSchema,
  ResearchOutputSchema,
  TestPlanOutputSchema,
  type ContextOutput,
  type DiagnosisOutput,
  type EvaluationOutput,
  type HypothesisOutput,
  type MetricsOutput,
  type ResearchOutput,
  type TestPlanOutput,
} from '../../contracts/modules.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';
import { runStructuredModule, type AgentRunner } from '../runner.js';
import { runResearchModule, type ResearchTool } from '../research/agent.js';
import type { MarketplaceResearchConfig } from '../research/marketplace-config.js';
import type { ModuleExecutor, ResearchRequest } from '../../workflow/engine.js';

const VISIBILITY_DIAGNOSIS_PROMPT = [
  'M4 Marketplace Visibility Diagnosis.',
  'Use sparse evidence honestly. Do not claim proof.',
  'If reviewMode.mode is exploratory_visibility_test, sparse or zero metrics alone are not a reason to stop.',
  'Use product context, marketplace context, and listing context to identify one likely visibility bottleneck hypothesis.',
  'Listing observations are qualitative evidence only.',
  'Choose proceed_to_hypothesis for one manual exploratory test unless the product or listing context is contradictory or unsafe.',
].join('\n');

const VISIBILITY_HYPOTHESIS_PROMPT = [
  'M5 Marketplace Visibility Hypothesis.',
  'Use sparse evidence honestly. Propose one manual, exploratory listing revision.',
  'The hypothesis may use listing copy or visual context, but must not claim the revision will improve marketplace outcomes.',
].join('\n');

const VISIBILITY_TEST_PLAN_PROMPT = [
  'M6 Marketplace Visibility Test Plan.',
  'Use sparse evidence honestly. Define a manual exploratory test and its later measurement needs.',
  'The output is a manual test plan. It must not claim the system will edit an external marketplace.',
  'Change one listing element at a time so the result remains interpretable.',
].join('\n');

const VISIBILITY_EVALUATION_PROMPT = [
  'M7 Marketplace Visibility Evaluation.',
  'Use sparse evidence honestly. Classify learning only from qualified later evidence.',
  'Do not claim proof of a marketplace visibility outcome.',
].join('\n');

type MarketplaceVisibilityModuleDependencies = {
  agentRunner: AgentRunner;
  research?: {
    config: MarketplaceResearchConfig;
    tool?: ResearchTool;
    now?: () => number;
  };
};

/** Builds the marketplace executor with an optional read-only M3 research seam. */
export function createMarketplaceVisibilityModuleExecutor(
  deps: MarketplaceVisibilityModuleDependencies,
): ModuleExecutor {
  const researchEnabled = deps.research?.config.enabled ?? false;
  if (researchEnabled && !deps.research?.tool) {
    throw new AppError('configuration_failed', 'Enabled marketplace research requires a hosted web-search tool');
  }

  return {
    async runM1(state) {
      return deterministicMarketplaceVisibilityContext(requireInitialEvidence(state));
    },
    async runM2Initial(state) {
      return metricsFromMarketplaceVisibilityEvidence(requireInitialEvidence(state));
    },
    async runM3(state, request) {
      if (!researchEnabled || !deps.research?.tool) return unavailableResearchResult(request);
      return runResearchModule({
        runner: deps.agentRunner,
        tools: [deps.research.tool],
        request: {
          requester: request.requester,
          question: request.question,
          reason: 'Marketplace visibility research request',
        },
        limits: deps.research.config.limits,
        now: deps.research.now,
        trace: trace(state),
      });
    },
    async runM4(state) {
      const evidence = requireInitialEvidence(state);
      const result = await runStructuredModule({
        runner: deps.agentRunner,
        moduleId: 'm4',
        modulePrompt: VISIBILITY_DIAGNOSIS_PROMPT,
        input: state,
        outputSchema: DiagnosisOutputSchema,
        trace: trace(state),
      });
      return normalizeDiagnosis(result.output, evidence, researchEnabled);
    },
    async runM5(state) {
      const result = await runStructuredModule({
        runner: deps.agentRunner,
        moduleId: 'm5',
        modulePrompt: VISIBILITY_HYPOTHESIS_PROMPT,
        input: state,
        outputSchema: HypothesisOutputSchema,
        trace: trace(state),
      });
      return normalizeHypothesis(result.output, researchEnabled);
    },
    async runM6(state) {
      const result = await runStructuredModule({
        runner: deps.agentRunner,
        moduleId: 'm6',
        modulePrompt: VISIBILITY_TEST_PLAN_PROMPT,
        input: state,
        outputSchema: TestPlanOutputSchema,
        trace: trace(state),
      });
      return normalizeTestPlan(result.output, researchEnabled);
    },
    async runM2Results(state) {
      return metricsFromMarketplaceVisibilityResult(state, requireResultEvidence(state));
    },
    async runM7(state) {
      const result = await runStructuredModule({
        runner: deps.agentRunner,
        moduleId: 'm7',
        modulePrompt: VISIBILITY_EVALUATION_PROMPT,
        input: state,
        outputSchema: EvaluationOutputSchema,
        trace: trace(state),
      });
      return normalizeEvaluation(result.output, researchEnabled);
    },
  };
}

export function deterministicMarketplaceVisibilityContext(evidence: MarketplaceVisibilityEvidence): ContextOutput {
  const listing = evidence.listingContext;
  return {
    product: evidence.marketplaceContext.productName,
    likelyCustomer: evidence.marketplaceContext.targetCustomer,
    positioning: `${marketplaceName(evidence.marketplaceContext.marketplace)} visibility review: ${evidence.marketplaceContext.currentSurfaceSummary}`,
    availableEvidence: [
      `profile: ${evidence.profile}`,
      `evidence level: ${evidence.evidenceLevel}`,
      `artifact: ${evidence.artifactRef}`,
      ...(listing ? [
        `listing url: ${listing.sourceUrl}`,
        ...(listing.publicSurface.headline ? [`listing headline: ${listing.publicSurface.headline}`] : []),
        ...(listing.publicSurface.category ? [`listing category: ${listing.publicSurface.category}`] : []),
        `listing gallery images: ${listing.gallery.imageCount}`,
        ...listing.copyNotes.clearClaims.map((claim) => `listing clear claim: ${claim}`),
      ] : ['listing context: unavailable']),
    ],
    missingInformation: [
      ...evidence.limitations,
      ...(listing ? [
        ...listing.trustSignals.friction.map((item) => `listing friction: ${item}`),
        ...listing.copyNotes.unclearClaims.map((item) => `listing unclear claim: ${item}`),
        ...listing.copyNotes.missingContext.map((item) => `listing missing context: ${item}`),
        ...listing.limitations.map((item) => `listing limitation: ${item}`),
      ] : ['listing context unavailable']),
    ],
    notes: [
      ...evidence.prohibitedClaims,
      ...(listing ? [
        'Listing observations are qualitative context, not conversion proof.',
        `listing captured at: ${listing.capturedAt}`,
        `promise clarity: ${listing.visibilityRubricNotes.promiseClarity}`,
        `trust and risk reduction: ${listing.visibilityRubricNotes.trustAndRiskReduction}`,
      ] : []),
    ],
  };
}

export function metricsFromMarketplaceVisibilityEvidence(evidence: MarketplaceVisibilityEvidence): MetricsOutput {
  return {
    phase: 'initial',
    comparisonQuality: 'limited',
    metrics: [
      {
        name: 'visibility.evidence_level',
        current: 1,
        baseline: null,
        absoluteChange: null,
        percentageChange: null,
        qualification: 'inconclusive',
        confidence: 'low',
      },
      ...Object.entries(evidence.measuredSignals).sort(([left], [right]) => left.localeCompare(right)).map(([name, current]) => ({
        name,
        current,
        baseline: null,
        absoluteChange: null,
        percentageChange: null,
        qualification: 'inconclusive' as const,
        confidence: 'low' as const,
      })),
    ],
    unresolvedQualificationNeeds: [
      'measured marketplace traffic is sparse',
      ...evidence.limitations,
    ],
  };
}

export function metricsFromMarketplaceVisibilityResult(
  state: WorkflowRunState,
  evidence: MarketplaceVisibilityEvidence,
): MetricsOutput {
  const plan = state.moduleOutputs.m6;
  if (!plan) return missingVisibilityResult('visibility result requires an approved M6 plan');

  const current = evidence.measuredSignals[plan.primaryMetric];
  if (current === undefined) return missingVisibilityResult(`visibility result does not contain ${plan.primaryMetric}`);

  const absoluteChange = current - plan.baselineValue;
  return {
    phase: 'post_experiment',
    metrics: [{
      name: plan.primaryMetric,
      baseline: plan.baselineValue,
      current,
      absoluteChange,
      percentageChange: plan.baselineValue === 0 ? null : absoluteChange / plan.baselineValue,
      qualification: current === plan.baselineValue ? 'stable' : current > plan.baselineValue ? 'improved' : 'declined',
      confidence: 'low',
    }],
    comparisonQuality: 'limited',
    unresolvedQualificationNeeds: ['visibility result remains sparse and exploratory'],
  };
}

function requireInitialEvidence(state: WorkflowRunState): MarketplaceVisibilityEvidence {
  const evidence = state.evidenceSnapshots?.initial;
  if (!evidence || evidence.product !== 'marketplace_visibility') {
    throw new AppError('validation_failed', 'Marketplace visibility module requires persisted initial visibility evidence');
  }
  return evidence;
}

function requireResultEvidence(state: WorkflowRunState): MarketplaceVisibilityEvidence {
  const evidence = state.evidenceSnapshots?.result;
  if (!evidence || evidence.product !== 'marketplace_visibility') {
    throw new AppError('validation_failed', 'Marketplace visibility result metrics require persisted result visibility evidence');
  }
  return evidence;
}

function missingVisibilityResult(reason: string): MetricsOutput {
  return {
    phase: 'post_experiment',
    metrics: [],
    comparisonQuality: 'missing',
    unresolvedQualificationNeeds: [reason],
  };
}

function marketplaceName(marketplace: MarketplaceVisibilityEvidence['marketplaceContext']['marketplace']): string {
  return marketplace === 'shopify_app_store' ? 'Shopify App Store' : 'Etsy';
}

function trace(state: WorkflowRunState) {
  return { runId: state.runId, stage: state.stage };
}

function normalizeDiagnosis(
  output: DiagnosisOutput,
  evidence: MarketplaceVisibilityEvidence,
  researchEnabled: boolean,
): DiagnosisOutput {
  if (
    evidence.reviewMode.mode === 'exploratory_visibility_test'
    && output.decision === 'collect_more_data'
  ) {
    return {
      ...output,
      performancePath: 'discovery',
      decision: 'proceed_to_hypothesis',
      notes: [
        ...output.notes,
        'Sparse metrics do not block a human-approved exploratory visibility test.',
        'Recommendation remains low-confidence and not metric-proven.',
      ],
    };
  }
  if (output.decision !== 'research_domain_knowledge' || researchEnabled) return output;
  const { researchQuestion: _researchQuestion, ...withoutResearchQuestion } = output;
  return { ...withoutResearchQuestion, decision: 'collect_more_data' };
}

function normalizeHypothesis(output: HypothesisOutput, researchEnabled: boolean): HypothesisOutput {
  const { researchNeed, ...withoutResearchNeed } = output;
  return {
    ...withoutResearchNeed,
    ...(researchEnabled && researchNeed ? { researchNeed } : {}),
    notes: uniqueStrings([
      ...withoutResearchNeed.notes,
      'Exploratory recommendation; not metric-proven.',
      'Human approval required before changing any marketplace surface.',
    ]),
  };
}

function normalizeTestPlan(output: TestPlanOutput, researchEnabled: boolean): TestPlanOutput {
  const { researchNeed, ...withoutResearchNeed } = output;
  return {
    ...withoutResearchNeed,
    ...(researchEnabled && researchNeed ? { researchNeed } : {}),
    qualificationRequirements: uniqueStrings([
      ...withoutResearchNeed.qualificationRequirements,
      'Human approval and manual marketplace edit are required before measurement.',
      'Later evidence must be compared as exploratory and low confidence.',
    ]),
    contextToMonitor: uniqueStrings([
      ...withoutResearchNeed.contextToMonitor,
      'manual marketplace change applied by owner',
    ]),
    unresolvedMeasurementRules: researchEnabled ? output.unresolvedMeasurementRules : [],
  };
}

function normalizeEvaluation(output: EvaluationOutput, researchEnabled: boolean): EvaluationOutput {
  if (output.nextAction !== 'research' || researchEnabled) return output;
  const { researchQuestion: _researchQuestion, ...withoutResearchQuestion } = output;
  return { ...withoutResearchQuestion, nextAction: 'wait' };
}

function unavailableResearchResult(request: ResearchRequest): ResearchOutput {
  return ResearchOutputSchema.parse({
    status: 'unresolved',
    next_action: 'stop',
    requester: request.requester,
    question: request.question,
    evidence: [],
    confidence: 'low',
    limitations: ['External research is disabled for marketplace visibility reviews.'],
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
