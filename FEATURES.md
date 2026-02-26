# Feature List — buffr

**Application:** buffr
**Type:** Web app (Next.js frontend + Netlify Functions backend)
**Description:** Developer productivity hub that tracks projects, work sessions, and momentum. Aggregates work items from GitHub/Notion/Jira, provides AI-powered session summaries and next-step suggestions, and manages a reusable prompt library with LLM execution.
**Tech Stack:** Next.js 16 (App Router), TypeScript, Tailwind CSS, Netlify Functions v2, Netlify Blobs (KV storage), LangChain.js, GitHub/Notion/Jira REST APIs
**User Roles:** Single authenticated user (no multi-tenancy; auth is via environment-level API tokens)

---

## Feature Table

| # | Module | Feature | Description | User Role | Priority | Category |
|---|--------|---------|-------------|-----------|----------|----------|
| 1 | Dashboard | Project list | Display all projects sorted by last updated | User | Critical | Functional |
| 2 | Dashboard | Loading skeleton | Show animated placeholder cards while projects load | User | Low | UI/UX |
| 3 | Dashboard | Empty state | Show message when no projects exist | User | Medium | UI/UX |
| 4 | Dashboard | Quick action: Prompts | Navigate to prompt library from dashboard | User | Medium | Functional |
| 5 | Dashboard | Quick action: Tools | Navigate to tools page from dashboard | User | Medium | Functional |
| 6 | Dashboard | Project card | Show project name, phase badge, stack, GitHub repo link, Netlify URL, time since update | User | High | UI/UX |
| 7 | Dashboard | Project card click | Navigate to project detail page | User | Critical | Functional |
| 8 | Projects API | List projects | `GET /projects` — return all projects from Netlify Blobs | User | Critical | Functional |
| 9 | Projects API | Get project | `GET /projects?id=` — return single project by ID | User | Critical | Functional |
| 10 | Projects API | Create project | `POST /projects` — create project with auto-generated ID and timestamp | User | Critical | Functional |
| 11 | Projects API | Update project | `PUT /projects?id=` — partial update, auto-set updatedAt | User | Critical | Functional |
| 12 | Projects API | Delete project | `DELETE /projects?id=` — remove project from store | User | High | Functional |
| 13 | Project Detail | Resume Card | Main workspace showing project header, tabs, and session controls | User | Critical | Functional |
| 14 | Project Detail | Phase badge | Display current phase (idea/mvp/polish/deploy) with color variant | User | Medium | UI/UX |
| 15 | Project Detail | GitHub link | Clickable link to project's GitHub repo | User | Medium | UI/UX |
| 16 | Project Detail | Netlify site link | Clickable link to project's deployed site | User | Low | UI/UX |
| 17 | Sessions | Last Session tab | Display goal, what changed, next step, blockers, and intent badge from most recent session | User | Critical | Functional |
| 18 | Sessions | End Session modal | Form to log goal, what changed, next step, and blockers | User | Critical | Functional |
| 19 | Sessions | AI Auto-fill (summarize) | Button to auto-generate "what changed" bullets from activity items via LLM | User | High | Functional |
| 20 | Sessions | AI Suggest next step | Button to generate next step suggestion via LLM | User | High | Functional |
| 21 | Sessions | AI Intent detection | Auto-detect intent on session save (non-blocking) | User | Medium | Functional |
| 22 | Sessions | Intent badge | Show detected intent tag on session tab | User | Low | UI/UX |
| 23 | Sessions API | List sessions | `GET /sessions?projectId=` — return sessions sorted by creation date | User | Critical | Functional |
| 24 | Sessions API | Create session | `POST /sessions` — save session with AI fields (aiSummary, detectedIntent, suggestedNextStep) | User | Critical | Functional |
| 25 | Sessions API | Delete session | `DELETE /sessions?id=` — remove session | User | Medium | Functional |
| 26 | Session AI API | Summarize activity | `POST /session-ai?summarize` — LLM chain to produce bullet summary | User | High | Integration |
| 27 | Session AI API | Detect intent | `POST /session-ai?intent` — LLM chain to classify session intent | User | Medium | Integration |
| 28 | Session AI API | Suggest next step | `POST /session-ai?suggest` — LLM chain to recommend next work | User | High | Integration |
| 29 | Work Items | Open Items tab | Show aggregated work items from all configured data sources | User | Critical | Functional |
| 30 | Work Items | Source badges | Display source label (GitHub/Notion/Jira) per work item | User | Medium | UI/UX |
| 31 | Work Items | Multi-source fetch | Fetch open items from each enabled data source via tool execution | User | High | Integration |
| 32 | Work Items | Empty state | Show message when no data sources configured or no items found | User | Medium | UI/UX |
| 33 | Data Sources | Data source checkboxes | Toggle GitHub/Notion/Jira as active data sources per project | User | High | Functional |
| 34 | Data Sources | Persist selection | Save data source selections to project via API | User | High | Functional |
| 35 | Data Sources | Capability mapping | Route capabilities (list_open_items, create_item, etc.) to correct tool per integration | User | High | Functional |
| 36 | Next Actions | Actions tab | Display prioritized next actions with done/skip controls | User | Critical | Functional |
| 37 | Next Actions | AI-suggested actions | Show actions from AI with sparkle icon | User | High | UI/UX |
| 38 | Next Actions | Session-derived actions | Generate action from last session's next step | User | High | Functional |
| 39 | Next Actions | Issue-derived actions | Generate actions from open work items | User | High | Functional |
| 40 | Next Actions | Activity-based actions | Show "resume project" prompt when idle > 7 days | User | Medium | Functional |
| 41 | Next Actions | Action deduplication | Prevent duplicate actions by ID | User | Medium | Functional |
| 42 | Next Actions | Action limit | Cap at 3 actions maximum | User | Low | Functional |
| 43 | Next Actions | Action notes | Add/edit persistent notes per action | User | Medium | Functional |
| 44 | Action Notes API | Get notes | `GET /action-notes?projectId=` — return all notes for project | User | Medium | Functional |
| 45 | Action Notes API | Save note | `PUT /action-notes?projectId=` — update individual action note | User | Medium | Functional |
| 46 | Suggestions | Suggestions bar | Display contextual project suggestions above tabs | User | Medium | Functional |
| 47 | Suggestions | Connect data source | Suggest enabling a data source when none configured (requires connected integration) | User | Medium | Functional |
| 48 | Suggestions | First session | Suggest starting first session when none exist | User | Medium | Functional |
| 49 | Suggestions | Idle project | Suggest resuming when idle > 14 days | User | Low | Functional |
| 50 | Suggestions | Add prompts | Suggest adding prompts to library | User | Low | Functional |
| 51 | Suggestions | Dismiss suggestion | Persist dismissal to project record | User | Medium | Functional |
| 52 | Suggestions | Suggestion limit | Cap at 2 suggestions maximum | User | Low | Functional |
| 53 | Prompts | Prompts page | List all prompts with search, tag filter, and sort | User | High | Functional |
| 54 | Prompts | Create prompt | Modal form with title, body, tags, scope (global or project) | User | High | Functional |
| 55 | Prompts | Edit prompt | Inline edit of existing prompt | User | High | Functional |
| 56 | Prompts | Delete prompt | Remove prompt from library | User | Medium | Functional |
| 57 | Prompts | Search prompts | Filter by title, body, or tags | User | Medium | Functional |
| 58 | Prompts | Sort by Recent/Most Used | Toggle sort order on prompts page | User | Medium | UI/UX |
| 59 | Prompts | Usage count badge | Display how many times each prompt has been run | User | Low | UI/UX |
| 60 | Prompts | Tag filter | Click tag to filter prompts list | User | Medium | UI/UX |
| 61 | Prompts | Copy to clipboard | One-click copy of resolved prompt body | User | High | Functional |
| 62 | Prompts | Template variables | Resolve `{{project.name}}`, `{{project.stack}}`, `{{lastSession.goal}}`, `{{issues}}` | User | High | Functional |
| 63 | Prompts | Tool syntax hint | Show `{{tool:toolName}}` documentation in create/edit modal | User | Low | UI/UX |
| 64 | Prompts | Prompts tab (project) | Project-scoped prompts with Run button and response display | User | High | Functional |
| 65 | Prompts | Run prompt | Execute prompt through LLM with variable + tool resolution | User | Critical | Functional |
| 66 | Prompts | Suggested actions | Display tool action buttons from LLM response | User | High | Functional |
| 67 | Prompts | Increment usage count | Track prompt executions on each run | User | Low | Functional |
| 68 | Prompts API | List prompts | `GET /prompts` — optionally filtered by scope | User | High | Functional |
| 69 | Prompts API | Create prompt | `POST /prompts` — with auto ID and timestamps | User | High | Functional |
| 70 | Prompts API | Update prompt | `PUT /prompts?id=` — partial update | User | High | Functional |
| 71 | Prompts API | Delete prompt | `DELETE /prompts?id=` — remove prompt | User | Medium | Functional |
| 72 | Run Prompt API | Execute prompt | `POST /run-prompt` — load, resolve variables, resolve `{{tool:...}}` tokens, run through LLM, return text + suggested actions | User | Critical | Integration |
| 73 | Run Prompt API | Tool token resolution | Server-side `{{tool:toolName:input}}` execution and injection | User | High | Integration |
| 74 | Tools | Tools page | List all builtin and custom integrations with status | User | High | Functional |
| 75 | Tools | Integration status | Show Connected / Error / Not Configured per integration | User | High | UI/UX |
| 76 | Tools | Configure integration | Modal to enter credentials (tokens, URLs, keys) | User | Critical | Functional |
| 77 | Tools | Secret field masking | Mask secret config fields with password input type | User | High | Security |
| 78 | Tools | Test tool | Modal to execute any tool with custom input and view output | User | High | Functional |
| 79 | Tools | Remove integration | Delete custom integration and its config | User | Medium | Functional |
| 80 | Tools | Add custom integration | Modal to define name, description, and config fields | User | Medium | Functional |
| 81 | Tools | Tool list per integration | Expand to see all registered tools with descriptions | User | Medium | UI/UX |
| 82 | Tools API | List integrations | `GET /tools` — return all integrations with status, tools, and config fields | User | High | Functional |
| 83 | Tools API | Execute tool | `POST /tools?execute` — run tool by name with input params | User | Critical | Functional |
| 84 | Tools API | Save config | `PUT /tools?integrationId=` — save credentials and enabled state | User | High | Functional |
| 85 | Tools API | Create custom integration | `POST /tools?create` — register new integration | User | Medium | Functional |
| 86 | Tools API | Remove integration | `DELETE /tools?integrationId=` — delete integration and config | User | Medium | Functional |
| 87 | GitHub Integration | List issues | Fetch open issues (excludes PRs) as WorkItems | User | High | Integration |
| 88 | GitHub Integration | Create issue | Create issue with title, body, labels | User | Medium | Integration |
| 89 | GitHub Integration | Close issue | Close issue by number | User | Medium | Integration |
| 90 | GitHub Integration | List commits | Fetch commits since a given date | User | Medium | Integration |
| 91 | GitHub Integration | Get diffs | Fetch diffs between two refs | User | Medium | Integration |
| 92 | GitHub Integration | Analyze repo | Detect stack, frameworks, dev tools, maturity phase | User | High | Integration |
| 93 | GitHub Integration | List repos | List all user repositories | User | Medium | Integration |
| 94 | GitHub Integration | Get repo info | Fetch repo metadata (name, default branch, last commit) | User | Medium | Integration |
| 95 | GitHub Integration | Create repo | Create new repository | User | Medium | Integration |
| 96 | GitHub Integration | Push files | Push files to repo with commit message via Git tree API | User | Medium | Integration |
| 97 | Notion Integration | List tasks | Query database with optional status filter | User | High | Integration |
| 98 | Notion Integration | Get task | Fetch single page/task by ID | User | Medium | Integration |
| 99 | Notion Integration | Create task | Create new task with title and status | User | Medium | Integration |
| 100 | Notion Integration | Update task | Update task properties (title, status) | User | Medium | Integration |
| 101 | Jira Integration | List issues | Search open issues with optional JQL | User | High | Integration |
| 102 | Jira Integration | List resolved | Fetch recently resolved issues | User | Medium | Integration |
| 103 | Jira Integration | Get issue | Fetch issue by key | User | Medium | Integration |
| 104 | Jira Integration | Create issue | Create issue with summary, description, type, labels | User | Medium | Integration |
| 105 | Jira Integration | Transition issue | Move issue to new status | User | Medium | Integration |
| 106 | LLM Providers | Provider switcher | Dropdown to select active LLM provider | User | High | Functional |
| 107 | LLM Providers | Persist selection | Save provider choice to localStorage | User | Medium | Functional |
| 108 | LLM Providers | Provider availability | Show only providers with configured API keys | User | High | Functional |
| 109 | LLM Providers | Anthropic (Claude) | Support Claude models via LangChain | User | Critical | Integration |
| 110 | LLM Providers | OpenAI (GPT) | Support GPT models via LangChain | User | High | Integration |
| 111 | LLM Providers | Google (Gemini) | Support Gemini models via LangChain | User | High | Integration |
| 112 | LLM Providers | Ollama (local) | Support local Ollama models via LangChain | User | Medium | Integration |
| 113 | LLM Providers API | Get providers | `GET /providers` — return configured providers and default | User | High | Functional |
| 114 | Command Palette | Open with Cmd+K | Keyboard shortcut to toggle palette | User | High | UI/UX |
| 115 | Command Palette | Search commands | Filter commands and prompts by text | User | High | Functional |
| 116 | Command Palette | Navigate pages | Jump to Prompts, Tools, Dashboard | User | Medium | Functional |
| 117 | Command Palette | Copy prompts | Search prompts and copy to clipboard | User | Medium | Functional |
| 118 | Command Palette | Usage-sorted prompts | Prompts sorted by usage count descending | User | Low | UI/UX |
| 119 | Command Palette | Keyboard navigation | Arrow keys + Enter to select, Escape to close | User | High | Accessibility |
| 120 | Command Palette | Click-outside dismiss | Close palette when clicking overlay | User | Medium | UI/UX |
| 121 | Navigation | Nav bar | Sticky header with buffr logo, provider switcher, and Cmd+K hint | User | High | UI/UX |
| 122 | Navigation | Dynamic routing | `/project/[id]` route for project detail | User | Critical | Functional |
| 123 | Notifications | Toast notifications | In-app notification system via NotificationProvider | User | Medium | UI/UX |
| 124 | Error Handling | API error parsing | Parse JSON error messages from backend responses | User | High | Functional |
| 125 | Error Handling | Classify error | Backend utility mapping error types to HTTP status codes | User | High | Functional |
| 126 | Error Handling | Network failure graceful fallback | `.catch()` on all parallel fetches to prevent cascade failures | User | High | Functional |
| 127 | Error Handling | 404 page | Next.js default not-found page | User | Medium | UI/UX |
| 128 | Storage | Netlify Blobs | 7 KV stores: projects, sessions, prompt-library, action-notes, tool-config, custom-integrations, settings | User | Critical | Functional |
| 129 | Storage | Auto timestamps | Automatic `updatedAt`/`createdAt` on all write operations | User | Medium | Functional |
| 130 | Storage | Sorted retrieval | Projects by updatedAt desc, sessions by createdAt desc | User | Medium | Functional |
| 131 | Resolve Tools | Server-side tool execution | `{{tool:toolName}}` or `{{tool:toolName:jsonInput}}` resolved before LLM call | User | High | Functional |
| 132 | Resolve Tools | Reverse-order processing | Process tool tokens in reverse to preserve string positions | User | Low | Functional |

