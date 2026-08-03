import type { ScorecardDefinition } from '@buffr/contracts';

export const MARKET_RESEARCH_SCORECARD: ScorecardDefinition = {
  id: 'market-research-v1',
  version: '1.0.0',
  metrics: [
    { id: 'frequency',      label: 'Frequency',      weight: 0.30, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'trend-velocity', label: 'Trend Velocity',  weight: 0.25, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'specificity',    label: 'Specificity',     weight: 0.20, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'monetizability', label: 'Monetizability',  weight: 0.25, direction: 'higher-is-better', min: 0, max: 100 },
  ],
  minimumEvidenceCount: 4,
  confidencePenalty: 0.8,
};
