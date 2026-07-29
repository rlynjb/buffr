# Engine Investing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@buffr/engine-investing` — a new monorepo package that wires Collector → Analyzer → Scorer → Teacher → Memory/Journal into a single `InvestingEngine.run()` call.

**Architecture:** `InvestingEngine` implements the `Engine<InvestingInput, InvestingOutput>` interface from `@buffr/contracts`. It accepts a `ModelProvider`, a list of `InvestingSource` objects (connector + param-builder), and an optional `ConversationMemory`. The constructor wires capability instances; `run()` executes the linear pipeline and optionally persists to memory and/or journal.

**Tech Stack:** TypeScript ESM, `node:test`, `@buffr/contracts`, `@buffr/kernel`, `@buffr/capabilities`, `@buffr/connectors`, `@buffr/domain-pack-investing`

## Global Constraints

- TypeScript ESM: all local imports must use `.js` extension (e.g. `'./types.js'`).
- `tsconfig.json` extends `"../../../tsconfig.base.json"` (three levels up from `packages/engines/investing/`).
- No new prod dependencies beyond: `@buffr/contracts`, `@buffr/kernel`, `@buffr/capabilities`, `@buffr/connectors`, `@buffr/domain-pack-investing`.
- Root `package.json` workspace array must include `"packages/engines/*"`.
- The engine must NOT modify any file in `packages/contracts/`, `packages/kernel/`, `packages/capabilities/`, `packages/connectors/`, or `packages/domain-packs/`.
- `run()` must short-circuit with `confidence: 0` and skip all model calls when `evidence.length === 0` after Collector.
- Journal write only when `input.decision` is provided; memory write only when `this.memory` exists AND `input.conversationId` is provided.
- All files in `packages/engines/investing/` only.

---

### Task 1: Package scaffold + workspace registration + types + stub engine + failing tests

**Files:**
- Modify: `package.json` (root, workspaces array and build:packages script)
- Create: `packages/engines/investing/package.json`
- Create: `packages/engines/investing/tsconfig.json`
- Create: `packages/engines/investing/src/types.ts`
- Create: `packages/engines/investing/src/engine.ts` (stub — throws "Not implemented")
- Create: `packages/engines/investing/src/index.ts`
- Create: `packages/engines/investing/test/engine.test.ts`

**Interfaces:**
- Produces: `InvestingEngine`, `InvestingInput`, `InvestingOutput`, `InvestingSource`, `InvestingEngineOptions` exported from `@buffr/engine-investing`

---

- [ ] **Step 1: Create directory tree**

```bash
mkdir -p packages/engines/investing/src packages/engines/investing/test
```

---

- [ ] **Step 2: Write `packages/engines/investing/package.json`**

```json
{
  "name": "@buffr/engine-investing",
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
    "@buffr/domain-pack-investing": "0.0.1"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  }
}
```

---

- [ ] **Step 3: Write `packages/engines/investing/tsconfig.json`**

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

---

- [ ] **Step 4: Update root `package.json` — workspaces and build:packages**

Open `package.json` at the repo root. Make two edits:

**4a. Workspaces array** — change from:
```json
"workspaces": ["packages/*", "packages/domain-packs/*"]
```
to:
```json
"workspaces": ["packages/*", "packages/domain-packs/*", "packages/engines/*"]
```

**4b. build:packages script** — append `&& npm run build -w @buffr/engine-investing` to the end of the existing `build:packages` value. The full new value:
```
"build:packages": "npm run build -w @buffr/contracts && npm run build -w @buffr/kernel && npm run build -w @buffr/connectors && npm run build -w @buffr/capabilities && npm run build -w @buffr/domain-pack-investing && npm run build -w @buffr/engine-investing"
```

---

- [ ] **Step 5: Register the new workspace**

Run from the repo root:

```bash
npm install
```

Expected: npm resolves workspaces and creates `node_modules/@buffr/engine-investing` symlink. No errors about missing packages.

---

- [ ] **Step 6: Write `packages/engines/investing/src/types.ts`**

```typescript
import type { DataConnector } from '@buffr/connectors';
import type { ModelProvider, ConversationMemory } from '@buffr/kernel';
import type { AnalysisFinding } from '@buffr/capabilities';
import type { ScoredMetric } from '@buffr/capabilities';
import type { Evidence } from '@buffr/contracts';

export type InvestingSource = {
  connector: DataConnector<unknown, unknown>;
  paramsFor: (ticker: string, entityType: 'company' | 'etf') => unknown;
  optional?: boolean;
};

export type InvestingEngineOptions = {
  model: ModelProvider;
  sources: InvestingSource[];
  memory?: ConversationMemory;
};

export type InvestingInput = {
  ticker: string;
  entityType: 'company' | 'etf';
  conversationId?: string;
  decision?: string;
  thesis?: string;
  timeHorizon?: string;
};

export type InvestingOutput = {
  summary: {
    ticker: string;
    entityType: 'company' | 'etf';
    totalScore: number;
    confidence: number;
    explanation: string;
    keyLessons: string[];
    actionableNext: string[];
    warnings: string[];
  };
  detail: {
    findings: AnalysisFinding[];
    metrics: ScoredMetric[];
    evidence: Evidence[];
    failed: Array<{ sourceId: string; reason: string }>;
    journalEntryId?: string;
  };
};
```

