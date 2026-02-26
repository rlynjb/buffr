# End-User Feature Map — buffr

**Application:** buffr
**Platform:** Web app (self-hosted on Netlify)
**Description:** A developer productivity hub that tracks your projects and work sessions, aggregates tasks from GitHub/Notion/Jira, and uses AI to summarize your work, suggest next steps, and run custom prompts.
**User Roles:** Single user (developer self-hosting the app with their own API keys)

---

## A. First-Time Experience

### Landing / Dashboard (Empty State)
- User sees the buffr header with tagline: "Your projects, sessions, and momentum — all in one place."
- Two quick action buttons: **Prompts** and **Tools**
- Empty state message: "No projects yet. Projects will appear here once created."
- Provider switcher in the nav bar (defaults to first configured LLM provider)
- Keyboard shortcut hint for command palette (Cmd+K / Ctrl+K)

### Initial Setup Required
- User must configure at least one LLM provider API key in environment variables before AI features work
- User must configure a GitHub token for GitHub integration features
- Notion and Jira tokens are optional — features appear only when configured

### No Onboarding Wizard
- No guided tutorial, tooltips, or walkthrough
- User explores features through the dashboard quick actions and command palette

---

## B. Core Features

### 1. Project Management

**What the user sees:**
- Dashboard with project cards showing: name, phase badge (idea/mvp/polish/deploy), tech stack, GitHub repo link, Netlify site link, time since last update

**What the user can do:**
- View all projects on the dashboard
- Click a project card to open the project workspace
- See project metadata: name, description, phase, stack, constraints, goals
- Projects are sorted by most recently updated

---

### 2. Project Workspace (Resume Card)

The main screen where daily work happens. Contains a project header and a tabbed interface with four tabs.

**Project Header:**
- Project name and description
- Phase badge (color-coded: idea, mvp, polish, deploy)
- Clickable GitHub repo link (opens in new tab)
- Clickable Netlify site link (opens in new tab)
- Data source checkboxes (toggle GitHub/Notion/Jira per project)

**Tab: Last Session**
- Shows the most recent work session: goal, what was changed, next step, blockers
- Displays AI-detected intent badge (e.g., "feature", "bugfix", "refactor") if available
- Empty state if no sessions have been logged yet

**Tab: Open Items**
- Aggregated list of open work items from all enabled data sources
- Each item shows: title, source badge (GitHub/Notion/Jira), link
- Count displayed in the tab label
- Empty state with message when no sources are configured or no items exist

**Tab: Next Actions**
- Prioritized list of up to 3 recommended actions
- Actions come from multiple sources, shown with labels:
  - AI-suggested actions (sparkle icon)
  - Session-derived ("Continue: [next step from last session]")
  - Issue-derived (from open work items)
  - Activity-based ("You've been away for X days — review and pick up where you left off")
- Each action has: **Done** button, **Skip** button, expandable **Notes** field
- Notes persist across sessions

**Tab: Prompts**
- Project-scoped prompts from the library
- Each prompt shows: title, resolved preview body, copy button
- **Run** button executes the prompt through the selected LLM
- After running: displays AI response text and suggested action buttons
- Suggested actions can be clicked to execute tools directly

**End Session Button:**
- Opens the End Session modal at the bottom of the workspace

---

### 3. Session Tracking

**End Session Modal — what the user fills out:**
- **Goal** — what were you trying to accomplish?
- **What Changed** — list of things you did (multi-line text)
- **Next Step** — what should you do next time?
- **Blockers** — anything blocking progress (optional)

**AI-Assisted Session Logging:**
- **"Auto-fill with AI"** button next to What Changed — calls the LLM to summarize recent activity into bullet points
- **"AI Suggest"** button next to Next Step — calls the LLM to recommend what to work on next based on context
- Intent detection runs automatically on save (non-blocking) — tags the session with a detected intent

**What happens after saving:**
- Session is stored and becomes the "Last Session" shown in the workspace
- Next actions list updates based on the new session data
- AI-suggested next step appears as top priority action (if generated)

---

### 4. Prompt Library

**Prompts Page — what the user sees:**
- Searchable list of all prompts (global + project-scoped)
- Each prompt shows: title, tags, usage count badge
- Search filters by title, body content, or tags
- Clickable tags to filter the list
- Sort toggle: **Recent** (default) or **Most Used**

**What the user can do:**
- **Create** a new prompt: title, body (with template variables), tags, scope (global or specific project)
- **Edit** any existing prompt
- **Delete** a prompt
- **Copy** a prompt's resolved body to clipboard
- See a hint about template variable syntax: `{{project.name}}`, `{{project.stack}}`, `{{lastSession.goal}}`, `{{issues}}`, `{{tool:toolName}}`

**Template Variables (auto-resolved when copying or running):**
- `{{project.name}}` — current project name
- `{{project.stack}}` — tech stack
- `{{project.description}}` — project description
- `{{lastSession.goal}}` — goal from last session
- `{{lastSession.nextStep}}` — next step from last session
- `{{lastSession.blockers}}` — blockers from last session
- `{{issues}}` — formatted list of open work items
- `{{tool:toolName}}` — executes a tool and injects its output (server-side only, when running)

