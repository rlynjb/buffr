# Etsy Workflow Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan intentionally contains no commit steps because the user explicitly requested no commits for plan creation.

**Goal:** Build the first working Etsy workflow engine for one Etsy seller, proving deterministic inputs, pauses, state transitions, evidence gates, M1-M7 structured module outputs, and experiment-result learning before any terminal-chat adapter is added.

**Architecture:** Implement a deterministic workflow orchestrator with bounded agentic workers. A custom TypeScript state machine owns routes, loops, validation, persisted state, stop states, waits, and lifecycle routing; OpenAI Agents SDK modules M1-M7 provide bounded structured evidence interpretation and never choose business-process routing.

**Tech Stack:** TypeScript + Node.js; OpenAI Agents SDK for judgment-heavy module calls behind a local adapter; Zod for contracts, validation, and structured outputs; Etsy Open API v3 through a read-only OAuth connector; OpenAI hosted web search for cited M3 research; local-file persistence for runs, evidence, experiment plans, and learning records; Vitest with mocked Etsy/OpenAI tools; structured workflow events plus Agents SDK tracing hooks.

## Global Constraints

- No automated Etsy listing writes. Recommendations and experiments are manual-only.
- Connector credentials stay in local ignored settings and are accessible only through a future connector configuration layer.
- The workflow engine must never access `.env`, raw API keys, OAuth client secrets, refresh tokens, or token file contents.
- Etsy connector modules may know Etsy endpoint shapes; workflow modules consume normalized evidence only.
- M0 is shared policy and runtime configuration, not a standalone workflow turn.
- M1-M7 return structured outputs validated by Zod.
- The engine, not an LLM, owns allowed transitions, evidence gates, validation, state, persistence, stop/wait/resume/completion, and lifecycle routing.
- M3 uses only read-only tools, requires citations for open-web research, returns structured output, and never chooses lifecycle routing.
- M3 canonical `status` values are `resolved`, `partly_resolved`, and `unresolved`.
- M3 `next_action` values are `continue` and `stop`; the engine honors `continue` only inside configured hard limits.
- M3 initial configurable safety bounds are maximum 3 research tool calls per invocation and maximum 2 minutes wall-clock time per invocation.
- A per-run cost/token budget must be chosen and configured before a real API-backed run; mocked development does not require the real budget value.
- The terminal-chat interface is deferred until engine inputs, pauses, and outputs are proven by non-networked tests and at least one representative workflow run.
- Local files are the first persistence mechanism because version one serves one known Etsy seller on one developer-controlled machine.
- Database, seller onboarding, billing, voice UX, hosted product shell, and web app work are outside this implementation plan.
- Tasks are TDD-first. Each task starts by adding focused tests, runs them to confirm failure, implements the smallest behavior, then reruns the named tests.
- This plan includes future implementation instructions that modify code and dependencies. Creating this plan is documentation-only.

---

## File Structure Map

Create or modify these files during implementation:

Tasks 1-4 have already created the root contracts, storage, and workflow-engine files shown below.
The self-documenting module-folder convention applies to Tasks 5 and later.

```text
buffr/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── core/
│   │   ├── config.ts
│   │   └── errors.ts
│   ├── contracts/
│   │   ├── evidence.ts
│   │   ├── experiments.ts
│   │   ├── modules.ts
│   │   └── workflow.ts
│   ├── storage/
│   │   └── runs.ts
│   ├── workflow/
│   │   ├── engine.ts
│   │   ├── guards.ts
│   │   ├── routes.ts
│   │   └── state.ts
│   ├── agents/
│   │   ├── runner.ts
│   │   ├── core/
│   │   │   ├── policy.ts
│   │   │   ├── policy.md
│   │   │   └── README.md
│   │   ├── context/
│   │   │   ├── agent.ts
│   │   │   ├── prompt.md
│   │   │   └── README.md
│   │   ├── metrics/
│   │   │   ├── agent.ts
│   │   │   ├── prompt.md
│   │   │   └── README.md
│   │   ├── research/
│   │   │   ├── agent.ts
│   │   │   ├── prompt.md
│   │   │   └── README.md
│   │   ├── diagnosis/
│   │   │   ├── agent.ts
│   │   │   ├── prompt.md
│   │   │   └── README.md
│   │   ├── hypothesis/
│   │   │   ├── agent.ts
│   │   │   ├── prompt.md
│   │   │   └── README.md
│   │   ├── test-definition/
│   │   │   ├── agent.ts
│   │   │   ├── prompt.md
│   │   │   └── README.md
│   │   └── evaluation/
│   │       ├── agent.ts
│   │       ├── prompt.md
│   │       └── README.md
│   ├── connectors/
│   │   └── etsy/
│   │       ├── auth.ts
│   │       ├── client.ts
│   │       ├── mapper.ts
│   │       └── repository.ts
│   ├── tracing/
│   │   └── events.ts
│   └── tests/
│       ├── agents/
│       ├── connectors/
│       ├── contracts/
│       ├── fixtures/
│       ├── storage/
│       ├── tracing/
│       └── workflow/
```

Responsibilities:

- `core/config.ts`: validated non-secret app configuration and connector config inputs supplied by the caller.
- `core/errors.ts`: typed application errors with stable codes.
- `contracts/*.ts`: Zod schemas, TypeScript types, enums, and validation helpers.
- `storage/runs.ts`: local-file repository for run state, evidence snapshots, plans, and events.
- `workflow/*.ts`: deterministic state machine, routes, guards, and orchestration.
- `agents/runner.ts`: local interface that wraps OpenAI Agents SDK calls and is easy to fake in tests.
- `agents/core/`: M0 shared policy and runtime guidance. It is shared configuration, not a
  workflow turn.
- `agents/<role>/agent.ts`: runtime TypeScript for the module's schema validation, deterministic
  helpers, model calls, and tool wiring.
- `agents/<role>/prompt.md`: co-located prompt text for that module. There is no separate prompt
  tree.
- `agents/<role>/README.md`: concise module card documenting purpose, when it runs, input contract,
  output contract, dependencies, permitted tools, success/stop/pause/failure conditions, and links
  to related design docs.
- Shared contract definitions stay in `src/contracts/`; module READMEs reference them and must not
  duplicate their schema definitions.
- `connectors/etsy/*.ts`: read-only Etsy config, OAuth token provider interface, HTTP client, mapping, and normalized repository functions.
- `tracing/events.ts`: structured run event types and trace sink.
- `tests/fixtures/*.ts`: representative normalized Etsy listing, metrics, experiment, and research fixtures.

---

## Shared Interfaces

Use these names exactly so each task composes with the next.

```typescript
export type WorkflowStage =
  | 'm1_context'
  | 'm2_metrics_initial'
  | 'm3_research'
  | 'm4_diagnosis'
  | 'm5_hypothesis'
  | 'm6_test_plan'
  | 'experiment_wait'
  | 'm2_metrics_results'
  | 'm7_learning'
  | 'cycle_complete';

export type WorkflowStatus =
  | 'analyzing'
  | 'researching'
  | 'waiting_for_data'
  | 'ready_for_experiment'
  | 'experiment_running'
  | 'ready_for_evaluation'
  | 'cycle_complete'
  | 'stopped';

export type ModuleId = 'm1' | 'm2' | 'm3' | 'm4' | 'm5' | 'm6' | 'm7';
export type Confidence = 'low' | 'moderate' | 'high';
export type ResearchStatus = 'resolved' | 'partly_resolved' | 'unresolved';
export type ResearchNextAction = 'continue' | 'stop';
export type ResearchToolName = 'etsy_listing_details' | 'etsy_transactions' | 'normalized_evidence' | 'hosted_web_search';
export type DiagnosisDecision = 'proceed_to_hypothesis' | 'research_domain_knowledge' | 'collect_more_data';
export type ExperimentOutcome = 'win' | 'loss' | 'inconclusive';
export type HypothesisEvaluation = 'supported' | 'partly_supported' | 'not_supported' | 'inconclusive';
export type EvaluationNextAction = 'keep' | 'revert' | 'iterate' | 'new_test' | 'research' | 'wait';
```

