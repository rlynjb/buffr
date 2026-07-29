export type CompanyEntity = {
  ticker: string;
  name: string;
  exchange: string;
  sector?: string;
  industry?: string;
  marketCapUsd?: number;
  description?: string;
};

export type EtfEntity = {
  ticker: string;
  name: string;
  issuer: string;
  expenseRatioPct?: number;
  aumUsd?: number;
  indexTracked?: string;
  assetClass?: 'equity' | 'bond' | 'commodity' | 'real-estate' | 'mixed';
  description?: string;
};

export const INVESTING_ENTITIES: Record<string, unknown> = {
  company: {} as CompanyEntity,
  etf: {} as EtfEntity,
};
