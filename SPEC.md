# buffr — Product Spec

> Developer continuity and momentum tool. Flow preserver and setup eliminator.

---

## 1. Product Overview

### What buffr Is

buffr is a **single-user developer productivity tool** that maintains continuity across coding sessions on multiple side projects. It tracks session history, manages next actions, syncs with GitHub, and AI-summarizes work so you can pick a project back up without burning a session on rebuilding mental state. All data lives in Neon Postgres.

### Who It's For

Solo developers managing multiple side projects who context-switch between codebases and need to rebuild mental state quickly.

### Core Value Loop

**Start session → Work → End session (auto-summarize from commits + completed tasks) → Detect intent → Next session picks up seamlessly with last intent banner + carried-over tasks.**

---

## 2. Tech Stack

| Layer | Technology | Version |
|-------|------------|---------|
| Framework | Next.js (App Router) | 16.1.6 |
| UI | React + TypeScript | 19.2.3 / 5 |
| Styling | Tailwind CSS v4 (`@theme inline`) | 4 |
| Backend | Netlify Functions (serverless) | `@netlify/functions` 5.1.2 |
| Database | Neon Postgres via Drizzle ORM | `drizzle-orm` 0.45.2, `postgres` 3.4.9 |
| Migrations | drizzle-kit | 0.31.10 |
| AI | LangChain.js multi-provider | `@langchain/core` 1.1.27 |
| Auth | JWT (jose) in HTTP-only cookie | `jose` 4.15.9 |
| Testing | Vitest | 4.0.18 |
| Lint | ESLint (Next config) | 9 |
| Deploy | Netlify (esbuild bundler, 120s function timeout) | — |

LLM providers (each is optional; only those with env keys appear in the UI): `@langchain/anthropic`, `@langchain/openai`, `@langchain/google-genai`, `@langchain/ollama`.

---

## 3. Project Structure

```
src/
  app/
    login/page.tsx                 Login page
    project/[id]/page.tsx          Project workspace (cached via sessionStorage)
    page.tsx                       Dashboard (project list)
    layout.tsx                     Root layout: AuthProvider + AppShell, fonts
    globals.css                    Design tokens + base styles
  components/
    ui/                            Primitives: Button, Input, Modal, Badge, Card,
                                   Checkbox, Textarea, Notification
    dashboard/                     ProjectCard, ImportProjectModal
    session/                       ResumeCard, SessionTab, ActionsTab,
                                   ToolsTab, EndSessionModal
    tools/                         ConfigModal, TestToolModal
    app-shell.tsx                  Auth gate + Provider/Notification context wrap
    nav.tsx                        Top nav (logo, provider switcher, sign out)
    provider-switcher.tsx          LLM provider dropdown
    icons.tsx                      Inline SVG icon set + sourceColor()/SourceIcon
  context/
    auth-context.tsx               authenticated/loading + login/logout
    provider-context.tsx           providers list + selected (persisted to localStorage)
  lib/
    api.ts                         Fetch wrapper for Netlify Functions
    types.ts                       Shared TypeScript interfaces
    constants.ts                   PHASE_COLORS + SOURCE_COLORS
    format.ts                      timeAgo + formatDayDate
    data-sources.ts                Capability → tool-name mapping
    suggestions.ts                 Smart suggestion engine
    project-health.ts              Weekly activity health computation
    suggestions.test.ts            Vitest
    data-sources.test.ts           Vitest
  middleware.ts                    Next.js JWT auth guard

netlify/functions/
  login.ts / logout.ts / auth-check.ts    Auth endpoints
  projects.ts                              Projects CRUD
  sessions.ts                              Sessions CRUD
  manual-actions.ts                        Task list CRUD + reorder + cleanDone
  session-ai.ts                            AI chains (summarize, intent, paraphrase)
  providers.ts                             Available LLM providers
  tools.ts                                 Integration registry + tool execution
  lib/
    ai/
      provider.ts                          Multi-provider LLM factory (temperature 0.7)
      parse-utils.ts                       stripCodeBlock for ``` json ``` LLM output
      chains/
        session-summarizer.ts              Session activity → goal + bullets
        intent-detector.ts                 Session intent classification
        paraphraser.ts                     Task rewriting (default + 5 personas)
      prompts/
        session-prompts.ts                 SUMMARIZE_SYSTEM_PROMPT + INTENT_SYSTEM_PROMPT
    storage/                               Drizzle-backed data access
      projects.ts
      sessions.ts
      manual-actions.ts
      tool-config.ts
      settings.ts
    db/
      client.ts                            postgres-js + Drizzle (uses NETLIFY_DATABASE_URL)
      schema.ts                            5 tables: projects, sessions, manual_actions,
                                           tool_configs, settings
    tools/
      registry.ts                          Map<name, Tool> + executeTool
      register-all.ts                      Cold-start registration (idempotent)
      github.ts                            11 GitHub tool registrations
    github.ts                              GitHub REST API wrapper (no Octokit)
    auth.ts                                JWT creation/verification + cookie helpers
    responses.ts                           json + errorResponse + classifyError

drizzle/                                   Migration SQL: 0000..0004
scripts/archived/                          Historical Blob → Postgres migration scripts
```

