# Project Context — buffr-laptop

> Placeholder scaffolded by `/aipe:study`. Edit for accuracy, then re-run.

## What this is

`buffr-laptop` — the laptop "brain" of a self-hosted personal RAG agent. It graduates an
in-memory RAG pipeline to **persistent Supabase pgvector** (database `reindb`, schema
`agents`), single-device. It consumes the **aptkit** toolkit as a library and adds the
persistence + an **interactive chat CLI**. The sole interface is `npm run chat` — a
long-lived Ink (React-in-terminal) session that holds one conversation in-process; the old
one-shot `npm run ask` was removed.

Design docs live in `docs/superpowers/specs/` and `docs/superpowers/plans/`; the parent
vision is `agent-layer-plan.md`.

## Stack

- **Language/runtime:** TypeScript, ESM (`"type": "module"`), `module`/`moduleResolution`
  = `NodeNext`. Node ≥ 20.
- **AI toolkit:** `@rlynjb/aptkit-core` (^0.4.1) — the published aptkit bundle (model
  provider contract, runtime agent loop, retrieval pipeline, tools, evals, context, and
  `@aptkit/memory`). The conversation-memory engine (`createConversationMemory`) was
  extracted *up* from buffr into aptkit and is re-consumed via this bundle.
- **UI:** `@opentui/react` + `@opentui/core` for the chat TUI (OpenTUI — React reconciler over a Zig native renderer). Requires **Bun** as the runtime for the chat command (`npm run chat` invokes `bun dist/src/cli/chat.js`). React 19.2.8. Previously Ink; migrated to OpenTUI because Ink became inactive.
- **Database:** Postgres + `pgvector` (`pg` / node-postgres, direct connection — no Edge
  Functions this phase). HNSW cosine index.
- **Models:** Ollama-served — `gemma2:9b` (generation), `nomic-embed-text:v1.5` (embeddings,
  **768-dim**).
- **Tests:** `node:test` + `node:assert/strict`, `--test-concurrency=1`. DB-touching
  tests gate on `DATABASE_URL` and skip when unset.

## Data model (`agents` schema, `sql/001_agents_schema.sql`)

- `documents` — source-of-truth corpus rows (`id`, `app_id`, content, meta).
- `chunks` — `embedding vector(768)`, `document_id` as a **soft link** (the FK is
  deliberately dropped, to preserve `VectorStore` drop-in parity with aptkit's in-memory
  store), HNSW `vector_cosine_ops` index, `app_id` index. Chunk id = `"<docId>#<index>"`.
- `conversations` / `messages` — full-signal trajectory capture (all 6 `CapabilityEvent`
  types: step / tool_call_start / tool_call_end / model_usage / warning / error). `messages`
  columns `tool_calls`/`tool_results`/`model`/`tokens_used` are populated; `created_at` comes
  from the event timestamp (deterministic replay order).
- Conversation memory rides the `chunks` table tagged `meta.kind='memory'` (id
  `"memory:<conv>:<n>"`), written via `@aptkit/memory` — relevant past exchanges resurface
  through the same `search_knowledge_base` tool (retrieval-based episodic memory).
- `profiles` — the `me.md`-style user profile injected into the system prompt.
- Every table carries `app_id` (default `'laptop'`). **No RLS this phase.**

## File structure

- `src/config.ts` — pure `loadConfig(env)`; `src/db.ts` — pg `Pool` factory.
- `src/migrate.ts` — transactional SQL migration runner + CLI.
- `src/pg-vector-store.ts` — `PgVectorStore` implementing aptkit's `VectorStore` over pgvector.
- `src/runtime.ts` — `indexDocumentRow` (documents row + chunk indexing).
- `src/supabase-trace-sink.ts` — `CapabilityTraceSink` persisting full-signal trajectory.
- `src/profile.ts` — `loadProfile` from `agents.profiles`.
- `src/session.ts` — `createChatSession()`: warm pool + one conversation held across turns;
  builds the agent once; per-turn `ask()` persists, runs the agent, and remembers the exchange.
- `src/cli/chat.tsx` — the OpenTUI interactive chat UI (the interface). Uses `@opentui/react` JSX primitives (`<box>`, `<text>`, `<input>`), a custom `Spinner` component (braille frames + `setInterval`), and `process.exit(0)` on `/exit`/`/quit`. Run via `bun` (OpenTUI uses `bun:ffi` for its Zig core).
- `src/cli/{index,eval}-cmd.ts` — index corpus / score precision@k (one-shot CLIs).
- `test/` — mirrors `src/`; `sql/` — migrations; `eval/queries.json` — labeled eval set.

## Must-not-change constraints

- **aptkit is consumed, never edited here** — buffr only imports `@rlynjb/aptkit-core`.
- **Embedding dimension is 768** everywhere (`vector(768)`); a mismatch must throw, never
  silently truncate.
- Schema is `agents` in database `reindb`; `app_id` from `AGENT_APP_ID` (default
  `'laptop'`), schema from `AGENT_DB_SCHEMA` (default `'agents'`).
- Secrets live in `.env` (gitignored) — never committed.
- Chunk/document ids are aptkit's deterministic ids (`"<docId>#<index>"`, `docId`).
