import { describe, expect, it, vi } from 'vitest';
import type { MarketplaceProductIdentity, MarketplaceVisibilityEvidence } from '../../contracts/marketplace-visibility.js';
import type {
  WorkflowRunState,
  WorkflowRunStateInput,
  WorkflowStage,
  WorkflowStatus,
} from '../../contracts/workflow.js';
import { AppError } from '../../core/errors.js';
import {
  createMarketplaceVisibilityDependencies,
  createOwnerApplicationPrompt,
  marketplaceVisibilityStorageLayout,
  runMarketplaceVisibilityCli,
  runMarketplaceVisibilityEntrypoint,
  type MarketplaceVisibilityCliDependencies,
} from '../../cli/marketplace-visibility.js';
import {
  createMarketplaceRollingReviewService,
  type MarketplaceRollingReviewEngine,
  type OwnerApplicationPrompt,
} from '../../workflow/marketplace-rolling-review.js';

describe('marketplace visibility CLI', () => {
  it('composes resolvable artifact and run references from the documented data directory', () => {
    expect(marketplaceVisibilityStorageLayout('artifacts/merchgrid/metrics')).toEqual({
      artifactRoot: 'artifacts/merchgrid/metrics/artifacts',
      runRoot: 'artifacts/merchgrid/metrics/workflow-runs',
    });
  });

  it.each([
    ['an invalid enabled flag', { MARKETPLACE_RESEARCH_ENABLED: 'maybe' }],
    ['an engine-exceeding tool-call cap', { MARKETPLACE_RESEARCH_ENABLED: 'true', MARKETPLACE_RESEARCH_MAX_TOOL_CALLS: '4' }],
  ])('validates marketplace M3 runtime configuration for %s', (_label, researchEnv) => {
    expect(() => createMarketplaceVisibilityDependencies({
      MERCHGRID_METRICS_DATA_DIR: 'artifacts/merchgrid/metrics',
      ...researchEnv,
    })).toThrowError(expect.objectContaining({
      code: 'configuration_failed',
      message: 'Marketplace research configuration is invalid',
    }));
  });

  it('surfaces bounded missing weekly source-dates through the CLI error channel', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const missingMessage = 'Missing weekly metric snapshots (2): posthog/2026-08-10, fly_metrics/2026-08-20';

    await runMarketplaceVisibilityEntrypoint({
      args: nextReviewArgs(),
      dependencies: {
        rollingReviews: {
          nextReview: async () => {
            throw new AppError('storage_failed', missingMessage);
          },
        },
        resolveThrough: async () => '2026-09-07',
        resolveProductRef: async () => 'merchgrid-shopify-app',
        defaultContextPath: 'artifacts/merchgrid/context/default-review.json',
      },
      writeLine: (line) => output.push(line),
      writeError: (line) => errors.push(line),
    });

    expect(output).toEqual([]);
    expect(errors).toEqual([`storage_failed: ${missingMessage}`]);
  });

  it('always forwards configured context paths to the rolling service', async () => {
    const nextReview = vi.fn(async () => reviewResult());

    await runMarketplaceVisibilityCli(cliInput([
      'next-review',
      '--profile', 'merchgrid_shopify_app_store',
    ], {
      rollingReviews: { nextReview },
      resolveThrough: async () => '2026-09-07',
      resolveProductRef: async () => 'merchgrid-shopify-app',
      defaultContextPath: 'artifacts/merchgrid/context/default-review.json',
      defaultListingContextPath: 'artifacts/merchgrid/context/default-listing.json',
    }));

    expect(nextReview).toHaveBeenCalledWith({
      profile: 'merchgrid_shopify_app_store',
      productRef: 'merchgrid-shopify-app',
      through: '2026-09-07',
      contextPath: 'artifacts/merchgrid/context/default-review.json',
      listingContextPath: 'artifacts/merchgrid/context/default-listing.json',
    });
  });

  it('uses the configured local context defaults', async () => {
    const nextReview = vi.fn(async () => reviewResult());

    await runMarketplaceVisibilityCli(cliInput([
      'next-review', '--profile', 'merchgrid_shopify_app_store',
    ], {
      rollingReviews: { nextReview },
      resolveThrough: async () => '2026-09-07',
      resolveProductRef: async () => 'merchgrid-shopify-app',
      defaultContextPath: 'artifacts/merchgrid/context/default-review.json',
      defaultListingContextPath: 'artifacts/merchgrid/context/default-listing.json',
    }));

    expect(nextReview).toHaveBeenCalledWith(expect.objectContaining({
      contextPath: 'artifacts/merchgrid/context/default-review.json',
      listingContextPath: 'artifacts/merchgrid/context/default-listing.json',
    }));
  });

  it('prints only bounded generated-run details', async () => {
    const lines: string[] = [];

    await runMarketplaceVisibilityCli({
      ...cliInput([
        'next-review', '--profile', 'merchgrid_shopify_app_store',
      ], {
        rollingReviews: {
          nextReview: async () => reviewResult({
            previousRun: { runId: 'previous-review', resolution: 'not_applied' },
            currentRun: {
              runId: '2026-09-07-merchgrid_shopify_app_store-merchgrid-shopify-app',
              status: 'awaiting_approval',
              stage: 'approval_wait',
              experimentPlanRef: 'artifacts/workflow-runs/current/experiment-plan.json',
            },
          }),
        },
        resolveThrough: async () => '2026-09-07',
        resolveProductRef: async () => 'merchgrid-shopify-app',
        defaultContextPath: 'artifacts/merchgrid/context/default-review.json',
      }),
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      'previous: previous-review (not_applied)',
      'run: 2026-09-07-merchgrid_shopify_app_store-merchgrid-shopify-app',
      'status: awaiting_approval',
      'stage: approval_wait',
      'experiment-plan: artifacts/workflow-runs/current/experiment-plan.json',
    ]);
    expect(lines.join('\n')).not.toMatch(/OPENAI_API_KEY|POSTHOG_PERSONAL_API_KEY|FLY_ACCESS_TOKEN|myshopify/i);
  });

  it.each(['visibility-review', 'approve', 'reject', 'record-result'])('rejects removed command %s', async (command) => {
    await expect(runMarketplaceVisibilityCli(cliInput([command]))).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Expected next-review command',
    });
  });

  it('rejects malformed next-review options before calling the rolling service', async () => {
    const nextReview = vi.fn(async () => reviewResult());

    await expect(runMarketplaceVisibilityCli(cliInput([
      'next-review', '--profile', 'unsupported_profile',
    ], { rollingReviews: { nextReview } }))).rejects.toMatchObject({ code: 'validation_failed' });

    expect(nextReview).not.toHaveBeenCalled();
  });

  it.each([
    ['a required option followed by another option', [
      'next-review', '--profile',
    ]],
    ['the removed context option', [
      'next-review', '--profile', 'merchgrid_shopify_app_store', '--product-ref', 'merchgrid-shopify-app',
      '--context', 'artifacts/merchgrid/context/review.json',
    ]],
    ['the removed listing-context option', [
      'next-review', '--profile', 'merchgrid_shopify_app_store', '--product-ref', 'merchgrid-shopify-app',
      '--listing-context', 'artifacts/merchgrid/context/listing.json',
    ]],
    ['the removed through option', [
      'next-review', '--profile', 'merchgrid_shopify_app_store', '--product-ref', 'merchgrid-shopify-app',
      '--through', '2026-09-07',
    ]],
    ['the removed product-ref option', [
      'next-review', '--profile', 'merchgrid_shopify_app_store',
      '--product-ref', 'merchgrid-shopify-app',
    ]],
  ])('rejects %s before calling the rolling service', async (_caseName, args) => {
    const nextReview = vi.fn(async () => reviewResult());

    await expect(runMarketplaceVisibilityCli(cliInput(args, {
      rollingReviews: { nextReview },
      defaultContextPath: 'artifacts/merchgrid/context/default-review.json',
    }))).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Expected options: --profile',
    });

    expect(nextReview).not.toHaveBeenCalled();
  });

  it('does not invoke the owner prompt for the first CLI review cycle', async () => {
    const fixture = coordinatorFixture();

    await runMarketplaceVisibilityCli(cliInput(nextReviewArgs(), {
      rollingReviews: fixture.service,
      defaultContextPath: 'artifacts/merchgrid/context/default-review.json',
    }));

    expect(fixture.prompt.confirm).not.toHaveBeenCalled();
  });

  it('does not invoke the owner prompt when the CLI retries an existing cycle', async () => {
    const fixture = coordinatorFixture({ existing: workflowState('2026-09-07-merchgrid_shopify_app_store-merchgrid-shopify-app') });

    await runMarketplaceVisibilityCli(cliInput(nextReviewArgs(), {
      rollingReviews: fixture.service,
      defaultContextPath: 'artifacts/merchgrid/context/default-review.json',
    }));

    expect(fixture.prompt.confirm).not.toHaveBeenCalled();
  });

  it('does not invoke the owner prompt for an already-resolved prior CLI review', async () => {
    const fixture = coordinatorFixture({ previous: completedWorkflowState('previous-review') });

    await runMarketplaceVisibilityCli(cliInput(nextReviewArgs(), {
      rollingReviews: fixture.service,
      defaultContextPath: 'artifacts/merchgrid/context/default-review.json',
    }));

    expect(fixture.prompt.confirm).not.toHaveBeenCalled();
  });
});

