import type { ToolDefinition, ToolHandler } from '@buffr/kernel';
import type { DataConnector, GoogleSearchParams, GoogleSearchData } from '@buffr/connectors';

export function createGoogleSearchTool(
  connector: DataConnector<GoogleSearchParams, GoogleSearchData>,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'web_search_google',
    description: 'Search the web using Google Custom Search and return ranked results with titles, URLs, and snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        count: { type: 'integer', description: 'Number of results to return (1–10).', default: 5 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };

  const handler: ToolHandler = async (args) => {
    const query = typeof args['query'] === 'string' ? args['query'] : '';
    const count = typeof args['count'] === 'number' && args['count'] > 0 ? Math.min(args['count'], 10) : 5;
    const result = await connector.fetch({ query, count });
    return {
      query: result.data.query,
      fetchedAt: result.fetchedAt,
      results: result.data.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      })),
    };
  };

  return { definition, handler };
}
