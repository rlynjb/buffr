# AI features in this codebase

What buffr-laptop actually ships that uses an LLM or learned model — feature by feature, with the inputs, outputs, model, cost, and observed failure modes. This is the per-codebase counterpart to the concept files: those teach the patterns, this names where each pattern is wired in *your* code.

buffr is an **LLM application engineering** codebase (the loopd shape): single-purpose retrieval over a personal corpus, a bounded tool-calling agent, retrieval-based evals. It consumes pre-trained models; it trains none. (For the ML side, see `ml-features-in-this-codebase.md` — the short version is "buffr trains nothing.")

## The features, at a glance

```
buffr's AI features — what's wired

┌────────────────────────┬─────────────────────────┬──────────────────────────┐
│ Feature                │ Pattern used            │ Why this pattern         │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Corpus indexing        │ chunk → embed → upsert  │ one job: make notes      │
│ (npm run index)        │ (the RAG index path)    │ searchable by meaning    │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Grounded chat answer   │ bounded tool-calling    │ KB + web + RSS + reviews │
│ (the chat TUI)         │ agent + 6 tools         │ — synthesise all sources │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ KB search w/ threshold │ embed → HNSW ANN →      │ semantic recall + score  │
│ (search_knowledge_base)│ minScore 0.65 filter    │ guard vs. topic drift    │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Web search             │ connector fan-out        │ live facts outside the   │
│ (Google/Brave/Tavily)  │ (DataConnector<P,D>)    │ personal knowledge base  │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Live RSS feed          │ connector: fetch+parse  │ current AI/tech articles │
│ (fetch_rss_feed)       │ (RssConnector)          │ on demand, per question  │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Episodic memory        │ retrieval-based memory  │ past exchanges resurface │
│ (createConversation-   │ over conversation       │ via the same search tool │
│  Memory)               │ history (RAG-over-chat) │ — across sessions        │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Profile personalization│ system-prompt injection │ the assistant knows who  │
│ (loadProfile / me.md)  │                         │ it's assisting           │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Retrieval eval         │ precision@k / recall@k  │ measure retrieval before │
│ (npm run eval)         │ on a golden set         │ trusting answers         │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Trajectory capture +   │ full-signal trace sink  │ every step replayable;   │
│ live TUI callbacks     │ + per-ask onStatus/     │ real-time status + token │
│ (SupabaseTraceSink)    │   onTokens/onComplete   │ count shown live in chat │
└────────────────────────┴─────────────────────────┴──────────────────────────┘
```

Two local models via Ollama: `gemma2:9b` (generation) and `nomic-embed-text:v1.5` (768-dim embeddings). Three optional cloud search APIs (Google Custom Search, Brave, Tavily) are activated by their respective env keys — when present they carry a per-call API cost but stay within free-tier limits (Google: 100 req/day, Tavily: 1k/month, Brave: 2k/month).

## Feature specs

### 1. Corpus indexing — the RAG index path

