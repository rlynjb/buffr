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
