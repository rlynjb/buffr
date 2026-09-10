import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowEvent } from '../../tracing/events.js';
import {
  JsonFileReviewOperationEventRepository,
  marketplaceReviewOperationId,
} from '../../storage/review-operations.js';

describe('review operation event repository', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('builds deterministic marketplace review operation ids', () => {
    expect(marketplaceReviewOperationId({
      profile: 'merchgrid_shopify_app_store',
      productRef: 'merchgrid-shopify-app',
      through: '2026-09-04',
    })).toBe('marketplace-review:merchgrid_shopify_app_store:merchgrid-shopify-app:2026-09-04');
  });

  it('appends and loads review operation events in order', async () => {
    const rootDir = await temporaryRoot();
    const repository = new JsonFileReviewOperationEventRepository({ rootDir });
    const operationId = marketplaceReviewOperationId({
      profile: 'merchgrid_shopify_app_store',
      productRef: 'merchgrid-shopify-app',
      through: '2026-09-04',
    });

    await repository.appendEvent(operationId, event(operationId, 'marketplace_review.started'));
    await repository.appendEvent(operationId, event(operationId, 'marketplace_review.workflow.completed'));

    await expect(repository.loadEvents(operationId)).resolves.toMatchObject([
      { runId: operationId, type: 'marketplace_review.started' },
      { runId: operationId, type: 'marketplace_review.workflow.completed' },
    ]);
  });

  it('returns no events for a missing review operation', async () => {
    const repository = new JsonFileReviewOperationEventRepository({ rootDir: await temporaryRoot() });

    await expect(repository.loadEvents('marketplace-review:merchgrid_shopify_app_store:merchgrid-shopify-app:2026-09-04'))
      .resolves.toEqual([]);
  });

  it('surfaces corrupt review operation JSONL as a storage failure', async () => {
    const rootDir = await temporaryRoot();
    const repository = new JsonFileReviewOperationEventRepository({ rootDir });
    const operationId = 'marketplace-review:merchgrid_shopify_app_store:merchgrid-shopify-app:2026-09-04';
    const operationDir = join(rootDir, 'review-operations', encodeURIComponent(operationId));
    await mkdir(operationDir, { recursive: true });
    await writeFile(join(operationDir, 'events.jsonl'), '{"eventId":\n', 'utf8');

    await expect(repository.loadEvents(operationId)).rejects.toMatchObject({
      code: 'storage_failed',
      message: `Review operation events JSONL is corrupt: ${operationId}`,
    });
  });

  it('keeps credential-like event data out through workflow event validation', async () => {
    expect(() => createWorkflowEvent({
      runId: 'marketplace-review:merchgrid_shopify_app_store:merchgrid-shopify-app:2026-09-04',
      type: 'marketplace_review.failed',
      message: 'Marketplace review failed',
      data: { apiKey: 'not persisted' },
      now: fixedNow,
    })).toThrow();
  });

  async function temporaryRoot(): Promise<string> {
    const rootDir = await mkdtemp(join(tmpdir(), 'review-operations-'));
    temporaryDirectories.push(rootDir);
    return rootDir;
  }
});

function event(runId: string, type: string) {
  return createWorkflowEvent({
    runId,
    type,
    message: type,
    data: { profile: 'merchgrid_shopify_app_store', productRef: 'merchgrid-shopify-app', through: '2026-09-04' },
    now: fixedNow,
  });
}

function fixedNow(): Date {
  return new Date('2026-09-05T00:00:00.000Z');
}
