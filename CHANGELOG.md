# Changelog

## 2026-02-22 20:56 UTC

### Initial Build
- Project scaffold: Next.js 16, TypeScript, Tailwind 4, Netlify Functions
- Backend: CRUD for projects and sessions via Netlify Blobs
- Backend: Multi-provider LLM system (Anthropic, OpenAI, Google, Ollama) with LangChain
- Backend: AI plan generation, file generation, GitHub repo creation, Netlify deploy
- Frontend: Dashboard, 4-step project wizard, load existing project, session memory
- Frontend: Resume Card with next-action engine, end session modal
- Frontend: Provider switcher, command palette (Cmd+K), toast notifications
- UI component library: Button, Input, TextArea, Badge, Card, Modal, Checkbox, Toggle

### Changed
- `generate.ts` returns user-friendly errors with proper HTTP status codes (401, 402, 429)

### Fixed
- Replaced `uuid` with `crypto.randomUUID()` for CJS compatibility in Netlify Functions
- Netlify Blobs `get()` calls now use `{ type: "text" }` to return strings
- API errors surface as toast notifications instead of hidden inline divs

## 2026-02-22 21:30 UTC

### Changed
- Project description in Step 2 is now LLM-generated and editable, previously static text from user input
- Added `description` field to `ProjectPlan` type and LLM plan prompt
- Plan parser extracts description from LLM response
- Repo description now derives from plan description instead of raw user input

## 2026-02-22 21:45 UTC

### Changed
- Project Description and Recommended Stack fields in Step 2 switched from `Input` to `TextArea` for better editing of longer content

## 2026-02-22 22:30 UTC

### Fixed
- Replaced `@octokit/rest` with direct `fetch` calls to GitHub API — fixes `require() of ES Module` error in Netlify Functions CJS bundle
- GitHub repo creation now uses `auto_init: true` so the Git Data API works on first push (previously failed with "Git Repository is empty")
- `pushFiles` now gets HEAD commit as parent, uses `base_tree`, and PATCHes the ref instead of creating a new one
- GitHub API error messages now include the `errors` array for actionable details (e.g. "name already exists on this account")
- Non-JSON API responses no longer crash the frontend — `api.ts` now parses `res.text()` first with `JSON.parse()` fallback
- Netlify site name collision fixed by appending random 6-char UUID suffix
- Netlify deploy no longer fails with "Host key verification failed" — site is created without repo linking (requires user to install Netlify GitHub App separately)

### Changed
- Step 4 (Deploy) now displays error messages inline with editable Project Name and Repository Name fields, plus a Retry button
- Default repo visibility changed from Private to Public so Netlify can access the repo
- Netlify site creation deploys a styled placeholder landing page (project name, next steps, clone/install/run instructions) instead of leaving the site empty
- Deploy step reduced from 6 to 5 steps (removed "Trigger deploy" — replaced by placeholder deploy)
- `scaffold.ts` error handling improved with user-friendly messages for billing (402), auth (401), rate limit (429), repo conflicts (422), and missing config (400)
- `deploy.ts` simplified to create site + placeholder only, returns `buildId: "pending"`

## 2026-02-22 23:00 UTC

### Fixed
- "Load Existing Project" validation was sending a GET request to the scaffold endpoint which only accepted POST, returning 405 Method Not Allowed
- `scaffold.ts` now handles `GET ?validate=owner/repo` — calls `getRepoInfo` from `github.ts` to verify the repo exists and is accessible
- Strips trailing `.git` from repo input before validation
- Returns repo info (name, description, default branch, last commit) on success, or 404 if not found

### Changed
- `load-existing.tsx` now parses the validation response and displays the actual repo name and description from GitHub instead of extracting from user input

## 2026-02-23 00:30 UTC

### Added
- **Repo analysis on Load Existing**: After validating a GitHub repo, buffr now auto-detects the project's stack, frameworks, dev tools, phase, and maturity signals by reading the file tree and `package.json` — no LLM needed
  - Detects 14 frameworks (Next.js, React, Vue, Svelte, Angular, Express, Astro, Remix, etc.), TypeScript, CSS frameworks (Tailwind, styled-components, Emotion)
  - Detects 11 dev tools (ESLint, Prettier, Jest, Vitest, Playwright, Storybook, Husky, etc.)
  - Determines project phase from maturity signals: `idea` (<5 files) → `mvp` (default) → `polish` (tests + CI/deploy) → `deploy` (all three)
  - Analysis runs non-blocking in the background while user selects project files
- **GitHub Issues integration**: Open issues are fetched from GitHub and displayed in the Resume Card as a new "Open Issues" section with linked titles, issue numbers, and label badges
  - On-demand refresh via `GET /scaffold?issues=owner/repo` endpoint
  - PRs are filtered out — only actual issues are shown
- **`GitHubIssue` type** added to `src/lib/types.ts`; optional `issueCount` field added to `Project` for dashboard display without re-fetching
- **Analysis UI in Load Existing flow**: Shows detected stack, phase badge, file count, maturity indicators (has tests/CI/deploy config in green), dev tool badges, and open issue count

### Changed
- **Next Actions engine rewritten** with extensible `ActionContext` pattern — replaces old `(project, lastSession)` signature with `generateNextActions(context: ActionContext)`
  - Five pluggable source functions in priority order: session (last session's nextStep), activity (>7 days idle reminder), issues (top 3 open GitHub issues as "Fix #N: title"), stack (suggest test framework if missing), phase (existing idea/mvp/polish/deploy defaults)
  - Each `NextAction` now has an optional `source` field for future UI indicators
  - Results deduplicated by id and capped at 3
- **Resume Card** now fetches sessions and issues in parallel via `Promise.all`, passes full `ActionContext` to the next-actions engine
- `scaffold.ts` GET handler restructured with three query modes: `?validate=`, `?analyze=`, `?issues=` — returns 405 only if no recognized param is present
- Default `repoVisibility` in Load Existing changed from `"private"` to `"public"`

### Fixed
- `netlify/functions/projects.ts` POST handler now saves `netlifySiteId` and `netlifySiteUrl` from the request body instead of hardcoding `null`
- `.git` suffix properly stripped from repo input in `parseRepoInput()` before passing to `createProject`

## 2026-02-23 01:15 UTC

### Added
- **Notion integration foundation**: `NotionTask` interface added to `src/lib/types.ts` — defines the shape for tasks pulled from Notion (id, title, status, priority, tags, url)
- **`NOTION_SETUP.md`**: Step-by-step guide for connecting a Notion tasks database to buffr — covers creating an internal integration, getting the token, sharing the database, extracting the database ID, expected table structure (Name + Status required; Priority + Tags optional), and the planned `NOTION_CONFIG` code-editable config pattern with property mappings and per-project database map
- Groundwork for Notion as a pluggable data source in the `ActionContext` next-actions engine, alongside GitHub Issues
