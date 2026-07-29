# Shared Capabilities v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build five reusable reasoning capabilities (Collector, Analyzer, Scorer, Teacher, Journal) in a new `@buffr/capabilities` package, each implementing `Capability<TInput, TOutput>` from `@buffr/contracts`.

**Architecture:** One new workspace package `packages/capabilities/` depends on `@buffr/contracts`, `@buffr/kernel`, and `@buffr/connectors`. Analyzer and Teacher call `runAgentLoop` from kernel with a single structured-output tool; Collector, Scorer, and Journal are model-free. Engines (Phase 4) assemble the pipeline; capabilities never call each other.

**Tech Stack:** TypeScript ESM (NodeNext), `node:test` + `node:assert/strict`, `runAgentLoop` from `@buffr/kernel`, `DataConnector` / `ConnectorResult` from `@buffr/connectors`, `Capability` / `AgentContext` / `AgentResult` from `@buffr/contracts`.

## Global Constraints

- TypeScript ESM; all intra-package imports must use `.js` extension (e.g. `'../analyzer/index.js'`).
- No new prod dependencies beyond `@buffr/contracts`, `@buffr/kernel`, `@buffr/connectors`.
- Tests run with `node:test` + `node:assert/strict` matching existing kernel/connectors pattern.
- Build: `tsc -p tsconfig.json`. Test: `npm run build && node --test --test-concurrency=1 dist/test/*.test.js`.
- Analyzer and Teacher inject `ModelProvider`; no hardcoded Gemma inside capabilities.
- `AgentResult.latencyMs` is measured for model-using capabilities (Analyzer, Teacher); synchronous capabilities (Collector, Scorer, Journal) omit it.
- `performance.now()` is a Node.js 20+ global — no import needed.
- `crypto.randomUUID()` is a Node.js 20+ global — no import needed.

---

## File Map

**New package:**
- `packages/capabilities/package.json` — package manifest
- `packages/capabilities/tsconfig.json` — TypeScript config (mirrors kernel/connectors)
- `packages/capabilities/src/collector/index.ts` — Collector class + types
- `packages/capabilities/src/analyzer/index.ts` — Analyzer class + AnalysisFinding type
- `packages/capabilities/src/scorer/index.ts` — Scorer class + scorecard types
- `packages/capabilities/src/teacher/index.ts` — Teacher class + types
- `packages/capabilities/src/journal/index.ts` — Journal class + JournalInput/Output types
- `packages/capabilities/src/index.ts` — barrel re-export
- `packages/capabilities/test/collector.test.ts` — Collector tests
- `packages/capabilities/test/analyzer.test.ts` — Analyzer tests
- `packages/capabilities/test/scorer.test.ts` — Scorer tests
- `packages/capabilities/test/teacher.test.ts` — Teacher tests
- `packages/capabilities/test/journal.test.ts` — Journal tests

**Modified:**
- `packages/contracts/src/index.ts` — add `workspaceId: string` to `DecisionJournalEntry`
- `package.json` (root) — add `@buffr/capabilities` to dependencies and `build:packages` script

---

### Task 1: Scaffold @buffr/capabilities + update contracts

**Files:**
- Create: `packages/capabilities/package.json`
- Create: `packages/capabilities/tsconfig.json`
- Modify: `packages/contracts/src/index.ts`
- Modify: `package.json` (root)

**Interfaces:**
- Produces: `@buffr/capabilities` workspace importable by root; `DecisionJournalEntry.workspaceId` available in contracts.

- [ ] **Step 1: Update DecisionJournalEntry in contracts**

Open `packages/contracts/src/index.ts`. Find the `DecisionJournalEntry` interface. Add `workspaceId: string` after `userId: string`:

```typescript
export interface DecisionJournalEntry {
  id: string;
  userId: string;
  workspaceId: string;   // ← add this line
  domain: string;
  subjectType: string;
  subjectId: string;
  createdAt: string;
  decision: string;
  thesis: string;
  expectedOutcome: string;
  timeHorizon?: string;
  confidence: number;
  assumptions: string[];
  risks: string[];
  evidenceIds: string[];
  emotionalState?: string;
  status: 'open' | 'review-due' | 'reviewed';
  reviewAt?: string;
}
```

- [ ] **Step 2: Rebuild contracts and verify no breakage**

```bash
npm run build -w @buffr/contracts
```

Expected: zero errors. (Nothing in kernel/connectors/root uses `DecisionJournalEntry` yet, so no downstream breakage.)

- [ ] **Step 3: Create package.json for @buffr/capabilities**

Create `packages/capabilities/package.json`:

