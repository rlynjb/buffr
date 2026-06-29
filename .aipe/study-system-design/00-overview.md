# 00 — System Overview

One page, one diagram. Skim this and you have the whole map of buffr-laptop: every
component, what it owns, and what it talks to. Everything else in this guide zooms into
a box on this picture.

## The whole system

buffr-laptop is the **body** that wires aptkit's contracts to real persistence. aptkit
ships the brain parts (model provider, agent loop, retrieval pipeline, memory engine,
evals) as a library; buffr fills the seams with a Postgres-backed implementation and a
terminal interface. One device, one user, one process per `chat`.

```
  buffr-laptop — full system map

  ┌─ Interface layer (you) ──────────────────────────────────────────────┐
  │  npm run chat → Ink TUI (src/cli/chat.tsx)                            │
  │    React-in-terminal: input box, turn list, spinner                  │
  │    one process, one conversation, held across turns                  │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ session.ask(question)
  ┌─ Session layer (buffr) ───────▼──────────────────────────────────────┐
  │  createChatSession (src/session.ts)                                  │
  │    warm pg Pool · agent built ONCE · ONE conversationId · per-turn:  │
  │    persist user → agent.answer() → trace.flush() → memory.remember() │
  └──────┬──────────────┬───────────────┬───────────────┬────────────────┘
         │              │               │               │
  ┌──────▼─────┐ ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼─────────────────┐
  │ aptkit     │ │ aptkit      │ │ buffr       │ │ aptkit @aptkit/memory  │
  │ RagQuery   │ │ retrieval   │ │ Supabase    │ │ createConversation-    │
  │ Agent      │ │ pipeline    │ │ TraceSink   │ │ Memory                 │
  │ (loop +    │ │ (embed →    │ │ (Capability │ │ (remember/recall over  │
  │  Gemma)    │ │  search →   │ │  TraceSink) │ │  injected store)       │
  │            │ │  rank)      │ │             │ │                        │
  └──────┬─────┘ └──────┬──────┘ └──────┬──────┘ └──────┬─────────────────┘
         │ tool calls   │ store.search  │ INSERT msgs   │ store.upsert (kind=memory)
         │              │               │               │
  ┌──────▼──────────────▼───────────────▼───────────────▼────────────────┐
  │  buffr adapter layer                                                  │
  │    PgVectorStore (src/pg-vector-store.ts) — implements VectorStore   │
  │    profile.ts · runtime.ts · supabase-trace-sink.ts                  │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ node-postgres (pg Pool), direct SQL
  ┌─ Storage layer ───────────────▼──────────────────────────────────────┐
  │  Postgres reindb · schema `agents` · pgvector ext (HNSW cosine)      │
  │    documents · chunks (embedding vector(768)) · conversations ·      │
  │    messages · profiles      [ all keyed by app_id='laptop', no RLS ] │
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ Provider layer (external, local) ────────────────────────────────────┐
  │  Ollama @ http://localhost:11434                                      │
  │    gemma2:9b (generation)   ·   nomic-embed-text:v1.5 (768-dim embed) │
  └───────────────────────────────────────────────────────────────────────┘
```

## Legend — what each component is, owns, and talks to

| Component | What it is | Owns | Talks to |
| --- | --- | --- | --- |
| **Ink TUI** (`src/cli/chat.tsx`) | React-in-terminal chat UI, the only interface | ephemeral render state (turns, input, busy) | `session.ask` / `session.close` |
| **ChatSession** (`src/session.ts`) | long-lived orchestrator built once at startup | the warm `pg.Pool`, the single `conversationId`, the wired agent | aptkit agent, pipeline, memory; buffr trace sink |
| **RagQueryAgent** (aptkit) | the bounded agent loop + guarded Gemma | the reasoning loop, tool dispatch | Gemma (Ollama), `search_knowledge_base` tool, trace sink |
| **Retrieval pipeline** (aptkit) | embed → search → rank | nothing persistent; pure pipeline over injected store | embedder (Ollama), `PgVectorStore` |
| **PgVectorStore** (`src/pg-vector-store.ts`) | buffr's `VectorStore` adapter over pgvector | the SQL for chunk upsert + cosine search, the 768-dim guard | `pg.Pool`, `agents.chunks` |
| **SupabaseTraceSink** (`src/supabase-trace-sink.ts`) | `CapabilityTraceSink` impl, full-signal | the queue of pending message inserts | `agents.messages` via `persistMessage` |
| **ConversationMemory** (aptkit `@aptkit/memory`) | episodic memory engine, store-injected | embedding + tagging + recall logic; never names a DB | the *same* `PgVectorStore` (rows tagged `kind=memory`) |
| **Postgres `reindb` / `agents`** | the single source of truth | the corpus, the vectors, the trajectory, the profile | every buffr adapter via `pg` |
| **Ollama** | local model server | the weights; nothing buffr owns | embedder + Gemma provider over HTTP localhost |

## The one thing to notice first

There is **no network in the architecture except localhost Ollama and the pg connection
to one Postgres instance.** No HTTP API, no Edge Functions, no load balancer, no queue,
no second service. This is deliberate (`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md:54`
— "direct `pg` now, Edge Functions later"). The whole system fits in one process plus
one database plus one model server. That single-device shape is what makes most of the
classic system-design lenses read `not yet exercised` — and the audit names that
honestly rather than inventing scale that isn't there.

## See also

- `audit.md` — the 8-lens walk with each `not yet exercised` named
- `02-library-as-dependency-boundary.md` — the aptkit seam this whole map hangs on
- `04-long-lived-chat-session.md` — the deep walk of the session orchestrator
