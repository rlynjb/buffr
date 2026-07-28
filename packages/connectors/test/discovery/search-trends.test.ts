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
