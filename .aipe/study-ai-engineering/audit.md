# AI Engineering Audit — buffr

> Updated: 2026-06-24 — reconciled to the `chat`/`session.ts` surface (purged `ask`/`ask-cmd.ts`); promoted Agent memory to retrieval-based episodic memory via `@aptkit/memory`; updated Token economics + LLM observability for the now-persisted `model_usage`/`tokens_used` and full 6-event trace; faithfulness gap kept; fine-tuning ceiling kept (now full-signal FT corpus).

> Pass 1 of the two-pass audit. One section per lens from the AI-engineering spec. Each lens names what buffr actually does, grounded in `file:line`, or says `not yet exercised` honestly. Significant findings cross-link to a pattern file rather than restating it.
>
> Scope reminder: buffr *consumes* `@rlynjb/aptkit-core` and is never allowed to edit it. So a lens can be "exercised by the library buffr wires up" (counts — buffr made the wiring decision) or "available in the library but buffr doesn't wire it" (does not count — `not yet exercised`). The distinction matters: the audit grades buffr's *use* of the toolkit, not the toolkit.

---

## LLM foundations

### What an LLM is / the IO model

Exercised. The generation model is stock `gemma2:9b` served by Ollama, wired in `src/session.ts:46` via `GemmaModelProvider`. buffr treats it as exactly what it is — a text-in/text-out function — and never asks it to be a database or a reasoner. The knowledge lives in pgvector; the model only synthesizes over retrieved chunks.

### Tokenization

`not yet exercised` directly. buffr never counts tokens itself. The only token-shaped boundary is `ContextWindowGuardedProvider(..., { maxTokens: 8192 })` at `src/session.ts:46`, which caps the window the model sees. Usage counts (`prompt_eval_count`/`eval_count`) flow back from Ollama through the Gemma provider — and they are now *persisted*: the trace sink handles the `model_usage` event and writes the summed input+output tokens into `agents.messages.tokens_used` (`src/supabase-trace-sink.ts:73`). So tokens are captured per turn even though buffr still doesn't *act* on them (no budget, no cost ledger). See Token economics below.

### Sampling parameters

`not yet exercised` in buffr. No temperature/top-p/top-k is set at any buffr call site — `src/session.ts:46` constructs the provider with host only. The library's `RubricJudge` accepts a `temperature`, but buffr doesn't consume the judge. Generation runs at Ollama's default sampling.

### Structured outputs

Exercised, but indirectly and as the *risk*, not a clean win. buffr's agent depends on Gemma returning a single well-formed JSON tool-call object. There is no Zod/JSON-schema validation on buffr's side; the contract is enforced in the library by `parseToolCall` + a one-shot retry nudge in the Gemma provider. → see `04-gemma-tool-call-emulation.md`.

### Streaming

`not yet exercised`. `src/session.ts:62` calls `agent.answer(question)` and awaits the full string before the Ink chat surface renders it. The Gemma transport explicitly sets `stream: false` (`gemma-provider.js`). No token-by-token output to the user — the chat UI shows a "thinking…" spinner (`src/cli/chat.tsx`) until the whole answer arrives. This is a deliberate fit for the batch tool, but it means perceived latency is full-response latency.

### Token economics

Partially exercised now — capture without action. The `model_usage` event is no longer dropped: `SupabaseTraceSink.emit` handles it and writes `(inputTokens ?? 0) + (outputTokens ?? 0)` into `agents.messages.tokens_used` (`src/supabase-trace-sink.ts:73`), the column that used to sit orphaned (`sql/001_agents_schema.sql:48`). So per-turn token counts are now logged. What's *still* missing: nothing reads them — no cost ledger, no budget guard, no per-request cost rollup. The capture half is done; the optimization half isn't.

### Heuristic-before-LLM

`not yet exercised`. Every `chat` turn goes straight to the agent loop (`src/session.ts:62`). There is no cheap deterministic path that short-circuits before paying for a Gemma call. Acceptable at single-device personal scale; named here because it's the cheapest future win if `chat` ever runs hot.

### Provider abstraction

Exercised. buffr codes against the library's `ModelProvider` / `EmbeddingProvider` / `VectorStore` interfaces, not concrete vendors. `PgVectorStore implements VectorStore` (`src/pg-vector-store.ts:19`) is the clearest case — buffr swapped the library's in-memory store for Postgres without touching the pipeline. The deeper architectural treatment is in `.aipe/study-system-design/01-vector-store-adapter.md`.

### User-override locks

`not yet exercised`, and not applicable in the loopd sense. buffr doesn't re-classify user-editable fields, so there's no override-clobbering risk. The nearest analog is the `profiles` table being read-most-recent (`src/profile.ts:6`) — last write wins, no lock needed because nothing automated overwrites it.

