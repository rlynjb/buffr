import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Scorer } from '@buffr/capabilities';
import { MARKET_RESEARCH_SCORECARD } from '../src/index.js';
import type { AgentContext } from '@buffr/contracts';
import type { AnalysisFinding } from '@buffr/capabilities';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Fixture = {
  description: string;
  findings: AnalysisFinding[];
  evidenceCount: number;
  expectedTotalScore: number;
  expectedWarnings?: string[];
  expectedWarningsContain?: string[];
};

const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(__dirname, '../../eval/fixtures.json'), 'utf-8'),
);

const ctx: AgentContext = {
  userId: 'test', workspaceId: 'test', traceId: 'test',
  domain: 'market-research', now: '2026-08-02T00:00:00.000Z', permissions: [],
};

const scorer = new Scorer();

describe('market-research-pack: fixtures', () => {
  for (const fixture of fixtures) {
    it(fixture.description, async () => {
      const result = await scorer.execute(
        { findings: fixture.findings, scorecard: MARKET_RESEARCH_SCORECARD, evidenceCount: fixture.evidenceCount },
        ctx,
      );
      assert.ok(
        Math.abs(result.data.totalScore - fixture.expectedTotalScore) < 0.01,
        `totalScore ${result.data.totalScore.toFixed(4)} !== expected ${fixture.expectedTotalScore}`,
      );
      if (fixture.expectedWarnings !== undefined) {
        assert.equal(result.data.warnings.length, fixture.expectedWarnings.length);
      }
      if (fixture.expectedWarningsContain !== undefined) {
        for (const term of fixture.expectedWarningsContain) {
          assert.ok(
            result.data.warnings.some(w => w.toLowerCase().includes(term.toLowerCase())),
            `expected a warning containing "${term}", got: ${JSON.stringify(result.data.warnings)}`,
          );
        }
      }
    });
  }
});
