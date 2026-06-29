# AI Engineering — buffr-laptop, in one frame

This is the orientation page. Read it first, then open whatever sub-section the diagram sends you to.

## What buffr is, as an AI system

buffr-laptop is a local **retrieval-augmented generation (the RAG pipeline)** agent. You index your own markdown into Postgres, then chat with a model that answers *only* from what it retrieved. Everything runs on your laptop: Ollama serves `gemma2:9b` for generation and `nomic-embed-text:v1.5` for **embeddings (768-dim vectors)**, and Postgres with the **pgvector** extension stores and searches them via an **approximate nearest-neighbour index (the HNSW index)**.

The whole system in one picture — every box below maps to a sub-section of this guide:

```
buffr-laptop — the AI system, end to end

┌─ UI layer ─────────────────────────────────────────────────────────┐
│  Ink chat TUI (src/cli/chat.tsx)   ·   index/eval CLIs (src/cli/)    │
└───────────────────────────────┬────────────────────────────────────┘
                                │  ask(question)  ·  npm run index/eval
┌─ Session layer ───────────────▼────────────────────────────────────┐
│  createChatSession (src/session.ts)                                 │
│   builds the agent once · holds ONE conversation across turns       │
└──────┬─────────────────────────────────┬───────────────────┬───────┘
       │ system prompt                   │ agent loop        │ remember
       ▼                                 ▼                   ▼
┌─ Profile ──────┐   ┌─ Agent ─────────────────────┐  ┌─ Memory ───────────┐
│ me.md injected │   │ RagQueryAgent (aptkit)      │  │ createConversation │
│ (src/profile)  │   │  search_knowledge_base only │  │ Memory (@aptkit/   │
└────────────────┘   │  emulated tool-calling →    │  │ memory) — episodic │
                     │  gemma2:9b (Ollama)         │  └─────────┬──────────┘
                     └──────────────┬──────────────┘            │
                                    │ embed → ANN → rank → ground │
┌─ Retrieval / Storage layer ───────▼─────────────────────────────▼──┐
│  PgVectorStore (src/pg-vector-store.ts)  ·  RetrievalPipeline       │
│  Postgres + pgvector · vector(768) · HNSW cosine · app_id='laptop'  │
│  documents · chunks (memory rides here, meta.kind='memory')         │
│  conversations · messages (full trajectory) · profiles              │
└───────────────────────────────┬────────────────────────────────────┘
                                │ every CapabilityEvent
┌─ Observability ───────────────▼────────────────────────────────────┐
│  SupabaseTraceSink (src/supabase-trace-sink.ts) → agents.messages   │
│  precision@k / recall@k eval (src/cli/eval-cmd.ts)                  │
└─────────────────────────────────────────────────────────────────────┘
```

## The two paths that define the system

Every RAG system is two paths sharing one store. buffr is no exception.

```
INDEX PATH (offline, npm run index)        QUERY PATH (online, every chat turn)

  markdown file                              user question
      │                                          │
      ▼ chunkText (~512 chars)                    ▼ embed (nomic, 768-dim)
  chunks                                      query vector
      │                                          │
      ▼ embed (nomic, 768-dim)                    ▼ HNSW ANN search (cosine)
  768-dim vectors                            top-k chunks
      │                                          │
      ▼ upsert                                    ▼ stuff into prompt + ground
  agents.chunks (pgvector)  ◄──────────────  gemma2:9b answers, cites sources
```

The index path is `src/cli/index-cmd.ts` → `indexDocumentRow` (`src/runtime.ts`) → the pipeline's `chunkText` → embed → `PgVectorStore.upsert`. The query path is `RagQueryAgent.answer` → the `search_knowledge_base` tool → `PgVectorStore.search` → `gemma2:9b`. Both assert the 768 dimension before touching the database.

## The one fact that shapes everything: 768 is a one-way door

The embedding dimension (768, from `nomic-embed-text:v1.5`) is asserted in four places as defense-in-depth: at the embedding provider, at the pipeline wiring (`assertWiring`), per-vector on every upsert and search (`PgVectorStore.assertDim`), and in the SQL column type (`embedding vector(768)`). Change the embedding model and you change the dimension, and now the entire indexed corpus is unsearchable — you must re-index from scratch. That is why the assertion is loud and everywhere: a silent mismatch would corrupt retrieval invisibly. See `03-retrieval-and-rag/02-embedding-model-choice.md` and `01-llm-foundations/08-provider-abstraction.md`.

## The reliability ceiling you should know going in

gemma2:9b has **no native tool-calling**. aptkit emulates it: it renders the tool's JSON schema into the system prompt and parses a JSON object back out of the model's prose (`GemmaModelProvider`, `provider-gemma`). There is **no argument-schema validation** on the parsed call — if the model emits the wrong key, the `query` field comes back empty and the search silently returns whatever an empty-string query embeds to. That is the single biggest correctness risk in the system, and it is honest to name it. See `04-agents-and-tool-use/02-tool-calling.md`.

## How this guide is organized

Nine sub-sections, each a directory with its own README:

- **01-llm-foundations** — what the model is, tokens, sampling, structured output, streaming, cost, heuristic-before-LLM, provider abstraction, override locks.
- **02-context-and-prompts** — the context window, lost-in-the-middle, prompt chaining.
- **03-retrieval-and-rag** — embeddings, chunking, pgvector, dense/sparse, hybrid, reranking, query rewriting, stale embeddings, incremental indexing, RAG, GraphRAG.
- **04-agents-and-tool-use** — agents vs chains, tool calling (the emulated path), ReAct, routing, agent memory, error recovery.
- **05-evals-and-observability** — eval sets, eval methods, LLM-as-judge bias, observability.
- **06-production-serving** — caching, cost optimization, prompt injection, rate limiting, retry/circuit breaker.
- **07-system-design-templates** — search ranking and tech-support-chatbot interview reframes.
- **08-machine-learning** — classical ML as new ground (buffr trains nothing; these are taught as buildable targets).
- **09-ml-system-design-templates** — recommender, anomaly detection, object detection reframes.

Plus two root files: `ai-features-in-this-codebase.md` and `ml-features-in-this-codebase.md`.

## What this codebase does NOT yet exercise

Named honestly so you know where the gaps are — these are the strongest project-exercise targets:

- **Fine-tuning.** The captured trajectories (`agents.messages`) are a fine-tuning corpus, but no FT runs. This is the ceiling.
- **Reranking.** Single-stage ANN only; no cross-encoder second stage.
- **Hybrid / keyword search.** Pure dense retrieval; no BM25, no RRF fusion.
- **Streaming.** `RagQueryAgent.answer` awaits the full response; `stream: false` in the Gemma transport.
- **Caching.** No prompt cache, no semantic cache, no exact-match cache.
- **Chunking-strategy tuning.** Fixed 512-char windows, never tuned against the eval set.
- **Faithfulness eval.** `RubricJudge` exists in aptkit but is **unwired** in buffr — only precision@k/recall@k run.
- **Classical ML.** buffr trains no model. All of SECTION 04 is new ground.

## Cross-links to sibling guides

- `study-prompt-engineering/` — the prompt anatomy, single-purpose chains, the system-prompt-injection seam.
- `study-agent-architecture/` — the agent loop, agentic retrieval, bounded autonomy in depth.
- `study-database-systems/` — pgvector storage, HNSW internals, the `chunks` table.
- `study-dsa-foundations/` — ANN, the vector-space geometry, graph structure of HNSW.
- `study-testing/` — the eval seam, `node:test`, the DATABASE_URL-gated suite.
