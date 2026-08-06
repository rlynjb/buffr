# AI features in this codebase

What buffr-laptop actually ships that uses an LLM or learned model — feature by feature, with the inputs, outputs, model, cost, and observed failure modes. This is the per-codebase counterpart to the concept files: those teach the patterns, this names where each pattern is wired in *your* code.

buffr is an **LLM application engineering** codebase (the loopd shape): single-purpose retrieval over a personal corpus, a bounded tool-calling agent, retrieval-based evals. It consumes pre-trained models; it trains none. (For the ML side, see `ml-features-in-this-codebase.md` — the short version is "buffr trains nothing.")

## The features, at a glance

```
buffr's AI features — what's wired

┌────────────────────────┬─────────────────────────┬──────────────────────────┐
│ Feature                │ Pattern used            │ Why this pattern         │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Corpus indexing        │ chunk → embed → upsert  │ one job: make markdown   │
│ (npm run index)        │ (the RAG index path)    │ notes searchable         │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ DB indexing            │ query → sanitize →      │ personal DB rows (journal│
│ (npm run index:db)     │ chunk → embed → upsert  │ tasks, health, fitness)  │
│                        │ DbSource config-object  │ into the same KB         │
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
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Capabilities pipeline  │ Collector→Analyzer→     │ structured multi-step    │
│ (@buffr/capabilities)  │ Scorer→Teacher→Journal  │ analysis outside the     │
│                        │ (Engine pattern)        │ agent loop               │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Investing analysis     │ InvestingEngine.run()   │ chat command /investing  │
│ (/investing <TICKER>)  │ (Engine<In,Out>)        │ delegates to the engine  │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Investing eval         │ Scorer against fixtures  │ /eval command verifies   │
│ (/eval)                │ (pure math, no LLM)     │ scorecard accuracy       │
│                        │                         │ offline                  │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Market research        │ MarketResearchEngine    │ a SECOND domain engine,  │
│ (/research <topic>)    │ .collect()/.evaluate()  │ same Collector→Analyzer→ │
│                        │ (split Engine pattern)  │ Scorer→Teacher shape     │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Predict-then-reveal    │ research-flow.ts state  │ human commits to a score │
│ calibration loop       │ machine + Prediction-   │ BEFORE seeing the        │
│ (/research prediction) │ Comparison (code, not   │ engine's — measures the  │
│                        │ LLM, computes the gap)  │ human's own calibration  │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Decision journal        │ JournalStore contract   │ tracks predict-then-     │
│ (/review)               │ (Pg/InMemory) →         │ reveal predictions to a  │
│                         │ agents.decisions        │ resolved real-world      │
│                         │                          │ outcome                 │
└────────────────────────┴─────────────────────────┴──────────────────────────┘
```

Two local models via Ollama: `gemma2:9b` (generation) and `nomic-embed-text:v1.5` (768-dim embeddings). Three optional cloud search APIs (Google Custom Search, Brave, Tavily) are activated by their respective env keys — when present they carry a per-call API cost but stay within free-tier limits (Google: 100 req/day, Tavily: 1k/month, Brave: 2k/month).

## Feature specs

### 1. Corpus indexing — two paths, one shared pipeline

#### 1a. Markdown indexing (`npm run index`)

