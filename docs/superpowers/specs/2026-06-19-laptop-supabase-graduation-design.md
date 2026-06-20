# Laptop Brain → Supabase Graduation — Design Spec

**Date:** 2026-06-19
**Status:** Design — approved to capture, implementation not started
**Repo:** **buffr** (this is the *body*; it depends on aptkit as a library, which stays untouched)
**Parent:** `docs/superpowers/specs/2026-06-19-aptkit-packages-design.md` (the aptkit packages A–E)
**Predecessor plan:** `docs/superpowers/plans/2026-06-19-laptop-build.md` (built the in-memory laptop brain)
**Reader profile:** `aipe/specs/me.md`

---

## What this is

Graduate the laptop brain from an **in-memory** RAG pipeline to a **persistent Supabase**
one — single device, no phone, no sync, no multi-app HTTP API yet. The in-memory toy
becomes a real brain that remembers its corpus and its conversations across runs.

This is **v1b** of the deferred body: the smallest persistent step. It is built entirely
in **buffr** and consumes aptkit as a dependency. aptkit already shipped the seams
(`VectorStore` / `EmbeddingProvider` contracts, `RagQueryAgent`, the Gemma provider, the
evals); buffr fills them with a Supabase-backed implementation.

## Decisions locked (from brainstorming)

| Decision | Choice | Why |
| --- | --- | --- |
| Build target | **buffr** (aptkit untouched) | repo-split: aptkit = deployment-agnostic toolkit, buffr = the body |
| Access path | **direct `pg` now**, Edge Functions later | single device has one client; HTTP API is YAGNI until phone/app #2 |
| Schema shape | **forward-compat columns, no RLS** | `app_id`/`user_id`/`embedding_model` are cheap now, painful to retrofit; RLS unneeded for one user |
| Scope | single-device persistence only | phone, sync, gateway, fine-tune stay deferred |
| Database | **existing `reindb`** (not a new project) | already hosts per-app schemas; reuse it |
| Schema home | **shared `agents` schema**, `app_id`-keyed | centralized agent layer (many apps); the agent service is its own "app" schema, existing per-app schemas untouched |

## Architecture & boundaries

```
  buffr laptop runtime  (new — wires aptkit packages)
    │  GemmaModelProvider (guarded)  ← aptkit A
    │  RagQueryAgent                 ← aptkit E
    │  OllamaEmbeddingProvider       ← aptkit B
    │  PgVectorStore (NEW, buffr)    ← implements aptkit's VectorStore
    │  SupabaseTraceSink (NEW, buffr)← implements aptkit's CapabilityTraceSink
    ▼  node-postgres (pg)
  reindb (Supabase Postgres)  —  NEW schema: agents  (pgvector + HNSW)
    documents · chunks · conversations · messages · profiles   (keyed by app_id)
    [ existing app_* schemas untouched ]
```

- **aptkit** — no changes. Provides the contracts and the agent; buffr imports them.
- **buffr (new code):** `PgVectorStore`, the `agents` schema + migrations, `SupabaseTraceSink`,
  the `index` / `ask` / `eval` CLI.
- **Supabase** — one project, `agents` schema, `pgvector` extension enabled.

## Connection approach — `pg` + SQL (direct)

The laptop runtime talks to Postgres with **node-postgres (`pg`)**. Vector search is a
cosine query — `ORDER BY embedding <=> $1 LIMIT k` — optionally wrapped in a
`agents.search_chunks(query_embedding, match_count, app)` SQL function. No PostgREST, no
Edge Functions.

**Deferred (named, not built):** a supabase-js / Edge Function HTTP layer. It arrives in the
multi-app / phone phase, wrapping the same SQL. Building it now would add PostgREST
indirection and latency for the only client that exists.

## Supabase schema — `agents` (forward-compat, no RLS)

A **new `agents` schema in the existing `reindb` database** (which already holds per-app
schemas like `app_buffr`, left untouched). The agent layer is its own "app" — this schema
is pointed to the agent service, and `app_id` distinguishes consumers
(`laptop` / `buffr` / `blooming` / `contrl`). For this phase there is one writer
(`app_id = 'laptop'`); the column exists so adding apps later needs no migration.

