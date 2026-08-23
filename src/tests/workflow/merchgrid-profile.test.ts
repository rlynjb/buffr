import { describe, expect, it } from 'vitest';
import { FakeAgentRunner } from '../../agents/runner.js';
import { MerchGridReviewEvidenceSchema, type MerchGridReviewEvidence } from '../../metrics/evidence.js';
import type { MerchGridReviewArtifactRepository } from '../../jobs/merchgrid-source-pack.js';
import { WorkflowRunStateSchema, type WorkflowRunState, type WorkflowRunStateInput } from '../../contracts/workflow.js';
import { createMerchGridModuleExecutor } from '../../agents/merchgrid/modules.js';
import { createWorkflowEngine } from '../../workflow/engine.js';
import { createMerchGridWorkflowService } from '../../workflow/merchgrid-profile.js';
import type { RunRepository } from '../../storage/runs.js';

describe('MerchGrid workflow profile', () => {
  it('returns healthy_no_action without creating a run for a healthy daily artifact', async () => {
    const runs = new InMemoryRunRepository();
    const service = createService({
      runs,
      artifacts: new InMemoryArtifacts({ daily: dailyArtifact({ request_count: 100, error_response_count: 2 }) }),
    });

    await expect(service.startDailyInvestigation({ runId: 'daily-healthy', date: '2026-08-21' }))
      .resolves.toEqual({ outcome: 'healthy_no_action', reason: 'no_material_reliability_concern' });
    expect(runs.created).toEqual([]);
  });

  it('starts an investigation from a saved daily artifact and stops after M4 before M5 or M6', async () => {
    const runs = new InMemoryRunRepository();
    const service = createService({
      runs,
      artifacts: new InMemoryArtifacts({ daily: dailyArtifact({ request_count: 100, error_response_count: 10 }) }),
    });

    const started = await service.startDailyInvestigation({ runId: 'daily-incident', date: '2026-08-21' });
    expect(started).toMatchObject({ workflowKind: 'merchgrid_daily', stage: 'm1_context' });

    await service.engine.step('daily-incident');
    await service.engine.step('daily-incident');
    const settled = await service.engine.step('daily-incident');

    expect(settled).toMatchObject({ stage: 'm4_diagnosis', status: 'waiting_for_data' });
    expect(settled.moduleOutputs.m5).toBeUndefined();
    expect(settled.moduleOutputs.m6).toBeUndefined();
  });

  it('starts a ready weekly recommendation with deterministic M1 context and M2 metrics', async () => {
    const runs = new InMemoryRunRepository();
    const service = createService({
      runs,
      artifacts: new InMemoryArtifacts({
        weekly: {
          '2026-08-21': weeklyArtifact('2026-08-08', '2026-08-14', '2026-08-15', '2026-08-21', 8, 10),
        },
      }),
    });

    const started = await service.startWeeklyRecommendation({ runId: 'weekly-ready', through: '2026-08-21' });
    expect(started).toMatchObject({ workflowKind: 'merchgrid_weekly', stage: 'm1_context' });

    await service.engine.step('weekly-ready');
    const afterMetrics = await service.engine.step('weekly-ready');

    expect(afterMetrics).toMatchObject({
      stage: 'm4_diagnosis',
      moduleOutputs: {
        m1: { product: 'MerchGrid' },
        m2Initial: {
          comparisonQuality: 'valid',
          metrics: [expect.objectContaining({ name: 'posthog.app_opened_count', current: 10, baseline: 8 })],
        },
      },
    });
  });

  it('uses the saved M6 baseline when later weekly evidence is supplied after approval', async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifacts({
      weekly: {
        '2026-08-21': weeklyArtifact('2026-08-08', '2026-08-14', '2026-08-15', '2026-08-21', 8, 10),
        '2026-09-04': weeklyArtifact('2026-08-22', '2026-08-28', '2026-08-29', '2026-09-04', 10, 14),
      },
    });
    const service = createService({ runs, artifacts });

    await service.startWeeklyRecommendation({ runId: 'weekly-approved', through: '2026-08-21' });
    for (let index = 0; index < 5; index += 1) await service.engine.step('weekly-approved');
    await service.engine.approveExperiment('weekly-approved');

    const result = await service.supplyWeeklyResult({ runId: 'weekly-approved', through: '2026-09-04' });

    expect(result).toMatchObject({
      stage: 'm2_metrics_results',
      evidenceSnapshots: { result: { product: 'merchgrid', kind: 'weekly_review' } },
      moduleOutputs: { m6: { primaryMetric: 'posthog.app_opened_count', baselineValue: 10, baselinePeriod: '2026-08-15..2026-08-21' } },
    });

    await service.engine.step('weekly-approved');
    const complete = await service.engine.step('weekly-approved');
    expect(complete).toMatchObject({ stage: 'cycle_complete', status: 'cycle_complete' });
  });

  it('waits for more data when later weekly evidence cannot qualify the frozen primary metric', async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifacts({
      weekly: {
        '2026-08-21': weeklyArtifact('2026-08-08', '2026-08-14', '2026-08-15', '2026-08-21', 8, 10),
        '2026-09-04': weeklyArtifact('2026-08-22', '2026-08-28', '2026-08-29', '2026-09-04', 10, 14, 'partial'),
      },
    });
    const service = createService({ runs, artifacts });

    await service.startWeeklyRecommendation({ runId: 'weekly-incomplete', through: '2026-08-21' });
    for (let index = 0; index < 5; index += 1) await service.engine.step('weekly-incomplete');
    await service.engine.approveExperiment('weekly-incomplete');

    await expect(service.supplyWeeklyResult({ runId: 'weekly-incomplete', through: '2026-09-04' }))
      .resolves.toMatchObject({ stage: 'experiment_wait', status: 'waiting_for_data' });
  });
});

