import { config as loadEnv } from 'dotenv';
import {
  OllamaEmbeddingProvider, createRetrievalPipeline, createSearchKnowledgeBaseTool,
  InMemoryToolRegistry, GemmaModelProvider, ContextWindowGuardedProvider, RagQueryAgent,
  createConversationMemory, InMemoryCache, CachedEmbeddingProvider, PromptRegistry,
} from '@buffr/kernel';
import {
  RssConnector, GoogleTrendsConnector, AmazonReviewsConnector,
  BraveSearchConnector, TavilySearchConnector, GoogleSearchConnector,
  CachedConnector,
} from '@buffr/connectors';
import { createFetchRssTool } from './connector-tools/rss-tool.js';
import { createFetchTrendsTool } from './connector-tools/trends-tool.js';
import { createFetchReviewsTool } from './connector-tools/amazon-tool.js';
import { createBraveSearchTool } from './connector-tools/brave-tool.js';
import { createTavilySearchTool } from './connector-tools/tavily-tool.js';
import { createGoogleSearchTool } from './connector-tools/google-tool.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { PgVectorStore } from './pg-vector-store.js';
import { loadProfile } from './profile.js';
import { startConversation, persistMessage, SupabaseTraceSink } from './supabase-trace-sink.js';
import type { CapabilityTraceSink, CapabilityEvent } from '@buffr/kernel';
import { readFile } from 'node:fs/promises';
import { Scorer } from '@buffr/capabilities';
import type { ScorecardDefinition } from '@buffr/capabilities';
import { COMPANY_SCORECARD, ETF_SCORECARD } from '@buffr/domain-pack-investing';
import type { AgentContext } from '@buffr/contracts';
import { InvestingEngine } from '@buffr/engine-investing';
import type { InvestingSource, InvestingOutput } from '@buffr/engine-investing';
import { MarketResearchEngine } from '@buffr/engine-market-research';
import type { MarketResearchSource, MarketResearchOutput } from '@buffr/engine-market-research';
import { MARKET_RESEARCH_SCORECARD } from '@buffr/domain-pack-market-research';

/**
 * A long-lived chat session: one warm pg pool and one conversation held across
 * every turn (unlike the one-shot `ask` CLI, which opens and closes per call).
 * The agent itself is built once; each `ask()` persists the user turn, runs the
 * agent, and flushes the trajectory into that single conversation.
 *
 * Memory model:
 * - Knowledge (indexed docs) and profile are recalled every turn (RAG + system prompt).
 * - Retrievable conversation memory: after each turn the exchange is embedded into the
 *   SAME vector store (tagged kind=memory), so future turns surface relevant past
 *   exchanges via the existing search_knowledge_base tool — across sessions.
 *   The memory engine lives in @buffr/kernel; buffr only injects its PgVectorStore.
 * - Still missing: sequential in-prompt turn history (RagQueryAgent.answer() treats each
 *   question independently). Retrieval-based recall above gives relevance-based memory
 *   without it.
 */
export type TurnStats = {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  promptVersion?: string;
};
export type AskOptions = {
  onStatus?: (msg: string) => void;
  onTokens?: (delta: { input: number; output: number }) => void;
  onComplete?: (stats: TurnStats) => void;
};

const TOOL_LABELS: Record<string, string> = {
  search_knowledge_base: 'searching knowledge base',
  fetch_rss_feed:        'fetching RSS feed',
  web_search_google:     'searching Google',
  web_search_brave:      'searching Brave',
  web_search_tavily:     'searching Tavily',
  fetch_amazon_reviews:  'fetching Amazon reviews',
  fetch_search_trends:   'fetching search trends',
};

function toolStatusLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? `calling ${toolName}`;
}

export type ChatSession = {
  ask(question: string, opts?: AskOptions): Promise<string>;
  analyze(ticker: string, entityType: 'company' | 'etf', opts?: AskOptions): Promise<string>;
  evalInvesting(): Promise<string>;
  research(topic: string, opts?: AskOptions): Promise<string>;
  evalResearch(): Promise<string>;
  close(): Promise<void>;
};

