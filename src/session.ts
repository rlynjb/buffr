import { config as loadEnv } from 'dotenv';
import {
  OllamaEmbeddingProvider, createRetrievalPipeline, createSearchKnowledgeBaseTool,
  InMemoryToolRegistry, GemmaModelProvider, ContextWindowGuardedProvider, RagQueryAgent,
  createConversationMemory,
} from '@rlynjb/aptkit-core';
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
 * - Retrievable conversation memory via @aptkit/memory: after each turn the exchange is
 *   embedded into the SAME vector store (tagged kind=memory), so future turns surface
 *   relevant past exchanges via the existing search_knowledge_base tool — across sessions.
 *   The memory engine is aptkit's; buffr only injects its PgVectorStore.
 * - Still missing: sequential in-prompt turn history (RagQueryAgent.answer() treats each
 *   question independently). That's an aptkit-side change; retrieval-based recall above
 *   gives relevance-based memory without it.
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
  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
  const tools = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });

  const model = new ContextWindowGuardedProvider(new GemmaModelProvider({ host: cfg.ollamaHost }), { maxTokens: 8192 });
  const profile = await loadProfile(pool, cfg.appId);

  // Retrievable episodic memory over buffr's own store. The engine (embed, tag,
  // recall) is aptkit's; buffr injects the PgVectorStore. Sharing the document
  // store means memory surfaces via the existing search_knowledge_base tool — and
  // memory chunks live with no documents row, which the dropped FK allows.
  const memory = createConversationMemory({ embedder, store });

  const conversationId = await startConversation(pool, cfg.appId);
  const trace = new SupabaseTraceSink({ pool, conversationId });
  const agent = new RagQueryAgent({ model, tools, profile, trace });

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
