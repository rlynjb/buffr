import type { SourcePolicy } from '@buffr/contracts';

export const INVESTING_SOURCE_POLICIES: SourcePolicy[] = [
  {
    sourceType: 'sec-filing',
    priority: 10,
    freshnessRequirement: 'recent',
    notes: 'SEC 10-K, 10-Q, 8-K filings. Authoritative for financial data.',
  },
  {
    sourceType: 'fund-document',
    priority: 9,
    freshnessRequirement: 'recent',
    notes: 'ETF prospectus, fact sheets, semi-annual reports. Authoritative for fund data.',
  },
  {
    sourceType: 'financial-data',
    priority: 7,
    freshnessRequirement: 'live',
    notes: 'Price feeds, ratio calculators. Live preferred; stale price data triggers a warning.',
  },
  {
    sourceType: 'news-analysis',
    priority: 5,
    freshnessRequirement: 'recent',
    notes: 'Earnings coverage, analyst reports, financial press. Useful for qualitative signals.',
  },
  {
    sourceType: 'social-sentiment',
    priority: 2,
    freshnessRequirement: 'live',
    notes: 'Forums, social media. Low-trust; supplements but does not replace primary sources.',
  },
];
