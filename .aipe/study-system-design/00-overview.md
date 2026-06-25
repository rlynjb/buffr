# System Design — Overview (buffr-laptop)

One page. The whole system in one diagram, then a legend naming what each
box is, what it owns, and what it talks to. Skim only this file and you have
the map.

## The system in one frame

`buffr-laptop` is the **body** of a self-hosted RAG agent. It owns
persistence and the CLI; it consumes `@rlynjb/aptkit-core` (the **toolkit**)
for everything that is reusable — the model provider, the agent loop, the
retrieval pipeline, the search tool, the evals. One device, one user, one
Postgres. No HTTP API, no phone, no sync — those are named and deferred, not
forgotten.

```
  Full system — buffr-laptop, single device

  ┌─ CLI layer (buffr — entrypoints) ───────────────────────────────────┐
  │  index-cmd.ts      chat.tsx → session.ts   eval-cmd.ts               │
  │  load corpus       interactive chat        score retrieval (P@1/R@k) │
  │  (one-shot)        (long-lived session)    (one-shot)                │
  └────────┬───────────────┬───────────────────┬────────────────────────┘
           │               │                   │
  ┌─ Toolkit layer (@rlynjb/aptkit-core 0.4.1 — imported, never edited) ──┐
  │  createRetrievalPipeline   RagQueryAgent      scorePrecisionAtK      │
  │  OllamaEmbeddingProvider   GemmaModelProvider createSearchKB Tool    │
  │  ContextWindowGuardedProvider  InMemoryToolRegistry                  │
  │  createConversationMemory (engine; bundles @aptkit/memory)          │
  └────────┬───────────────┬───────────────────┬────────────────────────┘
           │ implements     │ uses             │ implements
           │ VectorStore    │ ModelProvider    │ CapabilityTraceSink
  ┌─ Adapter layer (buffr — fills aptkit's seams) ──────────────────────┐
  │  PgVectorStore         SupabaseTraceSink     loadProfile / runtime  │
  └────────┬─────────────────────────┬───────────────────┬─────────────┘
           │ pg (node-postgres)      │ pg                 │ pg
  ┌─ Storage layer (reindb · Postgres + pgvector · schema `agents`) ─────┐
  │  documents   chunks(vector 768, HNSW)   conversations   messages     │
  │  profiles                              [ all rows keyed by app_id ]   │
  └─────────────────────────────────────────────────────────────────────┘
           ▲                                                  ▲
  ┌─ Provider layer (Ollama, localhost:11434) ──────────────────────────┐
  │  nomic-embed-text:v1.5 (768-dim embeddings)   gemma2:9b (generation) │
  └─────────────────────────────────────────────────────────────────────┘
```

## Legend — what each box owns and talks to

**CLI layer** (`src/cli/*` + `src/session.ts`, buffr) — the entrypoints, in
two shapes. The one-shots (`index`, `eval`, `migrate`) load `.env`, build the
wiring (pool → embedder → store → pipeline), do one job, and exit. `chat`
(`chat.tsx` → `createChatSession`) is long-lived: it wires once and holds ONE
warm pool and ONE conversation across every turn until `/exit`. (The old
one-shot `ask` CLI is removed.) No long-running server — a process per
invocation, or one held session.
→ deep walk: `05-cli-as-entrypoints.md`

**Toolkit layer** (`@rlynjb/aptkit-core@0.4.1`) — everything reusable across
apps. The agent loop, the model/embedding provider contracts, the retrieval
pipeline, the `search_knowledge_base` tool, the eval scorers, and now the
conversation-memory engine (`createConversationMemory`, bundling
`@aptkit/memory`). buffr imports these and **never edits them** — the
dependency direction is the architecture. The memory engine is itself a
round-trip: extracted UP from buffr, re-consumed DOWN with `PgVectorStore`
injected. → deep walk: `04-library-as-dependency-boundary.md`

