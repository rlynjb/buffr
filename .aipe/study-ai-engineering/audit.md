# AI Engineering Audit — buffr

> Pass 1 of the two-pass audit. One section per lens from the AI-engineering spec. Each lens names what buffr actually does, grounded in `file:line`, or says `not yet exercised` honestly. Significant findings cross-link to a pattern file rather than restating it.
>
> Scope reminder: buffr *consumes* `@rlynjb/aptkit-core` and is never allowed to edit it. So a lens can be "exercised by the library buffr wires up" (counts — buffr made the wiring decision) or "available in the library but buffr doesn't wire it" (does not count — `not yet exercised`). The distinction matters: the audit grades buffr's *use* of the toolkit, not the toolkit.

---

## LLM foundations

### What an LLM is / the IO model

Exercised. The generation model is stock `gemma2:9b` served by Ollama, wired in `src/cli/ask-cmd.ts:26` via `GemmaModelProvider`. buffr treats it as exactly what it is — a text-in/text-out function — and never asks it to be a database or a reasoner. The knowledge lives in pgvector; the model only synthesizes over retrieved chunks.

### Tokenization

`not yet exercised` directly. buffr never counts tokens itself. The only token-shaped boundary is `ContextWindowGuardedProvider(..., { maxTokens: 8192 })` at `src/cli/ask-cmd.ts:26`, which caps the window the model sees. Usage counts (`prompt_eval_count`/`eval_count`) flow back from Ollama through the Gemma provider but buffr does not log or act on them.

### Sampling parameters

`not yet exercised` in buffr. No temperature/top-p/top-k is set at any buffr call site — `ask-cmd.ts` constructs the provider with host only. The library's `RubricJudge` accepts a `temperature`, but buffr doesn't consume the judge. Generation runs at Ollama's default sampling.

### Structured outputs

Exercised, but indirectly and as the *risk*, not a clean win. buffr's agent depends on Gemma returning a single well-formed JSON tool-call object. There is no Zod/JSON-schema validation on buffr's side; the contract is enforced in the library by `parseToolCall` + a one-shot retry nudge in the Gemma provider. → see `04-gemma-tool-call-emulation.md`.

### Streaming

`not yet exercised`. `ask-cmd.ts:34` calls `agent.answer(question)` and awaits the full string, then writes it once at line 37. The Gemma transport explicitly sets `stream: false` (`gemma-provider.js`). No token-by-token output to the user. This is a deliberate fit for a CLI batch tool, but it means perceived latency is full-response latency.

### Token economics

`not yet exercised`. No cost ledger, no `tokens_used` written. The `agents.messages` table even has a `tokens_used int` column (`sql/001_agents_schema.sql:48`) — the slot exists but `persistMessage` in `src/supabase-trace-sink.ts:14` never populates it. The wiring is one column-fill away.

### Heuristic-before-LLM

`not yet exercised`. Every `ask` invocation goes straight to the agent loop. There is no cheap deterministic path that short-circuits before paying for a Gemma call. Acceptable at single-device personal scale; named here because it's the cheapest future win if `ask` ever runs hot.

### Provider abstraction

Exercised. buffr codes against the library's `ModelProvider` / `EmbeddingProvider` / `VectorStore` interfaces, not concrete vendors. `PgVectorStore implements VectorStore` (`src/pg-vector-store.ts:19`) is the clearest case — buffr swapped the library's in-memory store for Postgres without touching the pipeline. The deeper architectural treatment is in `.aipe/study-system-design/01-vector-store-adapter.md`.

### User-override locks

`not yet exercised`, and not applicable in the loopd sense. buffr doesn't re-classify user-editable fields, so there's no override-clobbering risk. The nearest analog is the `profiles` table being read-most-recent (`src/profile.ts:6`) — last write wins, no lock needed because nothing automated overwrites it.

---

## Context and prompts

### Context window

