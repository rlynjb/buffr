# Investing Engine Design

**Date:** 2026-07-29
**Phase:** DI Platform Phase 4
**Status:** Approved

---

## Goal

Build `@buffr/engine-investing` — the first `Engine` implementation for the DI platform. It wires together Collector, Analyzer, Scorer, Teacher, and Journal capabilities with the investing domain pack to produce a complete research result for a given ticker symbol. Optional memory persistence lets future chat sessions retrieve past analyses by semantic search.

---

## Architecture

### Dependency graph

```
@buffr/contracts
      ↓
@buffr/kernel   @buffr/capabilities   @buffr/domain-pack-investing   @buffr/connectors
      ↓                 ↓                          ↓                        ↓
                 @buffr/engine-investing
```

The engine is a leaf node. Nothing else in the monorepo depends on it yet.

### Package location

```
packages/engines/investing/
```

Published as `@buffr/engine-investing`. The `packages/engines/` directory accommodates future engines without polluting `packages/` root. Root `package.json` workspace array must include `"packages/engines/*"`.

### Package structure

```
packages/engines/investing/
├── src/
│   ├── types.ts        — InvestingInput, InvestingOutput, InvestingSource, InvestingEngineOptions
│   ├── engine.ts       — InvestingEngine class
│   └── index.ts        — barrel re-export
├── test/
│   └── engine.test.ts
├── package.json
└── tsconfig.json
```

### Build and test

Matches existing monorepo packages:
- Build: `tsc -p tsconfig.json`
- Test: `npm run build && node --test --test-concurrency=1 dist/test/*.test.js`

---

## Contracts

`Engine<TInput, TOutput>` already exists in `@buffr/contracts`:

```typescript
export interface Engine<TInput, TOutput> {
  id: string;
  version: string;
  run(input: TInput, context: AgentContext): Promise<AgentResult<TOutput>>;
}
```

`InvestingEngine` implements this interface with `TInput = InvestingInput` and `TOutput = InvestingOutput`. No contracts changes needed.

---

## Types

Defined in `packages/engines/investing/src/types.ts`.

### InvestingSource

```typescript
import type { DataConnector } from '@buffr/connectors';

export type InvestingSource = {
  connector: DataConnector<unknown, unknown>;
  paramsFor: (ticker: string, entityType: 'company' | 'etf') => unknown;
  optional?: boolean;
};
```

The `paramsFor` function lets the caller build connector-specific query params from a ticker. Example:

```typescript
{
  connector: new BraveSearchConnector({ apiKey }),
  paramsFor: (ticker) => ({ query: `${ticker} company earnings analysis`, count: 5 }),
}
```

### InvestingEngineOptions

```typescript
import type { ModelProvider } from '@buffr/kernel';
import type { ConversationMemory } from '@buffr/kernel';

export type InvestingEngineOptions = {
  model: ModelProvider;
  sources: InvestingSource[];
  memory?: ConversationMemory;
};
```

### InvestingInput

```typescript
export type InvestingInput = {
  ticker: string;
  entityType: 'company' | 'etf';
  // Memory persistence — omit to skip
  conversationId?: string;
  // Journal persistence — omit to skip; if provided, decision + thesis are required together
  decision?: string;
  thesis?: string;
  timeHorizon?: string;
};
```

Journal is only written when `decision` is provided. Memory is only written when `conversationId` is provided. Both are opt-in.

### InvestingOutput

