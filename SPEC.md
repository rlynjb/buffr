# buffr — Product Spec

> Developer continuity and momentum tool. Flow preserver, setup eliminator, and structured idea helper.

---

## 1. Product Overview

### What buffr Is

buffr is a single-user developer productivity tool that helps maintain continuity across coding sessions. It solves the "where was I?" problem by tracking session history, managing next actions, syncing with GitHub repos, providing AI-assisted summarization of work, and generating structured specs from todo items.

### Who It's For

Solo developers managing multiple side projects who need to quickly context-switch between codebases without losing momentum.

### Core Value Loop

**Start session -> Work -> End session (auto-summarize) -> Next session picks up seamlessly**

---

## 2. Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 + React 19 + TypeScript 5 + Tailwind CSS v4 |
| Backend | Netlify Functions (serverless) |
| Database | Neon Postgres via Drizzle ORM |
| AI | LangChain.js with multi-provider support (Anthropic, OpenAI, Google, Ollama) |
| Auth | Single-user JWT (jose) with HTTP-only cookies |
| External APIs | GitHub (fetch wrapper) |
| Testing | Vitest |
| Deploy | Netlify |

---

## 3. Project Structure

```
src/
  app/                    Next.js App Router pages
    login/                Login page
    project/[id]/         Project detail page
    page.tsx              Dashboard (project list)
    layout.tsx            Root layout with auth + providers
    globals.css           Design tokens + base styles
  components/
    ui/                   Primitives (Button, Input, Modal, Badge, Notification)
    dashboard/            Project cards, import modal
    session/              ResumeCard, ActionsTab, SessionTab,
                          BuffrGlobalTab, BuffrSpecsTab, BuffrProjectTab,
                          ToolsTab, EndSessionModal, SpecBuilderModal
    tools/                ConfigModal, TestToolModal
    app-shell.tsx         Auth gate + layout wrapper
    nav.tsx               Top nav with provider switcher
    icons.tsx             SVG icon components
  context/
    auth-context.tsx      Auth state + login/logout
    provider-context.tsx  LLM provider selection
  lib/
    api.ts                Fetch wrapper for all Netlify Functions
    types.ts              Shared TypeScript interfaces
    constants.ts          Phase colors, source colors
    format.ts             Time formatting utilities
    data-sources.ts       Capability -> tool name mapping
    suggestions.ts        Smart suggestion engine
    project-health.ts     Weekly activity health computation

netlify/functions/
  login.ts / logout.ts / auth-check.ts    Auth endpoints
  projects.ts                              CRUD for projects
  sessions.ts                              CRUD for sessions
  manual-actions.ts                        Task list CRUD + reorder
  buffr-global.ts                          .buffr/global file CRUD + GitHub push
  buffr-specs.ts                           .buffr/specs file CRUD + GitHub push
  buffr-context.ts                         .buffr/project context CRUD + AI generation
  buffr-agent.ts                           Spec-building agent endpoint
  session-ai.ts                            AI chains (summarize, intent, paraphrase)
  providers.ts                             Available LLM providers
  tools.ts                                 Integration registry + tool execution
  lib/
    ai/
      provider.ts                          Multi-provider LLM factory
      agent.ts                             ReAct agent loop for spec building
      chains/                              LangChain chains
        context-generator.ts               Project context generation
        session-summarizer.ts              Session activity summarization
        intent-detector.ts                 Session intent detection
        paraphraser.ts                     Task text rewriting with personas
      tools/                               Agent tools
        types.ts                           AgentTool interface
        load-context.ts                    Load project context from DB
        select-template.ts                 Classify intent -> spec type
        build-spec.ts                      LLM-powered spec generation
        validate-spec.ts                   Check required sections
        save-spec.ts                       Save spec to DB with unique filename
      prompts/                             System prompts
      parse-utils.ts                       JSON response cleaning
    storage/                               Drizzle-backed data access
      projects.ts
      sessions.ts
      manual-actions.ts
      buffr-global.ts
      buffr-specs.ts
      buffr-context.ts
      conversations.ts
      tool-config.ts
      settings.ts
    db/
      client.ts                            Drizzle + postgres client
      schema.ts                            Full DB schema (10 tables)
    tools/                                 Tool registry + GitHub tools
    github.ts                              GitHub API wrapper
    auth.ts                                JWT creation/verification
    responses.ts                           HTTP response helpers

drizzle/                                   Migration SQL files
scripts/archived/                          Blob migration scripts (historical)
```

