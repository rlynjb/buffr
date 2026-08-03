import { Collector, Analyzer, Scorer, Teacher } from '@buffr/capabilities';
import type { Engine, AgentContext, AgentResult } from '@buffr/contracts';
import type { ConversationMemory } from '@buffr/kernel';
import {
  MARKET_RESEARCH_DIMENSIONS,
  MARKET_RESEARCH_SCORECARD,
  MARKET_RESEARCH_PROMPTS,
} from '@buffr/domain-pack-market-research';
import type { MarketResearchInput, MarketResearchOutput, MarketResearchSource, MarketResearchEngineOptions } from './types.js';

export class MarketResearchEngine implements Engine<MarketResearchInput, MarketResearchOutput> {
  readonly id = 'market-research-engine';
  readonly version = '1.0.0';

  private readonly collector: Collector;
  private readonly analyzer: Analyzer;
  private readonly scorer: Scorer;
  private readonly teacher: Teacher;
  private readonly sources: MarketResearchSource[];
  private readonly memory?: ConversationMemory;

  constructor(opts: MarketResearchEngineOptions) {
    this.collector = new Collector();
    this.analyzer = new Analyzer(opts.model);
    this.scorer = new Scorer();
    this.teacher = new Teacher(opts.model);
    this.sources = opts.sources;
    this.memory = opts.memory;
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

  async run(input: MarketResearchInput, context: AgentContext): Promise<AgentResult<MarketResearchOutput>> {
    const status = input.onStatus ?? (() => {});
    const partial = input.onPartial ?? (() => {});

    // Step 1 — build collector sources
    const collectorSources = this.sources.map(s => ({
      connector: s.connector,
      params: s.paramsFor(input.topic),
      optional: s.optional ?? false,
    }));

    // Step 2 — Collector
    const sourceNames = collectorSources.map(s => MarketResearchEngine.friendlyName(s.connector.id)).join(' · ');
    status(`fetching ${sourceNames}…`);
    const collectorResult = await this.collector.execute({ sources: collectorSources }, context);
    const { evidence, failed } = collectorResult.data;

    // Step 3 — short-circuit if no evidence
    if (evidence.length === 0) {
      return {
        data: {
          summary: {
            topic: input.topic,
            totalScore: 0,
            confidence: 0,
            explanation: 'No evidence could be collected.',
            keyProblems: [],
            productAngles: [],
            warnings: collectorResult.warnings,
          },
          detail: { findings: [], metrics: [], evidence: [], failed },
        },
        confidence: 0,
        evidence: [],
        assumptions: [],
        warnings: collectorResult.warnings,
        traceId: context.traceId,
      };
    }

    // Step 4 — Analyzer
    partial(`Collected ${evidence.length} result${evidence.length !== 1 ? 's' : ''} from ${sourceNames}\n\nAnalyzing…`);
    status(`analyzing ${evidence.length} results…`);
    const analyzerResult = await this.analyzer.execute(
      {
        subjectDescription: input.topic,
        evidence,
        dimensions: MARKET_RESEARCH_DIMENSIONS,
        instructions: [MARKET_RESEARCH_PROMPTS['analyzer-context']],
      },
      context,
    );

    // Step 5 — Scorer
    const findingsText = analyzerResult.data.findings.map(f =>
      `  ${f.dimensionId.padEnd(18)} ${String(Math.round(f.score)).padStart(3)}/100  ${f.summary}`
    ).join('\n');
    partial(`Collected ${evidence.length} result${evidence.length !== 1 ? 's' : ''} from ${sourceNames}\n\nFindings:\n${findingsText}\n\nScoring…`);
    status('scoring…');
    const scorerResult = await this.scorer.execute(
      {
        findings: analyzerResult.data.findings,
        scorecard: MARKET_RESEARCH_SCORECARD,
        evidenceCount: evidence.length,
      },
      context,
    );

    // Step 6 — Teacher
    partial(`Collected ${evidence.length} result${evidence.length !== 1 ? 's' : ''} from ${sourceNames}\n\nFindings:\n${findingsText}\n\nScore: ${Math.round(scorerResult.data.totalScore)}/100 · Confidence: ${Math.round(scorerResult.data.confidence * 100)}%\n\nSummarizing…`);
    status('summarizing…');
    const allWarnings = [...collectorResult.warnings, ...scorerResult.data.warnings];
    const teacherResult = await this.teacher.execute(
      {
        subjectDescription: input.topic,
        findings: analyzerResult.data.findings,
        totalScore: scorerResult.data.totalScore,
        confidence: scorerResult.data.confidence,
        warnings: allWarnings,
        audience: 'solo creator building digital products and Shopify apps',
        instructions: [MARKET_RESEARCH_PROMPTS['teacher-context']],
      },
      context,
    );

    // Step 7 — Memory write (opt-in)
    if (this.memory && input.conversationId) {
      const memoryAnswer =
        `${teacherResult.data.explanation}\n\n` +
        `Top problems: ${teacherResult.data.keyLessons.join('; ')}`;
      await this.memory.remember({
        conversationId: input.conversationId,
        question: `Research market: ${input.topic}`,
        answer: memoryAnswer,
      });
    }

    // Step 8 — assemble result, fall back to Analyzer findings if Teacher arrays are empty
    const keyProblems = teacherResult.data.keyLessons.length > 0
      ? teacherResult.data.keyLessons
      : analyzerResult.data.findings.flatMap(f => f.negatives).filter(Boolean).slice(0, 5);

    const productAngles = teacherResult.data.actionableNext.length > 0
      ? teacherResult.data.actionableNext
      : analyzerResult.data.findings.flatMap(f => f.positives).filter(Boolean).slice(0, 5);

    const explanation = teacherResult.data.explanation.trim() ||
      analyzerResult.data.findings.map(f => `${f.dimensionId}: ${f.summary}`).join(' ');

    return {
      data: {
        summary: {
          topic: input.topic,
          totalScore: scorerResult.data.totalScore,
          confidence: scorerResult.data.confidence,
          explanation,
          keyProblems,
          productAngles,
          warnings: allWarnings,
        },
        detail: {
          findings: analyzerResult.data.findings,
          metrics: scorerResult.data.metrics,
          evidence,
          failed,
        },
      },
      confidence: scorerResult.data.confidence,
      evidence,
      assumptions: analyzerResult.data.findings.flatMap(f => f.unknowns),
      warnings: allWarnings,
      traceId: context.traceId,
    };
  }
}
