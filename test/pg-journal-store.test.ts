import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, after } from 'node:test';
import { config as loadEnv } from 'dotenv';
import { createPool } from '../src/db.js';
import { runAllMigrations } from '../src/migrate.js';
import { PgJournalStore } from '../src/pg-journal-store.js';
import type { NewJournalEntry } from '@buffr/kernel';

loadEnv();
const url = process.env.DATABASE_URL;

describe('PgJournalStore', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(async () => {
    pool = createPool(url!);
    await runAllMigrations(pool);
  });
  beforeEach(async () => {
    await pool.query("delete from agents.decisions where app_id = 'test'");
  });
  after(async () => { await pool.end(); });

  const HYPOTHESIS: NewJournalEntry = {
    kind: 'hypothesis',
    userId: 'u1', workspaceId: 'w1', domain: 'market-research',
    subjectType: 'research-topic', subjectId: 'shopify returns management',
    claim: 'shopify returns management', evidenceIds: ['ev-1', 'ev-2'],
  };

  const DECISION: NewJournalEntry = {
    kind: 'decision',
    userId: 'u1', workspaceId: 'w1', domain: 'market-research',
    subjectType: 'research-topic', subjectId: 'etsy printables',
    claim: 'etsy printables', evidenceIds: ['ev-3'],
    stake: 'Build a landing page and run ads for 2 weeks',
    resolutionCondition: '10+ email signups in 2 weeks',
    reviewAt: '2026-08-01T00:00:00.000Z',
    prediction: { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 },
    assessment: { score: 78, confidence: 0.7 },
  };

  it('creates and round-trips a hypothesis', async () => {
    const store = new PgJournalStore({ pool, appId: 'test' });
    const entry = await store.create(HYPOTHESIS, '2026-08-03T00:00:00.000Z');
    assert.strictEqual(entry.kind, 'hypothesis');
    assert.strictEqual(entry.status, 'open');
    assert.deepStrictEqual(entry.evidenceIds, ['ev-1', 'ev-2']);
    assert.strictEqual(entry.stake, undefined);
  });

  it('creates and round-trips a decision', async () => {
    const store = new PgJournalStore({ pool, appId: 'test' });
    const entry = await store.create(DECISION, '2026-08-03T00:00:00.000Z');
    assert.strictEqual(entry.kind, 'decision');
    assert.strictEqual(entry.stake, DECISION.kind === 'decision' ? DECISION.stake : undefined);
    assert.strictEqual(entry.reviewAt, '2026-08-01T00:00:00.000Z');
    assert.deepStrictEqual(entry.prediction, { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 });
    assert.deepStrictEqual(entry.assessment, { score: 78, confidence: 0.7 });
  });

  it('listDue marks a past-due decision review-due and returns it, scoped by user/workspace', async () => {
    const store = new PgJournalStore({ pool, appId: 'test' });
    const created = await store.create(DECISION, '2026-08-03T00:00:00.000Z');
    const due = await store.listDue('u1', 'w1', '2026-08-03T00:00:00.000Z');
    assert.strictEqual(due.length, 1);
    assert.strictEqual(due[0]?.id, created.id);
    assert.strictEqual(due[0]?.status, 'review-due');

    const dueOther = await store.listDue('someone-else', 'w1', '2026-08-03T00:00:00.000Z');
    assert.strictEqual(dueOther.length, 0);
  });

  it('snooze and resolve update status correctly', async () => {
    const store = new PgJournalStore({ pool, appId: 'test' });
    const created = await store.create(DECISION, '2026-08-03T00:00:00.000Z');
    await store.listDue('u1', 'w1', '2026-08-03T00:00:00.000Z');

    const snoozed = await store.snooze(created.id, '2026-12-01T00:00:00.000Z');
    assert.strictEqual(snoozed.status, 'open');
    assert.strictEqual(snoozed.reviewAt, '2026-12-01T00:00:00.000Z');

    const resolved = await store.resolve(created.id, 'inconclusive', 'Ran out of time.', '2026-08-04T00:00:00.000Z');
    assert.strictEqual(resolved.status, 'resolved');
    assert.strictEqual(resolved.disposition, 'inconclusive');
    assert.strictEqual(resolved.note, 'Ran out of time.');
  });
});
