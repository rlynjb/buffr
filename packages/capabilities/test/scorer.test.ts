import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Scorer } from '../src/scorer/index.js';
import type { AnalysisFinding } from '../src/analyzer/index.js';
import type { AgentContext, ScorecardDefinition } from '@buffr/contracts';

const ctx: AgentContext = {
  userId: 'u1',
  workspaceId: 'w1',
  traceId: 't1',
  domain: 'test',
  now: '2026-07-29T00:00:00.000Z',
  permissions: [],
};

const scorecard: ScorecardDefinition = {
  id: 'test-card',
  version: '1.0.0',
  metrics: [
    { id: 'profitability', label: 'Profitability', weight: 0.6, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'risk', label: 'Risk', weight: 0.4, direction: 'lower-is-better', min: 0, max: 100 },
  ],
  minimumEvidenceCount: 3,
  confidencePenalty: 0.8,
};

const findings: AnalysisFinding[] = [
  {
    dimensionId: 'profitability',
    summary: 'Strong margins',
    positives: ['Revenue up'],
    negatives: [],
    unknowns: [],
    score: 80,
    confidence: 0.9,
    evidenceIds: ['src-1'],
  },
  {
    dimensionId: 'risk',
    summary: 'Moderate risk',
    positives: [],
    negatives: ['Macro headwinds'],
    unknowns: [],
    score: 40,
    confidence: 0.7,
    evidenceIds: ['src-1'],
  },
];

describe('Scorer', () => {
  it('computes totalScore correctly (higher-is-better + lower-is-better)', async () => {
    const scorer = new Scorer();
    const result = await scorer.execute({ findings, scorecard, evidenceCount: 5 }, ctx);
    // profitability: rawScore=80, weightedScore=80*0.6=48
    // risk: direction=lower-is-better → rawScore=100-40=60, weightedScore=60*0.4=24
    // totalScore = 48 + 24 = 72
    assert.ok(Math.abs(result.data.totalScore - 72) < 0.001, `expected 72, got ${result.data.totalScore}`);
  });

  it('returns ScoredMetric for each scorecard metric', async () => {
    const scorer = new Scorer();
    const result = await scorer.execute({ findings, scorecard, evidenceCount: 5 }, ctx);
    assert.strictEqual(result.data.metrics.length, 2);
    assert.strictEqual(result.data.metrics[0].id, 'profitability');
    assert.strictEqual(result.data.metrics[1].id, 'risk');
  });

  it('adds warning and contributes 0 for missing dimension', async () => {
    const scorer = new Scorer();
    const partialFindings = findings.slice(0, 1); // only profitability
    const result = await scorer.execute({ findings: partialFindings, scorecard, evidenceCount: 5 }, ctx);
    assert.ok(result.data.warnings.some(w => w.includes('risk')));
    // profitability: 80*0.6=48, missing risk: 0 → totalScore=48
    assert.ok(Math.abs(result.data.totalScore - 48) < 0.001);
  });

  it('penalises confidence when evidenceCount < minimumEvidenceCount', async () => {
    const scorer = new Scorer();
    const result = await scorer.execute({ findings, scorecard, evidenceCount: 2 }, ctx);
    // meanConfidence = (0.9 + 0.7) / 2 = 0.8; penalised: 0.8 * 0.8 = 0.64
    assert.ok(Math.abs(result.data.confidence - 0.64) < 0.001);
  });

  it('does not penalise confidence when evidenceCount >= minimumEvidenceCount', async () => {
    const scorer = new Scorer();
    const result = await scorer.execute({ findings, scorecard, evidenceCount: 5 }, ctx);
    const expected = (0.9 + 0.7) / 2;
    assert.ok(Math.abs(result.data.confidence - expected) < 0.001);
  });

  it('formats evidenceCoverage string', async () => {
    const scorer = new Scorer();
    const result = await scorer.execute({ findings, scorecard, evidenceCount: 2 }, ctx);
    assert.strictEqual(result.data.evidenceCoverage, '2 / 3 required signals');
  });

  it('sets traceId from context', async () => {
    const scorer = new Scorer();
    const result = await scorer.execute({ findings, scorecard, evidenceCount: 5 }, ctx);
    assert.strictEqual(result.traceId, ctx.traceId);
  });
});