```json
{
  "name": "@buffr/capabilities",
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
    "@buffr/connectors": "0.0.1"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 4: Create tsconfig.json for @buffr/capabilities**

Create `packages/capabilities/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 5: Create placeholder barrel (required for tsc composite)**

Create `packages/capabilities/src/index.ts` with just a comment for now:

```typescript
// packages/capabilities/src/index.ts — re-exports added per capability task
export {};
```

- [ ] **Step 6: Update root package.json**

In `package.json` (root), make two changes:

1. In `"scripts"`, update `"build:packages"` to include capabilities at the end:
```json
"build:packages": "npm run build -w @buffr/contracts && npm run build -w @buffr/kernel && npm run build -w @buffr/connectors && npm run build -w @buffr/capabilities"
```

2. In `"dependencies"`, add:
```json
"@buffr/capabilities": "0.0.1"
```

- [ ] **Step 7: Verify scaffold builds**

```bash
npm run build -w @buffr/capabilities
```

Expected: zero errors, `packages/capabilities/dist/src/index.js` created.

- [ ] **Step 8: Commit**

```bash
git add packages/capabilities/package.json packages/capabilities/tsconfig.json packages/capabilities/src/index.ts packages/contracts/src/index.ts package.json
git commit -m "feat: scaffold @buffr/capabilities package + add workspaceId to DecisionJournalEntry"
```

---

### Task 2: Collector capability

**Files:**
- Create: `packages/capabilities/src/collector/index.ts`
- Create: `packages/capabilities/test/collector.test.ts`

**Interfaces:**
- Consumes: `DataConnector<P, unknown>`, `ConnectorResult<unknown>` from `@buffr/connectors`; `Evidence`, `AgentContext`, `AgentResult`, `Capability` from `@buffr/contracts`
- Produces:
  ```typescript
  export type CollectorSource<P> = {
    connector: DataConnector<P, unknown>;
    params: P;
    optional?: boolean;  // default false
  };
  export type CollectorInput = { sources: CollectorSource<unknown>[] };
  export type CollectorOutput = {
    evidence: Evidence[];
    failed: Array<{ sourceId: string; reason: string }>;
  };
  export class Collector implements Capability<CollectorInput, CollectorOutput>
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/capabilities/test/collector.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Collector } from '../src/collector/index.js';
import type { AgentContext, Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult } from '@buffr/connectors';

const ctx: AgentContext = {
  userId: 'u1',
  workspaceId: 'w1',
  traceId: 't1',
  domain: 'test',
  now: '2026-07-29T00:00:00.000Z',
  permissions: [],
};

function makeConnector(id: string, evidenceItems: Evidence[]): DataConnector<Record<string, never>, unknown> {
  return {
    id,
    async fetch(_params, _opts): Promise<ConnectorResult<unknown>> {
      return {
        data: {},
        fetchedAt: ctx.now,
        sourceId: id,
        toEvidence() { return evidenceItems; },
      };
    },
  };
}

function makeFailingConnector(id: string): DataConnector<Record<string, never>, unknown> {
  return {
    id,
    async fetch(_params, _opts): Promise<ConnectorResult<unknown>> {
      throw new Error(`network error from ${id}`);
    },
  };
}

const sampleEvidence: Evidence = {
  sourceId: 'src-a',
  sourceType: 'test',
  retrievedAt: ctx.now,
};

describe('Collector', () => {
  it('collects evidence from all successful sources', async () => {
    const collector = new Collector();
    const result = await collector.execute(
      {
        sources: [
          { connector: makeConnector('src-a', [sampleEvidence]), params: {} },
          { connector: makeConnector('src-b', [{ ...sampleEvidence, sourceId: 'src-b' }]), params: {} },
        ],
      },
      ctx,
    );
    assert.strictEqual(result.data.evidence.length, 2);
    assert.strictEqual(result.data.failed.length, 0);
  });

  it('records a failed source in failed[]', async () => {
    const collector = new Collector();
    const result = await collector.execute(
      {
        sources: [
          { connector: makeConnector('src-a', [sampleEvidence]), params: {} },
          { connector: makeFailingConnector('src-fail'), params: {} },
        ],
      },
      ctx,
    );
    assert.strictEqual(result.data.evidence.length, 1);
    assert.strictEqual(result.data.failed.length, 1);
    assert.strictEqual(result.data.failed[0].sourceId, 'src-fail');
    assert.ok(result.data.failed[0].reason.includes('network error'));
  });

  it('adds a warning for non-optional source failure', async () => {
    const collector = new Collector();
    const result = await collector.execute(
      { sources: [{ connector: makeFailingConnector('required-src'), params: {}, optional: false }] },
      ctx,
    );
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('required-src'));
  });

  it('does NOT add a warning for optional source failure', async () => {
    const collector = new Collector();
    const result = await collector.execute(
      { sources: [{ connector: makeFailingConnector('optional-src'), params: {}, optional: true }] },
      ctx,
    );
    assert.strictEqual(result.warnings.length, 0);
    assert.strictEqual(result.data.failed.length, 1);
  });

  it('sets confidence to 1 and traceId from context', async () => {
    const collector = new Collector();
    const result = await collector.execute(
      { sources: [{ connector: makeConnector('src-a', [sampleEvidence]), params: {} }] },
      ctx,
    );
    assert.strictEqual(result.confidence, 1);
    assert.strictEqual(result.traceId, ctx.traceId);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -w @buffr/capabilities
```

