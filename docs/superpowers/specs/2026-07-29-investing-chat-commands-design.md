# Investing Chat Commands Design

**Date:** 2026-07-29
**Status:** Approved

---

## Goal

Add `/investing <TICKER>` and `/eval` slash commands to the buffr chat UI. `/investing` runs `InvestingEngine` against live web sources and displays a structured analysis in the chat. `/eval` runs the Scorer against the investing domain pack fixtures and reports pass/fail.

---

## Architecture

Three files change; nothing else in the monorepo is touched.

```
src/session.ts      — add analyze() + evalInvesting() to ChatSession + createChatSession()
src/cli/chat.tsx    — handle /investing and /eval in handleSubmit before session.ask()
```

`ChatSession` gains two new methods:

```typescript
analyze(ticker: string, entityType: 'company' | 'etf', opts?: AskOptions): Promise<string>;
evalInvesting(opts?: AskOptions): Promise<string>;
```

Both return a pre-formatted string. `chat.tsx` pushes it into the turns array as a `buffr` response — the same code path as a regular `session.ask()` answer, so the TUI renders it identically (same spinner, same status callbacks, same display component).

`InvestingEngine` is constructed once inside `createChatSession()`, alongside the existing connectors. The eval `Scorer` is constructed on demand inside `evalInvesting()` — it is pure computation and has no long-lived state.

---

## `/investing` flow

### Usage

```
/investing AAPL
/investing VTI
```

### ETF detection

A hardcoded `Set<string>` of common ETF tickers determines `entityType`. Any ticker not in the set defaults to `'company'`. The set covers at minimum:

```
VTI, SPY, QQQ, IVV, VOO, VXUS, BND, GLD, SLV, TLT, AGG, LQD, EFA, EEM,
VEA, VWO, VNQ, SCHD, JEPI, ARKK, XLF, XLE, XLK, XLV, SPDW, IEMG
```

### chat.tsx — handleSubmit

```typescript
if (q.startsWith('/investing ')) {
  const ticker = q.slice('/investing '.length).trim().toUpperCase();
  if (!ticker) return;
  setTurns(t => [...t, { role: 'you', text: q }]);
  setBusy(true);
  setStatus('analyzing…');
  setLiveTokens({ input: 0, output: 0 });
  let capturedStats: TurnStats | undefined;
  const entityType = ETF_TICKERS.has(ticker) ? 'etf' : 'company';
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
```

`detectEntityType(ticker: string): 'company' | 'etf'` is an exported pure function in `session.ts` backed by a module-level `ETF_TICKERS` `Set<string>`. `chat.tsx` imports and calls it. The test imports it directly without touching any opentui or DB code.

### session.ts — analyze()

`InvestingEngine` is wired with two `InvestingSource` objects:

```typescript
const investingSources: InvestingSource[] = [
  ...(cfg.braveApiKey ? [{
    connector: new CachedConnector(new BraveSearchConnector(cfg.braveApiKey), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS),
    paramsFor: (ticker: string, entityType: 'company' | 'etf') => ({
      query: `${ticker} ${entityType} financial analysis earnings`,
      count: 5,
    }),
    optional: true,
  }] : []),
  ...(cfg.tavilyApiKey ? [{
    connector: new CachedConnector(new TavilySearchConnector(cfg.tavilyApiKey), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS),
    paramsFor: (ticker: string, entityType: 'company' | 'etf') => ({
      query: `${ticker} ${entityType} investment analysis`,
      maxResults: 5,
    }),
    optional: true,
  }] : []),
];
```

If `investingSources` is empty (no API keys), `analyze()` returns immediately with:
```
No web search connectors configured — set BRAVE_API_KEY or TAVILY_API_KEY in .env
```

`InvestingEngine` is constructed once:
```typescript
const investingEngine = investingSources.length > 0
  ? new InvestingEngine({ model, sources: investingSources, memory })
  : null;
```

The `analyze()` method on `ChatSession`:

```typescript
async analyze(ticker: string, entityType: 'company' | 'etf', opts?: AskOptions): Promise<string> {
  if (!investingEngine) {
    return 'No web search connectors configured — set BRAVE_API_KEY or TAVILY_API_KEY in .env';
  }
  currentOnStatus = opts?.onStatus;
  currentOnTokens = opts?.onTokens;
  currentInputTokens = 0;
  currentOutputTokens = 0;
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
}
```

