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
│ Grounded chat answer   │ bounded tool-calling    │ answer ONLY from your    │
│ (the chat TUI)         │ agent + RAG             │ notes, cite sources      │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Knowledge-base search  │ embed → HNSW ANN → rank │ semantic recall, not     │
│ (search_knowledge_base)│ (dense retrieval)       │ keyword match            │
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
│ Trajectory capture     │ full-signal trace sink  │ every step replayable;   │
│ (SupabaseTraceSink)    │ → agents.messages       │ tokens captured          │
└────────────────────────┴─────────────────────────┴──────────────────────────┘
```

Two models do all the work, both served locally by Ollama: `gemma2:9b` (generation) and `nomic-embed-text:v1.5` (768-dim embeddings). No cloud provider, no API key, no per-call dollar cost.

## Feature specs

### 1. Corpus indexing — the RAG index path

- **Inputs:** one or more markdown files (`npm run index -- file.md ...`). Typed as `{ id: basename, text, sourcePath }`.
- **Outputs:** a `agents.documents` row (source of truth) plus N `agents.chunks` rows, each `{ id: "<docId>#<i>", embedding vector(768), content, meta }`.
- **Model and provider:** `nomic-embed-text:v1.5` via `OllamaEmbeddingProvider`, 768-dim.
- **Mechanism:** `src/cli/index-cmd.ts` → `indexDocumentRow` (`src/runtime.ts`) writes the documents row, then `pipeline.index({id,text})`. The pipeline chunks (aptkit's fixed-512-char splitter, 64-char overlap), embeds each chunk, and `PgVectorStore.upsert` writes them in a transaction with `on conflict (id) do update`.
- **Approximate token / compute cost per call:** one embedding call per chunk; embeddings are cheap and local (no dollars). A typical note is a handful of chunks.
- **Failure modes observed / latent:** dimension mismatch throws loudly (`assertDim`, `assertWiring`, SQL `vector(768)`) — the 768 one-way door. Re-indexing is manual; an edited doc carries stale embeddings until you re-run `npm run index` (no `embedding_stale_at` tracking). Deleted source files leave orphan chunks (no delete handling). See `03-retrieval-and-rag/09-stale-embeddings.md` and `10-incremental-indexing.md`.
- **Eval set:** indirectly — retrieval quality over the indexed corpus is measured by `eval/queries.json`.

### 2. Grounded chat answer — the bounded agent + RAG

- **Inputs:** a natural-language question from the Ink chat TUI (`src/cli/chat.tsx` → `session.ask(question)`).
- **Outputs:** a grounded answer string, citing retrieved chunks, or the fallback ("I couldn't find anything in the knowledge base to answer that.").
- **Model and provider:** `gemma2:9b` via `GemmaModelProvider`, wrapped by `ContextWindowGuardedProvider({maxTokens:8192})`.
- **Mechanism:** `RagQueryAgent.answer` runs the agent loop (`runAgentLoop`): the system prompt forces a `search_knowledge_base` call first, the loop gathers chunks (`maxToolCalls:4`, `maxTurns:6`), then a forced synthesis turn strips the tools and demands a final grounded answer (`buildSynthesisInstruction`). Least-privilege: the agent may call only `search_knowledge_base`.
- **Approximate token / compute cost per call:** input = system prompt + injected me.md profile + rendered tool schema (gemma has no native tools, so the schema lives in the system *text* — not free) + question + retrieved chunks; output = the answer. Token counts are captured per call (see feature 7). No dollar cost (local).
- **Failure modes observed / latent:** the headline one — gemma's tool-calling is **emulated** (JSON parsed from prose) with **no argument-schema validation**. A wrong key (`{"q":...}` for `{"query":...}`) is accepted and the search runs on an empty string, returning noise the model then answers confidently. One retry nudge, then it falls through to prose. See `04-agents-and-tool-use/02-tool-calling.md`. No groundedness/faithfulness check verifies the answer actually used the chunks (see feature 6).
- **Eval set:** retrieval is covered by `eval/queries.json`; the generation step is **not** evaluated (faithfulness is unwired).

### 3. Knowledge-base search — dense retrieval

- **Inputs:** `{ query, top_k?, filter? }` from the agent's tool call.
- **Outputs:** `{ query, results: [{ id, score, citation: "[docId] snippet", meta }] }`.
- **Model and provider:** `nomic-embed-text:v1.5` (query embedding) + Postgres/pgvector HNSW cosine search.
- **Mechanism:** `createSearchKnowledgeBaseTool(pipeline, {minTopK:4})` → `pipeline.query` → `PgVectorStore.search`: `1 - (embedding <=> $1::vector) as score`, `order by embedding <=> $1::vector limit $3`, scoped `where app_id = $2`. A `filter` over-fetches `topK*4` then post-filters; a hallucinated filter key can't wipe results (`matchesFilter` only excludes hits that *have* the key with a different value).
- **Cost:** one query embedding + one ANN search per tool call. Local, cheap.
- **Failure modes:** pure dense retrieval — exact terms, rare identifiers, and code tokens that don't embed well are missed (no BM25/hybrid, see `03-retrieval-and-rag/05-dense-vs-sparse.md`). Single-stage ANN, no reranking, so the best chunk isn't reliably ordered first (lost-in-the-middle risk, see `02-context-and-prompts/02-lost-in-the-middle.md`).
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

### 7. Trajectory capture — full-signal observability

- **Inputs:** every `CapabilityEvent` the agent emits (step, tool_call_start, tool_call_end, model_usage, warning, error).
- **Outputs:** rows in `agents.messages` — assistant text, tool args (the cause), tool results + `durationMs` (spans), `model='provider/model'`, `tokens_used = input + output`, `created_at = event.timestamp` (deterministic replay order).
- **Mechanism:** `SupabaseTraceSink` (`src/supabase-trace-sink.ts`) — `emit()` is sync (aptkit's contract), queues writes, awaited via `flush()` after each turn.
- **Failure modes / honest gaps:** capture is replay-*ready* (timestamps preserved) but aptkit's replay runner is **unwired**; no dashboard; `tokens_used` is a lossy `input + output` sum, and there's no dollar conversion (Ollama is free). See `05-evals-and-observability/04-llm-observability.md`.

## What's captured but not yet exercised

The honest ledger — these are the strongest project-exercise targets:

- **Fine-tuning.** The captured trajectories in `agents.messages` are a fine-tuning corpus. No FT runs. This is the ceiling (`08-machine-learning/07-transfer-learning.md`).
- **Faithfulness eval.** `RubricJudge` is built in aptkit, never wired in buffr.
- **Reranking, hybrid/keyword search, query rewriting/HyDE, GraphRAG.** None present — pure single-stage dense retrieval over the raw question.
- **Streaming.** `stream: false`; the chat shows a spinner, not tokens.
- **Caching.** No prompt, semantic, or exact-match cache.
- **Chunking-strategy tuning.** Fixed 512-char windows, never tuned against the eval set.
- **Heuristic-before-LLM, model routing.** The agent always calls the LLM; one model.

## See also

- `00-overview.md` — the whole system in one frame.
- `03-retrieval-and-rag/11-rag.md` — the centerpiece walkthrough.
- `04-agents-and-tool-use/02-tool-calling.md` — the emulated-tool-calling reliability ceiling.
- `05-evals-and-observability/03-llm-as-judge-bias.md` — the unwired faithfulness judge.
- `ml-features-in-this-codebase.md` — the ML side (buffr trains nothing).
