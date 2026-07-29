import type { DataConnector } from '@buffr/connectors';
import type { ModelProvider, ConversationMemory } from '@buffr/kernel';
import type { AnalysisFinding } from '@buffr/capabilities';
import type { ScoredMetric } from '@buffr/capabilities';
import type { Evidence } from '@buffr/contracts';

export type InvestingSource = {
  connector: DataConnector<unknown, unknown>;
  paramsFor: (ticker: string, entityType: 'company' | 'etf') => unknown;
  optional?: boolean;
};

export type InvestingEngineOptions = {
  model: ModelProvider;
  sources: InvestingSource[];
  memory?: ConversationMemory;
};

export type InvestingInput = {
  ticker: string;
  entityType: 'company' | 'etf';
  conversationId?: string;
  decision?: string;
  thesis?: string;
  timeHorizon?: string;
};

export type InvestingOutput = {
  summary: {
    ticker: string;
    entityType: 'company' | 'etf';
    totalScore: number;
    confidence: number;
    explanation: string;
    keyLessons: string[];
    actionableNext: string[];
    warnings: string[];
  };
  detail: {
    findings: AnalysisFinding[];
    metrics: ScoredMetric[];
    evidence: Evidence[];
    failed: Array<{ sourceId: string; reason: string }>;
    journalEntryId?: string;
  };
};
