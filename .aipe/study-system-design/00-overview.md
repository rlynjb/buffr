# 00 — System Overview

One page. One diagram. The whole of `buffr-laptop` on a single map, every box labelled with
what it is, what it owns, and what it talks to. Skim only this file and you have the system.

## The whole system, one frame

The thing to hold in your head: buffr is a thin **body** wrapped around a thick **library**.
Everything labelled "@buffr/kernel" is consumed, never edited here. Everything labelled
"buffr" is the repo's own ~20 files. The seam between them is the most important line on the
diagram. Since the last sync, two things were added on top of that same shape: a second
domain engine with a materially different call contract, and a decision-journal subsystem
that turns a `/research` run into a tracked, dated prediction.

```
  buffr-laptop — the full system (single device, one user)

  ┌─ UI layer ───────────────────────────────────────────────────────────┐
  │  src/cli/chat.tsx — OpenTUI (React-in-terminal) chat                 │
  │    spinner: tool name · elapsed time · live token count              │
  │    ProgressPanel: renders ProgressStep[] built from onProgress()     │
  └───────────────────────────────┬───────────────────────────────────────┘
                                  │  session.ask(q, {onStatus,onTokens,onComplete,onProgress})
                                  │  or: drives an active flow's controller.submit(q)
                                  ▼
  ┌─ CLI flow layer (buffr owns — in-command state machines) ─────────────┐
  │  src/cli/research-flow.ts   predict → reveal → promote                │
  │    (discard / hypothesis / decision → stake → resolution → review-date)│
  │  src/cli/review-flow.ts     per-due-decision: keep / snooze / resolve │
  │  src/cli/parse-review-date.ts  shared "N days" | ISO-date parser      │
  └───────────────────────────────┬───────────────────────────────────────┘
                                  │  session.researchCollect/researchEvaluate/
                                  │  saveHypothesis/saveDecision/listDueReviews/
                                  │  snoozeReview/resolveReview
                                  ▼
  ┌─ Session layer (buffr owns) ──────────────────────────────────────────┐
  │  src/session.ts — createChatSession()                                  │
  │    • ONE warm pg.Pool          • ONE conversationId across all turns   │
  │    • agent + both engines built ONCE  • mutable trace slots            │
  │    • TOOL_LABELS map → human status names                              │
  └───────┬─────────────────┬───────────────────┬──────────────┬──────────┘
          │ builds once     │ run per turn      │ remember      │ journal
          ▼                 ▼                   ▼               ▼
  ┌─ @buffr/kernel + Engine/Capability/Domain-pack packages (never edited at root) ─────────────┐
  │  RagQueryAgent.answer()      run-agent-loop, ReAct-style                                     │
  │    GemmaModelProvider ─ guarded by ContextWindowGuardedProvider(8192)                        │
  │    createRetrievalPipeline ─ OllamaEmbeddingProvider + VectorStore                            │
  │    createSearchKnowledgeBaseTool(minTopK:4, minScore:0.65) ─ tool 1                          │
  │    createConversationMemory ─ embed+tag+recall episodic memory engine                         │
  │                                                                                                │
  │  InvestingEngine.run()  (packages/engines/investing/) — ONE call, ONE pass                    │
  │    Collector→Analyzer→Scorer→Teacher→Journal (packages/capabilities/)                          │
  │    DIMENSIONS + SCORECARD + PROMPTS (packages/domain-packs/investing/)                         │
  │                                                                                                │
  │  MarketResearchEngine  (packages/engines/market-research/) — TWO calls, LLM in the second      │
  │    .collect(topic)  → Collector only → CollectedResearch{evidence, digest} — NO LLM call yet   │
  │                        emits ProgressEvent per connector (engine-start/connector-*)            │
  │    .evaluate(collected, prediction) → Analyzer→Scorer→Teacher → MarketResearchOutput           │
  │                        {summary, detail, comparison: PredictionComparison}                      │
  │    DIMENSIONS + SCORECARD + PROMPTS (packages/domain-packs/market-research/)                   │
  └───────┬───────────────────────────────────┬──────────────┬───────────────┬────────────────────┘
          │ store port (VectorStore)           │ trace port   │ uses same    │ journal port
          ▼                                    ▼              │ store        ▼ (JournalStore)
  ┌─ Adapter layer (buffr owns) ──────────────────────────────┴───────────────────────────────────┐
  │  PgVectorStore         SupabaseTraceSink + mutable-slot wrapper                                 │
  │  implements VectorStore implements CapabilityTraceSink                                          │
  │  src/pg-vector-store.ts  src/supabase-trace-sink.ts + session.ts slots                          │
  │                                                                                                   │
  │  PgJournalStore implements JournalStore (packages/kernel/src/journal/contracts.ts)               │
  │  src/pg-journal-store.ts — create/listDue/snooze/resolve on agents.decisions, scoped by app_id.  │
  │  InMemoryJournalStore (packages/kernel) is the test-only sibling behind the same contract.        │
  │                                                                                                   │
  │  Connector tools (buffr/packages/connectors):                                                     │
  │    RssConnector           → fetch_rss_feed        (always active)                                │
  │    AmazonReviewsConnector → fetch_amazon_reviews   (always active)                                │
  │    GoogleSearchConnector  → web_search_google      (key-gated)                                    │
  │    BraveSearchConnector   → web_search_brave       (key-gated)                                    │
  │    TavilySearchConnector  → web_search_tavily      (key-gated)                                    │
  │    RedditSearchConnector  → reddit .json search listing (always active, frequently 403s)          │
  │    GoogleTrendsConnector  → search-trends (always active, HTML-response guarded — see audit §6)   │
  └───────────────────────────────┬───────────────────────────────────────────────────────────────┘
                                  │  node-postgres (pg), direct TCP
                                  ▼
  ┌─ Storage layer (Postgres `reindb`, schema `agents`) ──────────────────────────────────────────┐
  │  documents · chunks(vector) · conversations · messages · profiles ·                             │
  │  decisions (sql/002_decision_journal.sql — predicted_*/assessed_*/stake/review_at/status)        │
  └────────────────────────────────────────────────────────────────────────────────────────────────┘
                  ▲ HTTP localhost:11434           ▲ HTTPS (external, key-gated or unauthenticated)
  ┌─ Local Ollama ─────────────────┐  ┌─ Web Search / Discovery APIs ──────────────────────────────┐
  │  gemma2:9b · nomic-embed-text  │  │  Google CSE · Brave · Tavily · Reddit · Google Trends       │
  └────────────────────────────────┘  └───────────────────────────────────────────────────────────┘
```