Expected: FAIL — `Cannot find module '../src/collector/index.js'`

- [ ] **Step 3: Implement Collector**

Create `packages/capabilities/src/collector/index.ts`:

```typescript
import type { DataConnector } from '@buffr/connectors';
import type { Evidence, AgentContext, AgentResult, Capability } from '@buffr/contracts';

export type CollectorSource<P> = {
  connector: DataConnector<P, unknown>;
  params: P;
  optional?: boolean;
};

export type CollectorInput = {
  sources: CollectorSource<unknown>[];
};

export type CollectorOutput = {
  evidence: Evidence[];
  failed: Array<{ sourceId: string; reason: string }>;
};

export class Collector implements Capability<CollectorInput, CollectorOutput> {
  readonly name = 'collector';
  readonly version = '1.0.0';

  async execute(input: CollectorInput, context: AgentContext): Promise<AgentResult<CollectorOutput>> {
    const results = await Promise.allSettled(
      input.sources.map(source => source.connector.fetch(source.params)),
    );

    const evidence: Evidence[] = [];
    const failed: Array<{ sourceId: string; reason: string }> = [];
    const warnings: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const settled = results[i];
      const source = input.sources[i];
      if (settled.status === 'fulfilled') {
        evidence.push(...settled.value.toEvidence());
      } else {
        const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        failed.push({ sourceId: source.connector.id, reason });
        if (!(source.optional ?? false)) {
          warnings.push(`Required source '${source.connector.id}' failed: ${reason}`);
        }
      }
    }

    return {
      data: { evidence, failed },
      confidence: 1,
      evidence,
      assumptions: [],
      warnings,
      traceId: context.traceId,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -w @buffr/capabilities
```

Expected: 5 passing tests under `Collector`.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/collector/index.ts packages/capabilities/test/collector.test.ts
git commit -m "feat(capabilities): Collector capability"
```

---

### Task 3: Analyzer capability

**Files:**
- Create: `packages/capabilities/src/analyzer/index.ts`
- Create: `packages/capabilities/test/analyzer.test.ts`

**Interfaces:**
- Consumes: `runAgentLoop`, `ToolExecutor`, `ModelTool` from `@buffr/kernel`; `ModelProvider`, `ModelRequest`, `ModelResponse` from `@buffr/kernel`; `Evidence`, `AgentContext`, `AgentResult`, `Capability` from `@buffr/contracts`
- Produces:
  ```typescript
  export type AnalysisFinding = {
    dimensionId: string; summary: string;
    positives: string[]; negatives: string[]; unknowns: string[];
    score: number;        // 0–100, model-assigned
    confidence: number;   // 0–1, model-assigned
    evidenceIds: string[];
  };
  export type AnalysisDimension = { id: string; label: string; description: string; weight?: number; };
  export type AnalyzerInput = { subjectDescription: string; evidence: Evidence[]; dimensions: AnalysisDimension[]; instructions?: string[]; };
  export type AnalyzerOutput = { findings: AnalysisFinding[]; };
  export class Analyzer implements Capability<AnalyzerInput, AnalyzerOutput>
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/capabilities/test/analyzer.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -w @buffr/capabilities
```

Expected: FAIL — `Cannot find module '../src/analyzer/index.js'`

- [ ] **Step 3: Implement Analyzer**

Create `packages/capabilities/src/analyzer/index.ts`:

```typescript
import { runAgentLoop } from '@buffr/kernel';
import type { ToolExecutor, ModelTool, ModelProvider } from '@buffr/kernel';
import type { Evidence, AgentContext, AgentResult, Capability } from '@buffr/contracts';

export type AnalysisDimension = {
  id: string;
  label: string;
  description: string;
  weight?: number;
};

export type AnalysisFinding = {
  dimensionId: string;
  summary: string;
  positives: string[];
  negatives: string[];
  unknowns: string[];
  score: number;
  confidence: number;
  evidenceIds: string[];
};

