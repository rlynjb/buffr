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
    assert.deepStrictEqual((definition.inputSchema as Record<string, unknown>)['required'], ['url']);
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
    await handler({ url: 'https://example.com/feed', limit: 5 } as Record<string, unknown>);
    assert.strictEqual((capturedParams as unknown as RssParams)?.limit, 5);
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
    await handler({ url: 'https://example.com/feed' } as Record<string, unknown>);
    assert.strictEqual((capturedParams as unknown as RssParams)?.limit, 10);
  });
});
