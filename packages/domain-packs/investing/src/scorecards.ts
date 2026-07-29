import type { ScorecardDefinition } from '@buffr/contracts';

export const COMPANY_SCORECARD: ScorecardDefinition = {
  id: 'investing-company-v1',
  version: '1.0.0',
  metrics: [
    { id: 'business-quality',   label: 'Business Quality',   weight: 0.25, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'financial-strength', label: 'Financial Strength', weight: 0.20, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'growth-durability',  label: 'Growth Durability',  weight: 0.15, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'valuation',          label: 'Valuation',          weight: 0.20, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'risk',               label: 'Risk',               weight: 0.20, direction: 'lower-is-better',  min: 0, max: 100 },
  ],
  minimumEvidenceCount: 5,
  confidencePenalty: 0.8,
};

export const ETF_SCORECARD: ScorecardDefinition = {
  id: 'investing-etf-v1',
  version: '1.0.0',
  metrics: [
    { id: 'holdings-quality', label: 'Holdings Quality', weight: 0.30, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'expense-ratio',    label: 'Expense Ratio',    weight: 0.25, direction: 'lower-is-better',  min: 0, max: 100 },
    { id: 'diversification',  label: 'Diversification',  weight: 0.20, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'liquidity',        label: 'Liquidity',        weight: 0.15, direction: 'higher-is-better', min: 0, max: 100 },
    { id: 'tracking-error',   label: 'Tracking Error',   weight: 0.10, direction: 'lower-is-better',  min: 0, max: 100 },
  ],
  minimumEvidenceCount: 5,
  confidencePenalty: 0.8,
};