---

## Context and prompts

### Context window

Exercised. `ContextWindowGuardedProvider` wraps Gemma with `maxTokens: 8192` at `src/session.ts:46` — a hard cap so the system prompt + profile + retrieved chunks + question can't overflow what Gemma can hold. The competing-for-space picture is real here: the injected `me.md` profile and the tool-result JSON both eat into that 8192.

### Lost-in-the-middle

`not yet exercised` as an explicit mitigation. The agent retrieves a small top-k (min 4, see `src/session.ts:43`) rather than stuffing 20 docs, which sidesteps the worst of the problem — but there's no reranking to put the most-relevant chunk at an edge. Small-k-by-default is the implicit mitigation.

### Prompt chaining

`not yet exercised`. There is no multi-call summarize→synthesize chain. The agent loop is a single capability with one tool, not a pipeline of distinct LLM jobs. The forced-final synthesis turn (`04`/`03`) is one model call, not a chain.

---

## Retrieval and RAG

### Embeddings

Exercised — the spine of the system. `nomic-embed-text` produces 768-dim vectors via `OllamaEmbeddingProvider` (`src/cli/index-cmd.ts:18`, `src/session.ts:40`, `eval-cmd.ts:14`). The same embedder is now also injected into the conversation-memory engine (`src/session.ts:53`), so chat exchanges land in the same 768-dim space as documents. → see `01-rag-index-path.md`, `05-embedding-model-choice.md`, and `08-conversation-memory.md`.

### Embedding model choice

Exercised — and treated correctly as a one-way door. The dimension `768` is asserted at three layers (provider, pipeline wiring, store, SQL column) and a mismatch throws rather than truncating. → see `05-embedding-model-choice.md`.

### Chunking strategies

Exercised via the library's chunker, with buffr accepting the default. `chunkText` is fixed-size-by-character (`CHUNK_SIZE = 512`, `CHUNK_OVERLAP = 64`) in the library. buffr does not tune it — `indexDocumentRow` (`src/runtime.ts:17`) hands the whole document text to `pipeline.index()` and lets the library chunk. Chunking-strategy tuning (semantic/structural splitting) is `not yet exercised`. → see `01-rag-index-path.md`.

### Vector databases

Exercised — this is buffr's reason to exist. pgvector in Postgres, HNSW `vector_cosine_ops` index (`sql/001_agents_schema.sql:28`), the `PgVectorStore` adapter (`src/pg-vector-store.ts`). The storage-engine mechanics are in `.aipe/study-database-systems/`. → see `02-rag-query-path.md`.

### Dense vs sparse retrieval

Dense only. `not yet exercised` on the sparse side — no BM25, no tsvector/full-text, no keyword index. `PgVectorStore.search` (`src/pg-vector-store.ts:67`) is pure cosine ANN. A query for an exact identifier that the embedding space doesn't separate well has no sparse fallback.

### Hybrid retrieval with RRF

`not yet exercised`. Follows from dense-only — there's nothing to fuse.

### Reranking with a cross-encoder

`not yet exercised`. The top-k from `<=>` is the final ranking; no second-stage cross-encoder rerank. The library's tool over-fetches only when a metadata filter is present (`search-knowledge-base-tool.js`), and that's a filter, not a rerank.

### Query rewriting / HyDE

`not yet exercised`. The user's question is embedded verbatim as the query (`eval-cmd.ts:25`, and inside the agent the model writes its own search query but there's no dedicated rewrite/HyDE step).

### Stale embeddings

`not yet exercised` as tracking. `chunks` has no `embedding_stale_at` column. On document edit, `indexDocumentRow` re-upserts the document row and re-indexes chunks (`src/runtime.ts:11`) — but chunk ids are `<docId>#<index>`, so if an edit produces *fewer* chunks, stale higher-index chunks from the old version are orphaned, not deleted. This is a real correctness gap named in `01-rag-index-path.md`.

### Incremental indexing

Partially exercised. `index-cmd.ts` indexes only the files you pass on the command line (`src/cli/index-cmd.ts:14`), and `upsert ... on conflict (id) do update` (`src/pg-vector-store.ts:50`) makes re-indexing one file idempotent. That's delta-by-invocation. There is no change-detection or full-rebuild orchestration. → see `01-rag-index-path.md`.

### RAG (the full pipeline)

Exercised end to end — index, retrieve, ground, generate. → see `02-rag-query-path.md` and `03-agent-loop-with-tool-calling.md`.

### GraphRAG

`not yet exercised`. No entity/relationship extraction, no graph traversal. Plain dense RAG.

---

## Agents and tool use

### Agents vs chains

