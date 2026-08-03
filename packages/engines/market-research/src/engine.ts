import type { Engine, AgentContext, AgentResult } from '@buffr/contracts';
import type { MarketResearchInput, MarketResearchOutput, MarketResearchEngineOptions } from './types.js';

export class MarketResearchEngine implements Engine<MarketResearchInput, MarketResearchOutput> {
  readonly id = 'market-research-engine';
  readonly version = '1.0.0';

  constructor(_opts: MarketResearchEngineOptions) {}

  async run(_input: MarketResearchInput, _context: AgentContext): Promise<AgentResult<MarketResearchOutput>> {
    throw new Error('not implemented');
  }
}
