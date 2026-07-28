# Connector Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the three Discovery connectors into the `RagQueryAgent` as callable tools so the agent can fetch live RSS feeds, Google Trends data, and Amazon reviews during a conversation.

**Architecture:** Three tool factories in `src/connector-tools/` follow the exact `createSearchKnowledgeBaseTool` pattern from `@buffr/kernel`. Each takes a `DataConnector<TParams, TData>` (structural interface, not the class) and returns `{ definition: ToolDefinition, handler: ToolHandler }`. All four tools are registered together in `InMemoryToolRegistry` inside `src/session.ts`. No changes to `@buffr/kernel` or `@buffr/connectors`.

**Tech Stack:** TypeScript (NodeNext/ESM), `node --test`, `@buffr/kernel` (ToolDefinition/ToolHandler), `@buffr/connectors` (DataConnector + connector classes).

## Global Constraints

- ESM only; all intra-package imports use `.js` extension
- `"strict": true` — no bare `any`
- Root tsconfig `rootDir: "."` → `outDir: "dist"` — source `src/foo.ts` compiles to `dist/src/foo.ts` and `test/foo.test.ts` compiles to `dist/test/foo.test.js`
- Test runner command: `npm test` → `npm run build && node --test --test-concurrency=1 dist/test/*.test.js` — test files must be flat in `test/` (not in subdirectories) to match the glob
- Tool factories accept `DataConnector<TParams, TData>` (structural interface from `@buffr/connectors`) — not the concrete class — so tests can pass plain object stubs without casting
- `ToolDefinition` and `ToolHandler` imported from `@buffr/kernel`
- `DataConnector`, `ConnectorResult`, and all data types imported from `@buffr/connectors`
- Tool names: `fetch_rss_feed`, `fetch_search_trends`, `fetch_amazon_reviews` (exact)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/connector-tools/rss-tool.ts` | Create | `createFetchRssTool` factory |
| `src/connector-tools/trends-tool.ts` | Create | `createFetchTrendsTool` factory |
| `src/connector-tools/amazon-tool.ts` | Create | `createFetchReviewsTool` factory |
| `test/rss-tool.test.ts` | Create | 5 tests for `createFetchRssTool` |
| `test/trends-tool.test.ts` | Create | 4 tests for `createFetchTrendsTool` |
| `test/amazon-tool.test.ts` | Create | 4 tests for `createFetchReviewsTool` |
| `src/session.ts` | Modify | Add 3 connector tools to `InMemoryToolRegistry` |
| `package.json` (root) | Modify | Add `"@buffr/connectors": "0.0.1"` to dependencies |

---

### Task 1: RSS connector tool + root dependency

**Files:**
- Create: `src/connector-tools/rss-tool.ts`
- Create: `test/rss-tool.test.ts`
- Modify: `package.json` (root)

**Interfaces:**
- Consumes: `DataConnector<RssParams, RssFeed>`, `ConnectorResult<RssFeed>`, `RssParams`, `RssFeed` from `@buffr/connectors`; `ToolDefinition`, `ToolHandler` from `@buffr/kernel`
- Produces: `createFetchRssTool(connector: DataConnector<RssParams, RssFeed>): { definition: ToolDefinition; handler: ToolHandler }` — used by Task 3

- [ ] **Step 1: Write the failing test**

Create `test/rss-tool.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchRssTool } from '../src/connector-tools/rss-tool.js';
import type { DataConnector, RssParams, RssFeed, ConnectorResult } from '@buffr/connectors';

function makeStub(data: RssFeed): DataConnector<RssParams, RssFeed> {
  return {
    id: 'discovery.news-rss',
    async fetch(_params: RssParams): Promise<ConnectorResult<RssFeed>> {
      return {
        data,
        fetchedAt: '2024-01-01T00:00:00.000Z',
        sourceId: `rss:${data.url}`,
        toEvidence: () => [],
      };
    },
  };
}

const FEED: RssFeed = {
  title: 'Test Feed',
  url: 'https://example.com/feed',
  articles: [
    { title: 'Article One', link: 'https://example.com/1', description: 'First article text', pubDate: '2024-01-01' },
    { title: 'Article Two', link: 'https://example.com/2', description: 'Second article text', pubDate: '2024-01-02' },
  ],
};

