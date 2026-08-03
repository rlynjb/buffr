import type { DomainPack } from '@buffr/contracts';
import { MARKET_RESEARCH_DIMENSIONS } from './dimensions.js';
import { MARKET_RESEARCH_SCORECARD } from './scorecards.js';
import { MARKET_RESEARCH_PROMPTS } from './prompts.js';

export const MARKET_RESEARCH_PACK: DomainPack = {
  id: 'market-research',
  version: '1.0.0',
  entities: {},
  scorecards: { topic: MARKET_RESEARCH_SCORECARD },
  dimensions: { topic: MARKET_RESEARCH_DIMENSIONS },
  sourcePolicies: [],
  prompts: MARKET_RESEARCH_PROMPTS,
  evalDatasets: ['eval/fixtures.json'],
};
