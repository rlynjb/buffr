import { config as loadEnv } from 'dotenv';
import {
  OllamaEmbeddingProvider, createRetrievalPipeline, createSearchKnowledgeBaseTool,
  InMemoryToolRegistry, GemmaModelProvider, ContextWindowGuardedProvider, RagQueryAgent,
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
 * - Retrievable conversation memory: after each turn the exchange is embedded into
 *   the SAME vector store (tagged kind=memory), so future turns surface relevant past
 *   exchanges via the existing search_knowledge_base tool — across sessions, not just
 *   within one. This is the "knows me over time" loop.
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

  const conversationId = await startConversation(pool, cfg.appId);
  const trace = new SupabaseTraceSink({ pool, conversationId });
  const agent = new RagQueryAgent({ model, tools, profile, trace });

  let turn = 0;
  return {
    async ask(question: string): Promise<string> {
      await persistMessage(pool, conversationId, 'user', question);
      const answer = await agent.answer(question);
      await trace.flush();
      // Retrievable memory: embed this exchange into the same store so future
      // turns recall it via search_knowledge_base, exactly like a document. The
      // dropped chunks->documents FK is what lets a memory chunk live here with
      // no documents row. Best-effort: a memory-write failure must not lose the
      // answer the user already has.
      try {
        await pipeline.index({
          id: `mem:${conversationId}:${turn}`,
          text: `Past exchange — you asked: "${question}"\nbuffr answered: "${answer}"`,
          meta: { kind: 'memory', conversationId },
        });
      } catch {
        // swallow: memory is best-effort, the turn already succeeded
      }
      turn += 1;
      return answer;
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
