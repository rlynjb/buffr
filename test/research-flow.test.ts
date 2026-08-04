import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createResearchFlow } from '../src/cli/research-flow.js';
import type { ChatSession } from '../src/session.js';
import type { CollectedResearch, MarketResearchOutput, ResearchPrediction } from '@buffr/engine-market-research';

const COLLECTED: CollectedResearch = {
  topic: 'shopify returns management',
  evidence: [
    { sourceId: 'stub-1', sourceType: 'web-search', title: 'Merchants hate manual tagging', retrievedAt: '2026-08-03T00:00:00.000Z' },
  ],
  failed: [],
  digest: { totalCount: 1, sources: [{ source: 'Brave Search', count: 1, titles: ['Merchants hate manual tagging'] }] },
  warnings: [],
};

const EMPTY_COLLECTED: CollectedResearch = {
  topic: 'an extremely obscure topic with no hits',
  evidence: [],
  failed: [],
  digest: { totalCount: 0, sources: [] },
  warnings: [],
};

function makeOutput(comparisonOverrides: Partial<MarketResearchOutput['comparison']> = {}): MarketResearchOutput {
  return {
    summary: {
      topic: 'shopify returns management',
      totalScore: 78,
      confidence: 0.8,
      explanation: 'Strong signal.',
      keyProblems: ['Manual tagging is tedious'],
      productAngles: ['Auto-tagging app'],
      warnings: [],
      principle: 'High-frequency manual work is a strong automation signal.',
      reflectionQuestion: 'Would merchants pay monthly for this?',
    },
    detail: { findings: [], metrics: [], evidence: COLLECTED.evidence, failed: [] },
    comparison: {
      prediction: { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 },
      actualScore: 78,
      actualDimension: 'frequency',
      scoreGap: 18,
      dimensionMatched: true,
      ...comparisonOverrides,
    },
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
    researchCollect: async () => ({ collected: COLLECTED }),
    researchEvaluate: async () => ({ output: makeOutput() }),
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

describe('research-flow — happy path to discard', () => {
  it('collects, prompts for a prediction, reveals, and discards on request', async () => {
    const session = makeStubSession();
    const flow = createResearchFlow(session, 'shopify returns management', {});

    const started = await flow.start();
    assert.strictEqual(started.step, 'prediction');
    assert.ok(started.messages[0]!.includes('Merchants hate manual tagging'));

    const predicted = await flow.submit('60 frequency 50');
    assert.strictEqual(predicted.step, 'promote');
    assert.ok(predicted.messages[0]!.includes('78'));

    const done = await flow.submit('discard');
    assert.strictEqual(done.step, 'done');
    assert.ok(done.messages[0]!.toLowerCase().includes('discarded'));
  });
});

describe('research-flow — zero evidence', () => {
  it('ends immediately with no prediction prompt', async () => {
    const session = makeStubSession({ researchCollect: async () => ({ collected: EMPTY_COLLECTED }) });
    const flow = createResearchFlow(session, EMPTY_COLLECTED.topic, {});
    const started = await flow.start();
    assert.strictEqual(started.step, 'done');
  });
});

describe('research-flow — invalid prediction input', () => {
  it('re-prompts without calling researchEvaluate', async () => {
    let evaluateCalls = 0;
    const session = makeStubSession({
      researchEvaluate: async () => { evaluateCalls++; return { output: makeOutput() }; },
    });
    const flow = createResearchFlow(session, 'shopify returns management', {});
    await flow.start();

    const badFormat = await flow.submit('not a valid prediction');
    assert.strictEqual(badFormat.step, 'prediction');
    assert.strictEqual(evaluateCalls, 0);

    const badDimension = await flow.submit('60 made-up-dimension 50');
    assert.strictEqual(badDimension.step, 'prediction');
    assert.strictEqual(evaluateCalls, 0);

    const badRange = await flow.submit('150 frequency 50');
    assert.strictEqual(badRange.step, 'prediction');
    assert.strictEqual(evaluateCalls, 0);

    const ok = await flow.submit('60 frequency 50');
    assert.strictEqual(ok.step, 'promote');
    assert.strictEqual(evaluateCalls, 1);
  });
});

describe('research-flow — save as hypothesis', () => {
  it('calls saveHypothesis with the topic and evidence ids', async () => {
    let captured: { topic: string; evidenceIds: string[] } | undefined;
    const session = makeStubSession({
      saveHypothesis: async (input) => { captured = input; },
    });
    const flow = createResearchFlow(session, 'shopify returns management', {});
    await flow.start();
    await flow.submit('60 frequency 50');
    const result = await flow.submit('hypothesis');

    assert.strictEqual(result.step, 'done');
    assert.deepStrictEqual(captured, { topic: 'shopify returns management', evidenceIds: ['stub-1'] });
  });
});

describe('research-flow — track as decision', () => {
  it('walks stake -> resolution -> review-date -> saveDecision', async () => {
    let captured: {
      topic: string; evidenceIds: string[]; stake: string; resolutionCondition: string;
      reviewAt: string; prediction: ResearchPrediction; assessment: { score: number; confidence: number };
    } | undefined;
    const session = makeStubSession({
      saveDecision: async (input) => { captured = input; },
    });
    const flow = createResearchFlow(session, 'shopify returns management', {});
    await flow.start();
    await flow.submit('60 frequency 50');

    const afterPromote = await flow.submit('decision');
    assert.strictEqual(afterPromote.step, 'stake');

    const afterStake = await flow.submit('Build a landing page and run ads for 2 weeks');
    assert.strictEqual(afterStake.step, 'resolution');

    const afterResolution = await flow.submit('10+ email signups in 2 weeks');
    assert.strictEqual(afterResolution.step, 'review-date');

    const afterReviewDate = await flow.submit('30');
    assert.strictEqual(afterReviewDate.step, 'done');

    assert.ok(captured);
    assert.strictEqual(captured!.topic, 'shopify returns management');
    assert.strictEqual(captured!.stake, 'Build a landing page and run ads for 2 weeks');
    assert.strictEqual(captured!.resolutionCondition, '10+ email signups in 2 weeks');
    assert.strictEqual(captured!.prediction.expectedScore, 60);
    assert.strictEqual(captured!.assessment.score, 78);
    assert.ok(new Date(captured!.reviewAt).getTime() > Date.now());
  });

  it('re-prompts on an unparseable review date without saving', async () => {
    let saveCalls = 0;
    const session = makeStubSession({ saveDecision: async () => { saveCalls++; } });
    const flow = createResearchFlow(session, 'shopify returns management', {});
    await flow.start();
    await flow.submit('60 frequency 50');
    await flow.submit('decision');
    await flow.submit('stake text');
    await flow.submit('resolution text');

    const bad = await flow.submit('not a date');
    assert.strictEqual(bad.step, 'review-date');
    assert.strictEqual(saveCalls, 0);
  });
});
