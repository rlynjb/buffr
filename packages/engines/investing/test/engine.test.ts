import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InvestingEngine } from '../src/engine.js';
import type { InvestingEngineOptions, InvestingInput } from '../src/types.js';
import type { AgentContext, Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult } from '@buffr/connectors';
import type { ModelProvider, ModelRequest, ModelResponse } from '@buffr/kernel';
import type { ConversationMemory, MemoryTurn } from '@buffr/kernel';
import type { AnalysisFinding } from '@buffr/capabilities';

const ctx: AgentContext = {
  userId: 'u1',
  workspaceId: 'w1',
  traceId: 't1',
  domain: 'investing',
  now: '2026-07-29T00:00:00.000Z',
  permissions: [],
};

const COMPANY_FINDINGS: AnalysisFinding[] = [
  { dimensionId: 'business-quality', summary: 'Strong moat', positives: ['Brand'], negatives: ['Competition'], unknowns: [], score: 75, confidence: 0.8, evidenceIds: ['stub-1'] },
  { dimensionId: 'financial-strength', summary: 'Solid balance sheet', positives: ['Low debt'], negatives: ['Thin margins'], unknowns: [], score: 72, confidence: 0.8, evidenceIds: ['stub-1'] },
  { dimensionId: 'growth-durability', summary: 'Moderate growth', positives: ['Expanding market'], negatives: ['Slowing'], unknowns: [], score: 68, confidence: 0.75, evidenceIds: ['stub-1'] },
  { dimensionId: 'valuation', summary: 'Fair value', positives: ['P/E in range'], negatives: ['Premium to peers'], unknowns: [], score: 70, confidence: 0.8, evidenceIds: ['stub-1'] },
  { dimensionId: 'risk', summary: 'Moderate risk', positives: ['Diversified'], negatives: ['Macro risk'], unknowns: [], score: 40, confidence: 0.75, evidenceIds: ['stub-1'] },
];

const ETF_FINDINGS: AnalysisFinding[] = [
  { dimensionId: 'holdings-quality', summary: 'High quality', positives: ['Top holdings'], negatives: ['Concentration'], unknowns: [], score: 80, confidence: 0.85, evidenceIds: ['stub-2'] },
  { dimensionId: 'expense-ratio', summary: 'Low cost', positives: ['0.03% ER'], negatives: [], unknowns: [], score: 20, confidence: 0.9, evidenceIds: ['stub-2'] },
  { dimensionId: 'diversification', summary: 'Well diversified', positives: ['500 holdings'], negatives: ['US tilt'], unknowns: [], score: 82, confidence: 0.85, evidenceIds: ['stub-2'] },
  { dimensionId: 'liquidity', summary: 'Highly liquid', positives: ['High volume'], negatives: [], unknowns: [], score: 90, confidence: 0.9, evidenceIds: ['stub-2'] },
  { dimensionId: 'tracking-error', summary: 'Low tracking error', positives: ['<0.01%'], negatives: [], unknowns: [], score: 15, confidence: 0.9, evidenceIds: ['stub-2'] },
];

// Handles both Analyzer (submit_analysis) and Teacher (submit_explanation) in the same engine run.
// Flag-based so each tool name is responded to exactly once; subsequent calls for the same
// tool get a text 'done' response that terminates the runAgentLoop.
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
            keyLessons: ['Lesson A', 'Lesson B'],
            actionableNext: ['Step 1', 'Step 2'],
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
      { sourceId: 'stub-1', sourceType: 'stub', title: 'Stub article 1', excerpt: 'Evidence excerpt 1.', retrievedAt: ctx.now },
      { sourceId: 'stub-2', sourceType: 'stub', title: 'Stub article 2', excerpt: 'Evidence excerpt 2.', retrievedAt: ctx.now },
    ];
    return {
      data: {},
      fetchedAt: ctx.now,
      sourceId: 'stub-connector',
      toEvidence: () => evidence,
    };
  }
}

function makeEngine(findings: AnalysisFinding[], extra: Partial<InvestingEngineOptions> = {}): InvestingEngine {
  return new InvestingEngine({
    model: new StubModel(findings),
    sources: [{ connector: new StubConnector(), paramsFor: () => ({}) }],
    ...extra,
  });
}

describe('InvestingEngine', () => {
  it('company happy path: score > 0, explanation set, 5 findings, no journalEntryId', async () => {
    const engine = makeEngine(COMPANY_FINDINGS);
    const input: InvestingInput = { ticker: 'AAPL', entityType: 'company' };
    const result = await engine.run(input, ctx);

    assert.ok(result.data.summary.totalScore > 0, 'totalScore should be > 0');
    assert.strictEqual(result.data.summary.explanation, 'Test explanation.');
    assert.strictEqual(result.data.detail.findings.length, 5);
    assert.strictEqual(result.data.detail.journalEntryId, undefined);
  });

  it('ETF with journal: 5 findings, journalEntryId is a UUID', async () => {
    const engine = makeEngine(ETF_FINDINGS);
    const input: InvestingInput = {
      ticker: 'VTI',
      entityType: 'etf',
      decision: 'buy',
      thesis: 'low cost broad market',
    };
    const result = await engine.run(input, ctx);

    assert.strictEqual(result.data.detail.findings.length, 5);
    assert.ok(
      typeof result.data.detail.journalEntryId === 'string' &&
      /^[0-9a-f-]{36}$/.test(result.data.detail.journalEntryId),
      `journalEntryId should be a UUID, got: ${result.data.detail.journalEntryId}`,
    );
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

    const engine = makeEngine(COMPANY_FINDINGS, { memory: stubMemory });
    const input: InvestingInput = {
      ticker: 'MSFT',
      entityType: 'company',
      conversationId: 'conv-1',
    };
    await engine.run(input, ctx);

    assert.strictEqual(rememberCalled, 1, 'remember should be called exactly once');
    assert.strictEqual(capturedTurn?.conversationId, 'conv-1');
    assert.ok(
      typeof capturedTurn?.answer === 'string' && capturedTurn.answer.includes('Test explanation.'),
      `answer should contain 'Test explanation.', got: ${capturedTurn?.answer}`,
    );
  });
});
