# Market Research Chat Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/research <topic>` to the buffr chat UI, backed by a new `@buffr/domain-pack-market-research` and `@buffr/engine-market-research`, scoring problems people face across Frequency, Trend Velocity, Specificity, and Monetizability.

**Architecture:** The engine follows the same Collector → Analyzer → Scorer → Teacher pipeline as `@buffr/engine-investing`. A new domain pack supplies the four dimensions, one scorecard, and analyzer/teacher prompts. `session.ts` gains `research()` and `evalResearch()` methods; `chat.tsx` gains `/research <topic>`, `/eval research`, and `/eval investing` handlers (the existing bare `/eval` becomes a usage hint).

**Tech Stack:** TypeScript ESM, `node:test` + `node:assert/strict`, `@buffr/capabilities` (Collector/Analyzer/Scorer/Teacher), `@buffr/connectors` (GoogleTrendsConnector, BraveSearchConnector, TavilySearchConnector, CachedConnector), `@buffr/contracts` (Engine, DomainPack, AgentContext).

## Global Constraints

- No new npm dependencies.
- TypeScript ESM; all local imports use `.js` extension.
- Only `src/session.ts`, `src/cli/chat.tsx`, `test/commands.test.ts`, and root `package.json` are modified in the app; all upstream packages (`@buffr/contracts`, `@buffr/kernel`, `@buffr/capabilities`, `@buffr/connectors`) are untouched.
- `packages/domain-packs/market-research/tsconfig.json` extends `"../../../tsconfig.base.json"`.
- `packages/engines/market-research/tsconfig.json` extends `"../../../tsconfig.base.json"`.
- No ANSI color codes in any output string.
- Pass threshold for eval: `|actual − expected| ≤ 0.01`.
- `MarketResearchEngine` constructed once per session (not per request).
- `AmazonReviewsConnector` is NOT used (requires an ASIN, not a topic string).
- `GoogleTrendsConnector` always wires in (no API key needed).

---

### Task 1: `@buffr/domain-pack-market-research` — dimensions, scorecard, prompts, pack, eval fixtures, test

**Files:**
- Create: `packages/domain-packs/market-research/package.json`
- Create: `packages/domain-packs/market-research/tsconfig.json`
- Create: `packages/domain-packs/market-research/src/dimensions.ts`
- Create: `packages/domain-packs/market-research/src/scorecards.ts`
- Create: `packages/domain-packs/market-research/src/prompts.ts`
- Create: `packages/domain-packs/market-research/src/pack.ts`
- Create: `packages/domain-packs/market-research/src/index.ts`
- Create: `packages/domain-packs/market-research/eval/fixtures.json`
- Create: `packages/domain-packs/market-research/test/scorecard.test.ts`
- Modify: `package.json` (root) — add `@buffr/domain-pack-market-research` to `build:packages` script

**Interfaces:**
- Produces: `MARKET_RESEARCH_DIMENSIONS: AnalysisDimension[]`, `MARKET_RESEARCH_SCORECARD: ScorecardDefinition`, `MARKET_RESEARCH_PROMPTS: Record<string, string>`, `MARKET_RESEARCH_PACK: DomainPack` — all re-exported from `@buffr/domain-pack-market-research`

- [ ] **Step 1: Write the failing test**

Create `packages/domain-packs/market-research/test/scorecard.test.ts`:

```typescript
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
```

- [ ] **Step 2: Create the package scaffold**

`packages/domain-packs/market-research/package.json`:

```json
{
  "name": "@buffr/domain-pack-market-research",
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

`packages/domain-packs/market-research/tsconfig.json`:

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

- [ ] **Step 3: Write `src/dimensions.ts`**

```typescript
import type { AnalysisDimension } from '@buffr/contracts';

