import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../core/errors.js';
import {
  CitationSchema,
  ResearchOutputSchema,
  ResearchToolNameSchema,
  type ModuleId,
  type ResearchOutput,
  type ResearchToolName,
} from '../../contracts/modules.js';
import { parseWithSchema } from '../../contracts/workflow.js';
import { M3_DEFAULT_LIMITS } from '../core/policy.js';
import { runStructuredModule, type AgentRunner, type TraceContext } from '../runner.js';

export type ResearchTool = {
  name: ResearchToolName;
  call(input: Record<string, unknown>): Promise<ResearchToolResult>;
};

export type ResearchToolResult = {
  citations: ToolCitation[];
  data: unknown;
};

export type ToolCitation = {
    source: 'etsy' | 'web' | 'derived';
    title: string;
    url?: string;
    excerpt: string;
    fetchedAt: string;
};

export type ResearchRequest = {
  requester: Exclude<ModuleId, 'm3'>;
  question: string;
  reason: string;
};

export type ResearchLimits = {
  maxToolCalls: number;
  maxWallClockMs: number;
  maxEstimatedCostUsd?: number;
  maxTokens?: number;
};

export const M3_PROMPT = readPromptMarkdown();

export async function runResearchModule(input: {
  runner: AgentRunner;
  tools: readonly ResearchTool[];
  request: ResearchRequest;
  limits?: Partial<ResearchLimits>;
  now?: () => number;
  trace: TraceContext;
}): Promise<ResearchOutput> {
  const toolsByName = buildToolMap(input.tools);
  const limits = { ...M3_DEFAULT_LIMITS, ...input.limits };
  const now = input.now ?? Date.now;
  const startedAt = now();
  const toolEvidence: Array<{ tool: ResearchToolName; citations: ResearchToolResult['citations']; data: unknown }> = [];
  let toolCallCount = 0;
  let totalTokens = 0;
  let totalEstimatedCostUsd = 0;

  while (true) {
    const result = await runStructuredModule({
      runner: input.runner,
      moduleId: 'm3',
      modulePrompt: M3_PROMPT,
      input: {
        request: input.request,
        limits,
        toolCallCount,
        toolEvidence,
      },
      outputSchema: ResearchOutputSchema,
      trace: input.trace,
    });
    const output = normalizeResearchOutput(result.output);
    totalTokens += result.usage?.totalTokens ?? 0;
    totalEstimatedCostUsd += result.usage?.estimatedCostUsd ?? 0;

    if (output.next_action === 'stop') {
      return output;
    }

    if (limitReached({ limits, now: now(), startedAt, toolCallCount, totalTokens, totalEstimatedCostUsd })) {
      return forceStop(output);
    }

    const requestedLookup = normalizeRequestedLookup(output);
    if (!requestedLookup) {
      throw new AppError('validation_failed', 'M3 continue output requires requestedLookup');
    }

    const tool = toolsByName.get(requestedLookup.tool);
    if (!tool) {
      throw new AppError('configuration_failed', `M3 requested tool is not configured: ${requestedLookup.tool}`);
    }

    const toolResult = await tool.call(requestedLookup.input);
    const citations = toolResult.citations.map((citation) =>
      normalizeToolCitation(parseWithSchema(CitationSchema, citation, `${requestedLookup.tool} citation`)),
    );
    toolCallCount += 1;
    toolEvidence.push({
      tool: requestedLookup.tool,
      citations,
      data: toolResult.data,
    });

    if (limitReached({ limits, now: now(), startedAt, toolCallCount, totalTokens, totalEstimatedCostUsd })) {
      return forceStop(output);
    }
  }
}

function normalizeResearchOutput(output: unknown): ResearchOutput {
  return parseWithSchema(ResearchOutputSchema, output, 'm3 output');
}

function normalizeRequestedLookup(output: ResearchOutput):
  | { tool: ResearchToolName; reason: string; input: Record<string, unknown> }
  | undefined {
  if (!output.requestedLookup) {
    return undefined;
  }

  return {
    ...output.requestedLookup,
    input: output.requestedLookup.input ?? {},
  };
}

export function resolveResearchPromptUrl(moduleUrl: string = import.meta.url): URL {
  const adjacentSource = new URL('./prompt.md', moduleUrl);
  if (existsSync(adjacentSource)) {
    return adjacentSource;
  }

  return new URL('../../../src/agents/research/prompt.md', moduleUrl);
}

function buildToolMap(tools: readonly ResearchTool[]): Map<ResearchToolName, ResearchTool> {
  const toolsByName = new Map<ResearchToolName, ResearchTool>();

  for (const tool of tools) {
    const parsedName = ResearchToolNameSchema.safeParse(tool.name);
    if (!parsedName.success) {
      throw new AppError('configuration_failed', `M3 research tool is not permitted: ${tool.name}`);
    }

    toolsByName.set(parsedName.data, tool);
  }

  return toolsByName;
}

function limitReached(input: {
  limits: ResearchLimits;
  now: number;
  startedAt: number;
  toolCallCount: number;
  totalTokens: number;
  totalEstimatedCostUsd: number;
}): boolean {
  if (input.toolCallCount >= input.limits.maxToolCalls) {
    return true;
  }

  if (input.now - input.startedAt >= input.limits.maxWallClockMs) {
    return true;
  }

  if (input.limits.maxTokens !== undefined && input.totalTokens >= input.limits.maxTokens) {
    return true;
  }

  return (
    input.limits.maxEstimatedCostUsd !== undefined &&
    input.totalEstimatedCostUsd >= input.limits.maxEstimatedCostUsd
  );
}

function forceStop(output: ResearchOutput): ResearchOutput {
  return { ...output, next_action: 'stop' };
}

function normalizeToolCitation(citation: ReturnType<typeof parseCitation>): ToolCitation {
  const { source } = citation;
  if (source === 'user') {
    throw new AppError('validation_failed', 'M3 tool citation source is not permitted: user');
  }

  return { ...citation, source };
}

function parseCitation(value: unknown) {
  return parseWithSchema(CitationSchema, value, 'M3 tool citation');
}

function readPromptMarkdown(): string {
  return readFileSync(fileURLToPath(resolveResearchPromptUrl()), 'utf8').trim();
}
