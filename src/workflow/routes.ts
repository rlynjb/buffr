import type {
  DiagnosisOutput,
  EvaluationOutput,
  HypothesisOutput,
  MetricsOutput,
  ModuleId,
  TestPlanOutput,
} from '../contracts/modules.js';
import type { WorkflowStage } from '../contracts/workflow.js';

export type ResearchRequester = Extract<ModuleId, 'm2' | 'm4' | 'm5' | 'm6' | 'm7'>;

export type RouteDecision =
  | { type: 'advance'; nextStage: WorkflowStage }
  | { type: 'research'; requester: ResearchRequester; returnStage: WorkflowStage; question: string }
  | { type: 'wait'; reason: string; nextStage?: WorkflowStage }
  | { type: 'stop'; reason: string }
  | { type: 'complete'; reason: string };

export function routeAfterM2Initial(output: MetricsOutput): RouteDecision {
  if (output.researchNeed) {
    return {
      type: 'research',
      requester: 'm2',
      returnStage: 'm2_metrics_initial',
      question: output.researchNeed,
    };
  }

  if (output.comparisonQuality === 'missing' || output.metrics.every(isMetricNotAvailable)) {
    return { type: 'wait', reason: 'metrics evidence is missing' };
  }

  return { type: 'advance', nextStage: 'm4_diagnosis' };
}

export function routeAfterM4(output: DiagnosisOutput): RouteDecision {
  if (output.decision === 'proceed_to_hypothesis') {
    return { type: 'advance', nextStage: 'm5_hypothesis' };
  }

  if (output.decision === 'research_domain_knowledge') {
    return {
      type: 'research',
      requester: 'm4',
      returnStage: 'm4_diagnosis',
      question: output.researchQuestion ?? 'Research domain knowledge for diagnosis',
    };
  }

  return { type: 'wait', reason: 'diagnosis requires more data' };
}

export function routeAfterM5(output: HypothesisOutput): RouteDecision {
  if (output.researchNeed) {
    return {
      type: 'research',
      requester: 'm5',
      returnStage: 'm5_hypothesis',
      question: output.researchNeed,
    };
  }

  return { type: 'advance', nextStage: 'm6_test_plan' };
}

export function routeAfterM6(output: TestPlanOutput): RouteDecision {
  if (output.researchNeed) {
    return {
      type: 'research',
      requester: 'm6',
      returnStage: 'm6_test_plan',
      question: output.researchNeed,
    };
  }

  if (output.unresolvedMeasurementRules.length > 0) {
    return {
      type: 'research',
      requester: 'm6',
      returnStage: 'm6_test_plan',
      question: 'Resolve experiment measurement rules',
    };
  }

  return {
    type: 'wait',
    reason: 'experiment plan ready for manual execution',
    nextStage: 'experiment_wait',
  };
}

export function routeAfterM2Results(output: MetricsOutput): RouteDecision {
  if (output.researchNeed) {
    return {
      type: 'research',
      requester: 'm2',
      returnStage: 'm2_metrics_results',
      question: output.researchNeed,
    };
  }

  return { type: 'advance', nextStage: 'm7_learning' };
}

export function routeAfterM7(output: EvaluationOutput): RouteDecision {
  if (output.nextAction === 'research') {
    return {
      type: 'research',
      requester: 'm7',
      returnStage: 'm7_learning',
      question: output.researchQuestion ?? output.nextActionRationale,
    };
  }

  if (output.nextAction === 'wait') {
    return { type: 'complete', reason: 'learning complete; wait before another cycle' };
  }

  return { type: 'complete', reason: 'learning complete' };
}

function isMetricNotAvailable(metric: MetricsOutput['metrics'][number]): boolean {
  return metric.qualification === 'not_available';
}
