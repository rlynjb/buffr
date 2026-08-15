import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ContextOutputSchema, type ContextOutput } from '../../contracts/modules.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';
import { runStructuredModule, type AgentRunner, type TraceContext } from '../runner.js';

export const M1_PROMPT = readPromptMarkdown();

export async function runContextModule(
  runner: AgentRunner,
  state: WorkflowRunState,
  trace: TraceContext,
): Promise<ContextOutput> {
  const result = await runStructuredModule({
    runner,
    moduleId: 'm1',
    modulePrompt: M1_PROMPT,
    input: state,
    outputSchema: ContextOutputSchema,
    trace,
  });

  return result.output;
}

export function resolveContextPromptUrl(moduleUrl: string = import.meta.url): URL {
  const adjacentSource = new URL('./prompt.md', moduleUrl);
  if (existsSync(adjacentSource)) {
    return adjacentSource;
  }

  return new URL('../../../src/agents/context/prompt.md', moduleUrl);
}

function readPromptMarkdown(): string {
  return readFileSync(fileURLToPath(resolveContextPromptUrl()), 'utf8').trim();
}