// Bump when the routing prompt rules change so outputs carry the new version.
const ROUTING_PROMPT_VERSION = '1.0.0';

// 1-hour cache for external connector results.
const CONNECTOR_CACHE_TTL_MS = 60 * 60 * 1000;

const ETF_TICKERS = new Set([
  'VTI', 'SPY', 'QQQ', 'IVV', 'VOO', 'VXUS', 'BND', 'GLD', 'SLV', 'TLT',
  'AGG', 'LQD', 'EFA', 'EEM', 'VEA', 'VWO', 'VNQ', 'SCHD', 'JEPI', 'ARKK',
  'XLF', 'XLE', 'XLK', 'XLV', 'SPDW', 'IEMG',
]);

export function detectEntityType(ticker: string): 'company' | 'etf' {
  return ETF_TICKERS.has(ticker.toUpperCase()) ? 'etf' : 'company';
}

type EvalFixture = {
  description: string;
  findings: Parameters<Scorer['execute']>[0]['findings'];
  evidenceCount: number;
  expectedTotalScore: number;
};

async function formatEval(
  scorer: Scorer,
  evalCtx: AgentContext,
  companyFixtures: EvalFixture[],
  etfFixtures: EvalFixture[],
): Promise<string> {
  const total = companyFixtures.length + etfFixtures.length;
  let passed = 0;
  const lines: string[] = [`Investing eval — ${total} fixtures`, ''];

  async function runGroup(label: string, fixtures: EvalFixture[], scorecard: ScorecardDefinition): Promise<void> {
    lines.push(`${label} (${fixtures.length}):`);
    for (const fixture of fixtures) {
      const result = await scorer.execute(
        { findings: fixture.findings, scorecard, evidenceCount: fixture.evidenceCount },
        evalCtx,
      );
      const actual = result.data.totalScore;
      const expected = fixture.expectedTotalScore;
      const delta = Math.abs(actual - expected);
      const ok = delta <= 0.01;
      if (ok) passed++;
      const mark = ok ? '✔' : '✘';
      const desc = fixture.description.slice(0, 42).padEnd(42);
      lines.push(`  ${mark}  ${desc}  expected ${expected.toFixed(2)}  got ${actual.toFixed(2)}  Δ ${delta.toFixed(2)}`);
    }
    lines.push('');
  }

  await runGroup('Company', companyFixtures, COMPANY_SCORECARD);
  await runGroup('ETF', etfFixtures, ETF_SCORECARD);
  lines.push(`${passed}/${total} passed`);
  return lines.join('\n');
}

function formatAnalysis(output: InvestingOutput): string {
  const { summary, detail } = output;
  const score = summary.totalScore.toFixed(1);
  const confidence = Math.round(summary.confidence * 100);
  const entityLabel = summary.entityType === 'etf' ? 'ETF' : 'Company';

  const lines: string[] = [
    `${summary.ticker} — ${entityLabel}  ·  Score: ${score}/100  ·  Confidence: ${confidence}%`,
    '',
    summary.explanation,
  ];

  if (summary.keyLessons.length > 0) {
    lines.push('', 'Key lessons:');
    for (const lesson of summary.keyLessons) lines.push(`• ${lesson}`);
  }

  if (summary.actionableNext.length > 0) {
    lines.push('', 'Next steps:');
    for (const step of summary.actionableNext) lines.push(`• ${step}`);
  }

  lines.push('', `Sources: ${detail.evidence.length} signals collected`);

  if (summary.confidence < 0.5) {
    lines.push('⚠ Low confidence — limited evidence collected.');
  }
  for (const warning of summary.warnings) {
    lines.push(`⚠ ${warning}`);
  }

  return lines.join('\n');
}