- **Inputs:** one or more markdown files (`npm run index -- file.md ...`). Typed as `{ id: basename, text, sourcePath }`.
- **Outputs:** a `agents.documents` row (`source_type='markdown'`) plus N `agents.chunks` rows, each `{ id: "<docId>#<i>", embedding vector(768), content, meta }`.
- **Model and provider:** `nomic-embed-text:v1.5` via `OllamaEmbeddingProvider`, 768-dim.
- **Mechanism:** `src/cli/index-cmd.ts` → `indexDocumentRow` (`src/runtime.ts`) writes the documents row, then `pipeline.index({id,text})`. The pipeline chunks (kernel's fixed-512-char splitter, 64-char overlap), embeds each chunk, and `PgVectorStore.upsert` writes them in a transaction with `on conflict (id) do update`.
- **Approximate token / compute cost per call:** one embedding call per chunk; embeddings are cheap and local (no dollars). A typical note is a handful of chunks.
- **Failure modes observed / latent:** dimension mismatch throws loudly (`assertDim`). Re-indexing is manual; an edited doc carries stale embeddings until re-run. Deleted source files leave orphan chunks (no delete handling).
- **Eval set:** indirectly — retrieval quality over the indexed corpus is measured by `eval/queries.json`.

#### 1b. DB indexing (`npm run index:db`)

- **Inputs:** live Postgres queries defined in `src/db-sources.ts` — 8 tables across two schemas (`loopd`: entries/todo_meta/nutrition/vlogs/habits; `contrl`: exercises/sessions/week_progress). No file paths; rows pulled at run time.
- **Outputs:** same pipeline as markdown — `agents.documents` rows (`source_type='db'`) + `agents.chunks` with embeddings. The corpus now mixes markdown notes and personal DB data in the same KB.
- **Model and provider:** same — `nomic-embed-text:v1.5`, 768-dim.
- **Mechanism:** `src/cli/index-db-cmd.ts` → `pool.query(source.query)` per `DbSource` entry → `sanitize()` (strip UTF-16 surrogates — emoji in journal entries can produce lone surrogates that Postgres JSON rejects) → `indexDocumentRow(..., { sourceType: 'db' })` → same `pipeline.index` path.
- **Approximate token / compute cost per call:** one embedding per chunk; a large journal entry table may generate many chunks. Row counts unknown at write time.
- **Failure modes:** `sanitize()` strips surrogates silently; no warning if data is corrupted. The DB queries are hardcoded (`db-sources.ts`); a schema rename breaks them silently at index time.

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
- **Mechanism:** `createConversationMemory({embedder,store})` (`@buffr/kernel`, `packages/kernel/src/memory/conversation-memory.ts`). `remember` formats and embeds the exchange and upserts it. Because memory rides the same `chunks` table (the dropped FK allows a chunk with no documents row), past exchanges resurface through the *same* `search_knowledge_base` tool — retrieval-based episodic memory across sessions. `recall` exists too (over-fetch, filter `kind==='memory'`).
- **Cost:** one embedding + one upsert per turn. Best-effort: wrapped in try/catch in `session.ask()` so a memory-write failure never loses the user's answer.
- **Failure modes:** memory write is best-effort, so memory can have silent holes. buffr relies on the search tool surfacing memory chunks rather than calling `recall()` explicitly. There is **no** cross-turn in-prompt history — each `answer()` is independent; continuity is purely retrieval-based. See `04-agents-and-tool-use/05-agent-memory.md`.
- **Eval set:** none specific to memory.

### 5. Profile personalization — system-prompt injection

- **Inputs:** the most recent `agents.profiles` row (a me.md-style profile) for `app_id`.
- **Outputs:** the profile text prepended to the agent's system prompt under a heading.
- **Mechanism:** `loadProfile` (`src/profile.ts`) → injected via `@buffr/kernel`'s `injectProfile({position:'start'})` (`packages/kernel/src/agents/prompt-helpers.ts`) in the `RagQueryAgent` constructor (built once per session).
- **Cost:** consumes context-window tokens every turn (the profile is in the system prompt).
- **Failure modes:** the profile is **trusted text** in the system prompt — a prompt-injection seam if the profile is attacker-controlled. See `06-production-serving/03-prompt-injection.md`. Empty profile is handled (`?? ''`).
- **Eval set:** none.

### 6. Retrieval eval — precision@k / recall@k

- **Inputs:** `eval/queries.json` = `[{ query, relevant: [docId] }]`, 3 hand-labeled items (work.md / stack.md / coffee.md). This is the **golden set**.
- **Outputs:** per-query `P@1` and `R@3`, plus means, printed to stdout (`npm run eval`).
- **Mechanism:** `src/cli/eval-cmd.ts` runs `pipeline.query(query, 3)`, dedupes docIds, scores with `@buffr/kernel`'s `scorePrecisionAtK` / `scoreRecallAtK` (`packages/kernel/src/evals/precision-at-k.ts`; distinct-hit counting; not-well-formed guard when nothing retrieved).
- **Failure modes / honest gaps:** measures **retrieval** identity only. No **faithfulness** eval — `RubricJudge` (`packages/kernel/src/evals/rubric-judge.ts`) exists but is **unwired** in buffr's chat/eval path, so nobody checks whether the generated answer stays grounded in the retrieved chunks. No adversarial set, no regression set. See `05-evals-and-observability/`. (The `/research` predict-then-reveal loop, features 11-12 below, is a real but different human-in-the-loop signal — it checks a human's calibration against the engine's score, not whether the engine's own output is grounded in evidence.)