```typescript
import type { AnalysisFinding } from '@buffr/capabilities';
import type { ScoredMetric } from '@buffr/capabilities';
import type { Evidence } from '@buffr/contracts';

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

## Engine class

Defined in `packages/engines/investing/src/engine.ts`.

### Constructor

```typescript
import { Collector, Analyzer, Scorer, Teacher, Journal } from '@buffr/capabilities';
import type { Engine, AgentContext, AgentResult } from '@buffr/contracts';
import type { ModelProvider, ConversationMemory } from '@buffr/kernel';
import type { InvestingInput, InvestingOutput, InvestingEngineOptions } from './types.js';

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
}
```

### `run()` pipeline

```typescript
async run(input: InvestingInput, context: AgentContext): Promise<AgentResult<InvestingOutput>> {
  // Step 1 — pick domain pack data by entityType
  const dimensions = input.entityType === 'company' ? COMPANY_DIMENSIONS : ETF_DIMENSIONS;
  const scorecard  = input.entityType === 'company' ? COMPANY_SCORECARD  : ETF_SCORECARD;

  // Step 2 — build collector sources
  const collectorSources = this.sources.map(s => ({
    connector: s.connector,
    params: s.paramsFor(input.ticker, input.entityType),
    optional: s.optional ?? false,
  }));

  // Step 3 — Collector
  const collectorResult = await this.collector.execute({ sources: collectorSources }, context);
  const { evidence, failed } = collectorResult.data;

  // Step 4 — short-circuit if no evidence
  if (evidence.length === 0) {
    return {
      data: {
        summary: {
          ticker: input.ticker, entityType: input.entityType,
          totalScore: 0, confidence: 0,
          explanation: 'No evidence could be collected.',
          keyLessons: [], actionableNext: [],
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

  // Step 5 — Analyzer
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

  // Step 6 — Scorer
  const scorerResult = await this.scorer.execute(
    { findings: analyzerResult.data.findings, scorecard, evidenceCount: evidence.length },
    context,
  );

  // Step 7 — Teacher
  const allWarnings = [
    ...collectorResult.warnings,
    ...scorerResult.data.warnings,
  ];
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

  // Step 8 — Memory write (opt-in)
  if (this.memory && input.conversationId) {
    const memoryAnswer =
      `${teacherResult.data.explanation}\n\n` +
      `Score: ${scorerResult.data.totalScore.toFixed(1)}/100. ` +
      `Key lessons: ${teacherResult.data.keyLessons.join('; ')}`;
    await this.memory.remember({
      conversationId: input.conversationId,
      question: `Analyze ${input.ticker}`,
      answer: memoryAnswer,
    });
  }

  // Step 9 — Journal write (opt-in)
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

  // Step 10 — assemble result
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
```

---

## Test strategy

`test/engine.test.ts` uses `node:test` + `node:assert/strict`. All external calls are stubbed — no live API or model calls.

### Stub model

The stub `ModelProvider` returns different tool-call responses based on the tool schema name in the request. It inspects `request.tools[0].name` and returns either a `submit_analysis` or `submit_explanation` response with minimal but valid JSON:

```typescript
// submit_analysis response (5 company findings, scores 70–85, confidence 0.8)
// submit_explanation response (explanation: 'Test explanation.', keyLessons: ['a'], actionableNext: ['b'])
```

### Stub connector

Implements `DataConnector<unknown, unknown>`, returns a `ConnectorResult` whose `toEvidence()` yields 2 `Evidence` objects with `sourceId: 'stub-1'` and `sourceId: 'stub-2'`.

### Test cases

**1. Company happy path** — stub connector + stub model, `entityType: 'company'`, no `decision`, no `conversationId`. Assert:
- `result.data.summary.totalScore > 0`
- `result.data.summary.explanation === 'Test explanation.'`
- `result.data.detail.findings.length === 5` (COMPANY_DIMENSIONS has 5)
- `result.data.detail.journalEntryId === undefined`

**2. ETF with journal** — same stubs, `entityType: 'etf'`, `decision: 'buy'`, `thesis: 'low cost'`. Assert:
- `result.data.detail.findings.length === 5` (ETF_DIMENSIONS has 5)
- `result.data.detail.journalEntryId` is a string matching UUID pattern `/^[0-9a-f-]{36}$/`

**3. Memory write** — `entityType: 'company'`, `conversationId: 'conv-1'`, stub `ConversationMemory` with a captured `remember` call. Assert:
- `remember` was called exactly once
- Called with `conversationId: 'conv-1'`
- `answer` is a non-empty string containing the explanation

---

## Global constraints

- TypeScript ESM; all local imports use `.js` extension.
- No new prod dependencies beyond the five listed (`@buffr/contracts`, `@buffr/kernel`, `@buffr/capabilities`, `@buffr/connectors`, `@buffr/domain-pack-investing`).
- Root `package.json` workspace array must include `"packages/engines/*"`.
- `packages/engines/investing/tsconfig.json` extends `"../../../tsconfig.base.json"` (3 levels up).
- The engine must not change any upstream package (contracts, kernel, capabilities, connectors, domain-pack-investing).
- `run()` must short-circuit with `confidence: 0` and no model calls when `evidence.length === 0`.

---

## Exit criteria (DI plan Phase 4)

- `@buffr/engine-investing` builds and tests clean in the monorepo.
- `InvestingEngine` satisfies `Engine<InvestingInput, InvestingOutput>` at compile time.
- All 3 test cases pass with stub model and connector.
- Memory write and journal write are verified in tests.
- No upstream packages modified.
