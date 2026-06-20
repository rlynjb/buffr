import { config as loadEnv } from 'dotenv';
import { OllamaEmbeddingProvider, createRetrievalPipeline, createSearchKnowledgeBaseTool } from '@aptkit/retrieval';
import { InMemoryToolRegistry } from '@aptkit/tools';
import { GemmaModelProvider } from '@aptkit/provider-gemma';
import { ContextWindowGuardedProvider } from '@aptkit/provider-local';
import { RagQueryAgent } from '@aptkit/agent-rag-query';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { PgVectorStore } from '../pg-vector-store.js';
import { loadProfile } from '../profile.js';
import { startConversation, persistMessage, SupabaseTraceSink } from '../supabase-trace-sink.js';

loadEnv();
const cfg = loadConfig(process.env);
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');
const question = process.argv.slice(2).join(' ');
if (!question) throw new Error('usage: npm run ask -- "your question"');

const pool = createPool(cfg.databaseUrl);
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
const tools = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });

const model = new ContextWindowGuardedProvider(new GemmaModelProvider({ host: cfg.ollamaHost }), { maxTokens: 8192 });
const profile = await loadProfile(pool, cfg.appId);

const conversationId = await startConversation(pool, cfg.appId);
await persistMessage(pool, conversationId, 'user', question);
const trace = new SupabaseTraceSink({ pool, conversationId });

const agent = new RagQueryAgent({ model, tools, profile, trace });
const answer = await agent.answer(question);
await trace.flush();

process.stdout.write(`\n${answer}\n`);
await pool.end();
