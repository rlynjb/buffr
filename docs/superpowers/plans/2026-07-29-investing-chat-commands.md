# Investing Chat Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/investing <TICKER>` and `/eval` slash commands to the buffr chat that run `InvestingEngine` and the Scorer eval harness respectively.

**Architecture:** Approach A — `chat.tsx` intercepts `/investing` and `/eval` before `session.ask()`, calls new `analyze()` and `evalInvesting()` methods on `ChatSession`, and renders the returned string as a `buffr` turn. All logic lives in `session.ts`; `chat.tsx` only handles routing and display.

**Tech Stack:** TypeScript ESM, `node:test`, `@buffr/capabilities` (Scorer), `@buffr/engine-investing` (InvestingEngine), `@buffr/domain-pack-investing` (scorecards + fixtures), `@opentui/react` (chat TUI).

## Global Constraints

- No new npm dependencies.
- Only `src/session.ts` and `src/cli/chat.tsx` are modified; no upstream packages touched.
- All local imports use `.js` extension.
- `InvestingEngine` is constructed once per session (not per request) inside `createChatSession()`.
- `evalInvesting()` does not write to memory or journal.
- `formatAnalysis` and `formatEval` are pure module-level functions (no side effects, not inside the closure).
- Tests go in `test/` (repo root), compiled to `dist/test/`, picked up by `node --test dist/test/*.test.js`.

---

### Task 1: `detectEntityType` + `evalInvesting` + tests

**Files:**
- Modify: `src/session.ts`
- Create: `test/commands.test.ts`

**Interfaces:**
- Produces:
  - `export function detectEntityType(ticker: string): 'company' | 'etf'` — exported from `src/session.ts`
  - `ChatSession.evalInvesting(): Promise<string>` — added to the `ChatSession` type and return object

---

- [ ] **Step 1: Write the failing tests**

Create `test/commands.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Scorer } from '@buffr/capabilities';
import { COMPANY_SCORECARD, ETF_SCORECARD } from '@buffr/domain-pack-investing';
import type { AgentContext } from '@buffr/contracts';
import { detectEntityType } from '../src/session.js';

const evalCtx: AgentContext = {
  userId: 'eval', workspaceId: 'eval', traceId: 'eval',
  domain: 'investing', now: '2026-07-29T00:00:00.000Z', permissions: [],
};

describe('detectEntityType', () => {
  it('returns etf for known ETF tickers', () => {
    assert.strictEqual(detectEntityType('VTI'), 'etf');
    assert.strictEqual(detectEntityType('SPY'), 'etf');
    assert.strictEqual(detectEntityType('QQQ'), 'etf');
  });

  it('returns company for non-ETF tickers', () => {
    assert.strictEqual(detectEntityType('AAPL'), 'company');
    assert.strictEqual(detectEntityType('MSFT'), 'company');
    assert.strictEqual(detectEntityType('NVDA'), 'company');
  });
});

describe('eval:investing scorer accuracy', () => {
  it('company fixtures score within ±0.01 of expected', async () => {
    const scorer = new Scorer();
    const fixtures: Array<{
      description: string;
      findings: Parameters<Scorer['execute']>[0]['findings'];
      evidenceCount: number;
      expectedTotalScore: number;
    }> = JSON.parse(
      await readFile(
        new URL('../../packages/domain-packs/investing/eval/company-fixtures.json', import.meta.url),
        'utf8',
      ),
    );
    for (const fixture of fixtures) {
      const result = await scorer.execute(
        { findings: fixture.findings, scorecard: COMPANY_SCORECARD, evidenceCount: fixture.evidenceCount },
        evalCtx,
      );
      const delta = Math.abs(result.data.totalScore - fixture.expectedTotalScore);
      assert.ok(
        delta <= 0.01,
        `"${fixture.description}": expected ${fixture.expectedTotalScore}, got ${result.data.totalScore.toFixed(4)}, Δ ${delta.toFixed(4)}`,
      );
    }
  });

  it('ETF fixtures score within ±0.01 of expected', async () => {
    const scorer = new Scorer();
    const fixtures: Array<{
      description: string;
      findings: Parameters<Scorer['execute']>[0]['findings'];
      evidenceCount: number;
      expectedTotalScore: number;
    }> = JSON.parse(
      await readFile(
        new URL('../../packages/domain-packs/investing/eval/etf-fixtures.json', import.meta.url),
        'utf8',
      ),
    );
    for (const fixture of fixtures) {
      const result = await scorer.execute(
        { findings: fixture.findings, scorecard: ETF_SCORECARD, evidenceCount: fixture.evidenceCount },
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

---

- [ ] **Step 2: Run tests — expect 3 failures (detectEntityType not yet exported)**

```bash
npm test
```

Expected: TypeScript errors or runtime errors about `detectEntityType` not being exported. If it fails with "cannot find module" or "detectEntityType is not a function", proceed to Step 3.

---

- [ ] **Step 3: Add imports to `src/session.ts`**

At the top of `src/session.ts`, after the existing import block, add:

```typescript
import { readFile } from 'node:fs/promises';
import { Scorer } from '@buffr/capabilities';
import type { ScorecardDefinition } from '@buffr/capabilities';
import { COMPANY_SCORECARD, ETF_SCORECARD } from '@buffr/domain-pack-investing';
import type { AgentContext } from '@buffr/contracts';
```

---

- [ ] **Step 4: Add `ETF_TICKERS` constant and `detectEntityType` export to `src/session.ts`**

After the existing `ROUTING_PROMPT_VERSION` constant (around line 48), add:

```typescript
const ETF_TICKERS = new Set([
  'VTI', 'SPY', 'QQQ', 'IVV', 'VOO', 'VXUS', 'BND', 'GLD', 'SLV', 'TLT',
  'AGG', 'LQD', 'EFA', 'EEM', 'VEA', 'VWO', 'VNQ', 'SCHD', 'JEPI', 'ARKK',
  'XLF', 'XLE', 'XLK', 'XLV', 'SPDW', 'IEMG',
]);