Exercised, and it's genuinely an agent, not a chain. `RagQueryAgent.answer` runs `runAgentLoop` with `maxTurns: 6` — the model decides whether to call the search tool and when to stop. → see `03-agent-loop-with-tool-calling.md`.

### Tool calling

Exercised — and the hard part. buffr builds the tool (`createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 })`, `src/session.ts:43`) and registers it in an `InMemoryToolRegistry`. Because Gemma has no native tool API, the call is emulated. → see `04-gemma-tool-call-emulation.md`. Note: because conversation memory shares the same store, this one tool surfaces *both* indexed documents and recalled past exchanges — see `08-conversation-memory.md`.

### ReAct pattern

Partially exercised. The loop is observe-act (call tool → read result → answer), which is the ReAct skeleton, but there's no explicit "Thought:" externalization step. The model's reasoning is implicit. The structural loop (`runAgentLoop`) is the ReAct kernel; the verbalized-reasoning hardening is absent.

### Tool routing

Minimal. One tool, so routing is trivial — the model either calls `search_knowledge_base` or answers directly. No heuristic front / LLM back split. `not yet exercised` as a multi-tool routing problem.

### Agent memory

Exercised — and now in the textbook shape. Two layers, and the long-term layer is real retrieval, not just capture:

- **Short-term (in-context):** the loop's `messages` array holds the in-context trajectory for the duration of one `answer()` call. Disappears when that call returns. (Sequential in-prompt turn history across turns is still *not* threaded — `RagQueryAgent.answer()` treats each question independently; `src/session.ts:25`.)
- **Long-term (retrieval-based episodic memory):** after every chat turn, `memory.remember({ conversationId, question, answer })` embeds the exchange and upserts it into the same pgvector store, tagged `kind=memory` (`src/session.ts:53,66`). On a later turn — even in a *future session* — the same `search_knowledge_base` tool can surface that past exchange by semantic similarity, because memory rows live in the same vector space as documents. This is **RAG over conversation history**: store exchanges, recall the relevant ones by embedding distance.

The engine is aptkit's published `@aptkit/memory` (`createConversationMemory`, bundled in aptkit-core 0.4.1) — extracted *up* from buffr into the toolkit; buffr only injects its `PgVectorStore`. The store-agnostic split is the point: the engine speaks only `EmbeddingProvider`/`VectorStore`, so the same logic runs over an in-memory store in tests and pgvector in production. What's missing is memory *management* (summarization, fact extraction, consolidation, decay) — out of scope by design; this is the storage+retrieval half only. The separately persisted `conversations`/`messages` trace (`src/supabase-trace-sink.ts`) is the *observability* trajectory, a different concern from the recallable memory vectors. → see `08-conversation-memory.md` and `.aipe/study-system-design/03-trajectory-capture.md`.

### Error recovery in agents