---

## 4. Database Schema

Five tables. All defined in [`netlify/functions/lib/db/schema.ts`](netlify/functions/lib/db/schema.ts) using Drizzle ORM against Neon Postgres. Timestamps are `timestamp with time zone`. Migrations live under [`drizzle/`](drizzle/) (0000..0004).

### projects

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK, `defaultRandom()` |
| `name` | text | NOT NULL |
| `description` | text | NOT NULL, default `""` |
| `stack` | text | NOT NULL, default `""` |
| `phase` | text | NOT NULL — `idea` \| `mvp` \| `polish` \| `deploy` |
| `github_repo` | text | `"owner/repo"` |
| `netlify_site_url` | text | |
| `data_sources` | text[] | NOT NULL, default `{}` (e.g. `["github"]`) |
| `dismissed_suggestions` | text[] | NOT NULL, default `{}` |
| `last_session_id` | uuid | |
| `last_synced_at` | timestamptz | |
| `created_at` | timestamptz | NOT NULL, `now()` |
| `updated_at` | timestamptz | NOT NULL, `now()` |

Index: `projects_updated_at_idx` on `updated_at`.

### sessions

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `project_id` | uuid | FK → projects, `ON DELETE CASCADE` |
| `goal` | text | NOT NULL |
| `what_changed` | text[] | NOT NULL, default `{}` |
| `blockers` | text | nullable |
| `detected_intent` | text | AI-detected, 2–5 words |
| `created_at` | timestamptz | NOT NULL, `now()` |

Index: `sessions_project_id_created_at_idx` on `(project_id, created_at)`.

### manual_actions

One row per action. PK is the **app-generated text id** (e.g. `manual-1717000000000`).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text | PK — app-generated id |
| `project_id` | uuid | FK → projects, cascade delete |
| `text` | text | NOT NULL |
| `done` | boolean | NOT NULL, default `false` |
| `position` | integer | NOT NULL — sort order |
| `created_at` | timestamptz | NOT NULL, `now()` |
| `updated_at` | timestamptz | NOT NULL, `now()` |

Index: `manual_actions_project_id_position_idx` on `(project_id, position)`. Storage layer rewrites the entire list on every mutation (delete-then-insert) to keep `position` contiguous.

### tool_configs

| Column | Type | Notes |
|--------|------|-------|
| `integration_id` | text | PK — e.g. `github` |
| `values` | jsonb | NOT NULL, default `{}` — config key/values |
| `enabled` | boolean | NOT NULL, default `false` |
| `updated_at` | timestamptz | NOT NULL, `now()` |

### settings

| Column | Type | Notes |
|--------|------|-------|
| `key` | text | PK |
| `value` | jsonb | NOT NULL |

Generic JSONB key/value for app-wide flags (currently used for `default-data-sources`).

---

## 5. Data Models (TypeScript)

Source of truth: [`src/lib/types.ts`](src/lib/types.ts) (shared by client + functions). The `ManualActionData` wire type lives in [`src/lib/api.ts`](src/lib/api.ts).