export const MARKET_RESEARCH_DIMENSIONS: AnalysisDimension[] = [
  {
    id: 'frequency',
    label: 'Frequency',
    description:
      'How often this pain point is mentioned across search queries, forum posts, and product complaints. ' +
      'High frequency means many people face it, not just a vocal minority.',
    weight: 0.30,
  },
  {
    id: 'trend-velocity',
    label: 'Trend Velocity',
    description:
      'Is interest in this problem rising, stable, or declining? ' +
      'Rising problems represent better opportunities than peaked ones — the market is still forming.',
    weight: 0.25,
  },
  {
    id: 'specificity',
    label: 'Specificity',
    description:
      'Is the problem concrete enough to build a targeted solution? ' +
      'Vague complaints ("too hard to use") score low. Specific ones ("no bulk CSV import for product variants") score high.',
    weight: 0.20,
  },
  {
    id: 'monetizability',
    label: 'Monetizability',
    description:
      'Does a clear, sellable solution exist — a template, digital download, or app feature — that people would pay for? ' +
      'Assess whether the problem maps to a concrete product.',
    weight: 0.25,
  },
];
```

- [ ] **Step 4: Write `src/scorecards.ts`**

```typescript
import type { ScorecardDefinition } from '@buffr/contracts';

export const MARKET_RESEARCH_SCORECARD: ScorecardDefinition = {
  id: 'market-research-v1',
  version: '1.0.0',
  metrics: [
    { id: 'frequency',      label: 'Frequency',      weight: 0.30, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'trend-velocity', label: 'Trend Velocity',  weight: 0.25, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'specificity',    label: 'Specificity',     weight: 0.20, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'monetizability', label: 'Monetizability',  weight: 0.25, direction: 'higher-is-better', min: 0, max: 100 },
  ],
  minimumEvidenceCount: 4,
  confidencePenalty: 0.8,
};
```

- [ ] **Step 5: Write `src/prompts.ts`**

```typescript
export const MARKET_RESEARCH_PROMPTS: Record<string, string> = {
  'analyzer-context':
    'You are analyzing market demand and consumer pain points. ' +
    'Identify specific, concrete problems that appear repeatedly in the evidence. ' +
    'Assess trend direction from search data: rising interest means the problem is growing. ' +
    'Flag problems that are vague or unlikely to be monetizable. ' +
    'Cite the evidence source IDs that support each finding.',

  'teacher-context':
    'Explain the market research findings to a solo creator building digital products and apps. ' +
    'List the top problems people face, in plain language. ' +
    'For each problem, suggest a one-line product or app angle that could solve it. ' +
    'Prioritise specificity — vague problems are not actionable. ' +
    'Note where the evidence is thin or where the trend is declining.',
};
```

- [ ] **Step 6: Write `src/pack.ts`**

```typescript
import type { DomainPack } from '@buffr/contracts';
import { MARKET_RESEARCH_DIMENSIONS } from './dimensions.js';
import { MARKET_RESEARCH_SCORECARD } from './scorecards.js';
import { MARKET_RESEARCH_PROMPTS } from './prompts.js';

