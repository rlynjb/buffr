import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../core/errors.js';
import { JsonFileRunRepository, type RunRepository } from '../../storage/runs.js';

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

  it('rejects run ids that would escape the configured root', async () => {
    const repository = new JsonFileRunRepository({ rootDir });

    await expect(repository.create({ ...baseState, runId: '../escape' })).rejects.toMatchObject({
      name: 'AppError',
      code: 'storage_failed',
      message: 'Invalid workflow run id: ../escape',
    } satisfies Partial<AppError>);
  });
});

async function mkdtempCompat(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), prefix));
}