```typescript
interface Project {
  id: string;
  name: string;
  description: string;
  stack: string;
  phase: "idea" | "mvp" | "polish" | "deploy";
  lastSessionId: string | null;
  githubRepo: string | null;
  netlifySiteUrl: string | null;
  dataSources?: string[];
  dismissedSuggestions?: string[];
  lastSyncedAt?: string | null;
  updatedAt: string;
}

interface Session {
  id: string;
  projectId: string;
  goal: string;
  whatChanged: string[];
  blockers: string | null;
  detectedIntent?: string;
  createdAt: string;
}

interface ManualActionData {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolIntegration {
  id: string;            // e.g. "github"
  name: string;
  description: string;
  status: "connected" | "error" | "not_configured";
  tools: ToolDefinition[];
  configFields: { key: string; label: string; secret: boolean }[];
}

interface ToolConfig {
  integrationId: string;
  values: Record<string, string>;
  enabled: boolean;
  updatedAt: string;
}

interface LLMProvider {
  name: string;          // "anthropic" | "openai" | "google" | "ollama"
  label: string;
  model: string;
}
```

---

## 6. Features

### 6.1 Authentication

- Single-user login. Credentials are read from `AUTH_USERNAME` / `AUTH_PASSWORD`.
- JWT (HS256, 7-day expiry, subject `"buffr-user"`) signed with `AUTH_SECRET`.
- Stored in HTTP-only, Secure, SameSite=Lax cookie named `buffr-token` (Max-Age 604800s).
- [`src/middleware.ts`](src/middleware.ts) verifies the token and:
  - Skips `/login`, `/_next/`, `/.netlify/`, `/favicon.ico`.
  - Redirects unauthenticated users to `/login`.
  - Bounces authenticated users away from `/login` to `/`.
  - Falls back to `"fallback-dev-secret"` if `AUTH_SECRET` is unset (dev only).
- `AppShell` re-checks auth client-side via `/auth-check` and gates the nav + provider context behind the result.

### 6.2 Dashboard (`/`)

- Lists all projects sorted by `updated_at` desc.
- `ProjectCard` shows: name, phase badge, data-source icons, description, stack, "{n}m/h/d ago", up to 3 pending next actions, GitHub/Netlify link icons, delete button.
- "Load Existing" opens [`ImportProjectModal`](src/components/dashboard/import-project-modal.tsx).
- Delete with confirmation modal.
- Newly created project is cached in `sessionStorage` (`buffr-project-{id}`) so the project page renders instantly on navigation.
- Dashboard re-fetches projects on `window.focus`.

### 6.3 GitHub Import

- Accepts `owner/repo`, `https://github.com/owner/repo`, or `.git` URLs.
- Calls `github_analyze_repo` which:
  - Resolves the repo (follows GitHub renames/redirects via `getRepoInfo`).
  - Lists the recursive tree.
  - Reads `package.json` deps + devDeps.
  - **Frameworks detected**: Next.js, React, Vue, Nuxt, Svelte, SvelteKit, Angular, Express, Fastify, Hono, Astro, Gatsby, Remix, Solid; plus TypeScript (deps or `.ts`/`.tsx`), Tailwind CSS, styled-components, Emotion.
  - **Dev tools detected**: ESLint, Prettier, Jest, Vitest, Mocha, Testing Library, Cypress, Playwright, Storybook, Husky, lint-staged.
  - **Maturity signals**: `hasTests` (test deps or `.test.`/`.spec.`/`__tests__` paths), `hasCI` (`.github/workflows/`, `.gitlab-ci.yml`, `.circleci/config.yml`, `Jenkinsfile`), `hasDeployConfig` (`netlify.toml`, `vercel.json`, `fly.toml`, `Dockerfile`, `docker-compose.yml`, `render.yaml`).
  - **Phase auto-detect**: `idea` (`fileCount < 5`) → `mvp` (default) → `polish` (tests + CI or deploy) → `deploy` (all three).
  - Stack string is deduplicated (Next.js implies React; Nuxt implies Vue; SvelteKit implies Svelte).

### 6.4 Project Page (`/project/[id]`)

Tabbed workspace rendered by [`ResumeCard`](src/components/session/resume-card.tsx).