## Legend — what each component is, owns, and talks to

| Component | What it is | What it owns | Talks to |
|---|---|---|---|
| `chat.tsx` | OpenTUI, the only interface | screen state (turns, busy, liveTokens, `activeFlow`, `progressSteps`) | `session.*` methods, or an active flow's `controller.submit(q)` |
| `research-flow.ts` | in-command state machine | `step` (prediction→promote→stake→resolution→review-date→done), the collected evidence + prediction across steps | `session.researchCollect`, `session.researchEvaluate`, `session.saveHypothesis`/`saveDecision` |
| `review-flow.ts` | in-command state machine | the due-decisions list, current index, `step` (action→snooze-date/disposition→note→done) | `session.listDueReviews`, `session.snoozeReview`, `session.resolveReview` |
| `session.ts` | the orchestrator buffr owns | warm pool, conversation id, tool wiring, both engines, `journalStore` | aptkit agent, both engines, adapters, connectors, memory |
| `RagQueryAgent` (@buffr/kernel) | the agent loop | per-turn reasoning, tool dispatch | model, tools (up to 7), trace |
| `InvestingEngine` (@buffr/engine-investing) | single-call domain engine | one `run()` — collect→analyze→score→teach in one pass | Collector, Analyzer, Scorer, Teacher |
| `MarketResearchEngine` (@buffr/engine-market-research) | two-call domain engine | `collect()` (evidence only) and `evaluate()` (analysis, needs a caller-supplied prediction) as two separately-invocable methods | same four capabilities, split across the two calls |
| `PgVectorStore` (buffr) | **adapter** behind `VectorStore` **port** | SQL for upsert + cosine search; `minScore` filter | `agents.chunks` |
| `SupabaseTraceSink` (buffr) | **adapter** behind `CapabilityTraceSink` **port** | turning events into rows | `agents.messages` |
| `PgJournalStore` (buffr) | **adapter** behind `JournalStore` **port** | create/listDue/snooze/resolve on `agents.decisions`, app_id-scoped | `agents.decisions` |
| `InMemoryJournalStore` (@buffr/kernel) | **adapter** behind `JournalStore` **port**, test double | same contract, in-process Map | nothing external — used only in tests |
| mutable-trace slots (session.ts) | per-ask callback injection | `currentOnStatus`, `currentOnTokens`; fires live TUI updates | `trace.emit()`, `<Spinner>`/`<ProgressPanel>` |
| `ProgressEvent` (engine → UI contract) | typed progress callback, not a port/adapter — a plain event union | engine-start / connector-start / connector-done / connector-failed / stage-start / stage-done | `onProgress` param threaded engine → session → flow → chat.tsx's `updateProgressSteps` |
| Connector tools (buffr) | `DataConnector<P,D>` adapters | RSS fetch, Amazon reviews, Google/Brave/Tavily/Reddit search, Google Trends | external HTTP APIs |
| `createConversationMemory` (@buffr/kernel) | episodic-memory engine | embed/tag/recall logic | injected `PgVectorStore` |
| Postgres `agents` schema | the only durable store | corpus, chunks, trajectories, profiles, decisions | `pg` driver |
| Ollama | local model server | weights + inference | HTTP localhost:11434 |
| Google CSE / Brave / Tavily / Reddit / Trends | discovery APIs (mostly key-gated) | live web/social index | HTTPS, free-tier quota or unauthenticated scraping |

