import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TestPlanOutputSchema, type TestPlanOutput } from '../../contracts/modules.js';
import type { WorkflowRunState } from '../../contracts/workflow.js';
import { runStructuredModule, type AgentRunner, type TraceContext } from '../runner.js';

export const M6_PROMPT = readPromptMarkdown();

export async function runTestDefinitionModule(
  runner: AgentRunner,
  state: WorkflowRunState,
  trace: TraceContext,
): Promise<TestPlanOutput> {
  const result = await runStructuredModule({
    runner,
    moduleId: 'm6',
    modulePrompt: M6_PROMPT,
    input: state,
    outputSchema: TestPlanOutputSchema,
    trace,
  });

  return result.output;
}

export function resolveTestDefinitionPromptUrl(moduleUrl: string = import.meta.url): URL {
  const adjacentSource = new URL('./prompt.md', moduleUrl);
  if (existsSync(adjacentSource)) {
    return adjacentSource;
  }

  return new URL('../../../src/agents/test-definition/prompt.md', moduleUrl);
}

function readPromptMarkdown(): string {
  return readFileSync(fileURLToPath(resolveTestDefinitionPromptUrl()), 'utf8').trim();
}
