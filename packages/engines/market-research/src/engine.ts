import { Collector, Analyzer, Scorer, Teacher } from '@buffr/capabilities';
import type { AgentContext, AgentResult, Evidence } from '@buffr/contracts';
import type { ConversationMemory } from '@buffr/kernel';
import {
  MARKET_RESEARCH_DIMENSIONS,
  MARKET_RESEARCH_SCORECARD,
  MARKET_RESEARCH_PROMPTS,
} from '@buffr/domain-pack-market-research';
import type {
  MarketResearchCollectInput, MarketResearchEvaluateOptions, MarketResearchOutput,
  MarketResearchSource, MarketResearchEngineOptions, CollectedResearch, EvidenceDigest,
  EvidenceDigestSource, ResearchPrediction, PredictionComparison,
} from './types.js';

export class MarketResearchEngine {
  readonly id = 'market-research-engine';
  readonly version = '1.0.0';

  private readonly collector: Collector;
  private readonly analyzer: Analyzer;
  private readonly scorer: Scorer;
  private readonly teacher: Teacher;
  private readonly sources: MarketResearchSource[];
  private readonly memory?: ConversationMemory;
  private readonly modelId: string;

  constructor(opts: MarketResearchEngineOptions) {
    this.collector = new Collector();
    this.analyzer = new Analyzer(opts.model);
    this.scorer = new Scorer();
    this.teacher = new Teacher(opts.model);
    this.sources = opts.sources;
    this.memory = opts.memory;
    this.modelId = opts.model.id;
  }

  private static friendlyName(connectorId: string): string {
    const map: Record<string, string> = {
      'discovery.google-trends': 'Google Trends',
      'discovery.google-search': 'Google Search',
      'discovery.reddit-search': 'Reddit',
      'discovery.brave-search': 'Brave Search',
      'discovery.tavily-search': 'Tavily',
    };
    // strip CachedConnector wrapper id prefix if present
    const base = connectorId.replace(/^cached:/, '');
    return map[base] ?? connectorId;
  }

  /**
   * Gathers evidence and returns a safe digest (count, source, titles only —
   * no findings, scores, or synthesized text). Runs each source through the
   * (unchanged) Collector separately so the digest can be grouped by source
   * while keeping full cross-source parallelism.
   */
  async collect(input: MarketResearchCollectInput, context: AgentContext): Promise<AgentResult<CollectedResearch>> {
    const status = input.onStatus ?? (() => {});
    const progress = input.onProgress;

    progress?.({ type: 'engine-start', label: 'Market Research Engine' });

    const collectorSources = this.sources.map(s => ({
      connector: s.connector,
      params: s.paramsFor(input.topic),
      optional: s.optional ?? false,
    }));

    const sourceNames = collectorSources.map(s => MarketResearchEngine.friendlyName(s.connector.id)).join(' · ');
    status(`fetching ${sourceNames}…`);

    const allEvidence: Evidence[] = [];
    const allFailed: Array<{ sourceId: string; reason: string }> = [];
    const allWarnings: string[] = [];
    const digestSources: EvidenceDigestSource[] = [];

    await Promise.all(collectorSources.map(async (source) => {
      const label = MarketResearchEngine.friendlyName(source.connector.id);
      const result = await this.collector.execute({
        sources: [source],
        onEvent: progress ? (e) => {
          if (e.type === 'start') {
            progress({ type: 'connector-start', id: e.sourceId, label });
          } else if (e.type === 'done') {
            progress({ type: 'connector-done', id: e.sourceId, label, count: e.count });
          } else {
            progress({ type: 'connector-failed', id: e.sourceId, label, optional: e.optional });
          }
        } : undefined,
      }, context);

      const { evidence, failed } = result.data;
      allEvidence.push(...evidence);
      allFailed.push(...failed);
      allWarnings.push(...result.warnings);
      if (evidence.length > 0) {
        digestSources.push({ source: label, count: evidence.length, titles: evidence.map(e => e.title ?? e.sourceId) });
      }
    }));

    const digest: EvidenceDigest = { totalCount: allEvidence.length, sources: digestSources };

    return {
      data: {
        topic: input.topic,
        conversationId: input.conversationId,
        evidence: allEvidence,
        failed: allFailed,
        digest,
        warnings: allWarnings,
      },
      confidence: 1,
      evidence: allEvidence,
      assumptions: [],
      warnings: allWarnings,
      traceId: context.traceId,
    };
  }

