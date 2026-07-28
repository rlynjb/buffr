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
