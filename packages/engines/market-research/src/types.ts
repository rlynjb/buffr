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
  | { type: 'engine-start'; label: string }
  | { type: 'connector-start'; id: string; label: string }
  | { type: 'connector-done';  id: string; label: string; count: number }
  | { type: 'connector-failed'; id: string; label: string; optional: boolean }
  | { type: 'stage-start'; id: string; label: string; model?: string }
  | { type: 'stage-done';  id: string; detail: string };

export type MarketResearchCollectInput = {
  topic: string;
  conversationId?: string;
  onStatus?: (msg: string) => void;
  onProgress?: (event: ProgressEvent) => void;
};

export type MarketResearchEvaluateOptions = {
  onStatus?: (msg: string) => void;
  onPartial?: (text: string) => void;
  onProgress?: (event: ProgressEvent) => void;
};

export type EvidenceDigestSource = {
  source: string;
  count: number;
  titles: string[];
};

export type EvidenceDigest = {
  totalCount: number;
  sources: EvidenceDigestSource[];
};

/**
 * Result of collect(). Contains only evidence + a safe digest — no
 * interpretation. evaluate() assumes evidence.length > 0 (the caller checks
 * digest.totalCount before prompting for a prediction and calling evaluate()).
 */
export type CollectedResearch = {
  topic: string;
  conversationId?: string;
  evidence: Evidence[];
  failed: Array<{ sourceId: string; reason: string }>;
  digest: EvidenceDigest;
  warnings: string[];
};

export type ResearchDimensionId = 'frequency' | 'trend-velocity' | 'specificity' | 'monetizability';

export type ResearchPrediction = {
  expectedScore: number;
  expectedDimension: ResearchDimensionId;
  confidence: number;
};

export type PredictionComparison = {
  prediction: ResearchPrediction;
  actualScore: number;
  actualDimension: string;
  scoreGap: number;
  dimensionMatched: boolean;
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
    principle: string;
    reflectionQuestion: string;
  };
  detail: {
    findings: AnalysisFinding[];
    metrics: ScoredMetric[];
    evidence: Evidence[];
    failed: Array<{ sourceId: string; reason: string }>;
  };
  comparison: PredictionComparison;
};
