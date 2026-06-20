# Study — Data Modeling · buffr-laptop

The through-line for this guide is one question, asked of every table and
every query in the repo:

> **Does the data's shape match how it's actually read and written — and can
> it stay correct under live data?**

The data model is the most expensive thing to get wrong. Code is cheap to
change; a schema with rows in it is not. Migrations are that
change-amplification made physical. So this guide audits `agents` schema
(`sql/001_agents_schema.sql`) against the code that writes and queries it
(`src/pg-vector-store.ts`, `src/runtime.ts`, `src/supabase-trace-sink.ts`,
`src/profile.ts`).

## The schema, in one frame

The whole persistent model — five tables, one schema, one Postgres
instance (`reindb`).

```
  agents schema (Postgres + pgvector) — the whole persistent model

  ┌─────────────── documents ───────────────┐
  │ id            text  PK                   │  source-of-truth corpus
  │ app_id        text  not null 'laptop'    │
  │ source_type   text  not null            │
  │ source_path   text                       │
  │ content       text  not null            │  ← the full doc text
  │ meta          jsonb not null '{}'        │
  │ created_at    timestamptz now()          │
  └──────────────────┬───────────────────────┘
                     ╎  document_id   (SOFT link, no FK — see 06)
                     ╎  "<docId>#<index>" naming
  ┌──────────────────▼─── chunks ────────────┐
  │ id            text  PK  "<docId>#<idx>"  │  one row per embedded chunk
  │ document_id   text      (nullable, no FK)│
  │ app_id        text  not null 'laptop'    │
  │ chunk_index   int   not null            │
  │ content       text  not null            │  ← chunk text (ALSO in meta)
  │ embedding     vector(768) not null      │  ← HNSW vector_cosine_ops
  │ embedding_model text not null           │
  │ meta          jsonb not null '{}'        │  ← contains text AGAIN
  └──────────────────────────────────────────┘

  ┌──────────── conversations ──────────────┐
  │ id          uuid PK gen_random_uuid()   │  trajectory capture
  │ app_id      text 'laptop'               │
  │ user_id     text                         │
  │ agent_name  text 'rag-query-agent'      │
  │ created_at  timestamptz now()           │
  └──────────────────┬───────────────────────┘
                     │  conversation_id  FK ──► ON DELETE CASCADE
  ┌──────────────────▼─── messages ──────────┐
  │ id              uuid PK                  │  one row per turn
  │ conversation_id uuid  FK (CASCADE)       │  ← the ONLY hard FK in schema
  │ role            text not null            │
  │ content         text not null ''         │
  │ tool_calls      jsonb                     │
  │ tool_results    jsonb                     │
  │ model           text                      │
  │ tokens_used     int                       │
  │ created_at      timestamptz now()         │
  └──────────────────────────────────────────┘

  ┌──────────────── profiles ───────────────┐
  │ id        uuid PK gen_random_uuid()     │  me.md-style user profile
  │ app_id    text 'laptop'                  │  read latest-by-updated_at
  │ user_id   text                            │
  │ content   text not null                   │
  │ updated_at timestamptz now()             │
  └──────────────────────────────────────────┘
```

## The two partition seams

This guide owns the **shape** of persistent data. Two neighbours own the
rest — when a finding crosses one of these seams, it goes there, not here.

- **vs `study-system-design`** — "use Postgres, one instance, no read
  replica, `app_id` instead of sharding" is *architecture* → that guide.
  "`chunks` stores text twice / this query has no covering index" is *shape*
  → here.
- **vs `study-dsa-foundations`** — the HNSW graph as an in-memory traversal
  structure is DSA. The `vector(768)` column and its on-disk ANN index is
  data modeling → here.
- **vs `study-software-design`** — normalization is information-hiding for
  data (one fact, one place). The text-stored-twice finding (02) is the DB
  analog of information leakage; it cross-links there, doesn't re-teach it.

## Reading order

1. **`audit.md`** — Pass 1. Every data-modeling lens walked against the real
   schema and queries, worst-first, with `file:line` or `not yet exercised`.
2. **`00-overview.md`** — one-page orientation: what's interesting here.
3. Pattern files (Pass 2) — the patterns this repo actually exercises:
   - `01-vector-column-and-ann-index.md` — `vector(768)` + HNSW cosine
   - `02-text-stored-twice.md` — `content` AND `meta.text`, the redundancy
   - `03-deterministic-chunk-ids.md` — `"<docId>#<index>"` as the upsert key
   - `04-soft-link-no-fk.md` — `document_id` without referential integrity
   - `05-app-id-tenant-column.md` — multi-tenant in shape only, no RLS
   - `06-trajectory-tables.md` — conversations/messages, the one real FK

## Cross-links

- `study-database-systems` — HNSW internals, MVCC, the `<=>` operator's
  execution, transaction mechanics behind `begin/commit`.
- `study-security` — `app_id` is a tenant column with no RLS and no
  token-derivation; the trust-boundary analysis lives there.
- `study-system-design` — single-instance Postgres, no replication/sharding,
  why `app_id` is a future seam not a current one.