### 7. Trajectory capture + live TUI callbacks — full-signal + real-time

- **Inputs:** every `CapabilityEvent` the agent emits (step, tool_call_start, tool_call_end, model_usage, warning, error).
- **Outputs (durable):** rows in `agents.messages` — assistant text, tool args, tool results + `durationMs`, `model`, `tokens_used = input + output`, `created_at` (deterministic replay order).
- **Outputs (live):** `onStatus(msg)` fired on every `tool_call_start` event (displays human-readable label like "searching Google" in the TUI spinner); `onTokens({input, output})` fired on every `model_usage` event (accumulates live in `liveTokens` state); `onComplete(TurnStats)` called after `agent.answer()` returns with total `durationMs`, `inputTokens`, `outputTokens`.
- **Mechanism:** `SupabaseTraceSink` (`src/supabase-trace-sink.ts`) handles durable writes. Wrapped by a **mutable-trace-slot** in `session.ts:120-138`: before each `ask()`, `currentOnStatus` and `currentOnTokens` slots are set to the caller's callbacks; `trace.emit()` fires both the slot (live TUI) and the sink (Postgres); slots are cleared after the agent returns. The `TOOL_LABELS` map (`session.ts:44-52`) translates tool names → human strings. Real-time elapsed time is tracked in `<Spinner>` via `useRef(Date.now())` (`src/cli/chat.tsx:26-36`), independent of the callback path.
- **Failure modes / honest gaps:** capture is replay-*ready* (deterministic `created_at` ordering) but **no replay runner exists anywhere in the current stack** — this was a documented aptkit capability that did not carry over in the `@buffr/kernel` migration (`d61751e`), not a currently-unwired-but-present tool. No dashboard; `tokens_used` is a lossy sum — no dollar conversion for cloud APIs yet (web-search API costs are untracked). The mutable slots are **not thread-safe**: a hypothetical second concurrent `ask()` call would overwrite them. Single-user single-call assumption makes this safe today. See `05-evals-and-observability/04-llm-observability.md`.

### 8. Capabilities pipeline — structured multi-step analysis (now two engines share it)