**Adapter layer** (buffr) — the code that fills aptkit's seams with a
Postgres-backed implementation. `PgVectorStore` implements aptkit's
`VectorStore`; `SupabaseTraceSink` implements `CapabilityTraceSink`;
`runtime.ts` writes the `documents` source-of-truth row; `profile.ts` reads
the system-prompt profile. This layer is the load-bearing buffr code.
→ deep walks: `01-vector-store-adapter.md`, `03-trajectory-capture.md`,
`06-profile-injection-as-context.md`

**Storage layer** (`reindb`, Postgres + pgvector, schema `agents`) — the
single source of truth for corpus, embeddings, and conversation history.
`chunks.embedding` is `vector(768)` with an HNSW cosine index. Every row
carries `app_id` (default `'laptop'`) for a multi-tenant future that has one
tenant today. No RLS this phase.
→ deep walk: `02-retrieval-pipeline.md`; schema shape → cross-link
`study-data-modeling`; engine internals → cross-link
`study-database-systems`.

**Provider layer** (Ollama, `localhost:11434`) — the two models, served
locally. `nomic-embed-text:v1.5` turns text into 768-dim vectors;
`gemma2:9b` generates answers. No network leaves the laptop. The dimension
(768) is a one-way door wired end to end.

## The one tradeoff that shapes everything

Direct `pg` now, Edge Functions later. There is exactly one client (this
laptop), so an HTTP API in front of Postgres would add PostgREST indirection
and latency for nobody. The schema already carries the columns
(`app_id`, `user_id`, `embedding_model`) that the deferred phone/multi-app
future needs — cheap to add now, painful to retrofit. The whole "what
changes at 10x" story is **deliberately deferred**, named in the design
doc, and re-uses this exact schema and the `VectorStore` contract with no
rework. → deep walk: `07-deferred-body.md`

## Reading order

1. `00-overview.md` — you are here.
2. `audit.md` — the 8-lens system-design audit, grounded in `file:line`.
3. `01-vector-store-adapter.md` — the seam that makes pg drop in.
4. `02-retrieval-pipeline.md` — index and query, end to end.
5. `03-trajectory-capture.md` — sync emit, async flush, conversation rows.
6. `04-library-as-dependency-boundary.md` — aptkit consumed, never edited; the
   memory-engine round-trip.
7. `05-cli-as-entrypoints.md` — one-shot processes + the long-lived chat session.
8. `06-profile-injection-as-context.md` — me.md as a row in the prompt.
9. `07-deferred-body.md` — single-device now, two-brain/edge later.

## Cross-links to neighboring guides

- **`study-data-modeling`** — the shape of the `agents` schema: the
  `documents`/`chunks` split, the dropped FK, `app_id` denormalization,
  `vector(768)` as a typed column.
- **`study-database-systems`** — how pgvector executes `<=>` cosine
  distance, what HNSW does at the storage-engine level, transaction
  semantics of the `upsert` `begin/commit`.
- **`study-distributed-systems`** — the coordination mechanics that arrive
  in the deferred phases (RLS-as-isolation, edge function as a boundary,
  laptop↔phone sync).
- **`study-runtime-systems`** — how the per-invocation CLI process executes,
  the connection-pool lifecycle, the sync-emit/async-flush trace queue.
- **`study-ai-engineering`** / **`study-agent-architecture`** — the RAG
  pipeline, the ReAct-style agent loop inside `RagQueryAgent`, eval scoring.
- **`study-software-design`** — the deep-module / info-hiding read of the
  adapter layer (the seam contracts, the pure `loadConfig`).

---

Updated: 2026-06-24 — CLI layer reframed (one-shot `index`/`eval`/`migrate` +
long-lived `chat` session; `ask` removed); aptkit bumped to 0.4.1 (bundles
`@aptkit/memory`); added `createConversationMemory` engine + its round-trip to
the toolkit legend.
