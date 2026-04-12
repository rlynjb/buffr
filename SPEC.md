# buffr — Product Spec

> Developer continuity and momentum tool. Flow preserver, setup eliminator, and structured idea helper.

---

## 1. Product Overview

### What buffr Is

buffr is a single-user developer productivity tool that helps maintain continuity across coding sessions. It solves the "where was I?" problem by tracking session history, managing next actions, syncing with GitHub repos, and providing AI-assisted summarization of work.

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
| Storage | Netlify Blobs (key-value) |
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
    session/              ResumeCard, ActionsTab, SessionTab, DevTab, DocTab, ToolsTab
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
  dev-items.ts                             .dev file CRUD + GitHub push
  doc-items.ts                             .doc file CRUD + GitHub push
  session-ai.ts                            AI chains (summarize, intent, paraphrase)
  providers.ts                             Available LLM providers
  tools.ts                                 Integration registry + tool execution
  lib/
    ai/
      provider.ts                          Multi-provider LLM factory
      chains/                              LangChain chains (summarizer, intent, paraphraser)
      prompts/                             System prompts
      parse-utils.ts                       JSON response cleaning
    storage/                               Netlify Blobs wrappers per entity
    tools/                                 Tool registry + GitHub tool definitions
    github.ts                              GitHub API wrapper
    auth.ts                                JWT creation/verification
    responses.ts                           HTTP response helpers + error classification
