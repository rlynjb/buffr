# @buffr/connectors — Discovery Group Design

**Date:** 2026-07-27
**Status:** Approved

## Goal

Add a `packages/connectors/` workspace package (`@buffr/connectors`) that fetches data from external sources and returns it as typed raw data with a `toEvidence()` mapper. First group: Discovery — News/RSS, Google Trends, Amazon Reviews.

## Architecture

Single npm workspace package, all connector groups in subdirectories. Connectors depend only on `@buffr/contracts` (for the `Evidence` type), not on `@buffr/kernel`. Every connector accepts an injectable transport so tests run offline and transports can be swapped (e.g. Rainforest API for Amazon) without changing the class.

## Return Type: Option C

```typescript
import type { Evidence } from '@buffr/contracts';

export interface DataConnector<TParams, TData> {
  readonly id: string;
  fetch(params: TParams, options?: FetchOptions): Promise<ConnectorResult<TData>>;
}

export type ConnectorResult<TData> = {
  data: TData;
  fetchedAt: string;       // ISO 8601, set at fetch time
  sourceId: string;
  toEvidence(): Evidence[];
};

export type FetchOptions = { signal?: AbortSignal };
```

`fetchedAt` and `sourceId` are set by the connector at fetch time so `toEvidence()` has the right timestamp without reaching back to the caller.

## File Structure

```
packages/connectors/
  src/
    contracts.ts                       ← DataConnector<P,T>, ConnectorResult<T>, FetchOptions
    discovery/
      _freshness.ts                    ← inferFreshness() helper (internal)
      news-rss.ts                      ← RssConnector
      search-trends.ts                 ← GoogleTrendsConnector
      reviews/
        amazon.ts                      ← AmazonReviewsConnector
    index.ts                           ← re-exports everything public
  test/
    discovery/
      news-rss.test.ts
      search-trends.test.ts
      amazon-reviews.test.ts
  package.json
  tsconfig.json
```

## Connectors

### News/RSS — `RssConnector`

**ID:** `discovery.news-rss`

**Params & data types:**
```typescript
type RssParams  = { url: string; limit?: number };
type RssArticle = { title: string; link: string; description?: string; pubDate?: string; guid?: string };
type RssFeed    = { title: string; url: string; articles: RssArticle[] };
```

**Transport signature:**
```typescript
type RssTransport = (url: string, signal?: AbortSignal) => Promise<string>;
```

Default transport: Node 18 built-in `fetch`. XML parsing: `fast-xml-parser` (pure JS, zero native).

**`toEvidence()` mapping:** one `Evidence` per article — `sourceType: 'news-rss'`, title, excerpt from description (≤300 chars), `freshness` from `pubDate`.

**Tests:** stub transport returns a pre-baked RSS XML string; no network calls.

---

### Google Trends — `GoogleTrendsConnector`

**ID:** `discovery.search-trends.google`

**Params & data types:**
```typescript
type TrendsParams = {
  keywords: string[];
  geo?: string;       // e.g. 'US', '' = worldwide
  timeframe?: string; // e.g. 'now 7-d', 'today 12-m'
};
type TrendPoint  = { date: string; value: number };
type TrendResult = {
  keyword: string;
  geo: string;
  timeframe: string;
  timeline: TrendPoint[];
  averageInterest: number;
};
```

**Transport signature:**
```typescript
type TrendsTransport = (opts: TrendsRequestOpts) => Promise<TrendResult[]>;
```

Default transport: `google-trends-api` npm package (unofficial, free). `averageInterest` computed from timeline mean.

**`toEvidence()` mapping:** one `Evidence` per keyword — `sourceType: 'search-trends'`, `averageInterest` in excerpt.

**Tests:** stub transport returns a pre-baked `TrendResult[]`; no network calls.

---

### Amazon Reviews — `AmazonReviewsConnector`

**ID:** `discovery.reviews.amazon`

Amazon has no public reviews API. Default implementation scrapes `amazon.com/product-reviews/{asin}` via `cheerio`. Injectable transport allows swapping to Rainforest API or another source without changing the class.

**Params & data types:**
```typescript
type AmazonReviewsParams = { asin: string; limit?: number };
type AmazonReview = {
  id: string;
  title: string;
  body: string;
  rating: number;    // 1–5
  date: string;      // ISO 8601
  verified: boolean;
  helpful?: number;
};
type AmazonReviewsResult = {
  asin: string;
  productTitle?: string;
  reviews: AmazonReview[];
};
```

**Transport signature:**
```typescript
type AmazonTransport = (asin: string, signal?: AbortSignal) => Promise<string>;
```

**`toEvidence()` mapping:** one `Evidence` per review — `sourceType: 'reviews-amazon'`, rating + snippet (≤300 chars) in excerpt, `freshness` from review date.

**Tests:** stub transport returns a pre-baked HTML fixture; no network calls. Scraping brittleness is acknowledged — the injectable transport is the mitigation.

---

## Shared Freshness Helper

Internal utility in `src/discovery/_freshness.ts`, consumed by all three connectors:

```typescript
export function inferFreshness(dateStr?: string): Evidence['freshness'] {
  if (!dateStr) return 'unknown';
  const days = (Date.now() - Date.parse(dateStr)) / 86_400_000;
  if (days < 1)  return 'live';
  if (days < 7)  return 'recent';
  return 'stale';
}
```

## npm Dependencies

| Package | Purpose |
|---|---|
| `@buffr/contracts` | `Evidence` type |
| `fast-xml-parser` | RSS XML parsing (pure JS) |
| `google-trends-api` | Unofficial Google Trends |
| `cheerio` | Amazon HTML scraping |

No dependency on `@buffr/kernel`.

## Package Config

```json
{
  "name": "@buffr/connectors",
  "version": "0.0.1",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "dependencies": {
    "@buffr/contracts": "0.0.1",
    "fast-xml-parser": "^4.4.0",
    "google-trends-api": "^4.9.2",
    "cheerio": "^1.0.0"
  }
}
```

## Testing

All tests use `node --test` (no vitest), matching the pattern in `@buffr/kernel`. Every connector has a stub transport — no live network access in tests. Test files live in `test/discovery/`.

## Adding Future Connectors

1. Create a file under the appropriate group subdirectory (e.g. `src/market/alpha-vantage.ts`)
2. Implement `DataConnector<TParams, TData>` with an injectable transport
3. Add a `test/` file with a stub transport
4. Re-export from `src/index.ts`

No changes to contracts or other connectors needed.
