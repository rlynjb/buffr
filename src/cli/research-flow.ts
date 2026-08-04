import type { ChatSession, ResearchEvaluateCallbacks } from '../session.js';
import type { CollectedResearch, ResearchPrediction, MarketResearchOutput } from '@buffr/engine-market-research';
import { parseDayCountOrDate } from './parse-review-date.js';

const VALID_DIMENSIONS = ['frequency', 'trend-velocity', 'specificity', 'monetizability'] as const;
type Dimension = typeof VALID_DIMENSIONS[number];

export type ResearchFlowStep = 'prediction' | 'promote' | 'stake' | 'resolution' | 'review-date' | 'done';

export type ResearchFlowResult = {
  messages: string[];
  step: ResearchFlowStep;
};

// Same shape session.ts already uses for researchEvaluate()'s options —
// reused directly rather than re-derived, since collect() only needs the
// onStatus/onProgress subset and evaluate() needs onTokens too.
export type ResearchFlowCallbacks = ResearchEvaluateCallbacks;

export type ResearchFlow = {
  start(): Promise<ResearchFlowResult>;
  submit(input: string): Promise<ResearchFlowResult>;
};

function formatDigest(topic: string, collected: CollectedResearch): string {
  const lines = [
    `Collected evidence for "${topic}" — ${collected.digest.totalCount} result${collected.digest.totalCount === 1 ? '' : 's'}:`,
    '',
  ];
  for (const source of collected.digest.sources) {
    lines.push(`${source.source} (${source.count}):`);
    for (const title of source.titles) lines.push(`  • ${title}`);
  }
  return lines.join('\n');
}

const PREDICTION_PROMPT =
  'Before buffr scores this: what\'s your read?\n\n' +
  'Reply with: <expected score 0-100> <strongest dimension> <confidence 0-100>\n' +
  'Dimensions: frequency, trend-velocity, specificity, monetizability\n' +
  'Example: 72 frequency 60';

function parsePrediction(input: string): ResearchPrediction | null {
  const parts = input.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const [scoreStr, dimension, confidenceStr] = parts;
  const score = Number(scoreStr);
  const confidence = Number(confidenceStr);
  if (!Number.isFinite(score) || score < 0 || score > 100) return null;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) return null;
  if (!VALID_DIMENSIONS.includes(dimension as Dimension)) return null;
  return { expectedScore: score, expectedDimension: dimension as Dimension, confidence: confidence / 100 };
}

function formatReveal(output: MarketResearchOutput): string {
  const c = output.comparison;
  const matchLine = c.dimensionMatched
    ? `Dimension match: yes — both picked ${c.actualDimension}.`
    : `Dimension match: no — you picked ${c.prediction.expectedDimension}, strongest was ${c.actualDimension}.`;
  const gapSign = c.scoreGap >= 0 ? '+' : '';
  return [
    `Your call: ${c.prediction.expectedScore}   buffr: ${Math.round(output.summary.totalScore)}   gap: ${gapSign}${c.scoreGap.toFixed(0)}`,
    matchLine,
    '',
    `Principle: ${output.summary.principle}`,
    `Reflect: ${output.summary.reflectionQuestion}`,
  ].join('\n');
}

const PROMOTE_PROMPT = 'discard / hypothesis / decision — what do you want to do with this?';

export function createResearchFlow(session: ChatSession, topic: string, callbacks: ResearchFlowCallbacks): ResearchFlow {
  let step: ResearchFlowStep = 'prediction';
  let collected: CollectedResearch | null = null;
  let output: MarketResearchOutput | null = null;
  let prediction: ResearchPrediction | null = null;
  let stake = '';
  let resolutionCondition = '';

  return {
    async start(): Promise<ResearchFlowResult> {
      const { collected: c } = await session.researchCollect(topic, { onStatus: callbacks.onStatus, onProgress: callbacks.onProgress });
      collected = c;
      if (collected.digest.totalCount === 0) {
        step = 'done';
        return { messages: [`No evidence found for "${topic}". Try a different topic.`], step };
      }
      return { messages: [formatDigest(topic, collected), PREDICTION_PROMPT], step };
    },

    async submit(input: string): Promise<ResearchFlowResult> {
      if (!collected) throw new Error('research flow: submit() called before start()');

      if (step === 'prediction') {
        const parsed = parsePrediction(input);
        if (!parsed) {
          return {
            messages: ['Could not parse that. Format: <score 0-100> <dimension> <confidence 0-100>. Dimensions: frequency, trend-velocity, specificity, monetizability.'],
            step,
          };
        }
        prediction = parsed;
        const { output: o } = await session.researchEvaluate(collected, prediction, callbacks);
        output = o;
        step = 'promote';
        return { messages: [formatReveal(output), PROMOTE_PROMPT], step };
      }

      if (step === 'promote') {
        const choice = input.trim().toLowerCase();
        if (choice === 'discard') {
          step = 'done';
          return { messages: ['Discarded — nothing saved.'], step };
        }
        if (choice === 'hypothesis') {
          await session.saveHypothesis({ topic, evidenceIds: collected.evidence.map(e => e.sourceId) });
          step = 'done';
          return { messages: ['Saved as a hypothesis.'], step };
        }
        if (choice === 'decision') {
          step = 'stake';
          return { messages: ['What\'s the stake — what will you actually do, and what do you risk if you\'re wrong?'], step };
        }
        return { messages: [PROMOTE_PROMPT], step };
      }

      if (step === 'stake') {
        if (input.trim().length === 0) return { messages: ['Stake can\'t be empty — what will you actually do?'], step };
        stake = input.trim();
        step = 'resolution';
        return { messages: ['Resolution condition — what measurable outcome would prove this right or wrong?'], step };
      }

      if (step === 'resolution') {
        if (input.trim().length === 0) return { messages: ['Resolution condition can\'t be empty.'], step };
        resolutionCondition = input.trim();
        step = 'review-date';
        return { messages: ['Review date — when should buffr remind you? (e.g. "30" for 30 days, or an ISO date like 2026-09-01)'], step };
      }

      // step === 'review-date'
      const reviewAt = parseDayCountOrDate(input);
      if (!reviewAt) {
        return { messages: ['Could not parse that. Enter a number of days from now (e.g. "30") or an ISO date (e.g. "2026-09-01").'], step };
      }
      await session.saveDecision({
        topic,
        evidenceIds: collected.evidence.map(e => e.sourceId),
        stake,
        resolutionCondition,
        reviewAt,
        prediction: prediction!,
        assessment: { score: output!.summary.totalScore, confidence: output!.summary.confidence },
      });
      step = 'done';
      const reviewDate = reviewAt.slice(0, 10);
      return { messages: [`Tracked as a decision. buffr will remind you to review this around ${reviewDate}.`], step };
    },
  };
}