export function detectEntityType(ticker: string): 'company' | 'etf' {
  return ETF_TICKERS.has(ticker.toUpperCase()) ? 'etf' : 'company';
}
```

---

- [ ] **Step 5: Add `formatEval` helper to `src/session.ts`**

After `detectEntityType`, add the following module-level async function (outside `createChatSession`):

```typescript
type EvalFixture = {
  description: string;
  findings: Parameters<Scorer['execute']>[0]['findings'];
  evidenceCount: number;
  expectedTotalScore: number;
};

async function formatEval(
  scorer: Scorer,
  evalCtx: AgentContext,
  companyFixtures: EvalFixture[],
  etfFixtures: EvalFixture[],
): Promise<string> {
  const total = companyFixtures.length + etfFixtures.length;
  let passed = 0;
  const lines: string[] = [`Investing eval — ${total} fixtures`, ''];

  async function runGroup(label: string, fixtures: EvalFixture[], scorecard: ScorecardDefinition): Promise<void> {
    lines.push(`${label} (${fixtures.length}):`);
    for (const fixture of fixtures) {
      const result = await scorer.execute(
        { findings: fixture.findings, scorecard, evidenceCount: fixture.evidenceCount },
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
  }

  await runGroup('Company', companyFixtures, COMPANY_SCORECARD);
  await runGroup('ETF', etfFixtures, ETF_SCORECARD);
  lines.push(`${passed}/${total} passed`);
  return lines.join('\n');
}
```

---

- [ ] **Step 6: Add `evalInvesting` to the `ChatSession` type in `src/session.ts`**

Find the `ChatSession` type (currently):

```typescript
export type ChatSession = {
  ask(question: string, opts?: AskOptions): Promise<string>;
  close(): Promise<void>;
};
```

Change it to:

```typescript
export type ChatSession = {
  ask(question: string, opts?: AskOptions): Promise<string>;
  evalInvesting(): Promise<string>;
  close(): Promise<void>;
};
```

---

- [ ] **Step 7: Add `evalInvesting()` to the `createChatSession()` return object in `src/session.ts`**

Find the `return {` block inside `createChatSession()`. It currently returns `{ ask, close }`. Add `evalInvesting` between them:

```typescript
    async evalInvesting(): Promise<string> {
      const scorer = new Scorer();
      const evalCtx: AgentContext = {
        userId: cfg.appId, workspaceId: cfg.appId, traceId: 'eval',
        domain: 'investing', now: new Date().toISOString(), permissions: [],
      };
      const companyFixtures: EvalFixture[] = JSON.parse(
        await readFile(
          new URL('../../packages/domain-packs/investing/eval/company-fixtures.json', import.meta.url),
          'utf8',
        ),
      );
      const etfFixtures: EvalFixture[] = JSON.parse(
        await readFile(
          new URL('../../packages/domain-packs/investing/eval/etf-fixtures.json', import.meta.url),
          'utf8',
        ),
      );
      return formatEval(scorer, evalCtx, companyFixtures, etfFixtures);
    },
```

---

- [ ] **Step 8: Build and run tests — expect 3 passes**

```bash
npm test
```

Expected output (relevant lines):

```
✔ detectEntityType > returns etf for known ETF tickers
✔ detectEntityType > returns company for non-ETF tickers
✔ eval:investing scorer accuracy > company fixtures score within ±0.01 of expected
✔ eval:investing scorer accuracy > ETF fixtures score within ±0.01 of expected
```

All existing tests must also still pass.

If a scorer test fails with a delta > 0.01, the scorecard weights or lower-is-better logic changed — read `packages/domain-packs/investing/src/scorecards.ts` and `packages/capabilities/src/scorer/index.ts` to diagnose.

---

- [ ] **Step 9: Commit**

```bash
git add src/session.ts test/commands.test.ts
git commit -m "feat: add detectEntityType and evalInvesting to session"
```

---

### Task 2: `analyze()` + InvestingEngine wiring + chat.tsx command handling

**Files:**
- Modify: `src/session.ts`
- Modify: `src/cli/chat.tsx`

**Interfaces:**
- Consumes (from Task 1): `detectEntityType` exported from `src/session.ts`
- Produces:
  - `ChatSession.analyze(ticker, entityType, opts?): Promise<string>` — added to type + return object
  - `/investing <TICKER>` and `/eval` handled in `chat.tsx`

---

- [ ] **Step 1: Add `InvestingEngine` imports to `src/session.ts`**

After the existing imports in `src/session.ts`, add:

```typescript
import { InvestingEngine } from '@buffr/engine-investing';
import type { InvestingSource, InvestingOutput } from '@buffr/engine-investing';
```

---

- [ ] **Step 2: Add `formatAnalysis` helper to `src/session.ts`**

After `formatEval`, add:

```typescript
function formatAnalysis(output: InvestingOutput): string {
  const { summary, detail } = output;
  const score = summary.totalScore.toFixed(1);
  const confidence = Math.round(summary.confidence * 100);
  const entityLabel = summary.entityType === 'etf' ? 'ETF' : 'Company';

  const lines: string[] = [
    `${summary.ticker} — ${entityLabel}  ·  Score: ${score}/100  ·  Confidence: ${confidence}%`,
    '',
    summary.explanation,
  ];

  if (summary.keyLessons.length > 0) {
    lines.push('', 'Key lessons:');
    for (const lesson of summary.keyLessons) lines.push(`• ${lesson}`);
  }

  if (summary.actionableNext.length > 0) {
    lines.push('', 'Next steps:');
    for (const step of summary.actionableNext) lines.push(`• ${step}`);
  }

  lines.push('', `Sources: ${detail.evidence.length} signals collected`);

  if (summary.confidence < 0.5) {
    lines.push('⚠ Low confidence — limited evidence collected.');
  }
  for (const warning of summary.warnings) {
    lines.push(`⚠ ${warning}`);
  }

  return lines.join('\n');
}
```

---

- [ ] **Step 3: Wire `InvestingEngine` in `createChatSession()` in `src/session.ts`**

Inside `createChatSession()`, after the `googleTool` construction (around the end of connector setup), add:

```typescript
  const investingSources: InvestingSource[] = [
    ...(cfg.braveApiKey ? [{
      connector: new CachedConnector(
        new BraveSearchConnector(cfg.braveApiKey),
        new InMemoryCache(),
        CONNECTOR_CACHE_TTL_MS,
      ),
      paramsFor: (ticker: string, entityType: 'company' | 'etf') => ({
        query: `${ticker} ${entityType} financial analysis earnings`,
        count: 5,
      }),
      optional: true,
    } satisfies InvestingSource] : []),
    ...(cfg.tavilyApiKey ? [{
      connector: new CachedConnector(
        new TavilySearchConnector(cfg.tavilyApiKey),
        new InMemoryCache(),
        CONNECTOR_CACHE_TTL_MS,
      ),
      paramsFor: (ticker: string, entityType: 'company' | 'etf') => ({
        query: `${ticker} ${entityType} investment analysis`,
        maxResults: 5,
      }),
      optional: true,
    } satisfies InvestingSource] : []),
  ];

  const investingEngine = investingSources.length > 0
    ? new InvestingEngine({ model, sources: investingSources, memory })
    : null;
```

Note: `model` and `memory` are already defined above this point in the function. Place this block after the `const model = ...` and `const memory = ...` lines.

---

- [ ] **Step 4: Add `analyze` to `ChatSession` type in `src/session.ts`**

Update the `ChatSession` type (changed in Task 1) to include `analyze`:

```typescript
export type ChatSession = {
  ask(question: string, opts?: AskOptions): Promise<string>;
  analyze(ticker: string, entityType: 'company' | 'etf', opts?: AskOptions): Promise<string>;
  evalInvesting(): Promise<string>;
  close(): Promise<void>;
};
```

---

- [ ] **Step 5: Add `analyze()` to the `createChatSession()` return object in `src/session.ts`**

In the return object (after `evalInvesting`, before `close`), add:

```typescript
    async analyze(ticker: string, entityType: 'company' | 'etf', opts?: AskOptions): Promise<string> {
      if (!investingEngine) {
        return 'No web search connectors configured — set BRAVE_API_KEY or TAVILY_API_KEY in .env';
      }
      currentOnStatus = opts?.onStatus;
      currentOnTokens = opts?.onTokens;
      currentInputTokens = 0;
      currentOutputTokens = 0;
      opts?.onStatus?.('analyzing…');
      const startMs = Date.now();
      const agentCtx: AgentContext = {
        userId: cfg.appId,
        workspaceId: cfg.appId,
        traceId: `${ticker}-${Date.now()}`,
        domain: 'investing',
        now: new Date().toISOString(),
        permissions: [],
      };
      const result = await investingEngine.run(
        { ticker, entityType, conversationId },
        agentCtx,
      );
      currentOnStatus = undefined;
      currentOnTokens = undefined;
      opts?.onComplete?.({
        durationMs: Date.now() - startMs,
        inputTokens: currentInputTokens,
        outputTokens: currentOutputTokens,
      });
      return formatAnalysis(result.data);
    },
```

---

- [ ] **Step 6: Add `/investing` and `/eval` handlers to `src/cli/chat.tsx`**

Add the `detectEntityType` import to `chat.tsx`. Find the existing import:

```typescript
import { createChatSession, type ChatSession, type TurnStats } from '../session.js';
```

Change it to:

```typescript
import { createChatSession, detectEntityType, type ChatSession, type TurnStats } from '../session.js';
```

---

- [ ] **Step 7: Add command handlers in `handleSubmit` in `src/cli/chat.tsx`**

Find the existing early-return guards in `handleSubmit`:

```typescript
    if (busy || !q) return;
    taRef.current?.setText('');
    if (q === '/exit' || q === '/quit') {
      onExit().catch(err => { console.error(err); process.exit(1); });
      return;
    }
```

Add the two new command handlers immediately after the `/exit` check (before `setTurns`):

```typescript
    if (busy || !q) return;
    taRef.current?.setText('');
    if (q === '/exit' || q === '/quit') {
      onExit().catch(err => { console.error(err); process.exit(1); });
      return;
    }
    if (q.startsWith('/investing ')) {
      const ticker = q.slice('/investing '.length).trim().toUpperCase();
      if (!ticker) return;
      const entityType = detectEntityType(ticker);
      setTurns(t => [...t, { role: 'you', text: q }]);
      setBusy(true);
      setStatus('analyzing…');
      setLiveTokens({ input: 0, output: 0 });
      let capturedStats: TurnStats | undefined;
      session.analyze(ticker, entityType, {
        onStatus: (msg) => setStatus(msg),
        onTokens: (d) => setLiveTokens(t => ({ input: t.input + d.input, output: t.output + d.output })),
        onComplete: (s) => { capturedStats = s; },
      }).then(
        answer => { setTurns(t => [...t, { role: 'buffr', text: answer, stats: capturedStats }]); setBusy(false); },
        err    => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}`, stats: capturedStats }]); setBusy(false); },
      );
      return;
    }
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

---

- [ ] **Step 8: Build — verify no TypeScript errors**

```bash
npm run build
```

Expected: Compiles cleanly. If `InvestingEngine` or `InvestingSource` types are not found, verify `@buffr/engine-investing` is in the root `package.json` dependencies (it should already be in workspaces from the engine-investing task).

---

- [ ] **Step 9: Run tests — all existing tests must still pass**

```bash
npm test
```

Expected: All prior tests plus the 4 new tests from Task 1 pass. No new tests added in Task 2 (chat commands are integration-tested manually via `npm run chat`).

---

- [ ] **Step 10: Commit**

```bash
git add src/session.ts src/cli/chat.tsx
git commit -m "feat: add /investing and /eval commands to chat"
```
