import { describe, expect, it, vi } from 'vitest';
import {
  createOwnerApplicationPrompt,
  runMarketplaceVisibilityCli,
  type MarketplaceVisibilityCliDependencies,
} from '../../cli/marketplace-visibility.js';

describe('marketplace visibility CLI', () => {
  it('forwards one structured next-review request to the rolling service', async () => {
    const nextReview = vi.fn(async () => reviewResult());

    await runMarketplaceVisibilityCli(cliInput([
      'next-review',
      '--profile', 'merchgrid_shopify_app_store',
      '--product-ref', 'merchgrid-shopify-app',
      '--through', '2026-09-07',
      '--context', 'artifacts/merchgrid/context/review.json',
      '--listing-context', 'artifacts/merchgrid/context/listing.json',
    ], { rollingReviews: { nextReview } }));

    expect(nextReview).toHaveBeenCalledWith({
      profile: 'merchgrid_shopify_app_store',
      productRef: 'merchgrid-shopify-app',
      through: '2026-09-07',
      contextPath: 'artifacts/merchgrid/context/review.json',
      listingContextPath: 'artifacts/merchgrid/context/listing.json',
    });
  });

  it('uses the configured local context defaults', async () => {
    const nextReview = vi.fn(async () => reviewResult());

    await runMarketplaceVisibilityCli(cliInput([
      'next-review', '--profile', 'merchgrid_shopify_app_store',
      '--product-ref', 'merchgrid-shopify-app', '--through', '2026-09-07',
    ], {
      rollingReviews: { nextReview },
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
        '--product-ref', 'merchgrid-shopify-app', '--through', '2026-09-07',
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
      'next-review', '--profile', 'merchgrid_shopify_app_store', '--product-ref', 'MerchGrid', '--through', '2026-09-07',
    ], { rollingReviews: { nextReview } }))).rejects.toMatchObject({ code: 'validation_failed' });

    expect(nextReview).not.toHaveBeenCalled();
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
