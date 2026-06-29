# Study — AI Engineering: buffr-laptop

A per-codebase AI-engineering + ML study guide for `buffr-laptop`, generated against the aipe v1.69.1 `study-ai-engineering` spec. Written in the teacher voice (`teacher.md`), calibrated to the reader (`me.md`): diagram-first, pattern as the primary anchor, concept → mechanism → code at real `file:line`.

**Shape:** LLM application engineering (loopd-shaped). buffr is a local-first RAG agent — Ollama `gemma2:9b` generation + `nomic-embed-text:v1.5` embeddings, Postgres + pgvector retrieval, a bounded tool-calling agent loop. It trains no model, so the classical-ML sections are study-only.

## Start here

- **`00-overview.md`** — the whole system in one diagram, the one seam to understand first, reading order.
- **`ai-features-in-this-codebase.md`** — the AI-feature ledger (every feature, its pattern, its tokens).
- **`ml-features-in-this-codebase.md`** — honest: no trained model in this repo.

## Sections

| Dir | Topic | Weight in buffr |
|-----|-------|-----------------|
| `01-llm-foundations/` | what an LLM is, tokenization, sampling, structured output, streaming, token economics, heuristic-before-LLM, provider abstraction, user-override locks | **core** (Ollama, 768-dim) |
| `02-context-and-prompts/` | context window, lost-in-the-middle, prompt chaining | **core** (guard + profile) |
| `03-retrieval-and-rag/` | embeddings, model choice, chunking, vector DBs, dense/sparse, hybrid+RRF, reranking, query rewriting, stale embeddings, incremental indexing, RAG, GraphRAG | **the heart of buffr** |
| `04-agents-and-tool-use/` | agents vs chains, tool calling, ReAct, routing, agent memory, error recovery | **core** (the loop) |
| `05-evals-and-observability/` | eval set types, methods, judge bias, observability | **core** (P@k wired, faithfulness not) |
| `06-production-serving/` | caching, cost, prompt injection, rate limiting, retry/circuit-breaker | mostly *not yet exercised* |
| `07-system-design-templates/` | search ranking, tech-support chatbot (interview reframes) | every guide |
| `08-machine-learning/` | supervised pipeline, features, splits, imbalance, calibration, recommenders, on-device, quantization, drift, retraining | *study-only* (no model trained) |
| `09-ml-system-design-templates/` | recommender, anomaly detection, object detection (interview reframes) | every guide |

## The patterns buffr actually exercises (the load-bearing files)

- `03-retrieval-and-rag/11-rag.md` + `01-embeddings.md` + `10-incremental-indexing.md` — the index path and query path.
- `04-agents-and-tool-use/02-tool-calling.md` + `gemma` emulation in `01-llm-foundations/08-provider-abstraction.md` — the reliability seam.
- `04-agents-and-tool-use/01-agents-vs-chains.md` — the bounded loop (maxTurns=6, maxToolCalls=4, forced synthesis).
- `04-agents-and-tool-use/05-agent-memory.md` — retrieval-based **episodic** memory (`@aptkit/memory`).
- `05-evals-and-observability/02-eval-methods.md` + `04-llm-observability.md` — precision@k/recall@k and the full-signal trajectory trace.
- `01-llm-foundations/06-token-economics.md` — `model_usage` token persistence (partial cost observability).

## Cross-links to sibling guides

These concepts live where they belong; this guide points at them rather than restating:

- **Prompt engineering** (`.aipe/study-prompt-engineering/`) — the system-prompt anatomy, the profile-as-context prompt, structured-output contracts, injection defenses.
- **Agent architecture** (`.aipe/study-agent-architecture/`) — the ReAct reasoning pattern, agentic retrieval, the single-agent vs multi-agent boundary.
- **Database systems** (`.aipe/study-database-systems/`) — pgvector storage, the HNSW index, cosine distance, the dropped FK on `chunks.document_id`.
- **DSA foundations** (`.aipe/study-dsa-foundations/`) — vectors, cosine similarity, ANN vs exact k-NN, the heap behind top-k.
- **Testing** (`.aipe/study-testing/`) — the eval seam, `node:test`, DB-gated tests, the RubricJudge as the missing faithfulness test.

## Honest gaps (the "not yet exercised" list)

Fine-tuning · reranking · hybrid/sparse/keyword search · streaming · caching · chunking-strategy tuning · faithfulness eval · tool-arg-schema validation · rate limiting / backpressure / circuit breakers. Each is covered as study material with a concrete "how to make it apply" in this repo.
