import { describe, expect, it } from 'vitest';
import type {
  ExperimentApplication,
  MarketplaceProductIdentity,
  MarketplaceVisibilityEvidence,
} from '../../contracts/marketplace-visibility.js';
import type {
  WorkflowEvent,
  WorkflowRunState,
  WorkflowRunStateInput,
  WorkflowStage,
  WorkflowStatus,
} from '../../contracts/workflow.js';
import { AppError } from '../../core/errors.js';
import type { MarketplaceRunHistoryRepository } from '../../storage/runs.js';
import {
  createMarketplaceRollingReviewService,
  rollingVisibilityRunId,
  type MarketplaceRollingReviewEngine,
  type OwnerApplicationPrompt,
  type RollingReviewDependencies,
  type RollingReviewInput,
} from '../../workflow/marketplace-rolling-review.js';

describe('marketplace rolling review coordinator', () => {
  it('starts and advances the first review without prompting for a prior experiment', async () => {
    const fixture = createFixture();

    const result = await fixture.service.nextReview(nextReviewInput());

    expect(result).toMatchObject({
      currentRun: {
        runId: '2026-09-04-merchgrid_shopify_app_store-merchgrid-shopify-app',
        status: 'awaiting_approval',
        stage: 'approval_wait',
        experimentPlanRef: 'artifacts/workflow-runs/2026-09-04-merchgrid_shopify_app_store-merchgrid-shopify-app/experiment-plan.json',
      },
    });
    expect(result.previousRun).toBeUndefined();
    expect(fixture.prompt.inputs).toEqual([]);
    expect(fixture.calls).toEqual([
      'prepare-weekly-evidence',
      'find-latest-product-run',
      'start-next-run',
      'run-m1',
      'run-m2-initial',
      'run-m4',
      'run-m5',
      'run-m6',
    ]);
  });

  it('closes an applied prior run before starting one next run', async () => {
    const fixture = createFixture({
      previous: awaitingApplicationRun(),
      nextStartStage: 'approval_wait',
      promptResult: { status: 'applied', appliedAt: '2026-08-25' },
    });

    const result = await fixture.service.nextReview(nextReviewInput());

    expect(fixture.calls).toEqual([
      'prepare-weekly-evidence',
      'find-latest-product-run',
      'prompt-owner',
      'record-applied',
      'supply-result',
      'run-m2-results',
      'run-m7',
      'start-next-run',
    ]);
    expect(result.previousRun).toEqual({ runId: 'previous-run', resolution: 'evaluated' });
    expect(result.currentRun.runId).toBe('2026-09-04-merchgrid_shopify_app_store-merchgrid-shopify-app');
    expect(fixture.prompt.inputs).toEqual([{
      previousRunId: 'previous-run',
      experimentSummary: 'Lead the listing with the catalog-audit outcome',
    }]);
  });

  it('sanitizes and caps the model-produced revision before displaying the owner prompt', async () => {
    const fixture = createFixture({
      previous: workflowState({
        moduleOutputs: {
          m3: [],
          m5: hypothesis({
            recommendedRevision: `  Lead with the catalog audit outcome.\n${'x'.repeat(300)}\u001B[31m  `,
          }),
          m6: testPlan(),
        },
      }),
      nextStartStage: 'approval_wait',
      promptResult: { status: 'applied', appliedAt: '2026-08-25' },
    });

    await fixture.service.nextReview(nextReviewInput());

    const summary = fixture.prompt.inputs[0]?.experimentSummary;
    expect(summary).toHaveLength(240);
    expect(summary).toMatch(/^Lead with the catalog audit outcome\. x+/u);
    expect(summary).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  });

  it('persists and emits each cycle lifecycle event once without copying engine event types', async () => {
    const fixture = createFixture({
      previous: awaitingApplicationRun(),
      nextStartStage: 'approval_wait',
      promptResult: { status: 'applied', appliedAt: '2026-08-25' },
    });

    const first = await fixture.service.nextReview(nextReviewInput());
    await fixture.service.nextReview(nextReviewInput());
    const current = await fixture.history.load(first.currentRun.runId);
    const expectedTypes = [
      'rolling_review.started',
      'rolling_review.previous_run_found',
      'rolling_review.previous_run_evaluated',
      'rolling_review.prior_learning_selected',
      'rolling_review.next_run_created',
      'rolling_review.completed',
    ];

    expect(current.events.map((event) => event.type)).toEqual(expectedTypes);
    expect(fixture.emittedEvents.map((event) => event.type)).toEqual(expectedTypes);
    expect(current.events.every((event) => event.runId === first.currentRun.runId)).toBe(true);
    expect(current.events.map((event) => event.type)).not.toContain('experiment.applied');
    expect(JSON.stringify(current.events)).not.toMatch(/"learning":|"nextActionRationale":|OPENAI_API_KEY/u);
  });

  it('closes a declined prior plan without result or learning work', async () => {
    const fixture = createFixture({
      previous: awaitingApplicationRun(),
      nextStartStage: 'approval_wait',
      promptResult: { status: 'not_applied' },
    });

    const result = await fixture.service.nextReview(nextReviewInput());
    const current = await fixture.history.load(result.currentRun.runId);

    expect(result.previousRun).toEqual({ runId: 'previous-run', resolution: 'not_applied' });
    expect(fixture.calls).toEqual([
      'prepare-weekly-evidence',
      'find-latest-product-run',
      'prompt-owner',
      'record-not-applied',
      'start-next-run',
    ]);
    expect(current.previousRunRef).toBe('previous-run');
    expect(current.priorLearning).toBeUndefined();
    expect(fixture.engine.resumeCalls).toHaveLength(0);
    expect(fixture.engine.evaluationStepCalls).toBe(0);
  });

  it('reuses a completed prior run learning without prompting or evaluating it again', async () => {
    const fixture = createFixture({
      previous: completedRun(),
      nextStartStage: 'approval_wait',
    });

    const result = await fixture.service.nextReview(nextReviewInput());
    const current = await fixture.history.load(result.currentRun.runId);

    expect(result.previousRun).toEqual({ runId: 'previous-run', resolution: 'already_resolved' });
    expect(fixture.prompt.inputs).toEqual([]);
    expect(fixture.engine.resumeCalls).toHaveLength(0);
    expect(fixture.engine.evaluationStepCalls).toBe(0);
    expect(current.priorLearning).toMatchObject({
      sourceRunId: 'previous-run',
      sourceEvidenceRef: 'artifacts/merchgrid/metrics/artifacts/weekly-reviews/2026-08-28.json',
    });
  });

  it('returns the existing same-cycle run without prompting or evaluating again', async () => {
    const fixture = createFixture({
      previous: awaitingApplicationRun(),
      nextStartStage: 'approval_wait',
      promptResult: { status: 'applied', appliedAt: '2026-08-25' },
    });

    const first = await fixture.service.nextReview(nextReviewInput());
    const callsAfterFirst = [...fixture.calls];
    const second = await fixture.service.nextReview(nextReviewInput());

    expect(second).toEqual({ currentRun: first.currentRun });
    expect(fixture.calls).toEqual([...callsAfterFirst, 'prepare-weekly-evidence']);
    expect(fixture.prompt.inputs).toHaveLength(1);
    expect(fixture.engine.resumeCalls).toHaveLength(1);
    expect(fixture.engine.evaluationStepCalls).toBe(2);
    expect(fixture.engine.startCalls).toHaveLength(1);
  });

  it('resumes an executable same-cycle run after a transient M4 failure', async () => {
    const fixture = createFixture({ failStepOnceAt: 'm4_diagnosis' });

    await expect(fixture.service.nextReview(nextReviewInput())).rejects.toThrow('Synthetic m4_diagnosis failure');
    await expect(fixture.history.load(
      '2026-09-04-merchgrid_shopify_app_store-merchgrid-shopify-app',
    )).resolves.toMatchObject({ stage: 'm4_diagnosis', status: 'analyzing' });

    const retry = await fixture.service.nextReview(nextReviewInput());

    expect(retry.currentRun).toMatchObject({ stage: 'approval_wait', status: 'awaiting_approval' });
    expect(fixture.engine.startCalls).toHaveLength(1);
    expect(fixture.calls.filter((call) => call === 'run-m4')).toHaveLength(2);
  });

  it('does not mutate either workflow when owner confirmation is cancelled', async () => {
    const fixture = createFixture({
      previous: awaitingApplicationRun(),
      promptResult: { status: 'cancelled' },
    });

    await expect(fixture.service.nextReview(nextReviewInput())).rejects.toMatchObject({
      code: 'route_not_allowed',
      message: 'Rolling review was cancelled before workflow mutation',
    });

    expect(fixture.calls).toEqual([
      'prepare-weekly-evidence',
      'find-latest-product-run',
      'prompt-owner',
    ]);
    expect(fixture.engine.recordCalls).toHaveLength(0);
    expect(fixture.engine.startCalls).toHaveLength(0);
    await expect(fixture.history.load('previous-run')).resolves.toMatchObject({
      stage: 'approval_wait',
      status: 'awaiting_approval',
    });
  });

  it('rejects an invalid or future owner application date before mutating the previous run', async () => {
    const invalid = createFixture({
      previous: awaitingApplicationRun(),
      promptResult: { status: 'applied', appliedAt: 'not-a-date' },
    });
    const future = createFixture({
      previous: awaitingApplicationRun(),
      promptResult: { status: 'applied', appliedAt: '2026-09-09' },
    });

    await expect(invalid.service.nextReview(nextReviewInput())).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(future.service.nextReview(nextReviewInput())).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Experiment application date cannot be in the future',
    });

    expect(invalid.engine.recordCalls).toHaveLength(0);
    expect(future.engine.recordCalls).toHaveLength(0);
    await expect(invalid.history.load('previous-run')).resolves.toMatchObject({ status: 'awaiting_approval' });
    await expect(future.history.load('previous-run')).resolves.toMatchObject({ status: 'awaiting_approval' });
  });

  it('rejects an application date before the experiment plan existed without mutating either run', async () => {
    const initial = freshEvidence(identity(), '2026-08-01');
    const fixture = createFixture({
      previous: workflowState({
        subjectRef: initial.subjectRef,
        evidenceSnapshots: { initial },
        updatedAt: '2026-08-15T12:00:00.000Z',
      }),
      promptResult: { status: 'applied', appliedAt: '2026-08-14' },
    });

    await expect(fixture.service.nextReview(nextReviewInput())).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Experiment application date cannot precede experiment plan date 2026-08-15',
    });
    expect(fixture.engine.recordCalls).toHaveLength(0);
    expect(fixture.engine.startCalls).toHaveLength(0);
    const previous = await fixture.history.load('previous-run');
    expect(previous).toMatchObject({
      stage: 'approval_wait',
      status: 'awaiting_approval',
    });
    expect(previous).not.toHaveProperty('experimentApplication');
  });

  it('rejects an application date within the prior evidence window without mutating either run', async () => {
    const fixture = createFixture({
      previous: workflowState({ updatedAt: '2026-08-10T12:00:00.000Z' }),
      promptResult: { status: 'applied', appliedAt: '2026-08-13' },
    });

    await expect(fixture.service.nextReview(nextReviewInput())).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Experiment application date must be later than prior evidence date 2026-08-14',
    });
    expect(fixture.engine.recordCalls).toHaveLength(0);
    expect(fixture.engine.startCalls).toHaveLength(0);
    const previous = await fixture.history.load('previous-run');
    expect(previous).toMatchObject({
      stage: 'approval_wait',
      status: 'awaiting_approval',
    });
    expect(previous).not.toHaveProperty('experimentApplication');
  });

  it.each([
    ['has no measured signals', {}],
    ['omits the M6 primary metric', { request_count: 4 }],
  ])('leaves an applied prior plan unresolved when fresh result evidence %s', async (_label, measuredSignals) => {
    const fixture = createFixture({
      previous: awaitingApplicationRun(),
      promptResult: { status: 'applied', appliedAt: '2026-08-25' },
      preparedEvidence: { ...freshEvidence(identity(), '2026-09-04'), measuredSignals },
    });

    await expect(fixture.service.nextReview(nextReviewInput())).rejects.toMatchObject({
      code: 'route_not_allowed',
      message: 'Waiting for qualified result evidence: required primary metric app_opened_count is unavailable',
    });

    expect(fixture.calls).toEqual([
      'prepare-weekly-evidence',
      'find-latest-product-run',
      'prompt-owner',
    ]);
    expect(fixture.engine.recordCalls).toHaveLength(0);
    expect(fixture.engine.resumeCalls).toHaveLength(0);
    expect(fixture.engine.evaluationStepCalls).toBe(0);
    expect(fixture.engine.startCalls).toHaveLength(0);
    await expect(fixture.history.load('previous-run')).resolves.toMatchObject({
      stage: 'approval_wait',
      status: 'awaiting_approval',
    });
  });

  it('validates an overlapping result window before recording an applied experiment', async () => {
    const fixture = createFixture({
      previous: awaitingApplicationRun(),
      promptResult: { status: 'applied', appliedAt: '2026-08-30' },
    });

    await expect(fixture.service.nextReview(nextReviewInput())).rejects.toMatchObject({
      code: 'route_not_allowed',
      message: 'Fresh weekly evidence must begin after application date 2026-08-30; waiting for a qualified later window',
    });

    expect(fixture.calls).toEqual([
      'prepare-weekly-evidence',
      'find-latest-product-run',
      'prompt-owner',
    ]);
    expect(fixture.engine.recordCalls).toHaveLength(0);
    expect(fixture.engine.resumeCalls).toHaveLength(0);
    expect(fixture.engine.evaluationStepCalls).toBe(0);
    await expect(fixture.history.load('previous-run')).resolves.toMatchObject({
      stage: 'approval_wait',
      status: 'awaiting_approval',
    });
  });

  it.each(['m2_metrics_results', 'm7_learning'] as const)(
    'does not advance a persisted applied run at %s when fresh result evidence omits the M6 primary metric',
    async (stage) => {
      const previous = workflowState({
        stage,
        status: 'ready_for_evaluation',
        experimentApplication: { status: 'applied', appliedAt: '2026-08-25' },
      });
      const fixture = createFixture({
        previous,
        preparedEvidence: {
          ...freshEvidence(identity(), '2026-09-04'),
          measuredSignals: { request_count: 4 },
        },
      });

      await expect(fixture.service.nextReview(nextReviewInput())).rejects.toMatchObject({
        code: 'route_not_allowed',
        message: 'Waiting for qualified result evidence: required primary metric app_opened_count is unavailable',
      });

      expect(fixture.calls).toEqual([
        'prepare-weekly-evidence',
        'find-latest-product-run',
      ]);
      expect(fixture.prompt.inputs).toEqual([]);
      expect(fixture.engine.recordCalls).toHaveLength(0);
      expect(fixture.engine.resumeCalls).toHaveLength(0);
      expect(fixture.engine.evaluationStepCalls).toBe(0);
      expect(fixture.engine.startCalls).toHaveLength(0);
      await expect(fixture.history.load('previous-run')).resolves.toMatchObject({
        stage,
        status: 'ready_for_evaluation',
      });
    },
  );

  it('does not query history or mutate a workflow when fresh weekly evidence is unavailable', async () => {
    const fixture = createFixture({
      prepareError: new AppError('storage_failed', 'MerchGrid weekly review artifact not found: 2026-09-04'),
      previous: awaitingApplicationRun(),
    });

    await expect(fixture.service.nextReview(nextReviewInput())).rejects.toMatchObject({
      code: 'storage_failed',
      message: 'MerchGrid weekly review artifact not found: 2026-09-04',
    });

    expect(fixture.calls).toEqual(['prepare-weekly-evidence']);
    expect(fixture.engine.startCalls).toHaveLength(0);
    expect(fixture.engine.recordCalls).toHaveLength(0);
    expect(fixture.engine.resumeCalls).toHaveLength(0);
  });

  it.each([
    ['research', workflowState({ stage: 'm3_research', status: 'researching' })],
    ['data', workflowState({ stage: 'experiment_wait', status: 'waiting_for_data', experimentApplication: { status: 'applied', appliedAt: '2026-08-25' } })],
  ])('does not start a competing run while the prior run waits for unresolved %s', async (_kind, previous) => {
    const fixture = createFixture({ previous });

    await expect(fixture.service.nextReview(nextReviewInput())).rejects.toMatchObject({
      code: 'route_not_allowed',
      message: expect.stringContaining('Previous marketplace review previous-run is unresolved'),
    });

    expect(fixture.prompt.inputs).toEqual([]);
    expect(fixture.engine.startCalls).toHaveLength(0);
    expect(fixture.engine.recordCalls).toHaveLength(0);
    expect(fixture.engine.resumeCalls).toHaveLength(0);
  });

  it.each([
    ['data wait', 'waiting_for_data'],
    ['stopped run', 'stopped'],
  ] as const)('returns a new review at a terminal %s without stepping its requester stage', async (_label, status) => {
    const fixture = createFixture({
      nextStartStage: 'm3_research',
      nextStartStatus: status,
    });

    const result = await fixture.service.nextReview(nextReviewInput());

    expect(result).toEqual({
      currentRun: {
        runId: '2026-09-04-merchgrid_shopify_app_store-merchgrid-shopify-app',
        status,
        stage: 'm3_research',
        experimentPlanRef: 'artifacts/workflow-runs/2026-09-04-merchgrid_shopify_app_store-merchgrid-shopify-app/experiment-plan.json',
      },
    });
    expect(fixture.calls).toEqual([
      'prepare-weekly-evidence',
      'find-latest-product-run',
      'start-next-run',
    ]);
  });

  it('uses only the exact profile and product identity from history', async () => {
    const fixture = createFixture({
      previous: completedRun(),
      nextStartStage: 'approval_wait',
      otherRuns: [workflowState({
        runId: 'other-product-run',
        marketplaceIdentity: { profile: 'merchgrid_shopify_app_store', productRef: 'other-product' },
        createdAt: '2026-09-07T00:00:00.000Z',
        updatedAt: '2026-09-07T00:00:00.000Z',
      })],
    });

    const result = await fixture.service.nextReview(nextReviewInput());
    const current = await fixture.history.load(result.currentRun.runId);

    expect(result.previousRun).toEqual({ runId: 'previous-run', resolution: 'already_resolved' });
    expect(current.previousRunRef).toBe('previous-run');
    expect(current.priorLearning?.sourceRunId).toBe('previous-run');
  });

  it('retries only missing next-run creation after the previous run has already closed', async () => {
    const fixture = createFixture({
      previous: awaitingApplicationRun(),
      nextStartStage: 'approval_wait',
      promptResult: { status: 'applied', appliedAt: '2026-08-25' },
      failNextStartCount: 1,
    });

    await expect(fixture.service.nextReview(nextReviewInput())).rejects.toMatchObject({
      code: 'storage_failed',
      message: 'Synthetic next-run storage failure',
    });
    await expect(fixture.history.load('previous-run')).resolves.toMatchObject({
      stage: 'cycle_complete',
      status: 'cycle_complete',
      moduleOutputs: { m7: expect.anything() },
    });

    const retry = await fixture.service.nextReview(nextReviewInput());

    expect(retry.previousRun).toEqual({ runId: 'previous-run', resolution: 'already_resolved' });
    expect(fixture.prompt.inputs).toHaveLength(1);
    expect(fixture.engine.resumeCalls).toHaveLength(1);
    expect(fixture.engine.evaluationStepCalls).toBe(2);
    expect(fixture.engine.startCalls).toHaveLength(2);
  });

  it('derives a stable cycle run id from the exact identity and completed through date', () => {
    expect(rollingVisibilityRunId(identity(), '2026-09-04')).toBe(
      '2026-09-04-merchgrid_shopify_app_store-merchgrid-shopify-app',
    );
  });
});

