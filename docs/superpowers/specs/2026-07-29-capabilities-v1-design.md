# Shared Capabilities v1 Design

**Date:** 2026-07-29
**Phase:** DI Platform Phase 2
**Status:** Approved

---

## Goal

Build five reusable reasoning capabilities in a new `@buffr/capabilities` package. Each implements the `Capability<TInput, TOutput>` contract from `@buffr/contracts` so Phase 4 engines can orchestrate them generically without special-casing individual capabilities.

---

## Architecture

### Dependency graph

```
@buffr/contracts
      ↓
@buffr/kernel    @buffr/connectors
      ↓                ↓
      @buffr/capabilities
```

`@buffr/capabilities` depends on all three upstream packages. It must not be imported by kernel, connectors, or contracts (no cycles).

### Package structure

```
packages/capabilities/
├── src/
│   ├── collector/index.ts
│   ├── analyzer/index.ts
│   ├── scorer/index.ts
│   ├── teacher/index.ts
│   ├── journal/index.ts
│   └── index.ts            ← re-exports all five capabilities + their types
├── test/
│   ├── collector.test.ts
│   ├── analyzer.test.ts
│   ├── scorer.test.ts
│   ├── teacher.test.ts
│   └── journal.test.ts
├── package.json
└── tsconfig.json
```

### Build and test

Matches existing monorepo packages:
- Build: `tsc -p tsconfig.json`
- Test: `npm run build && node --test --test-concurrency=1 dist/test/*.test.js`

### Pipeline (how the five capabilities chain)

```
CollectorInput
      ↓
   Collector            → Evidence[]
      ↓
AnalyzerInput (Evidence[] + dimensions)
      ↓
   Analyzer             → AnalysisFinding[] (with score per dimension)
      ↓
ScorerInput (findings + ScorecardDefinition)
      ↓
   Scorer               → totalScore, confidence, warnings
      ↓
TeacherInput (findings + score + confidence)
      ↓
   Teacher              → explanation, keyLessons, actionableNext
      ↓
JournalInput (human decision + optional enrichment from above)
      ↓
   Journal              → DecisionJournalEntry
```

Engines assemble this pipeline. Capabilities do not call each other directly.

---

## Contracts from `@buffr/contracts`

These types already exist and are used as-is:

```typescript
interface AgentContext {
  userId: string;
  workspaceId: string;
  traceId: string;
  domain: string;
  now: string;
  permissions: string[];
}

interface Evidence {
  sourceId: string;
  sourceType: string;
  title?: string;
  url?: string;
  excerpt?: string;
  retrievedAt: string;
  freshness?: 'live' | 'recent' | 'stale' | 'unknown';
}

interface AgentResult<T> {
  data: T;
  confidence: number;
  evidence: Evidence[];
  assumptions: string[];
  warnings: string[];
  traceId: string;
  promptVersion?: string;
  model?: string;
  latencyMs?: number;
  estimatedCostUsd?: number;
}

interface Capability<TInput, TOutput> {
  name: string;
  version: string;
  execute(input: TInput, context: AgentContext): Promise<AgentResult<TOutput>>;
}
```

New types (`ScorecardDefinition`, `ScoreMetric`, `DecisionJournalEntry`) are defined in `packages/capabilities/src/` rather than contracts — they move to contracts when a second consumer needs them.

---

## Capability 1: Collector

**Responsibility:** Fetch evidence from multiple sources in parallel. Tolerate optional source failures gracefully.

### Types

```typescript
// packages/capabilities/src/collector/index.ts

import type { DataConnector } from '@buffr/connectors';
import type { Evidence, AgentContext, AgentResult, Capability } from '@buffr/contracts';

export type CollectorSource<P> = {
  connector: DataConnector<P, unknown>;
  params: P;
  optional?: boolean; // default false; true = failure goes to warnings, not hard error
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
  execute(input: CollectorInput, context: AgentContext): Promise<AgentResult<CollectorOutput>>;
}
```

### Internals

