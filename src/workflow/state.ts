import type { WorkflowEvent, WorkflowRunState, WorkflowRunStateInput } from '../contracts/workflow.js';

export function createInitialWorkflowState(input: {
  runId: string;
  listingId: string;
  initialEvidenceRef: string;
  now: Date;
}): WorkflowRunStateInput {
  const createdAt = input.now.toISOString();
  const state: WorkflowRunStateInput = {
    runId: input.runId,
    listingId: input.listingId,
    status: 'analyzing',
    stage: 'm1_context',
    createdAt,
    updatedAt: createdAt,
    evidenceRefs: [input.initialEvidenceRef],
    moduleOutputs: { m3: [] },
    events: [],
  };

  return appendEvent(state, {
    type: 'workflow.started',
    message: 'Workflow run started',
    stage: 'm1_context',
    data: { initialEvidenceRef: input.initialEvidenceRef },
    now: input.now,
  });
}

export function appendEvent(
  state: WorkflowRunStateInput,
  input: {
    type: string;
    message: string;
    stage?: WorkflowEvent['stage'];
    data?: Record<string, unknown>;
    now: Date;
  },
): WorkflowRunStateInput {
  const event: WorkflowEvent = {
    eventId: `event-${state.events.length + 1}`,
    runId: state.runId,
    type: input.type,
    stage: input.stage,
    message: input.message,
    createdAt: input.now.toISOString(),
    data: input.data ?? {},
  };

  return {
    ...state,
    updatedAt: input.now.toISOString(),
    events: [...state.events, event],
  };
}

export function evidenceRef(kind: 'initial' | 'result', input: { listingId: string; observedAt: string }): string {
  return `${kind}:${input.listingId}:${input.observedAt}`;
}

export function toWorkflowRunStateInput(state: WorkflowRunState): WorkflowRunStateInput {
  return {
    ...state,
    moduleOutputs: {
      ...state.moduleOutputs,
      m3: [...state.moduleOutputs.m3],
    },
    events: [...state.events],
    evidenceRefs: [...state.evidenceRefs],
  };
}
