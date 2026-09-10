import type {
  MarketplaceVisibilityProfile,
} from '../contracts/marketplace-visibility.js';
import type { WorkflowStage, WorkflowStatus } from '../contracts/workflow.js';
import { AppError } from '../core/errors.js';
import type {
  MarketplaceEvidencePreparationService,
  MarketplaceReviewInput,
} from './marketplace-evidence-preparation.js';
import type { MarketplaceRollingReviewService } from './marketplace-rolling-review.js';
import {
  marketplaceReviewOperationId,
  type ReviewOperationEventRepository,
} from '../storage/review-operations.js';
import { createWorkflowEvent, type TraceSink } from '../tracing/events.js';

export type { MarketplaceReviewInput } from './marketplace-evidence-preparation.js';

export type MarketplaceReviewResult = {
  operationId: string;
  weeklyArtifactRef: string;
  weeklyArtifactStatus: 'reused' | 'generated';
  previousRun?: {
    runId: string;
    resolution: 'evaluated' | 'not_applied' | 'already_resolved';
  };
  currentRun: {
    runId: string;
    status: WorkflowStatus;
    stage: WorkflowStage;
    experimentPlanRef?: string;
  };
};

export type MarketplaceReviewService = {
  review(input: MarketplaceReviewInput): Promise<MarketplaceReviewResult>;
};

export type MarketplaceReviewDependencies = {
  evidence: MarketplaceEvidencePreparationService;
  rollingReviews: MarketplaceRollingReviewService;
  operations: ReviewOperationEventRepository;
  now?: () => Date;
  emit?: TraceSink['emit'];
};

export function createMarketplaceReviewService(deps: MarketplaceReviewDependencies): MarketplaceReviewService {
  return {
    async review(input) {
      const operationId = marketplaceReviewOperationId(input);
      const record = async (type: string, message: string, data: Record<string, unknown>) => {
        const event = createWorkflowEvent({
          runId: operationId,
          type,
          message,
          data,
          now: deps.now,
        });
        await deps.operations.appendEvent(operationId, event);
        await deps.emit?.(event);
      };

      await record('marketplace_review.started', 'Marketplace review started', {
        profile: input.profile,
        productRef: input.productRef,
        through: input.through,
      });

      let stage: 'evidence_preparation' | 'workflow' = 'evidence_preparation';
      try {
        const prepared = await deps.evidence.prepare(input);
        stage = 'workflow';
        await record('marketplace_review.workflow.started', 'Marketplace review workflow started', {
          profile: input.profile,
          productRef: input.productRef,
          through: input.through,
          artifactRef: prepared.weeklyArtifactRef,
        });
        const result = await deps.rollingReviews.nextReview({
          ...input,
          preparedEvidence: prepared.evidence,
        });
        await record('marketplace_review.workflow.completed', 'Marketplace review workflow completed', {
          currentRunId: result.currentRun.runId,
          status: result.currentRun.status,
          stage: result.currentRun.stage,
          ...(result.previousRun ? { previousRunId: result.previousRun.runId } : {}),
        });

        return {
          operationId,
          weeklyArtifactRef: prepared.weeklyArtifactRef,
          weeklyArtifactStatus: prepared.weeklyArtifactStatus,
          ...result,
        };
      } catch (error) {
        try {
          await record('marketplace_review.failed', 'Marketplace review failed', {
            profile: input.profile,
            productRef: input.productRef,
            through: input.through,
            stage,
            failureCode: error instanceof AppError ? error.code : 'unexpected_error',
          });
        } catch (persistenceError) {
          throw new AppError('storage_failed', 'Marketplace review failure event could not be persisted', {
            cause: { originalError: error, persistenceError },
          });
        }
        throw error;
      }
    },
  };
}

export function reviewInputIdentity(input: MarketplaceReviewInput): {
  profile: MarketplaceVisibilityProfile;
  productRef: string;
  through: string;
} {
  return {
    profile: input.profile,
    productRef: input.productRef,
    through: input.through,
  };
}
