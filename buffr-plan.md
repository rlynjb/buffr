# buffr — Implementation Plan

> Structured for Claude Code. Read this file at the start of every session and continue from the next unchecked step. Complete all checkboxes in the current phase before moving to the next. Notify the user when a phase is complete before proceeding.

---

## Session startup prompt

```
Read buffr-plan.md from the project root and continue from
the next unchecked step in the current active phase.
Do not modify any files not explicitly mentioned in that phase.
When a phase is fully complete, stop and notify the user before
starting the next phase.
```

---

## Notification rule

> **After completing every phase, stop and output this message before doing anything else:**
>
> ```
> ✓ Phase [N] complete — [phase name]
>
> Summary of what was done:
> - [bullet list of completed steps]
>
> Next up: Phase [N+1] — [name]
> [one sentence describing what it involves]
>
> Ready to continue? Type "yes" to start Phase [N+1].
> ```
>
> Do not begin the next phase until the user confirms.

---

## Context

buffr is a single-user developer productivity tool built on Next.js 16, Netlify Functions, Netlify Blobs, and LangChain.js.

This plan covers two things in sequence:
1. **Restructure** — migrate `.dev/` and `.doc/` to a unified `.buffr/` directory with updated data models and UI
2. **DB migration** — move from Netlify Blobs to Neon Postgres using Drizzle ORM, keeping Supabase as a drop-in swap option

All feature work (Phases 7–9) builds on top of Postgres. Do not build new features on Netlify Blobs.

**Stack:** Next.js 16 · React 19 · TypeScript 5 · Tailwind CSS v4 · Netlify Functions · Netlify Blobs (current) · Neon Postgres (target) · Drizzle ORM · LangChain.js · Vitest

---

## Portability rules (database-agnostic from day one)

Follow these throughout Phases 2–6 to keep Supabase as a drop-in swap:

1. Use `postgres` (porsager/postgres) client and Drizzle ORM only — **no** `@neondatabase/serverless` HTTP mode in the core data layer
2. No Neon-specific SQL or extensions in app code
3. Keep auth in the existing JWT system — do not adopt Neon Auth or Supabase Auth
4. All schema changes go through Drizzle migration files in version control — never via a dashboard UI

---

## Target .buffr directory structure

```
.buffr/
  global/              ← who you are — global, all projects
    identity.md
    rules.md
    stack.md
    skills.md

  project/             ← what this project is — local to repo
    context.md
    rules.md
    stack.md

  specs/               ← what you're doing now — per task
    features/
    bugs/
    tests/
    phases/
    migrations/
    refactors/
    prompts/
    performance/
    integrations/
```

---

## Phase overview

| Phase | Description | Depends on | Est. |
|-------|-------------|------------|------|
| **1** | .buffr restructure — rename, data models, UI | — | 4–6h |
| **2** | DB setup — Neon + Drizzle + schema | Phase 1 | 1–2h |
| **3** | Parallel writes — Blobs + Postgres | Phase 2 | 4–6h |
| **4** | Backfill existing Blob data | Phase 3 stable 2+ days | 2–3h |
| **5** | Read cutover to Postgres + bug fixes | Phase 4 | 4–6h |
| **6** | Remove Netlify Blobs | Phase 5 stable 1–2 weeks | 1–2h |
| **7** | Project context generator | Phase 5 | 4–6h |
| **8** | Agent foundation | Phase 7 | 6–8h |
| **9** | Todo → spec automation | Phase 8 | 4–6h |
| | **Total** | | **30–45h** |

---

## Phase 1 — .buffr restructure

**Status: Active**

**Goal:** Replace `.dev/` and `.doc/` with `.buffr/global/` and `.buffr/specs/` throughout the entire codebase. Update data models, Netlify functions, storage, API client, file paths, and UI tabs. No DB changes, no agent work, no new AI features.

---

### Updated data models

**Remove `DevItem`. Replace with `BuffrGlobalItem`:**
```typescript
interface BuffrGlobalItem {
  id: string;
  filename: string;
  path: string;         // e.g. ".buffr/global/rules.md"
  category: "identity" | "rules" | "stack" | "skills";
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}
```

