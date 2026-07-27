// packages/kernel/src/retrieval/search-tool.ts
import type { ToolDefinition, ToolHandler } from '../tool-runtime/registry.js';
import type { VectorHit } from './contracts.js';
import type { RetrievalPipeline } from './pipeline.js';

export const SEARCH_KNOWLEDGE_BASE_TOOL_NAME = 'search_knowledge_base';

export type SearchKnowledgeBaseResult = { id: string; score: number; citation: string; meta: Record<string, unknown> };
export type SearchKnowledgeBaseOutput = { query: string; results: SearchKnowledgeBaseResult[] };

export type SearchKnowledgeBaseToolOptions = { defaultTopK?: number; minTopK?: number };

export function createSearchKnowledgeBaseTool(
  pipeline: RetrievalPipeline,
  options: SearchKnowledgeBaseToolOptions = {},
): { definition: ToolDefinition; handler: ToolHandler } {
  const defaultTopK = options.defaultTopK ?? 5;
  const minTopK = Math.max(1, options.minTopK ?? 1);

  const definition: ToolDefinition = {
    name: SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
    description: 'Search the indexed knowledge base for passages relevant to a query and return ranked chunks with citations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The natural-language search query.' },
        top_k: { type: 'integer', description: 'Max number of ranked results to return.', default: 5 },
        filter: { type: 'object', description: 'Optional exact-match filter over chunk metadata.', additionalProperties: true },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };

  const handler: ToolHandler = async (args): Promise<SearchKnowledgeBaseOutput> => {
    const query = typeof args['query'] === 'string' ? args['query'] : '';
    const requestedTopK = typeof args['top_k'] === 'number' && args['top_k'] > 0 ? args['top_k'] : defaultTopK;
    const topK = Math.max(requestedTopK, minTopK);
    const filter =
      args['filter'] && typeof args['filter'] === 'object' && !Array.isArray(args['filter'])
        ? (args['filter'] as Record<string, unknown>) : undefined;
    const fetchK = filter ? topK * 4 : topK;
    let hits = await pipeline.query(query, fetchK);
    if (filter) hits = hits.filter((h) => matchesFilter(h, filter)).slice(0, topK);
    return { query, results: hits.map(toResult) };
  };

  return { definition, handler };
}

function matchesFilter(hit: VectorHit, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => !(key in hit.meta) || hit.meta[key] === value);
}

function toResult(hit: VectorHit): SearchKnowledgeBaseResult {
  const docId = typeof hit.meta['docId'] === 'string' ? hit.meta['docId'] : hit.id;
  const text = typeof hit.meta['text'] === 'string' ? hit.meta['text'] : '';
  const snippet = text.length > 160 ? `${text.slice(0, 157)}...` : text;
  return { id: hit.id, score: hit.score, citation: snippet ? `[${docId}] ${snippet}` : `[${docId}]`, meta: hit.meta };
}