**Header:**
- "← Dashboard" back link.
- Multi-project nav bar with health dots (rendered only when there are >1 projects). Green = active this week; yellow = needs attention.
- Activity timestamps: "Last session: Day, Mon DD (Xh ago)" and "Last commit: Day, Mon DD (Xh ago)".
- Project name, phase badge, description, stack, GitHub link, Netlify link, "Last sync Xh ago".
- **Sync** button (only when `githubRepo` is set) re-runs `github_analyze_repo` and updates `name`, `githubRepo` (handles renames), `stack`, `phase`, `description`, `lastSyncedAt`.
- **End Session** button opens `EndSessionModal`.

**Smart Suggestions** (up to 2 cards, dismissable, persisted in `dismissed_suggestions`):
- No data sources connected + integrations available → suggest connecting one (jumps to Tools tab).
- No sessions yet → suggest starting a first session.
- Idle > 14 days → suggest resuming.

**Detected Intent** banner shows the AI-detected intent of the previous session (e.g. "authentication feature") when present.

#### Tabs

Three tabs: `Next Actions` (default), `Last Session`, `Tools`.

##### Next Actions (`ActionsTab`)
- Add new task via auto-resizing textarea (Enter submits, Shift+Enter newline).
- "Rewrite" button (default paraphrase) and "Persona ▾" dropdown with: User Story, Backend Dev, Frontend Dev, Stakeholder, Project Manager.
- Inline edit (click to edit, Enter commits, Esc cancels), delete, reorder via HTML5 drag-and-drop.
- Each row: drag handle, position number, text, Done button, trash button.
- Optimistic UI with rollback + toast notifications via `NotificationProvider` on server failure.
- Tasks persist across sessions; completed ones feed `EndSessionModal` summaries and are removed via `cleanDoneManualActions` after a session is saved.

##### Last Session (`SessionTab`)
- Read-only view: Goal, What Changed (bulleted), Blockers (in red label), timestamp.
- Empty state: "No sessions yet."

##### Tools (`ToolsTab`)
- **Default Data Sources for New Projects**: checkbox list (currently only `github`). Disabled if integration isn't connected. Persisted to `settings` key `default-data-sources`.
- **Integrations** grid: status badge (`Connected` / `Error` / `Not Configured`), tool count, Configure / Test / Remove buttons. The built-in `github` integration cannot be removed.
- **Tool Registry**: searchable, filterable table of every registered tool with name, description, parameter keys (first 4), and source icon.
- `ConfigModal` saves integration tokens to `tool_configs.values`. `TestToolModal` runs `executeTool(name, JSON.parse(input))` and displays the result.

### 6.5 End Session Modal (`EndSessionModal`)

Multi-phase flow (`fetching` → `summarizing` → `ready`):

1. **Fetching** — for each `dataSource`, looks up the relevant capability tool (`list_commits` for `github`) and pulls activity from the last 24h, then appends completed `manual_actions`.
2. **Summarizing** — calls `POST /session-ai?summarize` with the activity items and the selected provider; populates Goal + bulleted "What Changed".
3. **Ready** — editable form:
   - **Goal** (single sentence, required to enable Save).
   - **What Changed** (textarea; AI Summarize button re-runs the summarizer over the current bullets; Clear button).
   - **Blockers** (optional).
   - "AI-generated from N items across M sources" caption when the auto-fill ran.
4. **Save** — creates the `sessions` row, sets `project.lastSessionId`, calls `POST /session-ai?intent` to populate `detectedIntent`, then runs `cleanDoneManualActions` (best-effort).

If no LLM provider is configured (`providers.length === 0`), the modal skips fetch + summarize and goes straight to `ready` with an empty form.

### 6.6 AI Features

All AI features run through the currently selected LLM provider (switchable in the nav bar; persisted to `localStorage["buffr-provider"]` and restored on reload).

| Feature | Chain | Input | Output |
|---------|-------|-------|--------|
| Session summarize | `createSummarizeChain` | activity items | `{ goal, bullets[] }` |
| Intent detection | `createIntentChain` | `goal`, `whatChanged`, `projectPhase` | `{ intent }` |
| Task paraphrase | `createParaphraseChain` | `text`, optional `persona` | `{ text }` |

**Provider factory** ([`netlify/functions/lib/ai/provider.ts`](netlify/functions/lib/ai/provider.ts)) instantiates models at temperature `0.7` via `require()`-style imports (Netlify-bundle-friendly):

