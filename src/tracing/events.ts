import { randomUUID } from 'node:crypto';
import type { WorkflowEvent, WorkflowStage } from '../contracts/workflow.js';
import { assertNoCredentialKeys } from '../workflow/guards.js';

export type TraceContext = {
  runId: string;
  stage?: WorkflowStage;
  parentTraceId?: string;
};

export type TraceSink = {
  emit(event: WorkflowEvent): Promise<void> | void;
};

export function createWorkflowEvent(input: {
  runId: string;
  type: string;
  stage?: WorkflowStage;
  message: string;
  data?: Record<string, unknown>;
  now?: () => Date;
}): WorkflowEvent {
  const data = input.data ?? {};
  assertNoCredentialKeys(data);

  return {
    eventId: randomUUID(),
    runId: input.runId,
    type: input.type,
    stage: input.stage,
    message: input.message,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    data,
  };
}
