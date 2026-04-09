---
title: context
---
# buffr — Product Spec

> Developer continuity and momentum tool. Flow preserver, setup eliminator, and structured idea helper.

---

## 1. Product Overview

### What buffr Is

buffr is a single-user developer productivity tool that helps maintain continuity across coding sessions. It solves the "where was I?" problem by tracking session history, managing next actions, syncing with GitHub repos, and providing AI-assisted summarization of work.

### Who It's For

Solo developers (specifically: the app owner) managing multiple side projects who need to quickly context-switch between codebases without losing momentum.

### Core Value Loop

**Start session → Work → End session (auto-summarize) → Next session picks up seamlessly**

---

## 2. Architecture

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 + TypeScript + Tailwind CSS v4 |
| Backend | Netlify Functions (serverless) |
| Storage | Netlify Blobs (key-value) |
| AI | LangChain.js with multi-provider support (Anthropic, OpenAI, Google, Ollama) |
| Auth | Single-user JWT (jose) with HTTP-only cookies |
| External APIs | GitHub (Octokit-style fetch wrapper) |
| Deploy Target | Netlify |

### Project Structure

```
src/
  app/                    Next.js App Router pages
    login/                Login page
    project/[id]/         Project detail page
    page.tsx              Dashboard (project list)
    layout.tsx            Root layout with auth + providers
    globals.css           Design tokens + base styles
  components/
    ui/                   Primitives (Button, Input, Modal, Badge, Card, etc.)
    dashboard/            Project cards, import modal
    session/              ResumeCard, ActionsTab, SessionTab, DevTab, DocTab, ToolsTab
    tools/                ConfigModal, TestToolModal
    app-shell.tsx         Auth gate + layout wrapper
    nav.tsx               Top nav with provider switcher + cmd+k
    command-palette.tsx   Global command palette
    icons.tsx             SVG icon components
  context/
    auth-context.tsx      Auth state + login/logout
    provider-context.tsx  LLM provider selection
  lib/
    api.ts                Fetch wrapper for all Netlify Functions
    types.ts              Shared TypeScript interfaces
    constants.ts          Phase colors, source colors
    format.ts             Time formatting utilities
    data-sources.ts       Capability → tool name mapping
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
    github.ts                              GitHub API wrapper (repos, issues, commits, push)
    auth.ts                                JWT creation/verification
    responses.ts                           HTTP response helpers + error classification
```

### Storage Schema (Netlify Blobs)

Each entity type uses its own Blob store. Keys are UUIDs. Values are JSON strings.

| Store Name | Key | Value Type | Notes |
|------------|-----|------------|-------|
| `projects` | project UUID | `Project` | Sorted by updatedAt on read |
| `sessions` | session UUID | `Session` | Filtered by projectId on read (full scan) |
| `manual-actions` | project UUID | `ManualAction[]` | All actions for a project in one blob |
| `dev-items` | item UUID | `DevItem` | Global scope (not per-project) |
| `doc-items` | item UUID | `DocItem` | Scoped to project via `scope` field |
| `tool-config` | integration ID | `ToolConfig` | Per-integration settings |
| `settings` | string key | `any` | App-wide settings (e.g., default data sources) |

---

## 3. Data Models

### Project

```typescript
interface Project {
  id: string;
  name: string;
  description: string;
  stack: string;                           // e.g., "Next.js + TypeScript + Tailwind CSS"
  phase: "idea" | "mvp" | "polish" | "deploy";
  lastSessionId: string | null;
  githubRepo: string | null;               // "owner/repo" format
  netlifySiteUrl: string | null;
  dataSources?: string[];                  // e.g., ["github"]
  dismissedSuggestions?: string[];         // IDs of dismissed suggestion cards
  lastSyncedAt?: string | null;            // ISO timestamp of last GitHub sync
  updatedAt: string;
}
```

### Session

```typescript
interface Session {
  id: string;
  projectId: string;
  goal: string;                            // 1-sentence summary of what was worked on
  whatChanged: string[];                   // List of changes made
  blockers: string | null;                 // Optional blockers
  detectedIntent?: string;                 // AI-detected intent (2-5 words)
  createdAt: string;
}
```

### ManualAction

```typescript
interface ManualAction {
  id: string;
  text: string;
  done: boolean;
}
```

### DevItem (.dev files)

