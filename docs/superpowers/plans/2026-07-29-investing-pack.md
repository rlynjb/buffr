# Investing Domain Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@buffr/domain-pack-investing` — the first domain pack for the DI platform — providing investing-specific entity schemas, analysis dimensions, scorecards, source policies, and prompt fragments for Phase 4 engines.

**Architecture:** A single new monorepo package at `packages/domain-packs/investing/` that depends only on `@buffr/contracts`. It extends two contracts interfaces (`DomainPack`, adds `SourcePolicy`), exports pure TypeScript constants, and is verified through deterministic Scorer arithmetic tests against bundled eval fixtures.

**Tech Stack:** TypeScript ESM (NodeNext), `node:test` + `node:assert/strict`, `@buffr/contracts` (prod dep), `@buffr/capabilities` (dev dep for Scorer tests only).

## Global Constraints

- TypeScript ESM; all local imports use `.js` extension.
- No new prod dependencies beyond `@buffr/contracts` (test-only dev dep on `@buffr/capabilities`).
- No kernel, capabilities, or connectors code changes. Contracts changes only.
- `DomainPack` extension fields (`scorecards`, `dimensions`, `sourcePolicies`) are required on the interface — this is safe because `DomainPack` had no prior implementors outside the contracts package itself.
- Fixture `expectedTotalScore` values are ground-truth: company [72.65, 55.75, 57.75], ETF [88.25, 45.75]. These must match exactly (± 0.01) in tests.
- Test command: `npm run build && node --test --test-concurrency=1 dist/test/*.test.js` (same pattern as all other packages).
- Build command: `tsc -p tsconfig.json`.
- Package name: `@buffr/domain-pack-investing`, version `0.0.1`.

---

### Task 1: Workspace config + contracts extension + package scaffold

Extends `DomainPack` and adds `SourcePolicy` in contracts, registers the new package in the npm workspace, and creates the empty package scaffold. No data files yet — just config and contracts.

**Files:**
- Modify: `package.json` (root) — add `packages/domain-packs/*` to workspaces, add package to `build:packages`
- Modify: `packages/contracts/src/index.ts` — add `SourcePolicy` type, extend `DomainPack` interface
- Create: `packages/domain-packs/investing/package.json`
- Create: `packages/domain-packs/investing/tsconfig.json`
- Create: `packages/domain-packs/investing/src/index.ts` (placeholder)

**Interfaces:**
- Produces: `SourcePolicy` type and extended `DomainPack` interface (used in Tasks 2 and 3)

- [ ] **Step 1: Update root `package.json` workspaces and build:packages**

The current `workspaces` is `["packages/*"]` — this glob does not reach `packages/domain-packs/investing`. Add the nested glob. Also append the new package to `build:packages`.

Full root `package.json` (show only the changed fields — replace `"workspaces"` and `"build:packages"` in the existing file):

```json
"workspaces": ["packages/*", "packages/domain-packs/*"],
```

And the build:packages script line (append the new package):
```json
"build:packages": "npm run build -w @buffr/contracts && npm run build -w @buffr/kernel && npm run build -w @buffr/connectors && npm run build -w @buffr/capabilities && npm run build -w @buffr/domain-pack-investing",
```

- [ ] **Step 2: Add `SourcePolicy` and extend `DomainPack` in `packages/contracts/src/index.ts`**

Add `SourcePolicy` immediately before the existing `DomainPack` interface (so types appear in dependency order). Replace the existing `DomainPack` interface with the extended version. Complete replacement of both declarations:

```typescript
export type SourcePolicy = {
  sourceType: string;
  priority: number;
  freshnessRequirement?: 'live' | 'recent' | 'stale' | 'unknown';
  notes?: string;
};

export interface DomainPack {
  id: string;
  version: string;
  entities: Record<string, unknown>;
  scorecards: Record<string, ScorecardDefinition>;
  dimensions: Record<string, AnalysisDimension[]>;
  sourcePolicies: SourcePolicy[];
  prompts: Record<string, string>;
  evalDatasets: string[];
}
```