Exercised. `ContextWindowGuardedProvider` wraps Gemma with `maxTokens: 8192` at `src/cli/ask-cmd.ts:26` — a hard cap so the system prompt + profile + retrieved chunks + question can't overflow what Gemma can hold. The competing-for-space picture is real here: the injected `me.md` profile and the tool-result JSON both eat into that 8192.

### Lost-in-the-middle

`not yet exercised` as an explicit mitigation. The agent retrieves a small top-k (min 4, see `ask-cmd.ts:23`) rather than stuffing 20 docs, which sidesteps the worst of the problem — but there's no reranking to put the most-relevant chunk at an edge. Small-k-by-default is the implicit mitigation.

### Prompt chaining

`not yet exercised`. There is no multi-call summarize→synthesize chain. The agent loop is a single capability with one tool, not a pipeline of distinct LLM jobs. The forced-final synthesis turn (`04`/`03`) is one model call, not a chain.

---

## Retrieval and RAG

### Embeddings

Exercised — the spine of the system. `nomic-embed-text` produces 768-dim vectors via `OllamaEmbeddingProvider` (`src/cli/index-cmd.ts:18`, `ask-cmd.ts:20`, `eval-cmd.ts:14`). → see `01-rag-index-path.md` and `05-embedding-model-choice.md`.

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

Exercised — and the hard part. buffr builds the tool (`createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 })`, `src/cli/ask-cmd.ts:23`) and registers it in an `InMemoryToolRegistry`. Because Gemma has no native tool API, the call is emulated. → see `04-gemma-tool-call-emulation.md`.

### ReAct pattern

Partially exercised. The loop is observe-act (call tool → read result → answer), which is the ReAct skeleton, but there's no explicit "Thought:" externalization step. The model's reasoning is implicit. The structural loop (`runAgentLoop`) is the ReAct kernel; the verbalized-reasoning hardening is absent.

### Tool routing

Minimal. One tool, so routing is trivial — the model either calls `search_knowledge_base` or answers directly. No heuristic front / LLM back split. `not yet exercised` as a multi-tool routing problem.

### Agent memory

Partially exercised. Short-term: the loop's `messages` array holds the in-context trajectory for the duration of one `answer()` call. Long-term: `conversations`/`messages` tables persist every turn (`src/supabase-trace-sink.ts`) — but persistence is write-only capture; no prior conversation is *retrieved* back into a later prompt. Memory is recorded, not yet recalled. → see `.aipe/study-system-design/03-trajectory-capture.md`.

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

Partially exercised. Traces: `SupabaseTraceSink` persists assistant steps and tool-call-end events to `agents.messages` (`src/supabase-trace-sink.ts:27`). That's per-turn capture. What's missing: latency per step, token/cost per request (the `model_usage` event the loop emits is dropped by buffr's sink — it only handles `step` and `tool_call_end`), and any replay capability. → see `.aipe/study-system-design/03-trajectory-capture.md`.

---

## Production serving (LLM side)

### LLM caching

`not yet exercised`. No prompt cache, no semantic cache, no exact-match cache. Each `ask` re-embeds and re-generates from scratch. Local single-user scale makes this acceptable today.

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

- **No fine-tuning** — both models are stock. This is the literal ceiling: the system can only be as good as nomic's embeddings and Gemma2:9b's synthesis.
- **No reranking** — top-k from cosine is final.
- **No hybrid / sparse / keyword search** — dense-only; exact identifiers have no fallback.
- **No streaming** — full-response latency to the user.
- **No caching** — every call recomputes.
- **No chunking-strategy tuning** — library default fixed-size-by-character, untuned.
- **No faithfulness eval / LLM-as-judge** — only retrieval is scored; answer grounding is unmeasured despite a `RubricJudge` sitting in the library.
- **No token/cost logging** — the `tokens_used` column and `model_usage` event both exist and are both unused.
- **No prompt-injection defense, no rate limiting, no circuit breaker** — acceptable at single-user local scale, named for honesty.
- **No classical ML** — the entire SECTION 04 surface.
