# Investing Domain Pack Design

**Date:** 2026-07-29
**Phase:** DI Platform Phase 3
**Status:** Approved

---

## Goal

Build `@buffr/domain-pack-investing` — the first domain pack for the DI platform. It provides investing-specific entity schemas, analysis dimensions, scorecards, source policies, and prompt fragments that Phase 4 engines will assemble into research workflows. Adding the pack requires no changes to kernel or capabilities.

---

## Architecture

### Dependency graph

```
@buffr/contracts
      ↓
@buffr/domain-pack-investing
```

The pack depends only on `@buffr/contracts`. It does not import from `@buffr/kernel`, `@buffr/capabilities`, or `@buffr/connectors`. Engines (Phase 4) import from all of these and wire them together.

### Package location

```
packages/domain-packs/investing/
```

Published as `@buffr/domain-pack-investing`. The `packages/domain-packs/` directory accommodates future packs (digital products, etc.) without polluting `packages/` root.

### Package structure

```
packages/domain-packs/investing/
├── src/
│   ├── entities.ts         — CompanyEntity, EtfEntity types + schema placeholders
│   ├── dimensions.ts       — COMPANY_DIMENSIONS, ETF_DIMENSIONS
│   ├── scorecards.ts       — COMPANY_SCORECARD, ETF_SCORECARD
│   ├── source-policies.ts  — INVESTING_SOURCE_POLICIES
│   ├── prompts.ts          — INVESTING_PROMPTS
│   ├── pack.ts             — INVESTING_PACK manifest (implements DomainPack)
│   └── index.ts            — barrel re-export
├── eval/
│   ├── company-fixtures.json
│   └── etf-fixtures.json
├── test/
│   └── investing-pack.test.ts
├── package.json
└── tsconfig.json
```

### Build and test

Matches existing monorepo packages:
- Build: `tsc -p tsconfig.json`
- Test: `npm run build && node --test --test-concurrency=1 dist/test/*.test.js`

---

## Contracts extension

Two additions to `packages/contracts/src/index.ts`:

### SourcePolicy (new type)

```typescript
export type SourcePolicy = {
  sourceType: string;
  priority: number;
  freshnessRequirement?: 'live' | 'recent' | 'stale' | 'unknown';
  notes?: string;
};
```

`sourceType` is a string key matching `Evidence.sourceType`. `priority` is an integer; higher = preferred by the engine when selecting connectors. `freshnessRequirement` is the minimum acceptable freshness level for this source type.

### DomainPack (extended)

Current shape:
```typescript
export interface DomainPack {
  id: string;
  version: string;
  entities: Record<string, unknown>;
  prompts: Record<string, string>;
  evalDatasets: string[];
}
```

Extended shape (add three fields):
```typescript
export interface DomainPack {
  id: string;
  version: string;
  entities: Record<string, unknown>;
  scorecards: Record<string, ScorecardDefinition>;   // ← new
  dimensions: Record<string, AnalysisDimension[]>;   // ← new
  sourcePolicies: SourcePolicy[];                    // ← new
  prompts: Record<string, string>;
  evalDatasets: string[];
}
```

`scorecards` keys are named identifiers (e.g. `'company'`, `'etf'`). `dimensions` keys match `scorecards` keys. `sourcePolicies` is ordered by priority descending.

---

## Entity schemas

Defined in `packages/domain-packs/investing/src/entities.ts`.

### CompanyEntity

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
```

### EtfEntity

```typescript
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
```

`expenseRatioPct` is expressed as a percentage (e.g. `0.03` = 0.03%). Optional fields are sparse at research initiation — connectors populate them during the Collector phase.

### Pack entities record

```typescript
export const INVESTING_ENTITIES: Record<string, unknown> = {
  company: {} as CompanyEntity,
  etf: {} as EtfEntity,
};
```

The `entities` field on the `DomainPack` manifest is a shape reference, not live data. Real instances are constructed by the engine.

---

## Analysis dimensions

Defined in `packages/domain-packs/investing/src/dimensions.ts`.

### Company dimensions

Fed to `Analyzer` as `AnalysisDimension[]` when analyzing a company:

```typescript
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
```

### ETF dimensions

Fed to `Analyzer` when analyzing an ETF:

```typescript
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

