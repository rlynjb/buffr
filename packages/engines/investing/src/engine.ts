import type { Engine, AgentContext, AgentResult } from '@buffr/contracts';
import type { InvestingInput, InvestingOutput, InvestingEngineOptions } from './types.js';

export class InvestingEngine implements Engine<InvestingInput, InvestingOutput> {
  readonly id = 'investing-engine';
  readonly version = '1.0.0';

  constructor(_opts: InvestingEngineOptions) {}

  async run(_input: InvestingInput, _context: AgentContext): Promise<AgentResult<InvestingOutput>> {
    throw new Error('Not implemented');
  }
}