```typescript
export type AgentRunner = {
  runStructured<TOutput>(
    input: AgentRunInput<TOutput>,
  ): Promise<AgentRunResult<TOutput>>;
};

export type AgentRunInput<TOutput> = {
  moduleId: ModuleId;
  instructions: string;
  input: unknown;
  outputSchema: z.ZodType<TOutput>;
  trace: TraceContext;
};

export type AgentRunResult<TOutput> = {
  output: TOutput;
  traceId?: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
  };
};
```

```typescript
export type EtsyConnectorConfig = {
  apiKey: string;
  oauthClientId: string;
  oauthRedirectUri: string;
  tokenStoragePath: string;
  scopes: readonly string[];
};

export type EtsyTokenProvider = {
  getAccessToken(): Promise<string>;
};
```

---

## Real Credentials Boundary

Mocked development does not need real Etsy credentials or real OpenAI calls. Tasks 1-9, 11, and 12 run with fakes and fixtures only.

Real credentials are needed only after the mocked connector and engine pass:

- Task 10 includes a mocked OAuth/config test path and a separate local validation command.
- The local validation command must be skipped until `.env` contains real Etsy API and OAuth values.
- The workflow engine never reads those values directly; the connector configuration layer reads them and returns sanitized connector settings.
- OpenAI hosted web search is mocked in tests. A real API-backed M3 run requires the per-run cost/token budget to be configured first.

---

### Task 1: Tooling, Test Runner, And Project Skeleton

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `src/index.ts`
- Create: `src/core/errors.ts`
- Create: `src/tests/fixtures/listing.ts`
- Create: `src/tests/smoke.test.ts`

**Interfaces:**
- Consumes: existing reset scaffold.
- Produces:
  - `AppErrorCode = 'validation_failed' | 'route_not_allowed' | 'storage_failed' | 'connector_failed' | 'research_limit_reached' | 'configuration_failed'`
  - `class AppError extends Error`
  - Smoke test coverage for TypeScript module loading and `AppError` construction.

- [ ] **Step 1: Add test and runtime dependency plan to `package.json`**

Use Vitest as the test runner and add exact scripts:

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@openai/agents": "^0.1.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

Run after editing dependencies:

```bash
npm install
```

Expected: `package-lock.json` updates and `node_modules` installs packages.

- [ ] **Step 2: Add failing smoke test**

Create `src/tests/smoke.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { AppError } from '../core/errors.js';

describe('test harness', () => {
  it('loads TypeScript modules through Vitest', () => {
    const error = new AppError('validation_failed', 'Invalid fixture');
    expect(error.code).toBe('validation_failed');
    expect(error.message).toBe('Invalid fixture');
  });
});
```

Run:

```bash
npm test -- src/tests/smoke.test.ts
```

Expected before implementation: FAIL because `src/core/errors.ts` does not exist.

- [ ] **Step 3: Implement `src/core/errors.ts`**

```typescript
export type AppErrorCode =
  | 'validation_failed'
  | 'route_not_allowed'
  | 'storage_failed'
  | 'connector_failed'
  | 'research_limit_reached'
  | 'configuration_failed';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly cause?: unknown;

  constructor(code: AppErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.cause = options.cause;
  }
}
```

- [ ] **Step 4: Keep `src/index.ts` as a temporary non-workflow entry point**

Replace its contents with:

```typescript
console.log('buffr workflow engine scaffold loaded');
```

This does not start a workflow or read credentials.

- [ ] **Step 5: Verify tooling**

Run:

```bash
npm test -- src/tests/smoke.test.ts
npm run typecheck
npm run build
```

Expected: all commands exit 0.

---

### Task 2: Contracts And Contract Tests

**Files:**
- Create: `src/contracts/evidence.ts`
- Create: `src/contracts/experiments.ts`
- Create: `src/contracts/modules.ts`
- Create: `src/contracts/workflow.ts`
- Create: `src/tests/contracts/contracts.test.ts`
- Create: `src/tests/fixtures/listing.ts`

**Interfaces:**
- Consumes: Zod dependency from Task 1.
- Produces:
  - `NormalizedListingEvidenceSchema`, `NormalizedListingEvidence`
  - `MetricSnapshotSchema`, `MetricSnapshot`
  - `ExperimentPlanSchema`, `ExperimentPlan`
  - `ResearchOutputSchema`, `ResearchOutput`
  - `WorkflowRunStateSchema`, `WorkflowRunState`
  - `parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T`

- [ ] **Step 1: Write failing contract tests**

Create `src/tests/contracts/contracts.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { NormalizedListingEvidenceSchema } from '../../contracts/evidence.js';
import { ResearchOutputSchema } from '../../contracts/modules.js';
import { WorkflowRunStateSchema } from '../../contracts/workflow.js';
import { makeFixtureListingEvidence } from '../fixtures/listing.js';

describe('contracts', () => {
  it('accepts normalized Etsy evidence and rejects raw credentials', () => {
    const evidence = makeFixtureListingEvidence();
    expect(NormalizedListingEvidenceSchema.parse(evidence).listingId).toBe('listing-123');

    expect(() =>
      NormalizedListingEvidenceSchema.parse({ ...evidence, apiKey: 'secret-value' }),
    ).toThrow();
  });

  it('normalizes M3 status and next_action values', () => {
    const result = ResearchOutputSchema.parse({
      status: 'partly_resolved',
      next_action: 'stop',
      requester: 'm5',
      question: 'What test duration is defensible for low-volume listings?',
      evidence: [{ source: 'web', title: 'Etsy help', url: 'https://example.com/etsy', excerpt: 'Use listing stats.', fetchedAt: '2026-08-12T00:00:00.000Z' }],
      confidence: 'moderate',
      limitations: ['Example citation only for contract shape.'],
    });

    expect(result.status).toBe('partly_resolved');
    expect(() => ResearchOutputSchema.parse({ ...result, status: 'blocked' })).toThrow();
    expect(() => ResearchOutputSchema.parse({ ...result, next_action: 'blocked' })).toThrow();
    expect(() => ResearchOutputSchema.parse({ ...result, next_action: 'continue' })).toThrow();
    expect(
      ResearchOutputSchema.parse({
        ...result,
        next_action: 'continue',
        requestedLookup: {
          tool: 'hosted_web_search',
          reason: 'Need a cited source for low-volume Etsy experiment duration.',
          input: { query: 'Etsy low volume listing experiment duration' },
        },
      }).requestedLookup?.tool,
    ).toBe('hosted_web_search');
  });

  it('validates persisted run state shape', () => {
    const state = WorkflowRunStateSchema.parse({
      runId: 'run-123',
      listingId: 'listing-123',
      status: 'analyzing',
      stage: 'm1_context',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      evidenceRefs: [],
      moduleOutputs: {},
      events: [],
    });

    expect(state.stage).toBe('m1_context');
  });
});
```

Run:

```bash
npm test -- src/tests/contracts/contracts.test.ts
```

Expected before implementation: FAIL because contract modules do not exist.