**Remove `DocItem`. Replace with `BuffrSpecItem`:**
```typescript
interface BuffrSpecItem {
  id: string;
  category: "features" | "bugs" | "tests" | "phases" |
            "migrations" | "refactors" | "prompts" |
            "performance" | "integrations";
  filename: string;
  path: string;         // e.g. ".buffr/specs/bugs/agent-routing.md"
  title: string;
  content: string;
  scope: string;        // project ID
  status: "draft" | "ready" | "in-progress" | "done";
  createdAt: string;
  updatedAt: string;
}
```

---

### Steps

- [ ] **1.1** Rename `netlify/functions/dev-items.ts` → `netlify/functions/buffr-global.ts`
  - Update all internal imports and references
  - Update Netlify Blobs store name: `dev-items` → `buffr-global`
  - Update all file path prefixes: `.dev/` → `.buffr/global/`

- [ ] **1.2** Rename `netlify/functions/doc-items.ts` → `netlify/functions/buffr-specs.ts`
  - Update all internal imports and references
  - Update Netlify Blobs store name: `doc-items` → `buffr-specs`
  - Update all file path prefixes: `.doc/` → `.buffr/specs/`

- [ ] **1.3** Update storage wrappers in `netlify/functions/lib/storage/`
  - Rename `dev-items` storage wrapper → `buffr-global`
  - Rename `doc-items` storage wrapper → `buffr-specs`
  - Update store key strings in both wrappers

- [ ] **1.4** Create `scripts/migrate-blobs.ts`
  - Copy all existing `dev-items` blobs → `buffr-global` store
  - Copy all existing `doc-items` blobs → `buffr-specs` store
  - Add `category` defaulting to `"rules"` on migrated `BuffrGlobalItem` entries
  - Add `status` defaulting to `"draft"` on migrated `BuffrSpecItem` entries
  - Log entry counts — script must be idempotent

- [ ] **1.5** Update `netlify/functions/lib/github.ts`
  - All `.dev/` path prefixes → `.buffr/global/`
  - All `.doc/` path prefixes → `.buffr/specs/`

- [ ] **1.6** Update GitHub push adapter target paths:
  - Claude Code → `CLAUDE.md` (sourced from `.buffr/global/`)
  - Cursor → `.cursorrules`
  - Copilot → `.github/copilot-instructions.md`
  - Windsurf → `.windsurfrules`
  - Aider → `.aider.conf.yml`
  - Continue → `.continuerules`

- [ ] **1.7** Update `src/lib/api.ts`
  - All `/dev-items` endpoint calls → `/buffr-global`
  - All `/doc-items` endpoint calls → `/buffr-specs`
  - Update function names: `devItems*` → `buffrGlobal*`, `docItems*` → `buffrSpecs*`

- [ ] **1.8** Update `src/lib/types.ts`
  - Remove `DevItem` and `DocItem` interfaces
  - Add `BuffrGlobalItem` and `BuffrSpecItem` interfaces

- [ ] **1.9** Update all type imports throughout `src/` and `netlify/functions/`
  - Replace all `DevItem` → `BuffrGlobalItem`
  - Replace all `DocItem` → `BuffrSpecItem`

- [ ] **1.10** Rename `src/components/session/DevTab.tsx` → `BuffrGlobalTab.tsx`
  - Tab label: `.dev` → `.buffr/global`
  - Category filter: replace old values with `identity | rules | stack | skills`
  - Update file path display and form labels
  - Update Push to GitHub copy
  - Keep all CRUD functionality intact

- [ ] **1.11** Update parent tab list — replace `DevTab` → `BuffrGlobalTab`, tab id `dev` → `buffr-global`

- [ ] **1.12** Rename `src/components/session/DocTab.tsx` → `BuffrSpecsTab.tsx`
  - Tab label: `.doc` → `.buffr/specs`
  - Category filter: replace `docs | ideas | plans` with `features | bugs | tests | phases | migrations | refactors | prompts | performance | integrations`
  - Add status filter: `draft | ready | in-progress | done`
  - Add status dropdown to create/edit form, default `draft`
  - Update file path display and form labels
  - Keep all CRUD functionality intact

- [ ] **1.13** Update parent tab list — replace `DocTab` → `BuffrSpecsTab`, tab id `doc` → `buffr-specs`

