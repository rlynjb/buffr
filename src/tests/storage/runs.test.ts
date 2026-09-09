import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../core/errors.js';
import {
  JsonFileRunRepository,
  type MarketplaceRunHistoryRepository,
  type RunRepository,
} from '../../storage/runs.js';

let rootDir: string;

const baseState = {
  runId: 'run-123',
  listingId: 'listing-123',
  subjectRef: 'listing:listing-123',
  workflowKind: 'etsy_listing' as const,
  status: 'analyzing' as const,
  stage: 'm1_context' as const,
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
  evidenceRefs: [],
  moduleOutputs: {},
  events: [],
};

beforeEach(async () => {
  rootDir = await mkdtempCompat('buffr-runs-');
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('JsonFileRunRepository', () => {
  it('creates and loads a workflow run as readable JSON', async () => {
    const repository: RunRepository = new JsonFileRunRepository({ rootDir });

    await repository.create(baseState);

    expect(await repository.load('run-123')).toEqual({ ...baseState, moduleOutputs: { m3: [] } });
    const persisted = await readFile(join(rootDir, 'run-123', 'run.json'), 'utf8');
    expect(persisted).toContain('\n  "runId": "run-123"');
    expect(persisted.endsWith('\n')).toBe(true);
  });

  it('saves updated state and reloads it', async () => {
    const repository = new JsonFileRunRepository({ rootDir });
    await repository.create(baseState);

    await repository.save({
      ...baseState,
      status: 'ready_for_experiment',
      stage: 'experiment_wait',
      updatedAt: '2026-08-12T00:10:00.000Z',
      evidenceRefs: ['initial'],
    });

    expect(await repository.load('run-123')).toMatchObject({
      status: 'ready_for_experiment',
      stage: 'experiment_wait',
      evidenceRefs: ['initial'],
    });
  });

  it('rejects a duplicate create without overwriting the existing run', async () => {
    const repository = new JsonFileRunRepository({ rootDir });
    await repository.create(baseState);

    await expect(repository.create({
      ...baseState,
      status: 'ready_for_experiment',
      stage: 'experiment_wait',
      updatedAt: '2026-08-12T00:10:00.000Z',
    })).rejects.toMatchObject({
      code: 'storage_failed',
      message: 'Workflow run already exists: run-123',
    });
    await expect(repository.load('run-123')).resolves.toMatchObject({
      status: 'analyzing',
      stage: 'm1_context',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
  });

  it('throws a clear AppError for a missing run', async () => {
    const repository = new JsonFileRunRepository({ rootDir });

    await expect(repository.load('missing-run')).rejects.toMatchObject({
      name: 'AppError',
      code: 'storage_failed',
      message: 'Workflow run not found: missing-run',
    } satisfies Partial<AppError>);
  });

  it('rejects corrupt JSON with a clear AppError', async () => {
    await mkdir(join(rootDir, 'run-123'), { recursive: true });
    await writeFile(join(rootDir, 'run-123', 'run.json'), '{not json', 'utf8');
    const repository = new JsonFileRunRepository({ rootDir });

    await expect(repository.load('run-123')).rejects.toMatchObject({
      name: 'AppError',
      code: 'storage_failed',
      message: 'Workflow run JSON is corrupt: run-123',
    } satisfies Partial<AppError>);
  });

  it('rejects schema-invalid JSON with a validation AppError', async () => {
    await mkdir(join(rootDir, 'run-123'), { recursive: true });
    await writeFile(
      join(rootDir, 'run-123', 'run.json'),
      JSON.stringify({ ...baseState, status: 'not-a-status' }, null, 2),
      'utf8',
    );
    const repository = new JsonFileRunRepository({ rootDir });

    await expect(repository.load('run-123')).rejects.toMatchObject({
      name: 'AppError',
      code: 'validation_failed',
      message: 'workflow run run-123 failed validation',
    } satisfies Partial<AppError>);
  });

  it('does not leave temporary files after successful writes', async () => {
    const repository = new JsonFileRunRepository({ rootDir });

    await repository.create(baseState);
    await repository.save({ ...baseState, updatedAt: '2026-08-12T00:11:00.000Z' });

    const files = await readdir(join(rootDir, 'run-123'));
    expect(files).toEqual(['run.json']);
  });

  it('persists experiment plans with run metadata while preserving the plan fields', async () => {
    const repository = new JsonFileRunRepository({ rootDir });

    await repository.create({
      ...baseState,
      runId: 'visibility-2026-08-07',
      subjectRef: 'merchgrid:visibility:2026-08-07',
      workflowKind: 'marketplace_visibility_review',
      status: 'awaiting_approval',
      stage: 'approval_wait',
      createdAt: '2026-08-25T13:46:22.431Z',
      updatedAt: '2026-08-25T13:46:48.685Z',
      evidenceRefs: ['initial:marketplace_visibility:merchgrid_shopify_app_store:merchgrid:visibility:2026-08-07'],
      moduleOutputs: {
        m6: {
          primaryMetric: 'scan_started_count',
          secondaryMetrics: ['app_opened_count'],
          baselineValue: 0,
          baselinePeriod: 'sparse pre-test snapshot captured by 2026-08-25 evidence',
          qualificationRequirements: ['Record exact listing copy before the test'],
          expectedSupportingSignal: 'More qualified app opens and scan starts appear after the listing copy change',
          expectedWeakeningSignal: 'App opens or scan starts remain flat after the listing copy change',
          inconclusiveCondition: 'Traffic remains too sparse to distinguish signal from noise',
          contextToMonitor: ['listing copy changed only once'],
          unresolvedMeasurementRules: [],
        },
      },
    });

    const experimentPlanJson = await readFile(join(rootDir, 'visibility-2026-08-07', 'experiment-plan.json'), 'utf8');

    expect(JSON.parse(experimentPlanJson)).toMatchObject({
      metadata: {
        artifactKind: 'experiment_plan',
        runId: 'visibility-2026-08-07',
        workflowKind: 'marketplace_visibility_review',
        subjectRef: 'merchgrid:visibility:2026-08-07',
        status: 'awaiting_approval',
        stage: 'approval_wait',
        evidenceDate: '2026-08-07',
        generatedAt: '2026-08-25T13:46:48.685Z',
        runCreatedAt: '2026-08-25T13:46:22.431Z',
        evidenceRefs: ['initial:marketplace_visibility:merchgrid_shopify_app_store:merchgrid:visibility:2026-08-07'],
      },
      primaryMetric: 'scan_started_count',
    });
  });

  it('writes only sorted M3 citation references into the experiment plan', async () => {
    const repository = new JsonFileRunRepository({ rootDir });

    await repository.create({
      ...baseState,
      status: 'awaiting_approval',
      stage: 'approval_wait',
      moduleOutputs: {
        m3: [
          {
            status: 'resolved',
            next_action: 'stop',
            requester: 'm4',
            question: 'Synthetic policy question',
            evidence: [
              {
                source: 'web',
                title: 'Second guide',
                url: 'https://docs.example.test/z-guide',
                excerpt: 'Synthetic evidence.',
                fetchedAt: '2026-08-31T00:00:00.000Z',
              },
              {
                source: 'web',
                title: 'First guide',
                url: 'https://docs.example.test/a-guide',
                excerpt: 'Synthetic evidence.',
                fetchedAt: '2026-08-31T00:00:00.000Z',
              },
              {
                source: 'web',
                title: 'Duplicate guide',
                url: 'https://docs.example.test/a-guide',
                excerpt: 'Synthetic evidence.',
                fetchedAt: '2026-08-31T00:00:00.000Z',
              },
            ],
            confidence: 'low',
            limitations: [],
          },
        ],
        m6: testPlanOutput(),
      },
    });

    const plan = JSON.parse(await readFile(join(rootDir, 'run-123', 'experiment-plan.json'), 'utf8'));
    expect(plan.metadata.researchRefs).toEqual([
      {
        m3Index: 0,
        urls: ['https://docs.example.test/a-guide', 'https://docs.example.test/z-guide'],
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain('<html>');
  });

  it('keeps experiment plans without research references compatible', async () => {
    const repository = new JsonFileRunRepository({ rootDir });
    await repository.create({
      ...baseState,
      status: 'awaiting_approval',
      stage: 'approval_wait',
      moduleOutputs: { m3: [], m6: testPlanOutput() },
    });

    const run = await repository.load('run-123');
    const plan = JSON.parse(await readFile(join(rootDir, 'run-123', 'experiment-plan.json'), 'utf8'));
    expect(run.moduleOutputs.m3).toEqual([]);
    expect(plan.metadata).not.toHaveProperty('researchRefs');
  });

  it('rejects run ids that would escape the configured root', async () => {
    const repository = new JsonFileRunRepository({ rootDir });

    await expect(repository.create({ ...baseState, runId: '../escape' })).rejects.toMatchObject({
      name: 'AppError',
      code: 'storage_failed',
      message: 'Invalid workflow run id: ../escape',
    } satisfies Partial<AppError>);
  });

  it('returns undefined when no run matches the exact product identity', async () => {
    const repository: MarketplaceRunHistoryRepository = new JsonFileRunRepository({ rootDir });

    await repository.create(rollingRun('other-product', '2026-09-08T00:00:00.000Z', 'other-app'));

    await expect(repository.findLatestByProduct(rollingIdentity())).resolves.toBeUndefined();
  });

  it('finds only the newest exact profile and productRef match', async () => {
    const repository: MarketplaceRunHistoryRepository = new JsonFileRunRepository({ rootDir });

    await repository.create(rollingRun('older', '2026-09-01T00:00:00.000Z'));
    await repository.create(rollingRun('newer', '2026-09-08T00:00:00.000Z'));
    await repository.create(rollingRun('other-product', '2026-09-09T00:00:00.000Z', 'other-app'));

    await expect(repository.findLatestByProduct(rollingIdentity())).resolves.toMatchObject({ runId: 'newer' });
  });

  it('isolates runs by marketplace profile', async () => {
    const repository: MarketplaceRunHistoryRepository = new JsonFileRunRepository({ rootDir });

    await repository.create(rollingRun('shopify', '2026-09-08T00:00:00.000Z'));
    await repository.create(rollingRun('etsy', '2026-09-09T00:00:00.000Z', 'merchgrid-shopify-app', 'etsy_listing'));

    await expect(repository.findLatestByProduct(rollingIdentity())).resolves.toMatchObject({ runId: 'shopify' });
  });

  it('isolates runs by productRef', async () => {
    const repository: MarketplaceRunHistoryRepository = new JsonFileRunRepository({ rootDir });

    await repository.create(rollingRun('target', '2026-09-08T00:00:00.000Z'));
    await repository.create(rollingRun('other', '2026-09-09T00:00:00.000Z', 'other-app'));

    await expect(repository.findLatestByProduct(rollingIdentity())).resolves.toMatchObject({ runId: 'target' });
  });

  it('chooses the newest createdAt before comparing run ids', async () => {
    const repository: MarketplaceRunHistoryRepository = new JsonFileRunRepository({ rootDir });

    await repository.create(rollingRun('newer-id', '2026-09-09T00:00:00.000Z'));
    await repository.create(rollingRun('older-id', '2026-09-08T00:00:00.000Z'));

    await expect(repository.findLatestByProduct(rollingIdentity())).resolves.toMatchObject({ runId: 'newer-id' });
  });

  it('breaks createdAt ties deterministically by descending runId', async () => {
    const repository: MarketplaceRunHistoryRepository = new JsonFileRunRepository({ rootDir });

    await repository.create(rollingRun('run-a', '2026-09-08T00:00:00.000Z'));
    await repository.create(rollingRun('run-z', '2026-09-08T00:00:00.000Z'));

    await expect(repository.findLatestByProduct(rollingIdentity())).resolves.toMatchObject({ runId: 'run-z' });
  });

  it('omits valid legacy runs without marketplace identity', async () => {
    const repository: MarketplaceRunHistoryRepository = new JsonFileRunRepository({ rootDir });

    await repository.create({ ...baseState, runId: 'legacy', createdAt: '2026-09-09T00:00:00.000Z' });
    await repository.create(rollingRun('identified', '2026-09-08T00:00:00.000Z'));

    await expect(repository.findLatestByProduct(rollingIdentity())).resolves.toMatchObject({ runId: 'identified' });
  });

  it('fails visibly when a discovered candidate is corrupt', async () => {
    const repository: MarketplaceRunHistoryRepository = new JsonFileRunRepository({ rootDir });

    await repository.create(rollingRun('valid', '2026-09-08T00:00:00.000Z'));
    await mkdir(join(rootDir, 'corrupt'), { recursive: true });
    await writeFile(join(rootDir, 'corrupt', 'run.json'), '{not json', 'utf8');

    await expect(repository.findLatestByProduct(rollingIdentity())).rejects.toMatchObject({
      name: 'AppError',
      code: 'storage_failed',
      message: 'Workflow run JSON is corrupt: corrupt',
    } satisfies Partial<AppError>);
  });

  it('returns undefined when the configured run root does not exist', async () => {
    const repository: MarketplaceRunHistoryRepository = new JsonFileRunRepository({ rootDir });
    await rm(rootDir, { recursive: true, force: true });

    await expect(repository.findLatestByProduct(rollingIdentity())).resolves.toBeUndefined();
  });
});

function rollingIdentity() {
  return {
    profile: 'merchgrid_shopify_app_store' as const,
    productRef: 'merchgrid-shopify-app',
  };
}

function rollingRun(
  runId: string,
  createdAt: string,
  productRef = 'merchgrid-shopify-app',
  workflowKind: 'marketplace_visibility_review' | 'etsy_listing' = 'marketplace_visibility_review',
) {
  return {
    ...baseState,
    runId,
    createdAt,
    updatedAt: createdAt,
    workflowKind,
    marketplaceIdentity: {
      profile: workflowKind === 'etsy_listing' ? 'etsy_listing' as const : 'merchgrid_shopify_app_store' as const,
      productRef,
    },
  };
}

async function mkdtempCompat(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), prefix));
}

function testPlanOutput() {
  return {
    primaryMetric: 'visibility_count',
    secondaryMetrics: [],
    baselineValue: 0,
    baselinePeriod: 'synthetic baseline',
    qualificationRequirements: [],
    expectedSupportingSignal: 'A later signal appears.',
    expectedWeakeningSignal: 'The signal remains absent.',
    inconclusiveCondition: 'Evidence remains sparse.',
    contextToMonitor: [],
    unresolvedMeasurementRules: [],
  };
}
