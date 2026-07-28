# Connector Tools Design

**Date:** 2026-07-27
**Status:** Approved

## Goal

Wire the three Discovery connectors (`RssConnector`, `GoogleTrendsConnector`, `AmazonReviewsConnector`) into the `RagQueryAgent` as callable tools, so the agent can fetch live external data during a conversation.

## Architecture

Three tool factories live in `src/connector-tools/` — one per connector — following the existing `createSearchKnowledgeBaseTool` pattern from `@buffr/kernel`. Each factory returns `{ definition: ToolDefinition, handler: ToolHandler }`. The connectors are instantiated with default transports in `src/session.ts` and all four tools (search + 3 connectors) are registered in `InMemoryToolRegistry`.

No changes to `@buffr/kernel` or `@buffr/connectors`. Wiring is the app layer's responsibility.

## New Files

```
src/connector-tools/
  rss-tool.ts       ← createFetchRssTool(connector: RssConnector)
  trends-tool.ts    ← createFetchTrendsTool(connector: GoogleTrendsConnector)
  amazon-tool.ts    ← createFetchReviewsTool(connector: AmazonReviewsConnector)
```

## Tool Definitions

### `fetch_rss_feed`

```typescript
inputSchema: {
  type: 'object',
  properties: {
    url:   { type: 'string',  description: 'RSS feed URL to fetch.' },
    limit: { type: 'integer', description: 'Max articles to return.', default: 10 },
  },
  required: ['url'],
  additionalProperties: false,
}
```

Handler output:
```typescript
{
  feedTitle: string;
  url: string;
  fetchedAt: string;
  articles: Array<{ title: string; link: string; pubDate?: string; excerpt?: string }>;
}
```

### `fetch_search_trends`

```typescript
inputSchema: {
  type: 'object',
  properties: {
    keywords:  { type: 'array', items: { type: 'string' }, description: 'Keywords to look up.' },
    geo:       { type: 'string', description: 'Country code (e.g. "US") or "" for worldwide.', default: '' },
    timeframe: { type: 'string', description: 'Time window (e.g. "now 7-d", "today 12-m").', default: 'now 7-d' },
  },
  required: ['keywords'],
  additionalProperties: false,
}
```

Handler output:
```typescript
{
  fetchedAt: string;
  trends: Array<{ keyword: string; averageInterest: number; timeframe: string; geo: string }>;
}
```

### `fetch_amazon_reviews`

```typescript
inputSchema: {
  type: 'object',
  properties: {
    asin:  { type: 'string',  description: 'Amazon product ASIN.' },
    limit: { type: 'integer', description: 'Max reviews to return.', default: 10 },
  },
  required: ['asin'],
  additionalProperties: false,
}
```

Handler output:
```typescript
{
  asin: string;
  productTitle?: string;
  fetchedAt: string;
  reviews: Array<{ title: string; rating: number; body: string; date: string; verified: boolean }>;
}
```

## Modified Files

### `src/session.ts`

- Import `RssConnector`, `GoogleTrendsConnector`, `AmazonReviewsConnector` from `@buffr/connectors`
- Import the three tool factories from `./connector-tools/`
- Instantiate connectors with default transports (no config needed — they use Node's built-in `fetch`)
- Register all four tools in `InMemoryToolRegistry`

### `package.json` (root)

- Add `"@buffr/connectors": "0.0.1"` to `dependencies`

## Dependencies

`src/connector-tools/*.ts` imports:
- `ToolDefinition`, `ToolHandler` from `@buffr/kernel` (already a root dep)
- `RssConnector` / `GoogleTrendsConnector` / `AmazonReviewsConnector` from `@buffr/connectors` (new root dep)

## Testing

One test file per tool factory in `test/connector-tools/`:
- `rss-tool.test.ts` — stub connector, verify tool name, schema shape, and handler output format
- `trends-tool.test.ts` — same pattern
- `amazon-tool.test.ts` — same pattern

Tests use stub connectors (not stub transports) — pass a mock `RssConnector` whose `fetch()` returns canned data. No HTTP calls.

## What Does Not Change

- `@buffr/kernel` — untouched
- `@buffr/connectors` — untouched
- The existing `search_knowledge_base` tool — untouched, still registered
