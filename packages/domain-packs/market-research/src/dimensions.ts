import type { AnalysisDimension } from '@buffr/contracts';

export const MARKET_RESEARCH_DIMENSIONS: AnalysisDimension[] = [
  {
    id: 'frequency',
    label: 'Frequency',
    description:
      'How often this pain point is mentioned across search queries, forum posts, and product complaints. ' +
      'High frequency means many people face it, not just a vocal minority.',
    weight: 0.30,
  },
  {
    id: 'trend-velocity',
    label: 'Trend Velocity',
    description:
      'Is interest in this problem rising, stable, or declining? ' +
      'Rising problems represent better opportunities than peaked ones — the market is still forming.',
    weight: 0.25,
  },
  {
    id: 'specificity',
    label: 'Specificity',
    description:
      'Is the problem concrete enough to build a targeted solution? ' +
      'Vague complaints ("too hard to use") score low. Specific ones ("no bulk CSV import for product variants") score high.',
    weight: 0.20,
  },
  {
    id: 'monetizability',
    label: 'Monetizability',
    description:
      'Does a clear, sellable solution exist — a template, digital download, or app feature — that people would pay for? ' +
      'Assess whether the problem maps to a concrete product.',
    weight: 0.25,
  },
];