class InMemoryHistory implements MarketplaceRunHistoryRepository {
  private readonly states = new Map<string, WorkflowRunState>();
  readonly calls: string[];

  constructor(calls: string[], initial: readonly WorkflowRunState[]) {
    this.calls = calls;
    for (const state of initial) this.states.set(state.runId, structuredClone(state));
  }

  async create(state: WorkflowRunStateInput): Promise<void> {
    this.states.set(state.runId, structuredClone(state as WorkflowRunState));
  }

  async load(runId: string): Promise<WorkflowRunState> {
    const state = this.states.get(runId);
    if (!state) throw new AppError('storage_failed', `Workflow run not found: ${runId}`);
    return structuredClone(state);
  }

  async save(state: WorkflowRunStateInput): Promise<void> {
    this.states.set(state.runId, structuredClone(state as WorkflowRunState));
  }

  async findLatestByProduct(productIdentity: MarketplaceProductIdentity): Promise<WorkflowRunState | undefined> {
    this.calls.push('find-latest-product-run');
    return [...this.states.values()]
      .filter((state) => state.marketplaceIdentity?.profile === productIdentity.profile
        && state.marketplaceIdentity.productRef === productIdentity.productRef)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId))[0];
  }
}

class FakeRollingEngine implements MarketplaceRollingReviewEngine {
  readonly calls: string[];
  readonly recordCalls: ExperimentApplication[] = [];
  readonly resumeCalls: unknown[] = [];
  readonly startCalls: unknown[] = [];
  evaluationStepCalls = 0;
  private remainingStartFailures: number;
  private failStepOnceAt: WorkflowStage | undefined;
  private readonly nextStartStage: WorkflowStage;
  private readonly nextStartStatus: WorkflowStatus | undefined;
  private readonly history: InMemoryHistory;

