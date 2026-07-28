import type { Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult, FetchOptions } from '../contracts.js';

export type TavilySearchParams = { query: string; maxResults?: number; searchDepth?: 'basic' | 'advanced' };

export type TavilySearchResult = {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string;
};

export type TavilySearchData = {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
};

export type TavilyTransport = (
  query: string,
  maxResults: number,
  searchDepth: string,
  apiKey: string,
  signal?: AbortSignal,
) => Promise<TavilySearchData>;

async function defaultFetch(
  query: string,
  maxResults: number,
  searchDepth: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<TavilySearchData> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: searchDepth }),
    signal,
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json() as Record<string, unknown>;
  const raw = Array.isArray(json['results']) ? (json['results'] as unknown[]) : [];
  const results: TavilySearchResult[] = raw.map((r) => {
    const item = r as Record<string, unknown>;
    return {
      title: String(item['title'] ?? ''),
      url: String(item['url'] ?? ''),
      content: String(item['content'] ?? ''),
      score: typeof item['score'] === 'number' ? item['score'] : 0,
      publishedDate: item['published_date'] != null ? String(item['published_date']) : undefined,
    };
  });
  return {
    query,
    answer: typeof json['answer'] === 'string' ? json['answer'] : undefined,
    results,
  };
}

export class TavilySearchConnector implements DataConnector<TavilySearchParams, TavilySearchData> {
  readonly id = 'discovery.tavily-search';

  constructor(
    private readonly apiKey: string,
    private readonly transport: TavilyTransport = defaultFetch,
  ) {}

  async fetch(params: TavilySearchParams, opts?: FetchOptions): Promise<ConnectorResult<TavilySearchData>> {
    const maxResults = params.maxResults ?? 5;
    const searchDepth = params.searchDepth ?? 'basic';
    const data = await this.transport(params.query, maxResults, searchDepth, this.apiKey, opts?.signal);
    const fetchedAt = new Date().toISOString();
    return {
      data,
      fetchedAt,
      sourceId: `tavily:${params.query}`,
      toEvidence(): Evidence[] {
        return data.results.map((r) => ({
          sourceId: `tavily:${r.url}`,
          sourceType: 'web-search',
          title: r.title,
          url: r.url,
          excerpt: r.content.slice(0, 300),
          retrievedAt: fetchedAt,
          freshness: 'unknown' as const,
        }));
      },
    };
  }
}
