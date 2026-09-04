import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { webSearchTool } from '@openai/agents';
import { z } from 'zod';
import { ResearchSearchSummarySchema, type ResearchSearchSummary } from '../../contracts/modules.js';
import { parseWithSchema } from '../../contracts/workflow.js';
import { AppError } from '../../core/errors.js';
import { runStructuredModule, type AgentRunner } from '../runner.js';
import type { ResearchTool, ResearchToolResult, ToolCitation } from './agent.js';
import type { MarketplaceResearchConfig } from './marketplace-config.js';

const LookupCitationSchema = z
  .object({
    title: z.string().trim().min(1),
    url: z.string().url().nullable().optional(),
    excerpt: z.string().trim().min(1).max(1_000),
    fetchedAt: z.string().datetime(),
  })
  .strict();

const HostedWebSearchLookupSchema = z
  .object({
    answer: z.string().trim().min(1).max(4_000),
    citations: z.array(LookupCitationSchema).max(20),
    insufficientOfficialEvidence: z.boolean(),
  })
  .strict();

const QuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]/i.test(value), {
    message: 'credential-like values are not permitted',
  });

const HOSTED_WEB_SEARCH_PROMPT = readPromptMarkdown();

type SearchPass = 'authoritative_domains' | 'broader_web';

export function createHostedWebSearchResearchTool(input: {
  runner: AgentRunner;
  config: MarketplaceResearchConfig;
  now?: () => Date;
}): ResearchTool {
  const now = input.now ?? (() => new Date());

  return {
    name: 'hosted_web_search',
    async call(rawInput: Record<string, unknown>): Promise<ResearchToolResult> {
      const query = parseQuery(rawInput.query);
      const official = await lookup({
        runner: input.runner,
        config: input.config,
        query,
        pass: 'authoritative_domains',
        allowedDomains: input.config.allowedDomains,
        now,
      });

      if (official.summary.status === 'failed' && official.summary.failureCategory !== 'no_results') {
        return resultFromPasses([official]);
      }

      const needsFallback =
        official.insufficientOfficialEvidence ||
        (official.summary.status === 'failed' && official.summary.failureCategory === 'no_results');
      if (!needsFallback) return resultFromPasses([official]);

      const broader = await lookup({
        runner: input.runner,
        config: input.config,
        query,
        pass: 'broader_web',
        allowedDomains: [],
        now,
      });
      return resultFromPasses([official, broader]);
    },
  };
}

type PassResult = {
  citations: ToolCitation[];
  summary: ResearchSearchSummary;
  insufficientOfficialEvidence: boolean;
};

async function lookup(input: {
  runner: AgentRunner;
  config: MarketplaceResearchConfig;
  query: string;
  pass: SearchPass;
  allowedDomains: readonly string[];
  now: () => Date;
}): Promise<PassResult> {
  const startedAt = input.now().toISOString();

  try {
    const filters = input.allowedDomains.length > 0 ? { allowedDomains: [...input.allowedDomains] } : undefined;
    const run = await runStructuredModule({
      runner: input.runner,
      moduleId: 'm3',
      modulePrompt: HOSTED_WEB_SEARCH_PROMPT,
      input: { query: input.query, pass: input.pass, allowedDomains: [...input.allowedDomains] },
      outputSchema: HostedWebSearchLookupSchema,
      trace: { runId: 'marketplace-hosted-web-search', stage: 'm3_research' },
      hostedTools: [webSearchTool({ searchContextSize: input.config.searchContextSize, filters })],
      model: input.config.model,
    });

    const completedAt = input.now().toISOString();
    if (run.output.citations.some((citation) => !citation.url || !citation.url.startsWith('https://'))) {
      return failedPass(input, startedAt, completedAt, 'invalid_citations');
    }

    const citations = run.output.citations.map((citation) =>
      normalizeCitation(citation as z.infer<typeof LookupCitationSchema> & { url: string }, input.pass, input.config),
    );
    const failureCategory = citations.length === 0 ? 'no_results' : undefined;
    const summary = ResearchSearchSummarySchema.parse({
      pass: input.pass,
      status: failureCategory ? 'failed' : 'completed',
      citationCount: citations.length,
      officialCitationCount: citations.filter((citation) => citation.sourceType?.startsWith('official_')).length,
      broaderCitationCount: citations.filter((citation) => citation.searchPass === 'broader_web').length,
      allowedDomainCount: input.allowedDomains.length,
      ...(failureCategory ? { failureCategory } : {}),
      ...(run.usage?.totalTokens !== undefined ? { totalTokens: run.usage.totalTokens } : {}),
      ...(run.usage?.estimatedCostUsd !== undefined ? { estimatedCostUsd: run.usage.estimatedCostUsd } : {}),
      startedAt,
      completedAt,
    });

    return { citations, summary, insufficientOfficialEvidence: run.output.insufficientOfficialEvidence };
  } catch (error) {
    if (isUnsafeLocalInputError(error)) throw error;
    return failedPass(input, startedAt, input.now().toISOString(), 'connector_failed');
  }
}

function normalizeCitation(
  citation: z.infer<typeof LookupCitationSchema> & { url: string },
  pass: SearchPass,
  config: MarketplaceResearchConfig,
): ToolCitation {
  const domain = new URL(citation.url).hostname.toLowerCase();
  const isConfiguredOfficial = config.allowedDomains.some(
    (allowed) => domain === allowed || domain.endsWith(`.${allowed}`),
  );
  const isDocumentationDomain = /^(?:docs?|help|developers?)\./.test(domain) || domain.endsWith('.dev');

  return {
    source: 'web',
    title: citation.title,
    url: citation.url,
    excerpt: citation.excerpt,
    fetchedAt: citation.fetchedAt,
    domain,
    sourceType: isConfiguredOfficial
      ? isDocumentationDomain
        ? 'official_platform'
        : 'official_marketplace'
      : 'public_web',
    retrievalMethod: 'openai_hosted_web_search',
    searchPass: pass,
  };
}

function failedPass(
  input: { pass: SearchPass; allowedDomains: readonly string[] },
  startedAt: string,
  completedAt: string,
  failureCategory: ResearchSearchSummary['failureCategory'],
): PassResult {
  return {
    citations: [],
    insufficientOfficialEvidence: input.pass === 'authoritative_domains',
    summary: ResearchSearchSummarySchema.parse({
      pass: input.pass,
      status: 'failed',
      citationCount: 0,
      officialCitationCount: 0,
      broaderCitationCount: 0,
      allowedDomainCount: input.allowedDomains.length,
      failureCategory,
      startedAt,
      completedAt,
    }),
  };
}

function resultFromPasses(passes: readonly PassResult[]): ResearchToolResult {
  return {
    citations: passes.flatMap((pass) => pass.citations),
    data: { searchSummaries: passes.map((pass) => pass.summary) },
  };
}

function parseQuery(value: unknown): string {
  const parsed = QuerySchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('validation_failed', 'Hosted web-search query failed validation');
  }
  return parsed.data;
}

function isUnsafeLocalInputError(error: unknown): error is AppError {
  return error instanceof AppError && error.code === 'configuration_failed';
}

function readPromptMarkdown(): string {
  const adjacent = new URL('./hosted-web-search-prompt.md', import.meta.url);
  const url = existsSync(adjacent)
    ? adjacent
    : new URL('../../../src/agents/research/hosted-web-search-prompt.md', import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8').trim();
}
