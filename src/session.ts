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
  close(): Promise<void>;
};

// Bump when the routing prompt rules change so outputs carry the new version.
const ROUTING_PROMPT_VERSION = '1.0.0';

// 1-hour cache for external connector results.
const CONNECTOR_CACHE_TTL_MS = 60 * 60 * 1000;

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
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
