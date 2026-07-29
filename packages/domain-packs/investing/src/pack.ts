import type { DomainPack } from '@buffr/contracts';
import { INVESTING_ENTITIES } from './entities.js';
import { COMPANY_DIMENSIONS, ETF_DIMENSIONS } from './dimensions.js';
import { COMPANY_SCORECARD, ETF_SCORECARD } from './scorecards.js';
import { INVESTING_SOURCE_POLICIES } from './source-policies.js';
import { INVESTING_PROMPTS } from './prompts.js';

export const INVESTING_PACK: DomainPack = {
  id: 'investing',
  version: '1.0.0',
  entities: INVESTING_ENTITIES,
  scorecards: {
    company: COMPANY_SCORECARD,
    etf: ETF_SCORECARD,
  },
  dimensions: {
    company: COMPANY_DIMENSIONS,
    etf: ETF_DIMENSIONS,
  },
  sourcePolicies: INVESTING_SOURCE_POLICIES,
  prompts: INVESTING_PROMPTS,
  evalDatasets: ['eval/company-fixtures.json', 'eval/etf-fixtures.json'],
};
