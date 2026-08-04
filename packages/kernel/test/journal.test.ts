import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryJournalStore } from '../src/journal/index.js';
import type { NewJournalEntry } from '../src/journal/index.js';

const NOW = '2026-08-03T00:00:00.000Z';
const PAST = '2026-08-01T00:00:00.000Z';
const FUTURE = '2026-09-01T00:00:00.000Z';

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
  reviewAt: PAST,
  prediction: { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 },
  assessment: { score: 78, confidence: 0.7 },
};

describe('InMemoryJournalStore', () => {
  it('creates a hypothesis with status open and no stake/reviewAt', async () => {
    const store = new InMemoryJournalStore();
    const entry = await store.create(HYPOTHESIS, NOW);
    assert.strictEqual(entry.kind, 'hypothesis');
    assert.strictEqual(entry.status, 'open');
    assert.strictEqual(entry.createdAt, NOW);
    assert.strictEqual(entry.stake, undefined);
    assert.strictEqual(entry.reviewAt, undefined);
    assert.ok(entry.id.length > 0);
  });

  it('creates a decision carrying stake, resolutionCondition, reviewAt, prediction, assessment', async () => {
    const store = new InMemoryJournalStore();
    const entry = await store.create(DECISION, NOW);
    assert.strictEqual(entry.kind, 'decision');
    assert.strictEqual(entry.stake, 'Build a landing page and run ads for 2 weeks');
    assert.strictEqual(entry.resolutionCondition, '10+ email signups in 2 weeks');
    assert.strictEqual(entry.reviewAt, PAST);
    assert.deepStrictEqual(entry.prediction, { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 });
    assert.deepStrictEqual(entry.assessment, { score: 78, confidence: 0.7 });
  });

  it('listDue marks an open decision past its reviewAt as review-due and returns it', async () => {
    const store = new InMemoryJournalStore();
    const created = await store.create(DECISION, NOW);
    const due = await store.listDue('u1', 'w1', NOW);
    assert.strictEqual(due.length, 1);
    assert.strictEqual(due[0]?.id, created.id);
    assert.strictEqual(due[0]?.status, 'review-due');
  });

  it('listDue excludes decisions not yet due and hypotheses entirely', async () => {
    const store = new InMemoryJournalStore();
    await store.create(HYPOTHESIS, NOW);
    await store.create({ ...DECISION, reviewAt: FUTURE }, NOW);
    const due = await store.listDue('u1', 'w1', NOW);
    assert.strictEqual(due.length, 0);
  });

  it('listDue scopes by userId/workspaceId', async () => {
    const store = new InMemoryJournalStore();
    await store.create(DECISION, NOW);
    const due = await store.listDue('someone-else', 'w1', NOW);
    assert.strictEqual(due.length, 0);
  });

  it('snooze resets status to open with a new reviewAt', async () => {
    const store = new InMemoryJournalStore();
    const created = await store.create(DECISION, NOW);
    await store.listDue('u1', 'w1', NOW); // marks it review-due first
    const snoozed = await store.snooze(created.id, FUTURE);
    assert.strictEqual(snoozed.status, 'open');
    assert.strictEqual(snoozed.reviewAt, FUTURE);
    const due = await store.listDue('u1', 'w1', NOW);
    assert.strictEqual(due.length, 0, 'should not be due again until FUTURE');
  });

  it('resolve sets status resolved with disposition, note, resolvedAt', async () => {
    const store = new InMemoryJournalStore();
    const created = await store.create(DECISION, NOW);
    const resolved = await store.resolve(created.id, 'successful', 'Hit 14 signups.', NOW);
    assert.strictEqual(resolved.status, 'resolved');
    assert.strictEqual(resolved.disposition, 'successful');
    assert.strictEqual(resolved.note, 'Hit 14 signups.');
    assert.strictEqual(resolved.resolvedAt, NOW);
    const due = await store.listDue('u1', 'w1', NOW);
    assert.strictEqual(due.length, 0, 'resolved entries must not resurface as due');
  });
});
