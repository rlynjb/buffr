import { runAgentLoop } from '@buffr/kernel';
import type { ToolExecutor, ModelTool, ModelProvider } from '@buffr/kernel';
import type { AgentContext, AgentResult, Capability } from '@buffr/contracts';
import type { AnalysisFinding } from '../analyzer/index.js';

export type TeacherInput = {
  subjectDescription: string;
  findings: AnalysisFinding[];
  totalScore: number;
  confidence: number;
  warnings: string[];
  audience?: string;
  instructions?: string[];
};

export type TeacherOutput = {
  explanation: string;
  keyLessons: string[];
  actionableNext: string[];
};

const SUBMIT_EXPLANATION_TOOL: ModelTool = {
  name: 'submit_explanation',
  description: 'Submit the plain-language explanation, key lessons, and actionable next steps.',
  inputSchema: {
    type: 'object',
    required: ['explanation', 'keyLessons', 'actionableNext'],
    properties: {
      explanation: { type: 'string', description: '2–4 paragraph plain-language summary' },
      keyLessons: { type: 'array', items: { type: 'string' }, description: '3–5 bullet takeaways' },
      actionableNext: { type: 'array', items: { type: 'string' }, description: 'concrete next steps' },
    },
  },
};

export class Teacher implements Capability<TeacherInput, TeacherOutput> {
  readonly name = 'teacher';
  readonly version = '1.0.0';

  constructor(private readonly model: ModelProvider) {}

  async execute(input: TeacherInput, context: AgentContext): Promise<AgentResult<TeacherOutput>> {
    const start = performance.now();
    const audience = input.audience ?? 'general';

    const findingsSummary = input.findings
      .map(f => {
        const pros = f.positives.length ? `Positives: ${f.positives.join(', ')}` : '';
        const cons = f.negatives.length ? `Concerns: ${f.negatives.join(', ')}` : '';
        const unk = f.unknowns.length ? `Unknowns: ${f.unknowns.join(', ')}` : '';
        return `[${f.dimensionId}] Score: ${f.score}/100 — ${f.summary}\n${[pros, cons, unk].filter(Boolean).join('; ')}`;
      })
      .join('\n\n');

    const warningSection = input.warnings.length
      ? `\nWarnings: ${input.warnings.join('; ')}`
      : '';

    const system = `You are a clear, concise educator. Explain analysis results in plain language for a ${audience} audience. Call submit_explanation exactly once.`;

    const instructionSection = input.instructions?.length
      ? `\n\nAdditional context:\n${input.instructions.join('\n')}`
      : '';

    const userPrompt = `Subject: ${input.subjectDescription}
Overall score: ${Math.round(input.totalScore)}/100 (confidence: ${Math.round(input.confidence * 100)}%)${warningSection}

Findings by dimension:
${findingsSummary}${instructionSection}

Produce:
- explanation: 2–4 paragraphs summarising what this score means for the subject and why
- keyLessons: list the specific problems and frustrations found in the evidence (3–5 items)
- actionableNext: concrete product or solution ideas that address those problems (3–5 items)

Call submit_explanation now.`;

    const captured: { args: Record<string, unknown> | null } = { args: null };
    const tools: ToolExecutor = {
      async callTool(_name: string, args: Record<string, unknown>) {
        if (captured.args === null) { captured.args = args; }
        return { result: { ok: true }, durationMs: 0 };
      },
    };

    await runAgentLoop({
      capabilityId: 'teacher@1.0.0',
      model: this.model,
      tools,
      system,
      userPrompt,
      toolSchemas: [SUBMIT_EXPLANATION_TOOL],
      maxTurns: 4,
    });

    const latencyMs = Math.round(performance.now() - start);
    const args = captured.args ?? {};
    const output: TeacherOutput = {
      explanation: (args.explanation as string) ?? '',
      keyLessons: (args.keyLessons as string[]) ?? [],
      actionableNext: (args.actionableNext as string[]) ?? [],
    };

    return {
      data: output,
      confidence: input.confidence,
      evidence: [],
      assumptions: [],
      warnings: [],
      traceId: context.traceId,
      promptVersion: 'teacher@1.0.0',
      latencyMs,
    };
  }
}
