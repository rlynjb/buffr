import { describe, expect, it } from 'vitest';
import { runMerchGridWorkflowCli } from '../../cli/merchgrid-workflow.js';
import type { MerchGridWorkflowService } from '../../workflow/merchgrid-profile.js';
import type { WorkflowEngine } from '../../workflow/engine.js';

describe('MerchGrid workflow CLI', () => {
  it('prints only bounded details for a weekly recommendation', async () => {
    const lines: string[] = [];
    const state = {
      runId: 'weekly-1',
      status: 'awaiting_approval',
      stage: 'approval_wait',
      evidenceRefs: ['initial:weekly_review:.local/merchgrid.json'],
    };
    const service = { startWeeklyRecommendation: async () => state } as unknown as MerchGridWorkflowService;
    const engine = { step: async () => state } as unknown as WorkflowEngine;

    await runMerchGridWorkflowCli({
      args: ['weekly-recommend', '--through', '2026-08-21', '--run-id', 'weekly-1'],
      dependencies: { service, engine },
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      'run: weekly-1',
      'status: awaiting_approval',
      'stage: approval_wait',
      'artifact: initial:weekly_review:.local/merchgrid.json',
    ]);
    expect(lines.join('\n')).not.toMatch(/OPENAI_API_KEY|POSTHOG_PERSONAL_API_KEY|FLY_ACCESS_TOKEN|myshopify/i);
  });

  it('accepts the approval command with its single required option', async () => {
    const lines: string[] = [];
    const state = { runId: 'weekly-1', status: 'running', stage: 'm2_metrics_results', evidenceRefs: [] };
    const engine = { approveExperiment: async (runId: string) => ({ ...state, runId }) } as unknown as WorkflowEngine;

    await runMerchGridWorkflowCli({
      args: ['approve', '--run-id', 'weekly-1'],
      dependencies: { service: {} as MerchGridWorkflowService, engine },
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual(['run: weekly-1', 'status: running', 'stage: m2_metrics_results', 'artifact: none']);
  });
});
