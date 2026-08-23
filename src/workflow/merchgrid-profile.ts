import { UtcDateSchema } from '../contracts/metrics.js';
import { parseMerchGridWorkflowEvidence } from '../contracts/merchgrid-workflow.js';
import { AppError } from '../core/errors.js';
import type { MerchGridReviewArtifactRepository } from '../jobs/merchgrid-source-pack.js';
import { evaluateDailyReadiness, evaluateWeeklyReadiness, type DailyReadiness } from './merchgrid-readiness.js';
import type { WorkflowEngine } from './engine.js';
import type { WorkflowRunState } from '../contracts/workflow.js';
import type { RunRepository } from '../storage/runs.js';
import { metricsFromMerchGridResult } from '../agents/merchgrid/modules.js';

export type MerchGridWorkflowService = {
  startDailyInvestigation(input: { runId: string; date: string }): Promise<DailyReadiness | WorkflowRunState>;
  startWeeklyRecommendation(input: { runId: string; through: string }): Promise<WorkflowRunState>;
  supplyWeeklyResult(input: { runId: string; through: string }): Promise<WorkflowRunState>;
};

/** Facade for loading validated local MerchGrid artifacts and entering the shared workflow engine. */
export function createMerchGridWorkflowService(deps: {
  artifacts: MerchGridReviewArtifactRepository;
  engine: WorkflowEngine;
  runRepository: RunRepository;
}): MerchGridWorkflowService {
  return {
    async startDailyInvestigation(input) {
      const date = UtcDateSchema.parse(input.date);
      const artifact = await deps.artifacts.loadDailyHealth(date);
      if (!artifact) {
        throw new AppError('storage_failed', `MerchGrid daily health artifact not found: ${date}`);
      }
      const evidence = parseMerchGridWorkflowEvidence(artifact, dailyArtifactRef(date));
      const readiness = evaluateDailyReadiness(evidence);
      if (readiness.outcome !== 'investigate') {
        return readiness;
      }
      return deps.engine.startMerchGrid({
        runId: input.runId,
        subjectRef: `merchgrid:daily:${date}`,
        workflowKind: 'merchgrid_daily',
        initialEvidence: evidence,
      });
    },

    async startWeeklyRecommendation(input) {
      const through = UtcDateSchema.parse(input.through);
      const artifact = await deps.artifacts.loadWeeklyReview(through);
      if (!artifact) {
        throw new AppError('storage_failed', `MerchGrid weekly review artifact not found: ${through}`);
      }
      const evidence = parseMerchGridWorkflowEvidence(artifact, weeklyArtifactRef(through));
      const readiness = evaluateWeeklyReadiness(evidence);
      if (readiness.outcome !== 'ready') {
        throw new AppError('validation_failed', `MerchGrid weekly review is not ready: ${readiness.reason}`);
      }
      return deps.engine.startMerchGrid({
        runId: input.runId,
        subjectRef: `merchgrid:weekly:${through}`,
        workflowKind: 'merchgrid_weekly',
        initialEvidence: evidence,
      });
    },

    async supplyWeeklyResult(input) {
      const through = UtcDateSchema.parse(input.through);
      const state = await deps.runRepository.load(input.runId);
      const artifact = await deps.artifacts.loadWeeklyReview(through);
      if (!artifact) {
        throw new AppError('storage_failed', `MerchGrid weekly review artifact not found: ${through}`);
      }
      const evidence = parseMerchGridWorkflowEvidence(artifact, weeklyArtifactRef(through));
      const resultMetrics = metricsFromMerchGridResult(state, evidence);
      if (resultMetrics.comparisonQuality !== 'valid') {
        return deps.engine.waitForMoreData({
          runId: input.runId,
          reason: resultMetrics.unresolvedQualificationNeeds.join('; '),
        });
      }
      return deps.engine.resumeWithExperimentResults({ runId: input.runId, resultEvidence: evidence });
    },
  };
}

function dailyArtifactRef(date: string): string {
  return `.local/merchgrid-metrics/artifacts/daily-health/${date}.json`;
}

function weeklyArtifactRef(through: string): string {
  return `.local/merchgrid-metrics/artifacts/weekly-reviews/${through}.json`;
}