---

- [ ] **Step 7: Write `packages/engines/investing/src/engine.ts` (stub)**

```typescript
import type { Engine, AgentContext, AgentResult } from '@buffr/contracts';
import type { InvestingInput, InvestingOutput, InvestingEngineOptions } from './types.js';

export class InvestingEngine implements Engine<InvestingInput, InvestingOutput> {
  readonly id = 'investing-engine';
  readonly version = '1.0.0';

  constructor(_opts: InvestingEngineOptions) {}

  async run(_input: InvestingInput, _context: AgentContext): Promise<AgentResult<InvestingOutput>> {
    throw new Error('Not implemented');
  }
}
```

---

- [ ] **Step 8: Write `packages/engines/investing/src/index.ts`**

```typescript
export * from './types.js';
export * from './engine.js';
```

---

- [ ] **Step 9: Write `packages/engines/investing/test/engine.test.ts`**

```typescript
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
```

---

- [ ] **Step 10: Build upstream dependencies (if not already built)**

From the repo root:

```bash
npm run build -w @buffr/contracts && npm run build -w @buffr/kernel && npm run build -w @buffr/connectors && npm run build -w @buffr/capabilities && npm run build -w @buffr/domain-pack-investing
```

Expected: each package compiles without errors. The `dist/` folders for all five packages must exist before the engine can compile.

---

- [ ] **Step 11: Build engine and verify tests fail with "Not implemented"**

```bash
npm run test -w @buffr/engine-investing
```

Expected: TypeScript compiles cleanly, then 3 test failures:

```
✖ company happy path: score > 0, explanation set, 5 findings, no journalEntryId
    Error: Not implemented
✖ ETF with journal: 5 findings, journalEntryId is a UUID
    Error: Not implemented
✖ memory write: remember() called once with correct conversationId and explanation in answer
    Error: Not implemented
```

If you see TypeScript errors, fix them before proceeding. If you see different test errors, re-read the stub engine in Step 7.

---

- [ ] **Step 12: Commit**

```bash
git add packages/engines/investing/ package.json package-lock.json
git commit -m "feat: scaffold @buffr/engine-investing with types, stub, and failing tests"
```

---

### Task 2: InvestingEngine implementation

**Files:**
- Modify: `packages/engines/investing/src/engine.ts` — full `run()` pipeline

**Interfaces:**
- Consumes (from Task 1):
  - `InvestingSource`, `InvestingEngineOptions`, `InvestingInput`, `InvestingOutput` from `./types.js`
  - `COMPANY_DIMENSIONS`, `ETF_DIMENSIONS`, `COMPANY_SCORECARD`, `ETF_SCORECARD`, `INVESTING_PROMPTS` from `@buffr/domain-pack-investing`
  - `Collector`, `Analyzer`, `Scorer`, `Teacher`, `Journal` from `@buffr/capabilities`
  - `ConversationMemory`, `MemoryTurn` from `@buffr/kernel`
  - `Engine`, `AgentContext`, `AgentResult` from `@buffr/contracts`

---

- [ ] **Step 1: Replace `packages/engines/investing/src/engine.ts` with the full implementation**