```typescript
interface DevItem {
  id: string;
  filename: string;                        // e.g., "typescript-rules.md"
  path: string;                            // e.g., ".dev/typescript-rules.md"
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}
```

### DocItem (.doc files)

```typescript
interface DocItem {
  id: string;
  category: "docs" | "ideas" | "plans";
  filename: string;
  path: string;                            // e.g., ".doc/docs/api-auth.md"
  title: string;
  content: string;
  scope: string;                           // project ID
  createdAt: string;
  updatedAt: string;
}
```

### Tool System

```typescript
interface ToolIntegration {
  id: string;                              // e.g., "github"
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
```

---

## 4. Features

### 4.1 Authentication

- Single-user login (credentials from env vars `AUTH_USERNAME`, `AUTH_PASSWORD`)
- JWT stored in HTTP-only cookie, 7-day expiry
- Next.js middleware redirects unauthenticated users to `/login`
- Authenticated users redirected away from `/login`

### 4.2 Dashboard

- Lists all projects sorted by `updatedAt` (most recent first)
- Each project card shows: name, phase badge, stack, time since update, data source icons, pending next actions (up to 3)
- "Load Existing" button opens GitHub import modal
- Delete project with confirmation modal
- Projects cached in sessionStorage after creation for instant navigation

### 4.3 GitHub Import

- Accepts `owner/repo`, full GitHub URLs, or `.git` URLs
- Analyzes repository via GitHub API: detects frameworks, dev tools, test presence, CI, deploy config
- Auto-detects project phase: idea (<5 files), mvp (default), polish (tests + CI/deploy), deploy (all three)
- Handles GitHub repo renames/redirects transparently
- Creates project with detected metadata

### 4.4 Project Page — Resume Card

The main project view with tabbed interface:

**Header Section:**
- Multi-project nav bar with health dots (green = active this week, yellow = needs attention)
- Activity timestamps: last session date, last commit date
- Project name, phase badge, stack, GitHub link, site link
- Sync button (re-analyzes repo, updates metadata)
- End Session button

**Smart Suggestions:**
- Up to 2 contextual suggestion cards (dismissable, persisted)
- Rules: no data sources → suggest connecting, no sessions → suggest starting, idle >14 days → suggest resuming, no prompts → suggest adding

**Detected Intent:**
- Shows AI-detected intent from last session (e.g., "authentication feature")

**Tabs:**

#### Next Actions Tab
- Task list with add, edit, delete, reorder (drag-and-drop), mark done
- AI rewrite: plain rewrite or persona-based (User Story, Backend Dev, Frontend Dev, Stakeholder, Project Manager)
- Completed tasks carry over to End Session summaries, then get cleaned up
- Inline editing with textarea auto-resize
- Tasks persist across sessions

#### Last Session Tab
- Displays goal, what changed (bulleted), blockers, timestamp
- Read-only view of the most recent session

#### .dev Tab
- CRUD for `.dev/` files (AI rules, skills, context for coding assistants)
- Search and filter
- Inline expand to preview content
- Push to GitHub with adapter selection:
  - Claude Code → `CLAUDE.md` (symlinked from `.dev/adapters/`)
  - Cursor → `.cursorrules`
  - Copilot → `.github/copilot-instructions.md`
  - Windsurf → `.windsurfrules`
  - Aider → `.aider.conf.yml`
  - Continue → `.continuerules`
- Push creates content files in `.dev/`, adapter files in `.dev/adapters/`, and symlinks from repo root

#### .doc Tab
- CRUD for `.doc/` files organized by category: Documentation, Ideas, Plans
- Category filter with counts
- Scoped to current project
- Push to GitHub (files go to `.doc/{category}/`)
- Search across all docs

#### Tools Tab
- Integration management (currently: GitHub)
- Default data sources for new projects
- Configure integration (token input)
- Test tool execution with JSON input
- Tool registry table: name, description, parameters, source
- Filter by integration, search by name/description

### 4.5 End Session Modal

Multi-phase flow:

1. **Fetching** — Pulls activity from all configured data sources:
   - GitHub commits from last 24 hours
   - GitHub closed issues (recent activity)
   - Completed manual actions
2. **Summarizing** — Sends activity items to AI for summarization
3. **Ready** — Editable form:
   - Goal (1 sentence, required)
   - What Changed (multi-line, AI-summarizable)
   - Blockers (optional)
   - Save creates session, updates project's lastSessionId, cleans completed manual actions

### 4.6 AI Features