---

## 4. Database Schema

### Projects

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, auto |
| name | text | required |
| description | text | default "" |
| stack | text | default "" |
| phase | text | idea / mvp / polish / deploy |
| github_repo | text | "owner/repo" format |
| netlify_site_url | text | |
| data_sources | text[] | e.g., ["github"] |
| dismissed_suggestions | text[] | |
| last_session_id | uuid | |
| last_synced_at | timestamptz | |
| created_at | timestamptz | auto |
| updated_at | timestamptz | auto |

Index: `projects_updated_at_idx`

### Sessions

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, auto |
| project_id | uuid | FK -> projects, cascade delete |
| goal | text | required |
| what_changed | text[] | |
| blockers | text | |
| detected_intent | text | AI-detected, 2-5 words |
| created_at | timestamptz | auto |

Index: `sessions_project_id_created_at_idx`

### Manual Actions

| Column | Type | Notes |
|--------|------|-------|
| id | text | PK (manual-{timestamp} format) |
| project_id | uuid | FK -> projects, cascade delete |
| text | text | required |
| done | boolean | default false |
| position | integer | sort order |
| spec_path | text | link to generated spec |
| created_at | timestamptz | auto |
| updated_at | timestamptz | auto |

Index: `manual_actions_project_id_position_idx`

### Buffr Global

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, auto |
| filename | text | unique |
| path | text | e.g., ".buffr/global/rules.md" |
| category | text | identity / rules / stack / skills |
| title | text | |
| content | text | markdown |
| created_at | timestamptz | auto |
| updated_at | timestamptz | auto |

### Buffr Context

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, auto |
| project_id | uuid | FK -> projects, cascade delete |
| filename | text | |
| path | text | e.g., ".buffr/project/context.md" |
| category | text | context / rules / stack / agents |
| title | text | |
| content | text | AI-generated markdown |
| generated_at | timestamptz | auto |
| updated_at | timestamptz | auto |

Index: `buffr_context_project_id_idx`

### Buffr Specs

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, auto |
| project_id | uuid | FK -> projects, cascade delete |
| category | text | features / bugs / tests / phases / migrations / refactors / prompts / performance / integrations |
| filename | text | |
| path | text | e.g., ".buffr/specs/bugs/login-crash.md" |
| title | text | |
| content | text | markdown |
| status | text | draft / ready / in-progress / done |
| created_at | timestamptz | auto |
| updated_at | timestamptz | auto |

Unique: `(project_id, path)`. Index: `buffr_specs_project_id_category_idx`

### Tool Configs

| Column | Type | Notes |
|--------|------|-------|
| integration_id | text | PK |
| values | jsonb | config key-value pairs |
| enabled | boolean | |
| updated_at | timestamptz | auto |

### Settings

| Column | Type | Notes |
|--------|------|-------|
| key | text | PK |
| value | jsonb | |

### Conversations

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, auto |
| project_id | uuid | FK -> projects, cascade delete |
| title | text | |
| created_at | timestamptz | auto |
| updated_at | timestamptz | auto |

Index: `conversations_project_id_idx`

### Messages

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, auto |
| conversation_id | uuid | FK -> conversations, cascade delete |
| role | text | user / assistant / tool / system |
| content | text | |
| tool_calls | jsonb | |
| tool_results | jsonb | |
| created_at | timestamptz | auto |