---

## Scorecards

Defined in `packages/domain-packs/investing/src/scorecards.ts`. Each `ScoreMetric.id` matches the corresponding `AnalysisDimension.id`.

### Company scorecard

```typescript
export const COMPANY_SCORECARD: ScorecardDefinition = {
  id: 'investing-company-v1',
  version: '1.0.0',
  metrics: [
    { id: 'business-quality',  label: 'Business Quality',   weight: 0.25, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'financial-strength', label: 'Financial Strength', weight: 0.20, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'growth-durability',  label: 'Growth Durability',  weight: 0.15, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'valuation',          label: 'Valuation',          weight: 0.20, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'risk',               label: 'Risk',               weight: 0.20, direction: 'lower-is-better',  min: 0, max: 100 },
  ],
  minimumEvidenceCount: 5,
  confidencePenalty: 0.8,
};
```

### ETF scorecard

```typescript
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

Weights sum to 1.0 in both scorecards.

---

## Source policies

Defined in `packages/domain-packs/investing/src/source-policies.ts`, ordered priority-descending:

```typescript
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

---

## Prompts

Defined in `packages/domain-packs/investing/src/prompts.ts`. These are short string fragments that Phase 4 engines prepend to the generic `Analyzer` and `Teacher` system prompts.

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

---

## Pack manifest

Defined in `packages/domain-packs/investing/src/pack.ts`. Implements `DomainPack` from `@buffr/contracts`:

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

---

## Eval fixtures

Two JSON files in `packages/domain-packs/investing/eval/`. Each fixture has a fixed findings array and the expected Scorer output for deterministic arithmetic verification.

### `company-fixtures.json` (3 test cases)

```json
[
  {
    "description": "Strong company — all dimensions present",
    "findings": [
      { "dimensionId": "business-quality",  "score": 85, "confidence": 0.9, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "financial-strength", "score": 78, "confidence": 0.85, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "growth-durability",  "score": 72, "confidence": 0.8, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "valuation",          "score": 60, "confidence": 0.75, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "risk",               "score": 35, "confidence": 0.85, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 7,
    "expectedTotalScore": 72.65,
    "expectedWarnings": []
  },
  {
    "description": "Missing valuation dimension",
    "findings": [
      { "dimensionId": "business-quality",  "score": 80, "confidence": 0.9, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "financial-strength", "score": 70, "confidence": 0.8, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "growth-durability",  "score": 65, "confidence": 0.75, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "risk",               "score": 40, "confidence": 0.8, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 5,
    "expectedTotalScore": 55.75,
    "expectedWarningsContain": ["valuation"]
  },
  {
    "description": "Sparse evidence — confidence penalised",
    "findings": [
      { "dimensionId": "business-quality",  "score": 70, "confidence": 0.7, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "financial-strength", "score": 60, "confidence": 0.6, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "growth-durability",  "score": 55, "confidence": 0.65, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "valuation",          "score": 50, "confidence": 0.6, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "risk",               "score": 50, "confidence": 0.7, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 3,
    "expectedTotalScore": 57.75,
    "expectedConfidencePenalised": true
  }
]
```

**Score arithmetic for fixture 1:**
- business-quality: 85 × 0.25 = 21.25
- financial-strength: 78 × 0.20 = 15.60
- growth-durability: 72 × 0.15 = 10.80
- valuation: 60 × 0.20 = 12.00
- risk: (100−35) × 0.20 = 65 × 0.20 = 13.00
- **Total: 72.65** *(corrected from draft — spec is authoritative)*

**Score arithmetic for fixture 2 (missing valuation):**
- business-quality: 80 × 0.25 = 20.00
- financial-strength: 70 × 0.20 = 14.00
- growth-durability: 65 × 0.15 = 9.75
- risk: (100−40) × 0.20 = 60 × 0.20 = 12.00
- valuation: missing → 0
- **Total: 55.75** *(corrected)*

