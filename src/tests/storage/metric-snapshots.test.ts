import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyMetricSnapshot } from '../../contracts/metrics.js';
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
  vi.useRealTimers();
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

  it('does not persist a content-bearing note', async () => {
    const repository = new JsonFileMetricSnapshotRepository({ rootDir });
    const invalidSnapshot = {
      ...completePosthogSnapshot,
      notes: ['merchant@example.com'],
    } as unknown as DailyMetricSnapshot;

    await expect(repository.save(invalidSnapshot)).rejects.toMatchObject({
      name: 'AppError',
      code: 'validation_failed',
    } satisfies Partial<AppError>);
    await expect(repository.load('posthog', '2026-08-21')).resolves.toBeUndefined();
  });

  it('rejects current and future snapshots while allowing past-date backfills', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));
    const repository = new JsonFileMetricSnapshotRepository({ rootDir });

    await expect(
      repository.save({ ...completePosthogSnapshot, date: '2026-08-22' }),
    ).rejects.toMatchObject({ name: 'AppError', code: 'validation_failed' } satisfies Partial<AppError>);
    await expect(
      repository.save({ ...completePosthogSnapshot, date: '2026-08-23' }),
    ).rejects.toMatchObject({ name: 'AppError', code: 'validation_failed' } satisfies Partial<AppError>);
    await expect(repository.save(completePosthogSnapshot)).resolves.toBe('created');
  });

  it('serializes concurrent complete saves for the same source/date', async () => {
    const firstRepository = new JsonFileMetricSnapshotRepository({ rootDir });
    const secondRepository = new JsonFileMetricSnapshotRepository({ rootDir });
    const conflictingSnapshot = {
      ...completePosthogSnapshot,
      metrics: { app_opened_count: 9 },
    };

    const results = await Promise.allSettled([
      firstRepository.save(completePosthogSnapshot),
      secondRepository.save(conflictingSnapshot),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: {
        name: 'AppError',
        code: 'storage_failed',
        message: 'Completed metric snapshot is immutable: posthog/2026-08-21',
      },
    });
    const expectedWinner = results[0]?.status === 'fulfilled' ? completePosthogSnapshot : conflictingSnapshot;
    await expect(firstRepository.load('posthog', '2026-08-21')).resolves.toEqual(expectedWinner);
  });

  it('fails safely without writing when another process holds the snapshot filesystem lock', async () => {
    const snapshotDirectory = join(rootDir, 'posthog');
    const snapshotPath = join(snapshotDirectory, '2026-08-21.json');
    await mkdir(snapshotDirectory, { recursive: true });
    await mkdir(`${snapshotPath}.lock`);
    const repository = new JsonFileMetricSnapshotRepository({
      rootDir,
      lockTimeoutMs: 0,
      lockRetryMs: 1,
    });

    await expect(repository.save(completePosthogSnapshot)).rejects.toMatchObject({
      name: 'AppError',
      code: 'storage_failed',
      message: 'Metric snapshot is locked by another writer: posthog/2026-08-21',
    } satisfies Partial<AppError>);
    await expect(repository.load('posthog', '2026-08-21')).resolves.toBeUndefined();
  });
});

async function mkdtempCompat(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), prefix));
}