1. `Promise.allSettled` over all sources.
2. Fulfilled → call `result.toEvidence()` → push into `evidence[]`.
3. Rejected → push `{ sourceId: source.connector.id, reason: err.message }` into `failed[]`.
4. Non-optional failures also appear in `AgentResult.warnings`.
5. `AgentResult.confidence = 1` (Collector is deterministic — it fetched or it didn't).
6. `AgentResult.evidence` = the collected evidence.
7. `AgentResult.latencyMs` = wall-clock ms for all fetches.

### Test strategy

- Stub connector returning a fixed `ConnectorResult` with `toEvidence(): [{ sourceId: 'stub', ... }]`
- Assert `evidence.length` matches successful sources
- Assert `failed` entry appears for a rejected connector
- Assert non-optional failure appears in `AgentResult.warnings`
- Assert optional failure does NOT appear in `AgentResult.warnings`

---

## Capability 2: Analyzer

**Responsibility:** Use the model to analyze evidence across specified dimensions. Produces a per-dimension finding with a numeric score (used by Scorer) and confidence.

### Types

```typescript
// packages/capabilities/src/analyzer/index.ts

import type { ModelProvider } from '@buffr/kernel';
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
  score: number;       // 0–100, assigned by model per dimension
  confidence: number;  // 0–1, assigned by model per dimension
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

export class Analyzer implements Capability<AnalyzerInput, AnalyzerOutput> {
  readonly name = 'analyzer';
  readonly version = '1.0.0';
  constructor(model: ModelProvider) {}
  execute(input: AnalyzerInput, context: AgentContext): Promise<AgentResult<AnalyzerOutput>>;
}
```

### Internals

1. Build system prompt: lists subject description, evidence excerpts (capped to avoid context overflow), dimensions with descriptions, and any extra instructions.
2. Call `runAgentLoop` from `@buffr/kernel` with a single `submit_analysis` tool whose JSON schema matches `AnalyzerOutput`.
3. The model fills in findings by calling the tool (same emulated tool-calling path Gemma already uses via `GemmaModelProvider`).
4. `AgentResult.confidence` = mean of `finding.confidence` values.
5. `AgentResult.evidence` = input evidence passed through.
6. `AgentResult.promptVersion` = `'analyzer@1.0.0'` (static for now; moves to PromptRegistry later).
7. `AgentResult.latencyMs` = wall-clock ms for `runAgentLoop`.

### Test strategy

- Stub `ModelProvider` that returns a pre-crafted `submit_analysis` tool call response with valid `AnalyzerOutput` JSON.
- Assert `findings.length` matches `dimensions.length`.
- Assert each finding has `dimensionId`, `score` in `[0, 100]`, `confidence` in `[0, 1]`.
- Assert `AgentResult.confidence` = mean of finding confidences.

---

## Capability 3: Scorer

**Responsibility:** Apply scorecard weights to analyzer findings. Pure deterministic math — no model.

### Types

```typescript
// packages/capabilities/src/scorer/index.ts

import type { AgentContext, AgentResult, Capability } from '@buffr/contracts';
import type { AnalysisFinding } from '../analyzer/index.js';

export type ScoreMetric = {
  id: string;
  label: string;
  weight: number;           // all weights must sum to 1.0
  direction: 'higher-is-better' | 'lower-is-better';
  min: number;
  max: number;
};

export type ScorecardDefinition = {
  id: string;
  version: string;
  metrics: ScoreMetric[];
  minimumEvidenceCount?: number;
  confidencePenalty?: number; // multiplied into confidence if evidence sparse
};

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
  totalScore: number;       // 0–100 weighted sum
  confidence: number;       // mean finding confidence, penalised if evidence sparse
  warnings: string[];       // missing dimensions, low evidence
  evidenceCoverage: string; // e.g. "7 / 12 required signals"
};

export class Scorer implements Capability<ScorerInput, ScorerOutput> {
  readonly name = 'scorer';
  readonly version = '1.0.0';
  execute(input: ScorerInput, context: AgentContext): Promise<AgentResult<ScorerOutput>>;
}
```

### Internals

1. For each metric in `scorecard.metrics`, find the matching finding by `finding.dimensionId === metric.id`.
2. If not found: add warning, contribute `0` to `totalScore`.
3. `rawScore = finding.score` (already 0–100, model-assigned). Flip to `100 - rawScore` if `direction === 'lower-is-better'`.
4. `weightedScore = rawScore * metric.weight` (weights sum to 1.0, so result is 0–100).
5. `totalScore = sum(weightedScore)`. (`metric.min/max` are reserved for future domain packs supplying raw metric values.)
6. `confidence = mean(finding.confidence)`. If `evidenceCount < minimumEvidenceCount`, multiply by `confidencePenalty ?? 0.8`.
7. `evidenceCoverage = "${evidenceCount} / ${minimumEvidenceCount ?? evidenceCount} required signals"`.
8. All synchronous, returned as `Promise.resolve(result)`.

### Test strategy

- Fixed findings + scorecard → assert `totalScore` arithmetic exactly.
- Missing dimension → assert warning present, dimension contributes 0.
- `evidenceCount < minimumEvidenceCount` → assert `confidence` is penalised.
- `direction === 'lower-is-better'` → assert score is flipped correctly.

---

## Capability 4: Teacher

**Responsibility:** Use the model to produce a plain-language explanation of the analysis and score result.

### Types

```typescript
// packages/capabilities/src/teacher/index.ts

import type { ModelProvider } from '@buffr/kernel';
import type { AgentContext, AgentResult, Capability } from '@buffr/contracts';
import type { AnalysisFinding } from '../analyzer/index.js';

export type TeacherInput = {
  subjectDescription: string;
  findings: AnalysisFinding[];
  totalScore: number;
  confidence: number;
  warnings: string[];
  audience?: string; // default: 'general'
};

export type TeacherOutput = {
  explanation: string;       // 2–4 paragraph plain-language summary
  keyLessons: string[];      // 3–5 bullet takeaways
  actionableNext: string[];  // concrete next steps
};

export class Teacher implements Capability<TeacherInput, TeacherOutput> {
  readonly name = 'teacher';
  readonly version = '1.0.0';
  constructor(model: ModelProvider) {}
  execute(input: TeacherInput, context: AgentContext): Promise<AgentResult<TeacherOutput>>;
}
```

### Internals

1. Build system prompt: subject, score, confidence, top findings (positives/negatives/unknowns), warnings, target audience.
2. Call `runAgentLoop` with a single `submit_explanation` tool whose JSON schema matches `TeacherOutput`.
3. `AgentResult.confidence` passes through from `input.confidence` (Teacher does not reassess confidence).
4. `AgentResult.promptVersion` = `'teacher@1.0.0'`.
5. `AgentResult.latencyMs` = wall-clock ms.

### Test strategy

- Stub `ModelProvider` returning a pre-crafted `submit_explanation` tool call response.
- Assert all three output fields present and non-empty.
- Assert `AgentResult.confidence` matches `input.confidence`.

---

## Capability 5: Journal

**Responsibility:** Assemble a typed `DecisionJournalEntry` from the human's decision and optional enrichment data from Analyzer/Scorer. No model, no DB.

### Types

```typescript
// packages/capabilities/src/journal/index.ts

import type { AgentContext, AgentResult, Capability } from '@buffr/contracts';

export type DecisionJournalEntry = {
  id: string;
  userId: string;
  workspaceId: string;
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
  status: 'open' | 'review-due' | 'reviewed';
  reviewAt?: string;
};

export type JournalInput = {
  subject: { type: string; id: string; description: string };
  domain: string;
  decision: string;
  thesis: string;
  expectedOutcome: string;
  timeHorizon?: string;
  // optional enrichment from Scorer and Analyzer
  confidence?: number;       // default 0.5 if omitted
  assumptions?: string[];    // default []
  risks?: string[];          // default []
  evidenceIds?: string[];    // default []
  reviewAt?: string;         // ISO date string; omit = no scheduled review
};

export type JournalOutput = {
  entry: DecisionJournalEntry;
};

export class Journal implements Capability<JournalInput, JournalOutput> {
  readonly name = 'journal';
  readonly version = '1.0.0';
  execute(input: JournalInput, context: AgentContext): Promise<AgentResult<JournalOutput>>;
}
```

### Internals

1. `id = crypto.randomUUID()`.
2. `userId`, `workspaceId` from `context`.
3. `createdAt = context.now`.
4. `status = 'open'` always on creation.
5. All other fields copied from input, with defaults for optional enrichment fields.
6. `AgentResult.confidence` = `input.confidence ?? 0.5`.
7. All synchronous.

### Test strategy

- Fixed input + context → assert `entry.userId === context.userId`.
- Assert `entry.status === 'open'`.
- Assert `entry.id` is a valid UUID string.
- Assert omitted `confidence` defaults to `0.5`.
- Assert `reviewAt` is present when provided, absent when omitted.

---

## Global constraints

- TypeScript ESM, all imports use `.js` extension.
- No new prod dependencies beyond `@buffr/contracts`, `@buffr/kernel`, `@buffr/connectors`.
- `Analyzer` and `Teacher` use `runAgentLoop` from `@buffr/kernel` — injected `ModelProvider` must be the caller's responsibility (no hardcoded Gemma inside capabilities).
- `AgentResult.latencyMs` is measured for model-using capabilities; synchronous capabilities may omit it.
- Tests run with `node:test` + `node:assert/strict` matching existing package pattern.

---

## Exit criteria (DI plan Phase 2)

- Each capability has typed input and output.
- Each capability has unit tests.
- Each capability builds and tests cleanly in the monorepo.
- Each capability works with any domain pack (domain-agnostic contracts, no hardcoded domain logic).
