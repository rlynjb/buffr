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