  constructor(input: {
    calls: string[];
    history: InMemoryHistory;
    nextStartStage: WorkflowStage;
    nextStartStatus?: WorkflowStatus;
    failNextStartCount: number;
    failStepOnceAt?: WorkflowStage;
  }) {
    this.calls = input.calls;
    this.history = input.history;
    this.nextStartStage = input.nextStartStage;
    this.nextStartStatus = input.nextStartStatus;
    this.remainingStartFailures = input.failNextStartCount;
    this.failStepOnceAt = input.failStepOnceAt;
  }

  async startMarketplaceVisibility(input: Parameters<MarketplaceRollingReviewEngine['startMarketplaceVisibility']>[0]): Promise<WorkflowRunState> {
    this.calls.push('start-next-run');
    this.startCalls.push(input);
    if (this.remainingStartFailures > 0) {
      this.remainingStartFailures -= 1;
      throw new AppError('storage_failed', 'Synthetic next-run storage failure');
    }
    const stage = this.nextStartStage;
    const created = workflowState({
      runId: input.runId,
      subjectRef: input.subjectRef,
      marketplaceIdentity: input.marketplaceIdentity,
      previousRunRef: input.previousRunRef,
      priorLearning: input.priorLearning,
      stage,
      status: this.nextStartStatus ?? (stage === 'approval_wait' ? 'awaiting_approval' : 'analyzing'),
      evidenceSnapshots: { initial: input.initialEvidence },
      evidenceRefs: [`initial:marketplace_visibility:${input.initialEvidence.profile}:${input.initialEvidence.subjectRef}`],
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
    });
    await this.history.create(created);
    return created;
  }