```

---

## 4. Data Models

### Project

```typescript
interface Project {
  id: string;
  name: string;
  description: string;
  stack: string;
  phase: "idea" | "mvp" | "polish" | "deploy";
  lastSessionId: string | null;
  githubRepo: string | null;        // "owner/repo" format
  netlifySiteUrl: string | null;
  dataSources?: string[];            // e.g., ["github"]
  dismissedSuggestions?: string[];
  lastSyncedAt?: string | null;
  updatedAt: string;
}
```

### Session (per project)

```typescript
interface Session {
  id: string;
  projectId: string;
  goal: string;
  whatChanged: string[];
  blockers: string | null;
  detectedIntent?: string;
  createdAt: string;
}
```

### ManualAction (per project)

```typescript
interface ManualAction {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}
```

### DevItem (global)

```typescript
interface DevItem {
  id: string;
  filename: string;
  path: string;                      // e.g., ".dev/typescript-rules.md"
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}
```

### DocItem (per project)

```typescript
interface DocItem {
  id: string;
  category: "docs" | "ideas" | "plans";
  filename: string;
  path: string;                      // e.g., ".doc/docs/api-auth.md"
  title: string;
  content: string;
  scope: string;                     // project ID
  createdAt: string;
  updatedAt: string;
}
```

### Tool System

```typescript
interface ToolIntegration {
  id: string;                        // "github"
  name: string;
  description: string;
  status: "connected" | "error" | "not_configured";
  tools: ToolDefinition[];
  configFields: { key: string; label: string; secret: boolean }[];
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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

### Storage Schema (Netlify Blobs)

| Store Name | Key | Value Type | Notes |
|------------|-----|------------|-------|
| `projects` | project UUID | `Project` | Sorted by updatedAt on read |
| `sessions` | session UUID | `Session` | Filtered by projectId on read |
| `manual-actions` | project UUID | `ManualAction[]` | All actions for a project in one blob |
| `dev-items` | item UUID | `DevItem` | Global scope (not per-project) |
| `doc-items` | item UUID | `DocItem` | Scoped to project via `scope` field |
| `tool-config` | integration ID | `ToolConfig` | Per-integration settings |
| `settings` | string key | `any` | App-wide settings (e.g., default data sources) |

---

## 5. Features

### 5.1 Authentication

- Single-user login (credentials from env vars)
- JWT stored in HTTP-only cookie, 7-day expiry
- Next.js middleware redirects unauthenticated users to `/login`

### 5.2 Dashboard

- Lists all projects sorted by `updatedAt` (most recent first)
- Each project card shows: name, phase badge, stack, time since update, data source icons, pending next actions (up to 3)
- "Load Existing" button opens GitHub import modal
- Delete project with confirmation modal

### 5.3 GitHub Import

- Accepts `owner/repo`, full GitHub URLs, or `.git` URLs
- Analyzes repository via GitHub API: detects frameworks, dev tools, test presence, CI, deploy config
- Auto-detects project phase: idea (<5 files), mvp (default), polish (tests + CI/deploy), deploy (all three)
- Handles GitHub repo renames/redirects transparently

### 5.4 Project Page

Tabbed interface with header showing project metadata, health, and actions.

**Header:**
- Multi-project nav bar with health dots (green = active this week, yellow = needs attention)
- Activity timestamps: last session, last commit, last sync
- Project name, phase badge, stack, GitHub link, site link
- Sync button (re-analyzes repo) and End Session button

**Smart Suggestions:**
- Up to 2 contextual suggestion cards (dismissable, persisted)
- Rules: no data sources -> suggest connecting, no sessions -> suggest starting, idle >14 days -> suggest resuming

**Detected Intent:**
- Shows AI-detected intent from last session (e.g., "authentication feature")

#### Next Actions Tab

- Task list with add, edit, delete, reorder (drag-and-drop), mark done
- AI rewrite: plain rewrite or persona-based (User Story, Backend Dev, Frontend Dev, Stakeholder, Project Manager)
- Completed tasks feed into End Session summaries, then get cleaned up
- Inline editing with textarea auto-resize
- Optimistic UI with rollback on server failure and toast notifications
- Tasks persist across sessions

#### Last Session Tab

- Displays goal, what changed (bulleted), blockers, timestamp
- Read-only view of the most recent session

#### .dev Tab

- CRUD for `.dev/` files (AI rules, skills, context for coding assistants)
- Global scope — shared across all projects
- Search by title or filename
- Inline expand to preview content
- Push to GitHub with adapter selection:
  - Claude Code -> `CLAUDE.md` (symlinked from `.dev/adapters/`)
  - Cursor -> `.cursorrules`
  - Copilot -> `.github/copilot-instructions.md`
  - Windsurf -> `.windsurfrules`
  - Aider -> `.aider.conf.yml`
  - Continue -> `.continuerules`

#### .doc Tab

- CRUD for `.doc/` files organized by category: Documentation, Ideas, Plans
- Scoped to current project
- Category filter with counts
- Push to GitHub (files go to `.doc/{category}/`)
- Wide modal for editing

#### Tools Tab

- Integration management (currently: GitHub)
- Default data sources for new projects
- Configure integration tokens
- Test tool execution with JSON input
- Tool registry with search and filter

### 5.5 End Session Modal

Multi-phase flow:

1. **Fetching** — Pulls GitHub commits from last 24 hours + completed manual actions
2. **Summarizing** — Sends activity items to AI for summarization
3. **Ready** — Editable form:
   - Goal (1 sentence, required)
   - What Changed (multi-line, AI-summarizable)
   - Blockers (optional)
   - Save creates session, updates project's lastSessionId, detects intent, cleans completed manual actions

### 5.6 AI Features

All AI features use the selected LLM provider (switchable in nav).

| Feature | Chain | Input | Output |
|---------|-------|-------|--------|
| Session Summarize | `createSummarizeChain` | Activity items (title, source, timestamp) | `{ goal, bullets[] }` |
| Intent Detection | `createIntentChain` | Goal, what changed, project phase | `{ intent }` (2-5 words) |
| Task Paraphrase | `createParaphraseChain` | Text, optional persona | `{ text }` (rewritten) |

Supported providers: Anthropic Claude, OpenAI GPT, Google Gemini, Ollama (local).

### 5.7 Tool System

Extensible integration architecture:

- **Registry**: Tools register with name, description, input schema, execute function
- **Execution**: `POST /tools?execute` runs any registered tool by name
- **Data Source Mapping**: `data-sources.ts` maps capabilities to tool names

GitHub tools: `github_get_repo`, `github_list_issues`, `github_list_repos`, `github_analyze_repo`, `github_create_repo`, `github_push_files`, `github_create_issue`, `github_close_issue`, `github_list_commits`, `github_get_diffs`, `github_get_file`

### 5.8 Project Health

- Computed per-project based on sessions, last sync, last commit
- "Needs attention" if no activity in the current calendar week
- Displayed as colored dots in the multi-project nav

---

## 6. API Reference

All endpoints at `/.netlify/functions/`.

### Auth

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/auth-check` | -- | `{ authenticated: boolean }` |
| POST | `/login` | `{ username, password }` | Sets cookie |
| POST | `/logout` | -- | Clears cookie |

### Projects

| Method | Endpoint | Body/Params | Response |
|--------|----------|-------------|----------|
| GET | `/projects` | -- | `Project[]` |
| GET | `/projects?id=X` | -- | `Project` |
| POST | `/projects` | `Partial<Project>` | `Project` (201) |
| PUT | `/projects?id=X` | Allowed fields only | `Project` |
| DELETE | `/projects?id=X` | -- | `{ ok: true }` |

### Sessions

| Method | Endpoint | Body/Params | Response |
|--------|----------|-------------|----------|
| GET | `/sessions?projectId=X` | -- | `Session[]` |
| POST | `/sessions` | `{ projectId, goal, whatChanged[], blockers? }` | `Session` (201) |
| DELETE | `/sessions?id=X` | -- | `{ ok: true }` |

### Manual Actions

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/manual-actions?projectId=X` | -- | `ManualAction[]` |
| POST | `/manual-actions?projectId=X` | `{ id, text }` | `ManualAction[]` (201) |
| PUT | `/manual-actions?projectId=X` | `{ id, done?, text? }` | `ManualAction[]` |
| PATCH | `/manual-actions?projectId=X` | `{ orderedIds }` | `ManualAction[]` |
| DELETE | `/manual-actions?projectId=X&actionId=Y` | -- | `ManualAction[]` |
| DELETE | `/manual-actions?projectId=X&cleanDone` | -- | `ManualAction[]` |

### Dev Items

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/dev-items` | -- | `DevItem[]` |
| POST | `/dev-items` | `{ title, content, filename? }` | `DevItem` (201) |
| POST | `/dev-items?push` | `{ repo, adapterIds? }` | `{ sha }` |
| PUT | `/dev-items?id=X` | `{ title?, content?, filename? }` | `DevItem` |
| DELETE | `/dev-items?id=X` | -- | `{ ok: true }` |

### Doc Items

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/doc-items?scope=projectId` | -- | `DocItem[]` |
| POST | `/doc-items` | `{ title, content, category, filename?, scope }` | `DocItem` (201) |
| POST | `/doc-items?push` | `{ projectId, repo }` | `{ sha }` |
| PUT | `/doc-items?id=X` | `{ title?, content?, category?, filename?, scope? }` | `DocItem` |
| DELETE | `/doc-items?id=X` | -- | `{ ok: true }` |

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
| DELETE | `/tools?integrationId=X` | -- | `{ ok: true }` |
| GET | `/tools?defaultSources` | -- | `{ sources: string[] }` |
| PUT | `/tools?defaultSources` | `{ sources }` | `{ sources }` |

### Providers

| Method | Endpoint | Response |
|--------|----------|----------|
| GET | `/providers` | `{ providers: LLMProvider[], defaultProvider: string }` |

---

## 7. Design System

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

## 8. Environment Variables

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

---

## 9. Error Handling

The `classifyError` utility maps provider errors to user-friendly messages:

| Error Pattern | Status | Message |
|---------------|--------|---------|
| `credit balance is too low` | 402 | Insufficient credits |
| `API key` / `authentication` | 401 | Invalid API key |
| `rate limit` | 429 | Rate limited |
| `already exists` | 422 | Name conflict |
| `not configured` / missing token | 400 | Configuration missing |

Manual action mutations use optimistic UI with rollback on failure and toast notifications via `NotificationProvider`.