Index: `messages_conversation_id_idx`

---

## 5. Data Models (TypeScript)

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
  specPath?: string | null;
}

interface BuffrContextItem {
  id: string;
  projectId: string;
  filename: string;
  path: string;
  category: "context" | "rules" | "stack" | "agents";
  title: string;
  content: string;
  generatedAt: string;
  updatedAt: string;
}

interface BuffrGlobalItem {
  id: string;
  filename: string;
  path: string;
  category: "identity" | "rules" | "stack" | "skills";
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface BuffrSpecItem {
  id: string;
  category: "features" | "bugs" | "tests" | "phases" | "migrations"
           | "refactors" | "prompts" | "performance" | "integrations";
  filename: string;
  path: string;
  title: string;
  content: string;
  scope: string;
  status: "draft" | "ready" | "in-progress" | "done";
  createdAt: string;
  updatedAt: string;
}

interface ToolIntegration {
  id: string;
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
  name: string;
  label: string;
  model: string;
}
```

---

## 6. .buffr Directory Structure

```
.buffr/
  global/              -- who you are -- global, all projects
    identity.md
    rules.md
    stack.md
    skills.md
    adapters/          -- IDE-specific context files (symlinked to root)
      CLAUDE.md
      .cursorrules
      copilot-instructions.md
      .windsurfrules
      .aider.conf.yml
      .continuerules

  project/             -- what this project is -- per-project, AI-generated
    context.md