  async recordExperimentApplication(input: Parameters<MarketplaceRollingReviewEngine['recordExperimentApplication']>[0]): Promise<WorkflowRunState> {
    this.calls.push(input.application.status === 'applied' ? 'record-applied' : 'record-not-applied');
    this.recordCalls.push(input.application);
    const previous = await this.history.load(input.runId);
    const next = input.application.status === 'applied'
      ? workflowState({
        ...previous,
        stage: 'experiment_wait',
        status: 'ready_for_experiment',
        experimentApplication: input.application,
      })
      : workflowState({
        ...previous,
        status: 'stopped',
        experimentApplication: input.application,
      });
    await this.history.save(next);
    return next;
  }

  async resumeWithExperimentResults(input: Parameters<MarketplaceRollingReviewEngine['resumeWithExperimentResults']>[0]): Promise<WorkflowRunState> {
    this.calls.push('supply-result');
    this.resumeCalls.push(input);
    const previous = await this.history.load(input.runId);
    const next = workflowState({
      ...previous,
      stage: 'm2_metrics_results',
      status: 'ready_for_evaluation',
      evidenceSnapshots: { ...previous.evidenceSnapshots, result: input.resultEvidence as MarketplaceVisibilityEvidence },
    });
    await this.history.save(next);
    return next;
  }

