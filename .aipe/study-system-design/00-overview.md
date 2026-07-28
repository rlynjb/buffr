# 00 — System Overview

One page. One diagram. The whole of `buffr-laptop` on a single map, every box labelled with
what it is, what it owns, and what it talks to. Skim only this file and you have the system.

## The whole system, one frame

The thing to hold in your head: buffr is a thin **body** wrapped around a thick **library**.
Everything labelled "aptkit" is consumed, never edited here. Everything labelled "buffr"
is the ~10 files this repo actually owns. The seam between them is the most important line
on the diagram.

```
  buffr-laptop — the full system (single device, one user)

  ┌─ UI layer ───────────────────────────────────────────────────────────┐
  │  src/cli/chat.tsx — OpenTUI (React-in-terminal) chat                 │
  │    spinner: tool name · elapsed time · live token count              │
  └───────────────────────────────┬───────────────────────────────────────┘
                                  │  session.ask(q, {onStatus, onTokens, onComplete})
                                  ▼
  ┌─ Session layer (buffr owns) ──────────────────────────────────────────┐
  │  src/session.ts — createChatSession()                                  │
  │    • ONE warm pg.Pool          • ONE conversationId across all turns   │
  │    • agent built ONCE          • per-turn: slots → persist → answer   │
  │    • mutable trace slots:        → clear slots → flush → remember     │
  │      currentOnStatus/Tokens   • TOOL_LABELS map → human status names  │
  └───────┬─────────────────┬───────────────────┬─────────────────────────┘
          │                 │                   │
          │ builds once     │ run per turn      │ remember per turn
          ▼                 ▼                   ▼
  ┌─ aptkit-core (library — never edited here) ───────────────────────────┐
  │  RagQueryAgent.answer()      run-agent-loop, ReAct-style               │
  │    GemmaModelProvider ─ guarded by ContextWindowGuardedProvider(8192)  │
  │    createRetrievalPipeline ─ OllamaEmbeddingProvider + VectorStore     │
  │    createSearchKnowledgeBaseTool(minTopK:4, minScore:0.65) ─ tool 1   │
  │    createConversationMemory ─ embed+tag+recall episodic memory engine  │
  └───────┬───────────────────────────────────┬──────────────┬────────────┘
          │ store port (VectorStore)           │ trace port   │ uses same store
          ▼                                    ▼              ▼
  ┌─ Adapter layer (buffr owns) ──────────────────────────────────────────┐
  │  PgVectorStore         SupabaseTraceSink + mutable-slot wrapper       │
  │  implements VectorStore implements CapabilityTraceSink                 │
  │  src/pg-vector-store.ts  src/supabase-trace-sink.ts + session.ts slots│
  │                                                                        │
  │  Connector tools (buffr/packages/connectors):                          │
  │    RssConnector         → fetch_rss_feed   (always active)            │
  │    AmazonReviewsConnector → fetch_amazon_reviews (always active)      │
  │    GoogleSearchConnector  → web_search_google  (key-gated)            │
  │    BraveSearchConnector   → web_search_brave   (key-gated)            │
  │    TavilySearchConnector  → web_search_tavily  (key-gated)            │
  └───────────────────────────────┬───────────────────────────────────────┘
                                  │  node-postgres (pg), direct TCP
                                  ▼
  ┌─ Storage layer (Postgres `reindb`, schema `agents`) ──────────────────┐
  │  documents · chunks(vector) · conversations · messages · profiles     │
  └───────────────────────────────────────────────────────────────────────┘
                  ▲ HTTP localhost:11434           ▲ HTTPS (external, key-gated)
  ┌─ Local Ollama ─────────────────┐  ┌─ Web Search APIs ────────────────┐
  │  gemma2:9b · nomic-embed-text  │  │  Google CSE · Brave · Tavily     │
  └────────────────────────────────┘  └──────────────────────────────────┘
```

## Legend — what each component is, owns, and talks to

| Component | What it is | What it owns | Talks to |
|---|---|---|---|
| `chat.tsx` | OpenTUI, the only interface | screen state (turns, busy, liveTokens); Spinner with elapsed + token count | `session.ask(q, {onStatus, onTokens, onComplete})` |
| `session.ts` | the orchestrator buffr owns | warm pool, conversation id, tool wiring, mutable-trace slots, `TOOL_LABELS` | aptkit agent, adapters, connectors, memory |
| `RagQueryAgent` (aptkit) | the agent loop | per-turn reasoning, tool dispatch | model, tools (6), trace |
| `GemmaModelProvider` (aptkit) | the model port impl | Ollama wire format mapping | Ollama `/api/chat` |
| `PgVectorStore` (buffr) | **adapter** behind `VectorStore` **port** | SQL for upsert + cosine search; `minScore` filter | `agents.chunks` |
| `SupabaseTraceSink` (buffr) | **adapter** behind `CapabilityTraceSink` **port** | turning events into rows | `agents.messages` |
| mutable-trace slots (session.ts) | per-ask callback injection | `currentOnStatus`, `currentOnTokens`; fires live TUI updates | `trace.emit()`, `<Spinner>` |
| Connector tools (buffr) | `DataConnector<P,D>` adapters | RSS fetch, Amazon reviews, Google/Brave/Tavily search | external HTTP APIs |
| `createConversationMemory` (aptkit) | episodic-memory engine | embed/tag/recall logic | injected `PgVectorStore` |
| Postgres `agents` schema | the only durable store | corpus, chunks, trajectories, profiles | `pg` driver |
| Ollama | local model server | weights + inference | HTTP localhost:11434 |
| Google CSE / Brave / Tavily | web search APIs (key-gated) | live web index | HTTPS, free-tier quota |

## The three flows worth knowing (full walks in `audit.md` lens 2)

```
  1. INDEX   index-cmd → indexDocumentRow → documents row + pipeline.index
             → embed chunks → PgVectorStore.upsert → agents.chunks

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
```

## What this system is NOT (the deferred body)

Stated up front so no lens invents it: there is **no phone, no laptop↔phone sync, no HTTP/Edge
Function API, no RLS, no fine-tuning, no horizontal scale, no caching tier, no queue**. Every
one of those is named-and-deferred in the design specs, not missing by accident. The audit
calls each `not yet exercised` against real evidence.