describe('owner application prompt', () => {
  it('collects an explicit applied decision followed by a UTC date', async () => {
    const prompt = createOwnerApplicationPrompt({
      createInterface: fakePromptInterface(['yes', '2026-09-07']),
    });

    await expect(prompt.confirm({ previousRunId: 'previous-review', experimentSummary: 'Update listing headline' }))
      .resolves.toEqual({ status: 'applied', appliedAt: '2026-09-07' });
  });

  it('re-prompts after invalid answers and dates without inferring a default', async () => {
    const fake = fakePromptInterface(['perhaps', 'yes', '2026-02-30', '2026-09-07']);
    const prompt = createOwnerApplicationPrompt({ createInterface: fake });

    await expect(prompt.confirm({ previousRunId: 'previous-review', experimentSummary: 'Update listing headline' }))
      .resolves.toEqual({ status: 'applied', appliedAt: '2026-09-07' });
    expect(fake.questions).toHaveLength(4);
    expect(fake.questions[1]).toMatch(/yes or no/i);
    expect(fake.questions[3]).toMatch(/UTC date/i);
    expect(fake.closed).toBe(true);
  });

  it('returns not applied for an explicit no', async () => {
    const prompt = createOwnerApplicationPrompt({ createInterface: fakePromptInterface(['no']) });

    await expect(prompt.confirm({ previousRunId: 'previous-review', experimentSummary: 'Update listing headline' }))
      .resolves.toEqual({ status: 'not_applied' });
  });

  it('returns cancelled and closes the interface when the terminal prompt is interrupted', async () => {
    const fake = fakePromptInterface([new Error('readline closed')]);
    const prompt = createOwnerApplicationPrompt({ createInterface: fake });

    await expect(prompt.confirm({ previousRunId: 'previous-review', experimentSummary: 'Update listing headline' }))
      .resolves.toEqual({ status: 'cancelled' });
    expect(fake.closed).toBe(true);
  });
});

