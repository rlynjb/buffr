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
    assert.deepStrictEqual((definition.inputSchema as Record<string, unknown>)['required'], ['asin']);
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
    await handler({ asin: 'B000TEST01', limit: 3 } as Record<string, unknown>);
    assert.strictEqual((capturedParams as unknown as AmazonReviewsParams)?.limit, 3);
  });
});