- [ ] **1.14** Search codebase for remaining `dev-items`, `doc-items`, `DevItem`, `DocItem`, `.dev/`, `.doc/` references. Fix all including comments and string literals.

- [ ] **1.15** Run Vitest — all existing tests must pass

- [ ] **1.16** Manual smoke test:
  - Create `.buffr/global` item → saves and appears
  - Edit and delete it → CRUD works
  - Create `.buffr/specs` item with status `draft` → saves
  - Change status to `ready` → updates
  - Push global item to GitHub → lands at `.buffr/global/[filename]`
  - Push spec item to GitHub → lands at `.buffr/specs/[category]/[filename]`

---

### Constraints
- Do not change data shape in Netlify Blobs beyond `category` and `status` defaults in the migration script
- Do not modify auth, sessions, projects, manual-actions, or tools code
- Do not change layout, styling, or component structure beyond what is listed above
- Each step must leave the app in a deployable state

### Rollback plan
Keep old Netlify function filenames as thin forwarding wrappers for one deploy cycle. Revert migration script if blob data is corrupted.

### ✓ Done when
- [ ] No `dev-items`, `doc-items`, `DevItem`, `DocItem` references exist anywhere
- [ ] `.dev` and `.doc` tab labels replaced by `.buffr/global` and `.buffr/specs`
- [ ] Blob stores use `buffr-global` and `buffr-specs`
- [ ] Category and status fields work in the UI
- [ ] GitHub push lands at `.buffr/global/` and `.buffr/specs/[category]/`
- [ ] All Vitest tests pass
- [ ] App deploys to Netlify without errors

**→ Notify user, wait for confirmation before starting Phase 2**

---

## Phase 2 — DB setup

**Status: Backlog**

**Goal:** Provision Neon Postgres, install Drizzle, define the full schema, and get tables created. No app code changes yet — infrastructure only.

**Depends on:** Phase 1 complete and deployed

---

### Steps

- [ ] **2.1** Provision Neon database via Netlify dashboard (Integrations → Neon → Add). Confirm `NETLIFY_DATABASE_URL` and `NETLIFY_DATABASE_URL_UNPOOLED` env vars are auto-injected.

- [ ] **2.2** Install dependencies:
  ```
  npm i drizzle-orm postgres
  npm i -D drizzle-kit
  ```

- [ ] **2.3** Create `drizzle.config.ts` at project root pointing at `NETLIFY_DATABASE_URL`

- [ ] **2.4** Create `netlify/functions/lib/db/client.ts` — export a single shared `db` instance using `postgres` client:
  ```typescript
  import postgres from 'postgres';
  import { drizzle } from 'drizzle-orm/postgres-js';

  const client = postgres(process.env.NETLIFY_DATABASE_URL!);
  export const db = drizzle(client);
  ```

