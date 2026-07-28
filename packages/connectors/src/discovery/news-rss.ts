import { XMLParser } from 'fast-xml-parser';
import type { Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult, FetchOptions } from '../contracts.js';
import { inferFreshness } from './_freshness.js';

export type RssParams = { url: string; limit?: number };

export type RssArticle = {
  title: string;
  link: string;
  description?: string;
  pubDate?: string;
  guid?: string;
};

export type RssFeed = {
  title: string;
  url: string;
  articles: RssArticle[];
};

export type RssTransport = (url: string, signal?: AbortSignal) => Promise<string>;

async function defaultFetch(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
  return res.text();
}

export class RssConnector implements DataConnector<RssParams, RssFeed> {
  readonly id = 'discovery.news-rss';

  constructor(private readonly transport: RssTransport = defaultFetch) {}

  async fetch(params: RssParams, opts?: FetchOptions): Promise<ConnectorResult<RssFeed>> {
    const xml = await this.transport(params.url, opts?.signal);
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml) as Record<string, unknown>;

    const rss = parsed['rss'] as Record<string, unknown> | undefined;
    if (!rss) throw new Error(`Not a valid RSS 2.0 feed: ${params.url}`);
    const channel = rss['channel'] as Record<string, unknown>;

    const feedTitle = String(channel['title'] ?? '');
    const rawItems: unknown[] = Array.isArray(channel['item'])
      ? (channel['item'] as unknown[])
      : channel['item'] != null ? [channel['item']] : [];

    const articles: RssArticle[] = rawItems.slice(0, params.limit).map((item) => {
      const i = item as Record<string, unknown>;
      return {
        title: String(i['title'] ?? ''),
        link: String(i['link'] ?? ''),
        description: i['description'] != null ? String(i['description']) : undefined,
        pubDate: i['pubDate'] != null ? String(i['pubDate']) : undefined,
        guid: i['guid'] != null ? String(i['guid']) : undefined,
      };
    });

    const fetchedAt = new Date().toISOString();
    const data: RssFeed = { title: feedTitle, url: params.url, articles };

    return {
      data,
      fetchedAt,
      sourceId: `rss:${params.url}`,
      toEvidence(): Evidence[] {
        return articles.map((article) => ({
          sourceId: `rss:${article.guid ?? article.link}`,
          sourceType: 'news-rss',
          title: article.title,
          url: article.link,
          excerpt: article.description?.slice(0, 300),
          retrievedAt: fetchedAt,
          freshness: inferFreshness(article.pubDate),
        }));
      },
    };
  }
}