```sql
create extension if not exists vector;
create schema if not exists agents;

create table agents.documents (
  id text primary key,                  -- aptkit's source doc id, e.g. 'notes/work'
  app_id text not null default 'laptop',
  source_type text not null,            -- 'markdown' | ...
  source_path text,
  content text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table agents.chunks (
  id text primary key,                  -- "<doc>#<index>" (matches aptkit chunk ids)
  document_id text references agents.documents(id) on delete cascade,
  app_id text not null default 'laptop',
  chunk_index int not null,
  content text not null,
  embedding vector(768) not null,
  embedding_model text not null default 'nomic-embed-text:v1.5',
  meta jsonb not null default '{}'
);
create index on agents.chunks using hnsw (embedding vector_cosine_ops);

create table agents.conversations (
  id uuid primary key default gen_random_uuid(),
  app_id text not null default 'laptop',
  user_id text,
  agent_name text not null default 'rag-query-agent',
  created_at timestamptz not null default now()
);

create table agents.messages (                -- trajectories (Hermes MLOps idea)
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references agents.conversations(id) on delete cascade,
  role text not null,                   -- 'user' | 'assistant' | 'tool'
  content text not null default '',
  tool_calls jsonb,
  tool_results jsonb,
  model text,
  tokens_used int,
  created_at timestamptz not null default now()
);

create table agents.profiles (                -- me.md as a row
  id uuid primary key default gen_random_uuid(),
  app_id text not null default 'laptop',
  user_id text,
  content text not null,
  updated_at timestamptz not null default now()
);
```

`app_id` defaults `'laptop'`; `user_id` nullable; `embedding_model` carried for the
swap-embedder one-way door. **No RLS policies** — added when a second tenant (phone/app)
appears. **`agents.tool_runs` (cache) is deferred** — YAGNI for a single device.

## PgVectorStore (buffr)

Implements aptkit's `VectorStore` exactly, so it drops into `createRetrievalPipeline` with
zero agent changes:

```ts
class PgVectorStore implements VectorStore {
  readonly dimension = 768;
  constructor(opts: { pool: Pool; appId?: string; embeddingModel?: string });
  upsert(chunks): Promise<void>;   // INSERT ... ON CONFLICT (id) DO UPDATE
  search(vector, k): Promise<{ id; score; meta }[]>;  // cosine; score = 1 - distance
}
```

- A vector whose length ≠ `dimension` throws (same loud failure as `InMemoryVectorStore`).
- `search` reconstructs each hit's `meta` to the in-memory shape (`docId`, `chunkIndex`,
  `text` = the row's `content`) so the `search_knowledge_base` tool's citations work
  unchanged across stores.
- `upsert` resolves `document_id` from `meta.docId` (aptkit's deterministic ids). The
  `index` CLI writes the `agents.documents` row first; `pipeline.index` then populates
  `chunks` — the `documents` source-of-truth row is the CLI's job, not the store's.
- **Reindex is first-class**: a `reindex(embedder)` operation re-embeds the corpus when
  `embedding_model` changes — the dimension/model one-way door, named not hidden.

## Persistence (buffr)

- **`SupabaseTraceSink implements CapabilityTraceSink`** — on `step` (assistant) and
  `tool_call_end` events, append rows to `agents.messages`; create the `agents.conversations`
  row at session start. Trajectory capture from day one, no aptkit change (`RagQueryAgent`
  already accepts a `trace`).
- **Profile**: read `agents.profiles.content` → `injectProfile` into the system prompt.

## Laptop CLI (buffr)

- `index <path>` — read markdown files → `indexDocument` over `PgVectorStore`.
- `ask <question>` — build `RagQueryAgent` (guarded Gemma + retrieval over pg + profile +
  `SupabaseTraceSink`); print the answer; persist the conversation.
- `eval` — precision@k / recall@k over a labeled set against the pg corpus (reuses aptkit
  evals; the same ruler the in-memory `eval` script used).

## Testing strategy

PgVectorStore needs real Postgres + pgvector, so integration tests are **gated behind a
`DATABASE_URL` env** and skip when it is absent (no flaky cloud dependency in the default
run). Locally they run against **`supabase start`** (or a `pgvector` Docker container).

- **Contract parity:** the same round-trip `InMemoryVectorStore` passes — embed → upsert →
  search returns the planted chunk on top; dimension mismatch throws — now against pg.
- **Persistence:** after an agent run, assert `agents.messages` / `agents.conversations`
  rows exist with the expected roles.
- **Pure helpers** (SQL building, score mapping) get plain `node:test` unit tests with no DB.

## Out of scope (deferred — later phases)

Edge Functions / HTTP API · RLS policies · `agents.tool_runs` cache · the phone (RN,
on-device model) · laptop↔phone memory sync · the multi-platform gateway · trajectory →
fine-tune. Graduating to any of these reuses this schema and the `VectorStore` contract — no
rework.

## Open questions (settle before implementation)

- **RLS-later checkpoint:** the shared `agents` schema relies on `app_id` for isolation;
  with RLS deferred, that isolation is by convention only until app #2. Adding RLS +
  always-derive-`app_id`-from-token is a hard prerequisite before a second app writes.
- **HNSW build params** (`m`, `ef_construction`) — defaults are fine for a small corpus;
  revisit past ~10k chunks (parent plan's batch-reindex threshold).

## Done means

`index` loads a real markdown corpus into Supabase pgvector; `ask` answers from it with
citations in the profile voice and persists the conversation to `agents.messages`; `eval`
reports precision@k against the pg corpus; integration tests pass against local Supabase.
The in-memory brain is now a persistent single-device brain, with every phone/sync/gateway
decision still open.
