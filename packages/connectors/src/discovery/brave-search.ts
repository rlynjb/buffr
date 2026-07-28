import type { Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult, FetchOptions } from '../contracts.js';

export type BraveSearchParams = { query: string; count?: number };

export type BraveSearchResult = {
  title: string;
  url: string;
  description?: string;
  age?: string;
};

export type BraveSearchData = {
  query: string;
  results: BraveSearchResult[];
};

export type BraveTransport = (
  query: string,
  count: number,
  apiKey: string,
  signal?: AbortSignal,
) => Promise<BraveSearchData>;

async function defaultFetch(
  query: string,
  count: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<BraveSearchData> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
    signal,
  });
  if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json() as Record<string, unknown>;
  const web = json['web'] as { results?: unknown[] } | undefined;
  const raw = web?.results ?? [];
  const results: BraveSearchResult[] = raw.map((r) => {
    const item = r as Record<string, unknown>;
    return {
      title: String(item['title'] ?? ''),
      url: String(item['url'] ?? ''),
      description: item['description'] != null ? String(item['description']) : undefined,
      age: item['age'] != null ? String(item['age']) : undefined,
    };
  });
  return { query, results };
}

export class BraveSearchConnector implements DataConnector<BraveSearchParams, BraveSearchData> {
  readonly id = 'discovery.brave-search';

  constructor(
    private readonly apiKey: string,
    private readonly transport: BraveTransport = defaultFetch,
  ) {}

  async fetch(params: BraveSearchParams, opts?: FetchOptions): Promise<ConnectorResult<BraveSearchData>> {
    const count = params.count ?? 5;
    const data = await this.transport(params.query, count, this.apiKey, opts?.signal);
    const fetchedAt = new Date().toISOString();
    return {
      data,
      fetchedAt,
      sourceId: `brave:${params.query}`,
      toEvidence(): Evidence[] {
        return data.results.map((r) => ({
          sourceId: `brave:${r.url}`,
          sourceType: 'web-search',
          title: r.title,
          url: r.url,
          excerpt: r.description?.slice(0, 300),
          retrievedAt: fetchedAt,
          freshness: 'unknown' as const,
        }));
      },
    };
  }
}
