import type { AgentContext, AgentResult, Capability, ScorecardDefinition, ScoreMetric } from '@buffr/contracts';
import type { AnalysisFinding } from '../analyzer/index.js';

export type { ScorecardDefinition, ScoreMetric } from '@buffr/contracts';

export type ScoredMetric = {
  id: string;
  label: string;
  rawScore: number;
  weightedScore: number;
  weight: number;
};

export type ScorerInput = {
  findings: AnalysisFinding[];
  scorecard: ScorecardDefinition;
  evidenceCount: number;
};

export type ScorerOutput = {
  metrics: ScoredMetric[];
  totalScore: number;
  confidence: number;
  warnings: string[];
  evidenceCoverage: string;
};

export class Scorer implements Capability<ScorerInput, ScorerOutput> {
  readonly name = 'scorer';
  readonly version = '1.0.0';

  async execute(input: ScorerInput, context: AgentContext): Promise<AgentResult<ScorerOutput>> {
    const { findings, scorecard, evidenceCount } = input;
    const warnings: string[] = [];
    const metrics: ScoredMetric[] = [];
    let totalScore = 0;
    let confidenceSum = 0;
    let confidenceCount = 0;

    for (const metric of scorecard.metrics) {
      const finding = findings.find(f => f.dimensionId === metric.id);
      if (!finding) {
        warnings.push(`No finding for dimension '${metric.id}' (${metric.label}); contributing 0 to score.`);
        metrics.push({ id: metric.id, label: metric.label, rawScore: 0, weightedScore: 0, weight: metric.weight });
        continue;
      }

      const rawScore = metric.direction === 'lower-is-better'
        ? 100 - finding.score
        : finding.score;

      const weightedScore = rawScore * metric.weight;
      totalScore += weightedScore;
      confidenceSum += finding.confidence;
      confidenceCount += 1;
      metrics.push({ id: metric.id, label: metric.label, rawScore, weightedScore, weight: metric.weight });
    }

    const meanConfidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 0;
    const minRequired = scorecard.minimumEvidenceCount;
    const penalised = minRequired !== undefined && evidenceCount < minRequired;
    const confidence = penalised ? meanConfidence * (scorecard.confidencePenalty ?? 0.8) : meanConfidence;

    const evidenceCoverage = minRequired !== undefined
      ? `${evidenceCount} / ${minRequired} required signals`
      : `${evidenceCount} / ${evidenceCount} required signals`;

    return {
      data: { metrics, totalScore, confidence, warnings, evidenceCoverage },
      confidence,
      evidence: [],
      assumptions: [],
      warnings,
      traceId: context.traceId,
    };
  }
}
