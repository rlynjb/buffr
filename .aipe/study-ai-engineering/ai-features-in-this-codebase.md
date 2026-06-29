# How buffr-laptop uses AI

buffr is an LLM application end to end — there is exactly one user-facing AI feature (ask a question, get a grounded answer), but it's built from a stack of AI-engineering patterns worth naming individually. Everything runs on Ollama on your own laptop: `gemma2:9b` generates, `nomic-embed-text:v1.5` embeds at 768 dimensions. No cloud model is called.

## AI features

```
  the AI features in buffr-laptop

  ┌──────────────────────┬──────────────────┬─────────────────────────┐
  │ Feature              │ Pattern used     │ Why this pattern        │
  ├──────────────────────┼──────────────────┼─────────────────────────┤
  │ Answer a question    │ RAG + bounded    │ private corpus the model│
  │ (the chat loop)      │ agent loop       │ never trained on        │
  ├──────────────────────┼──────────────────┼─────────────────────────┤
  │ Retrieve passages    │ dense retrieval  │ semantic match over     │
  │                      │ (embed→ANN→rank) │ paraphrased questions   │
  ├──────────────────────┼──────────────────┼─────────────────────────┤
  │ Call the search tool │ Gemma tool-call  │ Gemma has no native     │
  │                      │ emulation        │ tool API → prompt+parse │
  ├──────────────────────┼──────────────────┼─────────────────────────┤
  │ Remember past turns  │ retrieval-based  │ recall by relevance     │
  │                      │ episodic memory  │ across sessions         │
  ├──────────────────────┼──────────────────┼─────────────────────────┤
  │ Personalize answers  │ profile-as-      │ inject me.md into the   │
  │                      │ context          │ system prompt           │
  ├──────────────────────┼──────────────────┼─────────────────────────┤
  │ Score retrieval      │ precision@k /    │ offline eval gate on    │
  │ quality (offline)    │ recall@k         │ a labeled query set     │
  └──────────────────────┴──────────────────┴─────────────────────────┘
```

## Per-feature spec

### Answer a question (the chat loop)

- **Inputs:** `question: string` (free text from the Ink TUI).
- **Outputs:** `answer: string` (grounded natural-language answer; citations are in the tool results captured in `messages`, not yet rendered to the user).
- **Model + provider:** `gemma2:9b` via `GemmaModelProvider` (Ollama, `http://localhost:11434`), wrapped in `ContextWindowGuardedProvider` at `maxTokens: 8192` — `src/session.ts:46`.
- **Approximate token cost per call:** $0 in dollars (local). The ledger that matters is latency and the 8192-token input budget. The trace sink persists per-call `inputTokens + outputTokens` into `agents.messages.tokens_used` from each `model_usage` event — `src/supabase-trace-sink.ts:73-78`. A single answer spends up to 6 model turns (each an input pass over system prompt + profile + retrieved chunks).
- **Failure modes observed:** the dominant one is the tool-arg miss (model emits the wrong key → empty search → ungrounded or refused answer). Secondary: context-window-guard trip when the profile + retrieved chunks exceed 8192 estimated tokens (throws `ContextWindowExceededError`, surfaced as a `warning` trace event). Faithfulness (hallucination over good chunks) is **unmeasured** — see below.
- **Eval set:** `eval/queries.json` (3 labeled query→relevant-doc pairs). Scores retrieval, not answer faithfulness — `src/cli/eval-cmd.ts`.

### Retrieve passages (dense retrieval)

- **Inputs:** `query: string`, `k` (default floor `minTopK: 4`, set at `src/session.ts:43`).
- **Outputs:** ranked `Hit[]` — `{ id, score, meta:{ docId, chunkIndex, text } }`, cosine similarity score = `1 - distance` (`src/pg-vector-store.ts:67-85`).
- **Model + provider:** `nomic-embed-text:v1.5` via `OllamaEmbeddingProvider`, 768-dim.
- **Storage:** `agents.chunks`, `embedding vector(768)`, HNSW `vector_cosine_ops` index, scoped by `app_id` (`src/pg-vector-store.ts:67-78`).
- **Failure modes observed:** dense-only retrieval misses exact-term/identifier queries (no BM25/sparse fallback). Empty-query search when the tool arg is wrong (see RAG seam). Stale embeddings if a document's text changes without re-index (no `embedding_stale_at` tracking).

### Call the search tool (Gemma tool-call emulation)

- **Inputs:** the model's free text, expected to contain `{"tool":"search_knowledge_base","arguments":{"query":"..."}}`.
- **Outputs:** parsed `{ name, input }` or `null` — `parseToolCall()` in aptkit's gemma provider (`packages/providers/gemma/src/gemma-provider.ts:168-182`).
- **Model + provider:** `gemma2:9b`. The tool schema is rendered into the system prompt (`buildSystemText()`, gemma-provider.ts:133-165); the JSON is parsed back with `parseAgentJson` (bounded-substring scan).
- **Approximate token cost:** the rendered tool schema is fixed overhead on every turn until the forced-synthesis turn drops it.
- **Failure modes observed:** **no argument-schema validation.** A wrong arg key passes straight through `InMemoryToolRegistry.callTool` to the handler, which coerces a missing `query` to `''`. This is the reliability ceiling — see `04-agents-and-tool-use/02-tool-calling.md`.

### Remember past turns (retrieval-based episodic memory)

- **Inputs:** `{ conversationId, question, answer }` after each successful turn — `src/session.ts:65`.
- **Outputs:** none directly; the exchange is embedded and upserted into the **same** `chunks` store, tagged `meta.kind='memory'`, id `memory:<conv>:<n>` (aptkit `createConversationMemory`, `packages/memory/src/conversation-memory.ts:74-87`).
- **Recall:** relevant past exchanges resurface through the *same* `search_knowledge_base` tool next turn — it's RAG over conversation history, not a separate recall call. The dropped FK on `chunks.document_id` is what lets memory rows exist with no parent document.
- **Failure modes observed:** memory-write is best-effort (`try/catch` swallow at `src/session.ts:66-69`) — a write failure never loses the user's answer. No sequential in-prompt turn history yet (`RagQueryAgent.answer()` treats each question independently — `src/session.ts:25-27`).

### Personalize answers (profile-as-context)

- **Inputs:** the `me.md`-style profile row from `agents.profiles` — `src/profile.ts`.
- **Outputs:** injected at the **start** of the system prompt under heading "About the person you are assisting" (`RagQueryAgent` constructor, `packages/agents/rag-query/src/rag-query-agent.ts:52-59`).
- **Failure modes observed:** empty profile (`loadProfile` returns `''`) → no personalization, no error. Profile counts against the 8192-token budget.

### Score retrieval quality (offline eval)

- **Inputs:** `eval/queries.json` — `{ query, relevant: string[] }[]`.
- **Outputs:** mean P@1 and mean R@3 over the set — `src/cli/eval-cmd.ts`.
- **Model + provider:** embeddings only (no generation in the eval path).
- **Failure modes observed:** measures retrieval, **not faithfulness**. A hallucinated answer over perfect chunks scores nothing here because answers are never scored. The `RubricJudge` that could score faithfulness ships in aptkit but is wired into nothing — see `05-evals-and-observability/02-eval-methods.md`.

## The honest summary

buffr exercises the full LLM-application stack: RAG, a bounded agent loop, tool-calling (emulated), episodic memory, profile context, and offline retrieval evals with token observability. What it does not yet exercise: streaming, caching, faithfulness eval, hybrid retrieval, reranking, prompt-injection defenses, and fine-tuning on its own captured trajectories. Each is a named "how to make it apply" in the relevant section.
