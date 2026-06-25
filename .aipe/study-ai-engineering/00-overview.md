# buffr — AI Engineering Study Guide

> Updated: 2026-06-24 — `ask-cmd.ts` retired for the interactive `chat`/`session.ts` surface; added retrieval-based episodic memory (file 08) to the seams list and diagram; trace now captures all 6 events incl. tokens.

> One-page orientation. Read this first, then `audit.md`, then the pattern files in order.

## The whole system in one diagram

buffr is the laptop "brain" of a self-hosted personal RAG agent. It consumes `@rlynjb/aptkit-core` (0.4.1) as a library and adds the Postgres persistence layer, an interactive chat surface, plus the index/eval CLIs. Everything runs locally — Ollama serves both models, Postgres+pgvector stores the corpus *and* the conversation memory, no cloud in the hot path.

```
  buffr — index → (chat: retrieve → generate → remember) → eval, all local

  ┌─ CLI / surface layer (buffr's entrypoints) ────────────────────┐
  │  index-cmd.ts      chat.tsx → session.ts     eval-cmd.ts       │
  │  (build corpus)    (Ink REPL, one warm       (score           │
  │                     conversation, remembers)  precision@k)     │
  └────────┬───────────────┬────────────────────┬─────────────────┘
           │               │                     │
  ┌─ Library layer (@rlynjb/aptkit-core 0.4.1 — consumed, never edited) ─┐
  │  RetrievalPipeline   RagQueryAgent         scorePrecisionAtK   │
  │  createSearchKB...   runAgentLoop          scoreRecallAtK      │
  │  OllamaEmbedding     GemmaModelProvider    createConversation- │
  │                      ContextWindowGuarded   Memory (@aptkit/    │
  │                      (RubricJudge — unused)  memory, episodic)  │
  └────────┬───────────────┬────────────────────┬─────────────────┘
           │               │                     │
  ┌─ Provider layer (Ollama, localhost:11434) ────────────────────┐
  │  nomic-embed-text (768-dim embeddings)   gemma2:9b (generation)│
  └────────┬───────────────────────────────────────────────────────┘
           │
  ┌─ Storage layer (Postgres "reindb", schema "agents") ──────────┐
  │  documents   chunks(embedding vector(768), HNSW cosine)        │
  │     ▲ memory exchanges live HERE too, tagged kind=memory       │
  │  conversations   messages(tokens_used filled)   profiles       │
  └────────────────────────────────────────────────────────────────┘
```

## Which shape is this codebase?

The AI-engineering spec names three shapes of AI work. buffr is squarely **LLM application engineering** — single-purpose retrieval over a personal corpus, a bounded agent loop with one tool, retrieval-based episodic memory over chat history, and offline retrieval evals. It is not classical ML (no trained model, no feature engineering, no labeled-data pipeline). So SECTION 04 (Machine Learning) and the ML system-design templates are covered honestly as **not exercised** — they're future ground, not refreshers, and the guide does not invent ML features buffr doesn't have.

The one wrinkle that makes buffr richer than a stock RAG demo: the generation model is **stock Gemma2:9b, which has no native tool-calling**. aptkit emulates tool calls by rendering tool schemas into the system prompt and parsing a JSON object back out. That emulation is the single highest-risk seam in the whole system, and it gets its own pattern file.

## The eight seams worth studying

The guide is two passes. `audit.md` walks every lens in the spec and says, per lens, what buffr does (with `file:line`) or `not yet exercised`. Then the pattern files go deep on the eight things that are actually load-bearing here:

```
  Pass 1: audit.md            — every lens, honestly, with file:line
  Pass 2: pattern files       — the eight load-bearing patterns:

   01-rag-index-path                chunk → embed → pgvector upsert
   02-rag-query-path                embed → ANN cosine → rank → ground
   03-agent-loop-with-tool-calling  bounded turns, forced synthesis
   04-gemma-tool-call-emulation     stock Gemma has no native tools
   05-embedding-model-choice        nomic 768-dim as a one-way door
   06-evals-precision-and-recall    offline retrieval scoring (no judge yet)
   07-profile-as-context            me.md injected into the system prompt
   08-conversation-memory           RAG over chat history — episodic recall
```

## Reading order

1. `audit.md` — the lens sweep. Where everything is, and what's missing.
2. `01-rag-index-path` → `02-rag-query-path` — the retrieval spine, in order.
3. `05-embedding-model-choice` — the one-way door that constrains both paths.
4. `03-agent-loop-with-tool-calling` → `04-gemma-tool-call-emulation` — the generation half, outer loop then the risky inner seam.
5. `07-profile-as-context` — how `me.md` gets into the prompt.
6. `08-conversation-memory` — how past exchanges get recalled via the same search tool (RAG over chat history).
7. `06-evals-precision-and-recall` — how you know retrieval works, and what's not measured.

## Cross-links to sibling guides

- **Database mechanics** behind pgvector — HNSW, cosine ops, the `<=>` operator — live in `.aipe/study-database-systems/`.
- **The ANN-vs-exact-search tradeoff** and graph-traversal cost models live in `.aipe/study-dsa-foundations/`.
- **The system-architecture view** of the same code (adapter boundary, CLI entrypoints, trajectory capture) lives in `.aipe/study-system-design/`.
- **The eval seam as a testing concern** (fake embedder injection, env-gated DB tests) lives in `.aipe/study-testing/`.
- **Prompt-level concerns** (the system template wording, synthesis instruction) are an AI-engineering topic here; the prompt-engineering generator, if run, lands in `.aipe/study-prompt-engineering/`.