function cliInput(
  args: readonly string[],
  dependencies: Partial<MarketplaceVisibilityCliDependencies> = {},
): Parameters<typeof runMarketplaceVisibilityCli>[0] {
  return {
    args,
    dependencies: {
      rollingReviews: { nextReview: async () => reviewResult() },
      resolveThrough: async () => '2026-09-07',
      resolveProductRef: async () => 'merchgrid-shopify-app',
      ...dependencies,
    },
    writeLine: () => undefined,
  };
}

function reviewResult(overrides: Record<string, unknown> = {}) {
  return {
    currentRun: {
      runId: '2026-09-07-merchgrid_shopify_app_store-merchgrid-shopify-app',
      status: 'awaiting_approval' as const,
      stage: 'approval_wait' as const,
    },
    ...overrides,
  };
}

function nextReviewArgs(): string[] {
  return [
    'next-review', '--profile', 'merchgrid_shopify_app_store',
  ];
}

function coordinatorFixture(input: { existing?: WorkflowRunState; previous?: WorkflowRunState } = {}) {
  const prompt: OwnerApplicationPrompt = { confirm: vi.fn(async () => ({ status: 'cancelled' as const })) };
  const states = new Map<string, WorkflowRunState>([
    ...(input.existing ? [[input.existing.runId, structuredClone(input.existing)] as const] : []),
    ...(input.previous ? [[input.previous.runId, structuredClone(input.previous)] as const] : []),
  ]);
  const history = {
    async create(state: WorkflowRunStateInput): Promise<void> {
      states.set(state.runId, structuredClone(state) as WorkflowRunState);
    },
    async save(state: WorkflowRunStateInput): Promise<void> {
      states.set(state.runId, structuredClone(state) as WorkflowRunState);
    },
    async load(runId: string): Promise<WorkflowRunState> {
      const state = states.get(runId);
      if (state) return structuredClone(state);
      throw new AppError('storage_failed', `Workflow run not found: ${runId}`);
    },
    async findLatestByProduct(): Promise<WorkflowRunState | undefined> {
      return input.previous;
    },
  };

  return {
    prompt,
    service: createMarketplaceRollingReviewService({
      history,
      engine: advancingEngine(),
      prompt,
      now: () => new Date('2026-09-08T00:00:00.000Z'),
      prepareWeeklyEvidence: async (input) => freshEvidence(input.identity, input.through),
    }),
  };
}