function formatResearch(output: MarketResearchOutput): string {
  const { summary, detail } = output;
  const confidence = Math.round(summary.confidence * 100);
  const lines: string[] = [
    `Topic: ${summary.topic}  ·  Score: ${summary.totalScore.toFixed(1)}/100  ·  Confidence: ${confidence}%`,
    '',
    summary.explanation,
    '',
    'Top problems:',
  ];

  summary.keyProblems.forEach((problem, i) => {
    lines.push(`• ${problem}`);
    const angle = summary.productAngles[i];
    if (angle) lines.push(`  → ${angle}`);
  });

  if (summary.confidence < 0.5) {
    lines.push('', '⚠ Low confidence — limited evidence collected.');
  }
  for (const warning of summary.warnings) {
    lines.push(`⚠ ${warning}`);
  }

  const sourceTypes = [...new Set(detail.evidence.map(e => e.sourceType))];
  lines.push('');
  lines.push(`Sources: ${detail.evidence.length} signals collected (${sourceTypes.join(' · ')})`);

  return lines.join('\n');
}

type ResearchEvalFixture = {
  description: string;
  findings: Parameters<Scorer['execute']>[0]['findings'];
  evidenceCount: number;
  expectedTotalScore: number;
};

async function formatResearchEval(
  scorer: Scorer,
  evalCtx: AgentContext,
  fixtures: ResearchEvalFixture[],
): Promise<string> {
  let passed = 0;
  const lines: string[] = [`Market research eval — ${fixtures.length} fixtures`, ''];

  for (const fixture of fixtures) {
    const result = await scorer.execute(
      { findings: fixture.findings, scorecard: MARKET_RESEARCH_SCORECARD, evidenceCount: fixture.evidenceCount },
      evalCtx,
    );
    const actual = result.data.totalScore;
    const expected = fixture.expectedTotalScore;
    const delta = Math.abs(actual - expected);
    const ok = delta <= 0.01;
    if (ok) passed++;
    const mark = ok ? '✔' : '✘';
    const desc = fixture.description.slice(0, 42).padEnd(42);
    lines.push(`  ${mark}  ${desc}  expected ${expected.toFixed(2)}  got ${actual.toFixed(2)}  Δ ${delta.toFixed(2)}`);
  }

  lines.push('');
  lines.push(`${passed}/${fixtures.length} passed`);
  return lines.join('\n');
}

