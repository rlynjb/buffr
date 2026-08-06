# Project Context — buffr-laptop

> Placeholder scaffolded by `/aipe:study`. Edit for accuracy, then re-run.

## What this is

`buffr-laptop` — the laptop "brain" of a self-hosted personal RAG agent. It graduates an
in-memory RAG pipeline to **persistent Supabase pgvector** (database `reindb`, schema
`agents`), single-device. It consumes internal `@buffr/*` monorepo packages as libraries
and adds the persistence + an **interactive chat CLI**. The sole interface is `npm run chat`
— a long-lived OpenTUI (React-in-terminal) session that holds one conversation in-process;
the old one-shot `npm run ask` was removed. Beyond plain chat, the CLI now hosts two
domain-pack-driven research engines (`/investing`, `/research`) and a decision-journal loop
(`/review`) that tracks predictions made during `/research` through to a resolved outcome.

Design docs live in `docs/superpowers/specs/` and `docs/superpowers/plans/`; the parent
vision is `agent-layer-plan.md`.

## Stack

- **Language/runtime:** TypeScript, ESM (`"type": "module"`), `module`/`moduleResolution`
  = `NodeNext`. Node ≥ 20.
- **AI toolkit:** monorepo packages in `packages/` — `@buffr/contracts` (shared types, incl. `DomainPack`/`SourcePolicy`), `@buffr/kernel` (model provider contract, runtime agent loop, retrieval pipeline, tools, evals, context, memory engine, `journal/` — `JournalStore` contract + `InMemoryJournalStore`), `@buffr/connectors` (`DataConnector` interface + Google/Reddit/RSS/Amazon/search-trends connectors), `@buffr/capabilities` (typed computation units shared across engines — Collector, Analyzer, Scorer, Teacher, Journal), `@buffr/domain-pack-investing` and `@buffr/domain-pack-market-research` (per-domain dimensions/scorecards/prompts, under `packages/domain-packs/`), `@buffr/engine-investing` and `@buffr/engine-market-research` (per-domain pipelines composed from capabilities + a domain pack, under `packages/engines/`). These replaced `@rlynjb/aptkit-core`. Build order: contracts → kernel → connectors → capabilities → domain-packs → engines (`npm run build:packages`).
- **UI:** `@opentui/react` + `@opentui/core` for the chat TUI (OpenTUI — React reconciler over a Zig native renderer). Requires **Bun** as the runtime for the chat command (`npm run chat` invokes `bun dist/src/cli/chat.js`). React 19.2.8. Previously Ink; migrated to OpenTUI because Ink became inactive.
- **Database:** Postgres + `pgvector` (`pg` / node-postgres, direct connection — no Edge
  Functions this phase). HNSW cosine index.
- **Models:** Ollama-served — `gemma2:9b` (generation), `nomic-embed-text:v1.5` (embeddings,
  **768-dim**).
- **Tests:** `node:test` + `node:assert/strict`, `--test-concurrency=1`. DB-touching
  tests gate on `DATABASE_URL` and skip when unset.

## Data model (`agents` schema, `sql/001_agents_schema.sql`)

- `documents` — source-of-truth corpus rows (`id`, `app_id`, `source_type` ('markdown'|'db'), `source_path`, content, meta). `source_type` distinguishes markdown-indexed vs DB-indexed rows.
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
- `decisions` (`sql/002_decision_journal.sql`) — the decision journal: one row per promoted
  `/research` prediction. Carries both sides of the predict-then-reveal loop
  (`predicted_score`/`predicted_dimension`/`predicted_confidence` from the user,
  `assessed_score`/`assessed_confidence` from the engine), plus `stake`,
  `resolution_condition`, `review_at`, and a `status` lifecycle
  (`open` → `review-due` → `resolved`/`snoozed`). Written via `PgJournalStore`
  (`src/pg-journal-store.ts`), implementing the same `JournalStore` contract
  (`packages/kernel/src/journal/contracts.ts`) that `InMemoryJournalStore` implements for
  tests — the same adapter-behind-a-contract shape as `PgVectorStore`/`VectorStore`.
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
- `src/cli/chat.tsx` — the OpenTUI interactive chat UI. Uses `<textarea ref={taRef}>` (multiline input), `<scrollbox stickyScroll>`, `useKeyboard` hook; Enter=submit, Alt+Enter=newline. Role-coloured turns, `formatStats()` per-turn footer, a live per-step progress panel during `/research`/`/investing`, and connector-aware `/help`. Now also drives two interactive multi-turn flows (`research-flow.ts`, `review-flow.ts`) as an in-command state machine. Run via `bun`.
- `src/cli/research-flow.ts` — the `/research` interactive loop: predict (raw evidence, no analysis shown yet) → reveal (score/gap/principle/reflection) → promote to a tracked decision (stake, resolution condition, review date).
- `src/cli/review-flow.ts` — the `/review` loop: surfaces due decisions one at a time, each resolved via keep/snooze/resolve.
- `src/cli/parse-review-date.ts` — shared day-count-or-ISO-date parser used by both flows.
- `src/pg-journal-store.ts` — `PgJournalStore`, the Postgres adapter for the `JournalStore` contract (`agents.decisions`), scoped by `app_id`.
- `src/cli/{index,eval,index-db}-cmd.ts` — index markdown corpus / score precision@k / index 8 DB tables (one-shot CLIs).
- `src/db-sources.ts` — `DB_SOURCES: DbSource[]` — 8 tables across `loopd` (entries/todo_meta/nutrition/vlogs/habits) and `contrl` (exercises/sessions/week_progress) schemas. Each entry has `query`, `toId`, `toText`; used by `index-db-cmd`.
- `packages/` — monorepo: `@buffr/contracts`, `@buffr/kernel` (incl. `journal/`), `@buffr/connectors`, `@buffr/capabilities`, `packages/domain-packs/{investing,market-research}`, `packages/engines/{investing,market-research}`.
- `test/` — mirrors `src/`; `sql/` — migrations (`migrate.ts` now runs every migration file in order, not just one); `eval/queries.json` — labeled eval set.

## Must-not-change constraints

- **monorepo packages are consumed, not edited at root** — buffr's root source imports `@buffr/kernel`, `@buffr/connectors`, `@buffr/contracts` from the local `packages/` workspaces; the public API surface of those packages must not change without a build step.
- **Embedding dimension is 768** everywhere (`vector(768)`); a mismatch must throw, never
  silently truncate.
- Schema is `agents` in database `reindb`; `app_id` from `AGENT_APP_ID` (default
  `'laptop'`), schema from `AGENT_DB_SCHEMA` (default `'agents'`).
- Secrets live in `.env` (gitignored) — never committed.
- Chunk/document ids are aptkit's deterministic ids (`"<docId>#<index>"`, `docId`).
