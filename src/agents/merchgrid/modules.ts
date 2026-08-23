import { AppError } from '../../core/errors.js';
import type { MerchGridWorkflowEvidence } from '../../contracts/merchgrid-workflow.js';
import {
  ResearchOutputSchema,
  type ContextOutput,
  type MetricsOutput,
  type ResearchOutput,
} from '../../contracts/modules.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';
import { runDiagnosisModule } from '../diagnosis/agent.js';
import { runEvaluationModule } from '../evaluation/agent.js';
import { runHypothesisModule } from '../hypothesis/agent.js';
import { M3_PROMPT } from '../research/agent.js';
import { runStructuredModule, type AgentRunner } from '../runner.js';
import { runTestDefinitionModule } from '../test-definition/agent.js';
import type { ModuleExecutor, ResearchRequest } from '../../workflow/engine.js';
import { evaluateWeeklyReadiness } from '../../workflow/merchgrid-readiness.js';

/** Builds a provider-free module executor from only persisted workflow evidence and an agent runner. */
export function createMerchGridModuleExecutor(deps: { agentRunner: AgentRunner }): ModuleExecutor {
  return {
    async runM1(state) {
      const evidence = requireMerchGridInitialEvidence(state);
      return deterministicMerchGridContext(evidence);
    },
    async runM2Initial(state) {
      const evidence = requireMerchGridInitialEvidence(state);
      return metricsFromMerchGridEvidence(evidence);
    },
    async runM3(state, request) {
      return runMerchGridResearchModule(deps.agentRunner, state, request);
    },
    async runM4(state) {
      return runDiagnosisModule(deps.agentRunner, state, trace(state));
    },
    async runM5(state) {
      return runHypothesisModule(deps.agentRunner, state, trace(state));
    },
    async runM6(state) {
      return runTestDefinitionModule(deps.agentRunner, state, trace(state));
    },
    async runM2Results(state) {
      return metricsFromMerchGridResult(state, requireMerchGridResultEvidence(state));
    },
    async runM7(state) {
      return runEvaluationModule(deps.agentRunner, state, trace(state));
    },
  };
}

export function deterministicMerchGridContext(evidence: MerchGridWorkflowEvidence): ContextOutput {
  const period = evidence.kind === 'daily_health'
    ? `daily health for ${evidence.observedPeriod.date}`
    : `weekly review from ${evidence.observedPeriod.previous.startDate} through ${evidence.observedPeriod.current.endDate}`;

  return {
    product: 'MerchGrid',
    positioning: `Operational review based on saved ${period}`,
    availableEvidence: [period, `artifact: ${evidence.artifactRef}`],
    missingInformation: evidence.limitations,
    notes: [],
  };
}

export function metricsFromMerchGridEvidence(evidence: MerchGridWorkflowEvidence): MetricsOutput {
  if (evidence.kind === 'weekly_review') {
    return evaluateWeeklyReadiness(evidence).metrics;
  }

  const requests = evidence.aggregateMetrics.fly_metrics?.request_count;
  const errors = evidence.aggregateMetrics.fly_metrics?.error_response_count;
  const errorRate = requests && errors !== undefined ? errors / requests : null;
  return {
    phase: 'initial',
    metrics: [
      {
        name: 'fly_metrics.error_rate',
        current: errorRate,
        baseline: null,
        absoluteChange: null,
        percentageChange: null,
        qualification: errorRate === null ? 'not_available' : 'inconclusive',
        confidence: errorRate === null ? 'low' : 'high',
      },
    ],
    comparisonQuality: errorRate === null ? 'missing' : 'limited',
    unresolvedQualificationNeeds: errorRate === null
      ? ['daily reliability investigation requires Fly request and error counts']
      : ['daily reliability investigation has no prior-week comparison baseline'],
  };
}

/** Compares later saved weekly evidence against the primary metric and frozen baseline in M6. */
export function metricsFromMerchGridResult(
  state: WorkflowRunState,
  evidence: MerchGridWorkflowEvidence,
): MetricsOutput {
  const plan = state.moduleOutputs.m6;
  if (!plan || evidence.kind !== 'weekly_review') {
    return missingResultMetrics('weekly result evidence requires a frozen M6 plan and a weekly artifact');
  }

  const current = readWeeklyMetric(evidence, plan.primaryMetric);
  if (current === undefined) {
    return missingResultMetrics(`weekly result does not qualify ${plan.primaryMetric}`);
  }
  if (!isLaterWeeklyPeriod(evidence.observedPeriod.current.startDate, plan.baselinePeriod)) {
    return missingResultMetrics('weekly result period must begin after the frozen M6 baseline period');
  }

  const absoluteChange = current - plan.baselineValue;
  return {
    phase: 'post_experiment',
    metrics: [{
      name: plan.primaryMetric,
      baseline: plan.baselineValue,
      current,
      absoluteChange,
      percentageChange: plan.baselineValue === 0 ? null : absoluteChange / plan.baselineValue,
      qualification: absoluteChange === 0 ? 'stable' : absoluteChange > 0 ? 'improved' : 'declined',
      confidence: 'high',
    }],
    comparisonQuality: 'valid',
    unresolvedQualificationNeeds: [],
  };
}

function requireMerchGridInitialEvidence(state: WorkflowRunState): MerchGridWorkflowEvidence {
  const evidence = state.evidenceSnapshots?.initial;
  if (!evidence || evidence.product !== 'merchgrid') {
    throw new AppError('validation_failed', 'MerchGrid module requires persisted MerchGrid initial evidence');
  }
  return evidence;
}

function requireMerchGridResultEvidence(state: WorkflowRunState): MerchGridWorkflowEvidence {
  const evidence = state.evidenceSnapshots?.result;
  if (!evidence || evidence.product !== 'merchgrid') {
    throw new AppError('validation_failed', 'MerchGrid result metrics require persisted MerchGrid result evidence');
  }
  return evidence;
}

function readWeeklyMetric(
  evidence: Extract<MerchGridWorkflowEvidence, { kind: 'weekly_review' }>,
  name: string,
): number | undefined {
  const [source, metric, ...rest] = name.split('.');
  if (rest.length > 0 || !source || !metric) return undefined;
  if (evidence.sourceCoverage.current[source as keyof typeof evidence.sourceCoverage.current]?.complete !== 7) {
    return undefined;
  }
  const values = evidence.aggregateMetrics.current[source as keyof typeof evidence.aggregateMetrics.current];
  if (!values || !(metric in values)) return undefined;
  const value = values[metric as keyof typeof values];
  return typeof value === 'number' ? value : undefined;
}

function isLaterWeeklyPeriod(currentStartDate: string, baselinePeriod: string): boolean {
  const baselineEnd = baselinePeriod.split('..')[1];
  return baselineEnd !== undefined && currentStartDate > baselineEnd;
}

function missingResultMetrics(reason: string): MetricsOutput {
  return {
    phase: 'post_experiment',
    metrics: [],
    comparisonQuality: 'missing',
    unresolvedQualificationNeeds: [reason],
  };
}

async function runMerchGridResearchModule(
  runner: AgentRunner,
  state: WorkflowRunState,
  request: ResearchRequest,
): Promise<ResearchOutput> {
  const result = await runStructuredModule({
    runner,
    moduleId: 'm3',
    modulePrompt: M3_PROMPT,
    input: { state, request },
    outputSchema: ResearchOutputSchema,
    trace: trace(state),
  });
  return ResearchOutputSchema.parse(result.output);
}

function trace(state: WorkflowRunState) {
  return { runId: state.runId, stage: state.stage };
}
