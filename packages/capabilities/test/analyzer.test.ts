import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer } from '../src/analyzer/index.js';
import type { AgentContext, Evidence } from '@buffr/contracts';
import type { ModelProvider, ModelRequest, ModelResponse } from '@buffr/kernel';

const ctx: AgentContext = {
  userId: 'u1',
  workspaceId: 'w1',
  traceId: 't1',
  domain: 'test',
  now: '2026-07-29T00:00:00.000Z',
  permissions: [],
};

const sampleEvidence: Evidence[] = [
  { sourceId: 'src-1', sourceType: 'test', excerpt: 'Revenue up 20%', retrievedAt: ctx.now },
];

const sampleDimensions = [
  { id: 'profitability', label: 'Profitability', description: 'Assess profit margins and revenue trends.' },
  { id: 'risk', label: 'Risk', description: 'Assess downside risks.' },
];

const prebuiltFindings = [
  {
    dimensionId: 'profitability',
    summary: 'Strong margins',
    positives: ['Revenue up'],
    negatives: ['High capex'],
    unknowns: ['Debt trajectory'],
    score: 78,
    confidence: 0.85,
    evidenceIds: ['src-1'],
  },
  {
    dimensionId: 'risk',
    summary: 'Moderate risk',
    positives: ['Diversified revenue'],
    negatives: ['Macro headwinds'],
    unknowns: ['Regulatory environment'],
    score: 60,
    confidence: 0.7,
    evidenceIds: ['src-1'],
  },
];

class AnalyzerStubModel implements ModelProvider {
  readonly id = 'analyzer-stub';
  private callCount = 0;

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    this.callCount++;
    if (this.callCount === 1) {
      return {
        content: [{
          type: 'tool_use',
          id: 'call_1',
          name: 'submit_analysis',
          input: { findings: prebuiltFindings },
        }],
      };
    }
    return { content: [{ type: 'text', text: 'done' }] };
  }
}

describe('Analyzer', () => {
  it('returns one finding per dimension', async () => {
    const analyzer = new Analyzer(new AnalyzerStubModel());
    const result = await analyzer.execute(
      { subjectDescription: 'ACME Corp Q3 earnings', evidence: sampleEvidence, dimensions: sampleDimensions },
      ctx,
    );
    assert.strictEqual(result.data.findings.length, 2);
    assert.strictEqual(result.data.findings[0].dimensionId, 'profitability');
    assert.strictEqual(result.data.findings[1].dimensionId, 'risk');
  });

  it('each finding has score in [0, 100] and confidence in [0, 1]', async () => {
    const analyzer = new Analyzer(new AnalyzerStubModel());
    const result = await analyzer.execute(
      { subjectDescription: 'ACME Corp', evidence: sampleEvidence, dimensions: sampleDimensions },
      ctx,
    );
    for (const f of result.data.findings) {
      assert.ok(f.score >= 0 && f.score <= 100, `score out of range: ${f.score}`);
      assert.ok(f.confidence >= 0 && f.confidence <= 1, `confidence out of range: ${f.confidence}`);
    }
  });

  it('AgentResult.confidence is mean of finding confidences', async () => {
    const analyzer = new Analyzer(new AnalyzerStubModel());
    const result = await analyzer.execute(
      { subjectDescription: 'ACME Corp', evidence: sampleEvidence, dimensions: sampleDimensions },
      ctx,
    );
    const expected = (0.85 + 0.7) / 2;
    assert.ok(Math.abs(result.confidence - expected) < 0.001);
  });

  it('passes input evidence through to AgentResult.evidence', async () => {
    const analyzer = new Analyzer(new AnalyzerStubModel());
    const result = await analyzer.execute(
      { subjectDescription: 'ACME Corp', evidence: sampleEvidence, dimensions: sampleDimensions },
      ctx,
    );
    assert.deepEqual(result.evidence, sampleEvidence);
  });

  it('sets promptVersion to analyzer@1.0.0', async () => {
    const analyzer = new Analyzer(new AnalyzerStubModel());
    const result = await analyzer.execute(
      { subjectDescription: 'ACME Corp', evidence: sampleEvidence, dimensions: sampleDimensions },
      ctx,
    );
    assert.strictEqual(result.promptVersion, 'analyzer@1.0.0');
  });
});
