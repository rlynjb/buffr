# Study — AI Engineering for buffr-laptop

An AI-engineering study guide generated against **this repo** (`buffr-laptop`) — a local RAG agent over Ollama (`gemma2:9b` + `nomic-embed-text:v1.5`) and Postgres/pgvector. Each concept file teaches the pattern, then anchors it to real code at `file:line`.

**Shape of this codebase:** LLM application engineering (the loopd shape) — single-purpose retrieval over a personal corpus, a bounded tool-calling agent, retrieval-based evals. It is **not** classical ML: buffr trains no model. SECTION 04 (machine learning) is therefore taught as new ground with buildable exercises, not as a description of existing code.

## Reading order

Start with **`00-overview.md`** — the whole system in one frame, the two paths, and the load-bearing facts (768 one-way door, the emulated-tool-calling ceiling, what's not yet exercised).

Then the sub-sections, in build order:

1. **`01-llm-foundations/`** — the model as a function; tokens, sampling, structured output, streaming, cost, heuristic-before-LLM, provider abstraction, override locks.
2. **`02-context-and-prompts/`** — the finite context window, lost-in-the-middle, prompt chaining.
3. **`03-retrieval-and-rag/`** — the core of buffr: embeddings → chunking → pgvector → ANN → RAG. Plus the patterns buffr doesn't yet run (hybrid, rerank, query rewrite, GraphRAG).
4. **`04-agents-and-tool-use/`** — the agent loop, the emulated tool-calling path, ReAct, routing, episodic memory, error recovery.
5. **`05-evals-and-observability/`** — eval sets, methods, LLM-as-judge bias, the trace sink.
6. **`06-production-serving/`** — caching, cost, prompt injection, rate limiting, retry/circuit breaker.
7. **`07-system-design-templates/`** — interview reframes: search ranking, tech-support chatbot.
8. **`08-machine-learning/`** — classical ML as new ground.
9. **`09-ml-system-design-templates/`** — interview reframes: recommender, anomaly detection, object detection.

Root files:

- **`ai-features-in-this-codebase.md`** — every AI feature buffr actually ships, with inputs/outputs/model/cost/failure-modes.
- **`ml-features-in-this-codebase.md`** — the honest "buffr trains nothing" page.

## How to read each concept file

Every file follows the same shape (from `format.md`): **Subtitle → Zoom out → Structure pass → How it works (pattern + your code at `file:line`) → Primary diagram → Elaborate → Project exercises → Interview defense → See also.** Diagrams lead; prose fills in; real code appears with line-by-line annotation at the load-bearing parts.

## Where buffr's code lives (quick map)

```
src/pg-vector-store.ts     PgVectorStore — upsert/search over pgvector, 768 assert
src/runtime.ts             indexDocumentRow — documents row + chunk indexing
src/session.ts             createChatSession — the warm session, agent, memory
src/profile.ts             loadProfile — me.md into the system prompt
src/supabase-trace-sink.ts SupabaseTraceSink — full-trajectory capture
src/cli/index-cmd.ts       npm run index — chunk → embed → store
src/cli/eval-cmd.ts        npm run eval — precision@k / recall@k
src/cli/chat.tsx           the Ink chat TUI
sql/001_agents_schema.sql  documents/chunks/conversations/messages/profiles
eval/queries.json          the labeled eval set
```

aptkit (`@rlynjb/aptkit-core`, consumed never edited) supplies the agent loop, retrieval pipeline, the `search_knowledge_base` tool, `createConversationMemory`, the precision/recall scorers, and the (unwired) `RubricJudge`.

## Cross-links

- `study-prompt-engineering/` · `study-agent-architecture/` · `study-database-systems/` · `study-dsa-foundations/` · `study-testing/`
