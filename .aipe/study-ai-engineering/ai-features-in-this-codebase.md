# AI features in buffr

> What this codebase actually does with AI, per the spec's per-codebase feature table. Every feature is grounded in real files. buffr is an LLM-application-engineering shape — retrieval over a personal corpus + a bounded agent loop + offline retrieval evals.

## AI features table

```
  ┌──────────────────────┬────────────────────────┬──────────────────────────┐
  │ Feature              │ Pattern used           │ Why this pattern         │
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Corpus indexing      │ chunk → embed → upsert  │ make docs searchable as  │
  │ (index)              │ (RAG index path, 01)    │ 768-dim vectors          │
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Grounded Q&A (ask)   │ agent loop + emulated   │ model decides when to    │
  │                      │ tool call (03, 04)      │ search; answers cite KB  │
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Retrieval (inside    │ embed → ANN cosine →    │ semantic match without   │
  │ ask + eval)          │ rank (RAG query, 02)    │ keyword overlap          │
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Personalization      │ profile injection (07)  │ "my stack" resolves; KB  │
  │                      │                         │ is the author's own      │
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Retrieval eval       │ precision@k/recall@k    │ measure retrieval before │
  │ (eval)               │ (06)                    │ optimizing it            │
  ├──────────────────────┼────────────────────────┼──────────────────────────┤
  │ Trajectory capture   │ trace sink → DB         │ persist every turn for   │
  │                      │ (conversations/messages)│ later inspection         │
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

### Grounded Q&A (`ask`)

- **Inputs:** a natural-language question string (`src/cli/ask-cmd.ts:16`).
- **Outputs:** a text answer citing retrieved sources, plus persisted conversation turns.
- **Model and provider:** `gemma2:9b` via Ollama, wrapped in `ContextWindowGuardedProvider(maxTokens: 8192)` (`src/cli/ask-cmd.ts:26`).
- **Token/cost:** `prompt_eval_count`/`eval_count` flow back from Ollama but are dropped by buffr's trace sink — unmeasured. The `tokens_used` column exists and is unused.
- **Failure modes observed:** emulated tool-call JSON failures (Gemma has no native tools, `04-gemma-tool-call-emulation.md`); the `{`-heuristic for retry; no argument-schema validation so a wrong-key tool call searches empty string; no repeated-tool-call loop detection.
- **Eval set:** retrieval is scored by `eval`; **faithfulness is unscored** — the answer's groundedness is not measured (`06-evals-precision-and-recall.md`).

### Retrieval

- **Inputs:** a query string (from the agent's tool call, or from `eval`).
- **Outputs:** ranked `Hit[]` with cosine-similarity scores and citation metadata.
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

### Retrieval eval (`eval`)

- **Inputs:** `eval/queries.json` (query → relevant docIds).
- **Outputs:** per-query and mean precision@1 / recall@3 (`src/cli/eval-cmd.ts:31-33`).
- **Model and provider:** `nomic-embed-text` for retrieval; **no judge model** (the library's `RubricJudge` is not wired).
- **Token/cost:** embed per query; local.
- **Failure modes observed:** golden-set-only (no adversarial, no regression); 3 items too few to trust a percentage; faithfulness entirely unmeasured.
- **Eval set:** is itself the eval; size 3, at `eval/queries.json`.

### Trajectory capture

- **Inputs:** `CapabilityEvent`s emitted by the agent loop (`src/supabase-trace-sink.ts:27`).
- **Outputs:** `agents.conversations` + `agents.messages` rows for assistant steps and tool calls.
- **Model and provider:** n/a (persistence layer).
- **Token/cost:** DB writes, queued and flushed after the run.
- **Failure modes observed:** write-only — memory is recorded but never *retrieved* back into a later prompt; the `model_usage` event (token counts) is dropped, only `step`/`tool_call_end` are handled.
- **Eval set:** none.

## What's not here (honest gaps)

No fine-tuning (the ceiling — both models stock), no reranking, no hybrid/sparse search, no streaming, no caching, no chunking-strategy tuning, no faithfulness/LLM-as-judge eval, no token/cost logging, no prompt-injection defense, no rate limiting/circuit breaker. Each is named with file-level grounding in `audit.md`. None is a defect at single-device personal scale; all are the visible next moves.
