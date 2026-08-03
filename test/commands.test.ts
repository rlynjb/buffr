import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Scorer } from '@buffr/capabilities';
import { COMPANY_SCORECARD, ETF_SCORECARD } from '@buffr/domain-pack-investing';
import { MARKET_RESEARCH_SCORECARD } from '@buffr/domain-pack-market-research';
import type { AgentContext } from '@buffr/contracts';
import { detectEntityType } from '../src/session.js';

const evalCtx: AgentContext = {
  userId: 'eval', workspaceId: 'eval', traceId: 'eval',
  domain: 'investing', now: '2026-07-29T00:00:00.000Z', permissions: [],
};

describe('detectEntityType', () => {
  it('returns etf for known ETF tickers', () => {
    assert.strictEqual(detectEntityType('VTI'), 'etf');
    assert.strictEqual(detectEntityType('SPY'), 'etf');
    assert.strictEqual(detectEntityType('QQQ'), 'etf');
  });

  it('returns company for non-ETF tickers', () => {
    assert.strictEqual(detectEntityType('AAPL'), 'company');
    assert.strictEqual(detectEntityType('MSFT'), 'company');
    assert.strictEqual(detectEntityType('NVDA'), 'company');
  });
});

describe('eval:investing scorer accuracy', () => {
  it('company fixtures score within ±0.01 of expected', async () => {
    const scorer = new Scorer();
    const fixtures: Array<{
      description: string;
      findings: Parameters<Scorer['execute']>[0]['findings'];
      evidenceCount: number;
      expectedTotalScore: number;
    }> = JSON.parse(
      await readFile(
        new URL('../../packages/domain-packs/investing/eval/company-fixtures.json', import.meta.url),
        'utf8',
      ),
    );
    for (const fixture of fixtures) {
      const result = await scorer.execute(
        { findings: fixture.findings, scorecard: COMPANY_SCORECARD, evidenceCount: fixture.evidenceCount },
        evalCtx,
      );
      const delta = Math.abs(result.data.totalScore - fixture.expectedTotalScore);
      assert.ok(
        delta <= 0.01,
        `"${fixture.description}": expected ${fixture.expectedTotalScore}, got ${result.data.totalScore.toFixed(4)}, Δ ${delta.toFixed(4)}`,
      );
    }
  });

  it('ETF fixtures score within ±0.01 of expected', async () => {
    const scorer = new Scorer();
    const fixtures: Array<{
      description: string;
      findings: Parameters<Scorer['execute']>[0]['findings'];
      evidenceCount: number;
      expectedTotalScore: number;
    }> = JSON.parse(
      await readFile(
        new URL('../../packages/domain-packs/investing/eval/etf-fixtures.json', import.meta.url),
        'utf8',
      ),
    );
    for (const fixture of fixtures) {
      const result = await scorer.execute(
        { findings: fixture.findings, scorecard: ETF_SCORECARD, evidenceCount: fixture.evidenceCount },
        evalCtx,
      );
      const delta = Math.abs(result.data.totalScore - fixture.expectedTotalScore);
      assert.ok(
        delta <= 0.01,
        `"${fixture.description}": expected ${fixture.expectedTotalScore}, got ${result.data.totalScore.toFixed(4)}, Δ ${delta.toFixed(4)}`,
      );
    }
  });
});

describe('eval:research scorer accuracy', () => {
  it('market research fixtures score within ±0.01 of expected', async () => {
    const scorer = new Scorer();
    const fixtures: Array<{
      description: string;
      findings: Parameters<Scorer['execute']>[0]['findings'];
      evidenceCount: number;
      expectedTotalScore: number;
    }> = JSON.parse(
      await readFile(
        new URL('../../packages/domain-packs/market-research/eval/fixtures.json', import.meta.url),
        'utf8',
      ),
    );
    for (const fixture of fixtures) {
      const result = await scorer.execute(
        { findings: fixture.findings, scorecard: MARKET_RESEARCH_SCORECARD, evidenceCount: fixture.evidenceCount },
        evalCtx,
      );
      const delta = Math.abs(result.data.totalScore - fixture.expectedTotalScore);
      assert.ok(
        delta <= 0.01,
        `"${fixture.description}": expected ${fixture.expectedTotalScore}, got ${result.data.totalScore.toFixed(4)}, Δ ${delta.toFixed(4)}`,
      );
    }
  });
});
