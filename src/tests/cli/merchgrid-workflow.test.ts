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

  it('generates a date-first run id for a weekly recommendation when run id is omitted', async () => {
    const calls: unknown[] = [];
    const lines: string[] = [];
    const service = {
      startWeeklyRecommendation: async (input: unknown) => {
        calls.push(input);
        return {
          runId: (input as { runId: string }).runId,
          status: 'awaiting_approval',
          stage: 'approval_wait',
          evidenceRefs: [],
        };
      },
    } as unknown as MerchGridWorkflowService;
    const engine = { step: async (runId: string) => ({ runId, status: 'awaiting_approval', stage: 'approval_wait', evidenceRefs: [] }) } as unknown as WorkflowEngine;

    await runMerchGridWorkflowCli({
      args: ['weekly-recommend', '--through', '2026-08-21'],
      dependencies: { service, engine, now: () => new Date('2026-08-25T13:00:00.000Z') },
      writeLine: (line) => lines.push(line),
    });

    expect(calls).toEqual([{ runId: '2026-08-25-merchgrid-weekly-2026-08-21', through: '2026-08-21' }]);
    expect(lines).toContain('run: 2026-08-25-merchgrid-weekly-2026-08-21');
  });

  it('generates a date-first run id for a daily investigation when run id is omitted', async () => {
    const calls: unknown[] = [];
    const service = {
      startDailyInvestigation: async (input: unknown) => {
        calls.push(input);
        return {
          runId: (input as { runId: string }).runId,
          status: 'awaiting_approval',
          stage: 'approval_wait',
          evidenceRefs: [],
        };
      },
    } as unknown as MerchGridWorkflowService;

    await runMerchGridWorkflowCli({
      args: ['daily-investigate', '--date', '2026-08-21'],
      dependencies: {
        service,
        engine: {} as WorkflowEngine,
        now: () => new Date('2026-08-25T13:00:00.000Z'),
      },
      writeLine: () => undefined,
    });

    expect(calls).toEqual([{ runId: '2026-08-25-merchgrid-daily-2026-08-21', date: '2026-08-21' }]);
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
