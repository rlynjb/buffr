import { describe, expect, it } from 'vitest';
import { AppError } from '../../core/errors.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';
import { assertCanRunStage, assertNoCredentialKeys, canRunStage } from '../../workflow/guards.js';

describe('workflow guards', () => {
  it('refuses to advance to M4 without M1 and M2 initial outputs', () => {
    const state = workflowState({ stage: 'm4_diagnosis' });

    expect(canRunStage(state, 'm4_diagnosis')).toBe(false);
    expect(() => assertCanRunStage(state, 'm4_diagnosis')).toThrow(AppError);
    expect(() => assertCanRunStage(state, 'm4_diagnosis')).toThrow(
      'Cannot run m4_diagnosis before M1 context and M2 initial metrics are present',
    );
  });

  it('refuses to run M5 unless M4 decided to proceed', () => {
    const state = workflowState({
      stage: 'm5_hypothesis',
      moduleOutputs: {
        m3: [],
        m4: {
          performancePath: 'insufficient_data',
          primaryBottleneck: 'Not enough data',
          confidence: 'low',
          decision: 'collect_more_data',
          notes: [],
        },
      },
    });

    expect(canRunStage(state, 'm5_hypothesis')).toBe(false);
    expect(() => assertCanRunStage(state, 'm5_hypothesis')).toThrow(
      'Cannot run m5_hypothesis unless M4 decided to proceed to hypothesis',
    );
  });

  it('refuses to enter M2 results unless an experiment plan and result evidence exist', () => {
    const state = workflowState({
      stage: 'm2_metrics_results',
      moduleOutputs: { m3: [] },
      evidenceRefs: ['initial:listing-123'],
    });

    expect(canRunStage(state, 'm2_metrics_results')).toBe(false);
    expect(() => assertCanRunStage(state, 'm2_metrics_results')).toThrow(
      'Cannot run m2_metrics_results before an experiment plan and result evidence are present',
    );
  });

  it('rejects credential-like keys anywhere in state or evidence objects', () => {
    expect(() =>
      assertNoCredentialKeys({
        listingId: 'listing-123',
        nested: { refreshToken: 'not-allowed' },
      }),
    ).toThrow('Credential-like key is not allowed in workflow data: refreshToken');

    expect(() => assertNoCredentialKeys({ listingId: 'listing-123', stats: { views: 1 } })).not.toThrow();
  });
});

function workflowState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: 'run-123',
    listingId: 'listing-123',
    status: 'analyzing',
    stage: 'm1_context',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    evidenceRefs: [],
    moduleOutputs: { m3: [] },
    events: [],
    ...overrides,
  };
}
