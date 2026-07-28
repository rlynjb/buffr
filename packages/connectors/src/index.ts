export type { DataConnector, ConnectorResult, FetchOptions } from './contracts.js';
export { RssConnector } from './discovery/news-rss.js';
export type { RssParams, RssFeed, RssArticle, RssTransport } from './discovery/news-rss.js';
export { GoogleTrendsConnector } from './discovery/search-trends.js';
export type { TrendsParams, TrendResult, TrendPoint, TrendsRequestOpts, TrendsTransport } from './discovery/search-trends.js';
export { AmazonReviewsConnector } from './discovery/reviews/amazon.js';
export type { AmazonReviewsParams, AmazonReviewsResult, AmazonReview, AmazonTransport } from './discovery/reviews/amazon.js';