function createService(input: { runs: InMemoryRunRepository; artifacts: MerchGridReviewArtifactRepository }) {
  const modules = createMerchGridModuleExecutor({
    agentRunner: new FakeAgentRunner({
      m4: {
        performancePath: 'profitability',
        primaryBottleneck: 'Fly error rate exceeded the investigation threshold',
        confidence: 'high',
        decision: 'proceed_to_hypothesis',
        notes: [],
      },
      m5: {
        hypothesis: 'Reducing operational errors will improve completed audits.',
        primaryVariable: 'reliability',
        recommendedRevision: 'Investigate the failing request path.',
        keepConstant: [],
        expectedSignal: 'Completed audits increase.',
        notes: [],
      },
      m6: {
        primaryMetric: 'posthog.app_opened_count',
        secondaryMetrics: [],
        baselineValue: 10,
        baselinePeriod: '2026-08-15..2026-08-21',
        qualificationRequirements: ['Use a later completed weekly artifact.'],
        expectedSupportingSignal: 'Weekly app opens increase.',
        expectedWeakeningSignal: 'Weekly app opens decrease.',
        inconclusiveCondition: 'Weekly evidence is incomplete.',
        contextToMonitor: [],
        unresolvedMeasurementRules: [],
      },
      m7: {
        outcome: 'win',
        hypothesisEvaluation: 'supported',
        evidence: ['Weekly app opens increased from 10 to 14.'],
        contextualFactors: [],
        learning: 'The approved reliability change is worth retaining.',
        confidence: 'high',
        knowledgeSource: 'experiment',
        nextAction: 'keep',
        nextActionRationale: 'The primary metric improved against the frozen baseline.',
      },
    }),
  });
  const engine = createWorkflowEngine({ repository: input.runs, modules, now: fixedNow });
  return {
    engine,
    ...createMerchGridWorkflowService({ artifacts: input.artifacts, engine, runRepository: input.runs }),
  };
}

class InMemoryRunRepository implements RunRepository {
  readonly created: WorkflowRunState[] = [];
  private readonly states = new Map<string, WorkflowRunState>();

  async create(state: WorkflowRunStateInput): Promise<void> {
    const parsed = WorkflowRunStateSchema.parse(state);
    this.states.set(parsed.runId, parsed);
    this.created.push(parsed);
  }

  async load(runId: string): Promise<WorkflowRunState> {
    const state = this.states.get(runId);
    if (!state) throw new Error(`Missing run ${runId}`);
    return structuredClone(state);
  }

  async save(state: WorkflowRunStateInput): Promise<void> {
    const parsed = WorkflowRunStateSchema.parse(state);
    this.states.set(parsed.runId, parsed);
  }
}

class InMemoryArtifacts implements MerchGridReviewArtifactRepository {
  constructor(private readonly values: { daily?: MerchGridReviewEvidence; weekly?: Record<string, MerchGridReviewEvidence> }) {}

  async saveDailyHealth(): Promise<string> { throw new Error('not used'); }
  async loadDailyHealth(): Promise<MerchGridReviewEvidence | undefined> { return this.values.daily; }
  async saveWeeklyReview(): Promise<string> { throw new Error('not used'); }
  async loadWeeklyReview(through: string): Promise<MerchGridReviewEvidence | undefined> { return this.values.weekly?.[through]; }
}

function dailyArtifact(flyMetrics: Record<string, number>): MerchGridReviewEvidence {
  return MerchGridReviewEvidenceSchema.parse({
    period: { kind: 'daily', date: '2026-08-21' },
    sourceCoverage: { posthog: 'complete', fly_metrics: 'complete', shopify_partner: 'unavailable' },
    sourceFreshness: {},
    aggregateMetrics: { fly_metrics: flyMetrics },
    limitations: [],
  });
}

function weeklyArtifact(
  previousStart: string,
  previousEnd: string,
  currentStart: string,
  currentEnd: string,
  baselineAppOpens: number,
  currentAppOpens: number,
  posthogStatus: 'complete' | 'partial' = 'complete',
): MerchGridReviewEvidence {
  const posthogCoverage = posthogStatus === 'complete' ? { complete: 7 } : { complete: 6, partial: 1 };
  return MerchGridReviewEvidenceSchema.parse({
    period: {
      kind: 'weekly',
      previous: { startDate: previousStart, endDate: previousEnd },
      current: { startDate: currentStart, endDate: currentEnd },
    },
    sourceCoverage: {
      previous: { posthog: posthogCoverage, fly_metrics: { complete: 7 }, shopify_partner: { complete: 7 } },
      current: { posthog: posthogCoverage, fly_metrics: { complete: 7 }, shopify_partner: { complete: 7 } },
    },
    sourceFreshness: { previous: {}, current: {} },
    aggregateMetrics: {
      previous: { posthog: { app_opened_count: baselineAppOpens } },
      current: { posthog: { app_opened_count: currentAppOpens } },
      change: { posthog: { app_opened_count: currentAppOpens - baselineAppOpens } },
    },
    limitations: [],
  });
}

function fixedNow(): Date {
  return new Date('2026-08-23T00:00:00.000Z');
}
