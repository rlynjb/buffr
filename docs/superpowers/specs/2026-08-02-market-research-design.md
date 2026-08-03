# Market Research Chat Command Design

**Date:** 2026-08-02
**Status:** Approved

---

## Goal

Add a `/research <topic>` slash command to the buffr chat UI. It discovers and ranks the top problems people face in a given niche, surfaced as opportunities for Etsy digital products or Shopify apps. This is a daily-use research tool — same routine as `/investing <TICKER>`, but for market intelligence instead of financial analysis.

---

## Architecture

Four new packages/files; nothing else in the monorepo is touched.

```
packages/domain-packs/market-research/   — dimensions, scorecard, prompts, eval fixtures
packages/engines/market-research/        — MarketResearchEngine
src/session.ts                           — research() + evalResearch() on ChatSession
src/cli/chat.tsx                         — /research and /eval research handlers
```

### Dependency graph

```
@buffr/contracts
      ↓
@buffr/kernel   @buffr/capabilities   @buffr/domain-pack-market-research   @buffr/connectors
      ↓                 ↓                          ↓                              ↓
                 @buffr/engine-market-research
```

Both new packages are leaf nodes. Nothing upstream changes.

### Workspace

`packages/engines/*` is already in the root workspace glob. `packages/domain-packs/*` is already included. No root `package.json` changes needed.

### Package locations

```
packages/domain-packs/market-research/    published as @buffr/domain-pack-market-research
packages/engines/market-research/         published as @buffr/engine-market-research
```

---

## Domain Pack — `@buffr/domain-pack-market-research`

### Package structure

```
packages/domain-packs/market-research/
├── src/
│   ├── dimensions.ts
│   ├── scorecards.ts
│   ├── prompts.ts
│   ├── pack.ts
│   └── index.ts
├── eval/
│   └── fixtures.json
├── test/
│   └── scorecard.test.ts
├── package.json
└── tsconfig.json
```

`tsconfig.json` extends `"../../../tsconfig.base.json"` (3 levels up, same as `domain-pack-investing`).

### `src/dimensions.ts`

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

### `src/scorecards.ts`

```typescript
import type { ScorecardDefinition } from '@buffr/contracts';

export const MARKET_RESEARCH_SCORECARD: ScorecardDefinition = {
  id: 'market-research-v1',
  version: '1.0.0',
  metrics: [
    { id: 'frequency',       label: 'Frequency',       weight: 0.30, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'trend-velocity',  label: 'Trend Velocity',  weight: 0.25, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'specificity',     label: 'Specificity',     weight: 0.20, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'monetizability',  label: 'Monetizability',  weight: 0.25, direction: 'higher-is-better', min: 0, max: 100 },
  ],
  minimumEvidenceCount: 4,
  confidencePenalty: 0.8,
};
```

### `src/prompts.ts`

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

### `src/pack.ts`

```typescript
import type { DomainPackManifest } from '@buffr/contracts';
import { MARKET_RESEARCH_DIMENSIONS } from './dimensions.js';
import { MARKET_RESEARCH_SCORECARD } from './scorecards.js';

export const MARKET_RESEARCH_PACK: DomainPackManifest = {
  id: 'market-research',
  version: '1.0.0',
  label: 'Market Research',
  dimensions: MARKET_RESEARCH_DIMENSIONS,
  scorecards: [MARKET_RESEARCH_SCORECARD],
};
```

### `src/index.ts`

```typescript
export * from './dimensions.js';
export * from './scorecards.js';
export * from './prompts.js';
export * from './pack.js';
```

### `eval/fixtures.json`

Three fixtures covering the main scoring scenarios. `expectedTotalScore` is computed from the formula: `sum(dimensionScore * weight)` for all present dimensions (all `higher-is-better`, no inversion). The confidence penalty applies when `evidenceCount < minimumEvidenceCount (4)`.

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
    "expectedWarningsContain": ["declining", "peaked"]
  }
]
```

Score verification:
- Fixture 1: `88×0.30 + 82×0.25 + 78×0.20 + 75×0.25 = 26.40 + 20.50 + 15.60 + 18.75 = 81.25`
- Fixture 2: `80×0.30 + 60×0.25 + 28×0.20 + 35×0.25 = 24.00 + 15.00 + 5.60 + 8.75 = 53.35`
- Fixture 3: `65×0.30 + 22×0.25 + 70×0.20 + 60×0.25 = 19.50 + 5.50 + 14.00 + 15.00 = 54.00`

---

## Engine — `@buffr/engine-market-research`

### Package structure

```
packages/engines/market-research/
├── src/
│   ├── types.ts
│   ├── engine.ts
│   └── index.ts
├── test/
│   └── engine.test.ts
├── package.json
└── tsconfig.json
```

`tsconfig.json` extends `"../../../tsconfig.base.json"` (3 levels up).

### `src/types.ts`

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

`keyProblems` maps from the Teacher's `keyLessons` — each is a one-line problem headline.
`productAngles` maps from the Teacher's `actionableNext` — parallel array, one angle per problem.

### `src/engine.ts`

```typescript
import { Collector, Analyzer, Scorer, Teacher } from '@buffr/capabilities';
import type { Engine, AgentContext, AgentResult } from '@buffr/contracts';
import type { ConversationMemory } from '@buffr/kernel';
import { MARKET_RESEARCH_DIMENSIONS, MARKET_RESEARCH_SCORECARD, MARKET_RESEARCH_PROMPTS } from '@buffr/domain-pack-market-research';
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