Partially exercised, all in the library buffr wires up. Tool errors are caught and fed back to the model as an error tool-result (`runAgentLoop`'s try/catch). The loop has a hard iteration budget (`maxTurns: 6`, `maxToolCalls: 4`) and a forced-final synthesis turn that drops tools. Bad tool-call JSON gets one retry-nudge in the Gemma provider. What's missing: no repeated-tool-call loop detection, no timeout on the tool itself. → see `03-agent-loop-with-tool-calling.md`.

---

## Evals and observability (LLM side)

### Eval set types

Partially exercised — a golden set only. `eval/queries.json` is a 3-item hand-curated query→relevant-doc set (a golden set). No adversarial set (prompt-injection, ambiguous queries), no regression set (frozen production failures). → see `06-evals-precision-and-recall.md`.

### Eval methods

Exercised at the cheap end of the ladder; absent at the expensive end. `eval-cmd.ts` runs exact-id-match retrieval scoring via `scorePrecisionAtK` / `scoreRecallAtK` (`src/cli/eval-cmd.ts:27-28`). No fuzzy match, no rubric, **no LLM-as-judge** even though the library ships a `RubricJudge`. So generation *faithfulness* (does the answer actually follow from the retrieved chunks?) is unmeasured — only retrieval is scored. → see `06-evals-precision-and-recall.md`.

### LLM-as-judge bias

`not yet exercised`, because there's no judge. Named in `06` as the thing to design for *if* a judge is added — and the self-preference fix (judge with a different/stronger model than the one being graded) is directly relevant: a Gemma-graded-by-Gemma setup would be the bias trap to avoid.

### LLM observability

Exercised more fully now. `SupabaseTraceSink.emit` persists **all six** `CapabilityEvent` variants to `agents.messages` — `step`, `tool_call_start` (the cause: tool name + args), `tool_call_end` (result + `durationMs` + error), `model_usage` (token counts), and `warning`/`error` (`src/supabase-trace-sink.ts:56-84`). Previously only `step` and `tool_call_end` survived; the rest were dropped on the floor. Two concrete wins from the wider capture: (1) `tokens_used` is now populated from `model_usage` (`:73`) — the observability surface carries cost signal; (2) the event's own `timestamp` is written into `created_at` (`:30`) so replay order matches emit order rather than the race between concurrent flush inserts. What's still missing: per-step *latency* on model calls (only tool-call `durationMs` is captured) and any actual replay tooling on top of the now-complete trajectory. → see `.aipe/study-system-design/03-trajectory-capture.md`.

---

## Production serving (LLM side)

### LLM caching

`not yet exercised`. No prompt cache, no semantic cache, no exact-match cache. Each `chat` turn re-embeds and re-generates from scratch. Local single-user scale makes this acceptable today.

### LLM cost optimization

`not yet exercised`, and largely moot — local Ollama inference has no per-token dollar cost. The "cheap model first" routing pattern doesn't apply when there's one local model. The real cost here is latency and laptop compute, neither of which is currently measured.

### Prompt injection

`not yet exercised` as a defense. Indexed documents and the user question both flow into the model's context unsanitized. Because the corpus is the user's own personal files (self-hosted, single-user), the trust boundary is benign today — but a document containing "ignore previous instructions" would be fed to Gemma verbatim. The one structural mitigation present: the search tool's `matchesFilter` ignores unknown filter keys (`search-knowledge-base-tool.js`), so a hallucinated filter can't wipe results. Output never triggers side effects — the agent only returns text.

### Rate limiting and backpressure

`not yet exercised`. CLI invocations are serial and human-paced; no queue, no concurrency limit. Not needed at current scale.

### Retry and circuit breaker

Partially exercised, narrowly. The Gemma provider retries *once* on a malformed tool call with a corrective nudge (`maxToolCallAttempts ?? 2`). That's an application-level retry for a specific failure, not a transport-level exponential-backoff retry or a circuit breaker. Ollama HTTP errors throw straight through (`gemma-provider.js` `defaultHttpTransport`). No backoff, no breaker.

---

## System design templates (interview reframes)

Covered as files `07-system-design-templates/01-search-ranking.md` and `02-tech-support-chatbot.md`, with the honest `Applies to this codebase` verdict per the spec (search-ranking: `partially`; tech-support-chatbot: `partially`). These are generic interview reframes; the "how to make it apply" bullets target buffr's real files.

---

## Machine learning (SECTION 04)

`not yet exercised` across the board. buffr trains no model, engineers no features, has no labeled-data pipeline, no train/val/test split, no classifier, no recommender, no on-device trained inference. The embedding and generation models are pre-trained and consumed as-is. The ML section and the ML system-design templates (recommender, anomaly detection, object detection) are covered honestly as future ground in `ml-features-in-this-codebase.md` — the reader has built one ML pipeline (contrl, pose landmarking) but that's a different repo; buffr has none. No ML concept files are generated, per the spec's rule that pure-LLM-app codebases skip ML concept files that don't match their shape.

---

## Summary of `not yet exercised`

The ceiling, named honestly so the gaps are visible:

- **No fine-tuning** — both models are stock. This is the literal ceiling: the system can only be as good as nomic's embeddings and Gemma2:9b's synthesis. The captured trajectories are now *full-signal* (all six events, token counts, tool args/results, ordered by emit time — `src/supabase-trace-sink.ts`), which means `agents.messages` is exactly the corpus you'd fine-tune Gemma on if you ever closed this gap. The data is ready; the training run isn't built.
- **No reranking** — top-k from cosine is final.
- **No hybrid / sparse / keyword search** — dense-only; exact identifiers have no fallback.
- **No streaming** — full-response latency to the user.
- **No caching** — every call recomputes.
- **No chunking-strategy tuning** — library default fixed-size-by-character, untuned.
- **No faithfulness eval / LLM-as-judge** — only retrieval is scored; answer grounding is unmeasured despite a `RubricJudge` sitting in the library. (Unchanged — this is still the live evals gap.)
- **No token/cost *action*** — token counts are now *logged* (`tokens_used` filled from the `model_usage` event, `src/supabase-trace-sink.ts:73`), but nothing reads them: no budget, no cost ledger, no per-request rollup. Capture done; optimization not.
- **No memory management** — retrieval-based episodic memory now exists (`08-conversation-memory.md`), but the *management* half (summarization, fact extraction, consolidation, decay) is out of scope in `@aptkit/memory` and unbuilt here.
- **No prompt-injection defense, no rate limiting, no circuit breaker** — acceptable at single-user local scale, named for honesty. (Note: shared-store memory slightly widens the injection surface — a remembered exchange can later be recalled into context.)
- **No classical ML** — the entire SECTION 04 surface.
