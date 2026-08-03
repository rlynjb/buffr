import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MarketResearchEngine } from '../src/engine.js';
import type { MarketResearchEngineOptions, MarketResearchInput } from '../src/types.js';
import type { AgentContext, Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult } from '@buffr/connectors';
import type { ModelProvider, ModelRequest, ModelResponse, ConversationMemory, MemoryTurn } from '@buffr/kernel';
import type { AnalysisFinding } from '@buffr/capabilities';

const ctx: AgentContext = {
  userId: 'u1', workspaceId: 'w1', traceId: 't1',
  domain: 'market-research', now: '2026-08-02T00:00:00.000Z', permissions: [],
};

const RESEARCH_FINDINGS: AnalysisFinding[] = [
  { dimensionId: 'frequency',      summary: 'High volume of complaints', positives: ['Many mentions'], negatives: [],                  unknowns: [], score: 80, confidence: 0.85, evidenceIds: ['stub-1'] },
  { dimensionId: 'trend-velocity', summary: 'Rising interest',           positives: ['Trending up'],   negatives: [],                  unknowns: [], score: 75, confidence: 0.80, evidenceIds: ['stub-1'] },
  { dimensionId: 'specificity',    summary: 'Concrete pain point',       positives: ['Actionable'],    negatives: ['Some vagueness'],   unknowns: [], score: 70, confidence: 0.80, evidenceIds: ['stub-2'] },
  { dimensionId: 'monetizability', summary: 'Clear product opportunity',  positives: ['Sellable'],      negatives: [],                  unknowns: [], score: 72, confidence: 0.78, evidenceIds: ['stub-2'] },
];

class StubModel implements ModelProvider {
  readonly id = 'stub-model';
  private analysisSubmitted = false;
  private explanationSubmitted = false;

  constructor(private readonly findings: AnalysisFinding[]) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const toolName = req.tools?.[0]?.name;

    if (toolName === 'submit_analysis' && !this.analysisSubmitted) {
      this.analysisSubmitted = true;
      return {
        content: [{
          type: 'tool_use',
          id: 'call_1',
          name: 'submit_analysis',
          input: { findings: this.findings },
        }],
      };
    }

    if (toolName === 'submit_explanation' && !this.explanationSubmitted) {
      this.explanationSubmitted = true;
      return {
        content: [{
          type: 'tool_use',
          id: 'call_2',
          name: 'submit_explanation',
          input: {
            explanation: 'Test explanation.',
            keyLessons: ['Problem A', 'Problem B'],
            actionableNext: ['App idea A', 'App idea B'],
          },
        }],
      };
    }

    return { content: [{ type: 'text', text: 'done' }] };
  }
}

class StubConnector implements DataConnector<unknown, unknown> {
  readonly id = 'stub-connector';

  async fetch(_params: unknown): Promise<ConnectorResult<unknown>> {
    const evidence: Evidence[] = [
      { sourceId: 'stub-1', sourceType: 'search-trends', title: 'Trend data',   excerpt: 'Trend excerpt.', retrievedAt: ctx.now },
      { sourceId: 'stub-2', sourceType: 'web-search',    title: 'Forum post',   excerpt: 'Forum excerpt.', retrievedAt: ctx.now },
    ];
    return {
      data: {},
      fetchedAt: ctx.now,
      sourceId: 'stub-connector',
      toEvidence: () => evidence,
    };
  }
}

function makeEngine(findings: AnalysisFinding[], extra: Partial<MarketResearchEngineOptions> = {}): MarketResearchEngine {
  return new MarketResearchEngine({
    model: new StubModel(findings),
    sources: [{ connector: new StubConnector(), paramsFor: () => ({}) }],
    ...extra,
  });
}

describe('MarketResearchEngine', () => {
  it('topic happy path: score > 0, keyProblems set, 4 findings', async () => {
    const engine = makeEngine(RESEARCH_FINDINGS);
    const input: MarketResearchInput = { topic: 'shopify returns management' };
    const result = await engine.run(input, ctx);

    assert.ok(result.data.summary.totalScore > 0, 'totalScore should be > 0');
    assert.strictEqual(result.data.summary.explanation, 'Test explanation.');
    assert.deepStrictEqual(result.data.summary.keyProblems, ['Problem A', 'Problem B']);
    assert.deepStrictEqual(result.data.summary.productAngles, ['App idea A', 'App idea B']);
    assert.strictEqual(result.data.detail.findings.length, 4);
  });

  it('memory write: remember() called once with correct conversationId and explanation in answer', async () => {
    let rememberCalled = 0;
    let capturedTurn: MemoryTurn | undefined;

    const stubMemory: ConversationMemory = {
      async remember(turn: MemoryTurn): Promise<void> {
        rememberCalled++;
        capturedTurn = turn;
      },
      async recall(_query: string, _k?: number) {
        return [];
      },
    };

    const engine = makeEngine(RESEARCH_FINDINGS, { memory: stubMemory });
    const input: MarketResearchInput = { topic: 'etsy printables', conversationId: 'conv-1' };
    await engine.run(input, ctx);

    assert.strictEqual(rememberCalled, 1, 'remember should be called exactly once');
    assert.strictEqual(capturedTurn?.conversationId, 'conv-1');
    assert.ok(
      typeof capturedTurn?.answer === 'string' && capturedTurn.answer.includes('Test explanation.'),
      `answer should contain 'Test explanation.', got: ${capturedTurn?.answer}`,
    );
  });
});
