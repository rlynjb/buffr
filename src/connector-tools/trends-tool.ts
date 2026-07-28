import type { ToolDefinition, ToolHandler } from '@buffr/kernel';
import type { DataConnector, TrendsParams, TrendResult } from '@buffr/connectors';

export function createFetchTrendsTool(
  connector: DataConnector<TrendsParams, TrendResult[]>,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'fetch_search_trends',
    description: 'Fetch Google Trends interest-over-time data for one or more keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords:  { type: 'array', items: { type: 'string' }, description: 'Keywords to look up (1–5).' },
        geo:       { type: 'string', description: 'Country code (e.g. "US") or "" for worldwide.', default: '' },
        timeframe: { type: 'string', description: 'Time window, e.g. "now 7-d" or "today 12-m".', default: 'now 7-d' },
      },
      required: ['keywords'],
      additionalProperties: false,
    },
  };

  const handler: ToolHandler = async (args) => {
    const keywords  = Array.isArray(args['keywords']) ? (args['keywords'] as string[]) : [];
    const geo       = typeof args['geo'] === 'string' ? args['geo'] : '';
    const timeframe = typeof args['timeframe'] === 'string' ? args['timeframe'] : 'now 7-d';
    const result = await connector.fetch({ keywords, geo, timeframe });
    return {
      fetchedAt: result.fetchedAt,
      trends: result.data.map((t) => ({
        keyword:         t.keyword,
        averageInterest: t.averageInterest,
        timeframe:       t.timeframe,
        geo:             t.geo,
      })),
    };
  };

  return { definition, handler };
}
