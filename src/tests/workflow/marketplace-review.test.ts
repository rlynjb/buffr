import { describe, expect, it } from 'vitest';
import type { WorkflowEvent } from '../../contracts/workflow.js';
import { AppError } from '../../core/errors.js';
import type { MarketplaceEvidencePreparationService } from '../../workflow/marketplace-evidence-preparation.js';
import type { MarketplaceRollingReviewService } from '../../workflow/marketplace-rolling-review.js';
import {
  createMarketplaceReviewService,
  type MarketplaceReviewInput,
} from '../../workflow/marketplace-review.js';
import type { ReviewOperationEventRepository } from '../../storage/review-operations.js';

describe('marketplace review facade', () => {
  it('persists bounded command and workflow events around a successful review', async () => {
    const fixture = createFixture();

    const result = await fixture.service.review(reviewInput());

    expect(result).toMatchObject({
      operationId: 'marketplace-review:merchgrid_shopify_app_store:merchgrid-shopify-app:2026-09-04',
      weeklyArtifactRef: 'artifacts/merchgrid/metrics/artifacts/weekly-reviews/2026-09-04.json',
      weeklyArtifactStatus: 'generated',
      currentRun: { runId: '2026-09-04-merchgrid_shopify_app_store-merchgrid-shopify-app' },
    });
    expect(fixture.persistedEvents.map((event) => event.type)).toEqual([
      'marketplace_review.started',
      'marketplace_review.workflow.started',
      'marketplace_review.workflow.completed',
    ]);
    expect(fixture.emittedEvents.map((event) => event.type)).toEqual(fixture.persistedEvents.map((event) => event.type));
    expect(JSON.stringify(fixture.persistedEvents)).not.toMatch(/secret|token|rawEvents|providerPayload|prompt/iu);
  });

  it('persists bounded failure events when evidence prep fails before workflow start', async () => {
    const fixture = createFixture({
      evidence: {
        async prepare() {
          throw new AppError('storage_failed', 'Missing weekly metric snapshots (1): posthog/2026-09-04');
        },
      } as MarketplaceEvidencePreparationService,
    });

    await expect(fixture.service.review(reviewInput())).rejects.toMatchObject({ code: 'storage_failed' });

    expect(fixture.rollingCalls).toEqual([]);
    expect(fixture.persistedEvents.map((event) => event.type)).toEqual([
      'marketplace_review.started',
      'marketplace_review.failed',
    ]);
    expect(fixture.persistedEvents.at(-1)?.data).toMatchObject({
      failureCode: 'storage_failed',
      stage: 'evidence_preparation',
    });
  });

  it('persists bounded failure events when the rolling workflow fails after evidence prep', async () => {
    const fixture = createFixture({ rollingFails: true });

    await expect(fixture.service.review(reviewInput())).rejects.toMatchObject({ code: 'route_not_allowed' });

    expect(fixture.rollingCalls).toHaveLength(1);
    expect(fixture.persistedEvents.map((event) => event.type)).toEqual([
      'marketplace_review.started',
      'marketplace_review.workflow.started',
      'marketplace_review.failed',
    ]);
    expect(fixture.persistedEvents.at(-1)?.data).toMatchObject({
      failureCode: 'route_not_allowed',
      stage: 'workflow',
    });
  });

  it('uses the same operation id for the same logical review cycle', async () => {
    const fixture = createFixture();

    const first = await fixture.service.review(reviewInput());
    const second = await fixture.service.review(reviewInput());

    expect(second.operationId).toBe(first.operationId);
  });

  function createFixture(input: {
    evidence?: MarketplaceEvidencePreparationService;
    rolling?: MarketplaceRollingReviewService;
    rollingFails?: boolean;
  } = {}) {
    const persistedEvents: WorkflowEvent[] = [];
    const emittedEvents: WorkflowEvent[] = [];
    const rollingCalls: MarketplaceReviewInput[] = [];
    const evidence = input.evidence ?? {
      async prepare(review) {
        return {
          profile: review.profile,
          productRef: review.productRef,
          through: review.through,
          windowStart: '2026-08-22',
          windowEnd: review.through,
          weeklyArtifactRef: 'artifacts/merchgrid/metrics/artifacts/weekly-reviews/2026-09-04.json',
          weeklyArtifactStatus: 'generated' as const,
          missingSnapshotCount: 0,
          collectedSnapshotCount: 1,
          reusedSnapshotCount: 41,
          evidence: {} as never,
        };
      },
    };
    const rolling = input.rolling ?? {
      async nextReview(review) {
        rollingCalls.push(review);
        if (input.rollingFails) {
          throw new AppError('route_not_allowed', 'Previous marketplace review is unresolved');
        }
        return {
          currentRun: {
            runId: '2026-09-04-merchgrid_shopify_app_store-merchgrid-shopify-app',
            status: 'awaiting_approval' as const,
            stage: 'approval_wait' as const,
          },
        };
      },
    };
    const operations: ReviewOperationEventRepository = {
      async appendEvent(_operationId, event) {
        persistedEvents.push(event);
      },
      async loadEvents() {
        return persistedEvents;
      },
    };
    return {
      service: createMarketplaceReviewService({
        evidence,
        rollingReviews: rolling,
        operations,
        now: fixedNow,
        emit: (event) => {
          emittedEvents.push(event);
        },
      }),
      persistedEvents,
      emittedEvents,
      rollingCalls,
    };
  }
});

function reviewInput(): MarketplaceReviewInput {
  return {
    profile: 'merchgrid_shopify_app_store',
    productRef: 'merchgrid-shopify-app',
    through: '2026-09-04',
    contextPath: 'artifacts/merchgrid/context/merchgrid-visibility-context.json',
  };
}

function fixedNow(): Date {
  return new Date('2026-09-05T00:00:00.000Z');
}
