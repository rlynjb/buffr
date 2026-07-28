import type { Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult, FetchOptions } from '../contracts.js';

export type GoogleSearchParams = { query: string; count?: number };

export type GoogleSearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

export type GoogleSearchData = {
  query: string;
  results: GoogleSearchResult[];
};

export type GoogleSearchTransport = (
  query: string,
  count: number,
  apiKey: string,
  cx: string,
  signal?: AbortSignal,
) => Promise<GoogleSearchData>;

async function defaultFetch(
  query: string,
  count: number,
  apiKey: string,
  cx: string,
  signal?: AbortSignal,
): Promise<GoogleSearchData> {
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.min(count, 10)));
  const res = await fetch(url.toString(), { signal });
  if (!res.ok) throw new Error(`Google Custom Search HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json() as Record<string, unknown>;
  const raw = Array.isArray(json['items']) ? (json['items'] as unknown[]) : [];
  const results: GoogleSearchResult[] = raw.map((r) => {
    const item = r as Record<string, unknown>;
    return {
      title: String(item['title'] ?? ''),
      url: String(item['link'] ?? ''),
      snippet: item['snippet'] != null ? String(item['snippet']) : undefined,
    };
  });
  return { query, results };
}

export class GoogleSearchConnector implements DataConnector<GoogleSearchParams, GoogleSearchData> {
  readonly id = 'discovery.google-search';

  constructor(
    private readonly apiKey: string,
    private readonly cx: string,
    private readonly transport: GoogleSearchTransport = defaultFetch,
  ) {}

  async fetch(params: GoogleSearchParams, opts?: FetchOptions): Promise<ConnectorResult<GoogleSearchData>> {
    const count = params.count ?? 5;
    const data = await this.transport(params.query, count, this.apiKey, this.cx, opts?.signal);
    const fetchedAt = new Date().toISOString();
    return {
      data,
      fetchedAt,
      sourceId: `google:${params.query}`,
      toEvidence(): Evidence[] {
        return data.results.map((r) => ({
          sourceId: `google:${r.url}`,
          sourceType: 'web-search',
          title: r.title,
          url: r.url,
          excerpt: r.snippet?.slice(0, 300),
          retrievedAt: fetchedAt,
          freshness: 'unknown' as const,
        }));
      },
    };
  }
}
