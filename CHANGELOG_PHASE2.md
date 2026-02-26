# Phase 2 Changelog

---

## 2026-02-25 13:08 — Remove Project Creation Wizard / Scaffold Feature

### Summary

Removed the Phase 1 project creation wizard (scaffold) feature, including all backend endpoints, frontend routes, components, and state management. This multi-step wizard previously generated project plans via LLM, scaffolded GitHub repos with generated files, and deployed to Netlify. With Phase 2's tool-based architecture and multi-source integrations, these capabilities are now handled by the tool registry (`github_list_issues`, `github_analyze_repo`, `github_list_repos`, etc.).

### Reason

The scaffold endpoint served dual purposes: (1) the wizard workflow and (2) pass-through queries for repo validation, analysis, issue fetching, and repo listing. All pass-through capabilities have been replaced by registered tools that can be invoked through the tools endpoint, making the scaffold endpoint redundant. The wizard UI (`/new` and `/load` routes) is no longer part of the Phase 2 workflow.

### Files Deleted (16)

**Backend endpoints (3):**
- `netlify/functions/scaffold.ts` — wizard endpoint (repos/validate/analyze/issues/scaffold)
- `netlify/functions/deploy.ts` — Netlify site creation endpoint
- `netlify/functions/generate.ts` — LLM plan generation endpoint

**Backend AI chains (4):**
- `netlify/functions/lib/ai/chains/file-generator.ts` — file content generation via LLM
- `netlify/functions/lib/ai/chains/plan-generator.ts` — project plan generation chain
- `netlify/functions/lib/ai/prompts/file-prompts.ts` — prompts for file generation
- `netlify/functions/lib/ai/prompts/plan-prompt.ts` — prompts for plan generation

**Frontend routes (2):**
- `src/app/new/page.tsx` — 4-step project creation wizard
- `src/app/load/page.tsx` — load existing GitHub repo page

**Frontend components (6):**
- `src/components/flow/step-indicator.tsx`
- `src/components/flow/step-info.tsx`
- `src/components/flow/step-plan.tsx`
- `src/components/flow/step-repo.tsx`
- `src/components/flow/step-deploy.tsx`
- `src/components/flow/load-existing.tsx`

**Frontend state (1):**
- `src/lib/flow-state.ts` — wizard reducer/state

### Files Modified (5)

- **`src/lib/types.ts`** — Removed `GeneratePlanRequest`, `GeneratePlanResponse`, `ScaffoldRequest`, `ScaffoldResponse`, `DeployRequest`, `DeployResponse`, `AVAILABLE_PROJECT_FILES`, `DEFAULT_STACK`
- **`src/lib/api.ts`** — Removed 7 functions (`generatePlan`, `scaffoldProject`, `validateRepo`, `analyzeRepo`, `getIssues`, `getUserRepos`, `deployProject`) and their unused type imports
- **`src/app/page.tsx`** — Removed `getUserRepos` import, stale-project cleanup logic, "New Project"/"Load Existing" header buttons, quick action buttons for `/new` and `/load`, and "Create First Project" empty-state button. Simplified to just `listProjects()`.
- **`src/components/command-palette.tsx`** — Removed "New Project" and "Load Existing Project" commands
- **`src/components/session/resume-card.tsx`** — Removed `getIssues` import, removed `mapGitHubIssuesToWorkItems` import, removed fallback branch in `fetchWorkItems()` that called `getIssues()` directly (tool-based fetch is now the only path)

### Impact on Remaining Features

None. All capabilities previously accessed through the scaffold endpoint are now available through the tool registry:
- `github_list_issues` replaces `?issues=` pass-through
- `github_analyze_repo` replaces `?analyze=` pass-through
- `github_list_repos` replaces `?repos` pass-through
- Repo validation is handled by `github_analyze_repo`

### Verification

- `npm run build` — clean TypeScript compilation, no broken imports
- `npm test` — all 28 tests pass
- Routes `/new` and `/load` are no longer generated
- Dashboard loads without errors
- Resume Card fetches work items exclusively through tool-based approach
- Command palette has no broken commands

---

## 2026-02-25 14:32 — Add "Import a project" + GitHub Sync

### Summary

Added two features to replace the removed scaffold wizard: (1) an "Import a project" modal on the dashboard that creates projects by analyzing a GitHub repo, and (2) a "Sync" button on the project workspace that re-fetches repo metadata from GitHub to keep project data up to date.

### Reason

After removing the scaffold wizard, there was no way to create projects from the UI. The import modal provides a lightweight replacement — enter `owner/repo`, the app analyzes the repo via `github_analyze_repo`, and creates a project pre-filled with detected stack, phase, and description. The sync feature was added because project metadata (description, stack, phase) was set once at import and never refreshed, even if the GitHub repo changed.

### Changes

**Files Created (1):**
- `src/components/dashboard/import-project-modal.tsx` — Modal component with owner/repo input. Calls `github_analyze_repo` to detect stack/phase/description, then `createProject()` to save. Navigates to the new project on success. Shows inline validation and error messages.

**Files Modified (3):**

- **`src/app/page.tsx`** — Added "Import a project" button in header, quick actions, and empty state. Renders `ImportProjectModal` with open/close state and navigation callback.
- **`src/components/session/resume-card.tsx`** — Added `handleSync()` function and "Sync" button next to phase badge. Calls `github_analyze_repo`, updates project stack/phase/description via `updateProject()`, and reflects changes immediately via local `currentProject` state. Also displays the project stack as a mono-text line under the description.
- **`netlify/functions/lib/tools/github.ts`** — Fixed `github_analyze_repo` tool to also call `getRepoInfo()` and include `description` and `defaultBranch` in the response. Previously only returned stack/phase analysis without repo metadata. Also uses the repo's actual default branch instead of hardcoding `"main"`.

### Fixes

- **Sync not updating description**: `github_analyze_repo` was only calling `analyzeRepo()` which inspects files for stack detection but doesn't fetch repo metadata. Now also calls `getRepoInfo()` to include the GitHub repo description.
- **Wrong branch assumption**: Analysis was hardcoded to branch `"main"`. Now reads the actual default branch from the GitHub API and falls back to `"main"` only if unavailable.

### Verification

- `npm run build` — clean compilation
- Dashboard shows "Import a project" button in header, quick actions, and empty state
- Clicking opens modal; entering a valid `owner/repo` analyzes and creates project
- Invalid repo format shows validation error; nonexistent repo shows API error
- Project workspace shows "Sync" button next to phase badge
- Clicking "Sync" updates description, stack, and phase from GitHub