---

## Summary by Priority

| Priority | Count |
|----------|-------|
| Critical | 17 |
| High | 52 |
| Medium | 44 |
| Low | 19 |
| **Total** | **132** |

## Summary by Category

| Category | Count |
|----------|-------|
| Functional | 82 |
| Integration | 27 |
| UI/UX | 18 |
| Security | 1 |
| Accessibility | 1 |
| Performance | 0 |
| **Total** | **132** |

---

## Blind Spots

Areas that cannot be fully assessed without more information:

1. **Authentication & Authorization** — No login/signup/session management visible in the codebase. Auth appears to be environment-level (API tokens). Is there planned user authentication? Multi-user support?

2. **Rate Limiting** — No rate limiting middleware detected on Netlify Functions. Are there plans to limit LLM calls or API usage?

3. **Input Validation / Sanitization** — Backend functions accept JSON bodies with minimal validation. Are there constraints on field lengths, XSS protection on stored content, or CSRF protections?

4. **Concurrent Users / Data Conflicts** — Netlify Blobs has no built-in concurrency control. What happens with simultaneous writes to the same project/session?

5. **Billing / LLM Cost Management** — LLM API calls (Anthropic, OpenAI, Google) incur costs. Is there usage tracking or budget limits?

6. **Offline / Disconnected State** — What happens when the user loses network connectivity mid-session?

