import { AppError } from '../../core/errors.js';
import type { MarketplaceVisibilityEvidence } from '../../contracts/marketplace-visibility.js';
import {
  DiagnosisOutputSchema,
  EvaluationOutputSchema,
  HypothesisOutputSchema,
  TestPlanOutputSchema,
  type ContextOutput,
  type MetricsOutput,
} from '../../contracts/modules.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';
import { runStructuredModule, type AgentRunner } from '../runner.js';
import type { ModuleExecutor } from '../../workflow/engine.js';

const VISIBILITY_DIAGNOSIS_PROMPT = [
  'M4 Marketplace Visibility Diagnosis.',
  'Use sparse evidence honestly. Identify one likely visibility bottleneck.',
  'Do not claim proof. Choose proceed_to_hypothesis only for a manual exploratory test.',
].join('\n');

const VISIBILITY_HYPOTHESIS_PROMPT = [
  'M5 Marketplace Visibility Hypothesis.',
  'Use sparse evidence honestly. Propose one manual, exploratory listing revision.',
  'Do not claim the revision will improve marketplace outcomes.',
].join('\n');

const VISIBILITY_TEST_PLAN_PROMPT = [
  'M6 Marketplace Visibility Test Plan.',
  'Use sparse evidence honestly. Define a manual exploratory test and its later measurement needs.',
  'The output is a manual test plan. It must not claim the system will edit an external marketplace.',
].join('\n');

const VISIBILITY_EVALUATION_PROMPT = [
  'M7 Marketplace Visibility Evaluation.',
  'Use sparse evidence honestly. Classify learning only from qualified later evidence.',
  'Do not claim proof of a marketplace visibility outcome.',
].join('\n');

/** Builds a provider-free executor for sparse marketplace-visibility reviews. */
export function createMarketplaceVisibilityModuleExecutor(deps: { agentRunner: AgentRunner }): ModuleExecutor {
  return {
    async runM1(state) {
      return deterministicMarketplaceVisibilityContext(requireInitialEvidence(state));
    },
    async runM2Initial(state) {
      return metricsFromMarketplaceVisibilityEvidence(requireInitialEvidence(state));
    },
    async runM3() {
      throw new AppError('route_not_allowed', 'Marketplace visibility reviews do not run external research');
    },
    async runM4(state) {
      const result = await runStructuredModule({
        runner: deps.agentRunner,
        moduleId: 'm4',
        modulePrompt: VISIBILITY_DIAGNOSIS_PROMPT,
        input: state,
        outputSchema: DiagnosisOutputSchema,
        trace: trace(state),
      });
      return result.output;
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
      return result.output;
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
      return result.output;
    },
    async runM2Results(state) {
      return metricsFromMarketplaceVisibilityEvidence(requireResultEvidence(state));
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
      return result.output;
    },
  };
}

export function deterministicMarketplaceVisibilityContext(evidence: MarketplaceVisibilityEvidence): ContextOutput {
  return {
    product: evidence.marketplaceContext.productName,
    likelyCustomer: evidence.marketplaceContext.targetAudience,
    positioning: `${marketplaceName(evidence.marketplaceContext.marketplace)} visibility review: ${evidence.marketplaceContext.currentSurfaceSummary}`,
    availableEvidence: [
      `profile: ${evidence.profile}`,
      `evidence level: ${evidence.evidenceLevel}`,
      `artifact: ${evidence.artifactRef}`,
    ],
    missingInformation: evidence.limitations,
    notes: evidence.prohibitedClaims,
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

function marketplaceName(marketplace: MarketplaceVisibilityEvidence['marketplaceContext']['marketplace']): string {
  return marketplace === 'shopify_app_store' ? 'Shopify App Store' : 'Etsy';
}

function trace(state: WorkflowRunState) {
  return { runId: state.runId, stage: state.stage };
}