- [ ] **2.5** Create `netlify/functions/lib/db/schema.ts` with Drizzle schema definitions matching this SQL:

  ```sql
  -- Projects
  CREATE TABLE projects (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name             text NOT NULL,
    description      text NOT NULL DEFAULT '',
    stack            text NOT NULL DEFAULT '',
    phase            text NOT NULL CHECK (phase IN ('idea','mvp','polish','deploy')),
    github_repo      text,
    netlify_site_url text,
    data_sources     text[] NOT NULL DEFAULT '{}',
    dismissed_suggestions text[] NOT NULL DEFAULT '{}',
    last_session_id  uuid,
    last_synced_at   timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX projects_updated_at_idx ON projects (updated_at DESC);

  -- Sessions
  CREATE TABLE sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    goal            text NOT NULL,
    what_changed    text[] NOT NULL DEFAULT '{}',
    blockers        text,
    detected_intent text,
    created_at      timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX sessions_project_id_created_at_idx ON sessions (project_id, created_at DESC);

  -- Manual actions (one row per action — fixes race condition)
  CREATE TABLE manual_actions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    text       text NOT NULL,
    done       boolean NOT NULL DEFAULT false,
    position   integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX manual_actions_project_id_position_idx ON manual_actions (project_id, position);

  -- buffr_global (replaces dev-items Blob store)
  CREATE TABLE buffr_global (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    filename   text NOT NULL UNIQUE,
    path       text NOT NULL,
    category   text NOT NULL CHECK (category IN ('identity','rules','stack','skills')),
    title      text NOT NULL,
    content    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  -- buffr_specs (replaces doc-items Blob store)
  CREATE TABLE buffr_specs (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    category   text NOT NULL CHECK (category IN (
                 'features','bugs','tests','phases','migrations',
                 'refactors','prompts','performance','integrations')),
    filename   text NOT NULL,
    path       text NOT NULL,
    title      text NOT NULL,
    content    text NOT NULL,
    status     text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','ready','in-progress','done')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, path)
  );
  CREATE INDEX buffr_specs_project_id_category_idx ON buffr_specs (project_id, category);

  -- Tool config
  CREATE TABLE tool_configs (
    integration_id text PRIMARY KEY,
    values         jsonb NOT NULL DEFAULT '{}',
    enabled        boolean NOT NULL DEFAULT false,
    updated_at     timestamptz NOT NULL DEFAULT now()
  );

  -- App-wide settings
  CREATE TABLE settings (
    key   text PRIMARY KEY,
    value jsonb NOT NULL
  );

  -- Phase 8 prep: agent conversation memory
  CREATE TABLE conversations (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX conversations_project_id_idx ON conversations (project_id, updated_at DESC);

  CREATE TABLE messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
    content         text NOT NULL,
    tool_calls      jsonb,
    tool_results    jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX messages_conversation_id_idx ON messages (conversation_id, created_at);
  ```

- [ ] **2.6** Run `drizzle-kit generate` to produce migration SQL files

- [ ] **2.7** Run `drizzle-kit migrate` to create all tables in Neon

- [ ] **2.8** Verify `db` client imports without errors in a Netlify Function (add a temporary health-check endpoint if needed, remove it after)

---

### ✓ Done when
- [ ] Neon DB is provisioned and connected to Netlify
- [ ] All tables exist and migration runs clean
- [ ] `db` client imports without errors in Netlify Functions environment

**→ Notify user, wait for confirmation before starting Phase 3**

---

## Phase 3 — Parallel writes

**Status: Backlog**

**Goal:** Write to both Netlify Blobs and Postgres simultaneously. Blobs remain authoritative — Postgres is write-only at this stage. Enables instant rollback if anything breaks.

**Depends on:** Phase 2 complete

---

### Steps

- [ ] **3.1** Create `netlify/functions/lib/storage/db/` directory with Postgres-backed storage modules mirroring existing Blob modules:
  - `projects.ts`, `sessions.ts`, `manual-actions.ts`, `buffr-global.ts`, `buffr-specs.ts`, `tool-configs.ts`, `settings.ts`
  - Each module uses Drizzle to write to the corresponding table
  - `manual-actions.ts` must handle JSON array → individual rows expansion when writing

- [ ] **3.2** Add `DB_WRITE_ENABLED=true` to `.env.local` and Netlify env vars. Add a guard to all DB writes:
  ```typescript
  if (process.env.DB_WRITE_ENABLED === 'true') {
    try { await db.insert(...) } catch (e) { console.error('[db write]', e) }
  }
  ```

- [ ] **3.3** In each existing Blob storage module, add a parallel DB write after the Blob write succeeds:
  - `netlify/functions/lib/storage/projects.ts`
  - `netlify/functions/lib/storage/sessions.ts`
  - `netlify/functions/lib/storage/manual-actions.ts`
  - `netlify/functions/lib/storage/buffr-global.ts`
  - `netlify/functions/lib/storage/buffr-specs.ts`
  - `netlify/functions/lib/storage/tool-configs.ts`
  - `netlify/functions/lib/storage/settings.ts`

- [ ] **3.4** Deploy and run for 2+ days of normal usage. Spot-check Postgres tables with `SELECT count(*)` after each use session.

---

### Constraints
- All reads still go to Blobs — do not touch any read functions
- DB write failures must be silent — logged only, never surfaced to the user
- Setting `DB_WRITE_ENABLED=false` must fully revert to Blob-only behaviour

