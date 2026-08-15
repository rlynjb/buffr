import { describe, expect, it } from 'vitest';
import { AppError } from '../../core/errors.js';
import { parseWithSchema, type WorkflowRunState } from '../../contracts/workflow.js';
import {
  FakeAgentRunner,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunner,
} from '../../agents/runner.js';
import { runContextModule } from '../../agents/context/agent.js';

describe('M1 context module wrapper', () => {
  it('runs M1 with shared policy, role prompt, schema validation, and sanitized input', async () => {
    const runner = new RecordingRunner({
      product: 'Printable Weekly Planner',
      likelyCustomer: 'Busy planner buyer',
      positioning: 'Printable planning download',
      availableEvidence: ['Listing title and tags are present'],
      missingInformation: [],
      notes: ['No diagnosis in M1'],
    });

    const output = await runContextModule(runner, stateWithCredentialLikeEvent(), {
      runId: 'run-123',
      stage: 'm1_context',
    });

    expect(output).toMatchObject({
      product: 'Printable Weekly Planner',
      availableEvidence: ['Listing title and tags are present'],
    });
    expect(runner.lastInput).toMatchObject({
      moduleId: 'm1',
      trace: { runId: 'run-123', stage: 'm1_context' },
    });
    expect(runner.lastInput?.instructions).toContain('Shared M0 policy:');
    expect(runner.lastInput?.instructions).toContain('M1 Context: organize product context');
    expect(JSON.stringify(runner.lastInput?.input)).not.toMatch(/apiKey|refreshToken|secret-value/);
  });

  it('rejects malformed M1 output through the shared schema path', async () => {
    const runner = new FakeAgentRunner({
      m1: { product: '', availableEvidence: [], missingInformation: [], notes: [] },
    });

    await expect(
      runContextModule(runner, stateWithCredentialLikeEvent(), { runId: 'run-123', stage: 'm1_context' }),
    ).rejects.toMatchObject({
      name: 'AppError',
      code: 'validation_failed',
      message: 'm1 output failed validation',
    } satisfies Partial<AppError>);
  });
});

class RecordingRunner implements AgentRunner {
  lastInput?: AgentRunInput<unknown>;

  constructor(private readonly output: unknown) {}

  async runStructured<TOutput>(input: AgentRunInput<TOutput>): Promise<AgentRunResult<TOutput>> {
    this.lastInput = input as AgentRunInput<unknown>;

    return {
      output: parseWithSchema(input.outputSchema, this.output, `${input.moduleId} output`) as TOutput,
    };
  }
}

function stateWithCredentialLikeEvent(): WorkflowRunState {
  return {
    runId: 'run-123',
    listingId: 'listing-123',
    status: 'analyzing',
    stage: 'm1_context',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    evidenceRefs: ['initial:listing-123:2026-08-12T00:00:00.000Z'],
    moduleOutputs: { m3: [] },
    events: [
      {
        eventId: 'event-1',
        runId: 'run-123',
        type: 'workflow.started',
        stage: 'm1_context',
        message: 'Workflow started',
        createdAt: '2026-08-12T00:00:00.000Z',
        data: { apiKey: 'secret-value', refreshToken: 'secret-value' },
      },
    ],
  };
}