- **Inputs:** one or more markdown files (`npm run index -- file.md ...`). Typed as `{ id: basename, text, sourcePath }`.
- **Outputs:** a `agents.documents` row (source of truth) plus N `agents.chunks` rows, each `{ id: "<docId>#<i>", embedding vector(768), content, meta }`.
- **Model and provider:** `nomic-embed-text:v1.5` via `OllamaEmbeddingProvider`, 768-dim.
- **Mechanism:** `src/cli/index-cmd.ts` → `indexDocumentRow` (`src/runtime.ts`) writes the documents row, then `pipeline.index({id,text})`. The pipeline chunks (aptkit's fixed-512-char splitter, 64-char overlap), embeds each chunk, and `PgVectorStore.upsert` writes them in a transaction with `on conflict (id) do update`.
- **Approximate token / compute cost per call:** one embedding call per chunk; embeddings are cheap and local (no dollars). A typical note is a handful of chunks.
- **Failure modes observed / latent:** dimension mismatch throws loudly (`assertDim`, `assertWiring`, SQL `vector(768)`) — the 768 one-way door. Re-indexing is manual; an edited doc carries stale embeddings until you re-run `npm run index` (no `embedding_stale_at` tracking). Deleted source files leave orphan chunks (no delete handling). See `03-retrieval-and-rag/09-stale-embeddings.md` and `10-incremental-indexing.md`.
- **Eval set:** indirectly — retrieval quality over the indexed corpus is measured by `eval/queries.json`.

### 2. Grounded chat answer — the bounded agent + 6 tools

- **Inputs:** a natural-language question from the OpenTUI chat TUI (`src/cli/chat.tsx` → `session.ask(question)`).
- **Outputs:** a grounded answer string synthesising KB chunks, web search results, and RSS articles; or the fallback ("I couldn't find anything in the knowledge base to answer that.").
- **Model and provider:** `gemma2:9b` via `GemmaModelProvider`, wrapped by `ContextWindowGuardedProvider({maxTokens:8192})`.
- **Tools available (session.ts:86-103):** `search_knowledge_base` (always), `fetch_rss_feed` (always), `fetch_amazon_reviews` (always), `web_search_google` / `web_search_brave` / `web_search_tavily` (each conditional on API key presence; trends tool disabled — scrapes unofficial endpoint Google blocks). The routing prompt mandates calling KB search first *and* the first available web-search tool for any question about companies, people, products, or news — regardless of what KB returned.
- **Mechanism:** `RagQueryAgent.answer` runs the agent loop (`runAgentLoop`): tool calls dispatched by Gemma in emulated JSON, up to `maxToolCalls:4`, `maxTurns:6`, then forced synthesis. Status of each tool call is forwarded live to the TUI via `currentOnStatus` (the mutable-trace-slot pattern — see feature 9).
- **Approximate token / compute cost per call:** input = system prompt + injected profile + rendered tool schemas for all enabled tools (Gemma has no native tools; schemas in system text — grows with each new tool) + question + all tool results; output = the synthesised answer. Token counts (input + output) accumulated live via `currentInputTokens`/`currentOutputTokens` and forwarded to `onTokens` callback; captured in `TurnStats.onComplete`. No dollar cost for local inference; web-search APIs carry free-tier per-call cost.
- **Failure modes observed / latent:** Gemma's tool calling is **emulated** (JSON parsed from prose), no argument-schema validation. Wrong key accepted, search on empty string, model answers the noise confidently. Google Custom Search returned 429 (quota exhausted) when the daily 100-query free limit was hit during setup. No groundedness/faithfulness check. See `04-agents-and-tool-use/02-tool-calling.md`.
- **Eval set:** retrieval covered by `eval/queries.json`; generation and multi-tool synthesis are **not** evaluated (faithfulness unwired).

### 3. Knowledge-base search — dense retrieval with score threshold

- **Inputs:** `{ query, top_k?, filter? }` from the agent's tool call.
- **Outputs:** `{ query, results: [{ id, score, citation: "[docId] snippet", meta }] }` — filtered to `score >= 0.65`.
- **Model and provider:** `nomic-embed-text:v1.5` (query embedding) + Postgres/pgvector HNSW cosine search.
- **Mechanism:** `createSearchKnowledgeBaseTool(pipeline, {minTopK:4, minScore:0.65})` (`src/session.ts:72`) → `pipeline.query` → `PgVectorStore.search`: `1 - (embedding <=> $1::vector) as score`, `order by embedding <=> $1::vector limit $3`, scoped `where app_id = $2`. The `minScore:0.65` threshold (`packages/kernel/src/retrieval/search-tool.ts`) then filters out any hit with a cosine similarity below 0.65 *before* returning to Gemma — preventing topic-drift answers like word-match false positives (e.g. "health" in nutrition chunks matching "guardoc health" questions). A `filter` over-fetches `topK*4` then post-filters; a hallucinated filter key can't wipe results.
- **Cost:** one query embedding + one ANN search per tool call. Local, cheap.
- **Failure modes:** pure dense retrieval — exact terms, rare identifiers, and code tokens that don't embed well are missed (no BM25/hybrid, see `03-retrieval-and-rag/05-dense-vs-sparse.md`). Single-stage ANN, no reranking. The `minScore` threshold is a blunt instrument — too high and relevant-but-loosely-worded chunks are discarded; 0.65 was chosen empirically. If KB returns zero hits above threshold, the routing prompt rules push Gemma to web search instead.
- **Eval set:** `eval/queries.json` (3 labeled queries).

### 4. Episodic memory — RAG over conversation history

- **Inputs:** each completed exchange `{ conversationId, question, answer }`.
- **Outputs:** a memory chunk in the *same* store, id `memory:<conv>:<n>`, tagged `meta.kind='memory'`, embedded.
- **Model and provider:** `nomic-embed-text:v1.5` + `PgVectorStore` (shared with documents).
- **Mechanism:** `createConversationMemory({embedder,store})` (`@aptkit/memory`). `remember` formats and embeds the exchange and upserts it. Because memory rides the same `chunks` table (the dropped FK allows a chunk with no documents row), past exchanges resurface through the *same* `search_knowledge_base` tool — retrieval-based episodic memory across sessions. `recall` exists too (over-fetch, filter `kind==='memory'`).
- **Cost:** one embedding + one upsert per turn. Best-effort: wrapped in try/catch in `session.ask()` so a memory-write failure never loses the user's answer.
- **Failure modes:** memory write is best-effort, so memory can have silent holes. buffr relies on the search tool surfacing memory chunks rather than calling `recall()` explicitly. There is **no** cross-turn in-prompt history — each `answer()` is independent; continuity is purely retrieval-based. See `04-agents-and-tool-use/05-agent-memory.md`.
- **Eval set:** none specific to memory.

### 5. Profile personalization — system-prompt injection

- **Inputs:** the most recent `agents.profiles` row (a me.md-style profile) for `app_id`.
- **Outputs:** the profile text prepended to the agent's system prompt under a heading.
- **Mechanism:** `loadProfile` (`src/profile.ts`) → injected via aptkit's `injectProfile({position:'start'})` in the `RagQueryAgent` constructor (built once per session).
- **Cost:** consumes context-window tokens every turn (the profile is in the system prompt).
- **Failure modes:** the profile is **trusted text** in the system prompt — a prompt-injection seam if the profile is attacker-controlled. See `06-production-serving/03-prompt-injection.md`. Empty profile is handled (`?? ''`).
- **Eval set:** none.

### 6. Retrieval eval — precision@k / recall@k

- **Inputs:** `eval/queries.json` = `[{ query, relevant: [docId] }]`, 3 hand-labeled items (work.md / stack.md / coffee.md). This is the **golden set**.
- **Outputs:** per-query `P@1` and `R@3`, plus means, printed to stdout (`npm run eval`).
- **Mechanism:** `src/cli/eval-cmd.ts` runs `pipeline.query(query, 3)`, dedupes docIds, scores with aptkit's `scorePrecisionAtK` / `scoreRecallAtK` (distinct-hit counting; not-well-formed guard when nothing retrieved).
- **Failure modes / honest gaps:** measures **retrieval** identity only. No **faithfulness** eval — the `RubricJudge` exists in aptkit but is **unwired** in buffr, so nobody checks whether the generated answer stays grounded in the retrieved chunks. No adversarial set, no regression set. See `05-evals-and-observability/`.

### 7. Trajectory capture + live TUI callbacks — full-signal + real-time

- **Inputs:** every `CapabilityEvent` the agent emits (step, tool_call_start, tool_call_end, model_usage, warning, error).
- **Outputs (durable):** rows in `agents.messages` — assistant text, tool args, tool results + `durationMs`, `model`, `tokens_used = input + output`, `created_at` (deterministic replay order).
- **Outputs (live):** `onStatus(msg)` fired on every `tool_call_start` event (displays human-readable label like "searching Google" in the TUI spinner); `onTokens({input, output})` fired on every `model_usage` event (accumulates live in `liveTokens` state); `onComplete(TurnStats)` called after `agent.answer()` returns with total `durationMs`, `inputTokens`, `outputTokens`.
- **Mechanism:** `SupabaseTraceSink` (`src/supabase-trace-sink.ts`) handles durable writes. Wrapped by a **mutable-trace-slot** in `session.ts:120-138`: before each `ask()`, `currentOnStatus` and `currentOnTokens` slots are set to the caller's callbacks; `trace.emit()` fires both the slot (live TUI) and the sink (Postgres); slots are cleared after the agent returns. The `TOOL_LABELS` map (`session.ts:44-52`) translates tool names → human strings. Real-time elapsed time is tracked in `<Spinner>` via `useRef(Date.now())` (`src/cli/chat.tsx:26-36`), independent of the callback path.
- **Failure modes / honest gaps:** capture is replay-*ready* but aptkit's replay runner is **unwired**; no dashboard; `tokens_used` is a lossy sum — no dollar conversion for cloud APIs yet (web-search API costs are untracked). The mutable slots are **not thread-safe**: a hypothetical second concurrent `ask()` call would overwrite them. Single-user single-call assumption makes this safe today. See `05-evals-and-observability/04-llm-observability.md`.

## What's captured but not yet exercised

The honest ledger — these are the strongest project-exercise targets:

- **Fine-tuning.** The captured trajectories in `agents.messages` are a fine-tuning corpus. No FT runs. This is the ceiling (`08-machine-learning/07-transfer-learning.md`).
- **Faithfulness eval.** `RubricJudge` is built in aptkit, never wired in buffr. The multi-tool synthesised answer is also not evaluated.
- **Reranking, hybrid/keyword search, query rewriting/HyDE, GraphRAG.** None present — pure single-stage dense retrieval over the raw question, post-filtered by `minScore:0.65`.
- **Web search eval.** The three web search connectors are functional but not evaluated — no golden set, no latency baseline, no accuracy measurement.
- **Streaming.** `stream: false`; the chat shows a spinner + live token count, not streaming tokens.
- **Caching.** No prompt, semantic, or exact-match cache. Web search results are not cached either.
- **Chunking-strategy tuning.** Fixed 512-char windows, never tuned against the eval set.
- **Heuristic-before-LLM, model routing.** The agent always calls the LLM; one model.
- **Web-search retry / quota handling.** Google 429 (quota exhausted) is visible to the agent as a tool error; no retry, no fallback to the next provider.

## See also

- `00-overview.md` — the whole system in one frame.
- `03-retrieval-and-rag/11-rag.md` — the centerpiece walkthrough.
- `04-agents-and-tool-use/02-tool-calling.md` — the emulated-tool-calling reliability ceiling.
- `05-evals-and-observability/03-llm-as-judge-bias.md` — the unwired faithfulness judge.
- `ml-features-in-this-codebase.md` — the ML side (buffr trains nothing).
