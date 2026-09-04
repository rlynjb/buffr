import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../core/errors.js';
import {
  CitationSchema,
  ResearchOutputSchema,
  ResearchSearchSummarySchema,
  ResearchToolNameSchema,
  type ModuleId,
  type ResearchOutput,
  type ResearchSearchSummary,
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
    domain?: string;
    sourceType?: 'official_platform' | 'official_marketplace' | 'public_web' | 'derived';
    retrievalMethod?: 'openai_hosted_web_search';
    searchPass?: 'authoritative_domains' | 'broader_web';
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
  const toolEvidence: ToolEvidence[] = [];
  const searchSummaries: ResearchSearchSummary[] = [];
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
      return finalizeResearchOutput(output, toolEvidence, searchSummaries);
    }

    const preLookupLimit = limitReason({
      limits,
      now: now(),
      startedAt,
      toolCallCount,
      totalTokens,
      totalEstimatedCostUsd,
    });
    if (preLookupLimit) {
      return finalizeResearchOutput(output, toolEvidence, searchSummaries, preLookupLimit);
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
    const toolSearchSummaries = parseToolSearchSummaries(toolResult.data);
    searchSummaries.push(...toolSearchSummaries);
    totalTokens += toolSearchSummaries.reduce((sum, summary) => sum + (summary.totalTokens ?? 0), 0);
    totalEstimatedCostUsd += toolSearchSummaries.reduce(
      (sum, summary) => sum + (summary.estimatedCostUsd ?? 0),
      0,
    );

    const postLookupLimit = limitReason({
      limits,
      now: now(),
      startedAt,
      toolCallCount,
      totalTokens,
      totalEstimatedCostUsd,
    });
    if (postLookupLimit) {
      return finalizeResearchOutput(output, toolEvidence, searchSummaries, postLookupLimit);
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

function limitReason(input: {
  limits: ResearchLimits;
  now: number;
  startedAt: number;
  toolCallCount: number;
  totalTokens: number;
  totalEstimatedCostUsd: number;
}): string | undefined {
  if (input.toolCallCount >= input.limits.maxToolCalls) {
    return 'M3 research tool-call limit reached.';
  }

  if (input.now - input.startedAt >= input.limits.maxWallClockMs) {
    return 'M3 research wall-clock limit reached.';
  }

  if (input.limits.maxTokens !== undefined && input.totalTokens >= input.limits.maxTokens) {
    return 'M3 research token budget exhausted.';
  }

  if (
    input.limits.maxEstimatedCostUsd !== undefined &&
    input.totalEstimatedCostUsd >= input.limits.maxEstimatedCostUsd
  ) {
    return 'M3 research cost budget exhausted.';
  }

  return undefined;
}

type ToolEvidence = {
  tool: ResearchToolName;
  citations: ToolCitation[];
  data: unknown;
};

function finalizeResearchOutput(
  output: ResearchOutput,
  toolEvidence: readonly ToolEvidence[],
  searchSummaries: readonly ResearchSearchSummary[],
  limit?: string,
): ResearchOutput {
  const { searchSummaries: _modelAuthoredSummaries, ...modelOutput } = output;
  const evidence = limit ? mergeToolCitations(modelOutput.evidence, toolEvidence) : modelOutput.evidence;
  assertWebCitationsCameFromTools(evidence, toolEvidence);

  return ResearchOutputSchema.parse({
    ...modelOutput,
    ...(limit ? { next_action: 'stop', limitations: uniqueStrings([...modelOutput.limitations, limit]) } : {}),
    evidence,
    ...(searchSummaries.length > 0 ? { searchSummaries } : {}),
  });
}

function parseToolSearchSummaries(data: unknown): ResearchSearchSummary[] {
  if (!data || typeof data !== 'object' || !('searchSummaries' in data)) return [];
  return parseWithSchema(
    ResearchSearchSummarySchema.array(),
    (data as { searchSummaries: unknown }).searchSummaries,
    'M3 search summaries',
  );
}

function assertWebCitationsCameFromTools(
  citations: readonly ResearchOutput['evidence'][number][],
  toolEvidence: readonly ToolEvidence[],
): void {
  const toolUrls = new Set(
    toolEvidence.flatMap((evidence) =>
      evidence.citations
        .filter((citation) => citation.source === 'web' && citation.url)
        .map((citation) => citation.url!),
    ),
  );

  const unmatched = citations.find((citation) => citation.source === 'web' && !toolUrls.has(citation.url!));
  if (unmatched) {
    throw new AppError('validation_failed', 'M3 web citation was not returned by a permitted research tool');
  }
}

function mergeToolCitations(
  outputCitations: readonly ResearchOutput['evidence'][number][],
  toolEvidence: readonly ToolEvidence[],
): ResearchOutput['evidence'] {
  const merged = [...outputCitations, ...toolEvidence.flatMap((evidence) => evidence.citations)];
  const seen = new Set<string>();
  return merged.filter((citation) => {
    const key = `${citation.source}\u0000${citation.url ?? ''}\u0000${citation.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeToolCitation(citation: ReturnType<typeof parseCitation>): ToolCitation {
  const { source } = citation;
  if (source === 'user') {
    throw new AppError('validation_failed', 'M3 tool citation source is not permitted: user');
  }

  return { ...citation, source, url: citation.url ?? undefined };
}

function parseCitation(value: unknown) {
  return parseWithSchema(CitationSchema, value, 'M3 tool citation');
}

function readPromptMarkdown(): string {
  return readFileSync(fileURLToPath(resolveResearchPromptUrl()), 'utf8').trim();
}