All AI features use the selected LLM provider (switchable in nav).

| Feature | Chain | Input | Output |
|---------|-------|-------|--------|
| Session Summarize | `createSummarizeChain` | Activity items (title, source, timestamp) | `{ goal, bullets[] }` |
| Intent Detection | `createIntentChain` | Goal, what changed, project phase | `{ intent }` (2-5 words) |
| Task Paraphrase | `createParaphraseChain` | Text, optional persona | `{ text }` (rewritten) |

Provider factory (`getLLM`) instantiates the correct LangChain model class based on provider name. Available providers are detected from env vars at runtime.

### 4.7 Command Palette

- `Cmd+K` / `Ctrl+K` toggle
- Search across commands
- Keyboard navigation (arrows, enter, escape)
- Commands: Load Existing, End Session, Dashboard

### 4.8 Tool System

Extensible integration architecture:

- **Registry**: Tools register with name, description, input schema, execute function
- **Integrations**: Built-in metadata defines available integrations and their config fields
- **Execution**: `POST /tools?execute` runs any registered tool by name
- **Data Source Mapping**: `data-sources.ts` maps integration capabilities to tool names (e.g., `github.list_commits` → `github_list_commits`)

Currently registered GitHub tools:
- `github_get_repo` — Repo metadata
- `github_list_issues` — Issues (excludes PRs)
- `github_list_repos` — All user repos
- `github_analyze_repo` — Stack/phase detection
- `github_create_repo` — Create new repo
- `github_push_files` — Push files (with symlink support)
- `github_create_issue` / `github_close_issue`
- `github_list_commits` / `github_get_diffs` / `github_get_file`

### 4.9 Project Health

- Computed per-project based on sessions, last sync, last commit
- "Needs attention" if no activity in the current calendar week
- Displayed as colored dots in the multi-project nav

---

## 5. Design System

### Palette

| Token | Value | Usage |
|-------|-------|-------|
| `--color-background` | `#09090b` | Page background |
| `--color-foreground` | `#e4e4e7` | Primary text |
| `--color-muted` | `#a1a1aa` | Secondary text |
| `--color-border` | `rgba(63, 63, 70, 0.6)` | Borders |
| `--color-card` | `rgba(24, 24, 27, 0.3)` | Card backgrounds |
| `--color-accent` | `#7c3aed` | Purple accent / primary actions |
| `--color-success` | `#34d399` | Emerald green |
| `--color-warning` | `#fbbf24` | Amber |
| `--color-error` | `#ef4444` | Red |

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
| Body / Sans | DM Sans (400, 500, 600, 700) |
| Mono / Code | JetBrains Mono |

### Component Conventions

- No border radius on most elements (sharp retro aesthetic) — except specific UI primitives
- BEM-like CSS class naming: `component__element--modifier`
- CSS modules via `.css` files imported per component
- Tailwind used via `@apply` in CSS files, not inline classes
- All icons are inline SVG components from `icons.tsx` (Lucide-inspired)
- Animations: `fadeIn` (0.2s ease-out), `slideDown` (0.15s ease-out)

---

## 6. API Reference

All endpoints are Netlify Functions at `/.netlify/functions/`.

### Auth

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/auth-check` | — | `{ authenticated: boolean }` |
| POST | `/login` | `{ username, password }` | Sets cookie, `{ authenticated: true }` |
| POST | `/logout` | — | Clears cookie |

### Projects

| Method | Endpoint | Body/Params | Response |
|--------|----------|-------------|----------|
| GET | `/projects` | — | `Project[]` |
| GET | `/projects?id=X` | — | `Project` |
| POST | `/projects` | `Partial<Project>` | `Project` (201) |
| PUT | `/projects?id=X` | Allowed fields only | `Project` |
| DELETE | `/projects?id=X` | — | `{ ok: true }` |

### Sessions

| Method | Endpoint | Body/Params | Response |
|--------|----------|-------------|----------|
| GET | `/sessions?id=X` | — | `Session` |
| GET | `/sessions?projectId=X` | — | `Session[]` |
| POST | `/sessions` | `{ projectId, goal, whatChanged[], blockers? }` | `Session` (201) |
| DELETE | `/sessions?id=X` | — | `{ ok: true }` |

### Manual Actions

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/manual-actions?projectId=X` | — | `ManualAction[]` |
| POST | `/manual-actions?projectId=X` | `{ id, text }` | `ManualAction[]` (201) |
| PUT | `/manual-actions?projectId=X` | `{ id, done?, text? }` | `ManualAction[]` |
| PATCH | `/manual-actions?projectId=X` | `{ orderedIds }` | `ManualAction[]` |
| DELETE | `/manual-actions?projectId=X&actionId=Y` | — | `ManualAction[]` |
| DELETE | `/manual-actions?projectId=X&cleanDone` | — | `ManualAction[]` |

