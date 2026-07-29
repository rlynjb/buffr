import { runAgentLoop } from '@buffr/kernel';
import type { ToolExecutor, ModelTool, ModelProvider } from '@buffr/kernel';
import type { Evidence, AgentContext, AgentResult, Capability } from '@buffr/contracts';

export type AnalysisDimension = {
  id: string;
  label: string;
  description: string;
  weight?: number;
};

export type AnalysisFinding = {
  dimensionId: string;
  summary: string;
  positives: string[];
  negatives: string[];
  unknowns: string[];
  score: number;
  confidence: number;
  evidenceIds: string[];
};

export type AnalyzerInput = {
  subjectDescription: string;
  evidence: Evidence[];
  dimensions: AnalysisDimension[];
  instructions?: string[];
};

export type AnalyzerOutput = {
  findings: AnalysisFinding[];
};

const SUBMIT_ANALYSIS_TOOL: ModelTool = {
  name: 'submit_analysis',
  description: 'Submit the analysis findings for all dimensions.',
  inputSchema: {
    type: 'object',
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['dimensionId', 'summary', 'positives', 'negatives', 'unknowns', 'score', 'confidence', 'evidenceIds'],
          properties: {
            dimensionId: { type: 'string' },
            summary: { type: 'string' },
            positives: { type: 'array', items: { type: 'string' } },
            negatives: { type: 'array', items: { type: 'string' } },
            unknowns: { type: 'array', items: { type: 'string' } },
            score: { type: 'number', minimum: 0, maximum: 100 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            evidenceIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

const EVIDENCE_EXCERPT_CHARS = 500;

export class Analyzer implements Capability<AnalyzerInput, AnalyzerOutput> {
  readonly name = 'analyzer';
  readonly version = '1.0.0';

  constructor(private readonly model: ModelProvider) {}

  async execute(input: AnalyzerInput, context: AgentContext): Promise<AgentResult<AnalyzerOutput>> {
    const start = performance.now();

    const evidenceSummary = input.evidence
      .map(e => `[${e.sourceId}] ${e.title ?? ''}${e.excerpt ? ': ' + e.excerpt.slice(0, EVIDENCE_EXCERPT_CHARS) : ''}`)
      .join('\n\n');

    const dimensionsList = input.dimensions
      .map(d => `- ${d.id} (${d.label}): ${d.description}`)
      .join('\n');

    const extraInstructions = input.instructions?.length
      ? `\nAdditional instructions:\n${input.instructions.map(i => `- ${i}`).join('\n')}`
      : '';

    const system = `You are an expert analyst. Analyze the subject across the specified dimensions and call submit_analysis exactly once with findings for every dimension.${extraInstructions}`;

    const userPrompt = `Subject: ${input.subjectDescription}

Evidence:
${evidenceSummary || '(no evidence provided)'}

Dimensions to analyze:
${dimensionsList}

For each dimension produce a finding with:
- dimensionId: the dimension id exactly as listed above
- summary: concise one-sentence assessment
- positives: list of supporting evidence points
- negatives: list of concerns or weaknesses
- unknowns: what could not be determined from the evidence
- score: integer 0–100 (0 = very poor, 100 = excellent)
- confidence: float 0–1 (your confidence in this assessment given the evidence)
- evidenceIds: source IDs that support this finding

Call submit_analysis with all ${input.dimensions.length} findings now.`;

    const captured: { args: Record<string, unknown> | null } = { args: null };
    const tools: ToolExecutor = {
      async callTool(_name: string, args: Record<string, unknown>) {
        captured.args = args;
        return { result: { ok: true }, durationMs: 0 };
      },
    };

    await runAgentLoop({
      capabilityId: 'analyzer@1.0.0',
      model: this.model,
      tools,
      system,
      userPrompt,
      toolSchemas: [SUBMIT_ANALYSIS_TOOL],
      maxTurns: 4,
    });

    const latencyMs = Math.round(performance.now() - start);
    const findings = (captured.args?.findings ?? []) as AnalysisFinding[];

    const meanConfidence = findings.length > 0
      ? findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length
      : 0;

    return {
      data: { findings },
      confidence: meanConfidence,
      evidence: input.evidence,
      assumptions: [],
      warnings: [],
      traceId: context.traceId,
      promptVersion: 'analyzer@1.0.0',
      latencyMs,
    };
  }
}