  async step(runId: string): Promise<WorkflowRunState> {
    const previous = await this.history.load(runId);
    if (previous.status === 'waiting_for_data') {
      throw new AppError('route_not_allowed', 'Cannot step workflow while waiting for more data');
    }
    if (previous.status === 'stopped') {
      throw new AppError('route_not_allowed', 'Stopped workflows cannot transition');
    }
    const call = stepCall(previous.stage);
    this.calls.push(call);
    if (this.failStepOnceAt === previous.stage) {
      this.failStepOnceAt = undefined;
      throw new Error(`Synthetic ${previous.stage} failure`);
    }
    if (previous.stage === 'm2_metrics_results' || previous.stage === 'm7_learning') this.evaluationStepCalls += 1;
    const next = transition(previous);
    await this.history.save(next);
    return next;
  }
}

class FakeOwnerPrompt implements OwnerApplicationPrompt {
  readonly inputs: Array<{ previousRunId: string; experimentSummary: string }> = [];
  private readonly calls: string[];
  private readonly result: Awaited<ReturnType<OwnerApplicationPrompt['confirm']>>;

  constructor(calls: string[], result: Awaited<ReturnType<OwnerApplicationPrompt['confirm']>>) {
    this.calls = calls;
    this.result = result;
  }

  async confirm(input: { previousRunId: string; experimentSummary: string }) {
    this.calls.push('prompt-owner');
    this.inputs.push(input);
    return this.result;
  }
}

