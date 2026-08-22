import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../core/errors.js';
import {
  DailyMetricSnapshotSchema,
  MetricSourceSchema,
  UtcDateSchema,
  type DailyMetricSnapshot,
  type MetricSource,
} from '../contracts/metrics.js';

export type MetricSnapshotRepository = {
  load(source: MetricSource, date: string): Promise<DailyMetricSnapshot | undefined>;
  save(snapshot: DailyMetricSnapshot): Promise<'created' | 'unchanged' | 'replaced_noncomplete'>;
  list(source: MetricSource, fromDate: string, throughDate: string): Promise<DailyMetricSnapshot[]>;
};

export type JsonFileMetricSnapshotRepositoryOptions = {
  rootDir: string;
};

export class JsonFileMetricSnapshotRepository implements MetricSnapshotRepository {
  private readonly rootDir: string;

  constructor(options: JsonFileMetricSnapshotRepositoryOptions) {
    this.rootDir = options.rootDir;
  }

  async load(source: MetricSource, date: string): Promise<DailyMetricSnapshot | undefined> {
    const validSource = parseSource(source);
    const validDate = parseDate(date);
    const file = this.snapshotFilePath(validSource, validDate);
    let raw: string;

    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return undefined;
      }
      throw new AppError('storage_failed', `Metric snapshot could not be read: ${validSource}/${validDate}`, {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AppError('storage_failed', `Metric snapshot JSON is corrupt: ${validSource}/${validDate}`, {
        cause: error,
      });
    }

    const snapshot = parseSnapshot(parsed, `${validSource}/${validDate}`);
    if (snapshot.source !== validSource || snapshot.date !== validDate) {
      throw new AppError(
        'storage_failed',
        `Metric snapshot content does not match its path: ${validSource}/${validDate}`,
      );
    }
    return snapshot;
  }

  async save(snapshot: DailyMetricSnapshot): Promise<'created' | 'unchanged' | 'replaced_noncomplete'> {
    const validSnapshot = parseSnapshot(snapshot, 'metric snapshot');
    const existing = await this.load(validSnapshot.source, validSnapshot.date);

    if (existing?.status === 'complete') {
      if (isDeepStrictEqual(existing, validSnapshot)) {
        return 'unchanged';
      }
      throw new AppError(
        'storage_failed',
        `Completed metric snapshot is immutable: ${validSnapshot.source}/${validSnapshot.date}`,
      );
    }

    const file = this.snapshotFilePath(validSnapshot.source, validSnapshot.date);
    try {
      await writeAtomic(file, `${JSON.stringify(validSnapshot, null, 2)}\n`);
    } catch (error) {
      throw new AppError(
        'storage_failed',
        `Metric snapshot could not be saved: ${validSnapshot.source}/${validSnapshot.date}`,
        { cause: error },
      );
    }

    return existing ? 'replaced_noncomplete' : 'created';
  }

  async list(source: MetricSource, fromDate: string, throughDate: string): Promise<DailyMetricSnapshot[]> {
    const validSource = parseSource(source);
    const start = parseDate(fromDate);
    const end = parseDate(throughDate);
    const sourceDir = this.sourceDirPath(validSource);
    let entries: string[];

    try {
      entries = await readdir(sourceDir);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }
      throw new AppError('storage_failed', `Metric snapshots could not be listed: ${validSource}`, {
        cause: error,
      });
    }

    const dates = entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter((date) => UtcDateSchema.safeParse(date).success && date >= start && date <= end)
      .sort();

    return Promise.all(dates.map((date) => this.load(validSource, date))).then((snapshots) =>
      snapshots.filter((snapshot): snapshot is DailyMetricSnapshot => snapshot !== undefined),
    );
  }

  private snapshotFilePath(source: MetricSource, date: string): string {
    return join(this.sourceDirPath(source), `${date}.json`);
  }

  private sourceDirPath(source: MetricSource): string {
    return join(this.rootDir, source);
  }
}

async function writeAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempFile = `${path}.${process.pid}.tmp`;
  await writeFile(tempFile, value, 'utf8');
  await rename(tempFile, path);
}

function parseSource(value: unknown): MetricSource {
  const result = MetricSourceSchema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', 'Metric snapshot source failed validation', { cause: result.error });
  }
  return result.data;
}

function parseDate(value: unknown): string {
  const result = UtcDateSchema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', 'Metric snapshot date failed validation', { cause: result.error });
  }
  return result.data;
}

function parseSnapshot(value: unknown, label: string): DailyMetricSnapshot {
  const result = DailyMetricSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', `${label} failed validation`, { cause: result.error });
  }
  return result.data;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
