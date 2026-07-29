import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Teacher } from '../src/teacher/index.js';
import type { AnalysisFinding } from '../src/analyzer/index.js';
import type { AgentContext } from '@buffr/contracts';
import type { ModelProvider, ModelRequest, ModelResponse } from '@buffr/kernel';

const ctx: AgentContext = {
  userId: 'u1',
  workspaceId: 'w1',
  traceId: 't1',
  domain: 'test',
  now: '2026-07-29T00:00:00.000Z',
  permissions: [],
};

const sampleFindings: AnalysisFinding[] = [
  {
    dimensionId: 'profitability',
    summary: 'Strong margins',
    positives: ['Revenue up 20%'],
    negatives: ['High capex'],
    unknowns: ['Long-term debt'],
    score: 78,
    confidence: 0.85,
    evidenceIds: ['src-1'],
  },
];

const prebuiltExplanation = {
  explanation: 'ACME Corp shows strong fundamentals with 20% revenue growth.',
  keyLessons: ['Revenue growth is robust', 'Capex investment is heavy but strategic'],
  actionableNext: ['Monitor Q4 capex guidance', 'Review debt covenants'],
};

class TeacherStubModel implements ModelProvider {
  readonly id = 'teacher-stub';
  private callCount = 0;

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    this.callCount++;
    if (this.callCount === 1) {
      return {
        content: [{
          type: 'tool_use',
          id: 'call_1',
          name: 'submit_explanation',
          input: prebuiltExplanation,
        }],
      };
    }
    return { content: [{ type: 'text', text: 'done' }] };
  }
}

describe('Teacher', () => {
  it('returns explanation, keyLessons, and actionableNext', async () => {
    const teacher = new Teacher(new TeacherStubModel());
    const result = await teacher.execute(
      { subjectDescription: 'ACME Corp', findings: sampleFindings, totalScore: 72, confidence: 0.8, warnings: [] },
      ctx,
    );
    assert.ok(result.data.explanation.length > 0);
    assert.ok(result.data.keyLessons.length > 0);
    assert.ok(result.data.actionableNext.length > 0);
  });

  it('passes confidence from input through to AgentResult.confidence', async () => {
    const teacher = new Teacher(new TeacherStubModel());
    const result = await teacher.execute(
      { subjectDescription: 'ACME Corp', findings: sampleFindings, totalScore: 72, confidence: 0.75, warnings: [] },
      ctx,
    );
    assert.strictEqual(result.confidence, 0.75);
  });

  it('sets promptVersion to teacher@1.0.0', async () => {
    const teacher = new Teacher(new TeacherStubModel());
    const result = await teacher.execute(
      { subjectDescription: 'ACME Corp', findings: sampleFindings, totalScore: 72, confidence: 0.8, warnings: [] },
      ctx,
    );
    assert.strictEqual(result.promptVersion, 'teacher@1.0.0');
  });

  it('sets traceId from context', async () => {
    const teacher = new Teacher(new TeacherStubModel());
    const result = await teacher.execute(
      { subjectDescription: 'ACME Corp', findings: sampleFindings, totalScore: 72, confidence: 0.8, warnings: [] },
      ctx,
    );
    assert.strictEqual(result.traceId, ctx.traceId);
  });

  it('sets latencyMs as a non-negative number', async () => {
    const teacher = new Teacher(new TeacherStubModel());
    const result = await teacher.execute(
      { subjectDescription: 'ACME Corp', findings: sampleFindings, totalScore: 72, confidence: 0.8, warnings: [] },
      ctx,
    );
    assert.ok(typeof result.latencyMs === 'number' && result.latencyMs >= 0);
  });
});
