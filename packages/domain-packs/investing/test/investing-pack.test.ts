import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Scorer } from '@buffr/capabilities';
import { COMPANY_SCORECARD, ETF_SCORECARD } from '../src/index.js';
import type { AgentContext } from '@buffr/contracts';
import type { AnalysisFinding } from '@buffr/capabilities';

const __dirname = dirname(fileURLToPath(import.meta.url));

type CompanyFixture = {
  description: string;
  findings: AnalysisFinding[];
  evidenceCount: number;
  expectedTotalScore: number;
  expectedWarnings?: string[];
  expectedWarningsContain?: string[];
  expectedConfidencePenalised?: boolean;
};

type EtfFixture = {
  description: string;
  findings: AnalysisFinding[];
  evidenceCount: number;
  expectedTotalScore: number;
  expectedWarnings?: string[];
};

const companyFixtures: CompanyFixture[] = JSON.parse(
  readFileSync(join(__dirname, '../../eval/company-fixtures.json'), 'utf-8'),
);
const etfFixtures: EtfFixture[] = JSON.parse(
  readFileSync(join(__dirname, '../../eval/etf-fixtures.json'), 'utf-8'),
);

const ctx: AgentContext = {
  userId: 'test',
  workspaceId: 'test',
  traceId: 'test',
  domain: 'investing',
  now: '2026-07-29T00:00:00.000Z',
  permissions: [],
};

const scorer = new Scorer();

describe('investing-pack: company fixtures', () => {
  for (const fixture of companyFixtures) {
    it(fixture.description, async () => {
      const result = await scorer.execute(
        { findings: fixture.findings, scorecard: COMPANY_SCORECARD, evidenceCount: fixture.evidenceCount },
        ctx,
      );
      assert.ok(
        Math.abs(result.data.totalScore - fixture.expectedTotalScore) < 0.01,
        `totalScore ${result.data.totalScore} !== expected ${fixture.expectedTotalScore}`,
      );
      if (fixture.expectedWarnings !== undefined) {
        assert.equal(result.data.warnings.length, fixture.expectedWarnings.length);
      }
      if (fixture.expectedWarningsContain !== undefined) {
        for (const term of fixture.expectedWarningsContain) {
          assert.ok(
            result.data.warnings.some((w) => w.includes(term)),
            `expected a warning containing "${term}"`,
          );
        }
      }
      if (fixture.expectedConfidencePenalised === true) {
        const meanConfidence =
          fixture.findings.reduce((sum, f) => sum + f.confidence, 0) / fixture.findings.length;
        assert.ok(result.data.confidence < meanConfidence, 'confidence should be penalised below mean');
      }
    });
  }
});

describe('investing-pack: etf fixtures', () => {
  for (const fixture of etfFixtures) {
    it(fixture.description, async () => {
      const result = await scorer.execute(
        { findings: fixture.findings, scorecard: ETF_SCORECARD, evidenceCount: fixture.evidenceCount },
        ctx,
      );
      assert.ok(
        Math.abs(result.data.totalScore - fixture.expectedTotalScore) < 0.01,
        `totalScore ${result.data.totalScore} !== expected ${fixture.expectedTotalScore}`,
      );
      if (fixture.expectedWarnings !== undefined) {
        assert.equal(result.data.warnings.length, fixture.expectedWarnings.length);
      }
    });
  }
});
