import { Collector, Analyzer, Scorer, Teacher, Journal } from '@buffr/capabilities';
import {
  COMPANY_DIMENSIONS,
  ETF_DIMENSIONS,
  COMPANY_SCORECARD,
  ETF_SCORECARD,
  INVESTING_PROMPTS,
} from '@buffr/domain-pack-investing';
import type { Engine, AgentContext, AgentResult } from '@buffr/contracts';
import type { ConversationMemory, MemoryTurn } from '@buffr/kernel';
import type { InvestingInput, InvestingOutput, InvestingEngineOptions, InvestingSource } from './types.js';

export class InvestingEngine implements Engine<InvestingInput, InvestingOutput> {
  readonly id = 'investing-engine';
  readonly version = '1.0.0';

  private readonly collector: Collector;
  private readonly analyzer: Analyzer;
  private readonly scorer: Scorer;
  private readonly teacher: Teacher;
  private readonly journal: Journal;
  private readonly sources: InvestingSource[];
  private readonly memory?: ConversationMemory;

  constructor(opts: InvestingEngineOptions) {
    this.collector = new Collector();
    this.analyzer = new Analyzer(opts.model);
    this.scorer = new Scorer();
    this.teacher = new Teacher(opts.model);
    this.journal = new Journal();
    this.sources = opts.sources;
    this.memory = opts.memory;
  }

  async run(input: InvestingInput, context: AgentContext): Promise<AgentResult<InvestingOutput>> {
    const dimensions = input.entityType === 'company' ? COMPANY_DIMENSIONS : ETF_DIMENSIONS;
    const scorecard  = input.entityType === 'company' ? COMPANY_SCORECARD  : ETF_SCORECARD;

    const collectorSources = this.sources.map(s => ({
      connector: s.connector,
      params: s.paramsFor(input.ticker, input.entityType),
      optional: s.optional ?? false,
    }));

    const collectorResult = await this.collector.execute({ sources: collectorSources }, context);
    const { evidence, failed } = collectorResult.data;

    if (evidence.length === 0) {
      return {
        data: {
          summary: {
            ticker: input.ticker,
            entityType: input.entityType,
            totalScore: 0,
            confidence: 0,
            explanation: 'No evidence could be collected.',
            keyLessons: [],
            actionableNext: [],
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

    const subjectDescription = `${input.ticker} (${input.entityType})`;

    const analyzerResult = await this.analyzer.execute(
      {
        subjectDescription,
        evidence,
        dimensions,
        instructions: [INVESTING_PROMPTS['analyzer-context']],
      },
      context,
    );

    const scorerResult = await this.scorer.execute(
      { findings: analyzerResult.data.findings, scorecard, evidenceCount: evidence.length },
      context,
    );

    const allWarnings = [...collectorResult.warnings, ...scorerResult.data.warnings];

    const teacherResult = await this.teacher.execute(
      {
        subjectDescription,
        findings: analyzerResult.data.findings,
        totalScore: scorerResult.data.totalScore,
        confidence: scorerResult.data.confidence,
        warnings: allWarnings,
        audience: 'individual investor',
      },
      context,
    );

    if (this.memory && input.conversationId) {
      const memoryAnswer =
        `${teacherResult.data.explanation}\n\n` +
        `Score: ${scorerResult.data.totalScore.toFixed(1)}/100. ` +
        `Key lessons: ${teacherResult.data.keyLessons.join('; ')}`;
      const turn: MemoryTurn = {
        conversationId: input.conversationId,
        question: `Analyze ${input.ticker}`,
        answer: memoryAnswer,
      };
      await this.memory.remember(turn);
    }

    let journalEntryId: string | undefined;
    if (input.decision) {
      const journalResult = await this.journal.execute(
        {
          subject: { type: input.entityType, id: input.ticker, description: subjectDescription },
          domain: 'investing',
          decision: input.decision,
          thesis: input.thesis ?? '',
          expectedOutcome: `Score ≥ ${scorerResult.data.totalScore.toFixed(1)}`,
          timeHorizon: input.timeHorizon,
          confidence: scorerResult.data.confidence,
          assumptions: analyzerResult.data.findings.flatMap(f => f.unknowns),
          risks: analyzerResult.data.findings.flatMap(f => f.negatives),
          evidenceIds: evidence.map(e => e.sourceId),
        },
        context,
      );
      journalEntryId = journalResult.data.entry.id;
    }

    return {
      data: {
        summary: {
          ticker: input.ticker,
          entityType: input.entityType,
          totalScore: scorerResult.data.totalScore,
          confidence: scorerResult.data.confidence,
          explanation: teacherResult.data.explanation,
          keyLessons: teacherResult.data.keyLessons,
          actionableNext: teacherResult.data.actionableNext,
          warnings: allWarnings,
        },
        detail: {
          findings: analyzerResult.data.findings,
          metrics: scorerResult.data.metrics,
          evidence,
          failed,
          journalEntryId,
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