No `Journal` capability — market research does not log decisions.

---

## `src/session.ts` changes

### New imports

```typescript
import { MarketResearchEngine } from '@buffr/engine-market-research';
import type { MarketResearchSource, MarketResearchOutput } from '@buffr/engine-market-research';
import { MARKET_RESEARCH_SCORECARD } from '@buffr/domain-pack-market-research';
```

### Updated `ChatSession` type

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

### Inside `createChatSession()`

Wire research sources (alongside existing investing sources):

```typescript
const researchSources: MarketResearchSource[] = [
  {
    connector: new CachedConnector(new GoogleTrendsConnector(), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS),
    paramsFor: (topic) => ({ keywords: [topic], timeframe: 'now 7-d' }),
    optional: true,
  },
  ...(cfg.braveApiKey ? [{
    connector: new CachedConnector(new BraveSearchConnector(cfg.braveApiKey), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS),
    paramsFor: (topic: string) => ({
      query: `${topic} problems complaints frustrations reddit forum`,
      count: 5,
    }),
    optional: true,
  }] : []),
  ...(cfg.tavilyApiKey ? [{
    connector: new CachedConnector(new TavilySearchConnector(cfg.tavilyApiKey), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS),
    paramsFor: (topic: string) => ({
      query: `${topic} issues pain points problems complaints`,
      maxResults: 5,
    }),
    optional: true,
  }] : []),
];
const researchEngine = new MarketResearchEngine({ model, sources: researchSources, memory });
```

`GoogleTrendsConnector` requires no API key — it always wires in. `AmazonReviewsConnector` is excluded here because it requires a known ASIN, not a topic string.

### `research()` method

```typescript
async research(topic: string, opts?: AskOptions): Promise<string> {
  currentOnStatus = opts?.onStatus;
  currentOnTokens = opts?.onTokens;
  currentInputTokens = 0;
  currentOutputTokens = 0;
  const startMs = Date.now();
  const agentCtx: AgentContext = {
    userId: cfg.appId,
    workspaceId: cfg.appId,
    traceId: `research-${topic}-${Date.now()}`,
    domain: 'market-research',
    now: new Date().toISOString(),
    permissions: [],
  };
  const result = await researchEngine.run(
    { topic, conversationId },
    agentCtx,
  );
  currentOnStatus = undefined;
  currentOnTokens = undefined;
  opts?.onComplete?.({
    durationMs: Date.now() - startMs,
    inputTokens: currentInputTokens,
    outputTokens: currentOutputTokens,
  });
  return formatResearch(result.data);
}
```

### `evalResearch()` method

```typescript
async evalResearch(): Promise<string> {
  const scorer = new Scorer();
  const evalCtx: AgentContext = {
    userId: 'eval', workspaceId: 'eval', traceId: 'eval-research',
    domain: 'market-research', now: new Date().toISOString(), permissions: [],
  };
  const fixtures = JSON.parse(await readFile(
    new URL('../../packages/domain-packs/market-research/eval/fixtures.json', import.meta.url),
    'utf8',
  ));
  return formatResearchEval(scorer, evalCtx, fixtures);
}
```

### `formatResearch()` — pure module-level function

```typescript
function formatResearch(output: MarketResearchOutput): string {
  const { summary } = output;
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

  if (summary.warnings.length > 0) {
    lines.push('');
    summary.warnings.forEach(w => lines.push(`⚠ ${w}`));
  }

  const sourceIds = [...new Set(output.detail.evidence.map(e => e.sourceType))];
  lines.push('');
  lines.push(`Sources: ${output.detail.evidence.length} signals collected (${sourceIds.join(' · ')})`);

  return lines.join('\n');
}
```

### `formatResearchEval()` — async module-level function

Same shape as `formatEval` for investing:

```typescript
async function formatResearchEval(
  scorer: Scorer,
  ctx: AgentContext,
  fixtures: EvalFixture[],
): Promise<string> {
  const lines: string[] = [`Market research eval — ${fixtures.length} fixtures`, ''];
  let passed = 0;

  for (const fixture of fixtures) {
    const result = await scorer.execute(
      { findings: fixture.findings, scorecard: MARKET_RESEARCH_SCORECARD, evidenceCount: fixture.evidenceCount },
      ctx,
    );
    const actual = result.data.totalScore;
    const delta = Math.abs(actual - fixture.expectedTotalScore);
    const ok = delta <= 0.01;
    if (ok) passed++;
    const mark = ok ? '✔' : '✘';
    const desc = fixture.description.padEnd(45);
    lines.push(
      `  ${mark}  ${desc} expected ${fixture.expectedTotalScore.toFixed(2)}  got ${actual.toFixed(2)}  Δ ${delta.toFixed(2)}`,
    );
  }

  lines.push('');
  lines.push(`${passed}/${fixtures.length} passed`);
  return lines.join('\n');
}
```

---

## `src/cli/chat.tsx` changes

### Import

Add to existing session imports:
```typescript
// (no new import needed — research() and evalResearch() come from ChatSession)
```

### `/research` handler — in `handleSubmit` before `session.ask()`

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
```

### `/eval` split — replace the existing bare `/eval` handler

```typescript
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

---

## Output example

```
Topic: shopify returns management  ·  Score: 74.2/100  ·  Confidence: 81%

Shopify merchants consistently struggle with manual return workflows. The strongest signal
is around label creation — a task merchants report consuming 20+ minutes per return.
Return reason visibility is also a gap: sellers can't see patterns across orders.

Top problems:
• Return label creation is manual and error-prone
  → Shopify app: automated return label generator with carrier API integration
• No visibility into return reasons across orders
  → Shopify app: return analytics dashboard with trend view
• Customers expect instant refund confirmation but get none
  → Shopify app: automated refund status emails triggered by workflow events

Sources: 11 signals collected (search-trends · web-search)
```

---

## Tests

### Domain pack — `test/scorecard.test.ts`

Using `node:test` + `node:assert/strict`.

Three tests — one per fixture in `eval/fixtures.json`:
- Instantiate `Scorer`, run `scorer.execute({ findings, scorecard: MARKET_RESEARCH_SCORECARD, evidenceCount })` per fixture
- Assert `|result.data.totalScore - fixture.expectedTotalScore| ≤ 0.01`

No model calls. Pure scorer accuracy.

### Engine — `test/engine.test.ts`

Two test cases with a stub `ModelProvider` and stub connector (same pattern as `@buffr/engine-investing`):

**1. Topic happy path** — stub connector returns 3 evidence items, stub model returns 4 findings (one per dimension) and a teacher explanation. Assert:
- `result.data.summary.totalScore > 0`
- `result.data.summary.keyProblems.length > 0`
- `result.data.detail.findings.length === 4`

**2. Memory write** — `conversationId: 'conv-1'`, stub `ConversationMemory` with captured `remember` call. Assert:
- `remember` called exactly once with `conversationId: 'conv-1'`
- `answer` is a non-empty string

### App-level — `test/commands.test.ts` (existing file, add 1 test)

Add one test: `/eval research` path — `evalResearch()` runs all 3 fixtures through the real `Scorer` and all pass within ±0.01.

---

## Global constraints

- No new npm dependencies.
- Only `src/session.ts` and `src/cli/chat.tsx` are modified in the app; no upstream packages touched.
- `MarketResearchEngine` constructed once per session (not per request).
- `AmazonReviewsConnector` is not used — it requires a known ASIN, not a topic string.
- `GoogleTrendsConnector` always wires in (no API key required).
- The bare `/eval` command now returns a usage hint; `/eval investing` and `/eval research` are the functional commands.
- `formatResearch` and `formatResearchEval` are pure functions (no side effects).
- No ANSI color codes in any output string — TUI renders plain text.
- `packages/engines/market-research/tsconfig.json` extends `"../../../tsconfig.base.json"`.
- `packages/domain-packs/market-research/tsconfig.json` extends `"../../../tsconfig.base.json"`.

---

## Exit criteria

- `/research shopify returns management` in chat runs the engine, displays a formatted problem list as a `buffr` turn.
- `/eval research` in chat runs all 3 fixtures through the Scorer and displays `3/3 passed`.
- `/eval investing` still works (renamed from `/eval`).
- `/eval` alone returns `Usage: /eval investing | /eval research`.
- Both `/research` and `/eval research` show the spinner while running.
- Engine tests pass with stub model and connector.
- No upstream packages modified.