describe('createFetchRssTool', () => {
  it('tool name is fetch_rss_feed', () => {
    const { definition } = createFetchRssTool(makeStub(FEED));
    assert.strictEqual(definition.name, 'fetch_rss_feed');
  });

  it('input schema requires url', () => {
    const { definition } = createFetchRssTool(makeStub(FEED));
    assert.deepStrictEqual(definition.inputSchema['required'], ['url']);
  });

  it('handler returns feedTitle, url, fetchedAt, articles array', async () => {
    const { handler } = createFetchRssTool(makeStub(FEED));
    const result = await handler({ url: 'https://example.com/feed' }) as Record<string, unknown>;
    assert.strictEqual(result['feedTitle'], 'Test Feed');
    assert.strictEqual(result['url'], 'https://example.com/feed');
    assert.strictEqual(result['fetchedAt'], '2024-01-01T00:00:00.000Z');
    const articles = result['articles'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(articles));
    assert.strictEqual(articles.length, 2);
    assert.strictEqual(articles[0]!['title'], 'Article One');
    assert.strictEqual(articles[0]!['link'], 'https://example.com/1');
  });

  it('handler passes limit to connector', async () => {
    let capturedParams: RssParams | null = null;
    const stub: DataConnector<RssParams, RssFeed> = {
      id: 'discovery.news-rss',
      async fetch(params: RssParams): Promise<ConnectorResult<RssFeed>> {
        capturedParams = params;
        return { data: FEED, fetchedAt: '2024-01-01T00:00:00.000Z', sourceId: 'rss:x', toEvidence: () => [] };
      },
    };
    const { handler } = createFetchRssTool(stub);
    await handler({ url: 'https://example.com/feed', limit: 5 });
    assert.strictEqual(capturedParams?.limit, 5);
  });

  it('handler defaults limit to 10 when not provided', async () => {
    let capturedParams: RssParams | null = null;
    const stub: DataConnector<RssParams, RssFeed> = {
      id: 'discovery.news-rss',
      async fetch(params: RssParams): Promise<ConnectorResult<RssFeed>> {
        capturedParams = params;
        return { data: FEED, fetchedAt: '2024-01-01T00:00:00.000Z', sourceId: 'rss:x', toEvidence: () => [] };
      },
    };
    const { handler } = createFetchRssTool(stub);
    await handler({ url: 'https://example.com/feed' });
    assert.strictEqual(capturedParams?.limit, 10);
  });
});
```

- [ ] **Step 2: Run test — confirm it fails to compile**

```bash
npm run build 2>&1 | head -20
```

Expected: TypeScript error — `Cannot find module '../src/connector-tools/rss-tool.js'`.

- [ ] **Step 3: Add `@buffr/connectors` to root `package.json` dependencies**

In `package.json` (root), in the `"dependencies"` block, add after `"@buffr/kernel": "0.0.1"`:

```json
"@buffr/connectors": "0.0.1",
```

Then run:

```bash
npm install
```

Expected: exits 0, no errors.

- [ ] **Step 4: Create `src/connector-tools/rss-tool.ts`**

```typescript
import type { ToolDefinition, ToolHandler } from '@buffr/kernel';
import type { DataConnector, RssParams, RssFeed } from '@buffr/connectors';

export function createFetchRssTool(
  connector: DataConnector<RssParams, RssFeed>,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'fetch_rss_feed',
    description: 'Fetch articles from an RSS 2.0 feed URL and return the latest items.',
    inputSchema: {
      type: 'object',
      properties: {
        url:   { type: 'string',  description: 'The RSS feed URL to fetch.' },
        limit: { type: 'integer', description: 'Max number of articles to return.', default: 10 },
      },
      required: ['url'],
      additionalProperties: false,
    },
  };

  const handler: ToolHandler = async (args) => {
    const url   = typeof args['url'] === 'string' ? args['url'] : '';
    const limit = typeof args['limit'] === 'number' && args['limit'] > 0 ? args['limit'] : 10;
    const result = await connector.fetch({ url, limit });
    return {
      feedTitle: result.data.title,
      url:       result.data.url,
      fetchedAt: result.fetchedAt,
      articles:  result.data.articles.map((a) => ({
        title:   a.title,
        link:    a.link,
        pubDate: a.pubDate,
        excerpt: a.description?.slice(0, 200),
      })),
    };
  };

  return { definition, handler };
}
```

- [ ] **Step 5: Run tests — confirm all 5 pass**

```bash
npm test
```

Expected: existing `runtime.test.js` tests + 5 new `rss-tool.test.js` tests pass, exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/connector-tools/rss-tool.ts test/rss-tool.test.ts package.json package-lock.json
git commit -m "feat: add RssConnector tool factory + register @buffr/connectors dep"
```