### Output format — formatAnalysis()

`formatAnalysis(output: InvestingOutput): string` is a pure function in `session.ts`:

```
AAPL — Company  ·  Score: 72.6/100  ·  Confidence: 78%

<explanation (full text from output.summary.explanation)>

Key lessons:
• <keyLessons[0]>
• <keyLessons[1]>
…

Next steps:
• <actionableNext[0]>
…

Sources: <evidence.length> signals collected
```

Warnings (if any) are appended as `⚠ <warning>` lines. If `confidence < 0.5`, prepend `⚠ Low confidence — limited evidence collected.`

---

## `/eval` flow

### Usage

```
/eval
```

### chat.tsx — handleSubmit

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

### session.ts — evalInvesting()

Loads fixture files relative to the session module file. Path: `../../packages/domain-packs/investing/eval/` from `dist/src/session.js`.

```typescript
async evalInvesting(): Promise<string> {
  const scorer = new Scorer();
  const evalCtx: AgentContext = {
    userId: 'eval', workspaceId: 'eval', traceId: 'eval',
    domain: 'investing', now: new Date().toISOString(), permissions: [],
  };
  const companyFixtures = JSON.parse(await readFile(
    new URL('../../packages/domain-packs/investing/eval/company-fixtures.json', import.meta.url), 'utf8'));
  const etfFixtures = JSON.parse(await readFile(
    new URL('../../packages/domain-packs/investing/eval/etf-fixtures.json', import.meta.url), 'utf8'));
  return formatEval(scorer, evalCtx, companyFixtures, etfFixtures);
}
```

`formatEval` is an `async` function that runs `Scorer.execute()` per fixture, compares `result.data.totalScore` to `fixture.expectedTotalScore` (pass = `|actual - expected| ≤ 0.01`), and builds the output string.

### Output format

```
Investing eval — 5 fixtures

Company (3):
  ✔  Strong company — all dimensions present     expected 72.65  got 72.65  Δ 0.00
  ✔  Missing valuation dimension                 expected 55.75  got 55.75  Δ 0.00
  ✔  Sparse evidence — confidence penalised      expected 57.75  got 57.75  Δ 0.00

ETF (2):
  ✔  Strong ETF — all dimensions present         expected 88.25  got 88.25  Δ 0.00
  ✔  High expense ratio — lower-is-better        expected 45.75  got 45.75  Δ 0.00

5/5 passed
```

Failed fixtures show `✘` and the delta. No ANSI color codes — the TUI renders plain text; color would appear as literal escape sequences.

---

## Tests

File: `src/test/commands.test.ts`

**Test 1 — ETF detection:** Import `detectEntityType` from `session.ts` and assert `detectEntityType('VTI') === 'etf'` and `detectEntityType('AAPL') === 'company'`.

**Test 2 — `/eval` scorer accuracy:** Instantiate `Scorer` directly, run it against each fixture in both fixture files, assert every `|actual - expected| ≤ 0.01`. This exercises the real Scorer against the real fixtures with no mocks.

Test runner: `node:test` + `node:assert/strict`, compiled to `dist/src/test/commands.test.js`.

---

## Global constraints

- No new npm dependencies.
- Only `src/session.ts` and `src/cli/chat.tsx` are modified; no upstream packages touched.
- `InvestingEngine` is constructed once per session (not per request).
- Both commands reuse `currentOnStatus` / `currentOnTokens` / `currentInputTokens` / `currentOutputTokens` — the existing mutable slots in `createChatSession()` closure.
- The `conversationId` from the session is passed to `engine.run()` so analyses are written to kernel memory.
- `evalInvesting()` does not write to memory or journal (no `conversationId`, no `decision` in the input).
- `formatAnalysis` and `formatEval` are pure functions (no side effects, no imports beyond their arguments).

---

## Exit criteria

- `/investing AAPL` in chat runs the engine, displays formatted analysis as a `buffr` turn.
- `/investing VTI` detects ETF, runs with `entityType: 'etf'`.
- `/eval` in chat runs all 5 fixtures through the Scorer and displays `5/5 passed`.
- Both commands show the spinner while running.
- Tests pass: ETF detection correct, all 5 eval fixtures score within ±0.01 of expected.
- No upstream packages modified.
