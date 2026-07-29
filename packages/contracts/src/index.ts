export interface AgentContext {
  userId: string;
  workspaceId: string;
  traceId: string;
  domain: string;
  now: string;
  permissions: string[];
}

export interface Evidence {
  sourceId: string;
  sourceType: string;
  title?: string;
  url?: string;
  excerpt?: string;
  retrievedAt: string;
  freshness?: 'live' | 'recent' | 'stale' | 'unknown';
}

export interface AgentResult<T> {
  data: T;
  confidence: number;
  evidence: Evidence[];
  assumptions: string[];
  warnings: string[];
  traceId: string;
  promptVersion?: string;
  model?: string;
  latencyMs?: number;
  estimatedCostUsd?: number;
}

export interface Capability<TInput, TOutput> {
  name: string;
  version: string;
  execute(input: TInput, context: AgentContext): Promise<AgentResult<TOutput>>;
}

export interface Engine<TInput, TOutput> {
  id: string;
  version: string;
  run(input: TInput, context: AgentContext): Promise<AgentResult<TOutput>>;
}

export interface AnalysisDimension {
  id: string;
  label: string;
  description: string;
  weight?: number;
}

export interface AnalyzeInput<T> {
  subject: T;
  evidence: Evidence[];
  dimensions: AnalysisDimension[];
  instructions?: string[];
}

export interface AnalyzeOutput {
  findings: Array<{
    dimensionId: string;
    summary: string;
    positives: string[];
    negatives: string[];
    unknowns: string[];
    confidence: number;
    evidenceIds: string[];
  }>;
}

export interface ScoreMetric {
  id: string;
  label: string;
  weight: number;
  direction: 'higher-is-better' | 'lower-is-better';
  min: number;
  max: number;
}

export interface ScorecardDefinition {
  id: string;
  version: string;
  metrics: ScoreMetric[];
  minimumEvidenceCount?: number;
  confidencePenalty?: number;
}

export interface DecisionJournalEntry {
  id: string;
  userId: string;
  workspaceId: string;
  domain: string;
  subjectType: string;
  subjectId: string;
  createdAt: string;
  decision: string;
  thesis: string;
  expectedOutcome: string;
  timeHorizon?: string;
  confidence: number;
  assumptions: string[];
  risks: string[];
  evidenceIds: string[];
  emotionalState?: string;
  status: 'open' | 'review-due' | 'reviewed';
  reviewAt?: string;
}

export interface EvalCase<TInput, TExpected> {
  id: string;
  domain: string;
  capabilityOrEngine: string;
  input: TInput;
  expected: TExpected;
  rubric: string[];
  tags: string[];
  sourceSnapshotIds?: string[];
}

export type SourcePolicy = {
  sourceType: string;
  priority: number;
  freshnessRequirement?: 'live' | 'recent' | 'stale' | 'unknown';
  notes?: string;
};

export interface DomainPack {
  id: string;
  version: string;
  entities: Record<string, unknown>;
  scorecards: Record<string, ScorecardDefinition>;
  dimensions: Record<string, AnalysisDimension[]>;
  sourcePolicies: SourcePolicy[];
  prompts: Record<string, string>;
  evalDatasets: string[];
}