- [ ] **Step 2: Implement `contracts/evidence.ts`**

Define:

```typescript
import { z } from 'zod';

export const EvidenceSourceSchema = z.enum(['etsy', 'web', 'user', 'derived']);
export const IsoDateSchema = z.string().datetime();

export const ListingStatsSchema = z.object({
  impressions: z.number().int().nonnegative().optional(),
  views: z.number().int().nonnegative().optional(),
  visits: z.number().int().nonnegative().optional(),
  favorites: z.number().int().nonnegative().optional(),
  orders: z.number().int().nonnegative().optional(),
  revenueCents: z.number().int().nonnegative().optional(),
  adImpressions: z.number().int().nonnegative().optional(),
  adClicks: z.number().int().nonnegative().optional(),
  adSpendCents: z.number().int().nonnegative().optional(),
  adRevenueCents: z.number().int().nonnegative().optional(),
}).strict();

export const NormalizedListingEvidenceSchema = z.object({
  listingId: z.string().min(1),
  shopId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  priceCents: z.number().int().nonnegative().optional(),
  currency: z.string().min(3).max(3).optional(),
  state: z.string().optional(),
  url: z.string().url().optional(),
  stats: ListingStatsSchema.default({}),
  observedAt: IsoDateSchema,
  source: EvidenceSourceSchema,
}).strict();

export type ListingStats = z.infer<typeof ListingStatsSchema>;
export type NormalizedListingEvidence = z.infer<typeof NormalizedListingEvidenceSchema>;
```

- [ ] **Step 3: Implement `contracts/modules.ts`**

Define all module output schemas:

```typescript
import { z } from 'zod';
import { IsoDateSchema } from './evidence.js';

export const ModuleIdSchema = z.enum(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
export const ConfidenceSchema = z.enum(['low', 'moderate', 'high']);
export const ResearchToolNameSchema = z.enum(['etsy_listing_details', 'etsy_transactions', 'normalized_evidence', 'hosted_web_search']);

export const CitationSchema = z.object({
  source: z.enum(['etsy', 'web', 'user', 'derived']),
  title: z.string().min(1),
  url: z.string().url().optional(),
  excerpt: z.string().min(1),
  fetchedAt: IsoDateSchema,
}).strict().superRefine((value, ctx) => {
  if (value.source === 'web' && !value.url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['url'],
      message: 'web citations require url',
    });
  }
});

export const ResearchOutputSchema = z.object({
  status: z.enum(['resolved', 'partly_resolved', 'unresolved']),
  next_action: z.enum(['continue', 'stop']),
  requester: ModuleIdSchema.exclude(['m3']),
  question: z.string().min(1),
  evidence: z.array(CitationSchema),
  confidence: ConfidenceSchema,
  limitations: z.array(z.string()),
  requestedLookup: z.object({
    tool: ResearchToolNameSchema,
    reason: z.string().min(1),
    input: z.record(z.unknown()).default({}),
  }).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.next_action === 'continue' && !value.requestedLookup) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestedLookup'],
      message: 'requestedLookup is required when next_action is continue',
    });
  }
});

export const ContextOutputSchema = z.object({
  product: z.string().min(1),
  likelyCustomer: z.string().optional(),
  positioning: z.string().optional(),
  availableEvidence: z.array(z.string()),
  missingInformation: z.array(z.string()),
  notes: z.array(z.string()),
}).strict();

export const MetricValueSchema = z.object({
  name: z.string().min(1),
  current: z.number().nullable(),
  baseline: z.number().nullable(),
  absoluteChange: z.number().nullable(),
  percentageChange: z.number().nullable(),
  qualification: z.enum(['improved', 'declined', 'stable', 'inconclusive', 'not_available']),
  confidence: ConfidenceSchema,
}).strict();

export const MetricsOutputSchema = z.object({
  phase: z.enum(['initial', 'post_experiment']),
  metrics: z.array(MetricValueSchema),
  comparisonQuality: z.enum(['valid', 'limited', 'invalid', 'missing']),
  unresolvedQualificationNeeds: z.array(z.string()),
  researchNeed: z.string().optional(),
}).strict();

export const DiagnosisOutputSchema = z.object({
  performancePath: z.enum(['discovery', 'click_through', 'interest', 'conversion', 'profitability', 'insufficient_data']),
  primaryBottleneck: z.string(),
  competingExplanation: z.string().optional(),
  confidence: ConfidenceSchema,
  decision: z.enum(['proceed_to_hypothesis', 'research_domain_knowledge', 'collect_more_data']),
  researchQuestion: z.string().optional(),
  notes: z.array(z.string()),
}).strict();

export const HypothesisOutputSchema = z.object({
  hypothesis: z.string().min(1),
  primaryVariable: z.string().min(1),
  recommendedRevision: z.string().min(1),
  keepConstant: z.array(z.string()),
  expectedSignal: z.string().min(1),
  researchNeed: z.string().optional(),
  notes: z.array(z.string()),
}).strict();

export const TestPlanOutputSchema = z.object({
  primaryMetric: z.string().min(1),
  secondaryMetrics: z.array(z.string()),
  baselineValue: z.number(),
  baselinePeriod: z.string().min(1),
  qualificationRequirements: z.array(z.string()),
  expectedSupportingSignal: z.string().min(1),
  expectedWeakeningSignal: z.string().min(1),
  inconclusiveCondition: z.string().min(1),
  contextToMonitor: z.array(z.string()),
  unresolvedMeasurementRules: z.array(z.string()),
  researchNeed: z.string().optional(),
}).strict();

export const EvaluationOutputSchema = z.object({
  outcome: z.enum(['win', 'loss', 'inconclusive']),
  hypothesisEvaluation: z.enum(['supported', 'partly_supported', 'not_supported', 'inconclusive']),
  evidence: z.array(z.string()),
  contextualFactors: z.array(z.string()),
  learning: z.string().min(1),
  confidence: ConfidenceSchema,
  knowledgeSource: z.enum(['product_data', 'experiment', 'external_research', 'combination']),
  nextAction: z.enum(['keep', 'revert', 'iterate', 'new_test', 'research', 'wait']),
  researchQuestion: z.string().optional(),
  nextActionRationale: z.string().min(1),
}).strict();

export type ResearchToolName = z.infer<typeof ResearchToolNameSchema>;
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;
export type ContextOutput = z.infer<typeof ContextOutputSchema>;
export type MetricsOutput = z.infer<typeof MetricsOutputSchema>;
export type DiagnosisOutput = z.infer<typeof DiagnosisOutputSchema>;
export type HypothesisOutput = z.infer<typeof HypothesisOutputSchema>;
export type TestPlanOutput = z.infer<typeof TestPlanOutputSchema>;
export type EvaluationOutput = z.infer<typeof EvaluationOutputSchema>;
```

- [ ] **Step 4: Implement `contracts/experiments.ts`**

Define:

```typescript
import { z } from 'zod';
import { TestPlanOutputSchema } from './modules.js';

export const ExperimentPlanSchema = z.object({
  experimentId: z.string().min(1),
  listingId: z.string().min(1),
  hypothesis: z.string().min(1),
  revision: z.string().min(1),
  testPlan: TestPlanOutputSchema,
  status: z.enum(['ready', 'running', 'completed', 'cancelled']),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
}).strict();

export type ExperimentPlan = z.infer<typeof ExperimentPlanSchema>;
```

- [ ] **Step 5: Implement `contracts/workflow.ts`**

Define:

```typescript
import { z } from 'zod';
import {
  ContextOutputSchema,
  DiagnosisOutputSchema,
  EvaluationOutputSchema,
  HypothesisOutputSchema,
  MetricsOutputSchema,
  ResearchOutputSchema,
  TestPlanOutputSchema,
} from './modules.js';

export const WorkflowStageSchema = z.enum([
  'm1_context',
  'm2_metrics_initial',
  'm3_research',
  'm4_diagnosis',
  'm5_hypothesis',
  'm6_test_plan',
  'experiment_wait',
  'm2_metrics_results',
  'm7_learning',
  'cycle_complete',
]);

export const WorkflowStatusSchema = z.enum([
  'analyzing',
  'researching',
  'waiting_for_data',
  'ready_for_experiment',
  'experiment_running',
  'ready_for_evaluation',
  'cycle_complete',
  'stopped',
]);

export const WorkflowEventSchema = z.object({
  eventId: z.string().min(1),
  runId: z.string().min(1),
  type: z.string().min(1),
  stage: WorkflowStageSchema.optional(),
  message: z.string().min(1),
  createdAt: z.string().datetime(),
  data: z.record(z.unknown()).default({}),
}).strict();

export const WorkflowRunStateSchema = z.object({
  runId: z.string().min(1),
  listingId: z.string().min(1),
  status: WorkflowStatusSchema,
  stage: WorkflowStageSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  evidenceRefs: z.array(z.string()),
  moduleOutputs: z.object({
    m1: ContextOutputSchema.optional(),
    m2Initial: MetricsOutputSchema.optional(),
    m3: z.array(ResearchOutputSchema).default([]),
    m4: DiagnosisOutputSchema.optional(),
    m5: HypothesisOutputSchema.optional(),
    m6: TestPlanOutputSchema.optional(),
    m2Results: MetricsOutputSchema.optional(),
    m7: EvaluationOutputSchema.optional(),
  }).strict(),
  events: z.array(WorkflowEventSchema),
}).strict();

export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
export type WorkflowRunState = z.infer<typeof WorkflowRunStateSchema>;
```

- [ ] **Step 6: Add validation helper**

In `contracts/workflow.ts`, add:

```typescript
import { AppError } from '../core/errors.js';

export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', `${label} failed validation`, { cause: result.error });
  }
  return result.data;
}
```

- [ ] **Step 7: Add fixture evidence**

Create `src/tests/fixtures/listing.ts`:

```typescript
import type { NormalizedListingEvidence } from '../../contracts/evidence.js';

export function makeFixtureListingEvidence(overrides: Partial<NormalizedListingEvidence> = {}): NormalizedListingEvidence {
  return {
    listingId: 'listing-123',
    shopId: 'shop-456',
    title: 'Printable Weekly Planner',
    description: 'A printable PDF planner for busy Etsy buyers.',
    tags: ['planner', 'printable', 'weekly'],
    priceCents: 700,
    currency: 'USD',
    state: 'active',
    url: 'https://www.etsy.com/listing/123/printable-weekly-planner',
    stats: {
      impressions: 1000,
      views: 100,
      favorites: 10,
      orders: 2,
      revenueCents: 1400,
      adImpressions: 200,
      adClicks: 20,
      adSpendCents: 500,
      adRevenueCents: 700,
    },
    observedAt: '2026-08-12T00:00:00.000Z',
    source: 'etsy',
    ...overrides,
  };
}
```

- [ ] **Step 8: Verify contracts**

Run:

```bash
npm test -- src/tests/contracts/contracts.test.ts
npm run typecheck
```

Expected: both commands exit 0.

---

### Task 3: Local File Storage With Tests

**Files:**
- Create: `src/storage/runs.ts`
- Create: `src/tests/storage/runs.test.ts`

**Interfaces:**
- Consumes: `WorkflowRunState`.
- Produces:
  - `RunRepository` interface
  - `JsonFileRunRepository`
  - `JsonFileRunRepositoryOptions`

```typescript
export type RunRepository = {
  create(state: WorkflowRunStateInput): Promise<void>;
  load(runId: string): Promise<WorkflowRunState>;
  save(state: WorkflowRunStateInput): Promise<void>;
};

export type JsonFileRunRepositoryOptions = {
  rootDir: string;
};
```

- [ ] **Step 1: Write failing storage tests**

Create `src/tests/storage/runs.test.ts` with temp-dir tests for:

- create + load round-tripping readable `run.json`;
- save updated state + reload;
- missing run behavior with clear `AppError('storage_failed', ...)`;
- corrupt JSON rejection;
- schema-invalid JSON rejection;
- no temporary-file residue after successful writes;
- run-id path safety.

Expected before implementation: FAIL because `JsonFileRunRepository` does not exist.

- [ ] **Step 2: Implement `JsonFileRunRepository`**

Implementation details:

- Store files under `${rootDir}/${runId}/`.
- `run.json` holds `WorkflowRunState`.
- Always validate loaded JSON with Zod schemas.
- Use atomic-ish writes: write to `${path}.tmp`, then rename.
- Reject run ids that would escape the configured root.

- [ ] **Step 3: Verify storage**

Run:

```bash
npm test -- src/tests/storage/runs.test.ts
npm run typecheck
```

Expected: both commands exit 0.

---

### Task 4: Deterministic Routes, Guards, State Engine

**Files:**
- Create: `src/workflow/routes.ts`
- Create: `src/workflow/guards.ts`
- Create: `src/workflow/state.ts`
- Create: `src/workflow/engine.ts`
- Create: `src/tests/workflow/routes.test.ts`
- Create: `src/tests/workflow/guards.test.ts`
- Create: `src/tests/workflow/engine.test.ts`

**Interfaces:**
- Consumes: contracts and `RunRepository`.
- Produces:

```typescript
export type RouteDecision =
  | { type: 'advance'; nextStage: WorkflowStage }
  | { type: 'research'; requester: Exclude<ModuleId, 'm3'>; returnStage: WorkflowStage; question: string }
  | { type: 'wait'; reason: string }
  | { type: 'stop'; reason: string }
  | { type: 'complete'; reason: string };

export function routeAfterM2Initial(output: MetricsOutput): RouteDecision;
export function routeAfterM4(output: DiagnosisOutput): RouteDecision;
export function routeAfterM5(output: HypothesisOutput): RouteDecision;
export function routeAfterM6(output: TestPlanOutput): RouteDecision;
export function routeAfterM2Results(output: MetricsOutput): RouteDecision;
export function routeAfterM7(output: EvaluationOutput): RouteDecision;

export type WorkflowEngine = {
  start(input: StartWorkflowInput): Promise<WorkflowRunState>;
  step(runId: string): Promise<WorkflowRunState>;
  resumeWithExperimentResults(input: ResumeExperimentInput): Promise<WorkflowRunState>;
};
```

- [ ] **Step 1: Write failing route tests**

Create tests that assert:

- M2 initial with no unresolved needs advances to `m4_diagnosis`.
- M2 initial with `researchNeed` routes to M3 with requester `m2`.
- M2 initial with missing metric inputs waits.
- M4 decision `proceed_to_hypothesis` advances to M5.
- M4 decision `research_domain_knowledge` routes to M3 with requester `m4`.
- M4 decision `collect_more_data` stops or waits.
- M6 with no unresolved measurement rules advances to `experiment_wait`.
- M7 next action `wait` completes cycle with wait reason, not a new automatic run.

Run:

```bash
npm test -- src/tests/workflow/routes.test.ts
```

Expected before implementation: FAIL because route functions do not exist.

- [ ] **Step 2: Implement route functions**

Rules:

- `routeAfterM2Initial`: if `researchNeed` exists, route M3 and return to `m2_metrics_initial`; if `comparisonQuality` is `missing` or every metric is `not_available`, wait; else advance `m4_diagnosis`.
- `routeAfterM4`: map `proceed_to_hypothesis` to `m5_hypothesis`, `research_domain_knowledge` to M3, `collect_more_data` to wait.
- `routeAfterM5`: if `researchNeed`, route M3 returning to `m5_hypothesis`; else advance `m6_test_plan`.
- `routeAfterM6`: if `researchNeed` or unresolved rules exist, route M3 returning to `m6_test_plan`; else wait at `experiment_wait`.
- `routeAfterM2Results`: if `researchNeed`, route M3 returning to `m2_metrics_results`; else advance `m7_learning`.
- `routeAfterM7`: if `nextAction` is `research`, route M3 returning to `m7_learning`; if `wait`, complete current cycle with wait; otherwise complete current cycle.

- [ ] **Step 3: Write failing guard tests**

Guard tests must assert:

- Engine refuses to advance to M4 without M1 and M2 initial outputs.
- Engine refuses to run M5 unless M4 decision is `proceed_to_hypothesis`.
- Engine refuses to enter M2 results unless an experiment plan exists and external result evidence was supplied.
- Engine never accepts raw credentials in state or evidence object keys.

Run:

```bash
npm test -- src/tests/workflow/guards.test.ts
```

Expected before implementation: FAIL because guards do not exist.

- [ ] **Step 4: Implement guards**

Expose:

```typescript
export function assertNoCredentialKeys(value: unknown): void;
export function canRunStage(state: WorkflowRunState, stage: WorkflowStage): boolean;
export function assertCanRunStage(state: WorkflowRunState, stage: WorkflowStage): void;
```

Credential key detection must reject object keys matching `/api[_-]?key|secret|token|refresh/i`.

- [ ] **Step 5: Write failing engine orchestration test**

Use a fake module executor that returns canned outputs. Assert `start()` creates a run, stores initial evidence, emits event `workflow.started`, and `step()` advances exactly one deterministic stage at a time.

Run:

```bash
npm test -- src/tests/workflow/engine.test.ts
```

Expected before implementation: FAIL because `createWorkflowEngine` does not exist.

- [ ] **Step 6: Implement engine shell**

Expose:

```typescript
export type StartWorkflowInput = {
  runId: string;
  listingId: string;
  initialEvidence: NormalizedListingEvidence;
  now?: () => Date;
};

export type ResumeExperimentInput = {
  runId: string;
  resultEvidence: NormalizedListingEvidence;
  now?: () => Date;
};

export type ModuleExecutor = {
  runM1(state: WorkflowRunState): Promise<ContextOutput>;
  runM2Initial(state: WorkflowRunState): Promise<MetricsOutput>;
  runM3(state: WorkflowRunState, request: ResearchRequest): Promise<ResearchOutput>;
  runM4(state: WorkflowRunState): Promise<DiagnosisOutput>;
  runM5(state: WorkflowRunState): Promise<HypothesisOutput>;
  runM6(state: WorkflowRunState): Promise<TestPlanOutput>;
  runM2Results(state: WorkflowRunState): Promise<MetricsOutput>;
  runM7(state: WorkflowRunState): Promise<EvaluationOutput>;
};

export function createWorkflowEngine(deps: {
  repository: RunRepository;
  modules: ModuleExecutor;
  emit?: TraceSink;
  now?: () => Date;
}): WorkflowEngine;
```

- [ ] **Step 7: Verify routing, guards, engine**

Run:

```bash
npm test -- src/tests/workflow/routes.test.ts src/tests/workflow/guards.test.ts src/tests/workflow/engine.test.ts
npm run typecheck
```

Expected: both commands exit 0.

---

### Task 5: Agent Runner Adapter, M0 Policy, And Module Wrapper Tests

**Files:**
- Create: `src/agents/core/policy.ts`
- Create: `src/agents/core/policy.md`
- Create: `src/agents/core/README.md`
- Create: `src/agents/runner.ts`
- Create: `src/tests/agents/runner.test.ts`
- Create: `src/tests/agents/policy.test.ts`

**Interfaces:**
- Consumes: contracts.
- Produces:
  - `M0_POLICY`
  - `buildModuleInstructions(moduleId: ModuleId, modulePrompt: string): string`
  - `AgentRunner`
  - `OpenAiAgentRunner`
  - `FakeAgentRunner<T>`

- [ ] **Step 1: Write failing policy tests**

Assert `M0_POLICY` includes:

- manual-only recommendations,
- evidence provenance,
- no raw credentials,
- citations for web research,
- M3 safety limits.

Run:

```bash
npm test -- src/tests/agents/policy.test.ts
```

Expected before implementation: FAIL.

- [ ] **Step 2: Implement M0 core policy files**

Create `src/agents/core/policy.md` with this policy text:

```text
Recommendations are manual-only; do not automate Etsy listing edits.
Preserve evidence provenance and distinguish observed facts from interpretation.
Never expose raw credentials, OAuth secrets, refresh tokens, or token file contents.
External web research requires citations.
M3 uses only read-only tools and is bounded by configured call, time, and cost/token limits.
```

Create `src/agents/core/policy.ts` with matching runtime constants:

```typescript
export const M3_DEFAULT_LIMITS = {
  maxToolCalls: 3,
  maxWallClockMs: 120_000,
} as const;

export const M0_POLICY = [
  'Recommendations are manual-only; do not automate Etsy listing edits.',
  'Preserve evidence provenance and distinguish observed facts from interpretation.',
  'Never expose raw credentials, OAuth secrets, refresh tokens, or token file contents.',
  'External web research requires citations.',
  'M3 uses only read-only tools and is bounded by configured call, time, and cost/token limits.',
].join('\\n');
```

Create `src/agents/core/README.md` as the M0 module card. It must document purpose, when it applies,
input contract, output contract, dependencies, permitted tools, success/stop/pause/failure
conditions, and links to the workflow design spec and this plan. M0 is shared policy/runtime
configuration for M1-M7, not a workflow turn.

- [ ] **Step 3: Write failing runner tests**

Tests:

- `FakeAgentRunner` validates output against schema before returning.
- Invalid fake output throws `AppError('validation_failed', ...)`.
- `buildModuleInstructions` prepends M0 policy text to the co-located module prompt Markdown passed
  by a wrapper.

- [ ] **Step 4: Implement `agents/runner.ts`**

Define the shared `AgentRunner` interface from this plan. Implement:

```typescript
export class FakeAgentRunner implements AgentRunner {
  constructor(private readonly outputs: Partial<Record<ModuleId, unknown>>) {}

  async runStructured<TOutput>(input: AgentRunInput<TOutput>): Promise<AgentRunResult<TOutput>> {
    const value = this.outputs[input.moduleId];
    return { output: parseWithSchema(input.outputSchema, value, `${input.moduleId} output`) };
  }
}
```

Add `OpenAiAgentRunner` as a thin adapter. It may import `@openai/agents`, but tests must not use real network calls. If the package API differs at implementation time, keep `AgentRunner` stable and adapt inside this class only.

- [ ] **Step 5: Verify runner**

Run:

```bash
npm test -- src/tests/agents/policy.test.ts src/tests/agents/runner.test.ts
npm run typecheck
```

Expected: both commands exit 0.

---

### Task 6: M1, Deterministic M2 Metrics, M4, M5, M6 Initial Lifecycle

