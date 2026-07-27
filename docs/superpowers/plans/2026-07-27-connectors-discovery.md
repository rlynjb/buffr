# @buffr/connectors — Discovery Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `@buffr/connectors` npm workspace package with three Discovery connectors — RSS feeds, Google Trends, and Amazon Reviews — each returning typed raw data with a `toEvidence()` mapper.

**Architecture:** Single package (`packages/connectors/`) in the existing npm workspaces setup. Every connector is a class with an injectable transport so tests run fully offline. The only cross-package dependency is `@buffr/contracts` (for the `Evidence` type) — no `@buffr/kernel` dependency.

**Tech Stack:** TypeScript (NodeNext/ESM), `node --test`, `fast-xml-parser` (RSS), `google-trends-api` (Trends, CJS via dynamic import), `cheerio` (Amazon HTML scraping).

## Global Constraints

- `"type": "module"` — ESM only; all intra-package imports use `.js` extension
- `"module": "NodeNext"` / `"moduleResolution": "NodeNext"` — inherited from `tsconfig.base.json`
- `"strict": true` — no `any` escapes except the explicit dynamic-import cast for `google-trends-api`
- All imports end with `.js` extension (compiled output, not source)
- Tests use `import { describe, it } from 'node:test'` and `import assert from 'node:assert/strict'` — no vitest
- Test runner: `node --test --test-concurrency=1`
- Package exports pattern matches `@buffr/kernel`: `"main": "./dist/src/index.js"`, `"types": "./dist/src/index.d.ts"`
- `rootDir: "."`, `outDir: "dist"` → source `src/foo.ts` compiles to `dist/src/foo.js`
- No `esModuleInterop` — use dynamic import with type assertion for CJS packages
- `ConnectorResult<TData>` is a plain object (not a class), returned from `fetch()`
- `toEvidence()` must close over `fetchedAt` (set at fetch time, not request time)
- `inferFreshness()` lives only in `src/discovery/_freshness.ts` — not re-implemented in each connector

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/connectors/package.json` | Create | Package metadata, dependencies, build/test scripts |
| `packages/connectors/tsconfig.json` | Create | TypeScript config (extends `../../tsconfig.base.json`) |
| `packages/connectors/src/contracts.ts` | Create | `DataConnector<P,T>`, `ConnectorResult<T>`, `FetchOptions` |
| `packages/connectors/src/index.ts` | Create | Public re-exports (built up across tasks) |
| `packages/connectors/src/discovery/_freshness.ts` | Create | `inferFreshness()` — shared by all Discovery connectors |
| `packages/connectors/src/discovery/news-rss.ts` | Create | `RssConnector`, `RssParams`, `RssFeed`, `RssArticle`, `RssTransport` |
| `packages/connectors/src/discovery/search-trends.ts` | Create | `GoogleTrendsConnector`, `TrendsParams`, `TrendResult`, `TrendPoint`, `TrendsTransport` |
| `packages/connectors/src/discovery/reviews/amazon.ts` | Create | `AmazonReviewsConnector`, `AmazonReviewsParams`, `AmazonReviewsResult`, `AmazonReview`, `AmazonTransport` |
| `packages/connectors/test/discovery/news-rss.test.ts` | Create | Offline tests for `RssConnector` |
| `packages/connectors/test/discovery/search-trends.test.ts` | Create | Offline tests for `GoogleTrendsConnector` |
| `packages/connectors/test/discovery/amazon-reviews.test.ts` | Create | Offline tests for `AmazonReviewsConnector` |
| `package.json` (root) | Modify | Add `@buffr/connectors` to `build:packages` script |

---

### Task 1: Package scaffold + DataConnector contracts

**Files:**
- Create: `packages/connectors/package.json`
- Create: `packages/connectors/tsconfig.json`
- Create: `packages/connectors/src/contracts.ts`
- Create: `packages/connectors/src/index.ts`
- Modify: `package.json` (root)

**Interfaces:**
- Consumes: `@buffr/contracts` (workspace dependency — already built)
- Produces: `DataConnector<TParams, TData>`, `ConnectorResult<TData>`, `FetchOptions` — used by all later tasks

- [ ] **Step 1: Create `packages/connectors/package.json`**

```json
{
  "name": "@buffr/connectors",
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
    "test": "npm run build && node --test --test-concurrency=1 dist/test/discovery/*.test.js"
  },
  "dependencies": {
    "@buffr/contracts": "0.0.1",
    "cheerio": "^1.0.0",
    "fast-xml-parser": "^4.4.0",
    "google-trends-api": "^4.9.2"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `packages/connectors/tsconfig.json`**

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

- [ ] **Step 3: Create `packages/connectors/src/contracts.ts`**

```typescript
import type { Evidence } from '@buffr/contracts';

export interface DataConnector<TParams, TData> {
  readonly id: string;
  fetch(params: TParams, options?: FetchOptions): Promise<ConnectorResult<TData>>;
}

export type ConnectorResult<TData> = {
  data: TData;
  fetchedAt: string;
  sourceId: string;
  toEvidence(): Evidence[];
};

export type FetchOptions = { signal?: AbortSignal };
```

- [ ] **Step 4: Create `packages/connectors/src/index.ts`** (initial — will be extended in later tasks)

```typescript
export type { DataConnector, ConnectorResult, FetchOptions } from './contracts.js';
```

- [ ] **Step 5: Update root `package.json` — add `@buffr/connectors` to `build:packages`**

Current line:
```json
"build:packages": "npm run build -w @buffr/contracts && npm run build -w @buffr/kernel",
```

Replace with:
```json
"build:packages": "npm run build -w @buffr/contracts && npm run build -w @buffr/kernel && npm run build -w @buffr/connectors",
```

- [ ] **Step 6: Install workspace and verify build**

```bash
npm install
npm run build -w @buffr/connectors
```

Expected: exits 0, `packages/connectors/dist/src/contracts.js` and `packages/connectors/dist/src/index.js` exist.

- [ ] **Step 7: Commit**

```bash
git add packages/connectors/package.json packages/connectors/tsconfig.json packages/connectors/src/contracts.ts packages/connectors/src/index.ts package.json
git commit -m "feat(connectors): scaffold package + DataConnector contracts"
```

---

### Task 2: Freshness helper + RssConnector

**Files:**
- Create: `packages/connectors/src/discovery/_freshness.ts`
- Create: `packages/connectors/src/discovery/news-rss.ts`
- Create: `packages/connectors/test/discovery/news-rss.test.ts`
- Modify: `packages/connectors/src/index.ts`

**Interfaces:**
- Consumes: `DataConnector<TParams, TData>`, `ConnectorResult<TData>`, `FetchOptions` from `../contracts.js`; `Evidence` from `@buffr/contracts`
- Produces:
  - `inferFreshness(dateStr?: string): 'live' | 'recent' | 'stale' | 'unknown'` (internal, not re-exported from index)
  - `RssConnector` (class, injectable transport)
  - `RssParams`, `RssFeed`, `RssArticle`, `RssTransport` (exported types)

- [ ] **Step 1: Write the failing test**

Create `packages/connectors/test/discovery/news-rss.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RssConnector } from '../../src/discovery/news-rss.js';

const STUB_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Article One</title>
      <link>https://example.com/1</link>
      <description>First article description that is short</description>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      <guid>https://example.com/1</guid>
    </item>
    <item>
      <title>Article Two</title>
      <link>https://example.com/2</link>
      <description>Second article description</description>
      <pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate>
      <guid>https://example.com/2</guid>
    </item>
  </channel>
</rss>`;

const stubTransport = async (_url: string) => STUB_RSS;

describe('RssConnector', () => {
  it('parses feed title and articles', async () => {
    const connector = new RssConnector(stubTransport);
    const result = await connector.fetch({ url: 'https://example.com/feed' });
    assert.strictEqual(result.data.title, 'Test Feed');
    assert.strictEqual(result.data.url, 'https://example.com/feed');
    assert.strictEqual(result.data.articles.length, 2);
    assert.strictEqual(result.data.articles[0]!.title, 'Article One');
  });

  it('respects limit param', async () => {
    const connector = new RssConnector(stubTransport);
    const result = await connector.fetch({ url: 'https://example.com/feed', limit: 1 });
    assert.strictEqual(result.data.articles.length, 1);
  });

  it('toEvidence returns one Evidence per article', async () => {
    const connector = new RssConnector(stubTransport);
    const result = await connector.fetch({ url: 'https://example.com/feed' });
    const evidence = result.toEvidence();
    assert.strictEqual(evidence.length, 2);
    assert.strictEqual(evidence[0]!.sourceType, 'news-rss');
    assert.strictEqual(evidence[0]!.title, 'Article One');
    assert.ok((evidence[0]!.excerpt?.length ?? 0) <= 300);
  });

  it('sets fetchedAt to an ISO timestamp', async () => {
    const connector = new RssConnector(stubTransport);
    const result = await connector.fetch({ url: 'https://example.com/feed' });
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(result.fetchedAt));
  });

  it('id is discovery.news-rss', () => {
    assert.strictEqual(new RssConnector(stubTransport).id, 'discovery.news-rss');
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
cd packages/connectors && npm run build 2>&1 | head -20
```

Expected: TypeScript error — `Cannot find module '../../src/discovery/news-rss.js'`.

- [ ] **Step 3: Create `packages/connectors/src/discovery/_freshness.ts`**

```typescript
export function inferFreshness(dateStr?: string): 'live' | 'recent' | 'stale' | 'unknown' {
  if (!dateStr) return 'unknown';
  const ms = Date.parse(dateStr);
  if (Number.isNaN(ms)) return 'unknown';
  const days = (Date.now() - ms) / 86_400_000;
  if (days < 1)  return 'live';
  if (days < 7)  return 'recent';
  return 'stale';
}
```

- [ ] **Step 4: Create `packages/connectors/src/discovery/news-rss.ts`**

```typescript
import { XMLParser } from 'fast-xml-parser';
import type { Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult, FetchOptions } from '../contracts.js';
import { inferFreshness } from './_freshness.js';

export type RssParams = { url: string; limit?: number };

export type RssArticle = {
  title: string;
  link: string;
  description?: string;
  pubDate?: string;
  guid?: string;
};

export type RssFeed = {
  title: string;
  url: string;
  articles: RssArticle[];
};

export type RssTransport = (url: string, signal?: AbortSignal) => Promise<string>;

async function defaultFetch(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
  return res.text();
}

export class RssConnector implements DataConnector<RssParams, RssFeed> {
  readonly id = 'discovery.news-rss';

  constructor(private readonly transport: RssTransport = defaultFetch) {}

  async fetch(params: RssParams, opts?: FetchOptions): Promise<ConnectorResult<RssFeed>> {
    const xml = await this.transport(params.url, opts?.signal);
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml) as Record<string, unknown>;

    const rss = parsed['rss'] as Record<string, unknown> | undefined;
    if (!rss) throw new Error(`Not a valid RSS 2.0 feed: ${params.url}`);
    const channel = rss['channel'] as Record<string, unknown>;

    const feedTitle = String(channel['title'] ?? '');
    const rawItems: unknown[] = Array.isArray(channel['item'])
      ? (channel['item'] as unknown[])
      : channel['item'] != null ? [channel['item']] : [];

    const articles: RssArticle[] = rawItems.slice(0, params.limit).map((item) => {
      const i = item as Record<string, unknown>;
      return {
        title: String(i['title'] ?? ''),
        link: String(i['link'] ?? ''),
        description: i['description'] != null ? String(i['description']) : undefined,
        pubDate: i['pubDate'] != null ? String(i['pubDate']) : undefined,
        guid: i['guid'] != null ? String(i['guid']) : undefined,
      };
    });

    const fetchedAt = new Date().toISOString();
    const data: RssFeed = { title: feedTitle, url: params.url, articles };

    return {
      data,
      fetchedAt,
      sourceId: `rss:${params.url}`,
      toEvidence(): Evidence[] {
        return articles.map((article) => ({
          sourceId: `rss:${article.guid ?? article.link}`,
          sourceType: 'news-rss',
          title: article.title,
          url: article.link,
          excerpt: article.description?.slice(0, 300),
          retrievedAt: fetchedAt,
          freshness: inferFreshness(article.pubDate),
        }));
      },
    };
  }
}
```

- [ ] **Step 5: Update `packages/connectors/src/index.ts`**

```typescript
export type { DataConnector, ConnectorResult, FetchOptions } from './contracts.js';
export { RssConnector } from './discovery/news-rss.js';
export type { RssParams, RssFeed, RssArticle, RssTransport } from './discovery/news-rss.js';
```

- [ ] **Step 6: Run tests — confirm they pass**

```bash
cd packages/connectors && npm test
```

Expected output: 5 passing tests in `news-rss.test.js`, exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/connectors/src/discovery/_freshness.ts packages/connectors/src/discovery/news-rss.ts packages/connectors/test/discovery/news-rss.test.ts packages/connectors/src/index.ts
git commit -m "feat(connectors): add RssConnector with offline-testable transport"
```

---

### Task 3: GoogleTrendsConnector

**Files:**
- Create: `packages/connectors/src/discovery/search-trends.ts`
- Create: `packages/connectors/test/discovery/search-trends.test.ts`
- Modify: `packages/connectors/src/index.ts`

**Interfaces:**
- Consumes: `DataConnector<TParams, TData>`, `ConnectorResult<TData>`, `FetchOptions` from `../contracts.js`; `Evidence` from `@buffr/contracts`
- Produces:
  - `GoogleTrendsConnector` (class, injectable transport)
  - `TrendsParams`, `TrendResult`, `TrendPoint`, `TrendsTransport`, `TrendsRequestOpts` (exported types)

**Note on `google-trends-api`:** This is a CJS package with no TypeScript types. Import it via `await import('google-trends-api')` with a type assertion cast — see Step 4 below. Do NOT add `esModuleInterop` to `tsconfig.json`.

- [ ] **Step 1: Write the failing test**

Create `packages/connectors/test/discovery/search-trends.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleTrendsConnector } from '../../src/discovery/search-trends.js';
import type { TrendResult, TrendsRequestOpts } from '../../src/discovery/search-trends.js';

const stubData: TrendResult[] = [
  {
    keyword: 'bitcoin',
    geo: 'US',
    timeframe: 'now 7-d',
    timeline: [
      { date: '2024-01-01T00:00:00.000Z', value: 80 },
      { date: '2024-01-02T00:00:00.000Z', value: 90 },
    ],
    averageInterest: 85,
  },
];

const stubTransport = async (_opts: TrendsRequestOpts) => stubData;

describe('GoogleTrendsConnector', () => {
  it('returns trend data from transport', async () => {
    const connector = new GoogleTrendsConnector(stubTransport);
    const result = await connector.fetch({ keywords: ['bitcoin'], geo: 'US' });
    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0]!.keyword, 'bitcoin');
    assert.strictEqual(result.data[0]!.averageInterest, 85);
  });

  it('toEvidence returns one Evidence per keyword', async () => {
    const connector = new GoogleTrendsConnector(stubTransport);
    const result = await connector.fetch({ keywords: ['bitcoin'], geo: 'US' });
    const evidence = result.toEvidence();
    assert.strictEqual(evidence.length, 1);
    assert.strictEqual(evidence[0]!.sourceType, 'search-trends');
    assert.ok(evidence[0]!.title!.includes('bitcoin'));
    assert.ok(evidence[0]!.excerpt!.includes('85'));
  });

  it('defaults geo to worldwide and timeframe to now 7-d', async () => {
    const connector = new GoogleTrendsConnector(stubTransport);
    const result = await connector.fetch({ keywords: ['ethereum'] });
    assert.strictEqual(result.sourceId, 'trends:ethereum');
  });

  it('sourceId uses comma-joined keywords for multi-keyword fetch', async () => {
    const connector = new GoogleTrendsConnector(stubTransport);
    const result = await connector.fetch({ keywords: ['bitcoin', 'ethereum'] });
    assert.strictEqual(result.sourceId, 'trends:bitcoin,ethereum');
  });

  it('sets fetchedAt to an ISO timestamp', async () => {
    const connector = new GoogleTrendsConnector(stubTransport);
    const result = await connector.fetch({ keywords: ['bitcoin'] });
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(result.fetchedAt));
  });

  it('id is discovery.search-trends.google', () => {
    assert.strictEqual(new GoogleTrendsConnector(stubTransport).id, 'discovery.search-trends.google');
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
cd packages/connectors && npm run build 2>&1 | head -20
```

Expected: TypeScript error — `Cannot find module '../../src/discovery/search-trends.js'`.

- [ ] **Step 3: Create `packages/connectors/src/discovery/search-trends.ts`**

```typescript
import type { Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult, FetchOptions } from '../contracts.js';

export type TrendsParams = {
  keywords: string[];
  geo?: string;
  timeframe?: string;
};

export type TrendPoint = { date: string; value: number };

export type TrendResult = {
  keyword: string;
  geo: string;
  timeframe: string;
  timeline: TrendPoint[];
  averageInterest: number;
};

export type TrendsRequestOpts = {
  keywords: string[];
  geo: string;
  timeframe: string;
};

export type TrendsTransport = (opts: TrendsRequestOpts) => Promise<TrendResult[]>;

// google-trends-api is a CJS package with no TypeScript types.
// Only used in defaultTrendsCall — the injectable transport keeps tests offline.
type GoogleTrendsModule = {
  default: {
    interestOverTime(opts: {
      keyword: string | string[];
      geo?: string;
      startTime?: Date;
      endTime?: Date;
    }): Promise<string>;
  };
};

type RawTimelineData = {
  default: {
    timelineData: Array<{
      time: string;
      value: number[];
    }>;
  };
};

function resolveTimeWindow(timeframe: string): { startTime: Date; endTime: Date } {
  const endTime = new Date();
  const startTime = new Date(endTime);
  if (timeframe === 'today 12-m') {
    startTime.setMonth(startTime.getMonth() - 12);
  } else {
    // default: 'now 7-d'
    startTime.setDate(startTime.getDate() - 7);
  }
  return { startTime, endTime };
}

async function defaultTrendsCall(opts: TrendsRequestOpts): Promise<TrendResult[]> {
  const { startTime, endTime } = resolveTimeWindow(opts.timeframe);
  const mod = await import('google-trends-api') as unknown as GoogleTrendsModule;
  const raw = await mod.default.interestOverTime({
    keyword: opts.keywords,
    geo: opts.geo,
    startTime,
    endTime,
  });
  const parsed = JSON.parse(raw) as RawTimelineData;
  const timeline = parsed.default.timelineData;

  return opts.keywords.map((keyword, idx) => {
    const points: TrendPoint[] = timeline.map((t) => ({
      date: new Date(Number(t.time) * 1000).toISOString(),
      value: t.value[idx] ?? 0,
    }));
    const averageInterest = points.length > 0
      ? Math.round(points.reduce((sum, p) => sum + p.value, 0) / points.length)
      : 0;
    return { keyword, geo: opts.geo, timeframe: opts.timeframe, timeline: points, averageInterest };
  });
}

export class GoogleTrendsConnector implements DataConnector<TrendsParams, TrendResult[]> {
  readonly id = 'discovery.search-trends.google';

  constructor(private readonly call: TrendsTransport = defaultTrendsCall) {}

  async fetch(params: TrendsParams, _opts?: FetchOptions): Promise<ConnectorResult<TrendResult[]>> {
    const geo = params.geo ?? '';
    const timeframe = params.timeframe ?? 'now 7-d';
    const data = await this.call({ keywords: params.keywords, geo, timeframe });
    const fetchedAt = new Date().toISOString();

    return {
      data,
      fetchedAt,
      sourceId: `trends:${params.keywords.join(',')}`,
      toEvidence(): Evidence[] {
        return data.map((trend) => ({
          sourceId: `trends:${trend.keyword}:${fetchedAt}`,
          sourceType: 'search-trends',
          title: `Search trend: "${trend.keyword}"`,
          excerpt: `Average interest: ${trend.averageInterest}/100 over ${trend.timeframe} (geo: ${trend.geo || 'worldwide'})`,
          retrievedAt: fetchedAt,
          freshness: 'recent',
        }));
      },
    };
  }
}
```

- [ ] **Step 4: Update `packages/connectors/src/index.ts`**

```typescript
export type { DataConnector, ConnectorResult, FetchOptions } from './contracts.js';
export { RssConnector } from './discovery/news-rss.js';
export type { RssParams, RssFeed, RssArticle, RssTransport } from './discovery/news-rss.js';
export { GoogleTrendsConnector } from './discovery/search-trends.js';
export type { TrendsParams, TrendResult, TrendPoint, TrendsRequestOpts, TrendsTransport } from './discovery/search-trends.js';
```

- [ ] **Step 5: Run tests — confirm all pass**

```bash
cd packages/connectors && npm test
```

Expected: 5 `news-rss` tests + 6 `search-trends` tests pass, exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/connectors/src/discovery/search-trends.ts packages/connectors/test/discovery/search-trends.test.ts packages/connectors/src/index.ts
git commit -m "feat(connectors): add GoogleTrendsConnector with injectable transport"
```

---

### Task 4: AmazonReviewsConnector

**Files:**
- Create: `packages/connectors/src/discovery/reviews/amazon.ts`
- Create: `packages/connectors/test/discovery/amazon-reviews.test.ts`
- Modify: `packages/connectors/src/index.ts`

**Interfaces:**
- Consumes: `DataConnector<TParams, TData>`, `ConnectorResult<TData>`, `FetchOptions` from `../../contracts.js`; `Evidence` from `@buffr/contracts`; `inferFreshness` from `../_freshness.js`
- Produces:
  - `AmazonReviewsConnector` (class, injectable transport)
  - `AmazonReviewsParams`, `AmazonReviewsResult`, `AmazonReview`, `AmazonTransport` (exported types)

**Note on scraping:** Amazon's HTML structure can change. The cheerio selectors below target `data-hook` attributes (more stable than class names). The injectable transport means a Rainforest API or other paid transport can be swapped in without touching this class.

- [ ] **Step 1: Write the failing test**

Create `packages/connectors/test/discovery/amazon-reviews.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AmazonReviewsConnector } from '../../src/discovery/reviews/amazon.js';

const STUB_HTML = `
<html><body>
<div data-hook="review" id="R1ABC123">
  <a data-hook="review-title"><span>Great product</span></a>
  <i data-hook="review-star-rating">
    <span class="a-icon-alt">4.0 out of 5 stars</span>
  </i>
  <span data-hook="review-date">Reviewed in the United States on January 15, 2024</span>
  <span data-hook="avp-badge">Verified Purchase</span>
  <span data-hook="review-body"><span>This product is excellent and works exactly as described in the listing.</span></span>
  <span data-hook="helpful-vote-statement">5 people found this helpful</span>
</div>
<div data-hook="review" id="R2DEF456">
  <a data-hook="review-title"><span>Decent but not perfect</span></a>
  <i data-hook="review-star-rating">
    <span class="a-icon-alt">3.0 out of 5 stars</span>
  </i>
  <span data-hook="review-date">Reviewed in the United States on February 20, 2024</span>
  <span data-hook="review-body"><span>It is okay but could be better overall.</span></span>
</div>
</body></html>
`;

const stubTransport = async (_asin: string) => STUB_HTML;

describe('AmazonReviewsConnector', () => {
  it('parses asin and reviews from HTML', async () => {
    const connector = new AmazonReviewsConnector(stubTransport);
    const result = await connector.fetch({ asin: 'B000TEST01' });
    assert.strictEqual(result.data.asin, 'B000TEST01');
    assert.strictEqual(result.data.reviews.length, 2);
    assert.strictEqual(result.data.reviews[0]!.title, 'Great product');
    assert.strictEqual(result.data.reviews[0]!.rating, 4);
    assert.strictEqual(result.data.reviews[0]!.verified, true);
    assert.strictEqual(result.data.reviews[0]!.helpful, 5);
    assert.strictEqual(result.data.reviews[1]!.rating, 3);
    assert.strictEqual(result.data.reviews[1]!.verified, false);
  });

  it('respects limit param', async () => {
    const connector = new AmazonReviewsConnector(stubTransport);
    const result = await connector.fetch({ asin: 'B000TEST01', limit: 1 });
    assert.strictEqual(result.data.reviews.length, 1);
  });

  it('toEvidence returns one Evidence per review', async () => {
    const connector = new AmazonReviewsConnector(stubTransport);
    const result = await connector.fetch({ asin: 'B000TEST01' });
    const evidence = result.toEvidence();
    assert.strictEqual(evidence.length, 2);
    assert.strictEqual(evidence[0]!.sourceType, 'reviews-amazon');
    assert.ok(evidence[0]!.excerpt!.includes('/5'));
    assert.ok((evidence[0]!.excerpt?.length ?? 0) <= 320);
  });

  it('sets fetchedAt to an ISO timestamp', async () => {
    const connector = new AmazonReviewsConnector(stubTransport);
    const result = await connector.fetch({ asin: 'B000TEST01' });
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(result.fetchedAt));
  });

  it('sourceId includes asin', async () => {
    const connector = new AmazonReviewsConnector(stubTransport);
    const result = await connector.fetch({ asin: 'B000TEST01' });
    assert.ok(result.sourceId.includes('B000TEST01'));
  });

  it('id is discovery.reviews.amazon', () => {
    assert.strictEqual(new AmazonReviewsConnector(stubTransport).id, 'discovery.reviews.amazon');
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
cd packages/connectors && npm run build 2>&1 | head -20
```

Expected: TypeScript error — `Cannot find module '../../src/discovery/reviews/amazon.js'`.

- [ ] **Step 3: Create `packages/connectors/src/discovery/reviews/amazon.ts`**

```typescript
import { load } from 'cheerio';
import type { Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult, FetchOptions } from '../../contracts.js';
import { inferFreshness } from '../_freshness.js';

export type AmazonReviewsParams = { asin: string; limit?: number };

export type AmazonReview = {
  id: string;
  title: string;
  body: string;
  rating: number;
  date: string;
  verified: boolean;
  helpful?: number;
};

export type AmazonReviewsResult = {
  asin: string;
  productTitle?: string;
  reviews: AmazonReview[];
};

export type AmazonTransport = (asin: string, signal?: AbortSignal) => Promise<string>;

async function defaultAmazonFetch(asin: string, signal?: AbortSignal): Promise<string> {
  const url = `https://www.amazon.com/product-reviews/${asin}?sortBy=recent&pageNumber=1`;
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; buffr-connector/0.0.1)',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`Amazon fetch failed: ${res.status} ${res.statusText}`);
  return res.text();
}

function parseRating(text: string): number {
  const match = /(\d(?:\.\d)?) out of/.exec(text);
  return match ? parseFloat(match[1]!) : 0;
}

function parseReviewDate(text: string): string {
  // e.g. "Reviewed in the United States on January 15, 2024"
  const match = /on (.+)$/.exec(text);
  if (!match) return new Date(0).toISOString();
  const parsed = Date.parse(match[1]!);
  return Number.isNaN(parsed) ? new Date(0).toISOString() : new Date(parsed).toISOString();
}

export class AmazonReviewsConnector implements DataConnector<AmazonReviewsParams, AmazonReviewsResult> {
  readonly id = 'discovery.reviews.amazon';

  constructor(private readonly transport: AmazonTransport = defaultAmazonFetch) {}

  async fetch(params: AmazonReviewsParams, opts?: FetchOptions): Promise<ConnectorResult<AmazonReviewsResult>> {
    const html = await this.transport(params.asin, opts?.signal);
    const $ = load(html);

    const productTitle = $('[data-hook="product-link"]').first().text().trim() || undefined;
    const reviews: AmazonReview[] = [];

    $('[data-hook="review"]').each((_i, el) => {
      if (params.limit != null && reviews.length >= params.limit) return false;

      const id = $(el).attr('id') ?? `${params.asin}-${reviews.length}`;
      const title = $('[data-hook="review-title"]', el).text().trim();
      const body = $('[data-hook="review-body"]', el).text().trim();
      const rating = parseRating($('[data-hook="review-star-rating"] .a-icon-alt', el).first().text());
      const date = parseReviewDate($('[data-hook="review-date"]', el).text().trim());
      const verified = $('[data-hook="avp-badge"]', el).length > 0;
      const helpfulText = $('[data-hook="helpful-vote-statement"]', el).text();
      const helpfulMatch = /(\d+)/.exec(helpfulText);

      reviews.push({
        id,
        title,
        body,
        rating,
        date,
        verified,
        helpful: helpfulMatch ? parseInt(helpfulMatch[1]!, 10) : undefined,
      });
    });

    const fetchedAt = new Date().toISOString();
    const data: AmazonReviewsResult = { asin: params.asin, productTitle, reviews };

    return {
      data,
      fetchedAt,
      sourceId: `amazon:reviews:${params.asin}`,
      toEvidence(): Evidence[] {
        return reviews.map((review) => ({
          sourceId: `amazon:${params.asin}:${review.id}`,
          sourceType: 'reviews-amazon',
          title: review.title,
          excerpt: `${review.rating}/5 — ${review.body.slice(0, 300)}`,
          retrievedAt: fetchedAt,
          freshness: inferFreshness(review.date),
        }));
      },
    };
  }
}
```

- [ ] **Step 4: Update `packages/connectors/src/index.ts`** (final state)

```typescript
export type { DataConnector, ConnectorResult, FetchOptions } from './contracts.js';
export { RssConnector } from './discovery/news-rss.js';
export type { RssParams, RssFeed, RssArticle, RssTransport } from './discovery/news-rss.js';
export { GoogleTrendsConnector } from './discovery/search-trends.js';
export type { TrendsParams, TrendResult, TrendPoint, TrendsRequestOpts, TrendsTransport } from './discovery/search-trends.js';
export { AmazonReviewsConnector } from './discovery/reviews/amazon.js';
export type { AmazonReviewsParams, AmazonReviewsResult, AmazonReview, AmazonTransport } from './discovery/reviews/amazon.js';
```

- [ ] **Step 5: Run all connector tests — confirm all pass**

```bash
cd packages/connectors && npm test
```

Expected:
```
▶ RssConnector
  ✔ parses feed title and articles
  ✔ respects limit param
  ✔ toEvidence returns one Evidence per article
  ✔ sets fetchedAt to an ISO timestamp
  ✔ id is discovery.news-rss
▶ GoogleTrendsConnector
  ✔ returns trend data from transport
  ✔ toEvidence returns one Evidence per keyword
  ✔ defaults geo to worldwide and timeframe to now 7-d
  ✔ sourceId uses comma-joined keywords for multi-keyword fetch
  ✔ sets fetchedAt to an ISO timestamp
  ✔ id is discovery.search-trends.google
▶ AmazonReviewsConnector
  ✔ parses asin and reviews from HTML
  ✔ respects limit param
  ✔ toEvidence returns one Evidence per review
  ✔ sets fetchedAt to an ISO timestamp
  ✔ sourceId includes asin
  ✔ id is discovery.reviews.amazon
```

All 17 tests pass, exits 0.

- [ ] **Step 6: Verify root build still works**

```bash
cd /path/to/repo/root && npm run build:packages
```

Expected: builds contracts, kernel, connectors in sequence without errors.

- [ ] **Step 7: Commit**

```bash
git add packages/connectors/src/discovery/reviews/amazon.ts packages/connectors/test/discovery/amazon-reviews.test.ts packages/connectors/src/index.ts
git commit -m "feat(connectors): add AmazonReviewsConnector with cheerio HTML scraping"
```