The old `DomainPack` in contracts was:
```typescript
export interface DomainPack {
  id: string;
  version: string;
  entities: Record<string, unknown>;
  prompts: Record<string, string>;
  evalDatasets: string[];
}
```

Replace it (and add `SourcePolicy` above it). Leave all other contracts interfaces unchanged.

- [ ] **Step 3: Build contracts to verify the extension is valid TypeScript**

```bash
npm run build -w @buffr/contracts
```

Expected: exits 0 with no errors. If TypeScript errors appear, fix them before continuing.

- [ ] **Step 4: Create `packages/domain-packs/investing/package.json`**

```json
{
  "name": "@buffr/domain-pack-investing",
  "version": "0.0.1",
  "type": "module",
  "main": "./dist/src/index.js",
  "types": "./dist/src/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/src/index.d.ts",
      "import": "./dist/src/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test --test-concurrency=1 dist/test/*.test.js"
  },
  "dependencies": {
    "@buffr/contracts": "0.0.1"
  },
  "devDependencies": {
    "@buffr/capabilities": "0.0.1",
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 5: Create `packages/domain-packs/investing/tsconfig.json`**

The package is three levels deep from the monorepo root (`packages/domain-packs/investing/`), so `extends` goes up three directories.

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 6: Create placeholder `packages/domain-packs/investing/src/index.ts`**

```typescript
export {};
```

This satisfies the TypeScript compiler for Task 1. It will be replaced in Task 2.

- [ ] **Step 7: Register the new package in the npm workspace**

```bash
npm install
```

Expected: npm prints something like `added N packages` or `up to date`. The workspace now knows about `@buffr/domain-pack-investing`. If you see an error about the package not found, verify the `workspaces` array in root `package.json` includes `"packages/domain-packs/*"`.

- [ ] **Step 8: Commit**

```bash
git add package.json packages/contracts/src/index.ts packages/domain-packs/investing/package.json packages/domain-packs/investing/tsconfig.json packages/domain-packs/investing/src/index.ts
git commit -m "feat: add SourcePolicy + extend DomainPack in contracts; scaffold @buffr/domain-pack-investing"
```

---

### Task 2: Pure data constants + barrel export

Creates all five source files (entities, dimensions, scorecards, source-policies, prompts) and a complete barrel export. No logic — just TypeScript constants and types. Verified by a clean build.

**Files:**
- Create: `packages/domain-packs/investing/src/entities.ts`
- Create: `packages/domain-packs/investing/src/dimensions.ts`
- Create: `packages/domain-packs/investing/src/scorecards.ts`
- Create: `packages/domain-packs/investing/src/source-policies.ts`
- Create: `packages/domain-packs/investing/src/prompts.ts`
- Modify: `packages/domain-packs/investing/src/index.ts` (replace placeholder with barrel)

**Interfaces:**
- Consumes: `AnalysisDimension`, `ScorecardDefinition`, `SourcePolicy` from `@buffr/contracts` (added in Task 1)
- Produces: `CompanyEntity`, `EtfEntity`, `INVESTING_ENTITIES`, `COMPANY_DIMENSIONS`, `ETF_DIMENSIONS`, `COMPANY_SCORECARD`, `ETF_SCORECARD`, `INVESTING_SOURCE_POLICIES`, `INVESTING_PROMPTS` (all used in Task 3)

- [ ] **Step 1: Write `packages/domain-packs/investing/src/entities.ts`**

```typescript
export type CompanyEntity = {
  ticker: string;
  name: string;
  exchange: string;
  sector?: string;
  industry?: string;
  marketCapUsd?: number;
  description?: string;
};

export type EtfEntity = {
  ticker: string;
  name: string;
  issuer: string;
  expenseRatioPct?: number;
  aumUsd?: number;
  indexTracked?: string;
  assetClass?: 'equity' | 'bond' | 'commodity' | 'real-estate' | 'mixed';
  description?: string;
};

