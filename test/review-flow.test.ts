import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createReviewFlow } from '../src/cli/review-flow.js';
import type { ChatSession } from '../src/session.js';
import type { JournalEntry } from '@buffr/kernel';

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'j-1',
    userId: 'u1', workspaceId: 'w1', domain: 'market-research',
    subjectType: 'research-topic', subjectId: 'shopify returns management',
    kind: 'decision', claim: 'shopify returns management', evidenceIds: ['ev-1'],
    createdAt: '2026-08-01T00:00:00.000Z', status: 'review-due',
    stake: 'Build a landing page', resolutionCondition: '10+ signups', reviewAt: '2026-08-03T00:00:00.000Z',
    prediction: { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 },
    assessment: { score: 78, confidence: 0.7 },
    ...overrides,
  };
}

function makeStubSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const base: ChatSession = {
    ask: async () => '',
    analyze: async () => '',
    evalInvesting: async () => '',
    evalResearch: async () => '',
    suggestResearchTopics: async () => '',
    connectorStatus: () => ({ chat: [], chatKnowledgeBase: '', research: [], investing: [] }),
    researchCollect: async () => { throw new Error('not used'); },
    researchEvaluate: async () => { throw new Error('not used'); },
    saveHypothesis: async () => {},
    saveDecision: async () => {},
    dueReviewCount: async () => 0,
    listDueReviews: async () => [],
    snoozeReview: async () => {},
    resolveReview: async () => {},
    close: async () => {},
  };
  return { ...base, ...overrides };
}

describe('review-flow — nothing due', () => {
  it('ends immediately', async () => {
    const session = makeStubSession({ listDueReviews: async () => [] });
    const flow = createReviewFlow(session);
    const result = await flow.start();
    assert.strictEqual(result.step, 'done');
    assert.ok(result.messages[0]!.toLowerCase().includes('nothing due'));
  });
});

describe('review-flow — keep open', () => {
  it('moves to the next entry without calling any store method', async () => {
    let snoozeCalls = 0, resolveCalls = 0;
    const entries = [makeEntry({ id: 'j-1' }), makeEntry({ id: 'j-2' })];
    const session = makeStubSession({
      listDueReviews: async () => entries,
      snoozeReview: async () => { snoozeCalls++; },
      resolveReview: async () => { resolveCalls++; },
    });
    const flow = createReviewFlow(session);
    const started = await flow.start();
    assert.strictEqual(started.step, 'action');

    const afterKeep = await flow.submit('keep');
    assert.strictEqual(afterKeep.step, 'action');
    assert.strictEqual(snoozeCalls, 0);
    assert.strictEqual(resolveCalls, 0);

    const afterKeep2 = await flow.submit('keep');
    assert.strictEqual(afterKeep2.step, 'done');
  });
});

describe('review-flow — snooze', () => {
  it('prompts for a date, then calls snoozeReview with a parsed ISO date', async () => {
    let captured: { id: string; reviewAt: string } | undefined;
    const session = makeStubSession({
      listDueReviews: async () => [makeEntry()],
      snoozeReview: async (id, reviewAt) => { captured = { id, reviewAt }; },
    });
    const flow = createReviewFlow(session);
    await flow.start();

    const afterSnoozeChoice = await flow.submit('snooze');
    assert.strictEqual(afterSnoozeChoice.step, 'snooze-date');

    const afterDate = await flow.submit('14');
    assert.strictEqual(afterDate.step, 'done');
    assert.strictEqual(captured?.id, 'j-1');
    assert.ok(new Date(captured!.reviewAt).getTime() > Date.now());
  });

  it('re-prompts on an unparseable date', async () => {
    let snoozeCalls = 0;
    const session = makeStubSession({
      listDueReviews: async () => [makeEntry()],
      snoozeReview: async () => { snoozeCalls++; },
    });
    const flow = createReviewFlow(session);
    await flow.start();
    await flow.submit('snooze');
    const bad = await flow.submit('whenever');
    assert.strictEqual(bad.step, 'snooze-date');
    assert.strictEqual(snoozeCalls, 0);
  });
});

describe('review-flow — resolve', () => {
  it('prompts for disposition then note, then calls resolveReview', async () => {
    let captured: { id: string; disposition: string; note: string } | undefined;
    const session = makeStubSession({
      listDueReviews: async () => [makeEntry()],
      resolveReview: async (id, disposition, note) => { captured = { id, disposition, note }; },
    });
    const flow = createReviewFlow(session);
    await flow.start();

    const afterResolveChoice = await flow.submit('resolve');
    assert.strictEqual(afterResolveChoice.step, 'disposition');

    const afterBadDisposition = await flow.submit('maybe');
    assert.strictEqual(afterBadDisposition.step, 'disposition');

    const afterDisposition = await flow.submit('successful');
    assert.strictEqual(afterDisposition.step, 'note');

    const afterNote = await flow.submit('Hit 14 signups.');
    assert.strictEqual(afterNote.step, 'done');
    assert.deepStrictEqual(captured, { id: 'j-1', disposition: 'successful', note: 'Hit 14 signups.' });
  });

  it('accepts an empty note', async () => {
    let captured: { note: string } | undefined;
    const session = makeStubSession({
      listDueReviews: async () => [makeEntry()],
      resolveReview: async (_id, _disposition, note) => { captured = { note }; },
    });
    const flow = createReviewFlow(session);
    await flow.start();
    await flow.submit('resolve');
    await flow.submit('inconclusive');
    await flow.submit('');
    assert.strictEqual(captured?.note, '');
  });
});