### Dev Items

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/dev-items` | — | `DevItem[]` |
| GET | `/dev-items?id=X` | — | `DevItem` |
| POST | `/dev-items` | `{ title, content, filename? }` | `DevItem` (201) |
| POST | `/dev-items?push` | `{ repo, adapterIds? }` | `{ sha }` |
| PUT | `/dev-items?id=X` | `{ title?, content?, filename? }` | `DevItem` |
| DELETE | `/dev-items?id=X` | — | `{ ok: true }` |

### Doc Items

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/doc-items?scope=projectId` | — | `DocItem[]` |
| GET | `/doc-items?id=X` | — | `DocItem` |
| POST | `/doc-items` | `{ title, content, category, filename?, scope }` | `DocItem` (201) |
| POST | `/doc-items?push` | `{ projectId, repo }` | `{ sha }` |
| PUT | `/doc-items?id=X` | `{ title?, content?, category?, filename?, scope? }` | `DocItem` |
| DELETE | `/doc-items?id=X` | — | `{ ok: true }` |

### Session AI

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | `/session-ai?summarize` | `{ activityItems[], provider? }` | `{ goal, bullets[] }` |
| POST | `/session-ai?intent` | `{ goal, whatChanged, projectPhase, provider? }` | `{ intent }` |
| POST | `/session-ai?paraphrase` | `{ text, provider?, persona? }` | `{ text }` |

### Tools

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/tools` | — | `ToolIntegration[]` |
| POST | `/tools?execute` | `{ toolName, input }` | `{ ok, result?, error? }` |
| PUT | `/tools?integrationId=X` | `{ values, enabled }` | `ToolConfig` |
| DELETE | `/tools?integrationId=X` | — | `{ ok: true }` |
| GET | `/tools?defaultSources` | — | `{ sources: string[] }` |
| PUT | `/tools?defaultSources` | `{ sources }` | `{ sources }` |

### Providers

| Method | Endpoint | Response |
|--------|----------|----------|
| GET | `/providers` | `{ providers: LLMProvider[], defaultProvider: string }` |

---

## 7. Error Handling

The `classifyError` utility in `responses.ts` maps provider errors to user-friendly messages:

| Error Pattern | Status | Message |
|---------------|--------|---------|
| `credit balance is too low` | 402 | Insufficient credits |
| `API key` / `authentication` | 401 | Invalid API key |
| `rate limit` | 429 | Rate limited |
| `already exists` | 422 | Name conflict |
| `not configured` / missing token | 400 | Configuration missing |

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
| `DEFAULT_LLM_PROVIDER` | No | Default provider on load (default: `anthropic`) |
| `GITHUB_TOKEN` | For GitHub features | Personal Access Token with `repo` scope |
| `AUTH_USERNAME` | Yes | Login username |
| `AUTH_PASSWORD` | Yes | Login password |
| `AUTH_SECRET` | Yes | JWT signing secret |
| `NETLIFY_TOKEN` | For deploy features | Netlify Personal Access Token |

---

## 9. Known Limitations & TODOs

Extracted from codebase comments and architectural observations:

### Security
- `session-ai` endpoint lacks authentication middleware (publicly accessible)
- No rate limiting on LLM calls
- No CSRF protection on state-mutating endpoints

### Performance
- `listSessionsByProject` fetches ALL sessions and filters in memory — needs indexed storage at scale
- All Blob list operations iterate every key in the store
- No pagination on any list endpoint

### Features
- Focus trap missing on modals (keyboard accessibility)
- No offline support / service worker
- No data export / backup mechanism
- Netlify deploy integration referenced but not implemented
- Prompt library suggested in UI but not built
- `ManualActionData` in API has `createdAt` field not present in storage type

### Architecture
- `require()` used for dynamic imports in provider factory (bundler workaround)
- Tool result types are loosely typed (`unknown`) — needs typed API wrappers
- `.dev` items are global (not scoped to project), while `.doc` items are project-scoped — inconsistency