### ✓ Done when
- [ ] All Postgres tables accumulate data matching Netlify Blobs
- [ ] App behaviour is identical to before — no user-facing changes
- [ ] `DB_WRITE_ENABLED=false` reverts to Blob-only cleanly
- [ ] 2+ days of normal usage with no errors

**→ Notify user, wait for confirmation before starting Phase 4**

---

## Phase 4 — Backfill Blob data

**Status: Backlog**

**Goal:** Copy all existing Netlify Blob data into Postgres so the DB is a complete mirror before reads are switched over.

**Depends on:** Phase 3 stable for 2+ days

---

### Steps

- [ ] **4.1** Write `scripts/backfill-postgres.ts`:
  - Reads every key from each Blob store: `projects`, `sessions`, `manual-actions`, `buffr-global`, `buffr-specs`, `tool-config`, `settings`
  - Upserts data into corresponding Postgres tables using Drizzle `onConflictDoUpdate`
  - Expands `manual_actions` JSON arrays into individual rows — assign `position` from array index
  - Logs entry counts per store
  - Is idempotent — safe to run multiple times

- [ ] **4.2** Run `npx ts-node scripts/backfill-postgres.ts`

- [ ] **4.3** Verify with `SELECT count(*)` on each table — counts must match Blob entry counts

- [ ] **4.4** Cross-check 3–5 sample records between Blobs and Postgres for correctness

---

### ✓ Done when
- [ ] Row counts in Postgres match Blob entry counts for all stores
- [ ] Sample records are identical between Blob and Postgres
- [ ] Script can be re-run without duplicating data

**→ Notify user, wait for confirmation before starting Phase 5**

---

## Phase 5 — Read cutover to Postgres

**Status: Backlog**

**Goal:** Switch all reads from Netlify Blobs to Postgres. Keep dual writes active as a safety net. Fix audit blockers that the new schema unblocks.

**Depends on:** Phase 4 complete

---

### Steps

- [ ] **5.1** Replace read functions in each Blob storage module with Drizzle queries. Keep all writes unchanged (dual write still active):
  - `projects.ts` — list, get by id
  - `sessions.ts` — list by project id (now uses index, no full scan)
  - `manual-actions.ts` — list by project id ordered by position (no more full-array reads)
  - `buffr-global.ts` — list all, get by id
  - `buffr-specs.ts` — list by project id + category filter
  - `tool-configs.ts` — get by integration id
  - `settings.ts` — get by key

- [ ] **5.2** Fix audit blockers now unblocked by the schema:
  - **Bug 3 — race condition:** gone — each manual action is its own row, parallel updates target different rows
  - **Bugs 1 & 2 — no rollback:** use `RETURNING *` in upsert/update to return authoritative state
  - **Session full scan:** fixed by `sessions_project_id_created_at_idx` index
  - **End session activity gap:** use `lastSession.created_at` as GitHub `since` parameter directly

- [ ] **5.3** Deploy and manually test every feature:
  - Create project, import from GitHub
  - End session — confirm goal, what changed, blockers save
  - Add, edit, reorder, complete manual actions
  - Create and push `.buffr/global` items
  - Create and push `.buffr/specs` items
  - Tool integration config

- [ ] **5.4** Monitor Netlify function logs for 24 hours — zero 500s required

---

### ✓ Done when
- [ ] All reads come from Postgres
- [ ] All four audit blockers resolved
- [ ] Manual smoke test passes across all features
- [ ] No 500s in Netlify logs after 24 hours

**→ Notify user, wait for confirmation before starting Phase 6**

---

## Phase 6 — Remove Netlify Blobs

**Status: Backlog**

**Goal:** Delete all Blob write code and remove the dependency after 1–2 weeks of stable Postgres reads.

**Depends on:** Phase 5 stable for 1–2 weeks

---

### Steps

- [ ] **6.1** Delete all Blob write code from each storage module (keep only the Drizzle reads/writes)

- [ ] **6.2** Delete the Blob storage wrapper files entirely from `netlify/functions/lib/storage/` (the originals, not the `db/` versions)

- [ ] **6.3** Remove `@netlify/blobs` from `package.json` and run `npm install`

- [ ] **6.4** Remove `DB_WRITE_ENABLED` env var and all related guard code