function createFixture(input: {
  previous?: WorkflowRunState;
  otherRuns?: WorkflowRunState[];
  promptResult?: Awaited<ReturnType<OwnerApplicationPrompt['confirm']>>;
  nextStartStage?: WorkflowStage;
  nextStartStatus?: WorkflowStatus;
  prepareError?: Error;
  preparedEvidence?: MarketplaceVisibilityEvidence;
  failNextStartCount?: number;
  failStepOnceAt?: WorkflowStage;
} = {}) {
  const calls: string[] = [];
  const emittedEvents: WorkflowEvent[] = [];
  const history = new InMemoryHistory(calls, [
    ...(input.previous ? [input.previous] : []),
    ...(input.otherRuns ?? []),
  ]);
  const engine = new FakeRollingEngine({
    calls,
    history,
    nextStartStage: input.nextStartStage ?? 'm1_context',
    nextStartStatus: input.nextStartStatus,
    failNextStartCount: input.failNextStartCount ?? 0,
    failStepOnceAt: input.failStepOnceAt,
  });
  const prompt = new FakeOwnerPrompt(calls, input.promptResult ?? { status: 'cancelled' });
  const dependencies: RollingReviewDependencies = {
    history,
    engine,
    prompt,
    now: () => new Date('2026-09-08T00:00:00.000Z'),
    prepareWeeklyEvidence: async (reviewInput) => {
      calls.push('prepare-weekly-evidence');
      if (input.prepareError) throw input.prepareError;
      return input.preparedEvidence ?? freshEvidence(reviewInput.identity, reviewInput.through);
    },
    emit: (event) => {
      emittedEvents.push(event);
    },
  };

  return {
    calls,
    emittedEvents,
    engine,
    history,
    prompt,
    service: createMarketplaceRollingReviewService(dependencies),
  };
}

