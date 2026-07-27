// packages/kernel/src/evals/rubric-judge.ts
import { generateStructured } from '../workflow-runtime/structured-generation.js';
import type { StructuredGenerationResult, GenerateStructuredOptions } from '../workflow-runtime/structured-generation.js';
import type { JsonValidation } from '../workflow-runtime/json-output.js';
import type { ModelProvider } from '../model-gateway/types.js';
import type { CapabilityTraceSink } from '../tracing.js';

export type RubricScoreLevel = { score: number; description: string };
export type RubricDimension = { id: string; label: string; description: string; scale: readonly RubricScoreLevel[] };
export type RubricVerdictRule = { verdict: string; description: string };
export type RubricCalibrationExample = { input: string; expected: string };

export type RubricDefinition = {
  id: string;
  title: string;
  task: string;
  dimensions: readonly RubricDimension[];
  verdicts: readonly RubricVerdictRule[];
  checks?: readonly string[];
  calibrationExamples?: readonly RubricCalibrationExample[];
};

export type RubricDimensionScore = { score: number; reason: string };

export type RubricJudgment = {
  dimensions: Record<string, RubricDimensionScore>;
  checks?: Record<string, boolean>;
  verdict: string;
  fix: string;
  reasoning?: string;
};

export type RubricJudgeInput = { subject: string; context?: Record<string, string> };

export type RubricJudgeOptions = {
  model: ModelProvider;
  rubric: RubricDefinition;
  capabilityId?: string;
  maxTokens?: number;
  temperature?: number;
  trace?: CapabilityTraceSink;
};

export class RubricJudge {
  private readonly model: ModelProvider;
  private readonly rubric: RubricDefinition;
  private readonly capabilityId: string;
  private readonly maxTokens: number;
  private readonly temperature?: number;
  private readonly trace?: CapabilityTraceSink;

  constructor(options: RubricJudgeOptions) {
    this.model = options.model;
    this.rubric = options.rubric;
    this.capabilityId = options.capabilityId ?? 'rubric-judge';
    this.maxTokens = options.maxTokens ?? 1200;
    this.temperature = options.temperature;
    this.trace = options.trace;
  }

  judge(input: RubricJudgeInput, options: { signal?: AbortSignal } = {}): Promise<StructuredGenerationResult<RubricJudgment>> {
    return generateStructured({
      capabilityId: this.capabilityId,
      model: this.model,
      system: buildRubricJudgeSystemPrompt(this.rubric),
      userPrompt: buildRubricJudgeUserPrompt(input),
      validate: createRubricJudgmentValidator(this.rubric),
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      trace: this.trace,
      signal: options.signal,
    } as GenerateStructuredOptions<RubricJudgment>);
  }
}

export function buildRubricJudgeSystemPrompt(rubric: RubricDefinition): string {
  const dimensions = rubric.dimensions.map((d) => {
    const scale = d.scale.map((l) => `  ${l.score} = ${l.description}`).join('\n');
    return `${d.id} ${d.label}: ${d.description}\n${scale}`;
  }).join('\n\n');
  const verdicts = rubric.verdicts.map((v) => `- ${v.verdict}: ${v.description}`).join('\n');
  const checks = rubric.checks?.length ? `\nChecks:\n${rubric.checks.map((c) => `- ${c}`).join('\n')}\n` : '';
  const examples = rubric.calibrationExamples?.length
    ? `\nCalibration examples:\n${rubric.calibrationExamples.map((e) => `Input:\n${e.input}\nExpected:\n${e.expected}`).join('\n\n')}\n` : '';
  const dimShape = Object.fromEntries(rubric.dimensions.map((d) => [d.id, { score: 0, reason: '' }]));
  const checkShape = Object.fromEntries((rubric.checks ?? []).map((c) => [c, true]));
  const outputShape = { dimensions: dimShape, ...(rubric.checks?.length ? { checks: checkShape } : {}), verdict: rubric.verdicts[0]?.verdict ?? 'pass', fix: '', reasoning: '' };
  return [
    `You are a rubric judge for: ${rubric.title}.`, rubric.task, '',
    'Score the subject against the rubric.', 'Return one highest-leverage fix, not a list.', '',
    'Rubric dimensions:', dimensions, '', 'Allowed verdicts:', verdicts,
    checks.trimEnd(), examples.trimEnd(), '',
    'Output JSON only. No prose. No markdown fences. Use exactly this shape:', JSON.stringify(outputShape),
  ].filter(Boolean).join('\n');
}

export function buildRubricJudgeUserPrompt(input: RubricJudgeInput): string {
  const context = input.context && Object.keys(input.context).length > 0
    ? `Context:\n${Object.entries(input.context).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n` : '';
  return `${context}Subject:\n${input.subject}`;
}

export function createRubricJudgmentValidator(
  rubric: RubricDefinition,
): (value: unknown) => JsonValidation<RubricJudgment> {
  const dimensionIds = new Set(rubric.dimensions.map((d) => d.id));
  const verdicts = new Set(rubric.verdicts.map((v) => v.verdict));
  const scoreRanges = new Map(rubric.dimensions.map((d) => [d.id, { min: Math.min(...d.scale.map((l) => l.score)), max: Math.max(...d.scale.map((l) => l.score)) }]));

  return (value: unknown): JsonValidation<RubricJudgment> => {
    if (!isRecord(value)) return { ok: false, error: 'judgment must be an object' };
    if (!isRecord(value['dimensions'])) return { ok: false, error: 'judgment.dimensions must be an object' };
    const dimensions: Record<string, RubricDimensionScore> = {};
    for (const id of dimensionIds) {
      const score = value['dimensions'][id];
      if (!isRecord(score)) return { ok: false, error: `dimensions.${id} must be an object` };
      if (typeof score['score'] !== 'number') return { ok: false, error: `dimensions.${id}.score must be a number` };
      if (typeof score['reason'] !== 'string') return { ok: false, error: `dimensions.${id}.reason must be a string` };
      const range = scoreRanges.get(id);
      if (range && (score['score'] < range.min || score['score'] > range.max)) {
        return { ok: false, error: `dimensions.${id}.score must be between ${range.min} and ${range.max}` };
      }
      dimensions[id] = { score: score['score'], reason: (score['reason'] as string).trim() };
    }
    if (typeof value['verdict'] !== 'string' || !verdicts.has(value['verdict'])) return { ok: false, error: 'judgment.verdict is not allowed by the rubric' };
    if (typeof value['fix'] !== 'string') return { ok: false, error: 'judgment.fix must be a string' };
    const checks = validateChecks(value['checks'], rubric.checks);
    if (!checks.ok) return checks;
    return { ok: true, value: { dimensions, ...(checks.value ? { checks: checks.value } : {}), verdict: value['verdict'], fix: (value['fix'] as string).trim(), ...(value['reasoning'] ? { reasoning: (value['reasoning'] as string).trim() } : {}) } };
  };
}

function validateChecks(value: unknown, expectedChecks?: readonly string[]): JsonValidation<Record<string, boolean> | undefined> {
  if (!expectedChecks?.length) return { ok: true, value: undefined };
  if (!isRecord(value)) return { ok: false, error: 'judgment.checks must be an object' };
  const checks: Record<string, boolean> = {};
  for (const check of expectedChecks) {
    if (typeof value[check] !== 'boolean') return { ok: false, error: `checks.${check} must be a boolean` };
    checks[check] = value[check] as boolean;
  }
  return { ok: true, value: checks };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