  specs/               -- what you're doing now -- per task
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

## 7. Features

### 7.1 Authentication

- Single-user login (credentials from env vars)
- JWT stored in HTTP-only cookie, 7-day expiry
- Next.js middleware redirects unauthenticated users to `/login`

### 7.2 Dashboard

- Lists all projects sorted by `updatedAt` (most recent first)
- Each project card shows: name, phase badge, stack, time since update, data source icons, pending next actions (up to 3)
- "Load Existing" button opens GitHub import modal
- Delete project with confirmation modal

### 7.3 GitHub Import

- Accepts `owner/repo`, full GitHub URLs, or `.git` URLs
- Analyzes repository: detects frameworks, dev tools, test presence, CI, deploy config
- Auto-detects project phase: idea (<5 files), mvp (default), polish (tests + CI/deploy), deploy (all three)
- Handles GitHub repo renames/redirects transparently

### 7.4 Project Page

Tabbed interface with header showing project metadata, health, and actions.

**Header:**
- Multi-project nav bar with health dots (green = active this week, yellow = needs attention)
- Activity timestamps: last session, last commit, last sync
- Project name, phase badge, stack, GitHub link, site link
- Sync button (re-analyzes repo + regenerates project context) and End Session button

**Smart Suggestions:**
- Up to 2 contextual suggestion cards (dismissable, persisted)
- Rules: no data sources -> suggest connecting, no sessions -> suggest starting, idle >14 days -> suggest resuming

**Detected Intent:**
- Shows AI-detected intent from last session (e.g., "authentication feature")

**Tabs:**

#### Next Actions Tab
- Task list with add, edit, delete, reorder (drag-and-drop), mark done
- AI rewrite: plain rewrite or persona-based (User Story, Backend Dev, Frontend Dev, Stakeholder, Project Manager)
- "Spec" button on each action -> opens SpecBuilderModal to generate a spec from the todo
- Purple "spec" badge on actions that have a linked spec -> navigates to .buffr/specs tab
- Optimistic UI with rollback on server failure and toast notifications
- Completed tasks feed into End Session summaries, then get cleaned up
- Tasks persist across sessions

#### Last Session Tab
- Displays goal, what changed (bulleted), blockers, timestamp
- Read-only view of the most recent session

#### .buffr/project Tab
- AI-generated project context (context.md)
- "Generate Context" / "Regenerate" button triggers AI analysis of project + sessions + repo
- Inline edit mode for manual refinement
- Push to GitHub at `.buffr/project/context.md`
- Auto-regenerates when user clicks sync button

#### .buffr/global Tab
- CRUD for global context files (identity, rules, stack, skills)
- Category filter with counts and color-coded badges
- Search by title or filename
- Inline expand to preview content
- Push to GitHub with adapter selection:
  - Claude Code -> `CLAUDE.md` (symlinked from `.buffr/global/adapters/`)
  - Cursor -> `.cursorrules`
  - Copilot -> `.github/copilot-instructions.md`
  - Windsurf -> `.windsurfrules`
  - Aider -> `.aider.conf.yml`
  - Continue -> `.continuerules`

#### .buffr/specs Tab
- CRUD for spec files organized by 9 categories
- Category filter + status filter (draft / ready / in-progress / done)
- Inline status update buttons in expanded view
- Directory group headers by category
- Scoped to current project
- Push to GitHub at `.buffr/specs/{category}/{filename}`
- Wide modal for editing

#### Tools Tab
- Integration management (currently: GitHub)
- Default data sources for new projects
- Configure integration tokens
- Test tool execution with JSON input
- Tool registry with search and filter

### 7.5 End Session Modal

Multi-phase flow:

1. **Fetching** -- Pulls GitHub commits from last 24 hours + completed manual actions
2. **Summarizing** -- Sends activity items to AI for summarization
3. **Ready** -- Editable form:
   - Goal (1 sentence, required)
   - What Changed (multi-line, AI-summarizable)
   - Blockers (optional)
   - Save creates session, updates project's lastSessionId, detects intent, cleans completed manual actions

### 7.6 Spec Builder Modal

Multi-step flow triggered from any Next Actions item:

1. **Type Selection** -- Auto-detected spec type with override dropdown (9 categories)
2. **Generating** -- Loading state while agent runs
3. **Preview** -- Full spec content in editable textarea, shows validation gaps
4. **Saved** -- Confirmation with spec path

### 7.7 AI Features

All AI features use the selected LLM provider (switchable in nav).

| Feature | Chain | Input | Output |
|---------|-------|-------|--------|
| Session Summarize | `createSummarizeChain` | Activity items | `{ goal, bullets[] }` |
| Intent Detection | `createIntentChain` | Goal, what changed, phase | `{ intent }` |
| Task Paraphrase | `createParaphraseChain` | Text, optional persona | `{ text }` |
| Context Generation | `createContextChain` | Project + sessions + repo | `{ title, content }` |
| Spec Building | `runSpecAgent` | Intent + projectId | `{ spec, path, gaps }` |

Supported providers: Anthropic Claude, OpenAI GPT, Google Gemini, Ollama (local).

### 7.8 Agent System

Tool-calling agent that builds specs from todo items:

```
loadContext -> selectTemplate -> buildSpec -> validateSpec -> saveSpec
```

- **loadContext** -- Reads project context from DB
- **selectTemplate** -- Classifies intent into spec category via keyword matching
- **buildSpec** -- LLM generates filled-in spec from template + context
- **validateSpec** -- Checks required sections per category
- **saveSpec** -- Creates BuffrSpecItem with unique filename (conflict resolution)

All agent turns stored in `conversations` + `messages` tables for tracing.

### 7.9 Tool System

Extensible integration architecture:

- **Registry**: Tools register with name, description, input schema, execute function
- **Execution**: `POST /tools?execute` runs any registered tool by name
- **Data Source Mapping**: `data-sources.ts` maps capabilities to tool names

GitHub tools: `github_get_repo`, `github_list_issues`, `github_list_repos`, `github_analyze_repo`, `github_create_repo`, `github_push_files`, `github_create_issue`, `github_close_issue`, `github_list_commits`, `github_get_diffs`, `github_get_file`

### 7.10 Project Health

- Computed per-project based on sessions, last sync, last commit
- "Needs attention" if no activity in the current calendar week
- Displayed as colored dots in the multi-project nav

---

## 8. API Reference

All endpoints at `/.netlify/functions/`.

### Auth

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/auth-check` | -- | `{ authenticated }` |
| POST | `/login` | `{ username, password }` | Sets cookie |
| POST | `/logout` | -- | Clears cookie |

### Projects

| Method | Endpoint | Body/Params | Response |
|--------|----------|-------------|----------|
| GET | `/projects` | -- | `Project[]` |
| GET | `/projects?id=X` | -- | `Project` |
| POST | `/projects` | `Partial<Project>` | `Project` (201) |
| PUT | `/projects?id=X` | Allowed fields | `Project` |
| DELETE | `/projects?id=X` | -- | `{ ok }` |

### Sessions

| Method | Endpoint | Body/Params | Response |
|--------|----------|-------------|----------|
| GET | `/sessions?projectId=X` | -- | `Session[]` |
| POST | `/sessions` | `{ projectId, goal, whatChanged[], blockers? }` | `Session` (201) |
| DELETE | `/sessions?id=X` | -- | `{ ok }` |

### Manual Actions

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/manual-actions?projectId=X` | -- | `ManualAction[]` |
| POST | `/manual-actions?projectId=X` | `{ id, text }` | `ManualAction[]` (201) |
| PUT | `/manual-actions?projectId=X` | `{ id, done?, text? }` | `ManualAction[]` |
| PATCH | `/manual-actions?projectId=X` | `{ orderedIds }` | `ManualAction[]` |
| DELETE | `/manual-actions?projectId=X&actionId=Y` | -- | `ManualAction[]` |
| DELETE | `/manual-actions?projectId=X&cleanDone` | -- | `ManualAction[]` |

### Buffr Context

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/buffr-context?projectId=X` | -- | `BuffrContextItem[]` |
| POST | `/buffr-context?generate` | `{ projectId, provider? }` | `BuffrContextItem` (201) |
| PUT | `/buffr-context?id=X` | `{ content?, title? }` | `BuffrContextItem` |
| POST | `/buffr-context?push` | `{ projectId, repo }` | `{ sha }` |

### Buffr Global

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/buffr-global` | -- | `BuffrGlobalItem[]` |
| POST | `/buffr-global` | `{ title, content, category, filename? }` | `BuffrGlobalItem` (201) |
| POST | `/buffr-global?push` | `{ repo, adapterIds? }` | `{ sha }` |
| PUT | `/buffr-global?id=X` | `{ title?, content?, category?, filename? }` | `BuffrGlobalItem` |
| DELETE | `/buffr-global?id=X` | -- | `{ ok }` |

### Buffr Specs

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/buffr-specs?scope=projectId` | -- | `BuffrSpecItem[]` |
| POST | `/buffr-specs` | `{ title, content, category, status?, filename?, scope }` | `BuffrSpecItem` (201) |
| POST | `/buffr-specs?push` | `{ projectId, repo }` | `{ sha }` |
| PUT | `/buffr-specs?id=X` | `{ title?, content?, category?, status?, filename? }` | `BuffrSpecItem` |
| DELETE | `/buffr-specs?id=X` | -- | `{ ok }` |

### Buffr Agent

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | `/buffr-agent?buildSpec` | `{ intent, projectId, answers?, provider? }` | `{ spec, path, gaps[], conversationId }` |

### Session AI

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | `/session-ai?summarize` | `{ activityItems[], provider? }` | `{ goal, bullets[] }` |
| POST | `/session-ai?intent` | `{ goal, whatChanged, projectPhase, provider? }` | `{ intent }` |
| POST | `/session-ai?paraphrase` | `{ text, provider?, persona? }` | `{ text }` |

### Tools

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/tools` | -- | `ToolIntegration[]` |
| POST | `/tools?execute` | `{ toolName, input }` | `{ ok, result?, error? }` |
| PUT | `/tools?integrationId=X` | `{ values, enabled }` | `ToolConfig` |
| DELETE | `/tools?integrationId=X` | -- | `{ ok }` |
| GET | `/tools?defaultSources` | -- | `{ sources }` |
| PUT | `/tools?defaultSources` | `{ sources }` | `{ sources }` |

### Providers

| Method | Endpoint | Response |
|--------|----------|----------|
| GET | `/providers` | `{ providers: LLMProvider[], defaultProvider }` |

---

## 9. Design System

### Palette

| Token | Value | Usage |
|-------|-------|-------|
| Background | `#09090b` | Page background |
| Foreground | `#e4e4e7` | Primary text |
| Muted | `#a1a1aa` | Secondary text |
| Border | `rgba(63, 63, 70, 0.6)` | Borders |
| Card | `rgba(24, 24, 27, 0.3)` | Card backgrounds |
| Accent | `#7c3aed` | Purple accent / primary actions |
| Success | `#34d399` | Emerald green |
| Warning | `#fbbf24` | Amber |
| Error | `#ef4444` | Red |

### Phase Colors

| Phase | Color |
|-------|-------|
| idea | `#fbbf24` (amber) |
| mvp | `#818cf8` (indigo) |
| polish | `#34d399` (emerald) |
| deploy | `#f472b6` (pink) |

### Spec Category Colors

| Category | Color |
|----------|-------|
| features | `#34d399` |
| bugs | `#ef4444` |
| tests | `#fbbf24` |
| phases | `#818cf8` |
| migrations | `#f472b6` |
| refactors | `#38bdf8` |
| prompts | `#c084fc` |
| performance | `#fb923c` |
| integrations | `#22d3ee` |

### Typography

| Role | Font |
|------|------|
| Body | DM Sans (400, 500, 600, 700) |
| Mono | JetBrains Mono |

### Conventions

- BEM-like CSS class naming: `component__element--modifier`
- CSS files per component using `@apply` (not inline Tailwind)
- All icons are inline SVG components from `icons.tsx`
- Animations: `fadeIn` (0.2s ease-out), `slideDown` (0.15s ease-out)

---

## 10. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | At least one LLM | Anthropic Claude API key |
| `ANTHROPIC_MODEL` | No | Model override (default: `claude-sonnet-4-20250514`) |
| `OPENAI_API_KEY` | At least one LLM | OpenAI API key |
| `OPENAI_MODEL` | No | Model override (default: `gpt-4o`) |
| `GOOGLE_API_KEY` | At least one LLM | Google Gemini API key |
| `GOOGLE_MODEL` | No | Model override (default: `gemini-1.5-pro`) |
| `OLLAMA_BASE_URL` | At least one LLM | Ollama server URL |
| `OLLAMA_MODEL` | No | Model override (default: `llama3`) |
| `DEFAULT_LLM_PROVIDER` | No | Default provider (default: `anthropic`) |
| `GITHUB_TOKEN` | For GitHub features | Personal Access Token with `repo` scope |
| `AUTH_USERNAME` | Yes | Login username |
| `AUTH_PASSWORD` | Yes | Login password |
| `AUTH_SECRET` | Yes | JWT signing secret |
| `NETLIFY_TOKEN` | For deploy features | Netlify Personal Access Token |
| `NETLIFY_DATABASE_URL` | Yes | Neon Postgres connection string |

---

## 11. Error Handling

The `classifyError` utility maps provider errors to user-friendly messages:

| Error Pattern | Status | Message |
|---------------|--------|---------|
| `credit balance is too low` | 402 | Insufficient credits |
| `API key` / `authentication` | 401 | Invalid API key |
| `rate limit` | 429 | Rate limited |
| `already exists` | 422 | Name conflict |
| `not configured` / missing token | 400 | Configuration missing |

Manual action mutations use optimistic UI with rollback on failure and toast notifications via `NotificationProvider`.