**Running a Prompt:**
- Click **Run** on any prompt in the project workspace Prompts tab
- The app resolves all variables, executes any `{{tool:...}}` tokens, sends to the selected LLM
- Response displays inline with the prompt
- If the LLM suggests tool actions, they appear as clickable buttons below the response

---

### 5. Data Source Configuration

**Per-project data source checkboxes:**
- Toggle which integrations feed into the Open Items tab
- Options: GitHub, Notion, Jira (only shown if the integration is connected)
- Selection persists to the project record

**How it works:**
- When GitHub is enabled and the project has a linked repo, open issues are fetched
- When Notion is enabled and configured, tasks from the Notion database are fetched
- When Jira is enabled and configured, open issues from the Jira project are fetched
- All items are merged into a single "Open Items" list with source badges

---

## C. Secondary Features

### 6. Tools & Integrations Page

**What the user sees:**
- List of all integrations: GitHub, Notion, Jira, plus any custom integrations
- Each integration shows: name, description, status badge (Connected / Error / Not Configured)
- Expandable list of available tools per integration with descriptions

**What the user can do:**
- **Configure** an integration: enter API tokens, URLs, database IDs via a credentials modal
- **Test** any individual tool: input parameters, see raw output
- **Enable/disable** integrations
- **Remove** a custom integration (and its stored config)
- **Add a custom integration**: define name, description, and config fields

**Secret handling:**
- Credential fields marked as secret are displayed as password inputs (masked)

---

### 7. LLM Provider Switcher

**What the user sees:**
- Dropdown in the nav bar showing the current LLM provider
- Available providers: Anthropic (Claude), OpenAI (GPT), Google (Gemini), Ollama (local)
- Only providers with configured API keys appear in the list

**What the user can do:**
- Switch between providers at any time
- Selection persists in browser localStorage
- All AI features (session summarization, intent detection, next step suggestion, prompt execution) use the selected provider

---

### 8. Command Palette

**How to open:** Cmd+K (Mac) or Ctrl+K (Windows/Linux)

**What the user can do:**
- Type to search across commands and prompts
- **Navigate** to: Dashboard, Prompt Library, Tools & Integrations
- **Copy prompts** to clipboard (prompts are listed with a clipboard icon)
- Prompts appear sorted by usage count (most used first)

**Keyboard controls:**
- Arrow Up/Down to navigate
- Enter to select
- Escape to close
- Click outside to dismiss

---

### 9. Adaptive Suggestions

**Where they appear:** Above the tabs in the project workspace

**What the user sees:** Up to 2 contextual suggestions based on project state:
- "Connect a data source to pull in issues and tasks" — when no data sources are configured but integrations are available
- "Start your first session to begin tracking progress" — when no sessions exist
- "You haven't worked on this project in a while" — when idle > 14 days
- "Add prompts to your library for faster workflows" — when prompt library is empty

**What the user can do:**
- Click the suggestion's action link to navigate to the relevant page
- **Dismiss** any suggestion (persists — won't show again for that project)

---

### 10. Action Notes

**Where:** Next Actions tab, expandable per action

**What the user can do:**
- Expand any action to reveal a text area
- Write notes about the action (context, links, decisions)
- Save notes (persisted per project, survives across sessions)
- Notes are available next time the action appears

---

## D. Navigation & Information Architecture

### Pages
| Route | Purpose |
|-------|---------|
| `/` | Dashboard — project list + quick actions |
| `/project/[id]` | Project workspace — Resume Card with tabs |
| `/prompts` | Prompt library — search, create, manage |
| `/tools` | Tools & integrations — configure, test |

### Global Elements (present on every page)
- **Nav bar**: buffr logo, LLM provider switcher, Cmd+K hint
- **Command palette**: available via Cmd+K from any page
- **Toast notifications**: in-app feedback for actions (save, delete, errors)

---

## E. What the User CANNOT Do (Current Limitations)

1. **No account creation or login** — app is single-user, configured via environment variables
2. **No project creation from the UI** — projects must be created programmatically or via API (the wizard was removed)
3. **No file upload** — all file operations are programmatic (push to GitHub)
4. **No real-time collaboration** — single-user app with no sharing features
5. **No data export** — no way to export projects, sessions, or prompts to a file
6. **No undo/redo** — deleting a project, session, or prompt is permanent
7. **No dark/light mode toggle** — theme is fixed (appears to use dark theme via CSS variables)
8. **No mobile-specific layout** — responsive via Tailwind defaults but not optimized for mobile
9. **No notification preferences** — toast notifications are system-controlled
10. **No search across projects** — only prompt search is available; no global project/session search
11. **No session editing** — sessions are write-once; cannot edit a past session's goal or notes
12. **No bulk operations** — cannot delete multiple projects/sessions/prompts at once

---

## F. Feature Count Summary

| Journey Stage | Feature Count |
|---------------|---------------|
| First-Time Experience | 4 |
| Core Features (Projects, Sessions, Prompts, Data Sources, Workspace) | 38 |
| Secondary Features (Tools, Providers, Palette, Suggestions, Notes) | 18 |
| **Total User-Facing Features** | **60** |

| Feature Type | Count |
|-------------|-------|
| Things the user can SEE (displays, badges, statuses) | 22 |
| Things the user can DO (actions, CRUD, navigation) | 30 |
| Things the user can EXPERIENCE (AI responses, suggestions, auto-detection) | 8 |
