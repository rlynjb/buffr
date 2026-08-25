import { describe, expect, it } from 'vitest';
import { runMarketplaceVisibilityCli } from '../../cli/marketplace-visibility.js';

describe('marketplace visibility CLI', () => {
  it('prints only bounded run details for a visibility review', async () => {
    const lines: string[] = [];
    const state = {
      runId: 'visibility-1',
      status: 'awaiting_approval',
      stage: 'approval_wait',
      evidenceRefs: ['initial:marketplace_visibility:merchgrid_shopify_app_store:merchgrid:visibility:2026-08-22'],
    };

    await runMarketplaceVisibilityCli({
      args: [
        'visibility-review',
        '--profile', 'merchgrid_shopify_app_store',
        '--date', '2026-08-22',
        '--run-id', 'visibility-1',
        '--context', '.local/merchgrid-visibility-context.json',
      ],
      dependencies: {
        service: { startVisibilityReview: async () => state },
        engine: { step: async () => state },
      },
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      'run: visibility-1',
      'status: awaiting_approval',
      'stage: approval_wait',
      'artifact: initial:marketplace_visibility:merchgrid_shopify_app_store:merchgrid:visibility:2026-08-22',
    ]);
    expect(lines.join('\n')).not.toMatch(/OPENAI_API_KEY|POSTHOG_PERSONAL_API_KEY|FLY_ACCESS_TOKEN|myshopify/i);
  });

  it('accepts reject with a reason', async () => {
    const lines: string[] = [];
    await runMarketplaceVisibilityCli({
      args: ['reject', '--run-id', 'visibility-1', '--reason', 'Too broad'],
      dependencies: {
        service: {},
        engine: { rejectExperiment: async () => ({ runId: 'visibility-1', status: 'stopped', stage: 'approval_wait', evidenceRefs: [] }) },
      },
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toContain('status: stopped');
  });

  it('stops stepping when a visibility review waits for more data', async () => {
    const lines: string[] = [];
    let stepCount = 0;

    await runMarketplaceVisibilityCli({
      args: [
        'visibility-review',
        '--profile', 'merchgrid_shopify_app_store',
        '--date', '2026-08-22',
        '--run-id', 'visibility-1',
        '--context', '.local/merchgrid-visibility-context.json',
      ],
      dependencies: {
        service: {
          startVisibilityReview: async () => ({
            runId: 'visibility-1',
            status: 'analyzing',
            stage: 'm4_diagnosis',
            evidenceRefs: ['initial-ref'],
          }),
        },
        engine: {
          step: async () => {
            stepCount += 1;
            if (stepCount > 1) throw new Error('CLI should not step a waiting run');
            return {
              runId: 'visibility-1',
              status: 'waiting_for_data',
              stage: 'm4_diagnosis',
              evidenceRefs: ['initial-ref'],
            };
          },
        },
      },
      writeLine: (line) => lines.push(line),
    });

    expect(stepCount).toBe(1);
    expect(lines).toContain('status: waiting_for_data');
    expect(lines).toContain('stage: m4_diagnosis');
  });

  it('forwards optional listing context path for a visibility review', async () => {
    const calls: unknown[] = [];
    const state = {
      runId: 'visibility-1',
      status: 'awaiting_approval',
      stage: 'approval_wait',
      evidenceRefs: ['initial-ref'],
    };

    await runMarketplaceVisibilityCli({
      args: [
        'visibility-review',
        '--profile', 'merchgrid_shopify_app_store',
        '--date', '2026-08-22',
        '--run-id', 'visibility-1',
        '--context', '.local/merchgrid-visibility-context.json',
        '--listing-context', '.local/merchgrid-listing-context.json',
      ],
      dependencies: {
        service: {
          startVisibilityReview: async (input) => {
            calls.push(input);
            return state;
          },
        },
        engine: { step: async () => state },
      },
      writeLine: () => undefined,
    });

    expect(calls).toEqual([{
      profile: 'merchgrid_shopify_app_store',
      runId: 'visibility-1',
      date: '2026-08-22',
      contextPath: '.local/merchgrid-visibility-context.json',
      listingContextPath: '.local/merchgrid-listing-context.json',
    }]);
  });

  it('uses the default listing context path when the flag is omitted', async () => {
    const calls: unknown[] = [];
    const state = {
      runId: 'visibility-1',
      status: 'awaiting_approval',
      stage: 'approval_wait',
      evidenceRefs: ['initial-ref'],
    };

    await runMarketplaceVisibilityCli({
      args: [
        'visibility-review',
        '--profile', 'merchgrid_shopify_app_store',
        '--date', '2026-08-22',
        '--run-id', 'visibility-1',
        '--context', '.local/merchgrid-visibility-context.json',
      ],
      dependencies: {
        service: {
          startVisibilityReview: async (input) => {
            calls.push(input);
            return state;
          },
        },
        engine: { step: async () => state },
        defaultListingContextPath: '.local/merchgrid-listing-context.json',
      },
      writeLine: () => undefined,
    });

    expect(calls).toEqual([{
      profile: 'merchgrid_shopify_app_store',
      runId: 'visibility-1',
      date: '2026-08-22',
      contextPath: '.local/merchgrid-visibility-context.json',
      listingContextPath: '.local/merchgrid-listing-context.json',
    }]);
  });

  it('forwards the result identity and period to the visibility service', async () => {
    const calls: unknown[] = [];

    await runMarketplaceVisibilityCli({
      args: [
        'record-result',
        '--profile', 'merchgrid_shopify_app_store',
        '--run-id', 'visibility-1',
        '--through', '2026-08-22',
      ],
      dependencies: {
        service: {
          supplyVisibilityResult: async (input) => {
            calls.push(input);
            return { runId: 'visibility-1', status: 'stopped', stage: 'approval_wait', evidenceRefs: [] };
          },
        },
        engine: {},
      },
      writeLine: () => undefined,
    });

    expect(calls).toEqual([{
      profile: 'merchgrid_shopify_app_store',
      runId: 'visibility-1',
      through: '2026-08-22',
    }]);
  });

  it('steps result metrics and learning before printing the result outcome', async () => {
    const steppedStages: string[] = [];
    const lines: string[] = [];

    await runMarketplaceVisibilityCli({
      args: [
        'record-result',
        '--profile', 'merchgrid_shopify_app_store',
        '--run-id', 'visibility-1',
        '--through', '2026-09-04',
      ],
      dependencies: {
        service: {
          supplyVisibilityResult: async () => ({
            runId: 'visibility-1', status: 'ready_for_evaluation', stage: 'm2_metrics_results', evidenceRefs: ['result-ref'],
          }),
        },
        engine: {
          step: async () => {
            const stage = steppedStages.length === 0 ? 'm7_learning' : 'cycle_complete';
            steppedStages.push(stage);
            return { runId: 'visibility-1', status: stage === 'cycle_complete' ? 'cycle_complete' : 'ready_for_evaluation', stage, evidenceRefs: ['result-ref'] };
          },
        },
      },
      writeLine: (line) => lines.push(line),
    });

    expect(steppedStages).toEqual(['m7_learning', 'cycle_complete']);
    expect(lines).toContain('stage: cycle_complete');
  });
});