**New since the last sync:** `packages/engines/market-research/` (`MarketResearchEngine`, split into `collect()`/`evaluate()`), `packages/domain-packs/market-research/` (4 dimensions: frequency, trend-velocity, specificity, monetizability), `packages/kernel/src/journal/` (`JournalStore` contract + `InMemoryJournalStore`), `src/pg-journal-store.ts` (`PgJournalStore`), `sql/002_decision_journal.sql` (`agents.decisions`), `src/cli/research-flow.ts` + `src/cli/review-flow.ts` (interactive multi-turn flows), a live `ProgressPanel` in `chat.tsx` fed by a new `ProgressEvent` contract, and a `principle`/`reflectionQuestion` pair added to `Teacher`'s output. → `07-capability-pipeline.md`, `08-domain-pack-and-engine.md`, `09-predict-then-reveal-loop.md`.

## The flows worth knowing (full walks in `audit.md` lens 2)

```
  1a. INDEX    index-cmd → indexDocumentRow(sourceType:'markdown')
              → documents row (source_type='markdown') + pipeline.index
              → embed chunks → PgVectorStore.upsert → agents.chunks

  1b. INDEX:DB index-db-cmd → DB_SOURCES (8 tables: loopd.entries/todo_meta/
              nutrition/vlogs/habits; contrl.exercises/sessions/week_progress)
              → pool.query per source → sanitize() → indexDocumentRow(sourceType:'db')
              → documents row (source_type='db') + pipeline.index → agents.chunks

  2. ASK     chat.tsx → session.ask(q, {onStatus, onTokens, onComplete})
             → set mutable slots → persist user msg
             → agent.answer (loop:
                 model → search_knowledge_base (minScore:0.65)
                      → onStatus("searching knowledge base")
                 model → web_search_google/brave/tavily OR fetch_rss_feed
                      → onStatus("searching Google" / etc.)
                      → onTokens({input, output}) on model_usage events
                 model → final synthesised answer)
             → clear slots → trace.flush (all events → agents.messages)
             → onComplete(TurnStats) → memory.remember

  3. EVAL    eval-cmd → pipeline.query per labeled question
             → scorePrecisionAtK / scoreRecallAtK → print the numbers

  4. ANALYZE chat.tsx /investing <TICKER>
             → session.analyze(ticker, entityType)
             → InvestingEngine.run():
                 Collector (concurrent web fetches via Brave/Tavily)
                 → Analyzer (LLM tool-calling, COMPANY/ETF_DIMENSIONS)
                 → Scorer   (pure math, COMPANY/ETF_SCORECARD)
                 → Teacher  (LLM single-shot, 'individual investor')
             → formatAnalysis() → display as buffr turn

  5. EVAL:INVESTING  chat.tsx /eval investing
             → session.evalInvesting()
             → load company-fixtures.json + etf-fixtures.json
             → Scorer.execute per fixture → assert |actual-expected| ≤ 0.01
             → render pass/fail table as buffr turn

  6. RESEARCH  chat.tsx /research <topic>  →  createResearchFlow(session, topic, cb)
             step=prediction:
               controller.start() → session.researchCollect(topic)
                 → MarketResearchEngine.collect(): Collector only, per-source
                   Promise.all (NO Analyzer/Teacher call) → CollectedResearch
                   {evidence, digest{totalCount, sources[]}} — progress events
                   stream connector-start/done/failed to the ProgressPanel
               → show digest (titles only) + PREDICTION_PROMPT, no score yet
             user replies "<score> <dimension> <confidence>" → parsePrediction()
             step=promote:
               controller.submit() → session.researchEvaluate(collected, prediction)
                 → MarketResearchEngine.evaluate(): Analyzer → Scorer → Teacher
                   → compares scorerResult.totalScore against the STORED prediction
                   (comparison computed in code, never re-asked of the model)
               → formatReveal(): your call vs buffr's score, dimension match,
                 principle, reflection question
             user replies discard / hypothesis / decision:
               discard  → nothing saved
               hypothesis → session.saveHypothesis() → JournalStore.create(kind:'hypothesis')
               decision   → step=stake → step=resolution → step=review-date
                          → session.saveDecision() → JournalStore.create(kind:'decision',
                            prediction, assessment, stake, resolutionCondition, reviewAt)
             → 09-predict-then-reveal-loop.md for the full walk

  7. EVAL:RESEARCH  chat.tsx /eval research
             → session.evalResearch() → same Scorer-fixture pattern as flow 5,
               against MARKET_RESEARCH_SCORECARD

  8. REVIEW  chat.tsx /review  →  createReviewFlow(session)
             controller.start() → session.listDueReviews()
               → JournalStore.listDue(): flips status open→review-due for any
                 decision whose review_at <= now, as a SIDE EFFECT of listing,
                 then returns the review-due set, oldest review_at first
             for each due decision, one at a time:
               keep    → advance to next, status stays review-due
               snooze  → parseDayCountOrDate() → session.snoozeReview()
                         → JournalStore.snooze(): status back to 'open', new review_at
               resolve → disposition (successful/unsuccessful/inconclusive) → note
                         → session.resolveReview() → JournalStore.resolve():
                           status='resolved', disposition+note+resolved_at recorded
             → 09-predict-then-reveal-loop.md for the full walk
```

## What this system is NOT (the deferred body)

Stated up front so no lens invents it: there is **no phone, no laptop↔phone sync, no HTTP/Edge
Function API, no RLS, no fine-tuning, no horizontal scale, no caching tier beyond the in-process
connector/embedding caches, no queue, and no multi-user journal** (`userId`/`workspaceId` on
every `JournalEntry` are both hard-coded to `cfg.appId` — the columns exist, nothing populates
them independently yet). Every one of those is named-and-deferred in the design specs, not
missing by accident. The audit calls each `not yet exercised` against real evidence.
