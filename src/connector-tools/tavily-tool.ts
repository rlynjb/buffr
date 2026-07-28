import type { ToolDefinition, ToolHandler } from '@buffr/kernel';
import type { DataConnector, TavilySearchParams, TavilySearchData } from '@buffr/connectors';

export function createTavilySearchTool(
  connector: DataConnector<TavilySearchParams, TavilySearchData>,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'web_search_tavily',
    description: 'Search the web using Tavily (AI-optimised search) and return relevant results with rich content excerpts. Prefer this for factual questions and research.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        max_results: { type: 'integer', description: 'Number of results to return (1–10).', default: 5 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };

  const handler: ToolHandler = async (args) => {
    const query = typeof args['query'] === 'string' ? args['query'] : '';
    const maxResults = typeof args['max_results'] === 'number' && args['max_results'] > 0
      ? Math.min(args['max_results'], 10) : 5;
    const result = await connector.fetch({ query, maxResults });
    return {
      query: result.data.query,
      fetchedAt: result.fetchedAt,
      answer: result.data.answer,
      results: result.data.results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        publishedDate: r.publishedDate,
      })),
    };
  };

  return { definition, handler };
}