```typescript
import { Collector, Analyzer, Scorer, Teacher, Journal } from '@buffr/capabilities';
import {
  COMPANY_DIMENSIONS,
  ETF_DIMENSIONS,
  COMPANY_SCORECARD,
  ETF_SCORECARD,
  INVESTING_PROMPTS,
} from '@buffr/domain-pack-investing';
import type { Engine, AgentContext, AgentResult } from '@buffr/contracts';
import type { ConversationMemory, MemoryTurn } from '@buffr/kernel';
import type { InvestingInput, InvestingOutput, InvestingEngineOptions, InvestingSource } from './types.js';

export class InvestingEngine implements Engine<InvestingInput, InvestingOutput> {
  readonly id = 'investing-engine';
  readonly version = '1.0.0';

  private readonly collector: Collector;
  private readonly analyzer: Analyzer;
  private readonly scorer: Scorer;
  private readonly teacher: Teacher;
  private readonly journal: Journal;
  private readonly sources: InvestingSource[];
  private readonly memory?: ConversationMemory;

  constructor(opts: InvestingEngineOptions) {
    this.collector = new Collector();
    this.analyzer = new Analyzer(opts.model);
    this.scorer = new Scorer();
    this.teacher = new Teacher(opts.model);
    this.journal = new Journal();
    this.sources = opts.sources;
    this.memory = opts.memory;
  }

  async run(input: InvestingInput, context: AgentContext): Promise<AgentResult<InvestingOutput>> {
    const dimensions = input.entityType === 'company' ? COMPANY_DIMENSIONS : ETF_DIMENSIONS;
    const scorecard  = input.entityType === 'company' ? COMPANY_SCORECARD  : ETF_SCORECARD;

    const collectorSources = this.sources.map(s => ({
      connector: s.connector,
      params: s.paramsFor(input.ticker, input.entityType),
      optional: s.optional ?? false,
    }));

    const collectorResult = await this.collector.execute({ sources: collectorSources }, context);
    const { evidence, failed } = collectorResult.data;

    if (evidence.length === 0) {
      return {
        data: {
          summary: {
            ticker: input.ticker,
            entityType: input.entityType,
            totalScore: 0,
            confidence: 0,
            explanation: 'No evidence could be collected.',
            keyLessons: [],
            actionableNext: [],
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

    const subjectDescription = `${input.ticker} (${input.entityType})`;

    const analyzerResult = await this.analyzer.execute(
      {
        subjectDescription,
        evidence,
        dimensions,
        instructions: [INVESTING_PROMPTS['analyzer-context']],
      },
      context,
    );

    const scorerResult = await this.scorer.execute(
      { findings: analyzerResult.data.findings, scorecard, evidenceCount: evidence.length },
      context,
    );

    const allWarnings = [...collectorResult.warnings, ...scorerResult.data.warnings];

    const teacherResult = await this.teacher.execute(
      {
        subjectDescription,
        findings: analyzerResult.data.findings,
        totalScore: scorerResult.data.totalScore,
        confidence: scorerResult.data.confidence,
        warnings: allWarnings,
        audience: 'individual investor',
      },
      context,
    );

    if (this.memory && input.conversationId) {
      const memoryAnswer =
        `${teacherResult.data.explanation}\n\n` +
        `Score: ${scorerResult.data.totalScore.toFixed(1)}/100. ` +
        `Key lessons: ${teacherResult.data.keyLessons.join('; ')}`;
      const turn: MemoryTurn = {
        conversationId: input.conversationId,
        question: `Analyze ${input.ticker}`,
        answer: memoryAnswer,
      };
      await this.memory.remember(turn);
    }

    let journalEntryId: string | undefined;
    if (input.decision) {
      const journalResult = await this.journal.execute(
        {
          subject: { type: input.entityType, id: input.ticker, description: subjectDescription },
          domain: 'investing',
          decision: input.decision,
          thesis: input.thesis ?? '',
          expectedOutcome: `Score ≥ ${scorerResult.data.totalScore.toFixed(1)}`,
          timeHorizon: input.timeHorizon,
          confidence: scorerResult.data.confidence,
          assumptions: analyzerResult.data.findings.flatMap(f => f.unknowns),
          risks: analyzerResult.data.findings.flatMap(f => f.negatives),
          evidenceIds: evidence.map(e => e.sourceId),
        },
        context,
      );
      journalEntryId = journalResult.data.entry.id;
    }

    return {
      data: {
        summary: {
          ticker: input.ticker,
          entityType: input.entityType,
          totalScore: scorerResult.data.totalScore,
          confidence: scorerResult.data.confidence,
          explanation: teacherResult.data.explanation,
          keyLessons: teacherResult.data.keyLessons,
          actionableNext: teacherResult.data.actionableNext,
          warnings: allWarnings,
        },
        detail: {
          findings: analyzerResult.data.findings,
          metrics: scorerResult.data.metrics,
          evidence,
          failed,
          journalEntryId,
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

---

- [ ] **Step 2: Run tests — expect 3 passes**

```bash
npm run test -w @buffr/engine-investing
```

Expected output:

```
▶ InvestingEngine
  ✔ company happy path: score > 0, explanation set, 5 findings, no journalEntryId
  ✔ ETF with journal: 5 findings, journalEntryId is a UUID
  ✔ memory write: remember() called once with correct conversationId and explanation in answer
▶ InvestingEngine (Xms)

3 tests passed
```

If a test fails, read the error message and trace it back to the corresponding pipeline step in the engine. The most common causes:
- `totalScore === 0`: Scorer couldn't match findings to scorecard metrics — check that `COMPANY_FINDINGS` dimensionIds match the `COMPANY_SCORECARD` metric ids exactly (`business-quality`, `financial-strength`, `growth-durability`, `valuation`, `risk`).
- `explanation !== 'Test explanation.'`: StubModel's `submit_explanation` branch wasn't reached — add `console.log` to verify `req.tools?.[0]?.name` in the Teacher call.
- `journalEntryId undefined`: the `if (input.decision)` branch in `run()` was skipped — verify `input.decision` is `'buy'` in Test 2.
- `rememberCalled !== 1`: the `if (this.memory && input.conversationId)` branch was skipped — verify the engine was constructed with `memory: stubMemory` and the input has `conversationId: 'conv-1'`.

---

- [ ] **Step 3: Commit**

```bash
git add packages/engines/investing/src/engine.ts
git commit -m "feat: implement InvestingEngine run() pipeline"
```