function nextReviewInput(): RollingReviewInput {
  return {
    profile: 'merchgrid_shopify_app_store',
    productRef: 'merchgrid-shopify-app',
    through: '2026-09-04',
    contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
  };
}

function identity(): MarketplaceProductIdentity {
  return { profile: 'merchgrid_shopify_app_store', productRef: 'merchgrid-shopify-app' };
}

function freshEvidence(productIdentity: MarketplaceProductIdentity, through: string): MarketplaceVisibilityEvidence {
  return {
    product: 'marketplace_visibility',
    profile: productIdentity.profile,
    productRef: productIdentity.productRef,
    subjectRef: `merchgrid:visibility:${through}`,
    artifactRef: `artifacts/merchgrid/metrics/artifacts/weekly-reviews/${through}.json`,
    evidenceLevel: 'sparse',
    recommendationType: 'visibility_hypothesis',
    reviewMode: {
      mode: 'exploratory_visibility_test',
      evidenceLevel: 'sparse',
      confidenceBoundary: 'low',
      reason: 'metrics_sparse_context_sufficient',
    },
    marketplaceContext: {
      productRef: productIdentity.productRef,
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
      productType: 'shopify_app',
      targetCustomer: 'Shopify merchants auditing catalog quality',
      customerProblem: 'Catalog issues can hurt trust before merchants notice',
      currentPromise: 'Find catalog issues before they hurt sales or trust',
      currentSurfaceSummary: 'Shopify app listing for catalog audits',
      primaryDiscoverySurface: 'Shopify App Store search and category pages',
      primaryActionWanted: 'Open the app and run a catalog audit',
      constraints: ['manual listing changes only'],
      availableAssets: ['listing copy', 'screenshots'],
      ownerGoal: 'increase qualified app opens and first scans',
    },
    measuredSignals: { app_opened_count: 4 },
    limitations: ['Evidence is sparse'],
    prohibitedClaims: ['Do not claim the listing caused traffic'],
  };
}

function awaitingApplicationRun(): WorkflowRunState {
  return workflowState({
    stage: 'approval_wait',
    status: 'awaiting_approval',
  });
}

