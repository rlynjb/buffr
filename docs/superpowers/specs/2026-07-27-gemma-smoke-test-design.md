# Gemma Smoke Test Design

**Date:** 2026-07-27
**Status:** Approved

## Goal

Prove that the bounded agent loop runs against real Gemma 2 9b via Ollama: Gemma emits a parseable tool_use, the loop dispatches it to the search_knowledge_base tool, retrieval returns chunks, and Gemma synthesizes a non-empty grounded answer.

This is the Phase 1 de-risk check from `agent-layer-plan.md`.

## File

`test/gemma.live.test.ts` — one test using `node:test`, flat in `test/` alongside existing tests.

## Gate

Skipped unless `LIVE_SMOKE=1` env var is set. Normal `npm test` passes through with the test marked skipped. Run explicitly when Ollama is running:

```
LIVE_SMOKE=1 npm test
LIVE_SMOKE=1 OLLAMA_HOST=http://localhost:11434 npm test
```

Requires: `ollama pull gemma2:9b && ollama pull nomic-embed-text:v1.5`

## Wiring (all from `@buffr/kernel`, no database)

| Component | Value |
|---|---|
| `OllamaEmbeddingProvider` | `model: 'nomic-embed-text:v1.5'`, `host: OLLAMA_HOST` |
| `InMemoryVectorStore` | `dimension: 768` |
| `createRetrievalPipeline` | wired with embedder + store |
| `createSearchKnowledgeBaseTool` | wrapped with a spy that counts calls |
| `InMemoryToolRegistry` | search tool only |
| `GemmaModelProvider` | `host: OLLAMA_HOST` (default `http://localhost:11434`) |
| `ContextWindowGuardedProvider` | `maxTokens: 8192` |
| `RagQueryAgent` | no `trace`, no `profile` |

`OLLAMA_HOST` defaults to `http://localhost:11434` if unset.

## Corpus

Three hard-coded documents indexed before the test runs. Short enough to fit in one chunk each.

```
doc-runtime:   "buffr is a self-hosted personal agent built on the @buffr/kernel runtime. The runtime provides a model-agnostic agent loop, tool registry, and retrieval pipeline."
doc-model:     "buffr uses Gemma 2 9b running locally via Ollama for language model inference. The context window is limited to 8192 tokens."
doc-retrieval: "buffr uses nomic-embed-text embeddings (768 dimensions) for semantic search over a pgvector-backed knowledge base."
```

## Question

```
What model does buffr use for inference?
```

Narrow enough that `doc-model` ranks first; the expected answer mentions Gemma.

## Assertions

```typescript
assert.ok(searchCallCount > 0, 'search_knowledge_base should have been called');
assert.ok(answer.length > 0, 'answer should be non-empty');
```

`searchCallCount > 0` is the key gate: it proves Gemma emitted a parseable tool_use JSON and the loop dispatched it. If Gemma's output is too malformed to parse, the search tool is never called and this assertion fails.

## Timeout

`120_000` ms (120 seconds). Gemma is slow on first inference.

## What Does Not Change

- `packages/kernel` — untouched
- `src/session.ts` — untouched
- Existing test files — untouched
- `npm test` behavior without `LIVE_SMOKE=1` — unchanged (test is skipped)

## What This Does Not Test

- PostgreSQL / pgvector integration (uses InMemoryVectorStore)
- Profile injection (no profile passed)
- Connector tools (RagQueryAgent filters to search_knowledge_base only)
- Eval metrics (precision@k, faithfulness) — those are Phase 4