- `anthropic` → `ChatAnthropic` (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` default `claude-sonnet-4-20250514`)
- `openai` → `ChatOpenAI` (`OPENAI_API_KEY`, `OPENAI_MODEL` default `gpt-4o`)
- `google` → `ChatGoogleGenerativeAI` (`GOOGLE_API_KEY`, `GOOGLE_MODEL` default `gemini-1.5-pro`)
- `ollama` → `ChatOllama` (`OLLAMA_BASE_URL`, `OLLAMA_MODEL` default `llama3`)

`getAvailableProviders()` filters to providers whose required env keys are set. The default provider is `DEFAULT_LLM_PROVIDER` (fallback `anthropic`). All chain output goes through `stripCodeBlock` to tolerate ` ```json ` fenced LLM responses, with a fallback to the raw string if JSON parsing fails.

### 6.7 Tool System

[`netlify/functions/lib/tools/registry.ts`](netlify/functions/lib/tools/registry.ts) exposes a small runtime registry:

```typescript
interface Tool {
  name: string;
  description: string;
  integrationId: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}
```

- `registerTool(tool)` adds to a module-level `Map<name, Tool>`.
- `listToolsByIntegration(integrationId)` — filtered view.
- `executeTool(name, input)` → `{ ok, result?, error? }`. Catches thrown errors and returns them as `error`.
- `register-all.ts` runs at module load on cold start via `tools.ts` and is idempotent (`registered` flag).

**Capability mapping** ([`src/lib/data-sources.ts`](src/lib/data-sources.ts)) maps abstract capabilities to concrete tool names per integration. Currently:

| Integration | Capability | Tool |
|---|---|---|
| github | create_item | `github_create_issue` |
| github | close_item | `github_close_issue` |
| github | list_commits | `github_list_commits` |
| github | get_diffs | `github_get_diffs` |
| github | get_file | `github_get_file` |

**Registered GitHub tools** ([`netlify/functions/lib/tools/github.ts`](netlify/functions/lib/tools/github.ts)): `github_get_repo`, `github_list_issues`, `github_list_repos`, `github_analyze_repo`, `github_create_repo`, `github_push_files`, `github_create_issue`, `github_close_issue`, `github_list_commits`, `github_get_diffs`, `github_get_file`.

**Integration status** is auto-detected: `connected` if `tool_configs.enabled` is true and all non-`databaseId` config fields are filled, OR — for `github` — if `GITHUB_TOKEN` is set in the environment. Otherwise `error` (enabled but missing values) or `not_configured`.

### 6.8 Project Health

[`src/lib/project-health.ts`](src/lib/project-health.ts) computes per-project from session `createdAt`, `project.lastSyncedAt`, and the latest GitHub commit date. "Needs attention" = no activity inside the current calendar week (Sunday 00:00 → next Sunday 00:00). Rendered as colored dots in the multi-project nav bar.

### 6.9 Smart Suggestions Engine

[`src/lib/suggestions.ts`](src/lib/suggestions.ts) returns up to 2 cards per project, filtered by `dismissed_suggestions`:

1. `connect-source` — no data sources but at least one integration is connected → "Go to Tools".
2. `first-session` — no last session → "Start working".
3. `idle-project` — last session > 14 days ago → "Resume".

---

## 7. API Reference

All endpoints are under `/.netlify/functions/`. All responses are JSON; errors use `{ error: string }` with an HTTP status from `classifyError`.

### Auth

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/auth-check` | — | `{ authenticated: boolean }` |
| POST | `/login` | `{ username, password }` | `{ authenticated: true }` + Set-Cookie |
| POST | `/logout` | — | `{ ok: true }` (clears cookie) |

### Providers

| Method | Endpoint | Response |
|--------|----------|----------|
| GET | `/providers` | `{ providers: LLMProvider[], defaultProvider: string }` |

### Projects

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| GET | `/projects` | — | `Project[]` |
| GET | `/projects?id=X` | — | `Project` |
| POST | `/projects` | `Partial<Project>` | `Project` (201) |
| PUT | `/projects?id=X` | whitelisted fields | `Project` |
| DELETE | `/projects?id=X` | — | `{ ok: true }` |

PUT only writes fields in the whitelist: `name, description, stack, phase, githubRepo, netlifySiteUrl, dataSources, dismissedSuggestions, lastSessionId, lastSyncedAt`.

### Sessions

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| GET | `/sessions?id=X` | — | `Session` |
| GET | `/sessions?projectId=X` | — | `Session[]` (DESC by createdAt) |
| POST | `/sessions` | `{ projectId, goal, whatChanged[], blockers?, detectedIntent? }` | `Session` (201) |
| DELETE | `/sessions?id=X` | — | `{ ok: true }` |

### Manual Actions

`projectId=X` is required for every method. Mutations return the **full updated list**, not just `{ ok }`.

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/manual-actions?projectId=X` | — | `ManualActionData[]` |
| POST | `/manual-actions?projectId=X` | `{ id, text }` | `ManualActionData[]` (201) |
| PUT | `/manual-actions?projectId=X` | `{ id, done?, text? }` | `ManualActionData[]` |
| PATCH | `/manual-actions?projectId=X` | `{ orderedIds: string[] }` | `ManualActionData[]` |
| DELETE | `/manual-actions?projectId=X&actionId=Y` | — | `ManualActionData[]` |
| DELETE | `/manual-actions?projectId=X&cleanDone` | — | `ManualActionData[]` (without `done`) |

### Session AI

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | `/session-ai?summarize` | `{ activityItems[], provider? }` | `{ goal, bullets[] }` |
| POST | `/session-ai?intent` | `{ goal, whatChanged, projectPhase, provider? }` | `{ intent }` |
| POST | `/session-ai?paraphrase` | `{ text, persona?, provider? }` | `{ text }` |

> ⚠ `session-ai` currently lacks auth-middleware enforcement (TODO in source). Reverse proxy / Netlify access controls are the only gate today.

### Tools

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/tools` | — | `ToolIntegration[]` |
| GET | `/tools?defaultSources` | — | `{ sources: string[] }` (default `["github"]`) |
| POST | `/tools?execute` | `{ toolName, input }` | `{ ok, result?, error? }` (status 200 on ok, 400 on error) |
| PUT | `/tools?integrationId=X` | `{ values, enabled }` | `ToolConfig` |
| PUT | `/tools?defaultSources` | `{ sources: string[] }` | `{ sources }` |
| DELETE | `/tools?integrationId=X` | — | `{ ok: true }` |

---

## 8. Design System

### Palette ([`src/app/globals.css`](src/app/globals.css))

| Token | Value | Usage |
|-------|-------|-------|
| `--color-background` | `#09090b` | Page background |
| `--color-foreground` | `#e4e4e7` | Primary text |
| `--color-muted` | `#a1a1aa` | Secondary text |
| `--color-border` | `rgba(63, 63, 70, 0.6)` | Borders |
| `--color-card` | `rgba(24, 24, 27, 0.3)` | Card background |
| `--color-card-hover` | `rgba(24, 24, 27, 0.5)` | Card hover |
| `--color-accent` | `#7c3aed` | Primary purple |
| `--color-accent-hover` | `#6d28d9` | Darker purple |
| `--color-success` | `#34d399` | Emerald |
| `--color-warning` | `#fbbf24` | Amber |
| `--color-error` | `#ef4444` | Red |

Selection: `#7c3aed40`. Scrollbars: thin, `#333` on transparent. Dark theme only (`<html className="dark">`).

### Phase Colors

| Phase | Color |
|-------|-------|
| idea | `#fbbf24` (amber) |
| mvp | `#818cf8` (indigo) |
| polish | `#34d399` (emerald) |
| deploy | `#f472b6` (pink) |

### Source Colors

| Source | Color |
|--------|-------|
| github | `#8b949e` |
| ai | `#c084fc` |
| session | `#a78bfa` |
| manual | `#71717a` |

### Typography

| Role | Font |
|------|------|
| Body | DM Sans (400, 500, 600, 700) |
| Mono | JetBrains Mono |

Loaded via `next/font/google` and exposed as `--font-dm-sans` / `--font-jetbrains-mono`.

### Conventions

- Tailwind CSS v4 with `@theme inline` tokens.
- BEM-like CSS class naming: `component__element--modifier`.
- Per-component CSS files (e.g. `actions-tab.css`) using `@apply` instead of inline Tailwind.
- All icons are inline SVG components from [`src/components/icons.tsx`](src/components/icons.tsx).
- Animations: `fadeIn` (0.2s ease-out), `slideDown` (0.15s ease-out).

---

## 9. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | At least one LLM | Anthropic Claude API key |
| `ANTHROPIC_MODEL` | No | Default `claude-sonnet-4-20250514` |
| `OPENAI_API_KEY` | At least one LLM | OpenAI API key |
| `OPENAI_MODEL` | No | Default `gpt-4o` |
| `GOOGLE_API_KEY` | At least one LLM | Google Gemini API key |
| `GOOGLE_MODEL` | No | Default `gemini-1.5-pro` |
| `OLLAMA_BASE_URL` | At least one LLM | Ollama server URL |
| `OLLAMA_MODEL` | No | Default `llama3` |
| `DEFAULT_LLM_PROVIDER` | No | Default `anthropic` |
| `GITHUB_TOKEN` | For GitHub features | PAT with `repo` scope |
| `AUTH_USERNAME` | Yes | Login username |
| `AUTH_PASSWORD` | Yes | Login password |
| `AUTH_SECRET` | Yes (prod) | JWT signing secret (long random string); dev fallback `"fallback-dev-secret"` |
| `NETLIFY_TOKEN` | For deploy features | Netlify Personal Access Token |
| `NETLIFY_DATABASE_URL` | Yes | Neon Postgres connection string used by `postgres-js` |

Only LLM providers whose keys are set appear in the UI.

---

## 10. Error Handling

`classifyError` ([`netlify/functions/lib/responses.ts`](netlify/functions/lib/responses.ts)) maps provider and API errors to user-friendly messages:

| Error pattern (substring) | Status | Message |
|---|---|---|
| `credit balance is too low`, `insufficient` | 402 | "Your LLM provider account has insufficient credits…" |
| `authentication`, `API key`, `Incorrect API key` | 401 | "Invalid API key for the selected provider…" |
| `rate limit`, `Rate limit` | 429 | "Rate limited by the LLM provider…" |
| `already exists`, `name already exists`, `must be unique` | 422 | "Name conflict — that name already exists…" |
| `not configured`, `GITHUB_TOKEN`, `NETLIFY_TOKEN` | 400 | passthrough message |
| anything else | 500 | passthrough message |

`responses.ts` also exposes `json(data, status?)` and `errorResponse(message, status?)`.

Manual-action mutations use optimistic UI with rollback + a toast via `NotificationProvider` on failure (e.g. "Failed to mark done — reverted").

---

## 11. Scripts & Build

| Command | Purpose |
|---------|---------|
| `npm run dev` | Next.js dev server (no Functions) |
| `netlify dev` | Next.js + Functions locally (recommended) |
| `npm run build` | `next build` |
| `npm run start` | Next.js production server |
| `npm run lint` | ESLint |
| `npm run test` | `vitest run` |

Netlify config ([`netlify.toml`](netlify.toml)): functions directory `netlify/functions`, `node_bundler = "esbuild"`, dev `timeout = 120` seconds, publish `.next`.

Drizzle migrations ([`drizzle/`](drizzle/)):

| File | Change |
|------|--------|
| `0000_sour_wolverine.sql` | Initial schema (`projects`, `sessions`, `manual_actions`, `buffr_global`, `buffr_specs`, `tool_configs`, `settings`, `conversations`, `messages`). |
| `0001_clammy_thundra.sql` | `manual_actions.id`: uuid → text, drop default. |
| `0002_keen_doctor_doom.sql` | Add `buffr_context` table + FK + index. |
| `0003_flawless_mockingbird.sql` | Add `manual_actions.spec_path` (text, nullable). |
| `0004_remove_buffr_tabs.sql` | Drop `messages`, `conversations`, `buffr_specs`, `buffr_context`, `buffr_global`, and `manual_actions.spec_path` (hand-written; regenerate `drizzle/meta/*` via `drizzle-kit generate` to sync snapshots). |

Tests live alongside source (`src/lib/*.test.ts`). Two suites: `data-sources`, `suggestions`.

Historical Blob-to-Postgres migration scripts are archived under [`scripts/archived/`](scripts/archived/) for reference and are not part of the runtime path.