---

### Task 2: Trends + Amazon connector tools

**Files:**
- Create: `src/connector-tools/trends-tool.ts`
- Create: `src/connector-tools/amazon-tool.ts`
- Create: `test/trends-tool.test.ts`
- Create: `test/amazon-tool.test.ts`

**Interfaces:**
- Consumes (from `@buffr/connectors`): `DataConnector<TrendsParams, TrendResult[]>`, `TrendsParams`, `TrendResult`; `DataConnector<AmazonReviewsParams, AmazonReviewsResult>`, `AmazonReviewsParams`, `AmazonReviewsResult`, `ConnectorResult`
- Produces:
  - `createFetchTrendsTool(connector: DataConnector<TrendsParams, TrendResult[]>): { definition: ToolDefinition; handler: ToolHandler }`
  - `createFetchReviewsTool(connector: DataConnector<AmazonReviewsParams, AmazonReviewsResult>): { definition: ToolDefinition; handler: ToolHandler }`
  - Both used by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `test/trends-tool.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchTrendsTool } from '../src/connector-tools/trends-tool.js';
import type { DataConnector, TrendsParams, TrendResult, ConnectorResult } from '@buffr/connectors';

const TRENDS: TrendResult[] = [
  { keyword: 'bitcoin', geo: 'US', timeframe: 'now 7-d', timeline: [], averageInterest: 75 },
];

function makeStub(data: TrendResult[]): DataConnector<TrendsParams, TrendResult[]> {
  return {
    id: 'discovery.search-trends.google',
    async fetch(_params: TrendsParams): Promise<ConnectorResult<TrendResult[]>> {
      return { data, fetchedAt: '2024-01-01T00:00:00.000Z', sourceId: 'trends:bitcoin', toEvidence: () => [] };
    },
  };
}

describe('createFetchTrendsTool', () => {
  it('tool name is fetch_search_trends', () => {
    const { definition } = createFetchTrendsTool(makeStub(TRENDS));
    assert.strictEqual(definition.name, 'fetch_search_trends');
  });

  it('input schema requires keywords', () => {
    const { definition } = createFetchTrendsTool(makeStub(TRENDS));
    assert.deepStrictEqual(definition.inputSchema['required'], ['keywords']);
  });

  it('handler returns fetchedAt and trends array', async () => {
    const { handler } = createFetchTrendsTool(makeStub(TRENDS));
    const result = await handler({ keywords: ['bitcoin'], geo: 'US' }) as Record<string, unknown>;
    assert.strictEqual(result['fetchedAt'], '2024-01-01T00:00:00.000Z');
    const trends = result['trends'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(trends));
    assert.strictEqual(trends.length, 1);
    assert.strictEqual(trends[0]!['keyword'], 'bitcoin');
    assert.strictEqual(trends[0]!['averageInterest'], 75);
  });

  it('handler defaults geo to empty string and timeframe to "now 7-d"', async () => {
    let capturedParams: TrendsParams | null = null;
    const stub: DataConnector<TrendsParams, TrendResult[]> = {
      id: 'discovery.search-trends.google',
      async fetch(params: TrendsParams): Promise<ConnectorResult<TrendResult[]>> {
        capturedParams = params;
        return { data: TRENDS, fetchedAt: '2024-01-01T00:00:00.000Z', sourceId: 'trends:x', toEvidence: () => [] };
      },
    };
    const { handler } = createFetchTrendsTool(stub);
    await handler({ keywords: ['ethereum'] });
    assert.strictEqual(capturedParams?.geo, '');
    assert.strictEqual(capturedParams?.timeframe, 'now 7-d');
  });
});
```