export const INVESTING_ENTITIES: Record<string, unknown> = {
  company: {} as CompanyEntity,
  etf: {} as EtfEntity,
};
```

- [ ] **Step 2: Write `packages/domain-packs/investing/src/dimensions.ts`**

```typescript
import type { AnalysisDimension } from '@buffr/contracts';

export const COMPANY_DIMENSIONS: AnalysisDimension[] = [
  {
    id: 'business-quality',
    label: 'Business Quality',
    description: 'Assess moat strength, competitive advantages, brand, switching costs, and market position.',
    weight: 0.25,
  },
  {
    id: 'financial-strength',
    label: 'Financial Strength',
    description: 'Assess balance sheet health, free cash flow generation, debt levels, and interest coverage.',
    weight: 0.20,
  },
  {
    id: 'growth-durability',
    label: 'Growth Durability',
    description: 'Assess the sustainability and quality of revenue and earnings growth over a 3–5 year horizon.',
    weight: 0.15,
  },
  {
    id: 'valuation',
    label: 'Valuation',
    description: 'Assess price relative to intrinsic value using P/E, P/FCF, EV/EBITDA, and DCF where evidence allows.',
    weight: 0.20,
  },
  {
    id: 'risk',
    label: 'Risk',
    description: 'Assess macro exposure, regulatory risk, key-person dependency, customer concentration, and competitive threats.',
    weight: 0.20,
  },
];

export const ETF_DIMENSIONS: AnalysisDimension[] = [
  {
    id: 'holdings-quality',
    label: 'Holdings Quality',
    description: 'Assess the quality of underlying securities: profitability, balance sheet strength, and moat.',
    weight: 0.30,
  },
  {
    id: 'expense-ratio',
    label: 'Expense Ratio',
    description: 'Assess the annual cost relative to peer ETFs tracking similar indices or asset classes.',
    weight: 0.25,
  },
  {
    id: 'diversification',
    label: 'Diversification',
    description: 'Assess concentration risk across holdings, sectors, geographies, and factor exposures.',
    weight: 0.20,
  },
  {
    id: 'liquidity',
    label: 'Liquidity',
    description: 'Assess AUM size, average daily volume, and bid-ask spread relative to peers.',
    weight: 0.15,
  },
  {
    id: 'tracking-error',
    label: 'Tracking Error',
    description: 'Assess how closely the ETF tracks its stated index or benchmark over trailing periods.',
    weight: 0.10,
  },
];
```

- [ ] **Step 3: Write `packages/domain-packs/investing/src/scorecards.ts`**

```typescript
import type { ScorecardDefinition } from '@buffr/contracts';

export const COMPANY_SCORECARD: ScorecardDefinition = {
  id: 'investing-company-v1',
  version: '1.0.0',
  metrics: [
    { id: 'business-quality',   label: 'Business Quality',   weight: 0.25, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'financial-strength', label: 'Financial Strength', weight: 0.20, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'growth-durability',  label: 'Growth Durability',  weight: 0.15, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'valuation',          label: 'Valuation',          weight: 0.20, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'risk',               label: 'Risk',               weight: 0.20, direction: 'lower-is-better',  min: 0, max: 100 },
  ],
  minimumEvidenceCount: 5,
  confidencePenalty: 0.8,
};

export const ETF_SCORECARD: ScorecardDefinition = {
  id: 'investing-etf-v1',
  version: '1.0.0',
  metrics: [
    { id: 'holdings-quality', label: 'Holdings Quality', weight: 0.30, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'expense-ratio',    label: 'Expense Ratio',    weight: 0.25, direction: 'lower-is-better',  min: 0, max: 100 },
    { id: 'diversification',  label: 'Diversification',  weight: 0.20, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'liquidity',        label: 'Liquidity',        weight: 0.15, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'tracking-error',   label: 'Tracking Error',   weight: 0.10, direction: 'lower-is-better',  min: 0, max: 100 },
  ],
  minimumEvidenceCount: 5,
  confidencePenalty: 0.8,
};
```

- [ ] **Step 4: Write `packages/domain-packs/investing/src/source-policies.ts`**

```typescript
import type { SourcePolicy } from '@buffr/contracts';

