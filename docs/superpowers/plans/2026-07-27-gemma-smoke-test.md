# Gemma Smoke Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `test/gemma.live.test.ts` — a single live integration test that proves the full Gemma → tool_use → retrieval → synthesis loop works against a real Ollama instance.

**Architecture:** One `node:test` test file. Gate: skipped unless `LIVE_SMOKE=1`. Wires `GemmaModelProvider` + `ContextWindowGuardedProvider` + `OllamaEmbeddingProvider` + `InMemoryVectorStore` + `createRetrievalPipeline` + `createSearchKnowledgeBaseTool` + `InMemoryToolRegistry` + `RagQueryAgent` — all from `@buffr/kernel`, no database. Indexes 3 hard-coded text documents, then asks one question and asserts the search tool was called and the answer is non-empty.

**Tech Stack:** TypeScript, `node:test`, `@buffr/kernel`, Ollama (gemma2:9b + nomic-embed-text:v1.5)

## Global Constraints

- ESM only: `"type": "module"`, all local imports use `.js` extension; package imports have no extension
- `"module": "NodeNext"` / `"moduleResolution": "NodeNext"`
- Tests use `node:test` (no vitest) — flat in `test/` to match glob `dist/test/*.test.js`
- Test command: `npm test` → `npm run build && node --test --test-concurrency=1 dist/test/*.test.js`
- No new npm dependencies — everything needed is already in `@buffr/kernel`
- YAGNI: one test, two assertions, nothing extra

---

### Task 1: Gemma live smoke test

**Files:**
- Create: `test/gemma.live.test.ts`

**Interfaces:**
- Consumes from `@buffr/kernel`:
  - `GemmaModelProvider` constructor: `new GemmaModelProvider({ host: string })`
  - `ContextWindowGuardedProvider` constructor: `new ContextWindowGuardedProvider(provider, { maxTokens: number })`
  - `OllamaEmbeddingProvider` constructor: `new OllamaEmbeddingProvider({ model: string; host: string })`
  - `InMemoryVectorStore` constructor: `new InMemoryVectorStore(dimension: number)`
  - `createRetrievalPipeline(wiring: { embedder, store }): RetrievalPipeline` where `pipeline.index(doc: { id: string; text: string; meta?: Record<string, unknown> }): Promise<void>`
  - `createSearchKnowledgeBaseTool(pipeline): { definition: ToolDefinition; handler: ToolHandler }`
  - `InMemoryToolRegistry` constructor: `new InMemoryToolRegistry(definitions: ToolDefinition[], handlers: Record<string, ToolHandler>)`
  - `RagQueryAgent` constructor: `new RagQueryAgent({ model, tools, profile?, prompt?, trace? })`
  - `RagQueryAgent.answer(question: string): Promise<string>`

- [ ] **Step 1: Write the test file**

Create `test/gemma.live.test.ts` with the following exact content:

```typescript
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
```

- [ ] **Step 2: Verify the test skips in normal npm test**

Run: `npm test`

Expected: build succeeds, test suite runs, the new `gemma.live.test.ts` test appears as `# SKIP` with no failure. Total pass count unchanged from before (22 passing tests, 1 skipped).

If the build fails with a TypeScript error, fix the import or type before continuing.

- [ ] **Step 3: Verify the test passes with Ollama**

Prerequisite: Ollama running locally with both models pulled:
```
ollama pull gemma2:9b
ollama pull nomic-embed-text:v1.5
```

Run: `LIVE_SMOKE=1 npm test`

Expected output (approximately):
```
▶ Gemma smoke: tool_use → retrieval → synthesis
  ✓ Gemma smoke: tool_use → retrieval → synthesis (≈30–90s)
```

Both assertions must pass:
- `search_knowledge_base should have been called` — Gemma emitted a parseable tool_use
- `answer should be non-empty` — Gemma synthesized a final answer

If `searchCallCount` stays at 0 but the test doesn't error: Gemma returned a plain text response without calling the tool. This is a model behaviour issue — check the system prompt by adding a temporary `console.error(answer)` before the assertions.

If the test times out at 120 seconds: Ollama is not running, or the model is not pulled.

- [ ] **Step 4: Commit**

```bash
git add test/gemma.live.test.ts
git commit -m "test: add Gemma live smoke test (LIVE_SMOKE=1 to run)"
```