**Score arithmetic for fixture 3 (sparse evidence):**
- business-quality: 70 × 0.25 = 17.50
- financial-strength: 60 × 0.20 = 12.00
- growth-durability: 55 × 0.15 = 8.25
- valuation: 50 × 0.20 = 10.00
- risk: (100−50) × 0.20 = 50 × 0.20 = 10.00
- **Total: 57.75** *(corrected)*

### `etf-fixtures.json` (2 test cases)

```json
[
  {
    "description": "Low-cost broad market ETF",
    "findings": [
      { "dimensionId": "holdings-quality", "score": 80, "confidence": 0.85, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "expense-ratio",    "score": 10, "confidence": 0.95, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "diversification",  "score": 90, "confidence": 0.9, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "liquidity",        "score": 95, "confidence": 0.95, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "tracking-error",   "score": 5,  "confidence": 0.9, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 6,
    "expectedTotalScore": 88.25,
    "expectedWarnings": []
  },
  {
    "description": "High-cost thematic ETF",
    "findings": [
      { "dimensionId": "holdings-quality", "score": 65, "confidence": 0.75, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "expense-ratio",    "score": 85, "confidence": 0.95, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "diversification",  "score": 40, "confidence": 0.8, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "liquidity",        "score": 50, "confidence": 0.8, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "tracking-error",   "score": 30, "confidence": 0.8, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 5,
    "expectedTotalScore": 45.75,
    "expectedWarnings": []
  }
]
```

**ETF score arithmetic for fixture 1 (low-cost broad market):**
- holdings-quality: 80 × 0.30 = 24.00
- expense-ratio: (100−10) × 0.25 = 90 × 0.25 = 22.50
- diversification: 90 × 0.20 = 18.00
- liquidity: 95 × 0.15 = 14.25
- tracking-error: (100−5) × 0.10 = 95 × 0.10 = 9.50
- **Total: 88.25** *(corrected)*

**ETF score arithmetic for fixture 2 (high-cost thematic):**
- holdings-quality: 65 × 0.30 = 19.50
- expense-ratio: (100−85) × 0.25 = 15 × 0.25 = 3.75
- diversification: 40 × 0.20 = 8.00
- liquidity: 50 × 0.15 = 7.50
- tracking-error: (100−30) × 0.10 = 70 × 0.10 = 7.00
- **Total: 45.75** *(corrected)*

---

## Test strategy

`test/investing-pack.test.ts` uses `node:test` + `node:assert/strict`. It imports `Scorer` from `@buffr/capabilities` and runs it against each fixture to verify arithmetic. No model calls — pure deterministic math.

```typescript
// Pattern for each fixture:
const result = await scorer.execute(
  { findings: fixture.findings, scorecard: COMPANY_SCORECARD, evidenceCount: fixture.evidenceCount },
  ctx,
);
assert.ok(Math.abs(result.data.totalScore - fixture.expectedTotalScore) < 0.01);
```

Missing-dimension fixtures also assert that `result.data.warnings` includes the missing dimension id.
Sparse-evidence fixtures assert that `result.data.confidence < meanConfidence` (penalised).

---

## Global constraints

- TypeScript ESM; all imports use `.js` extension.
- No new prod dependencies beyond `@buffr/contracts` and `@buffr/capabilities` (test-only dep on capabilities for the Scorer).
- No kernel code changes.
- `DomainPack` extension in contracts must be backwards-compatible (all new fields are required, but the interface was not previously implemented anywhere outside the contracts package itself).
- Fixture `expectedTotalScore` values are ground-truth arithmetic — use the corrected values from this spec (see score arithmetic sections above).

---

## Exit criteria (DI plan Phase 3 — investing pack)

- `@buffr/domain-pack-investing` builds and tests clean in the monorepo.
- `DomainPack` interface in contracts is extended with `scorecards`, `dimensions`, `sourcePolicies`.
- `INVESTING_PACK` object satisfies the extended `DomainPack` interface at compile time.
- Eval fixtures test all three Scorer behaviors: happy path, missing dimension, and sparse-evidence penalty.
- No kernel or capabilities code was changed to accommodate the pack.
