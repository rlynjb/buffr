# AI features in buffr

> Updated: 2026-06-24 — `ask` → `chat` (`session.ts`/`chat.tsx`); added Conversation memory (retrieval-based episodic memory) feature; `tokens_used` now populated; trace captures all 6 events.

> What this codebase actually does with AI, per the spec's per-codebase feature table. Every feature is grounded in real files. buffr is an LLM-application-engineering shape — retrieval over a personal corpus + a bounded agent loop + retrieval-based episodic memory + offline retrieval evals.

## AI features table

```
  ┌──────────────────────┬────────────────────────┬──────────────────────────┐
  │ Feature              │ Pattern used           │ Why this pattern         │
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Corpus indexing      │ chunk → embed → upsert  │ make docs searchable as  │
  │ (index)              │ (RAG index path, 01)    │ 768-dim vectors          │
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Grounded Q&A (chat)  │ agent loop + emulated   │ model decides when to    │
  │                      │ tool call (03, 04)      │ search; answers cite KB  │
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Retrieval (inside    │ embed → ANN cosine →    │ semantic match without   │
  │ chat + eval)         │ rank (RAG query, 02)    │ keyword overlap          │
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Personalization      │ profile injection (07)  │ "my stack" resolves; KB  │
  │                      │                         │ is the author's own      │
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Conversation memory  │ retrieval-based         │ recall relevant past     │
  │ (chat, cross-session)│ episodic memory (08) —  │ exchanges by similarity; │
  │                      │ RAG over chat history   │ shared store, kind=memory│
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Retrieval eval       │ precision@k/recall@k    │ measure retrieval before │
  │ (eval)               │ (06)                    │ optimizing it            │
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Trajectory capture   │ trace sink → DB, all 6  │ persist every event for  │
  │ (chat)               │ events (conv./messages) │ replay; fills tokens_used│
  └──────────────────────┴────────────────────────┴──────────────────────────┘
```

## Per-feature spec

### Corpus indexing (`index`)

- **Inputs:** one or more markdown file paths (`src/cli/index-cmd.ts:14`).
- **Outputs:** one `agents.documents` row + N `agents.chunks` rows per file, each chunk a 768-dim vector.
- **Model and provider:** `nomic-embed-text:v1.5` via Ollama (`OllamaEmbeddingProvider`).
- **Token/cost:** local Ollama — no dollar cost; cost is laptop compute. Not measured.
- **Failure modes observed:** orphaned chunks on re-index of a shrunk document (upsert never deletes, `01-rag-index-path.md`); two-write non-atomicity between `documents` and `chunks` (`src/runtime.ts:11`).
- **Eval set:** none for indexing directly; retrieval eval (`eval/queries.json`) exercises the result.

### Grounded Q&A (`chat`)

- **Inputs:** a natural-language question typed into the Ink REPL (`src/cli/chat.tsx`), passed to `session.ask()` (`src/session.ts:60`). Unlike the retired one-shot `ask` CLI, a single warm conversation is held across every turn.
- **Outputs:** a text answer citing retrieved sources, persisted conversation turns, *and* a remembered exchange embedded into the memory store.
- **Model and provider:** `gemma2:9b` via Ollama, wrapped in `ContextWindowGuardedProvider(maxTokens: 8192)` (`src/session.ts:46`).
- **Token/cost:** `prompt_eval_count`/`eval_count` flow back from Ollama and are now *persisted* — the trace sink handles `model_usage` and writes summed tokens into `agents.messages.tokens_used` (`src/supabase-trace-sink.ts:73`). Captured but not yet acted on (no budget, no cost rollup).
- **Failure modes observed:** emulated tool-call JSON failures (Gemma has no native tools, `04-gemma-tool-call-emulation.md`); the `{`-heuristic for retry; no argument-schema validation so a wrong-key tool call searches empty string; no repeated-tool-call loop detection. Memory writes are best-effort: a `memory.remember` failure is swallowed so the answer the user already has isn't lost (`src/session.ts:65-69`).
- **Eval set:** retrieval is scored by `eval`; **faithfulness is unscored** — the answer's groundedness is not measured (`06-evals-precision-and-recall.md`).

### Retrieval

