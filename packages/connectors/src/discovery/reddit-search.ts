import type { Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult, FetchOptions } from '../contracts.js';

export type RedditSearchParams = {
  query: string;
  subreddits?: string[];
  limit?: number;
  sort?: 'relevance' | 'new' | 'top';
};

export type RedditPost = {
  title: string;
  url: string;
  subreddit: string;
  selftext?: string;
  score: number;
  numComments: number;
  createdUtc: number;
};

export type RedditSearchData = {
  query: string;
  posts: RedditPost[];
};

export type RedditTransport = (
  query: string,
  subreddits: string[],
  limit: number,
  sort: string,
  signal?: AbortSignal,
) => Promise<RedditSearchData>;

async function defaultFetch(
  query: string,
  subreddits: string[],
  limit: number,
  sort: string,
  signal?: AbortSignal,
): Promise<RedditSearchData> {
  const base = subreddits.length === 1
    ? `https://www.reddit.com/r/${subreddits[0]}/search.json`
    : 'https://www.reddit.com/search.json';

  const url = new URL(base);
  url.searchParams.set('q', subreddits.length > 1
    ? `(${subreddits.map(s => `subreddit:${s}`).join(' OR ')}) ${query}`
    : query);
  url.searchParams.set('sort', sort);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('type', 'link');
  if (subreddits.length === 1) url.searchParams.set('restrict_sr', '1');

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'buffr-research-bot/1.0' },
    signal,
  });
  if (!res.ok) throw new Error(`Reddit search HTTP ${res.status}: ${await res.text()}`);

  const json = await res.json() as Record<string, unknown>;
  const listing = json['data'] as { children?: unknown[] } | undefined;
  const raw = listing?.children ?? [];

  const posts: RedditPost[] = raw.map((child) => {
    const c = child as Record<string, unknown>;
    const d = (c['data'] ?? {}) as Record<string, unknown>;
    const selftext = String(d['selftext'] ?? '').trim();
    return {
      title: String(d['title'] ?? ''),
      url: `https://reddit.com${String(d['permalink'] ?? '')}`,
      subreddit: String(d['subreddit'] ?? ''),
      selftext: selftext.length > 0 && selftext !== '[removed]' && selftext !== '[deleted]'
        ? selftext
        : undefined,
      score: Number(d['score'] ?? 0),
      numComments: Number(d['num_comments'] ?? 0),
      createdUtc: Number(d['created_utc'] ?? 0),
    };
  });

  return { query, posts };
}

export class RedditSearchConnector implements DataConnector<RedditSearchParams, RedditSearchData> {
  readonly id = 'discovery.reddit-search';

  constructor(
    private readonly transport: RedditTransport = defaultFetch,
  ) {}

  async fetch(params: RedditSearchParams, opts?: FetchOptions): Promise<ConnectorResult<RedditSearchData>> {
    const limit = params.limit ?? 10;
    const sort = params.sort ?? 'relevance';
    const subreddits = params.subreddits ?? [];
    const data = await this.transport(params.query, subreddits, limit, sort, opts?.signal);
    const fetchedAt = new Date().toISOString();
    return {
      data,
      fetchedAt,
      sourceId: `reddit:${params.query}`,
      toEvidence(): Evidence[] {
        return data.posts.map((p) => ({
          sourceId: `reddit:${p.url}`,
          sourceType: 'web-search',
          title: `[r/${p.subreddit}] ${p.title}`,
          url: p.url,
          excerpt: p.selftext?.slice(0, 400) ?? p.title,
          retrievedAt: fetchedAt,
          freshness: 'unknown' as const,
        }));
      },
    };
  }
}