function completedRun(): WorkflowRunState {
  const result = freshEvidence(identity(), '2026-08-28');
  return workflowState({
    stage: 'cycle_complete',
    status: 'cycle_complete',
    experimentApplication: { status: 'applied', appliedAt: '2026-08-18' },
    evidenceSnapshots: {
      initial: freshEvidence(identity(), '2026-08-14'),
      result: { ...result, subjectRef: 'merchgrid:visibility:2026-08-14' },
    },
    moduleOutputs: {
      m3: [],
      m5: hypothesis(),
      m6: testPlan(),
      m7: evaluation(),
    },
  });
}

function workflowState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: 'previous-run',
    subjectRef: 'merchgrid:visibility:2026-08-14',
    marketplaceIdentity: identity(),
    workflowKind: 'marketplace_visibility_review',
    status: 'awaiting_approval',
    stage: 'approval_wait',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    evidenceRefs: ['initial:marketplace_visibility:merchgrid_shopify_app_store:merchgrid:visibility:2026-08-14'],
    evidenceSnapshots: { initial: freshEvidence(identity(), '2026-08-14') },
    moduleOutputs: { m3: [], m5: hypothesis(), m6: testPlan() },
    events: [],
    ...overrides,
  };
}

function transition(state: WorkflowRunState): WorkflowRunState {
  switch (state.stage) {
    case 'm1_context':
      return workflowState({ ...state, stage: 'm2_metrics_initial', status: 'analyzing' });
    case 'm2_metrics_initial':
      return workflowState({ ...state, stage: 'm4_diagnosis', status: 'analyzing' });
    case 'm4_diagnosis':
      return workflowState({ ...state, stage: 'm5_hypothesis', status: 'analyzing' });
    case 'm5_hypothesis':
      return workflowState({ ...state, stage: 'm6_test_plan', status: 'analyzing' });
    case 'm6_test_plan':
      return workflowState({ ...state, stage: 'approval_wait', status: 'awaiting_approval' });
    case 'm2_metrics_results':
      return workflowState({ ...state, stage: 'm7_learning', status: 'ready_for_evaluation' });
    case 'm7_learning':
      return workflowState({
        ...state,
        stage: 'cycle_complete',
        status: 'cycle_complete',
        moduleOutputs: { ...state.moduleOutputs, m7: evaluation() },
      });
    default:
      throw new Error(`Unexpected fake workflow stage: ${state.stage}`);
  }
}

function stepCall(stage: WorkflowStage): string {
  const calls: Record<WorkflowStage, string> = {
    m1_context: 'run-m1',
    m2_metrics_initial: 'run-m2-initial',
    m3_research: 'run-m3',
    m4_diagnosis: 'run-m4',
    m5_hypothesis: 'run-m5',
    m6_test_plan: 'run-m6',
    approval_wait: 'step-approval-wait',
    experiment_wait: 'step-experiment-wait',
    m2_metrics_results: 'run-m2-results',
    m7_learning: 'run-m7',
    cycle_complete: 'step-cycle-complete',
  };
  return calls[stage];
}

function testPlan() {
  return {
    primaryMetric: 'app_opened_count',
    secondaryMetrics: [],
    baselineValue: 4,
    baselinePeriod: '2026-08-14',
    qualificationRequirements: [],
    expectedSupportingSignal: 'More qualified app opens',
    expectedWeakeningSignal: 'No change in qualified app opens',
    inconclusiveCondition: 'Evidence remains sparse',
    contextToMonitor: [],
    unresolvedMeasurementRules: [],
  } as WorkflowRunState['moduleOutputs']['m6'];
}

function hypothesis(overrides: Record<string, unknown> = {}) {
  return {
    hypothesis: 'A clearer first listing line may improve qualified app opens',
    primaryVariable: 'listing opening line',
    recommendedRevision: 'Lead the listing with the catalog-audit outcome',
    keepConstant: ['pricing', 'app behavior'],
    expectedSignal: 'More qualified app opens',
    notes: [],
    ...overrides,
  } as NonNullable<WorkflowRunState['moduleOutputs']['m5']>;
}

function evaluation() {
  return {
    outcome: 'inconclusive',
    hypothesisEvaluation: 'inconclusive',
    evidence: ['Weekly evidence remains sparse'],
    contextualFactors: [],
    learning: 'Observe another weekly window before changing the listing',
    confidence: 'low',
    knowledgeSource: 'experiment',
    nextAction: 'wait',
    nextActionRationale: 'One weekly window is not enough evidence',
  } as NonNullable<WorkflowRunState['moduleOutputs']['m7']>;
}