Create `test/amazon-tool.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchReviewsTool } from '../src/connector-tools/amazon-tool.js';
import type { DataConnector, AmazonReviewsParams, AmazonReviewsResult, ConnectorResult } from '@buffr/connectors';

const REVIEWS: AmazonReviewsResult = {
  asin: 'B000TEST01',
  productTitle: 'Test Widget',
  reviews: [
    { id: 'R1', title: 'Great!', body: 'Works perfectly.', rating: 5, date: '2024-01-01T00:00:00.000Z', verified: true },
  ],
};

function makeStub(data: AmazonReviewsResult): DataConnector<AmazonReviewsParams, AmazonReviewsResult> {
  return {
    id: 'discovery.reviews.amazon',
    async fetch(_params: AmazonReviewsParams): Promise<ConnectorResult<AmazonReviewsResult>> {
      return { data, fetchedAt: '2024-01-01T00:00:00.000Z', sourceId: `amazon:reviews:${data.asin}`, toEvidence: () => [] };
    },
  };
}

describe('createFetchReviewsTool', () => {
  it('tool name is fetch_amazon_reviews', () => {
    const { definition } = createFetchReviewsTool(makeStub(REVIEWS));
    assert.strictEqual(definition.name, 'fetch_amazon_reviews');
  });

  it('input schema requires asin', () => {
    const { definition } = createFetchReviewsTool(makeStub(REVIEWS));
    assert.deepStrictEqual(definition.inputSchema['required'], ['asin']);
  });

  it('handler returns asin, productTitle, fetchedAt, reviews array', async () => {
    const { handler } = createFetchReviewsTool(makeStub(REVIEWS));
    const result = await handler({ asin: 'B000TEST01' }) as Record<string, unknown>;
    assert.strictEqual(result['asin'], 'B000TEST01');
    assert.strictEqual(result['productTitle'], 'Test Widget');
    assert.strictEqual(result['fetchedAt'], '2024-01-01T00:00:00.000Z');
    const reviews = result['reviews'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(reviews));
    assert.strictEqual(reviews.length, 1);
    assert.strictEqual(reviews[0]!['rating'], 5);
    assert.strictEqual(reviews[0]!['verified'], true);
  });

  it('handler passes limit to connector', async () => {
    let capturedParams: AmazonReviewsParams | null = null;
    const stub: DataConnector<AmazonReviewsParams, AmazonReviewsResult> = {
      id: 'discovery.reviews.amazon',
      async fetch(params: AmazonReviewsParams): Promise<ConnectorResult<AmazonReviewsResult>> {
        capturedParams = params;
        return { data: REVIEWS, fetchedAt: '2024-01-01T00:00:00.000Z', sourceId: 'amazon:reviews:x', toEvidence: () => [] };
      },
    };
    const { handler } = createFetchReviewsTool(stub);
    await handler({ asin: 'B000TEST01', limit: 3 });
    assert.strictEqual(capturedParams?.limit, 3);
  });
});
```

- [ ] **Step 2: Run tests — confirm both new test files fail to compile**

```bash
npm run build 2>&1 | head -20
```

Expected: TypeScript errors — `Cannot find module` for `trends-tool.js` and `amazon-tool.js`.

- [ ] **Step 3: Create `src/connector-tools/trends-tool.ts`**

```typescript
import type { ToolDefinition, ToolHandler } from '@buffr/kernel';
import type { DataConnector, TrendsParams, TrendResult } from '@buffr/connectors';

export function createFetchTrendsTool(
  connector: DataConnector<TrendsParams, TrendResult[]>,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'fetch_search_trends',
    description: 'Fetch Google Trends interest-over-time data for one or more keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords:  { type: 'array', items: { type: 'string' }, description: 'Keywords to look up (1–5).' },
        geo:       { type: 'string', description: 'Country code (e.g. "US") or "" for worldwide.', default: '' },
        timeframe: { type: 'string', description: 'Time window, e.g. "now 7-d" or "today 12-m".', default: 'now 7-d' },
      },
      required: ['keywords'],
      additionalProperties: false,
    },
  };

  const handler: ToolHandler = async (args) => {
    const keywords  = Array.isArray(args['keywords']) ? (args['keywords'] as string[]) : [];
    const geo       = typeof args['geo'] === 'string' ? args['geo'] : '';
    const timeframe = typeof args['timeframe'] === 'string' ? args['timeframe'] : 'now 7-d';
    const result = await connector.fetch({ keywords, geo, timeframe });
    return {
      fetchedAt: result.fetchedAt,
      trends: result.data.map((t) => ({
        keyword:         t.keyword,
        averageInterest: t.averageInterest,
        timeframe:       t.timeframe,
        geo:             t.geo,
      })),
    };
  };

  return { definition, handler };
}
```

- [ ] **Step 4: Create `src/connector-tools/amazon-tool.ts`**