export const MARKET_RESEARCH_PACK: DomainPack = {
  id: 'market-research',
  version: '1.0.0',
  entities: {},
  scorecards: { topic: MARKET_RESEARCH_SCORECARD },
  dimensions: { topic: MARKET_RESEARCH_DIMENSIONS },
  sourcePolicies: [],
  prompts: MARKET_RESEARCH_PROMPTS,
  evalDatasets: ['eval/fixtures.json'],
};
```

- [ ] **Step 7: Write `src/index.ts`**

```typescript
export * from './dimensions.js';
export * from './scorecards.js';
export * from './prompts.js';
export * from './pack.js';
```

- [ ] **Step 8: Write `eval/fixtures.json`**

Score formula: `sum(dimensionScore × weight)` — all dimensions are `higher-is-better`, no inversion needed.
- Fixture 1: `88×0.30 + 82×0.25 + 78×0.20 + 75×0.25 = 81.25`
- Fixture 2: `80×0.30 + 60×0.25 + 28×0.20 + 35×0.25 = 53.35`
- Fixture 3: `65×0.30 + 22×0.25 + 70×0.20 + 60×0.25 = 54.00`

```json
[
  {
    "description": "Strong problem — high frequency, rising trend, specific, monetizable",
    "findings": [
      { "dimensionId": "frequency",      "score": 88, "confidence": 0.90, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "trend-velocity", "score": 82, "confidence": 0.85, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "specificity",    "score": 78, "confidence": 0.85, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "monetizability", "score": 75, "confidence": 0.80, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 8,
    "expectedTotalScore": 81.25,
    "expectedWarnings": []
  },
  {
    "description": "Vague problem — frequent but too broad to act on",
    "findings": [
      { "dimensionId": "frequency",      "score": 80, "confidence": 0.85, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "trend-velocity", "score": 60, "confidence": 0.75, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "specificity",    "score": 28, "confidence": 0.70, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "monetizability", "score": 35, "confidence": 0.70, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 6,
    "expectedTotalScore": 53.35,
    "expectedWarnings": []
  },
  {
    "description": "Peaked trend — specific and monetizable but interest declining",
    "findings": [
      { "dimensionId": "frequency",      "score": 65, "confidence": 0.80, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "trend-velocity", "score": 22, "confidence": 0.85, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "specificity",    "score": 70, "confidence": 0.80, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] },
      { "dimensionId": "monetizability", "score": 60, "confidence": 0.75, "summary": "", "positives": [], "negatives": [], "unknowns": [], "evidenceIds": [] }
    ],
    "evidenceCount": 5,
    "expectedTotalScore": 54.00,
    "expectedWarnings": []
  }
]
```

- [ ] **Step 9: Update root `package.json` `build:packages` script**

In `package.json` (root), find the `build:packages` script and append the two new packages at the end:

```json
"build:packages": "npm run build -w @buffr/contracts && npm run build -w @buffr/kernel && npm run build -w @buffr/connectors && npm run build -w @buffr/capabilities && npm run build -w @buffr/domain-pack-investing && npm run build -w @buffr/engine-investing && npm run build -w @buffr/domain-pack-market-research && npm run build -w @buffr/engine-market-research"
```

Note: `@buffr/engine-market-research` is listed here even though it's built in Task 3 — add it now so you never forget.

- [ ] **Step 10: Run the test to verify it fails**

```bash
cd packages/domain-packs/market-research && npm test
```

Expected: the test compiles and runs. All 3 fixture score assertions should pass (scores are pre-verified by formula). If any fail, re-check the fixture JSON and scorecard weights.

- [ ] **Step 11: Commit**

```bash
git add packages/domain-packs/market-research/ package.json
git commit -m "feat: add @buffr/domain-pack-market-research with dimensions, scorecard, eval fixtures"
```

---

### Task 2: `@buffr/engine-market-research` — scaffold + types + stub engine + failing tests

**Files:**
- Create: `packages/engines/market-research/package.json`
- Create: `packages/engines/market-research/tsconfig.json`
- Create: `packages/engines/market-research/src/types.ts`
- Create: `packages/engines/market-research/src/engine.ts` (stub — throws not implemented)
- Create: `packages/engines/market-research/src/index.ts`
- Create: `packages/engines/market-research/test/engine.test.ts`

**Interfaces:**
- Consumes: `MARKET_RESEARCH_DIMENSIONS`, `MARKET_RESEARCH_SCORECARD`, `MARKET_RESEARCH_PROMPTS` from `@buffr/domain-pack-market-research` (Task 1)
- Produces: `MarketResearchEngine`, `MarketResearchInput`, `MarketResearchOutput`, `MarketResearchSource`, `MarketResearchEngineOptions` — all re-exported from `@buffr/engine-market-research`

- [ ] **Step 1: Create package scaffold**

`packages/engines/market-research/package.json`:

```json
{
  "name": "@buffr/engine-market-research",
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
    "@buffr/contracts": "0.0.1",
    "@buffr/kernel": "0.0.1",
    "@buffr/capabilities": "0.0.1",
    "@buffr/connectors": "0.0.1",
    "@buffr/domain-pack-market-research": "0.0.1"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  }
}
```

`packages/engines/market-research/tsconfig.json`:

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

- [ ] **Step 2: Write `src/types.ts`**

```typescript
import type { DataConnector } from '@buffr/connectors';
import type { ModelProvider, ConversationMemory } from '@buffr/kernel';
import type { AnalysisFinding, ScoredMetric } from '@buffr/capabilities';
import type { Evidence } from '@buffr/contracts';

export type MarketResearchSource = {
  connector: DataConnector<unknown, unknown>;
  paramsFor: (topic: string) => unknown;
  optional?: boolean;
};

export type MarketResearchEngineOptions = {
  model: ModelProvider;
  sources: MarketResearchSource[];
  memory?: ConversationMemory;
};

export type MarketResearchInput = {
  topic: string;
  conversationId?: string;
};

export type MarketResearchOutput = {
  summary: {
    topic: string;
    totalScore: number;
    confidence: number;
    explanation: string;
    keyProblems: string[];
    productAngles: string[];
    warnings: string[];
  };
  detail: {
    findings: AnalysisFinding[];
    metrics: ScoredMetric[];
    evidence: Evidence[];
    failed: Array<{ sourceId: string; reason: string }>;
  };
};
```

- [ ] **Step 3: Write stub `src/engine.ts`**

```typescript
import type { Engine, AgentContext, AgentResult } from '@buffr/contracts';
import type { MarketResearchInput, MarketResearchOutput, MarketResearchEngineOptions } from './types.js';

export class MarketResearchEngine implements Engine<MarketResearchInput, MarketResearchOutput> {
  readonly id = 'market-research-engine';
  readonly version = '1.0.0';

  constructor(_opts: MarketResearchEngineOptions) {}

  async run(_input: MarketResearchInput, _context: AgentContext): Promise<AgentResult<MarketResearchOutput>> {
    throw new Error('not implemented');
  }
}
```

- [ ] **Step 4: Write `src/index.ts`**

```typescript
export * from './types.js';
export * from './engine.js';
```

- [ ] **Step 5: Write the failing tests in `test/engine.test.ts`**

```typescript
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
```

- [ ] **Step 6: Run tests to verify they fail**

```bash
cd packages/engines/market-research && npm test
```

Expected: FAIL — `Error: not implemented` (from the stub engine's `run()` method).

- [ ] **Step 7: Commit**

```bash
git add packages/engines/market-research/
git commit -m "feat: scaffold @buffr/engine-market-research with types, stub engine, and failing tests"
```

---

### Task 3: `MarketResearchEngine` — full implementation

**Files:**
- Modify: `packages/engines/market-research/src/engine.ts` (full implementation, replacing the stub)

**Interfaces:**
- Consumes: `MarketResearchInput`, `MarketResearchOutput`, `MarketResearchEngineOptions`, `MarketResearchSource` from `./types.js`; `Collector`, `Analyzer`, `Scorer`, `Teacher` from `@buffr/capabilities`; `MARKET_RESEARCH_DIMENSIONS`, `MARKET_RESEARCH_SCORECARD`, `MARKET_RESEARCH_PROMPTS` from `@buffr/domain-pack-market-research`
- Produces: `MarketResearchEngine` — satisfies `Engine<MarketResearchInput, MarketResearchOutput>`, exported from `src/index.ts`

- [ ] **Step 1: Replace stub `src/engine.ts` with full implementation**

```typescript
import { Collector, Analyzer, Scorer, Teacher } from '@buffr/capabilities';
import type { Engine, AgentContext, AgentResult } from '@buffr/contracts';
import type { ConversationMemory } from '@buffr/kernel';
import {
  MARKET_RESEARCH_DIMENSIONS,
  MARKET_RESEARCH_SCORECARD,
  MARKET_RESEARCH_PROMPTS,
} from '@buffr/domain-pack-market-research';
import type { MarketResearchInput, MarketResearchOutput, MarketResearchSource, MarketResearchEngineOptions } from './types.js';

export class MarketResearchEngine implements Engine<MarketResearchInput, MarketResearchOutput> {
  readonly id = 'market-research-engine';
  readonly version = '1.0.0';

  private readonly collector: Collector;
  private readonly analyzer: Analyzer;
  private readonly scorer: Scorer;
  private readonly teacher: Teacher;
  private readonly sources: MarketResearchSource[];
  private readonly memory?: ConversationMemory;

  constructor(opts: MarketResearchEngineOptions) {
    this.collector = new Collector();
    this.analyzer = new Analyzer(opts.model);
    this.scorer = new Scorer();
    this.teacher = new Teacher(opts.model);
    this.sources = opts.sources;
    this.memory = opts.memory;
  }

  async run(input: MarketResearchInput, context: AgentContext): Promise<AgentResult<MarketResearchOutput>> {
    // Step 1 — build collector sources
    const collectorSources = this.sources.map(s => ({
      connector: s.connector,
      params: s.paramsFor(input.topic),
      optional: s.optional ?? false,
    }));

    // Step 2 — Collector
    const collectorResult = await this.collector.execute({ sources: collectorSources }, context);
    const { evidence, failed } = collectorResult.data;

    // Step 3 — short-circuit if no evidence
    if (evidence.length === 0) {
      return {
        data: {
          summary: {
            topic: input.topic,
            totalScore: 0,
            confidence: 0,
            explanation: 'No evidence could be collected.',
            keyProblems: [],
            productAngles: [],
            warnings: collectorResult.warnings,
          },
          detail: { findings: [], metrics: [], evidence: [], failed },
        },
        confidence: 0,
        evidence: [],
        assumptions: [],
        warnings: collectorResult.warnings,
        traceId: context.traceId,
      };
    }

    // Step 4 — Analyzer
    const analyzerResult = await this.analyzer.execute(
      {
        subjectDescription: input.topic,
        evidence,
        dimensions: MARKET_RESEARCH_DIMENSIONS,
        instructions: [MARKET_RESEARCH_PROMPTS['analyzer-context']],
      },
      context,
    );

    // Step 5 — Scorer
    const scorerResult = await this.scorer.execute(
      {
        findings: analyzerResult.data.findings,
        scorecard: MARKET_RESEARCH_SCORECARD,
        evidenceCount: evidence.length,
      },
      context,
    );

    // Step 6 — Teacher
    const allWarnings = [...collectorResult.warnings, ...scorerResult.data.warnings];
    const teacherResult = await this.teacher.execute(
      {
        subjectDescription: input.topic,
        findings: analyzerResult.data.findings,
        totalScore: scorerResult.data.totalScore,
        confidence: scorerResult.data.confidence,
        warnings: allWarnings,
        audience: 'solo creator building digital products and Shopify apps',
      },
      context,
    );

    // Step 7 — Memory write (opt-in)
    if (this.memory && input.conversationId) {
      const memoryAnswer =
        `${teacherResult.data.explanation}\n\n` +
        `Top problems: ${teacherResult.data.keyLessons.join('; ')}`;
      await this.memory.remember({
        conversationId: input.conversationId,
        question: `Research market: ${input.topic}`,
        answer: memoryAnswer,
      });
    }

    // Step 8 — assemble result
    return {
      data: {
        summary: {
          topic: input.topic,
          totalScore: scorerResult.data.totalScore,
          confidence: scorerResult.data.confidence,
          explanation: teacherResult.data.explanation,
          keyProblems: teacherResult.data.keyLessons,
          productAngles: teacherResult.data.actionableNext,
          warnings: allWarnings,
        },
        detail: {
          findings: analyzerResult.data.findings,
          metrics: scorerResult.data.metrics,
          evidence,
          failed,
        },
      },
      confidence: scorerResult.data.confidence,
      evidence,
      assumptions: analyzerResult.data.findings.flatMap(f => f.unknowns),
      warnings: allWarnings,
      traceId: context.traceId,
    };
  }
}
```

- [ ] **Step 2: Run the tests to verify they pass**

```bash
cd packages/engines/market-research && npm test
```

Expected: PASS — `MarketResearchEngine > topic happy path` and `MarketResearchEngine > memory write` both pass.

- [ ] **Step 3: Commit**

```bash
git add packages/engines/market-research/src/engine.ts
git commit -m "feat: implement MarketResearchEngine with Collector→Analyzer→Scorer→Teacher pipeline"
```

---

### Task 4: Wire into `src/session.ts`, `src/cli/chat.tsx`, and `test/commands.test.ts`

**Files:**
- Modify: `src/session.ts` — add imports, update `ChatSession` type, wire `researchSources`/`researchEngine`, add `formatResearch()`, `formatResearchEval()`, `research()`, `evalResearch()`
- Modify: `src/cli/chat.tsx` — add `/research` handler, split `/eval` into `/eval investing`/`/eval research`/`/eval`
- Modify: `test/commands.test.ts` — add `eval:research scorer accuracy` test + import

**Interfaces:**
- Consumes: `MarketResearchEngine`, `MarketResearchSource`, `MarketResearchOutput` from `@buffr/engine-market-research`; `MARKET_RESEARCH_SCORECARD` from `@buffr/domain-pack-market-research`
- Produces: `ChatSession.research(topic, opts?): Promise<string>` and `ChatSession.evalResearch(): Promise<string>` (used by `chat.tsx` `/research` and `/eval research` handlers)

- [ ] **Step 1: Write the failing test in `test/commands.test.ts`**

Add to the existing imports at the top of `test/commands.test.ts`:

```typescript
import { MARKET_RESEARCH_SCORECARD } from '@buffr/domain-pack-market-research';
```

Add at the end of `test/commands.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run to verify the new test fails**

```bash
npm test
```

Expected: 3 existing tests pass. The new test fails — `Cannot find package '@buffr/domain-pack-market-research'` (because it's not yet imported in session.ts — but the test imports it directly, so it should resolve if Task 1 ran `npm install`). If the package isn't resolved, run `npm install` from the repo root first.

- [ ] **Step 3: Add imports to `src/session.ts`**

After the existing `import { InvestingEngine } from '@buffr/engine-investing';` block (around line 29–30), add:

```typescript
import { MarketResearchEngine } from '@buffr/engine-market-research';
import type { MarketResearchSource, MarketResearchOutput } from '@buffr/engine-market-research';
import { MARKET_RESEARCH_SCORECARD } from '@buffr/domain-pack-market-research';
```

- [ ] **Step 4: Update the `ChatSession` type in `src/session.ts`**

Find (lines 74–79):
```typescript
export type ChatSession = {
  ask(question: string, opts?: AskOptions): Promise<string>;
  analyze(ticker: string, entityType: 'company' | 'etf', opts?: AskOptions): Promise<string>;
  evalInvesting(): Promise<string>;
  close(): Promise<void>;
};
```

Replace with:
```typescript
export type ChatSession = {
  ask(question: string, opts?: AskOptions): Promise<string>;
  analyze(ticker: string, entityType: 'company' | 'etf', opts?: AskOptions): Promise<string>;
  evalInvesting(): Promise<string>;
  research(topic: string, opts?: AskOptions): Promise<string>;
  evalResearch(): Promise<string>;
  close(): Promise<void>;
};
```

- [ ] **Step 5: Add `formatResearch()` and `formatResearchEval()` to `src/session.ts`**

After the `formatAnalysis()` function (around line 171), add:

```typescript
function formatResearch(output: MarketResearchOutput): string {
  const { summary, detail } = output;
  const confidence = Math.round(summary.confidence * 100);
  const lines: string[] = [
    `Topic: ${summary.topic}  ·  Score: ${summary.totalScore.toFixed(1)}/100  ·  Confidence: ${confidence}%`,
    '',
    summary.explanation,
    '',
    'Top problems:',
  ];

  summary.keyProblems.forEach((problem, i) => {
    lines.push(`• ${problem}`);
    const angle = summary.productAngles[i];
    if (angle) lines.push(`  → ${angle}`);
  });

  if (summary.confidence < 0.5) {
    lines.push('', '⚠ Low confidence — limited evidence collected.');
  }
  for (const warning of summary.warnings) {
    lines.push(`⚠ ${warning}`);
  }

  const sourceTypes = [...new Set(detail.evidence.map(e => e.sourceType))];
  lines.push('');
  lines.push(`Sources: ${detail.evidence.length} signals collected (${sourceTypes.join(' · ')})`);

  return lines.join('\n');
}

type ResearchEvalFixture = {
  description: string;
  findings: Parameters<Scorer['execute']>[0]['findings'];
  evidenceCount: number;
  expectedTotalScore: number;
};

async function formatResearchEval(
  scorer: Scorer,
  evalCtx: AgentContext,
  fixtures: ResearchEvalFixture[],
): Promise<string> {
  let passed = 0;
  const lines: string[] = [`Market research eval — ${fixtures.length} fixtures`, ''];

  for (const fixture of fixtures) {
    const result = await scorer.execute(
      { findings: fixture.findings, scorecard: MARKET_RESEARCH_SCORECARD, evidenceCount: fixture.evidenceCount },
      evalCtx,
    );
    const actual = result.data.totalScore;
    const expected = fixture.expectedTotalScore;
    const delta = Math.abs(actual - expected);
    const ok = delta <= 0.01;
    if (ok) passed++;
    const mark = ok ? '✔' : '✘';
    const desc = fixture.description.slice(0, 42).padEnd(42);
    lines.push(`  ${mark}  ${desc}  expected ${expected.toFixed(2)}  got ${actual.toFixed(2)}  Δ ${delta.toFixed(2)}`);
  }

  lines.push('');
  lines.push(`${passed}/${fixtures.length} passed`);
  return lines.join('\n');
}
```

- [ ] **Step 6: Wire `researchSources` and `researchEngine` inside `createChatSession()`**

After the `investingEngine` declaration (around line 261–263):
```typescript
  const investingEngine = investingSources.length > 0
    ? new InvestingEngine({ model, sources: investingSources, memory })
    : null;
```

Add immediately after:
```typescript
  const researchSources: MarketResearchSource[] = [
    {
      connector: new CachedConnector(new GoogleTrendsConnector(), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS),
      paramsFor: (topic: string) => ({ keywords: [topic], timeframe: 'now 7-d' }),
      optional: true,
    },
    ...(cfg.braveApiKey ? [{
      connector: new CachedConnector(
        new BraveSearchConnector(cfg.braveApiKey),
        new InMemoryCache(),
        CONNECTOR_CACHE_TTL_MS,
      ),
      paramsFor: (topic: string) => ({
        query: `${topic} problems complaints frustrations reddit forum`,
        count: 5,
      }),
      optional: true,
    } satisfies MarketResearchSource] : []),
    ...(cfg.tavilyApiKey ? [{
      connector: new CachedConnector(
        new TavilySearchConnector(cfg.tavilyApiKey),
        new InMemoryCache(),
        CONNECTOR_CACHE_TTL_MS,
      ),
      paramsFor: (topic: string) => ({
        query: `${topic} issues pain points problems complaints`,
        maxResults: 5,
      }),
      optional: true,
    } satisfies MarketResearchSource] : []),
  ];
  const researchEngine = new MarketResearchEngine({ model, sources: researchSources, memory });
```

- [ ] **Step 7: Add `research()` and `evalResearch()` methods to the return object in `createChatSession()`**

In the `return { ... }` block at the bottom of `createChatSession()`, after `evalInvesting()` and before `analyze()`, add:

```typescript
    async research(topic: string, opts?: AskOptions): Promise<string> {
      currentOnStatus = opts?.onStatus;
      currentOnTokens = opts?.onTokens;
      currentInputTokens = 0;
      currentOutputTokens = 0;
      opts?.onStatus?.('researching…');
      const startMs = Date.now();
      const agentCtx: AgentContext = {
        userId: cfg.appId,
        workspaceId: cfg.appId,
        traceId: `research-${topic}-${Date.now()}`,
        domain: 'market-research',
        now: new Date().toISOString(),
        permissions: [],
      };
      const result = await researchEngine.run({ topic, conversationId }, agentCtx);
      currentOnStatus = undefined;
      currentOnTokens = undefined;
      opts?.onComplete?.({
        durationMs: Date.now() - startMs,
        inputTokens: currentInputTokens,
        outputTokens: currentOutputTokens,
      });
      return formatResearch(result.data);
    },
    async evalResearch(): Promise<string> {
      const scorer = new Scorer();
      const evalCtx: AgentContext = {
        userId: cfg.appId, workspaceId: cfg.appId, traceId: 'eval-research',
        domain: 'market-research', now: new Date().toISOString(), permissions: [],
      };
      const fixtures: ResearchEvalFixture[] = JSON.parse(
        await readFile(
          new URL('../../packages/domain-packs/market-research/eval/fixtures.json', import.meta.url),
          'utf8',
        ),
      );
      return formatResearchEval(scorer, evalCtx, fixtures);
    },
```

- [ ] **Step 8: Update `/eval` handler and add `/research` + `/eval research` in `src/cli/chat.tsx`**

Find the existing `/eval` handler in `handleSubmit` (around line 84–94):
```typescript
    if (q === '/eval') {
      setTurns(t => [...t, { role: 'you', text: q }]);
      setBusy(true);
      setStatus('running eval…');
      setLiveTokens({ input: 0, output: 0 });
      session.evalInvesting().then(
        answer => { setTurns(t => [...t, { role: 'buffr', text: answer }]); setBusy(false); },
        err    => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]); setBusy(false); },
      );
      return;
    }
```

Replace with these four handlers (keep in this order — most specific `/eval investing` and `/eval research` before bare `/eval`):

```typescript
    if (q.startsWith('/research ')) {
      const topic = q.slice('/research '.length).trim();
      if (!topic) return;
      setTurns(t => [...t, { role: 'you', text: q }]);
      setBusy(true); setStatus('researching…'); setLiveTokens({ input: 0, output: 0 });
      let capturedStats: TurnStats | undefined;
      session.research(topic, {
        onStatus: (msg) => setStatus(msg),
        onTokens: (d) => setLiveTokens(t => ({ input: t.input + d.input, output: t.output + d.output })),
        onComplete: (s) => { capturedStats = s; },
      }).then(
        answer => { setTurns(t => [...t, { role: 'buffr', text: answer, stats: capturedStats }]); setBusy(false); },
        err    => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}`, stats: capturedStats }]); setBusy(false); },
      );
      return;
    }
    if (q === '/eval investing') {
      setTurns(t => [...t, { role: 'you', text: q }]);
      setBusy(true); setStatus('running eval…'); setLiveTokens({ input: 0, output: 0 });
      session.evalInvesting().then(
        answer => { setTurns(t => [...t, { role: 'buffr', text: answer }]); setBusy(false); },
        err    => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]); setBusy(false); },
      );
      return;
    }
    if (q === '/eval research') {
      setTurns(t => [...t, { role: 'you', text: q }]);
      setBusy(true); setStatus('running eval…'); setLiveTokens({ input: 0, output: 0 });
      session.evalResearch().then(
        answer => { setTurns(t => [...t, { role: 'buffr', text: answer }]); setBusy(false); },
        err    => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]); setBusy(false); },
      );
      return;
    }
    if (q === '/eval') {
      setTurns(t => [...t, { role: 'you', text: q }]);
      setTurns(t => [...t, { role: 'buffr', text: 'Usage: /eval investing | /eval research' }]);
      return;
    }
```

- [ ] **Step 9: Build and run all tests**

```bash
npm run build && npm test
```

Expected output:
```
▶ detectEntityType
  ✔ returns etf for known ETF tickers
  ✔ returns company for non-ETF tickers
▶ eval:investing scorer accuracy
  ✔ company fixtures score within ±0.01 of expected
  ✔ ETF fixtures score within ±0.01 of expected
▶ eval:research scorer accuracy
  ✔ market research fixtures score within ±0.01 of expected
```

All 5 tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/session.ts src/cli/chat.tsx test/commands.test.ts
git commit -m "feat: add /research and /eval research commands, wire MarketResearchEngine into session"
```