**Files:**
- Create: `src/agents/context/agent.ts`
- Create: `src/agents/context/prompt.md`
- Create: `src/agents/context/README.md`
- Create: `src/agents/metrics/agent.ts`
- Create: `src/agents/metrics/prompt.md`
- Create: `src/agents/metrics/README.md`
- Create: `src/agents/diagnosis/agent.ts`
- Create: `src/agents/diagnosis/prompt.md`
- Create: `src/agents/diagnosis/README.md`
- Create: `src/agents/hypothesis/agent.ts`
- Create: `src/agents/hypothesis/prompt.md`
- Create: `src/agents/hypothesis/README.md`
- Create: `src/agents/test-definition/agent.ts`
- Create: `src/agents/test-definition/prompt.md`
- Create: `src/agents/test-definition/README.md`
- Create: `src/tests/agents/context.test.ts`
- Create: `src/tests/agents/metrics.test.ts`
- Create: `src/tests/agents/initial-lifecycle.test.ts`

**Interfaces:**
- Consumes: `AgentRunner`, contracts, workflow state.
- Produces:
  - `runContextModule`
  - `runMetricsModule`
  - `calculateMetricSnapshot`
  - `runDiagnosisModule`
  - `runHypothesisModule`
  - `runTestDefinitionModule`

```typescript
export function calculateMetricSnapshot(evidence: NormalizedListingEvidence): MetricsOutput;
export function runContextModule(runner: AgentRunner, state: WorkflowRunState, trace: TraceContext): Promise<ContextOutput>;
export function runMetricsModule(input: { phase: 'initial' | 'post_experiment'; state: WorkflowRunState; evidence: NormalizedListingEvidence }): MetricsOutput;
export function runDiagnosisModule(runner: AgentRunner, state: WorkflowRunState, trace: TraceContext): Promise<DiagnosisOutput>;
export function runHypothesisModule(runner: AgentRunner, state: WorkflowRunState, trace: TraceContext): Promise<HypothesisOutput>;
export function runTestDefinitionModule(runner: AgentRunner, state: WorkflowRunState, trace: TraceContext): Promise<TestPlanOutput>;
```

- [ ] **Step 1: Write failing deterministic metrics tests**

Use fixture stats:

- conversion rate = `2 / 100 = 0.02`.
- favorite rate = `10 / 100 = 0.1`.
- CTR = `20 / 200 = 0.1`.
- revenue per view = `1400 / 100 = 14` cents.
- average order value = `1400 / 2 = 700` cents.
- ROAS = `700 / 500 = 1.4`.

Assert missing denominators produce `null` and `not_available`.

Run:

```bash
npm test -- src/tests/agents/metrics.test.ts
```

Expected before implementation: FAIL.

- [ ] **Step 2: Implement deterministic M2 calculations**

`calculateMetricSnapshot` returns a `MetricsOutput` with `phase: 'initial'`, metrics listed above, `comparisonQuality: 'limited'`, empty unresolved needs when enough denominators exist, and `confidence: 'moderate'` for calculated metrics.

- [ ] **Step 3: Write failing M1 wrapper test**

Use `FakeAgentRunner` with a valid `ContextOutput`. Assert `runContextModule` passes module id `m1`, validates output, and never receives raw credential keys in input.

- [ ] **Step 4: Implement M1 folder**

Create `src/agents/context/prompt.md`:

```text
M1 Context: organize product context, available evidence, missing information, and notes. Do not diagnose or recommend changes.
```

Implement `src/agents/context/agent.ts` so it builds instructions from `M0_POLICY` plus the
co-located prompt Markdown and calls `AgentRunner.runStructured` with `ContextOutputSchema`.

Create `src/agents/context/README.md` as the M1 module card. It must document purpose, when it
runs, input contract, output contract, dependencies, permitted tools, success/stop/pause/failure
conditions, and links to the workflow design spec and this plan. Reference `src/contracts/` rather
than duplicating schemas.

- [ ] **Step 5: Write failing initial lifecycle test**

Use `createWorkflowEngine` and a `ModuleExecutor` built from M1/M2/M4/M5/M6 wrappers plus fakes. Assert route:

```text
m1_context -> m2_metrics_initial -> m4_diagnosis -> m5_hypothesis -> m6_test_plan -> experiment_wait
```

Expected final state:

```typescript
{
  status: 'ready_for_experiment',
  stage: 'experiment_wait'
}
```

- [ ] **Step 6: Implement M2/M4/M5/M6 folders**

For each folder, create a concise `prompt.md`, an `agent.ts`, and a module-card `README.md`.
Each wrapper uses `AgentRunner.runStructured` with its exact output schema and prompt boundary:

- M2: keep deterministic calculations in `src/agents/metrics/agent.ts`; use the prompt only for
  explanation/qualification that needs model judgment.
- M4: diagnose one bottleneck and choose `proceed_to_hypothesis`, `research_domain_knowledge`, or `collect_more_data`.
- M5: create one hypothesis, one intervention, and one expected signal.
- M6: create a measurement plan; do not evaluate outcome.

Every module README must document purpose, when it runs, input contract, output contract,
dependencies, permitted tools, success/stop/pause/failure conditions, and related-doc links. Shared
contract definitions remain in `src/contracts/`; do not duplicate them in module READMEs.

- [ ] **Step 7: Verify initial lifecycle**

Run:

```bash
npm test -- src/tests/agents/context.test.ts src/tests/agents/metrics.test.ts src/tests/agents/initial-lifecycle.test.ts
npm run typecheck
```

Expected: both commands exit 0.

---

### Task 7: M3 Bounded Research And Tool Policy

**Files:**
- Create: `src/agents/research/agent.ts`
- Create: `src/agents/research/prompt.md`
- Create: `src/agents/research/README.md`
- Create: `src/tests/agents/research.test.ts`

**Interfaces:**
- Consumes: M0 limits, `ResearchOutput`, citations.
- Produces:

```typescript
export type ResearchTool = {
  name: ResearchToolName;
  call(input: Record<string, unknown>): Promise<ResearchToolResult>;
};

export type ResearchToolResult = {
  citations: Array<{
    source: 'etsy' | 'web' | 'derived';
    title: string;
    url?: string;
    excerpt: string;
    fetchedAt: string;
  }>;
  data: unknown;
};

export type ResearchRequest = {
  requester: Exclude<ModuleId, 'm3'>;
  question: string;
  reason: string;
};

export type ResearchLimits = {
  maxToolCalls: number;
  maxWallClockMs: number;
  maxEstimatedCostUsd?: number;
  maxTokens?: number;
};

export async function runResearchModule(input: {
  runner: AgentRunner;
  tools: readonly ResearchTool[];
  request: ResearchRequest;
  limits?: Partial<ResearchLimits>;
  now?: () => number;
  trace: TraceContext;
}): Promise<ResearchOutput>;
```

- [ ] **Step 1: Write failing M3 tests**

Tests:

- A fake runner returns `next_action: 'continue'` with `requestedLookup` twice, then `stop`; tool call count is 2 and final output is returned.
- If fake runner keeps returning `continue`, engine forces stop after 3 tool calls.
- If `now()` crosses 120000 ms, engine forces stop.
- Any web citation missing `url` fails validation.
- A tool name outside the four permitted names is rejected before use.
- `status: 'blocked'` fails validation; `status: 'unresolved'` passes.

Run:

```bash
npm test -- src/tests/agents/research.test.ts
```

Expected before implementation: FAIL.

- [ ] **Step 2: Implement M3 loop**

Create `src/agents/research/prompt.md` with the M3 research boundary: answer only the bounded
research request, use permitted read-only tools only, include citations for web evidence, return
canonical `status`, return `next_action`, and do not choose lifecycle routing.

Algorithm:

1. Set limits to `{ maxToolCalls: 3, maxWallClockMs: 120000 }` plus configured cost/token fields.
2. Reject any tool whose `name` is not in the permitted set.
3. Call `AgentRunner.runStructured` with `ResearchOutputSchema`.
4. If output `next_action` is `stop`, return output.
5. If output `next_action` is `continue`, require `requestedLookup.tool`, `requestedLookup.reason`, and `requestedLookup.input`.
6. Call exactly the requested permitted tool and append citations from the tool result to the next agent input.
7. Stop when tool calls, wall-clock time, token budget, or cost budget reaches the configured limit.
8. When limits force stop, return the latest validated `ResearchOutput` with `next_action: 'stop'`.

Create `src/agents/research/README.md` as the M3 module card. It must document purpose, when it
runs, input contract, output contract, dependencies, permitted tools, success/stop/pause/failure
conditions, and links to the workflow design spec and this plan. Reference `src/contracts/` rather
than duplicating schemas.

- [ ] **Step 3: Verify M3**

Run:

```bash
npm test -- src/tests/agents/research.test.ts
npm run typecheck
```

Expected: both commands exit 0.

---

### Task 8: M2 Results And M7 Post-Experiment Lifecycle

**Files:**
- Modify: `src/agents/metrics/agent.ts`
- Modify: `src/agents/metrics/README.md`
- Create: `src/agents/evaluation/agent.ts`
- Create: `src/agents/evaluation/prompt.md`
- Create: `src/agents/evaluation/README.md`
- Create: `src/tests/agents/post-experiment.test.ts`

**Interfaces:**
- Consumes: M2 metrics, M5 hypothesis, M6 plan, M7 schema.
- Produces:
  - `runEvaluationModule`
  - post-experiment `runMetricsModule` support.

- [ ] **Step 1: Write failing post-experiment test**

Set up a completed experiment:

- Baseline conversion rate: `0.02`.
- Result conversion rate: `0.04`.
- M6 primary metric: `conversion_rate`.
- Fake M7 returns `outcome: 'win'`, `hypothesisEvaluation: 'supported'`, `nextAction: 'keep'`.

Assert route:

```text
experiment_wait -> m2_metrics_results -> m7_learning -> cycle_complete
```

Expected final state:

```typescript
{
  status: 'cycle_complete',
  stage: 'cycle_complete',
  moduleOutputs: {
    m7: {
      outcome: 'win',
      nextAction: 'keep'
    }
  }
}
```

- [ ] **Step 2: Extend M2 for post-experiment**

`runMetricsModule({ phase: 'post_experiment', ... })` reuses the frozen baseline from M6 and computes the result metric from new evidence. It must not pick a new baseline after seeing the result.

- [ ] **Step 3: Implement M7 wrapper**

Create `src/agents/evaluation/prompt.md` with this prompt boundary:

```text
M7 Evaluation: consume frozen test plan and qualified result metrics; classify win/loss/inconclusive, evaluate hypothesis, capture learning, and choose one next action. Do not start a new cycle.
```

Implement `src/agents/evaluation/agent.ts` with `EvaluationOutputSchema` and the co-located prompt.
Create `src/agents/evaluation/README.md` as the M7 module card documenting purpose, when it runs,
input contract, output contract, dependencies, permitted tools, success/stop/pause/failure
conditions, and links to the workflow design spec and this plan. Reference shared contracts instead
of duplicating schema definitions.

- [ ] **Step 4: Verify post-experiment lifecycle**

Run:

```bash
npm test -- src/tests/agents/post-experiment.test.ts
npm run typecheck
```

Expected: both commands exit 0.

---

### Task 9: Tracing And Structured Workflow Events

**Files:**
- Create: `src/tracing/events.ts`
- Create: `src/tests/tracing/events.test.ts`
- Modify: `src/workflow/engine.ts`

**Interfaces:**
- Consumes: `WorkflowEvent`.
- Produces:

```typescript
export type TraceContext = {
  runId: string;
  stage?: WorkflowStage;
  parentTraceId?: string;
};

export type TraceSink = {
  emit(event: WorkflowEvent): Promise<void> | void;
};

export function createWorkflowEvent(input: {
  runId: string;
  type: string;
  stage?: WorkflowStage;
  message: string;
  data?: Record<string, unknown>;
  now?: () => Date;
}): WorkflowEvent;
```

- [ ] **Step 1: Write failing tracing tests**

Assert:

- `createWorkflowEvent` produces ISO timestamp and stable type/message.
- Engine emits `workflow.started`, `module.started`, `module.completed`, `route.decided`, and `workflow.waiting` events during initial lifecycle.
- Event data never includes raw credential key names.

- [ ] **Step 2: Implement event helpers and engine emits**

Use `crypto.randomUUID()` for `eventId`. Call `assertNoCredentialKeys` before emitting.

- [ ] **Step 3: Verify tracing**

Run:

```bash
npm test -- src/tests/tracing/events.test.ts src/tests/workflow/engine.test.ts
npm run typecheck
```

Expected: both commands exit 0.

---

### Task 10: Etsy Connector Configuration, OAuth Boundary, And Read-Only Mapping

**Files:**
- Create: `src/core/config.ts`
- Create: `src/connectors/etsy/auth.ts`
- Create: `src/connectors/etsy/client.ts`
- Create: `src/connectors/etsy/mapper.ts`
- Create: `src/connectors/etsy/repository.ts`
- Create: `src/connectors/etsy/validate.ts`
- Create: `src/tests/connectors/etsy-config.test.ts`
- Create: `src/tests/connectors/etsy-mapper.test.ts`
- Create: `src/tests/connectors/etsy-client.test.ts`

**Interfaces:**
- Consumes: Etsy config boundary spec.
- Produces:

```typescript
export function loadEtsyConnectorConfig(env: NodeJS.ProcessEnv): EtsyConnectorConfig;

export type EtsyHttpClient = {
  getJson<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T>;
};

export class EtsyOpenApiClient implements EtsyHttpClient {
  constructor(input: { config: EtsyConnectorConfig; tokenProvider: EtsyTokenProvider; fetchImpl?: typeof fetch });
  getJson<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T>;
}

export type EtsyEvidenceRepository = {
  getListingEvidence(listingId: string): Promise<NormalizedListingEvidence>;
  getListingTransactions(listingId: string): Promise<unknown[]>;
};

export async function validateEtsyConnection(input: {
  env: NodeJS.ProcessEnv;
  listingId: string;
  fetchImpl?: typeof fetch;
  tokenProvider?: EtsyTokenProvider;
}): Promise<{ ok: true; listingId: string; title: string }>;
```

- [ ] **Step 1: Write failing config tests**

Assert:

- `loadEtsyConnectorConfig` accepts env object with `ETSY_API_KEY`, `ETSY_OAUTH_CLIENT_ID`, `ETSY_OAUTH_REDIRECT_URI`, `ETSY_OAUTH_SCOPES`, `ETSY_TOKEN_STORAGE_PATH`.
- It returns sanitized config without `ETSY_API_SECRET`.
- Missing required values throw `configuration_failed`.
- Workflow engine tests never import `loadEtsyConnectorConfig`.

- [ ] **Step 2: Implement config boundary**

`loadEtsyConnectorConfig(env)` reads only the env object passed to it. It does not mutate process state. It must not export API secrets to workflow modules.

- [ ] **Step 3: Write failing mapper tests**

Use fake Etsy Open API response:

```typescript
{
  listing_id: 123,
  user_id: 456,
  title: 'Printable Weekly Planner',
  description: 'A printable PDF planner',
  tags: ['planner'],
  price: { amount: 700, divisor: 100, currency_code: 'USD' },
  state: 'active',
  url: 'https://www.etsy.com/listing/123/printable-weekly-planner'
}
```

Assert mapped evidence uses `listingId: '123'`, `shopId: '456'`, `priceCents: 700`, `currency: 'USD'`, `source: 'etsy'`, and rejects credential-like fields.

- [ ] **Step 4: Implement mapper**

Expose:

```typescript
export function mapEtsyListingToEvidence(input: unknown, observedAt: string): NormalizedListingEvidence;
```

- [ ] **Step 5: Write failing client tests**

Use a fake `fetchImpl` and fake `EtsyTokenProvider`. Assert:

- GET requests include `Authorization: Bearer test-token`.
- GET requests include `x-api-key`.
- No POST/PATCH/PUT/DELETE methods exist on `EtsyOpenApiClient`.
- Non-2xx response throws `connector_failed`.

- [ ] **Step 6: Implement read-only client and repository**

`EtsyOpenApiClient.getJson` builds URLs under `https://openapi.etsy.com/v3/application`. `EtsyEvidenceRepository` exposes read-only methods only.

- [ ] **Step 7: Implement validation module and script**

Create `src/connectors/etsy/validate.ts`. It must:

1. Call `loadEtsyConnectorConfig(input.env)`.
2. Use the supplied `tokenProvider` in tests, or the real OAuth token provider when supplied by later local wiring.
3. Fetch one listing through `EtsyOpenApiClient`.
4. Map it through `mapEtsyListingToEvidence`.
5. Return `{ ok: true, listingId, title }`.
6. Never print or return credential values.

Add script to `package.json`:

```json
{
  "scripts": {
    "etsy:validate": "node dist/connectors/etsy/validate.js"
  }
}
```

The script is for a later local real-credential check after build. Mocked tests call `validateEtsyConnection` directly and do not require `.env`.

- [ ] **Step 8: Verify connector with mocks**

Run:

```bash
npm test -- src/tests/connectors/etsy-config.test.ts src/tests/connectors/etsy-mapper.test.ts src/tests/connectors/etsy-client.test.ts
npm run typecheck
```

Expected: both commands exit 0 without real credentials.

- [ ] **Step 9: Run local validation only after real credentials are configured**

After real credentials exist, run a local validation command:

```bash
npm run etsy:validate
```

Expected with real credentials and a configured listing id: command exits 0 and prints only listing id/title validation output. Expected without real credentials: command exits non-zero with `configuration_failed` and prints no credential values. This later command is skipped during mocked development.

---

### Task 11: Full Mocked End-To-End Lifecycle Test

**Files:**
- Create: `src/tests/workflow/end-to-end.test.ts`
- Modify: `src/workflow/engine.ts`
- Modify: `src/agents/<role>/agent.ts`, `prompt.md`, or `README.md` only as needed to satisfy the test.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: one representative complete run using only fakes.

- [ ] **Step 1: Write failing end-to-end test**

Set up:

- `JsonFileRunRepository` with temp dir.
- Fixture initial evidence.
- Fake agent outputs for M1, M4, M5, M6, M7.
- Deterministic M2 initial and M2 results.
- M3 fake is available but not used for the happy path.

Assert:

```text
start -> M1 -> M2 initial -> M4 -> M5 -> M6 -> wait for manual experiment -> resume -> M2 results -> M7 -> cycle complete
```

Assert persisted artifacts:

- `run.json` exists.
- `evidence/initial.json` exists.
- `evidence/result.json` exists.
- `experiment-plan.json` exists.
- `events.jsonl` contains at least 8 events.
- No event or persisted workflow state contains credential-like keys.

- [ ] **Step 2: Implement any missing engine transitions**

Keep changes deterministic. Do not add terminal-chat behavior. Do not add real network calls.

- [ ] **Step 3: Verify end-to-end**

Run:

```bash
npm test -- src/tests/workflow/end-to-end.test.ts
npm test
npm run typecheck
npm run build
```

Expected: all commands exit 0.

---

### Task 12: Terminal-Chat Adapter Deferral And Acceptance Gate

**Files:**
- Create: `src/tests/workflow/ui-deferral.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: engine public API.
- Produces: documented UI deferral gate only.

- [ ] **Step 1: Write failing deferral test**

Create `src/tests/workflow/ui-deferral.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createWorkflowEngine } from '../../workflow/engine.js';

describe('terminal-chat adapter deferral', () => {
  it('exposes engine methods without importing a chat adapter', () => {
    expect(typeof createWorkflowEngine).toBe('function');
  });
});
```

Do not create `src/chat/` in this task.

- [ ] **Step 2: Update README acceptance wording**

Add one short bullet under the README architecture section:

```markdown
- Terminal chat starts only after a mocked end-to-end lifecycle proves engine inputs, waits, resume behavior, outputs, traces, and persisted evidence.
```

- [ ] **Step 3: Verify no chat adapter exists**

Run:

```bash
test ! -d src/chat
npm test -- src/tests/workflow/ui-deferral.test.ts
npm run typecheck
```

Expected: `test ! -d src/chat` exits 0; tests and typecheck exit 0.

---

## Implementation Order And Review Gates

Execute tasks in order. After each task:

- Run the task-specific verification commands.
- Run `git diff --check`.
- Inspect `git diff --stat`.
- Confirm no `.env`, token file, or credential value appears in tracked diffs.
- Do not commit unless the user explicitly changes the no-commit instruction for implementation.

Recommended checkpoints:

1. After Task 4, review deterministic workflow routing before adding Agents SDK wrappers.
2. After Task 7, review M3 limits and research contracts before any real hosted web search call.
3. After Task 10, review credential boundary before OAuth validation with real credentials.
4. After Task 11, review the mocked end-to-end run trace before building terminal chat.

---

## Self-Review

Spec coverage:

- Deterministic orchestrator and state machine: Tasks 4, 8, and 11.
- Bounded agentic workers M1-M7: Tasks 5, 6, 7, and 8.
- M0 shared policy: Task 5.
- M3 read-only tools, citations, `status`, `next_action`, 3-call and 2-minute limits: Task 7.
- Credentials isolated from workflow engine: Tasks 4 and 10.
- Etsy read-only connector and normalized evidence mapping: Task 10.
- Local-file persistence: Task 3.
- Structured run events and tracing: Task 9.
- Full mocked lifecycle: Task 11.
- Terminal-chat adapter deferred with acceptance condition: Task 12.
- Real credentials boundary: Real credentials are needed only for the later OAuth validation command and real API-backed M3/Etsy runs; mocked development is not blocked.

Placeholder scan:

- There are no unresolved markers, empty sections, or open implementation choices.
- The only intentional future choice is the per-run cost/token budget, which must be configured before a real API-backed run.

Type consistency:

- `ResearchOutput.status` uses `resolved | partly_resolved | unresolved` everywhere in this plan.
- `ResearchOutput.next_action` uses `continue | stop` everywhere in this plan.
- `WorkflowStage`, `WorkflowStatus`, `ModuleId`, `AgentRunner`, `RunRepository`, `ResearchTool`, and `TraceSink` names are defined once and reused consistently.
- M2 is reused for `initial` and `post_experiment` phases as required.

Scope check:

- The plan implements the workflow engine, contracts, local storage, bounded module wrappers, mocked connector, tracing, and mocked end-to-end lifecycle.
- The plan does not implement seller onboarding, billing, voice UX, hosted product shell, web app, automated Etsy writes, or terminal-chat behavior before the acceptance gate.
