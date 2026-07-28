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
    assert.deepStrictEqual((definition.inputSchema as Record<string, unknown>)['required'], ['keywords']);
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
    await handler({ keywords: ['ethereum'] } as Record<string, unknown>);
    assert.strictEqual((capturedParams as unknown as TrendsParams)?.geo, '');
    assert.strictEqual((capturedParams as unknown as TrendsParams)?.timeframe, 'now 7-d');
  });
});