- **Inputs:** ticker + entityType (investing) or a free-text topic (market research); evidence collected from web/discovery sources.
- **Outputs:** `totalScore`, `confidence`, `explanation`, `keyLessons`, `actionableNext`, plus (new) `principle` + `reflectionQuestion` — wrapped in `AgentResult<InvestingOutput>` / `AgentResult<MarketResearchOutput>`.
- **Pattern:** `Collector → Analyzer (LLM) → Scorer (pure math) → Teacher (LLM)` — the **same four-capability shape**, wired twice: `packages/engines/investing/src/engine.ts` and `packages/engines/market-research/src/engine.ts`. This is the self-similarity payoff of the `@buffr/capabilities` design: a second domain (market research) was added by writing a domain pack (`@buffr/domain-pack-market-research` — dimensions, scorecard, prompts) and a ~240-line engine, reusing every capability unchanged.
- **Key design call:** each capability is independently instantiable and testable; LLM calls are isolated to exactly two stages (Analyzer and Teacher); Scorer is deterministic math — no model dependency.
- **Teacher's structured output, with a field-level fallback (new — `01a212e`):** `Teacher.execute()` (`packages/capabilities/src/teacher/index.ts:48-138`) now asks the model for two more fields beyond the original three — `principle` (one transferable lesson) and `reflectionQuestion` (one question that tests whether the result is worth trusting) — via the `submit_explanation` tool schema (`SUBMIT_EXPLANATION_TOOL`, lines 24-38). When the model's captured args omit or blank either field, buffr does **not** retry the LLM call — it falls back in code: `fallbackPrinciple()` (lines 40-44) derives a principle from the highest-scoring finding (`"${strongest.dimensionId} was the strongest signal (${score}/100) — ${summary}"`), and `reflectionQuestion` falls back to a fixed string (`FALLBACK_REFLECTION_QUESTION`, line 46). Both paths are unit-tested in `packages/capabilities/test/teacher.test.ts:105-151` — one test asserts the fallback fires and references the strongest dimension by name, the other asserts model-supplied values pass through untouched. See `01-llm-foundations/04-structured-outputs.md` for how this compares to the ceiling documented there (same emulated-tool-call mechanism, one layer of graceful degradation deeper).
- **Capability source:** `@buffr/capabilities` (`packages/capabilities/src/`); domain data: `@buffr/domain-pack-investing` and `@buffr/domain-pack-market-research` (`packages/domain-packs/`).
- **Failure modes:** if `evidence.length === 0` (Collector found nothing), the engine short-circuits and returns confidence=0 with no LLM calls (investing: `engine.ts:48-69`; market research: the caller checks `collected.digest.totalCount === 0` in `research-flow.ts:85-88` before ever calling `evaluate()`).
- **Eval set:** Scorer accuracy is covered by `test/commands.test.ts:28-79` (investing, fixture-based, no LLM) and `packages/domain-packs/market-research/test/scorecard.test.ts` (market research). Analyzer + Teacher quality: not evaluated by an automated oracle — the predict-then-reveal loop (feature 11, below) is the closest thing buffr has to a human check on Teacher's output, but it checks the *score*, not the *explanation text*.

### 9. /investing <TICKER> command

- **Inputs:** user types `/investing AAPL` or `/investing VTI` in chat.
- **ETF detection:** `detectEntityType()` exported from `src/session.ts` — a `Set` of 26 known ETF tickers; default is `'company'` for anything not in the Set.
- **Outputs:** formatted analysis string displayed as buffr turn in TUI; the same `onStatus`/`onTokens`/`onComplete` callback wiring as `session.ask()`.
- **Mechanism:** `src/cli/chat.tsx:65-83` intercepts the command before `session.ask()`, calls `session.analyze(ticker, entityType, opts)` which calls `investingEngine.run()` (`session.ts:388-406`). InvestingEngine is constructed once per session in `createChatSession()`.
- **Fallback:** when no web search connectors are configured (`BRAVE_API_KEY` / `TAVILY_API_KEY` both absent), `investingEngine` is `null` and `session.analyze()` returns a "No web search connectors configured" message without running the pipeline.
- **Failure modes:** same as Feature 8 (zero-evidence short-circuit). Error is caught in `chat.tsx` and rendered as an error turn.

### 10. /eval command — offline scorer accuracy

- **Inputs:** no user input beyond `/eval`.
- **Outputs:** a table of pass/fail per fixture, with expected/actual/delta.
- **Mechanism:** `session.evalInvesting()` loads `packages/domain-packs/investing/eval/company-fixtures.json` and `etf-fixtures.json` via `new URL(..., import.meta.url)` (`session.ts:376-386`). Runs a `Scorer` instance against each fixture's `findings` + scorecard, asserts `|actual - expected| ≤ 0.01`.
- **Pattern:** pure-computation eval with fixture files — no LLM, no web, no DB. The same fixture load-and-assert runs in `test/commands.test.ts:28-79` as a proper test assertion; `evalInvesting()` renders the same check as a human-readable table in the TUI.
- **Failure modes:** none observed. Scorer is deterministic; fixture JSON is checked into the monorepo.
- **What it does not cover:** whether the LLM-generated explanation is grounded in the evidence (faithfulness) — that is not evaluated here.

### 11. /research <topic> — the predict-then-reveal calibration loop