- **Inputs:** a query string (from the agent's tool call, from memory `recall`, or from `eval`).
- **Outputs:** ranked `Hit[]` with cosine-similarity scores and citation metadata — documents and `kind=memory` exchanges share the same ranked space.
- **Model and provider:** `nomic-embed-text` (query side) + pgvector HNSW cosine `<=>` (`src/pg-vector-store.ts:67`).
- **Token/cost:** one embed call per query; local.
- **Failure modes observed:** dense-only — no sparse fallback for exact identifiers, no rerank, no hybrid (`02-rag-query-path.md`).
- **Eval set:** `eval/queries.json` (3-item golden set), scored precision@1 / recall@3.

### Personalization (profile injection)

- **Inputs:** the most-recent `agents.profiles` row for the app (`src/profile.ts:6`).
- **Outputs:** the profile text prepended to the system prompt under a heading.
- **Model and provider:** consumed by Gemma as system-prompt context.
- **Token/cost:** profile text counts against the 8192-token window; length is untuned.
- **Failure modes observed:** no length budget — a large profile crowds out retrieved chunks (`07-profile-as-context.md`).
- **Eval set:** none — and notably the `eval` path skips the agent, so it never exercises the profile.

### Conversation memory (retrieval-based episodic memory)

- **Inputs:** the `{ conversationId, question, answer }` of each completed chat turn (`src/session.ts:66`).
- **Outputs:** one memory vector per exchange, upserted into the same `agents.chunks` store, tagged `kind=memory` with the formatted exchange text in `meta`. Recallable on later turns (including future sessions) via the same `search_knowledge_base` tool.
- **Model and provider:** `OllamaEmbeddingProvider` (`nomic-embed-text`, the same 768-dim embedder as documents) + `PgVectorStore`, wired into `createConversationMemory({ embedder, store })` (`src/session.ts:53`). The engine is aptkit's published `@aptkit/memory` (bundled in aptkit-core 0.4.1), extracted *up* from buffr; buffr injects only the store.
- **Token/cost:** one embed call per remembered turn; local. Recall over-fetches (`max(k*4, 20)`) then filters to `kind=memory` because the `VectorStore` contract has no metadata filter.
- **Failure modes observed:** best-effort write — `remember` is wrapped in try/catch so a failure never costs the user their answer (`src/session.ts:65-69`). Sharing the store with documents means memory mixes into the same ranked results (intended), and slightly widens the prompt-injection surface (a remembered exchange can later be recalled into context). Counters are per-process, so ids namespace by `kind:conversationId:n`.
- **Eval set:** none — recall quality is unmeasured; the retrieval `eval` scores documents only.

### Retrieval eval (`eval`)

- **Inputs:** `eval/queries.json` (query → relevant docIds).
- **Outputs:** per-query and mean precision@1 / recall@3 (`src/cli/eval-cmd.ts:31-33`).
- **Model and provider:** `nomic-embed-text` for retrieval; **no judge model** (the library's `RubricJudge` is not wired).
- **Token/cost:** embed per query; local.
- **Failure modes observed:** golden-set-only (no adversarial, no regression); 3 items too few to trust a percentage; faithfulness entirely unmeasured.
- **Eval set:** is itself the eval; size 3, at `eval/queries.json`.

### Trajectory capture

- **Inputs:** all six `CapabilityEvent` variants emitted by the agent loop (`src/supabase-trace-sink.ts:53`).
- **Outputs:** `agents.conversations` + `agents.messages` rows for `step`, `tool_call_start` (args), `tool_call_end` (result + durationMs + error), `model_usage` (tokens), and `warning`/`error` — ordered by the event's own timestamp written into `created_at`.
- **Model and provider:** n/a (persistence layer).
- **Token/cost:** DB writes, queued and flushed after the run; `tokens_used` now filled from `model_usage` (`:73`).
- **Failure modes observed:** this is the *observability* trajectory, distinct from the recallable memory vectors (`08-conversation-memory.md`) — it is not retrieved back into prompts (by design; that's memory's job). Now captures the full signal that previously got dropped; missing only per-step model latency and any replay tooling on top.
- **Eval set:** none.

## What's not here (honest gaps)

No fine-tuning (the ceiling — both models stock; the now-full-signal trajectories are the FT corpus), no reranking, no hybrid/sparse search, no streaming, no caching, no chunking-strategy tuning, no faithfulness/LLM-as-judge eval (still the live evals gap), no token/cost *action* (tokens are now logged but unread), no memory *management* (summarization/decay — out of scope in `@aptkit/memory`), no prompt-injection defense, no rate limiting/circuit breaker. Each is named with file-level grounding in `audit.md`. None is a defect at single-device personal scale; all are the visible next moves.