function advancingEngine(): MarketplaceRollingReviewEngine {
  const stages: Array<[WorkflowStage, WorkflowStatus]> = [
    ['m2_metrics_initial', 'analyzing'],
    ['m4_diagnosis', 'analyzing'],
    ['m5_hypothesis', 'analyzing'],
    ['m6_test_plan', 'analyzing'],
    ['approval_wait', 'awaiting_approval'],
  ];
  let index = 0;
  return {
    async startMarketplaceVisibility(input) {
      return workflowState(input.runId, 'm1_context', 'analyzing');
    },
    async step(runId) {
      const [stage, status] = stages[index++]!;
      return workflowState(runId, stage, status);
    },
    async resumeWithExperimentResults() {
      throw new Error('No resolved review should resume results');
    },
    async recordExperimentApplication() {
      throw new Error('No resolved review should record application');
    },
  };
}

function workflowState(
  runId: string,
  stage: WorkflowStage = 'approval_wait',
  status: WorkflowStatus = 'awaiting_approval',
): WorkflowRunState {
  return {
    runId,
    subjectRef: 'merchgrid:visibility:2026-09-07',
    workflowKind: 'marketplace_visibility_review',
    marketplaceIdentity: marketplaceIdentity(),
    status,
    stage,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    evidenceRefs: [],
    evidenceSnapshots: { initial: freshEvidence(marketplaceIdentity(), '2026-09-07') },
    moduleOutputs: { m3: [] },
    events: [],
  } as unknown as WorkflowRunState;
}

function completedWorkflowState(runId: string): WorkflowRunState {
  const state = workflowState(runId, 'cycle_complete', 'cycle_complete');
  return {
    ...state,
    subjectRef: 'merchgrid:visibility:2026-08-21',
    experimentApplication: { status: 'applied', appliedAt: '2026-08-15' },
    evidenceSnapshots: {
      initial: freshEvidence(marketplaceIdentity(), '2026-08-21'),
      result: { ...freshEvidence(marketplaceIdentity(), '2026-08-28'), subjectRef: 'merchgrid:visibility:2026-08-21' },
    },
    moduleOutputs: {
      m3: [],
      m5: { hypothesis: 'A clear outcome helps', primaryVariable: 'headline', recommendedRevision: 'Lead with outcome', keepConstant: [], expectedSignal: 'opens', notes: [] },
      m6: { primaryMetric: 'app_opened_count', secondaryMetrics: [], baselineValue: 1, baselinePeriod: 'week', qualificationRequirements: [], expectedSupportingSignal: 'more opens', expectedWeakeningSignal: 'fewer opens', inconclusiveCondition: 'sparse', contextToMonitor: [], unresolvedMeasurementRules: [] },
      m7: { outcome: 'inconclusive', hypothesisEvaluation: 'inconclusive', evidence: [], contextualFactors: [], learning: 'More evidence is needed', confidence: 'low', knowledgeSource: 'experiment', nextAction: 'wait', nextActionRationale: 'Wait for a qualified window' },
    },
  } as WorkflowRunState;
}

function marketplaceIdentity(): MarketplaceProductIdentity {
  return { profile: 'merchgrid_shopify_app_store', productRef: 'merchgrid-shopify-app' };
}

function freshEvidence(identity: MarketplaceProductIdentity, through: string): MarketplaceVisibilityEvidence {
  return {
    product: 'marketplace_visibility',
    profile: identity.profile,
    productRef: identity.productRef,
    subjectRef: `merchgrid:visibility:${through}`,
    artifactRef: `artifacts/weekly-reviews/${through}.json`,
    evidenceLevel: 'sparse',
    recommendationType: 'visibility_hypothesis',
    reviewMode: { mode: 'exploratory_visibility_test', evidenceLevel: 'sparse', confidenceBoundary: 'low', reason: 'metrics_sparse_context_sufficient' },
    marketplaceContext: {
      productRef: identity.productRef,
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
      productType: 'shopify_app',
      targetCustomer: 'Shopify merchants',
      customerProblem: 'Catalog issues are hard to find',
      currentPromise: 'Find catalog issues',
      currentSurfaceSummary: 'Marketplace listing',
      primaryDiscoverySurface: 'App Store search',
      primaryActionWanted: 'Open the app',
      constraints: ['manual changes'],
      availableAssets: ['listing copy'],
      ownerGoal: 'increase qualified app opens',
    },
    measuredSignals: { app_opened_count: 4 },
    limitations: ['Evidence is sparse'],
    prohibitedClaims: ['Do not claim the listing caused traffic'],
  };
}

function fakePromptInterface(answers: Array<string | Error>) {
  const questions: string[] = [];
  let closed = false;
  return {
    questions,
    get closed() {
      return closed;
    },
    async question(question: string): Promise<string> {
      questions.push(question);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error('No terminal answer available');
      return answer;
    },
    close() {
      closed = true;
    },
  };
}