  /**
   * Runs Analyzer -> Scorer -> Teacher and computes the prediction
   * comparison in code (never asks the model to invent the gap). Assumes
   * collected.evidence.length > 0 — the caller must check
   * collected.digest.totalCount before calling this.
   */
  async evaluate(
    collected: CollectedResearch,
    prediction: ResearchPrediction,
    opts: MarketResearchEvaluateOptions,
    context: AgentContext,
  ): Promise<AgentResult<MarketResearchOutput>> {
    const partial = opts.onPartial ?? (() => {});
    const status = opts.onStatus ?? (() => {});
    const progress = opts.onProgress;
    const { evidence, failed, topic, conversationId } = collected;

    partial('Analyzing…');
    status(`analyzing ${evidence.length} results…`);
    progress?.({ type: 'stage-start', id: 'analyzer', label: 'Analyzer', model: this.modelId });
    const analyzerResult = await this.analyzer.execute(
      {
        subjectDescription: topic,
        evidence,
        dimensions: MARKET_RESEARCH_DIMENSIONS,
        instructions: [MARKET_RESEARCH_PROMPTS['analyzer-context']],
      },
      context,
    );
    progress?.({ type: 'stage-done', id: 'analyzer', detail: `${analyzerResult.data.findings.length} findings` });

    const findingsText = analyzerResult.data.findings.map(f =>
      `  ${f.dimensionId.padEnd(18)} ${String(Math.round(f.score)).padStart(3)}/100  ${f.summary}`
    ).join('\n');
    partial(`Findings:\n${findingsText}\n\nScoring…`);
    status('scoring…');
    progress?.({ type: 'stage-start', id: 'scorer', label: 'Scorer' });
    const scorerResult = await this.scorer.execute(
      { findings: analyzerResult.data.findings, scorecard: MARKET_RESEARCH_SCORECARD, evidenceCount: evidence.length },
      context,
    );
    progress?.({ type: 'stage-done', id: 'scorer', detail: `${Math.round(scorerResult.data.totalScore)}/100` });

    partial(`Findings:\n${findingsText}\n\nScore: ${Math.round(scorerResult.data.totalScore)}/100 · Confidence: ${Math.round(scorerResult.data.confidence * 100)}%\n\nSummarizing…`);
    status('summarizing…');
    progress?.({ type: 'stage-start', id: 'teacher', label: 'Teacher', model: this.modelId });
    const allWarnings = [...collected.warnings, ...scorerResult.data.warnings];
    const teacherResult = await this.teacher.execute(
      {
        subjectDescription: topic,
        findings: analyzerResult.data.findings,
        totalScore: scorerResult.data.totalScore,
        confidence: scorerResult.data.confidence,
        warnings: allWarnings,
        audience: 'solo creator building digital products and Shopify apps',
        instructions: [MARKET_RESEARCH_PROMPTS['teacher-context']],
      },
      context,
    );
    progress?.({ type: 'stage-done', id: 'teacher', detail: 'done' });

    if (this.memory && conversationId) {
      const memoryAnswer = `${teacherResult.data.explanation}\n\nTop problems: ${teacherResult.data.keyLessons.join('; ')}`;
      await this.memory.remember({ conversationId, question: `Research market: ${topic}`, answer: memoryAnswer });
    }

    const keyProblems = teacherResult.data.keyLessons.length > 0
      ? teacherResult.data.keyLessons
      : analyzerResult.data.findings.flatMap(f => f.negatives).filter(Boolean).slice(0, 5);

    const productAngles = teacherResult.data.actionableNext.length > 0
      ? teacherResult.data.actionableNext
      : analyzerResult.data.findings.flatMap(f => f.positives).filter(Boolean).slice(0, 5);

    const explanation = teacherResult.data.explanation.trim() ||
      analyzerResult.data.findings.map(f => `${f.dimensionId}: ${f.summary}`).join(' ');

    const strongestFinding = analyzerResult.data.findings.reduce(
      (max, f) => (f.score > max.score ? f : max),
      analyzerResult.data.findings[0]!,
    );
    const comparison: PredictionComparison = {
      prediction,
      actualScore: scorerResult.data.totalScore,
      actualDimension: strongestFinding.dimensionId,
      scoreGap: scorerResult.data.totalScore - prediction.expectedScore,
      dimensionMatched: strongestFinding.dimensionId === prediction.expectedDimension,
    };

    return {
      data: {
        summary: {
          topic,
          totalScore: scorerResult.data.totalScore,
          confidence: scorerResult.data.confidence,
          explanation,
          keyProblems,
          productAngles,
          warnings: allWarnings,
          principle: teacherResult.data.principle,
          reflectionQuestion: teacherResult.data.reflectionQuestion,
        },
        detail: {
          findings: analyzerResult.data.findings,
          metrics: scorerResult.data.metrics,
          evidence,
          failed,
        },
        comparison,
      },
      confidence: scorerResult.data.confidence,
      evidence,
      assumptions: analyzerResult.data.findings.flatMap(f => f.unknowns),
      warnings: allWarnings,
      traceId: context.traceId,
    };
  }
}
