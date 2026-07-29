import type { AnalysisDimension } from '@buffr/contracts';

export const COMPANY_DIMENSIONS: AnalysisDimension[] = [
  {
    id: 'business-quality',
    label: 'Business Quality',
    description: 'Assess moat strength, competitive advantages, brand, switching costs, and market position.',
    weight: 0.25,
  },
  {
    id: 'financial-strength',
    label: 'Financial Strength',
    description: 'Assess balance sheet health, free cash flow generation, debt levels, and interest coverage.',
    weight: 0.20,
  },
  {
    id: 'growth-durability',
    label: 'Growth Durability',
    description: 'Assess the sustainability and quality of revenue and earnings growth over a 3–5 year horizon.',
    weight: 0.15,
  },
  {
    id: 'valuation',
    label: 'Valuation',
    description: 'Assess price relative to intrinsic value using P/E, P/FCF, EV/EBITDA, and DCF where evidence allows.',
    weight: 0.20,
  },
  {
    id: 'risk',
    label: 'Risk',
    description: 'Assess macro exposure, regulatory risk, key-person dependency, customer concentration, and competitive threats.',
    weight: 0.20,
  },
];

export const ETF_DIMENSIONS: AnalysisDimension[] = [
  {
    id: 'holdings-quality',
    label: 'Holdings Quality',
    description: 'Assess the quality of underlying securities: profitability, balance sheet strength, and moat.',
    weight: 0.30,
  },
  {
    id: 'expense-ratio',
    label: 'Expense Ratio',
    description: 'Assess the annual cost relative to peer ETFs tracking similar indices or asset classes.',
    weight: 0.25,
  },
  {
    id: 'diversification',
    label: 'Diversification',
    description: 'Assess concentration risk across holdings, sectors, geographies, and factor exposures.',
    weight: 0.20,
  },
  {
    id: 'liquidity',
    label: 'Liquidity',
    description: 'Assess AUM size, average daily volume, and bid-ask spread relative to peers.',
    weight: 0.15,
  },
  {
    id: 'tracking-error',
    label: 'Tracking Error',
    description: 'Assess how closely the ETF tracks its stated index or benchmark over trailing periods.',
    weight: 0.10,
  },
];
