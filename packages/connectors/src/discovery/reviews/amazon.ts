import { load } from 'cheerio';
import type { Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult, FetchOptions } from '../../contracts.js';
import { inferFreshness } from '../_freshness.js';

export type AmazonReviewsParams = { asin: string; limit?: number };

export type AmazonReview = {
  id: string;
  title: string;
  body: string;
  rating: number;
  date: string;
  verified: boolean;
  helpful?: number;
};

export type AmazonReviewsResult = {
  asin: string;
  productTitle?: string;
  reviews: AmazonReview[];
};

export type AmazonTransport = (asin: string, signal?: AbortSignal) => Promise<string>;

async function defaultAmazonFetch(asin: string, signal?: AbortSignal): Promise<string> {
  const url = `https://www.amazon.com/product-reviews/${asin}?sortBy=recent&pageNumber=1`;
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; buffr-connector/0.0.1)',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`Amazon fetch failed: ${res.status} ${res.statusText}`);
  return res.text();
}

function parseRating(text: string): number {
  const match = /(\d(?:\.\d)?) out of/.exec(text);
  return match ? parseFloat(match[1]!) : 0;
}

function parseReviewDate(text: string): string {
  // e.g. "Reviewed in the United States on January 15, 2024"
  const match = /on (.+)$/.exec(text);
  if (!match) return new Date(0).toISOString();
  const parsed = Date.parse(match[1]!);
  return Number.isNaN(parsed) ? new Date(0).toISOString() : new Date(parsed).toISOString();
}

export class AmazonReviewsConnector implements DataConnector<AmazonReviewsParams, AmazonReviewsResult> {
  readonly id = 'discovery.reviews.amazon';

  constructor(private readonly transport: AmazonTransport = defaultAmazonFetch) {}

  async fetch(params: AmazonReviewsParams, opts?: FetchOptions): Promise<ConnectorResult<AmazonReviewsResult>> {
    const html = await this.transport(params.asin, opts?.signal);
    const $ = load(html);

    const productTitle = $('[data-hook="product-link"]').first().text().trim() || undefined;
    const reviews: AmazonReview[] = [];

    $('[data-hook="review"]').each((_i, el) => {
      if (params.limit != null && reviews.length >= params.limit) return false;

      const id = $(el).attr('id') ?? `${params.asin}-${reviews.length}`;
      const title = $('[data-hook="review-title"]', el).text().trim();
      const body = $('[data-hook="review-body"]', el).text().trim();
      const rating = parseRating($('[data-hook="review-star-rating"] .a-icon-alt', el).first().text());
      const date = parseReviewDate($('[data-hook="review-date"]', el).text().trim());
      const verified = $('[data-hook="avp-badge"]', el).length > 0;
      const helpfulText = $('[data-hook="helpful-vote-statement"]', el).text();
      const helpfulMatch = /(\d+)/.exec(helpfulText);

      reviews.push({
        id,
        title,
        body,
        rating,
        date,
        verified,
        helpful: helpfulMatch ? parseInt(helpfulMatch[1]!, 10) : undefined,
      });
    });

    const fetchedAt = new Date().toISOString();
    const data: AmazonReviewsResult = { asin: params.asin, productTitle, reviews };

    return {
      data,
      fetchedAt,
      sourceId: `amazon:reviews:${params.asin}`,
      toEvidence(): Evidence[] {
        return reviews.map((review) => ({
          sourceId: `amazon:${params.asin}:${review.id}`,
          sourceType: 'reviews-amazon',
          title: review.title,
          excerpt: `${review.rating}/5 — ${review.body.slice(0, 300)}`,
          retrievedAt: fetchedAt,
          freshness: inferFreshness(review.date),
        }));
      },
    };
  }
}