export async function createChatSession(): Promise<ChatSession> {
  loadEnv();
  const cfg = loadConfig(process.env);
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');

  const pool = createPool(cfg.databaseUrl);

  // Embedding cache persists for the session lifetime (no TTL) — same model,
  // same text → same vector, so stale-embedding risk is zero within a session.
  const embedCache = new InMemoryCache<string, number[]>();
  const embedder = new CachedEmbeddingProvider(
    new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost }),
    embedCache,
  );

  const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
  const pipeline = createRetrievalPipeline({ embedder, store });
  const searchTool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4, minScore: 0.65 });

  const rssTool    = createFetchRssTool(new CachedConnector(new RssConnector(), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS));
  const trendsTool = createFetchTrendsTool(new CachedConnector(new GoogleTrendsConnector(), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS));
  const amazonTool = createFetchReviewsTool(new CachedConnector(new AmazonReviewsConnector(), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS));
  const braveTool  = cfg.braveApiKey
    ? createBraveSearchTool(new CachedConnector(new BraveSearchConnector(cfg.braveApiKey), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS))
    : null;
  const tavilyTool = cfg.tavilyApiKey
    ? createTavilySearchTool(new CachedConnector(new TavilySearchConnector(cfg.tavilyApiKey), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS))
    : null;
  const googleTool = (cfg.googleApiKey && cfg.googleCx)
    ? createGoogleSearchTool(new CachedConnector(new GoogleSearchConnector(cfg.googleApiKey, cfg.googleCx), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS))
    : null;

  const allToolDefs = [
    searchTool.definition,
    rssTool.definition,
    trendsTool.definition,
    amazonTool.definition,
    ...(braveTool  ? [braveTool.definition]  : []),
    ...(tavilyTool ? [tavilyTool.definition] : []),
    ...(googleTool ? [googleTool.definition] : []),
  ];
  const allToolHandlers: Record<string, typeof searchTool.handler> = {
    [searchTool.definition.name]: searchTool.handler,
    [rssTool.definition.name]:    rssTool.handler,
    [trendsTool.definition.name]: trendsTool.handler,
    [amazonTool.definition.name]: amazonTool.handler,
    ...(braveTool  ? { [braveTool.definition.name]:  braveTool.handler }  : {}),
    ...(tavilyTool ? { [tavilyTool.definition.name]: tavilyTool.handler } : {}),
    ...(googleTool ? { [googleTool.definition.name]: googleTool.handler } : {}),
  };
  const tools = new InMemoryToolRegistry(allToolDefs, allToolHandlers);

  const model = new ContextWindowGuardedProvider(new GemmaModelProvider({ host: cfg.ollamaHost }), { maxTokens: 8192 });
  const profile = await loadProfile(pool, cfg.appId);

  // Retrievable episodic memory over buffr's own store. The engine (embed, tag,
  // recall) lives in @buffr/kernel; buffr injects the PgVectorStore. Sharing the
  // document store means memory surfaces via the existing search_knowledge_base
  // tool — memory chunks live with no documents row, which the dropped FK allows.
  const memory = createConversationMemory({ embedder, store });

  const investingSources: InvestingSource[] = [
    ...(cfg.braveApiKey ? [{
      connector: new CachedConnector(
        new BraveSearchConnector(cfg.braveApiKey),
        new InMemoryCache(),
        CONNECTOR_CACHE_TTL_MS,
      ),
      paramsFor: (ticker: string, entityType: 'company' | 'etf') => ({
        query: `${ticker} ${entityType} financial analysis earnings`,
        count: 5,
      }),
      optional: true,
    } satisfies InvestingSource] : []),
    ...(cfg.tavilyApiKey ? [{
      connector: new CachedConnector(
        new TavilySearchConnector(cfg.tavilyApiKey),
        new InMemoryCache(),
        CONNECTOR_CACHE_TTL_MS,
      ),
      paramsFor: (ticker: string, entityType: 'company' | 'etf') => ({
        query: `${ticker} ${entityType} investment analysis`,
        maxResults: 5,
      }),
      optional: true,
    } satisfies InvestingSource] : []),
  ];

  const investingEngine = investingSources.length > 0
    ? new InvestingEngine({ model, sources: investingSources, memory })
    : null;

  const researchSources: MarketResearchSource[] = [
    {
      connector: new CachedConnector(new GoogleTrendsConnector(), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS),
      paramsFor: (topic: string) => ({ keywords: [topic], timeframe: 'now 7-d' }),
      optional: true,
    },
    ...(cfg.braveApiKey ? [{
      connector: new CachedConnector(
        new BraveSearchConnector(cfg.braveApiKey),
        new InMemoryCache(),
        CONNECTOR_CACHE_TTL_MS,
      ),
      paramsFor: (topic: string) => ({
        query: `${topic} problems complaints frustrations reddit forum`,
        count: 5,
      }),
      optional: true,
    } satisfies MarketResearchSource] : []),
    ...(cfg.tavilyApiKey ? [{
      connector: new CachedConnector(
        new TavilySearchConnector(cfg.tavilyApiKey),
        new InMemoryCache(),
        CONNECTOR_CACHE_TTL_MS,
      ),
      paramsFor: (topic: string) => ({
        query: `${topic} issues pain points problems complaints`,
        maxResults: 5,
      }),
      optional: true,
    } satisfies MarketResearchSource] : []),
  ];
  const researchEngine = new MarketResearchEngine({ model, sources: researchSources, memory });

  const conversationId = await startConversation(pool, cfg.appId);
  const supabaseTrace = new SupabaseTraceSink({ pool, conversationId });

  // Build routing prompt and register it so each turn carries a promptVersion stamp.
  const webSearchTools = [tavilyTool, braveTool, googleTool].filter(Boolean);
  const primaryWebSearch = webSearchTools[0] ?? null;
  const routingPrompt = [
    'You are a personal knowledge assistant. For EVERY question, always call tools to gather information before answering — never answer from memory alone.',
    '',
    'Available tools:',
    `- ${searchTool.definition.name}: search indexed personal knowledge (journal entries, tasks, nutrition, workouts, habits, past conversations).`,
    `- ${rssTool.definition.name}: fetch live articles from an RSS feed. Known-working feeds:`,
    '    AI/ML news: https://www.artificialintelligence-news.com/feed/',
    '    AI on HN:   https://hnrss.org/frontpage?tags=ai',
    '    Tech (TC):  https://techcrunch.com/tag/artificial-intelligence/feed/',
    '    HN front:   https://hnrss.org/frontpage',
    `- ${amazonTool.definition.name}: fetch product reviews from Amazon by product URL or ASIN.`,
    ...(tavilyTool ? [`- ${tavilyTool.definition.name}: search the live web for factual answers, news, and general knowledge.`] : []),
    ...(braveTool  ? [`- ${braveTool.definition.name}: search the live web for general knowledge and current information.`] : []),
    ...(googleTool ? [`- ${googleTool.definition.name}: search the web using Google Custom Search.`] : []),
    '',
    'Tool usage rules (always follow):',
    `1. ALWAYS call ${searchTool.definition.name} first for any question.`,
    primaryWebSearch
      ? `2. ALWAYS also call ${primaryWebSearch.definition.name} for any question about: companies, people, products, news, current events, or anything that might not be in personal records. Do NOT skip this step even if the knowledge base returned results.`
      : `2. For news or current events, call ${rssTool.definition.name} with a relevant feed URL.`,
    `3. For product reviews, call ${amazonTool.definition.name}.`,
    '4. Synthesize ALL tool results into one answer. Do not stop after just one tool.',
    '5. Cite sources when available.',
    '6. If the knowledge base returns zero relevant results (empty results array), say so clearly.',
    '7. NEVER fabricate information. Only use what the tools returned.',
  ].join('\n');

  const registry = new PromptRegistry();
  registry.register('rag-query-agent/routing', ROUTING_PROMPT_VERSION, routingPrompt);

  // Thin wrapper that intercepts events to forward live status and accumulate
  // token usage to the TUI. Mutable slots are swapped per-ask.
  let currentOnStatus: ((msg: string) => void) | undefined;
  let currentOnTokens: ((delta: { input: number; output: number }) => void) | undefined;
  let currentInputTokens = 0;
  let currentOutputTokens = 0;
  const trace: CapabilityTraceSink = {
    emit(event: CapabilityEvent) {
      if (event.type === 'tool_call_start' && currentOnStatus) {
        currentOnStatus(toolStatusLabel(event.toolName));
      }
      if (event.type === 'model_usage') {
        const deltaIn  = event.inputTokens  ?? 0;
        const deltaOut = event.outputTokens ?? 0;
        currentInputTokens  += deltaIn;
        currentOutputTokens += deltaOut;
        currentOnTokens?.({ input: deltaIn, output: deltaOut });
      }
      supabaseTrace.emit(event);
    },
  };

  const agent = new RagQueryAgent({
    model,
    tools,
    profile,
    trace,
    allowedTools: [
      searchTool.definition.name,
      rssTool.definition.name,
      // trendsTool: google-trends-api scrapes an unofficial endpoint that
      // Google frequently blocks with an HTML response. Re-enable when replaced.
      amazonTool.definition.name,
      ...(braveTool  ? [braveTool.definition.name]  : []),
      ...(tavilyTool ? [tavilyTool.definition.name] : []),
      ...(googleTool ? [googleTool.definition.name] : []),
    ],
    promptRegistry: registry,
    promptName: 'rag-query-agent/routing',
  });

  return {
    async ask(question: string, opts?: AskOptions): Promise<string> {
      currentOnStatus = opts?.onStatus;
      currentOnTokens = opts?.onTokens;
      currentInputTokens = 0;
      currentOutputTokens = 0;
      const startMs = Date.now();
      await persistMessage(pool, conversationId, 'user', question);
      const answer = await agent.answer(question);
      currentOnStatus = undefined;
      currentOnTokens = undefined;
      opts?.onComplete?.({
        durationMs: Date.now() - startMs,
        inputTokens: currentInputTokens,
        outputTokens: currentOutputTokens,
        promptVersion: agent.promptVersion,
      });
      await supabaseTrace.flush();
      // Best-effort: a memory-write failure must not lose the answer the user has.
      try {
        await memory.remember({ conversationId, question, answer });
      } catch {
        // swallow: memory is best-effort, the turn already succeeded
      }
      return answer;
    },
    async evalInvesting(): Promise<string> {
      const scorer = new Scorer();
      const evalCtx: AgentContext = {
        userId: cfg.appId, workspaceId: cfg.appId, traceId: 'eval',
        domain: 'investing', now: new Date().toISOString(), permissions: [],
      };
      const companyFixtures: EvalFixture[] = JSON.parse(
        await readFile(
          new URL('../../packages/domain-packs/investing/eval/company-fixtures.json', import.meta.url),
          'utf8',
        ),
      );
      const etfFixtures: EvalFixture[] = JSON.parse(
        await readFile(
          new URL('../../packages/domain-packs/investing/eval/etf-fixtures.json', import.meta.url),
          'utf8',
        ),
      );
      return formatEval(scorer, evalCtx, companyFixtures, etfFixtures);
    },
    async research(topic: string, opts?: AskOptions): Promise<string> {
      currentOnStatus = opts?.onStatus;
      currentOnTokens = opts?.onTokens;
      currentInputTokens = 0;
      currentOutputTokens = 0;
      opts?.onStatus?.('researching…');
      const startMs = Date.now();
      const agentCtx: AgentContext = {
        userId: cfg.appId,
        workspaceId: cfg.appId,
        traceId: `research-${topic}-${Date.now()}`,
        domain: 'market-research',
        now: new Date().toISOString(),
        permissions: [],
      };
      const result = await researchEngine.run({ topic, conversationId }, agentCtx);
      currentOnStatus = undefined;
      currentOnTokens = undefined;
      opts?.onComplete?.({
        durationMs: Date.now() - startMs,
        inputTokens: currentInputTokens,
        outputTokens: currentOutputTokens,
      });
      return formatResearch(result.data);
    },
    async evalResearch(): Promise<string> {
      const scorer = new Scorer();
      const evalCtx: AgentContext = {
        userId: cfg.appId, workspaceId: cfg.appId, traceId: 'eval-research',
        domain: 'market-research', now: new Date().toISOString(), permissions: [],
      };
      const fixtures: ResearchEvalFixture[] = JSON.parse(
        await readFile(
          new URL('../../packages/domain-packs/market-research/eval/fixtures.json', import.meta.url),
          'utf8',
        ),
      );
      return formatResearchEval(scorer, evalCtx, fixtures);
    },
    async analyze(ticker: string, entityType: 'company' | 'etf', opts?: AskOptions): Promise<string> {
      if (!investingEngine) {
        return 'No web search connectors configured — set BRAVE_API_KEY or TAVILY_API_KEY in .env';
      }
      currentOnStatus = opts?.onStatus;
      currentOnTokens = opts?.onTokens;
      currentInputTokens = 0;
      currentOutputTokens = 0;
      opts?.onStatus?.('analyzing…');
      const startMs = Date.now();
      const agentCtx: AgentContext = {
        userId: cfg.appId,
        workspaceId: cfg.appId,
        traceId: `${ticker}-${Date.now()}`,
        domain: 'investing',
        now: new Date().toISOString(),
        permissions: [],
      };
      const result = await investingEngine.run(
        { ticker, entityType, conversationId },
        agentCtx,
      );
      currentOnStatus = undefined;
      currentOnTokens = undefined;
      opts?.onComplete?.({
        durationMs: Date.now() - startMs,
        inputTokens: currentInputTokens,
        outputTokens: currentOutputTokens,
      });
      return formatAnalysis(result.data);
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
