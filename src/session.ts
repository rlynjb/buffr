import { config as loadEnv } from 'dotenv';
import {
  OllamaEmbeddingProvider, createRetrievalPipeline, createSearchKnowledgeBaseTool,
  InMemoryToolRegistry, GemmaModelProvider, ContextWindowGuardedProvider, RagQueryAgent,
  createConversationMemory,
} from '@buffr/kernel';
import { RssConnector, GoogleTrendsConnector, AmazonReviewsConnector } from '@buffr/connectors';
import { createFetchRssTool } from './connector-tools/rss-tool.js';
import { createFetchTrendsTool } from './connector-tools/trends-tool.js';
import { createFetchReviewsTool } from './connector-tools/amazon-tool.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { PgVectorStore } from './pg-vector-store.js';
import { loadProfile } from './profile.js';
import { startConversation, persistMessage, SupabaseTraceSink } from './supabase-trace-sink.js';

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
export type ChatSession = {
  ask(question: string): Promise<string>;
  close(): Promise<void>;
};

export async function createChatSession(): Promise<ChatSession> {
  loadEnv();
  const cfg = loadConfig(process.env);
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');

  const pool = createPool(cfg.databaseUrl);
  const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
  const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
  const pipeline = createRetrievalPipeline({ embedder, store });
  const searchTool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
  const rssTool    = createFetchRssTool(new RssConnector());
  const trendsTool = createFetchTrendsTool(new GoogleTrendsConnector());
  const amazonTool = createFetchReviewsTool(new AmazonReviewsConnector());

  const tools = new InMemoryToolRegistry(
    [searchTool.definition, rssTool.definition, trendsTool.definition, amazonTool.definition],
    {
      [searchTool.definition.name]: searchTool.handler,
      [rssTool.definition.name]:    rssTool.handler,
      [trendsTool.definition.name]: trendsTool.handler,
      [amazonTool.definition.name]: amazonTool.handler,
    },
  );

  const model = new ContextWindowGuardedProvider(new GemmaModelProvider({ host: cfg.ollamaHost }), { maxTokens: 8192 });
  const profile = await loadProfile(pool, cfg.appId);

  // Retrievable episodic memory over buffr's own store. The engine (embed, tag,
  // recall) lives in @buffr/kernel; buffr injects the PgVectorStore. Sharing the
  // document store means memory surfaces via the existing search_knowledge_base
  // tool — memory chunks live with no documents row, which the dropped FK allows.
  const memory = createConversationMemory({ embedder, store });

  const conversationId = await startConversation(pool, cfg.appId);
  const trace = new SupabaseTraceSink({ pool, conversationId });
  const agent = new RagQueryAgent({
    model,
    tools,
    profile,
    trace,
    allowedTools: [
      searchTool.definition.name,
      rssTool.definition.name,
      // trendsTool: google-trends-api scrapes an unofficial endpoint that
      // Google frequently blocks with an HTML response, causing the tool to
      // throw on every call and the agent to spiral. Re-enable when replaced
      // with a proper API.
      amazonTool.definition.name,
    ],
    prompt: [
      'You are a personal knowledge assistant with access to the following tools:',
      '',
      `- ${searchTool.definition.name}: search indexed personal knowledge (journal entries, tasks, nutrition, workouts, habits, past conversations).`,
      `- ${rssTool.definition.name}: fetch live articles from an RSS feed URL. Known-working feeds:`,
      '    AI/ML news: https://www.artificialintelligence-news.com/feed/',
      '    AI on HN:   https://hnrss.org/frontpage?tags=ai',
      '    Tech (TC):  https://techcrunch.com/tag/artificial-intelligence/feed/',
      '    HN front:   https://hnrss.org/frontpage',
      `- ${amazonTool.definition.name}: fetch product reviews from Amazon by product URL or ASIN.`,
      '',
      'Rules:',
      `- For questions about the user's personal life, history, habits, work, or anything that may be in their knowledge base: call ${searchTool.definition.name} first.`,
      `- For questions about news or articles from a specific site: call ${rssTool.definition.name} with the site's RSS feed URL.`,
      `- For questions about product reviews: call ${amazonTool.definition.name}.`,
      '- Always use a tool before answering. Do not answer from memory alone.',
      '- Ground every answer in what the tools return. Cite sources when available.',
    ].join('\n'),
  });

  return {
    async ask(question: string): Promise<string> {
      await persistMessage(pool, conversationId, 'user', question);
      const answer = await agent.answer(question);
      await trace.flush();
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
