import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HypothesisOutputSchema, type HypothesisOutput } from '../../contracts/modules.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';
import { runStructuredModule, type AgentRunner, type TraceContext } from '../runner.js';

export const M5_PROMPT = readPromptMarkdown();

export async function runHypothesisModule(
  runner: AgentRunner,
  state: WorkflowRunState,
  trace: TraceContext,
): Promise<HypothesisOutput> {
  const result = await runStructuredModule({
    runner,
    moduleId: 'm5',
    modulePrompt: M5_PROMPT,
    input: state,
    outputSchema: HypothesisOutputSchema,
    trace,
  });

  return result.output;
}

export function resolveHypothesisPromptUrl(moduleUrl: string = import.meta.url): URL {
  const adjacentSource = new URL('./prompt.md', moduleUrl);
  if (existsSync(adjacentSource)) {
    return adjacentSource;
  }

  return new URL('../../../src/agents/hypothesis/prompt.md', moduleUrl);
}

function readPromptMarkdown(): string {
  return readFileSync(fileURLToPath(resolveHypothesisPromptUrl()), 'utf8').trim();
}