```typescript
import type { ToolDefinition, ToolHandler } from '@buffr/kernel';
import type { DataConnector, AmazonReviewsParams, AmazonReviewsResult } from '@buffr/connectors';

export function createFetchReviewsTool(
  connector: DataConnector<AmazonReviewsParams, AmazonReviewsResult>,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'fetch_amazon_reviews',
    description: 'Fetch recent customer reviews for an Amazon product by ASIN.',
    inputSchema: {
      type: 'object',
      properties: {
        asin:  { type: 'string',  description: 'Amazon product ASIN (e.g. "B08N5WRWNW").' },
        limit: { type: 'integer', description: 'Max number of reviews to return.', default: 10 },
      },
      required: ['asin'],
      additionalProperties: false,
    },
  };

  const handler: ToolHandler = async (args) => {
    const asin  = typeof args['asin'] === 'string' ? args['asin'] : '';
    const limit = typeof args['limit'] === 'number' && args['limit'] > 0 ? args['limit'] : 10;
    const result = await connector.fetch({ asin, limit });
    return {
      asin:         result.data.asin,
      productTitle: result.data.productTitle,
      fetchedAt:    result.fetchedAt,
      reviews:      result.data.reviews.map((r) => ({
        title:    r.title,
        rating:   r.rating,
        body:     r.body,
        date:     r.date,
        verified: r.verified,
      })),
    };
  };

  return { definition, handler };
}
```

- [ ] **Step 5: Run all tests — confirm all pass**

```bash
npm test
```

Expected: all existing tests + 5 rss-tool + 4 trends-tool + 4 amazon-tool tests pass, exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/connector-tools/trends-tool.ts src/connector-tools/amazon-tool.ts test/trends-tool.test.ts test/amazon-tool.test.ts
git commit -m "feat: add GoogleTrendsConnector and AmazonReviewsConnector tool factories"
```

---

### Task 3: Wire connector tools into session.ts

**Files:**
- Modify: `src/session.ts`

**Interfaces:**
- Consumes: `createFetchRssTool` from `./connector-tools/rss-tool.js`; `createFetchTrendsTool` from `./connector-tools/trends-tool.js`; `createFetchReviewsTool` from `./connector-tools/amazon-tool.js`; `RssConnector`, `GoogleTrendsConnector`, `AmazonReviewsConnector` from `@buffr/connectors`
- Produces: `createChatSession()` returns an agent that has 4 tools: `search_knowledge_base`, `fetch_rss_feed`, `fetch_search_trends`, `fetch_amazon_reviews`

No new tests — `session.ts` requires live infrastructure (Postgres, Ollama). Verification is a clean TypeScript build.

- [ ] **Step 1: Update imports in `src/session.ts`**

At the top of `src/session.ts`, add after the existing imports:

```typescript
import { RssConnector, GoogleTrendsConnector, AmazonReviewsConnector } from '@buffr/connectors';
import { createFetchRssTool } from './connector-tools/rss-tool.js';
import { createFetchTrendsTool } from './connector-tools/trends-tool.js';
import { createFetchReviewsTool } from './connector-tools/amazon-tool.js';
```

- [ ] **Step 2: Replace the tool registration block in `createChatSession()`**

Find and replace this block (currently around line 43–44 of `src/session.ts`):

```typescript
  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
  const tools = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });
```

Replace with:

```typescript
  const searchTool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
  const rssTool    = createFetchRssTool(new RssConnector());
  const trendsTool = createFetchTrendsTool(new GoogleTrendsConnector());
  const amazonTool = createFetchReviewsTool(new AmazonReviewsConnector());

  const tools = new InMemoryToolRegistry(
    [searchTool.definition, rssTool.definition, trendsTool.definition, amazonTool.definition],
    {
      [searchTool.definition.name]: searchTool.handler,
      [rssTool.definition.name]:    rssTool.handler,
      [trendsTool.definition.name]: trendsTool.handler,
      [amazonTool.definition.name]: amazonTool.handler,
    },
  );
```

- [ ] **Step 3: Verify build succeeds**

```bash
npm run build
```

Expected: exits 0, no TypeScript errors. `dist/src/session.js` updated.

- [ ] **Step 4: Run tests to confirm nothing regressed**

```bash
npm test
```

Expected: same test count as after Task 2, all pass, exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/session.ts
git commit -m "feat: wire RSS, Google Trends, and Amazon Reviews tools into RagQueryAgent"
```
