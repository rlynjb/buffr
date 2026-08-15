import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EvaluationOutputSchema, type EvaluationOutput } from '../../contracts/modules.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';
import { runStructuredModule, type AgentRunner, type TraceContext } from '../runner.js';

export const M7_PROMPT = readPromptMarkdown();

export async function runEvaluationModule(
  runner: AgentRunner,
  state: WorkflowRunState,
  trace: TraceContext,
): Promise<EvaluationOutput> {
  const result = await runStructuredModule({
    runner,
    moduleId: 'm7',
    modulePrompt: M7_PROMPT,
    input: state,
    outputSchema: EvaluationOutputSchema,
    trace,
  });

  return result.output;
}

export function resolveEvaluationPromptUrl(moduleUrl: string = import.meta.url): URL {
  const adjacentSource = new URL('./prompt.md', moduleUrl);
  if (existsSync(adjacentSource)) {
    return adjacentSource;
  }

  return new URL('../../../src/agents/evaluation/prompt.md', moduleUrl);
}

function readPromptMarkdown(): string {
  return readFileSync(fileURLToPath(resolveEvaluationPromptUrl()), 'utf8').trim();
}
