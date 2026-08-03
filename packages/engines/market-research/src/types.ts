import type { DataConnector } from '@buffr/connectors';
import type { ModelProvider, ConversationMemory } from '@buffr/kernel';
import type { AnalysisFinding, ScoredMetric } from '@buffr/capabilities';
import type { Evidence } from '@buffr/contracts';

export type MarketResearchSource = {
  connector: DataConnector<unknown, unknown>;
  paramsFor: (topic: string) => unknown;
  optional?: boolean;
};

export type MarketResearchEngineOptions = {
  model: ModelProvider;
  sources: MarketResearchSource[];
  memory?: ConversationMemory;
};

export type ProgressEvent =
  | { type: 'connector-start'; id: string; label: string }
  | { type: 'connector-done';  id: string; label: string; count: number }
  | { type: 'connector-failed'; id: string; label: string; optional: boolean }
  | { type: 'stage-start'; id: string; label: string }
  | { type: 'stage-done';  id: string; detail: string };

export type MarketResearchInput = {
  topic: string;
  conversationId?: string;
  onStatus?: (msg: string) => void;
  onPartial?: (text: string) => void;
  onProgress?: (event: ProgressEvent) => void;
};

export type MarketResearchOutput = {
  summary: {
    topic: string;
    totalScore: number;
    confidence: number;
    explanation: string;
    keyProblems: string[];
    productAngles: string[];
    warnings: string[];
  };
  detail: {
    findings: AnalysisFinding[];
    metrics: ScoredMetric[];
    evidence: Evidence[];
    failed: Array<{ sourceId: string; reason: string }>;
  };
};