- [ ] **6.5** Move backfill and blob migration scripts to `scripts/archived/` — do not delete them

- [ ] **6.6** Run Vitest — all tests pass

- [ ] **6.7** Deploy to Netlify — confirm app runs entirely on Postgres

---

### Supabase escape hatch
If you ever need to switch away from Neon:
```bash
pg_dump $NETLIFY_DATABASE_URL > backup.sql
psql $SUPABASE_DATABASE_URL < backup.sql
# Update DATABASE_URL env var in Netlify → redeploy
# Drizzle queries, schema, and app code do not change
```

### ✓ Done when
- [ ] No `@netlify/blobs` imports remain in the codebase
- [ ] App runs entirely on Postgres
- [ ] All Vitest tests pass
- [ ] Deployed and stable for 24+ hours

**→ Notify user, wait for confirmation before starting Phase 7**

---

## Phase 7 — Project context generator

**Status: Backlog**

**Goal:** Add `buffr_context` table, `buffr-context` Netlify function, and an AI chain that analyses the current project and generates `.buffr/project/context.md`. Add a `.buffr/project` tab to the project page.

**Depends on:** Phase 5 complete (reads from Postgres)

---

### Steps

- [ ] **7.1** Add `buffr_context` table to Drizzle schema in `schema.ts`:
  ```sql
  CREATE TABLE buffr_context (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename      text NOT NULL,
    path          text NOT NULL,
    category      text NOT NULL CHECK (category IN ('context','rules','stack','agents')),
    title         text NOT NULL,
    content       text NOT NULL,
    generated_at  timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
  );
  ```

- [ ] **7.2** Run `drizzle-kit generate` and `drizzle-kit migrate`

- [ ] **7.3** Create `netlify/functions/lib/storage/db/buffr-context.ts` storage module

- [ ] **7.4** Create `netlify/functions/buffr-context.ts` with endpoints:
  - `GET /buffr-context?projectId=X` → `BuffrProjectContext[]`
  - `POST /buffr-context?generate` `{ projectId }` → triggers AI generation
  - `PUT /buffr-context?id=X` `{ content? }` → manual edit
  - `POST /buffr-context?push` `{ projectId, repo }` → push to GitHub

- [ ] **7.5** Create AI chain `netlify/functions/lib/ai/chains/context-generator.ts`:
  - Input: project data + session history + GitHub repo analysis
  - Output: structured markdown with sections: data model, file structure, stack, what's stable, what must not change
  - Uses existing `provider.ts` multi-provider factory

- [ ] **7.6** Add `generateContext()`, `getContext()`, `updateContext()`, `pushContext()` to `src/lib/api.ts`

- [ ] **7.7** Add `.buffr/project` tab to project page tab list:
  - Lists `BuffrProjectContext` files
  - "Regenerate" button calls `?generate`
  - "Push to GitHub" button calls `?push`
  - Files are read-only by default — edit button unlocks

- [ ] **7.8** Auto-trigger context regeneration when user clicks the existing sync button

- [ ] **7.9** Run Vitest — all tests pass

---

### ✓ Done when
- [ ] Project can generate `context.md` via the UI
- [ ] Generated context pushes to GitHub at `.buffr/project/context.md`
- [ ] Regeneration triggers on sync
- [ ] Tests pass

**→ Notify user, wait for confirmation before starting Phase 8**

---

## Phase 8 — Agent foundation

**Status: Backlog**

**Goal:** Build tool-calling infrastructure and a ReAct loop. The `conversations` and `messages` tables are already created in Phase 2 — wire them up here. Prerequisite for Phase 9.

**Depends on:** Phase 7 complete

---

### Steps

- [ ] **8.1** Create `netlify/functions/lib/ai/tools/` directory with tool interface:
  ```typescript
  interface AgentTool {
    name: string;
    description: string;
    execute: (input: unknown) => Promise<unknown>;
  }
  ```

- [ ] **8.2** Implement five tools:
  - `loadContext.ts` — reads `buffr_context` from DB by projectId, returns content string
  - `selectTemplate.ts` — classification chain mapping intent to spec type
  - `buildSpec.ts` — guided fill-in chain using template + answers + context
  - `validateSpec.ts` — checks spec for required sections per type, returns gaps[]
  - `saveSpec.ts` — creates `BuffrSpecItem` row in `buffr_specs` table with correct path

