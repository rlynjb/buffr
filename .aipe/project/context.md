# Project Context — buffr-laptop

> Placeholder scaffolded by `/aipe:study`. Edit for accuracy, then re-run.

## What this is

`buffr-laptop` — the laptop "brain" of a self-hosted personal RAG agent. It graduates an
in-memory RAG pipeline to **persistent Supabase pgvector** (database `reindb`, schema
`agents`), single-device. It consumes the **aptkit** toolkit as a library and adds the
persistence + CLI layer.

Design docs live in `docs/superpowers/specs/` and `docs/superpowers/plans/`; the parent
vision is `agent-layer-plan.md`.

## Stack

- **Language/runtime:** TypeScript, ESM (`"type": "module"`), `module`/`moduleResolution`
  = `NodeNext`. Node ≥ 20.
- **AI toolkit:** `@rlynjb/aptkit-core` (^0.4.0) — the published aptkit bundle (model
  provider contract, runtime agent loop, retrieval pipeline, tools, evals, context).
- **Database:** Postgres + `pgvector` (`pg` / node-postgres, direct connection — no Edge
  Functions this phase). HNSW cosine index.
- **Models:** Ollama-served — `gemma2:9b` (generation), `nomic-embed-text` (embeddings,
  **768-dim**).
- **Tests:** `node:test` + `node:assert/strict`, `--test-concurrency=1`. DB-touching
  tests gate on `DATABASE_URL` and skip when unset.

## Data model (`agents` schema, `sql/001_agents_schema.sql`)

- `documents` — source-of-truth corpus rows (`id`, `app_id`, content, meta).
- `chunks` — `embedding vector(768)`, `document_id` as a **soft link** (the FK is
  deliberately dropped, to preserve `VectorStore` drop-in parity with aptkit's in-memory
  store), HNSW `vector_cosine_ops` index, `app_id` index. Chunk id = `"<docId>#<index>"`.
- `conversations` / `messages` — trajectory capture (user/assistant/tool turns).
- `profiles` — the `me.md`-style user profile injected into the system prompt.
- Every table carries `app_id` (default `'laptop'`). **No RLS this phase.**

## File structure

- `src/config.ts` — pure `loadConfig(env)`; `src/db.ts` — pg `Pool` factory.
- `src/migrate.ts` — transactional SQL migration runner + CLI.
- `src/pg-vector-store.ts` — `PgVectorStore` implementing aptkit's `VectorStore` over pgvector.
- `src/runtime.ts` — `indexDocumentRow` (documents row + chunk indexing).
- `src/supabase-trace-sink.ts` — `CapabilityTraceSink` persisting conversations/messages.
- `src/profile.ts` — `loadProfile` from `agents.profiles`.
- `src/cli/{index,ask,eval}-cmd.ts` — index corpus / ask the agent / score precision@k.
- `test/` — mirrors `src/`; `sql/` — migrations; `eval/queries.json` — labeled eval set.

## Must-not-change constraints

- **aptkit is consumed, never edited here** — buffr only imports `@rlynjb/aptkit-core`.
- **Embedding dimension is 768** everywhere (`vector(768)`); a mismatch must throw, never
  silently truncate.
- Schema is `agents` in database `reindb`; `app_id` from `AGENT_APP_ID` (default
  `'laptop'`), schema from `AGENT_DB_SCHEMA` (default `'agents'`).
- Secrets live in `.env` (gitignored) — never committed.
- Chunk/document ids are aptkit's deterministic ids (`"<docId>#<index>"`, `docId`).