export const INVESTING_SOURCE_POLICIES: SourcePolicy[] = [
  {
    sourceType: 'sec-filing',
    priority: 10,
    freshnessRequirement: 'recent',
    notes: 'SEC 10-K, 10-Q, 8-K filings. Authoritative for financial data.',
  },
  {
    sourceType: 'fund-document',
    priority: 9,
    freshnessRequirement: 'recent',
    notes: 'ETF prospectus, fact sheets, semi-annual reports. Authoritative for fund data.',
  },
  {
    sourceType: 'financial-data',
    priority: 7,
    freshnessRequirement: 'live',
    notes: 'Price feeds, ratio calculators. Live preferred; stale price data triggers a warning.',
  },
  {
    sourceType: 'news-analysis',
    priority: 5,
    freshnessRequirement: 'recent',
    notes: 'Earnings coverage, analyst reports, financial press. Useful for qualitative signals.',
  },
  {
    sourceType: 'social-sentiment',
    priority: 2,
    freshnessRequirement: 'live',
    notes: 'Forums, social media. Low-trust; supplements but does not replace primary sources.',
  },
];
```

- [ ] **Step 5: Write `packages/domain-packs/investing/src/prompts.ts`**

```typescript
export const INVESTING_PROMPTS: Record<string, string> = {
  'analyzer-context':
    'You are analyzing an investment opportunity. Apply rigorous fundamental analysis. ' +
    'Flag red flags clearly. When evidence is insufficient, say so — do not extrapolate. ' +
    'Cite the evidence source IDs that support each finding.',

  'teacher-context':
    'Explain the investment analysis to an individual investor. Use plain language. ' +
    'Present risks alongside opportunities. Do not give financial advice or price targets. ' +
    'Summarise what is known and what remains uncertain.',
};
```

- [ ] **Step 6: Replace the placeholder `packages/domain-packs/investing/src/index.ts` with the full barrel**

```typescript
export * from './entities.js';
export * from './dimensions.js';
export * from './scorecards.js';
export * from './source-policies.js';
export * from './prompts.js';
```

- [ ] **Step 7: Build to verify all five files compile clean**

```bash
npm run build -w @buffr/domain-pack-investing
```

Expected: exits 0. `dist/src/` directory created with compiled `.js` and `.d.ts` files for all five modules plus `index`. If TypeScript errors appear, fix them now — common mistakes: missing `.js` extension on imports, wrong import paths, type mismatches.

- [ ] **Step 8: Commit**

```bash
git add packages/domain-packs/investing/src/
git commit -m "feat: add investing pack data constants (entities, dimensions, scorecards, source-policies, prompts)"
```

---

### Task 3: Pack manifest + eval fixtures + test suite

Wires everything together: the `INVESTING_PACK` manifest (satisfies the extended `DomainPack` interface at compile time), the JSON eval fixtures, and a test file that drives the Scorer against each fixture to verify deterministic arithmetic.

**Files:**
- Create: `packages/domain-packs/investing/src/pack.ts`
- Modify: `packages/domain-packs/investing/src/index.ts` (add pack export)
- Create: `packages/domain-packs/investing/eval/company-fixtures.json`
- Create: `packages/domain-packs/investing/eval/etf-fixtures.json`
- Create: `packages/domain-packs/investing/test/investing-pack.test.ts`

**Interfaces:**
- Consumes: `DomainPack` from `@buffr/contracts`; all constants from `./entities.js`, `./dimensions.js`, `./scorecards.js`, `./source-policies.js`, `./prompts.js`; `Scorer` + `AnalysisFinding` from `@buffr/capabilities`; `AgentContext` from `@buffr/contracts`
- Produces: `INVESTING_PACK` (the final deliverable; used by Phase 4 engines)

- [ ] **Step 1: Write the failing test first**

Create `packages/domain-packs/investing/test/investing-pack.test.ts`:

```typescript
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
```

Note: The test reads fixtures from `../../eval/` relative to the compiled test at `dist/test/`. That path (`dist/test/` → `dist/` → `packages/domain-packs/investing/` → `eval/`) is correct.

- [ ] **Step 2: Verify the test fails (pack.ts and eval files don't exist yet)**

Ensure `@buffr/capabilities` is built before attempting to compile (it must have a `dist/` directory):

```bash
npm run build -w @buffr/capabilities
```

Then attempt to build the investing pack (expect a TypeScript error because `../src/index.js` doesn't export `COMPANY_SCORECARD` or `ETF_SCORECARD` yet — pack.ts and the scorecards export are missing from the barrel):

```bash
npm run build -w @buffr/domain-pack-investing 2>&1 | head -20
```

Expected: TypeScript error about missing exports or missing `pack.ts`. If no error appears, the test still fails at runtime because the JSON fixtures don't exist. Either failure is the correct "red" state.

- [ ] **Step 3: Create `packages/domain-packs/investing/eval/company-fixtures.json`**

Score arithmetic (for reference — do not change these values):
- Fixture 1: 85×0.25 + 78×0.20 + 72×0.15 + 60×0.20 + (100−35)×0.20 = 21.25+15.60+10.80+12.00+13.00 = **72.65**
- Fixture 2: 80×0.25 + 70×0.20 + 65×0.15 + (100−40)×0.20 + 0(missing) = 20.00+14.00+9.75+12.00+0 = **55.75**
- Fixture 3: 70×0.25 + 60×0.20 + 55×0.15 + 50×0.20 + (100−50)×0.20 = 17.50+12.00+8.25+10.00+10.00 = **57.75**

```json
[
  {
    "description": "Strong company — all dimensions present",
    "findings": [
      { "dimensionId": "business-quality",  "score": 85, "confidence": 0.9,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "financial-strength","score": 78, "confidence": 0.85, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "growth-durability", "score": 72, "confidence": 0.8,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "valuation",         "score": 60, "confidence": 0.75, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "risk",              "score": 35, "confidence": 0.85, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 7,
    "expectedTotalScore": 72.65,
    "expectedWarnings": []
  },
  {
    "description": "Missing valuation dimension",
    "findings": [
      { "dimensionId": "business-quality",  "score": 80, "confidence": 0.9,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "financial-strength","score": 70, "confidence": 0.8,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "growth-durability", "score": 65, "confidence": 0.75, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "risk",              "score": 40, "confidence": 0.8,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 5,
    "expectedTotalScore": 55.75,
    "expectedWarningsContain": ["valuation"]
  },
  {
    "description": "Sparse evidence — confidence penalised",
    "findings": [
      { "dimensionId": "business-quality",  "score": 70, "confidence": 0.7,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "financial-strength","score": 60, "confidence": 0.6,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "growth-durability", "score": 55, "confidence": 0.65, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "valuation",         "score": 50, "confidence": 0.6,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "risk",              "score": 50, "confidence": 0.7,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 3,
    "expectedTotalScore": 57.75,
    "expectedConfidencePenalised": true
  }
]
```

- [ ] **Step 4: Create `packages/domain-packs/investing/eval/etf-fixtures.json`**

Score arithmetic:
- Fixture 1: 80×0.30 + (100−10)×0.25 + 90×0.20 + 95×0.15 + (100−5)×0.10 = 24.00+22.50+18.00+14.25+9.50 = **88.25**
- Fixture 2: 65×0.30 + (100−85)×0.25 + 40×0.20 + 50×0.15 + (100−30)×0.10 = 19.50+3.75+8.00+7.50+7.00 = **45.75**

```json
[
  {
    "description": "Low-cost broad market ETF",
    "findings": [
      { "dimensionId": "holdings-quality","score": 80, "confidence": 0.85, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "expense-ratio",   "score": 10, "confidence": 0.95, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "diversification", "score": 90, "confidence": 0.9,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "liquidity",       "score": 95, "confidence": 0.95, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "tracking-error",  "score": 5,  "confidence": 0.9,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 6,
    "expectedTotalScore": 88.25,
    "expectedWarnings": []
  },
  {
    "description": "High-cost thematic ETF",
    "findings": [
      { "dimensionId": "holdings-quality","score": 65, "confidence": 0.75, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "expense-ratio",   "score": 85, "confidence": 0.95, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "diversification", "score": 40, "confidence": 0.8,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "liquidity",       "score": 50, "confidence": 0.8,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "tracking-error",  "score": 30, "confidence": 0.8,  "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 5,
    "expectedTotalScore": 45.75,
    "expectedWarnings": []
  }
]
```

- [ ] **Step 5: Write `packages/domain-packs/investing/src/pack.ts`**

```typescript
import type { DomainPack } from '@buffr/contracts';
import { INVESTING_ENTITIES } from './entities.js';
import { COMPANY_DIMENSIONS, ETF_DIMENSIONS } from './dimensions.js';
import { COMPANY_SCORECARD, ETF_SCORECARD } from './scorecards.js';
import { INVESTING_SOURCE_POLICIES } from './source-policies.js';
import { INVESTING_PROMPTS } from './prompts.js';

export const INVESTING_PACK: DomainPack = {
  id: 'investing',
  version: '1.0.0',
  entities: INVESTING_ENTITIES,
  scorecards: {
    company: COMPANY_SCORECARD,
    etf: ETF_SCORECARD,
  },
  dimensions: {
    company: COMPANY_DIMENSIONS,
    etf: ETF_DIMENSIONS,
  },
  sourcePolicies: INVESTING_SOURCE_POLICIES,
  prompts: INVESTING_PROMPTS,
  evalDatasets: ['eval/company-fixtures.json', 'eval/etf-fixtures.json'],
};
```

If TypeScript reports a type error on this assignment, the most common cause is a mismatch between the `ScorecardDefinition` type used by `COMPANY_SCORECARD` and the one in the `DomainPack.scorecards` field. Both come from `@buffr/contracts`, so this should not happen. If it does, rebuild contracts first (`npm run build -w @buffr/contracts`).

- [ ] **Step 6: Add pack to the barrel export in `packages/domain-packs/investing/src/index.ts`**

```typescript
export * from './entities.js';
export * from './dimensions.js';
export * from './scorecards.js';
export * from './source-policies.js';
export * from './prompts.js';
export * from './pack.js';
```

- [ ] **Step 7: Run the tests and verify all 5 pass**

```bash
npm run test -w @buffr/domain-pack-investing
```

Expected output (5 passing tests):
```
▶ investing-pack: company fixtures
  ✔ Strong company — all dimensions present
  ✔ Missing valuation dimension
  ✔ Sparse evidence — confidence penalised
▶ investing-pack: etf fixtures
  ✔ Low-cost broad market ETF
  ✔ High-cost thematic ETF
```

If a score test fails, double-check the `expectedTotalScore` in the JSON against the arithmetic in Step 3 and Step 4 comments. If a confidence-penalised test fails, verify the Scorer's `confidencePenalty` logic: mean confidence for fixture 3 is `(0.7+0.6+0.65+0.6+0.7)/5 = 0.65`; penalised = `0.65 × 0.8 = 0.52`, which must be less than 0.65. If a warning test fails, check that the Scorer warning includes the missing dimension's `id` string (e.g. `"valuation"`), not its label.

- [ ] **Step 8: Commit**

```bash
git add packages/domain-packs/investing/src/pack.ts packages/domain-packs/investing/src/index.ts packages/domain-packs/investing/eval/ packages/domain-packs/investing/test/
git commit -m "feat: add INVESTING_PACK manifest, eval fixtures, and Scorer-based test suite"
```