- [ ] **8.3** Create storage modules for `conversations` and `messages` tables

- [ ] **8.4** Create ReAct agent loop `netlify/functions/lib/ai/agent.ts`:
  - Accepts: `{ intent, projectId, answers?, provider? }`
  - Runs: `loadContext → selectTemplate → buildSpec → validateSpec → saveSpec`
  - Stores conversation turns in `conversations` + `messages` tables
  - Returns: `{ spec, path, gaps }`

- [ ] **8.5** Create `netlify/functions/buffr-agent.ts`:
  - `POST /buffr-agent?buildSpec` `{ intent, projectId, answers?, provider? }`

- [ ] **8.6** Add `buildSpec()` to `src/lib/api.ts`

- [ ] **8.7** Write unit tests for all five tools

- [ ] **8.8** Run Vitest — all tests pass

---

### Constraints
- ReAct loop must support all existing providers via `provider.ts`
- Tools must be independently testable — no shared side effects
- `saveSpec` must not overwrite existing specs — generate unique filename on conflict
- No UI work in this phase — agent is backend only

### ✓ Done when
- [ ] Agent takes plain-text intent and produces a saved spec end-to-end
- [ ] All five tools have passing unit tests
- [ ] Agent endpoint returns spec content and saved path
- [ ] Conversation history persists in DB

**→ Notify user, wait for confirmation before starting Phase 9**

---

## Phase 9 — Todo → spec automation

**Status: Backlog**

**Goal:** Connect Next Actions tab to the agent. "Generate spec" on any todo triggers classification, pre-fill from context, 2–3 clarifying questions, and auto-save to `.buffr/specs/`.

**Depends on:** Phase 8 complete

---

### Steps

- [ ] **9.1** Add `spec_path` column to `manual_actions` table via new Drizzle migration:
  ```sql
  ALTER TABLE manual_actions ADD COLUMN spec_path text;
  ```
  Run `drizzle-kit generate` and `drizzle-kit migrate`.

- [ ] **9.2** Update `ManualAction` TypeScript interface — add `specPath?: string`

- [ ] **9.3** Add "Generate spec" action button to each `ManualAction` item in `BuffrSpecsTab`. Only visible when `.buffr/project/context.md` exists for the project.

- [ ] **9.4** Build `SpecBuilderModal` component — multi-step modal:
  - Step 1: detected spec type (editable dropdown)
  - Step 2: pre-filled sections from context + 2–3 clarifying questions
  - Step 3: completed spec preview (editable)
  - Step 4: confirm → saves to `.buffr/specs/[type]/[name].md`
  - Modal is closeable at any step without saving

- [ ] **9.5** On spec save: update `ManualAction` row with `specPath` pointing to the generated spec

- [ ] **9.6** Show spec link badge on todo items that have a `specPath`. Badge links to the spec in `.buffr/specs` tab.

- [ ] **9.7** Add spec history view to `.buffr/specs` tab:
  - Filter by category and status
  - Inline status update without opening the spec
  - Sort by `updated_at`

- [ ] **9.8** Run Vitest — all tests pass

---

### ✓ Done when
- [ ] "Generate spec" works on any todo item
- [ ] Modal guides through type → questions → preview → save
- [ ] Saved spec appears in `.buffr/specs` tab with correct category
- [ ] Todo item shows badge linking to its spec
- [ ] Spec history view works with filter and status update
- [ ] Tests pass

**→ Notify user: all phases complete. buffr restructure and DB migration done.**

---

## Cross-phase constraints

These apply to every phase:

- **Notify the user after every phase completes** — summarise what was done, state the next phase, wait for confirmation before starting
- **One phase per Claude Code session** — do not begin the next phase until all checkboxes are ticked
- **Do not modify unrelated files** — if a file is not mentioned in the current phase steps, leave it alone
- **Run Vitest after every phase** — no phase is done until tests pass
- **Deploy to Netlify after Phase 1 and Phase 5** — validate real behaviour before building further

---

## File location

Save as `buffr-plan.md` in the buffr repo root.
