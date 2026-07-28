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
