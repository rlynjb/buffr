import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DiagnosisOutputSchema, type DiagnosisOutput } from '../../contracts/modules.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';
import { runStructuredModule, type AgentRunner, type TraceContext } from '../runner.js';

export const M4_PROMPT = readPromptMarkdown();

export async function runDiagnosisModule(
  runner: AgentRunner,
  state: WorkflowRunState,
  trace: TraceContext,
): Promise<DiagnosisOutput> {
  const result = await runStructuredModule({
    runner,
    moduleId: 'm4',
    modulePrompt: M4_PROMPT,
    input: state,
    outputSchema: DiagnosisOutputSchema,
    trace,
  });

  return result.output;
}

export function resolveDiagnosisPromptUrl(moduleUrl: string = import.meta.url): URL {
  const adjacentSource = new URL('./prompt.md', moduleUrl);
  if (existsSync(adjacentSource)) {
    return adjacentSource;
  }

  return new URL('../../../src/agents/diagnosis/prompt.md', moduleUrl);
}

function readPromptMarkdown(): string {
  return readFileSync(fileURLToPath(resolveDiagnosisPromptUrl()), 'utf8').trim();
}
