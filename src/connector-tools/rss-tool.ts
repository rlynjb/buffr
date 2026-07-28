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