7. **Browser Support Matrix** — No polyfills or compatibility targets specified. What browsers must be supported?

8. **Mobile Responsiveness** — Tailwind is used but no explicit responsive breakpoints or mobile-specific layouts were observed beyond default behavior.

9. **Performance Targets** — No explicit performance budgets. What are acceptable load times for dashboard, tool execution, and LLM calls?

10. **Error Recovery** — If an LLM provider is down or returns an error mid-chain, is there fallback behavior or retry logic?

11. **Data Backup / Export** — No data export feature detected. Can users back up their projects, sessions, or prompts?

12. **Notion/Jira Database Schema** — Notion and Jira integrations assume specific property names (e.g., "Status", "Name" for Notion pages). What if the user's database schema differs?

---

## Assumptions

1. **Single-user application** — No multi-tenancy or auth system; the app is used by one developer with their own API tokens configured in environment variables.
2. **GitHub token has repo scope** — The GITHUB_TOKEN has sufficient permissions for all GitHub operations (repo CRUD, issue management, commit listing).
3. **Notion database has standard properties** — Title property exists; Status property is either a "status" or "select" type.
4. **Jira uses REST API v3** — Basic Auth with email + API token is the authentication method.
5. **LLM providers are pre-configured** — At least one provider API key is set in environment variables before the app is used.
6. **Netlify Blobs is the sole persistence layer** — No external database; all data lives in Netlify Blobs KV stores.
7. **No file upload/download features** — The app doesn't handle user file uploads (push-to-repo is programmatic, not user-uploaded files).
8. **No email/push notifications** — The only notifications are in-app toasts via NotificationProvider.
9. **Desktop-first design** — The UI is optimized for desktop browser use, with mobile as secondary.
10. **All tool executions are synchronous** — Tool execution via `/tools?execute` returns results in a single request/response cycle.