- **Inputs:** a free-text topic typed after `/research` in chat.
- **Outputs:** an interactive multi-turn flow, not a single answer — evidence digest, then a forced human prediction, then the engine's reveal (score/gap/principle/reflection), then an optional promotion to a tracked decision.
- **The mechanism that makes this new:** `MarketResearchEngine.run()` was **split into `collect()` and `evaluate()`** (`a3e88fc`, `packages/engines/market-research/src/engine.ts:56-237`). `collect()` (lines 56-117) fans sources out in parallel and returns a **safe digest** — `EvidenceDigest{totalCount, sources:[{source,count,titles}]}` — explicitly *no findings, scores, or synthesized text* (see the doc comment at line 50-55). `evaluate()` (lines 125-237) is a second, separate call that runs Analyzer → Scorer → Teacher and computes a `PredictionComparison` **in code, never asking the model to invent the gap** (lines 202-208: `scoreGap = actualScore - prediction.expectedScore`, `dimensionMatched` is a plain equality check).
- **Why the split matters:** it opens a pause point between "the system has raw evidence" and "the system has an opinion" that didn't exist when `run()` was one call. `src/cli/research-flow.ts` is the state machine that uses that pause: `start()` calls `session.researchCollect()` and shows the digest + a forced-format prediction prompt (`PREDICTION_PROMPT`, lines 37-42: `"<score 0-100> <dimension> <confidence 0-100>"`) — **the human must commit to a number before the engine's own score exists anywhere the human could see it.** Only after `parsePrediction()` succeeds does `submit()` call `session.researchEvaluate(collected, prediction, callbacks)`, which reveals `formatReveal()` (lines 56-69): your call vs. buffr's score vs. the signed gap, whether the strongest dimension matched, plus Teacher's `principle` and `reflectionQuestion` (feature 8).
- **Session wiring:** `src/session.ts:713-744` — `researchCollect()` and `researchEvaluate()` are thin wrappers that build a fresh `AgentContext` per call (`traceId` prefixed `research-collect-`/`research-evaluate-`) and forward `onStatus`/`onProgress`/`onTokens` callbacks into the same mutable-trace-slot mechanism feature 7 documents. Both engines (`investingEngine`, `researchEngine`) share the one `GemmaModelProvider` instance built once in `createChatSession()` (`session.ts:516-561`) — so Teacher's structured-output ceiling (feature 8) is identical for both domains.
- **This is a genuinely distinct AI-engineering pattern, not a chatbot feature:** it is closer to **human-in-the-loop evaluation / calibration training** than to agents or to a standard eval harness — see `05-evals-and-observability/02-eval-methods.md`'s updated "human" rung for where this sits on the eval-method ladder, and why it answers a different question than a classic human-rates-the-output eval.
- **Failure modes:** a malformed prediction reply (wrong token count, out-of-range score, unknown dimension) is rejected by `parsePrediction()` and re-prompted (`research-flow.ts:44-54`) — the flow cannot advance past `'prediction'` without a well-formed commitment. If `collected.digest.totalCount === 0`, the flow ends immediately with "No evidence found" and `evaluate()` is never called (mirrors the investing engine's zero-evidence short-circuit).
- **Eval set:** none — this loop *is* the closest thing to a human eval buffr has, but it evaluates the *human's* calibration against the engine, not the engine's answer against ground truth. See feature 12 for how that gap eventually gets closed.

### 12. Decision journal + /review — closing the calibration loop

- **Inputs:** a promoted `/research` decision (`stake`, `resolutionCondition`, `reviewAt`, both `prediction` and `assessment`) written via `session.saveDecision()` (`session.ts:758-783`); later, a real-world outcome typed during `/review`.
- **Outputs:** a row in `agents.decisions` (`sql/002_decision_journal.sql`) that carries **both sides of the predict-then-reveal loop** — the human's `predicted_score`/`predicted_dimension`/`predicted_confidence` and the engine's `assessed_score`/`assessed_confidence` — through a status lifecycle `open → review-due → resolved`/`snoozed`.
- **Mechanism:** the `JournalStore` contract (`packages/kernel/src/journal/contracts.ts:67-72` — `create`/`listDue`/`snooze`/`resolve`) has two implementations sharing one behavior contract: `InMemoryJournalStore` (`packages/kernel/src/journal/in-memory-journal-store.ts`, used in tests) and `PgJournalStore` (`src/pg-journal-store.ts`, scoped by `app_id`) — the identical adapter-behind-a-contract shape buffr already uses for `VectorStore`/`PgVectorStore`. `listDue()` doubles as the `open → review-due` state transition (a side effect of being listed, documented at `contracts.ts:61-66` so both implementations must do it identically). `src/cli/review-flow.ts` is the `/review` state machine: surfaces one due decision at a time, offers keep/snooze/resolve, and on resolve asks for a `Disposition` (`'successful' | 'unsuccessful' | 'inconclusive'`) plus a free-text note.
- **Why this is a maturity signal, not just a feature:** most AI features never record whether their predictions were right. This one does, end to end — predict (human) → reveal (engine) → promote (decision with a stake and a falsifiable resolution condition) → resolve (human records the real outcome weeks later) — which is the calibration-tracking infrastructure that a `08-machine-learning/09-calibration.md`-style reliability diagram would eventually need real data from.
- **Failure modes:** resolution is entirely manual — nothing reminds buffr's user to open `/review` beyond `dueReviewCount()` (`session.ts:784-787`), which the chat UI can poll but nothing currently forces. A decision can sit `review-due` indefinitely if the user never runs `/review`. No aggregate calibration report exists yet (e.g., "of 12 resolved decisions, how often was the human's confidence well-calibrated vs. the engine's") — the raw data is captured, the analysis is not built.
- **Eval set:** none automated — the decision journal *is* the evaluation, just a slow, human-paced one instead of a CI-speed one.

## What's captured but not yet exercised

The honest ledger — these are the strongest project-exercise targets:

- **Fine-tuning.** The captured trajectories in `agents.messages` are a fine-tuning corpus. No FT runs. This is the ceiling (`08-machine-learning/07-transfer-learning.md`).
- **Faithfulness eval.** `RubricJudge` (`packages/kernel/src/evals/rubric-judge.ts`) is built, never constructed in buffr. The multi-tool synthesised answer is also not evaluated.
- **Aggregate calibration reporting.** The decision journal (feature 12) captures per-decision prediction-vs-assessment-vs-outcome data, but nothing rolls it up — no "how well-calibrated is the human, vs. the engine, across N resolved decisions" report. The raw material for a real calibration curve exists in `agents.decisions`; the analysis doesn't.
- **Reranking, hybrid/keyword search, query rewriting/HyDE, GraphRAG.** None present — pure single-stage dense retrieval over the raw question, post-filtered by `minScore:0.65`.
- **Web search eval.** The three web search connectors are functional but not evaluated — no golden set, no latency baseline, no accuracy measurement.
- **Streaming.** `stream: false`; the chat shows a spinner + live token count, not streaming tokens.
- **Caching.** No prompt, semantic, or exact-match cache in the RAG/agent path. `CachedConnector` is used for investing web sources (wrapping Brave/Tavily connectors in `InvestingEngine`), so those results are cached within a session run — but the broader agent loop and embeddings remain uncached.
- **Chunking-strategy tuning.** Fixed 512-char windows, never tuned against the eval set.
- **Heuristic-before-LLM, model routing.** The agent always calls the LLM; one model.
- **Web-search retry / quota handling.** Google 429 (quota exhausted) is visible to the agent as a tool error; no retry, no fallback to the next provider.
- **Investing faithfulness eval.** The `/eval` command scores Scorer accuracy against fixtures; it does not evaluate whether the LLM-generated explanation (from Analyzer + Teacher) is grounded in the evidence. That faithfulness gap is the same unwired `RubricJudge` gap noted for the main chat agent.

## See also

- `00-overview.md` — the whole system in one frame.
- `03-retrieval-and-rag/11-rag.md` — the centerpiece walkthrough.
- `04-agents-and-tool-use/02-tool-calling.md` — the emulated-tool-calling reliability ceiling that Teacher's `submit_explanation` call also rides.
- `01-llm-foundations/04-structured-outputs.md` — Teacher's principle/reflection fallback as a second, more disciplined worked example of structured output.
- `05-evals-and-observability/02-eval-methods.md` — where the predict-then-reveal loop sits on the eval-method ladder (the "human" rung, updated).
- `05-evals-and-observability/03-llm-as-judge-bias.md` — the unwired faithfulness judge.
- `ml-features-in-this-codebase.md` — the ML side (buffr trains nothing).