export type AnalyzerInput = {
  subjectDescription: string;
  evidence: Evidence[];
  dimensions: AnalysisDimension[];
  instructions?: string[];
};

export type AnalyzerOutput = {
  findings: AnalysisFinding[];
};

const SUBMIT_ANALYSIS_TOOL: ModelTool = {
  name: 'submit_analysis',
  description: 'Submit the analysis findings for all dimensions.',
  inputSchema: {
    type: 'object',
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['dimensionId', 'summary', 'positives', 'negatives', 'unknowns', 'score', 'confidence', 'evidenceIds'],
          properties: {
            dimensionId: { type: 'string' },
            summary: { type: 'string' },
            positives: { type: 'array', items: { type: 'string' } },
            negatives: { type: 'array', items: { type: 'string' } },
            unknowns: { type: 'array', items: { type: 'string' } },
            score: { type: 'number', minimum: 0, maximum: 100 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            evidenceIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

const EVIDENCE_EXCERPT_CHARS = 500;

export class Analyzer implements Capability<AnalyzerInput, AnalyzerOutput> {
  readonly name = 'analyzer';
  readonly version = '1.0.0';

  constructor(private readonly model: ModelProvider) {}

  async execute(input: AnalyzerInput, context: AgentContext): Promise<AgentResult<AnalyzerOutput>> {
    const start = performance.now();

    const evidenceSummary = input.evidence
      .map(e => `[${e.sourceId}] ${e.title ?? ''}${e.excerpt ? ': ' + e.excerpt.slice(0, EVIDENCE_EXCERPT_CHARS) : ''}`)
      .join('\n\n');

    const dimensionsList = input.dimensions
      .map(d => `- ${d.id} (${d.label}): ${d.description}`)
      .join('\n');

    const extraInstructions = input.instructions?.length
      ? `\nAdditional instructions:\n${input.instructions.map(i => `- ${i}`).join('\n')}`
      : '';

    const system = `You are an expert analyst. Analyze the subject across the specified dimensions and call submit_analysis exactly once with findings for every dimension.${extraInstructions}`;

    const userPrompt = `Subject: ${input.subjectDescription}

Evidence:
${evidenceSummary || '(no evidence provided)'}

Dimensions to analyze:
${dimensionsList}

For each dimension produce a finding with:
- dimensionId: the dimension id exactly as listed above
- summary: concise one-sentence assessment
- positives: list of supporting evidence points
- negatives: list of concerns or weaknesses
- unknowns: what could not be determined from the evidence
- score: integer 0–100 (0 = very poor, 100 = excellent)
- confidence: float 0–1 (your confidence in this assessment given the evidence)
- evidenceIds: source IDs that support this finding

Call submit_analysis with all ${input.dimensions.length} findings now.`;

    const captured: { args: Record<string, unknown> | null } = { args: null };
    const tools: ToolExecutor = {
      async callTool(_name: string, args: Record<string, unknown>) {
        captured.args = args;
        return { result: { ok: true }, durationMs: 0 };
      },
    };

    await runAgentLoop({
      capabilityId: 'analyzer@1.0.0',
      model: this.model,
      tools,
      system,
      userPrompt,
      toolSchemas: [SUBMIT_ANALYSIS_TOOL],
      maxTurns: 4,
    });

    const latencyMs = Math.round(performance.now() - start);
    const findings = (captured.args?.findings ?? []) as AnalysisFinding[];

    const meanConfidence = findings.length > 0
      ? findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length
      : 0;

    return {
      data: { findings },
      confidence: meanConfidence,
      evidence: input.evidence,
      assumptions: [],
      warnings: [],
      traceId: context.traceId,
      promptVersion: 'analyzer@1.0.0',
      latencyMs,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -w @buffr/capabilities
```

Expected: 5 Analyzer tests passing (plus the 5 Collector tests from Task 2).

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/analyzer/index.ts packages/capabilities/test/analyzer.test.ts
git commit -m "feat(capabilities): Analyzer capability"
```

---

### Task 4: Scorer capability

**Files:**
- Create: `packages/capabilities/src/scorer/index.ts`
- Create: `packages/capabilities/test/scorer.test.ts`

**Interfaces:**
- Consumes: `AnalysisFinding` from `../analyzer/index.js`; `ScoreMetric`, `ScorecardDefinition` from `@buffr/contracts`; `AgentContext`, `AgentResult`, `Capability` from `@buffr/contracts`
- Produces:
  ```typescript
  export type ScoredMetric = { id: string; label: string; rawScore: number; weightedScore: number; weight: number; };
  export type ScorerInput = { findings: AnalysisFinding[]; scorecard: ScorecardDefinition; evidenceCount: number; };
  export type ScorerOutput = { metrics: ScoredMetric[]; totalScore: number; confidence: number; warnings: string[]; evidenceCoverage: string; };
  export class Scorer implements Capability<ScorerInput, ScorerOutput>
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/capabilities/test/scorer.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -w @buffr/capabilities
```

Expected: FAIL — `Cannot find module '../src/scorer/index.js'`

- [ ] **Step 3: Implement Scorer**

Create `packages/capabilities/src/scorer/index.ts`:

```typescript
import type { AgentContext, AgentResult, Capability, ScorecardDefinition, ScoreMetric } from '@buffr/contracts';
import type { AnalysisFinding } from '../analyzer/index.js';

export type { ScorecardDefinition, ScoreMetric } from '@buffr/contracts';

export type ScoredMetric = {
  id: string;
  label: string;
  rawScore: number;
  weightedScore: number;
  weight: number;
};

export type ScorerInput = {
  findings: AnalysisFinding[];
  scorecard: ScorecardDefinition;
  evidenceCount: number;
};

export type ScorerOutput = {
  metrics: ScoredMetric[];
  totalScore: number;
  confidence: number;
  warnings: string[];
  evidenceCoverage: string;
};

export class Scorer implements Capability<ScorerInput, ScorerOutput> {
  readonly name = 'scorer';
  readonly version = '1.0.0';

  async execute(input: ScorerInput, context: AgentContext): Promise<AgentResult<ScorerOutput>> {
    const { findings, scorecard, evidenceCount } = input;
    const warnings: string[] = [];
    const metrics: ScoredMetric[] = [];
    let totalScore = 0;
    let confidenceSum = 0;
    let confidenceCount = 0;

    for (const metric of scorecard.metrics) {
      const finding = findings.find(f => f.dimensionId === metric.id);
      if (!finding) {
        warnings.push(`No finding for dimension '${metric.id}' (${metric.label}); contributing 0 to score.`);
        metrics.push({ id: metric.id, label: metric.label, rawScore: 0, weightedScore: 0, weight: metric.weight });
        continue;
      }

      const rawScore = metric.direction === 'lower-is-better'
        ? 100 - finding.score
        : finding.score;

      const weightedScore = rawScore * metric.weight;
      totalScore += weightedScore;
      confidenceSum += finding.confidence;
      confidenceCount += 1;
      metrics.push({ id: metric.id, label: metric.label, rawScore, weightedScore, weight: metric.weight });
    }

    const meanConfidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 0;
    const minRequired = scorecard.minimumEvidenceCount;
    const penalised = minRequired !== undefined && evidenceCount < minRequired;
    const confidence = penalised ? meanConfidence * (scorecard.confidencePenalty ?? 0.8) : meanConfidence;

    const evidenceCoverage = minRequired !== undefined
      ? `${evidenceCount} / ${minRequired} required signals`
      : `${evidenceCount} / ${evidenceCount} required signals`;

    return {
      data: { metrics, totalScore, confidence, warnings, evidenceCoverage },
      confidence,
      evidence: [],
      assumptions: [],
      warnings,
      traceId: context.traceId,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -w @buffr/capabilities
```

Expected: 7 Scorer tests passing (plus previous Collector + Analyzer tests).

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/scorer/index.ts packages/capabilities/test/scorer.test.ts
git commit -m "feat(capabilities): Scorer capability"
```

---

### Task 5: Teacher capability

**Files:**
- Create: `packages/capabilities/src/teacher/index.ts`
- Create: `packages/capabilities/test/teacher.test.ts`

**Interfaces:**
- Consumes: `runAgentLoop`, `ToolExecutor`, `ModelTool`, `ModelProvider`, `ModelRequest`, `ModelResponse` from `@buffr/kernel`; `AnalysisFinding` from `../analyzer/index.js`; `AgentContext`, `AgentResult`, `Capability` from `@buffr/contracts`
- Produces:
  ```typescript
  export type TeacherInput = {
    subjectDescription: string; findings: AnalysisFinding[];
    totalScore: number; confidence: number; warnings: string[];
    audience?: string;  // default 'general'
  };
  export type TeacherOutput = { explanation: string; keyLessons: string[]; actionableNext: string[]; };
  export class Teacher implements Capability<TeacherInput, TeacherOutput>
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/capabilities/test/teacher.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -w @buffr/capabilities
```

Expected: FAIL — `Cannot find module '../src/teacher/index.js'`

- [ ] **Step 3: Implement Teacher**

Create `packages/capabilities/src/teacher/index.ts`:

```typescript
import { runAgentLoop } from '@buffr/kernel';
import type { ToolExecutor, ModelTool, ModelProvider } from '@buffr/kernel';
import type { AgentContext, AgentResult, Capability } from '@buffr/contracts';
import type { AnalysisFinding } from '../analyzer/index.js';

export type TeacherInput = {
  subjectDescription: string;
  findings: AnalysisFinding[];
  totalScore: number;
  confidence: number;
  warnings: string[];
  audience?: string;
};

export type TeacherOutput = {
  explanation: string;
  keyLessons: string[];
  actionableNext: string[];
};

const SUBMIT_EXPLANATION_TOOL: ModelTool = {
  name: 'submit_explanation',
  description: 'Submit the plain-language explanation, key lessons, and actionable next steps.',
  inputSchema: {
    type: 'object',
    required: ['explanation', 'keyLessons', 'actionableNext'],
    properties: {
      explanation: { type: 'string', description: '2–4 paragraph plain-language summary' },
      keyLessons: { type: 'array', items: { type: 'string' }, description: '3–5 bullet takeaways' },
      actionableNext: { type: 'array', items: { type: 'string' }, description: 'concrete next steps' },
    },
  },
};

export class Teacher implements Capability<TeacherInput, TeacherOutput> {
  readonly name = 'teacher';
  readonly version = '1.0.0';

  constructor(private readonly model: ModelProvider) {}

  async execute(input: TeacherInput, context: AgentContext): Promise<AgentResult<TeacherOutput>> {
    const start = performance.now();
    const audience = input.audience ?? 'general';

    const findingsSummary = input.findings
      .map(f => {
        const pros = f.positives.length ? `Positives: ${f.positives.join(', ')}` : '';
        const cons = f.negatives.length ? `Concerns: ${f.negatives.join(', ')}` : '';
        const unk = f.unknowns.length ? `Unknowns: ${f.unknowns.join(', ')}` : '';
        return `[${f.dimensionId}] Score: ${f.score}/100 — ${f.summary}\n${[pros, cons, unk].filter(Boolean).join('; ')}`;
      })
      .join('\n\n');

    const warningSection = input.warnings.length
      ? `\nWarnings: ${input.warnings.join('; ')}`
      : '';

    const system = `You are a clear, concise educator. Explain analysis results in plain language for a ${audience} audience. Call submit_explanation exactly once.`;

    const userPrompt = `Subject: ${input.subjectDescription}
Overall score: ${Math.round(input.totalScore)}/100 (confidence: ${Math.round(input.confidence * 100)}%)${warningSection}

Findings by dimension:
${findingsSummary}

Produce:
- explanation: 2–4 paragraphs summarising what this score means for the subject and why
- keyLessons: 3–5 memorable bullet-point takeaways
- actionableNext: concrete next steps for the reader

Call submit_explanation now.`;

    const captured: { args: Record<string, unknown> | null } = { args: null };
    const tools: ToolExecutor = {
      async callTool(_name: string, args: Record<string, unknown>) {
        captured.args = args;
        return { result: { ok: true }, durationMs: 0 };
      },
    };

    await runAgentLoop({
      capabilityId: 'teacher@1.0.0',
      model: this.model,
      tools,
      system,
      userPrompt,
      toolSchemas: [SUBMIT_EXPLANATION_TOOL],
      maxTurns: 4,
    });

    const latencyMs = Math.round(performance.now() - start);
    const args = captured.args ?? {};
    const output: TeacherOutput = {
      explanation: (args.explanation as string) ?? '',
      keyLessons: (args.keyLessons as string[]) ?? [],
      actionableNext: (args.actionableNext as string[]) ?? [],
    };

    return {
      data: output,
      confidence: input.confidence,
      evidence: [],
      assumptions: [],
      warnings: [],
      traceId: context.traceId,
      promptVersion: 'teacher@1.0.0',
      latencyMs,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -w @buffr/capabilities
```

Expected: 4 Teacher tests passing (plus all previous capability tests).

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/teacher/index.ts packages/capabilities/test/teacher.test.ts
git commit -m "feat(capabilities): Teacher capability"
```

---

### Task 6: Journal capability

**Files:**
- Create: `packages/capabilities/src/journal/index.ts`
- Create: `packages/capabilities/test/journal.test.ts`

**Interfaces:**
- Consumes: `DecisionJournalEntry` from `@buffr/contracts`; `AgentContext`, `AgentResult`, `Capability` from `@buffr/contracts`
- Produces:
  ```typescript
  export type JournalInput = {
    subject: { type: string; id: string; description: string };
    domain: string; decision: string; thesis: string;
    expectedOutcome: string; timeHorizon?: string;
    confidence?: number;    // default 0.5
    assumptions?: string[]; // default []
    risks?: string[];       // default []
    evidenceIds?: string[]; // default []
    reviewAt?: string;
  };
  export type JournalOutput = { entry: DecisionJournalEntry; };
  export class Journal implements Capability<JournalInput, JournalOutput>
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/capabilities/test/journal.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/journal/index.js';
import type { AgentContext } from '@buffr/contracts';

const ctx: AgentContext = {
  userId: 'u1',
  workspaceId: 'w1',
  traceId: 't1',
  domain: 'investing',
  now: '2026-07-29T00:00:00.000Z',
  permissions: [],
};

const baseInput = {
  subject: { type: 'stock', id: 'ACME', description: 'ACME Corp Q3 earnings review' },
  domain: 'investing',
  decision: 'Buy ACME at $45',
  thesis: 'Revenue growth and margin expansion will drive re-rating.',
  expectedOutcome: 'Stock reaches $60 within 12 months.',
};

describe('Journal', () => {
  it('sets userId and workspaceId from context', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.strictEqual(result.data.entry.userId, 'u1');
    assert.strictEqual(result.data.entry.workspaceId, 'w1');
  });

  it('sets status to "open" always', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.strictEqual(result.data.entry.status, 'open');
  });

  it('generates a valid UUID for id', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.match(result.data.entry.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('defaults confidence to 0.5 when omitted', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.strictEqual(result.data.entry.confidence, 0.5);
    assert.strictEqual(result.confidence, 0.5);
  });

  it('uses provided confidence when given', async () => {
    const journal = new Journal();
    const result = await journal.execute({ ...baseInput, confidence: 0.8 }, ctx);
    assert.strictEqual(result.data.entry.confidence, 0.8);
    assert.strictEqual(result.confidence, 0.8);
  });

  it('sets reviewAt when provided', async () => {
    const journal = new Journal();
    const result = await journal.execute({ ...baseInput, reviewAt: '2026-10-29T00:00:00.000Z' }, ctx);
    assert.strictEqual(result.data.entry.reviewAt, '2026-10-29T00:00:00.000Z');
  });

  it('omits reviewAt when not provided', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.strictEqual(result.data.entry.reviewAt, undefined);
  });

  it('defaults assumptions, risks, evidenceIds to empty arrays', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.deepEqual(result.data.entry.assumptions, []);
    assert.deepEqual(result.data.entry.risks, []);
    assert.deepEqual(result.data.entry.evidenceIds, []);
  });

  it('sets createdAt from context.now', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.strictEqual(result.data.entry.createdAt, ctx.now);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -w @buffr/capabilities
```

Expected: FAIL — `Cannot find module '../src/journal/index.js'`

- [ ] **Step 3: Implement Journal**

Create `packages/capabilities/src/journal/index.ts`:

```typescript
import type { AgentContext, AgentResult, Capability, DecisionJournalEntry } from '@buffr/contracts';

export type { DecisionJournalEntry } from '@buffr/contracts';

export type JournalInput = {
  subject: { type: string; id: string; description: string };
  domain: string;
  decision: string;
  thesis: string;
  expectedOutcome: string;
  timeHorizon?: string;
  confidence?: number;
  assumptions?: string[];
  risks?: string[];
  evidenceIds?: string[];
  reviewAt?: string;
};

export type JournalOutput = {
  entry: DecisionJournalEntry;
};

export class Journal implements Capability<JournalInput, JournalOutput> {
  readonly name = 'journal';
  readonly version = '1.0.0';

  async execute(input: JournalInput, context: AgentContext): Promise<AgentResult<JournalOutput>> {
    const confidence = input.confidence ?? 0.5;
    const entry: DecisionJournalEntry = {
      id: crypto.randomUUID(),
      userId: context.userId,
      workspaceId: context.workspaceId,
      domain: input.domain,
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      createdAt: context.now,
      decision: input.decision,
      thesis: input.thesis,
      expectedOutcome: input.expectedOutcome,
      ...(input.timeHorizon !== undefined ? { timeHorizon: input.timeHorizon } : {}),
      confidence,
      assumptions: input.assumptions ?? [],
      risks: input.risks ?? [],
      evidenceIds: input.evidenceIds ?? [],
      status: 'open',
      ...(input.reviewAt !== undefined ? { reviewAt: input.reviewAt } : {}),
    };

    return {
      data: { entry },
      confidence,
      evidence: [],
      assumptions: entry.assumptions,
      warnings: [],
      traceId: context.traceId,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -w @buffr/capabilities
```

Expected: 9 Journal tests passing (plus all previous capability tests).

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/journal/index.ts packages/capabilities/test/journal.test.ts
git commit -m "feat(capabilities): Journal capability"
```

---

### Task 7: Barrel export + full build verification

**Files:**
- Modify: `packages/capabilities/src/index.ts`

**Interfaces:**
- Produces: all five capabilities + their types re-exported from `@buffr/capabilities`

- [ ] **Step 1: Write the barrel export**

Replace `packages/capabilities/src/index.ts` with:

```typescript
export * from './collector/index.js';
export * from './analyzer/index.js';
export * from './scorer/index.js';
export * from './teacher/index.js';
export * from './journal/index.js';
```

- [ ] **Step 2: Verify the full monorepo build including capabilities**

```bash
npm run build:packages
```

Expected: zero errors across contracts → kernel → connectors → capabilities in that order.

- [ ] **Step 3: Run all capability tests**

```bash
npm run test -w @buffr/capabilities
```

Expected: all tests pass across all five capabilities (Collector 5, Analyzer 5, Scorer 7, Teacher 4, Journal 9 = 30 tests total).

- [ ] **Step 4: Run the root build to ensure no breakage**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/index.ts
git commit -m "feat(capabilities): barrel export + full build verified"
```

---

## Self-Review

### 1. Spec coverage

| Spec requirement | Task |
|---|---|
| `@buffr/capabilities` package at `packages/capabilities/` | Task 1 |
| Build: `tsc -p tsconfig.json` | Task 1 (tsconfig) |
| Test: `node --test --test-concurrency=1 dist/test/*.test.js` | Task 1 (package.json) |
| Dep chain: contracts → kernel → connectors → capabilities | Task 1 (package.json deps) |
| `Collector` — Promise.allSettled, toEvidence(), optional flag | Task 2 |
| `Collector` — non-optional failure → AgentResult.warnings | Task 2 |
| `Collector` — confidence = 1 | Task 2 |
| `Analyzer` — runAgentLoop + submit_analysis tool | Task 3 |
| `Analyzer` — AnalysisFinding.score 0–100, confidence 0–1 | Task 3 |
| `Analyzer` — AgentResult.confidence = mean of finding.confidence | Task 3 |
| `Analyzer` — promptVersion = 'analyzer@1.0.0' | Task 3 |
| `Scorer` — rawScore = finding.score; flip for lower-is-better | Task 4 |
| `Scorer` — weightedScore = rawScore * metric.weight | Task 4 |
| `Scorer` — confidence penalised if evidenceCount < minimum | Task 4 |
| `Scorer` — missing dimension → warning + contributes 0 | Task 4 |
| `Scorer` — evidenceCoverage string | Task 4 |
| `Teacher` — runAgentLoop + submit_explanation tool | Task 5 |
| `Teacher` — AgentResult.confidence passes through from input | Task 5 |
| `Teacher` — promptVersion = 'teacher@1.0.0' | Task 5 |
| `Journal` — crypto.randomUUID() for id | Task 6 |
| `Journal` — userId + workspaceId from context | Task 6 |
| `Journal` — status = 'open' always on creation | Task 6 |
| `Journal` — confidence defaults to 0.5 | Task 6 |
| `Journal` — no model, no DB | Task 6 |
| `DecisionJournalEntry.workspaceId` added to contracts | Task 1 |
| Barrel re-export from `packages/capabilities/src/index.ts` | Task 7 |
| Full build including root | Task 7 |

All spec sections covered. No gaps found.

### 2. Placeholder scan

No "TBD", "TODO", or vague steps found. Every step has exact code or exact commands.

### 3. Type consistency

- `AnalysisFinding` defined in Task 3 (`packages/capabilities/src/analyzer/index.ts`) and imported as `import type { AnalysisFinding } from '../analyzer/index.js'` in Task 4 (Scorer) and Task 5 (Teacher). ✓
- `ScorecardDefinition`, `ScoreMetric` imported from `@buffr/contracts` in Task 4 and re-exported. ✓
- `DecisionJournalEntry` imported from `@buffr/contracts` in Task 6 and re-exported. ✓
- `ModelProvider`, `ModelRequest`, `ModelResponse` imported from `@buffr/kernel` in stub models in Tasks 3 and 5. ✓
- `runAgentLoop`, `ToolExecutor`, `ModelTool` imported from `@buffr/kernel` in Tasks 3 and 5. ✓
- Barrel in Task 7 exports everything via `export * from './X/index.js'` — no naming conflicts across capabilities. ✓
