import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../core/errors.js';
import {
  JsonFileMetricSnapshotRepository,
  type MetricSnapshotRepository,
} from '../../storage/metric-snapshots.js';

let rootDir: string;

const completePosthogSnapshot = {
  source: 'posthog' as const,
  date: '2026-08-21',
  collectedAt: '2026-08-22T00:05:00.000Z',
  status: 'complete' as const,
  metrics: { app_opened_count: 8 },
  notes: [],
};

beforeEach(async () => {
  rootDir = await mkdtempCompat('buffr-metric-snapshots-');
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('JsonFileMetricSnapshotRepository', () => {
  it('stores and loads a snapshot at its source/date path', async () => {
    const repository: MetricSnapshotRepository = new JsonFileMetricSnapshotRepository({ rootDir });

    await expect(repository.save(completePosthogSnapshot)).resolves.toBe('created');
    await expect(repository.load('posthog', '2026-08-21')).resolves.toEqual(completePosthogSnapshot);
    await expect(readFile(join(rootDir, 'posthog', '2026-08-21.json'), 'utf8')).resolves.toContain(
      '"app_opened_count": 8',
    );
  });

  it('does not duplicate a successful source/date snapshot', async () => {
    const repository = new JsonFileMetricSnapshotRepository({ rootDir });

    await repository.save(completePosthogSnapshot);

    await expect(repository.save(completePosthogSnapshot)).resolves.toBe('unchanged');
  });

  it('replaces an incomplete source/date snapshot with a complete snapshot', async () => {
    const repository = new JsonFileMetricSnapshotRepository({ rootDir });
    await repository.save({ ...completePosthogSnapshot, status: 'partial', metrics: {} });

    await expect(repository.save(completePosthogSnapshot)).resolves.toBe('replaced_noncomplete');
    await expect(repository.load('posthog', '2026-08-21')).resolves.toEqual(completePosthogSnapshot);
  });

  it('rejects a different complete snapshot for a completed source/date', async () => {
    const repository = new JsonFileMetricSnapshotRepository({ rootDir });
    await repository.save(completePosthogSnapshot);

    await expect(
      repository.save({ ...completePosthogSnapshot, metrics: { app_opened_count: 9 } }),
    ).rejects.toMatchObject({
      name: 'AppError',
      code: 'storage_failed',
    } satisfies Partial<AppError>);
  });

  it('rejects a stored snapshot whose content does not match its source/date path', async () => {
    await mkdir(join(rootDir, 'posthog'), { recursive: true });
    await writeFile(
      join(rootDir, 'posthog', '2026-08-21.json'),
      JSON.stringify({ ...completePosthogSnapshot, source: 'fly_metrics' }),
      'utf8',
    );
    const repository = new JsonFileMetricSnapshotRepository({ rootDir });

    await expect(repository.load('posthog', '2026-08-21')).rejects.toMatchObject({
      name: 'AppError',
      code: 'storage_failed',
    } satisfies Partial<AppError>);
  });
});

async function mkdtempCompat(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), prefix));
}
