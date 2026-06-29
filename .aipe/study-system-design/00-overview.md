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
  │  src/cli/chat.tsx — Ink (React-in-terminal) chat                       │
  │    one input box, a scrollback of turns, a "thinking…" spinner         │
  └───────────────────────────────┬───────────────────────────────────────┘
                                  │  session.ask(question)  — in-process call
                                  ▼
  ┌─ Session layer (buffr owns) ──────────────────────────────────────────┐
  │  src/session.ts — createChatSession()                                  │
  │    • ONE warm pg.Pool          • ONE conversationId across all turns   │
  │    • agent built ONCE          • per-turn: persist → answer → remember │
  └───────┬─────────────────┬───────────────────┬─────────────────────────┘
          │                 │                   │
          │ builds once     │ run per turn      │ remember per turn
          ▼                 ▼                   ▼
  ┌─ aptkit-core (library — never edited here) ───────────────────────────┐
  │  RagQueryAgent.answer()      run-agent-loop, ReAct-style               │
  │    GemmaModelProvider ─ guarded by ContextWindowGuardedProvider(8192)  │
  │    createRetrievalPipeline ─ OllamaEmbeddingProvider + VectorStore     │
  │    createSearchKnowledgeBaseTool ─ the one tool the agent can call     │
  │    createConversationMemory ─ embed+tag+recall episodic memory engine  │
  └───────┬───────────────────────────────────┬──────────────┬────────────┘
          │ store port (VectorStore)           │ trace port   │ uses same store
          ▼                                    ▼              ▼
  ┌─ Adapter layer (buffr owns) ──────────────────────────────────────────┐
  │  PgVectorStore         SupabaseTraceSink        (memory injects the    │
  │  implements VectorStore implements              same PgVectorStore)    │
  │  src/pg-vector-store.ts CapabilityTraceSink                            │
  │                         src/supabase-trace-sink.ts                     │
  └───────────────────────────────┬───────────────────────────────────────┘
                                  │  node-postgres (pg), direct TCP — no HTTP layer
                                  ▼
  ┌─ Storage layer (Postgres `reindb`, schema `agents`) ──────────────────┐
  │  documents   source-of-truth corpus rows                              │
  │  chunks      embedding vector(768), HNSW cosine index, app_id index   │
  │              ↑ conversation memory ALSO lives here (meta.kind=memory)  │
  │  conversations / messages   full-signal trajectory (6 event types)    │
  │  profiles    the me.md-style user profile injected into the prompt    │
  └───────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │  HTTP (localhost:11434)
  ┌─ Provider layer (Ollama, local box) ──────────────────────────────────┐
  │  gemma2:9b — generation        nomic-embed-text:v1.5 — embeddings 768d │
  └───────────────────────────────────────────────────────────────────────┘
```

## Legend — what each component is, owns, and talks to

| Component | What it is | What it owns | Talks to |
|---|---|---|---|
| `chat.tsx` | Ink TUI, the only interface | screen state (turns, input, busy) | `session.ask()` |
| `session.ts` | the orchestrator buffr owns | the warm pool, the one conversation id, the wiring | aptkit agent, both adapters, memory |
| `RagQueryAgent` (aptkit) | the agent loop | the per-turn reasoning, tool dispatch | model, tools, trace |
| `GemmaModelProvider` (aptkit) | the model port impl | Ollama wire format mapping | Ollama `/api/chat` |
| `PgVectorStore` (buffr) | the **adapter** behind the `VectorStore` **port** | the SQL for upsert + cosine search | `agents.chunks` |
| `SupabaseTraceSink` (buffr) | the **adapter** behind the `CapabilityTraceSink` **port** | turning events into rows | `agents.messages` |
| `createConversationMemory` (aptkit) | the episodic-memory engine | embed/tag/recall logic | injected `PgVectorStore` |
| Postgres `agents` schema | the only durable store | all corpus, chunks, trajectories, profiles | `pg` driver |
| Ollama | the local model server | weights + inference | hit over HTTP |

## The three flows worth knowing (full walks in `audit.md` lens 2)

```
  1. INDEX   index-cmd → indexDocumentRow → documents row + pipeline.index
             → embed chunks → PgVectorStore.upsert → agents.chunks

  2. ASK     chat.tsx → session.ask → persist user msg
             → agent.answer (loop: model → search_knowledge_base tool → model)
             → trace.flush (all events → agents.messages) → memory.remember

  3. EVAL    eval-cmd → pipeline.query per labeled question
             → scorePrecisionAtK / scoreRecallAtK → print the numbers
```

## What this system is NOT (the deferred body)

Stated up front so no lens invents it: there is **no phone, no laptop↔phone sync, no HTTP/Edge
Function API, no RLS, no fine-tuning, no horizontal scale, no caching tier, no queue**. Every
one of those is named-and-deferred in the design specs, not missing by accident. The audit
calls each `not yet exercised` against real evidence.
