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
});
