import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GemmaModelProvider,
  ContextWindowGuardedProvider,
  OllamaEmbeddingProvider,
  InMemoryVectorStore,
  createRetrievalPipeline,
  createSearchKnowledgeBaseTool,
  InMemoryToolRegistry,
  RagQueryAgent,
} from '@buffr/kernel';

const SKIP = process.env['LIVE_SMOKE'] !== '1';
const OLLAMA_HOST = process.env['OLLAMA_HOST'] ?? 'http://localhost:11434';

const DOCS = [
  {
    id: 'doc-runtime',
    text: 'buffr is a self-hosted personal agent built on the @buffr/kernel runtime. The runtime provides a model-agnostic agent loop, tool registry, and retrieval pipeline.',
  },
  {
    id: 'doc-model',
    text: 'buffr uses Gemma 2 9b running locally via Ollama for language model inference. The context window is limited to 8192 tokens.',
  },
  {
    id: 'doc-retrieval',
    text: 'buffr uses nomic-embed-text embeddings (768 dimensions) for semantic search over a pgvector-backed knowledge base.',
  },
];

test('Gemma smoke: tool_use → retrieval → synthesis', { skip: SKIP, timeout: 120_000 }, async () => {
  const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: OLLAMA_HOST });
  const store    = new InMemoryVectorStore(768);
  const pipeline = createRetrievalPipeline({ embedder, store });

  for (const doc of DOCS) await pipeline.index(doc);

  const { definition, handler } = createSearchKnowledgeBaseTool(pipeline);
  let searchCallCount = 0;
  const spyHandler: typeof handler = (args, opts) => {
    searchCallCount += 1;
    return handler(args, opts);
  };

  const tools = new InMemoryToolRegistry([definition], { [definition.name]: spyHandler });
  const model = new ContextWindowGuardedProvider(
    new GemmaModelProvider({ host: OLLAMA_HOST }),
    { maxTokens: 8192 },
  );
  const agent = new RagQueryAgent({ model, tools });

  const answer = await agent.answer('What model does buffr use for inference?');

  assert.ok(searchCallCount > 0, 'search_knowledge_base should have been called');
  assert.ok(answer.length > 0, 'answer should be non-empty');
});
