import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCompletedUtcWindow,
  DailyMetricSnapshotSchema,
} from '../../contracts/metrics.js';

const completePosthogSnapshot = {
  source: 'posthog',
  date: '2026-08-21',
  collectedAt: '2026-08-22T00:05:00.000Z',
  status: 'complete',
  metrics: { app_opened_count: 8, scan_completion_rate: 0.75 },
  notes: ['backfill'],
};

describe('metric contracts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates an exact completed UTC window', () => {
    expect(createCompletedUtcWindow('2026-08-21')).toEqual({
      date: '2026-08-21',
      startInclusive: '2026-08-21T00:00:00.000Z',
      endExclusive: '2026-08-22T00:00:00.000Z',
    });
  });

  it('accepts a bounded aggregate snapshot', () => {
    expect(DailyMetricSnapshotSchema.parse(completePosthogSnapshot)).toEqual(completePosthogSnapshot);
  });

  it('rejects invalid dates, timestamps, and metric values', () => {
    expect(() =>
      DailyMetricSnapshotSchema.parse({ ...completePosthogSnapshot, date: '2026-02-30' }),
    ).toThrow();
    expect(() =>
      DailyMetricSnapshotSchema.parse({ ...completePosthogSnapshot, collectedAt: 'not-a-timestamp' }),
    ).toThrow();
    expect(() =>
      DailyMetricSnapshotSchema.parse({ ...completePosthogSnapshot, metrics: { app_opened_count: -1 } }),
    ).toThrow();
    expect(() =>
      DailyMetricSnapshotSchema.parse({ ...completePosthogSnapshot, metrics: { app_opened_count: Infinity } }),
    ).toThrow();
  });

  it('rejects overlong notes and sensitive keys in aggregate metadata', () => {
    expect(() =>
      DailyMetricSnapshotSchema.parse({
        ...completePosthogSnapshot,
        notes: Array.from({ length: 13 }, () => 'bounded'),
      }),
    ).toThrow();
    expect(() =>
      DailyMetricSnapshotSchema.parse({
        ...completePosthogSnapshot,
        metrics: { response_count: 8 },
      }),
    ).toThrow();
  });

  it('rejects content-bearing note values while allowing bounded operational labels', () => {
    expect(
      DailyMetricSnapshotSchema.parse({
        ...completePosthogSnapshot,
        notes: ['authentication', 'manual_import'],
      }).notes,
    ).toEqual(['authentication', 'manual_import']);
    expect(() =>
      DailyMetricSnapshotSchema.parse({ ...completePosthogSnapshot, notes: ['merchant@example.com'] }),
    ).toThrow();
    expect(() =>
      DailyMetricSnapshotSchema.parse({
        ...completePosthogSnapshot,
        notes: ['{"payload":{"email":"merchant@example.com"}}'],
      }),
    ).toThrow();
  });

  it('rejects current and future UTC windows while retaining explicit past-date backfills', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));

    expect(() => createCompletedUtcWindow('2026-08-22')).toThrow();
    expect(() => createCompletedUtcWindow('2026-08-23')).toThrow();
    expect(createCompletedUtcWindow('2026-08-21').date).toBe('2026-08-21');
  });
});
