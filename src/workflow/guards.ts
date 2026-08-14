import { AppError } from '../core/errors.js';
import type { WorkflowRunState, WorkflowStage } from '../contracts/workflow.js';

const CREDENTIAL_KEY_PATTERN = /api[_-]?key|secret|token|refresh/i;

export function assertNoCredentialKeys(value: unknown): void {
  visitObjectKeys(value, (key) => {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new AppError('validation_failed', `Credential-like key is not allowed in workflow data: ${key}`);
    }
  });
}

export function canRunStage(state: WorkflowRunState, stage: WorkflowStage): boolean {
  try {
    assertCanRunStage(state, stage);
    return true;
  } catch (error) {
    if (error instanceof AppError) {
      return false;
    }
    throw error;
  }
}

export function assertCanRunStage(state: WorkflowRunState, stage: WorkflowStage): void {
  assertNoCredentialKeys(state);

  switch (stage) {
    case 'm1_context':
      return;
    case 'm2_metrics_initial':
      if (!state.moduleOutputs.m1) {
        throw routeError('Cannot run m2_metrics_initial before M1 context is present');
      }
      return;
    case 'm4_diagnosis':
      if (!state.moduleOutputs.m1 || !state.moduleOutputs.m2Initial) {
        throw routeError('Cannot run m4_diagnosis before M1 context and M2 initial metrics are present');
      }
      return;
    case 'm5_hypothesis':
      if (state.moduleOutputs.m4?.decision !== 'proceed_to_hypothesis') {
        throw routeError('Cannot run m5_hypothesis unless M4 decided to proceed to hypothesis');
      }
      return;
    case 'm6_test_plan':
      if (!state.moduleOutputs.m5) {
        throw routeError('Cannot run m6_test_plan before M5 hypothesis is present');
      }
      return;
    case 'experiment_wait':
      if (!state.moduleOutputs.m6) {
        throw routeError('Cannot enter experiment_wait before M6 test plan is present');
      }
      return;
    case 'm2_metrics_results':
      if (!state.moduleOutputs.m6 || !hasResultEvidence(state)) {
        throw routeError('Cannot run m2_metrics_results before an experiment plan and result evidence are present');
      }
      return;
    case 'm7_learning':
      if (!state.moduleOutputs.m2Results) {
        throw routeError('Cannot run m7_learning before M2 results are present');
      }
      return;
    case 'm3_research':
    case 'cycle_complete':
      return;
  }
}

function hasResultEvidence(state: WorkflowRunState): boolean {
  return state.evidenceRefs.some((ref) => ref.startsWith('result:'));
}

function routeError(message: string): AppError {
  return new AppError('route_not_allowed', message);
}

function visitObjectKeys(value: unknown, visitor: (key: string) => void): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visitObjectKeys(item, visitor);
    }
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visitor(key);
    visitObjectKeys(child, visitor);
  }
}
