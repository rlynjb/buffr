# Phase 2 Changelog — Post .dev/ Integration

Everything done after `24bef9a implemented .dev integration feature plan` (2026-03-04).

**Total: 75 files changed, 4,876 insertions, 557 deletions across 18 commits.**

---

## 2026-03-04 — Fix .dev/ File Tree to Align with Plan

**Commit:** `4fbace0`

Rewrote the `generate-dev` endpoint to produce a deterministic `.dev/` folder structure instead of relying entirely on LLM output. The LLM now only generates analysis data (stack detection, patterns, gap analysis). File generation uses hardcoded templates populated with LLM results.

### Changes

- **`netlify/functions/generate-dev.ts`** — Replaced LLM-generated file content with template-based generation. Added `buildGeneratedFiles()` that produces all `.dev/` files from scan results. Ensures consistent folder structure regardless of LLM behavior (+550 lines).
- **`netlify/functions/lib/ai/chains/dev-scanner.ts`** — Simplified output schema. Removed `generatedFiles` from LLM output — the LLM now returns only analysis (stack, patterns, gaps, adapters).
- **`src/components/dev-folder/file-tree-tab.tsx`** — Minor alignment fix for file tree display.

---

## 2026-03-07 12:14 — Authentication System

**Commit:** `69aacb7`, `34f5b78`

Added JWT-based authentication with a login page, auth middleware, and protected routes.

### Files Created (9)

- **`netlify/functions/login.ts`** — Login endpoint, validates credentials against `AUTH_USERNAME`/`AUTH_PASSWORD` env vars, returns JWT via `Set-Cookie`
- **`netlify/functions/logout.ts`** — Clears auth cookie
- **`netlify/functions/auth-check.ts`** — Verifies JWT validity, returns user status
- **`netlify/functions/lib/auth.ts`** — JWT helpers using `jose` (sign, verify, cookie parsing)
- **`src/app/login/page.tsx`** + **`page.css`** — Login form with error handling
- **`src/middleware.ts`** — Next.js middleware, redirects unauthenticated users to `/login`
- **`src/context/auth-context.tsx`** — React context for auth state, provides `login`/`logout`/`isAuthenticated`
- **`src/components/app-shell.tsx`** — Wrapper component that checks auth before rendering children
- **`docs/DATA_LIFECYCLE.md`** — Documentation of data flow and lifecycle

### Files Modified (4)

- **`src/app/layout.tsx`** — Wrapped app in `AuthProvider` and `AppShell`
- **`src/components/nav.tsx`** — Added logout button
- **`.env.example`** — Added `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET` vars
- **`package.json`** — Added `jose` dependency

---

## 2026-03-07 12:55 — .dev/ Folder Detection

**Commit:** `da1daae`

Added ability to detect whether a GitHub repo already has a `.dev/` folder, so the UI can show existing scan status without requiring a fresh scan.

### Files Created (1)

- **`netlify/functions/detect-dev.ts`** — Endpoint that checks GitHub repo for `.dev/` folder existence and reads `PROJECT.md` if found

### Files Modified (4)

- **`netlify/functions/lib/github.ts`** — Added `getFileContent()` and `checkPathExists()` helpers
- **`netlify/functions/projects.ts`** — Added `devFolder` field to project creation/update
- **`src/app/dev-folder/[id]/page.tsx`** — Calls detect-dev on mount to show existing status
- **`src/lib/api.ts`** — Added `detectDev()` API client function
- **`src/lib/types.ts`** — Added `devFolder` field to `Project` type

---

## 2026-03-07 12:58 — .dev/ Link in Project Workspace

**Commit:** `89dab6c`

Added a `.dev/` link in the resume card header so users can navigate to the dev folder viewer from the project workspace.

### Files Modified (1)

- **`src/components/session/resume-card.tsx`** — Added `IconLayers` link to `/dev-folder/[id]` next to GitHub/Site links

---

## 2026-03-07 13:43 — Separate Tech Debt from .dev/ Scanner

**Commit:** `c244845`

Moved tech debt scanning out of the `.dev/` generation flow and into its own standalone feature. Tech debt is now scanned via `github_scan_tech_debt` tool and displayed in a dedicated grid on the project workspace.

### Files Created (2)

- **`src/components/session/tech-debt-grid.tsx`** — Renders tech debt summary as a categorized grid with severity-colored items
- **`src/components/session/tech-debt-grid.css`** — BEM styles for tech debt grid

### Files Modified (8)

- **`netlify/functions/generate-dev.ts`** — Removed tech debt logic from scan flow
- **`netlify/functions/lib/ai/chains/dev-scanner.ts`** — Removed `techDebt` from LLM output schema
- **`netlify/functions/lib/github.ts`** — Added `scanTechDebt()` function that analyzes repo files for common debt indicators (TODO comments, deprecated deps, missing tests)
- **`netlify/functions/lib/tools/github.ts`** — Registered `github_scan_tech_debt` tool
- **`netlify/functions/projects.ts`** — Store `techDebt` on project record
- **`src/components/dev-folder/overview-tab.tsx`** — Removed tech debt section from overview
- **`src/components/session/resume-card.tsx`** — Renders `TechDebtGrid` at bottom of workspace, calls scan during sync
- **`src/lib/types.ts`** — Added `TechDebtScan`, `TechDebtItem` interfaces

---

## 2026-03-07 14:42 — Polish .dev/ UI

**Commit:** `c2dece9`

Visual refinements to the gap analysis tab, overview tab, and tech debt grid.

### Files Modified (6)

- **`src/components/dev-folder/gap-tab.tsx`** + **`.css`** — Redesigned gap table with colored status badges, category grouping, and summary stats
- **`src/components/dev-folder/overview-tab.tsx`** + **`.css`** — Added footer with scan metadata (last scanned time, file count, analysis source)
- **`src/components/session/tech-debt-grid.tsx`** + **`.css`** — Added scan timestamp display, refined grid spacing

---

## 2026-03-07 15:43 — Polish .dev/ Feature (Major)

**Commit:** `57fb2e0`

Major refinement pass adding file preview, diff views, review workflows, and file ownership display.

### Files Created (4)

- **`src/components/dev-folder/diff-view.tsx`** + **`.css`** — Side-by-side diff viewer for comparing current vs proposed file changes
- **`src/components/dev-folder/review-banner.tsx`** + **`.css`** — Banner shown for reviewable files, with approve/reject actions

### Files Modified (8)

- **`src/app/dev-folder/[id]/page.tsx`** — Added file merge logic, reviewable file approval flow, and file editing capabilities. Introduced `mergedFiles` computed from scan result + user edits.
- **`src/components/dev-folder/file-tree-tab.tsx`** + **`.css`** — Added inline file preview with syntax highlighting, ownership badges, expand/collapse, and ownership-based coloring. Files now show content on click.
- **`netlify/functions/generate-dev.ts`** — Added support for incremental scans (merge new files with existing user-edited files)
- **`netlify/functions/scan-results.ts`** — Added PUT endpoint to update individual generated files
- **`netlify/functions/lib/industry-kb/seed.ts`** — Expanded industry knowledge base seed data
- **`src/components/session/resume-card.tsx`** — Restructured header layout, added `.dev/` button in header actions
- **`src/lib/api.ts`** — Added `updateScanResultFile()` API function
- **`src/lib/types.ts`** — Added `analysisSource` field to `ScanResult`

---

## 2026-03-07 15:58 — Implement Adapter Management

**Commit:** `eb8bc52`

Built out the Adapters tab with full adapter configuration — view adapter content, toggle adapters on/off, and see which AI tools are supported.

### Files Modified (5)

- **`src/components/dev-folder/adapters-tab.tsx`** + **`.css`** — Rebuilt adapter cards with descriptions, content preview, and install toggle. Each adapter shows its generated config file from `.dev/adapters/`.
- **`src/app/dev-folder/[id]/page.tsx`** — Added adapter state management, passes `generatedFiles` filtered to adapters
- **`netlify/functions/scan-results.ts`** — Added adapter-specific query support
- **`src/lib/api.ts`** — Updated scan result API calls

---

## 2026-03-07 16:11 — Link Gap Analysis to File Tree

**Commit:** `13e4162`

Connected the Gap Analysis tab to the File Tree tab. Clicking a gap entry navigates to the relevant file in the tree with auto-scroll and highlight.

### Files Modified (5)

- **`src/app/dev-folder/[id]/page.tsx`** — Added `highlightedFilePath` state and `CATEGORY_FILE_MAP` mapping gap categories to file paths. Added `handleGapNavigateToFile()` callback.
- **`src/components/dev-folder/gap-tab.tsx`** + **`.css`** — Added "view file" icon button on each row that calls `onNavigateToFile(category)`
- **`src/components/dev-folder/file-tree-tab.tsx`** + **`.css`** — Added gap count indicators per file (colored pills: red/amber/green). Added highlight + auto-scroll when `highlightedFilePath` changes, with pulse animation.

---

## 2026-03-07 16:36 — Adapter Installation (Push to GitHub)

**Commit:** `ccc893c`

Added the ability to install adapters by pushing symlinks to the GitHub repo root. Symlinks point to `.dev/adapters/` files so AI tools pick them up automatically.

### Files Modified (10)

- **`netlify/functions/generate-dev.ts`** — Added `?install-adapter` endpoint that creates git symlinks (mode `120000`) via GitHub API
- **`netlify/functions/lib/github.ts`** — Added `createOrUpdateFile()` with symlink support
- **`src/app/dev-folder/[id]/page.tsx`** — Added `ADAPTER_ROOT_PATHS` mapping and `useMemo`-based `installedAdapters` derived from scan result file tree. Detects already-installed adapters across page reloads.
- **`src/components/dev-folder/adapters-tab.tsx`** + **`.css`** — Added "Install" button that calls install endpoint, shows "Installed" badge for active adapters
- **`src/components/dev-folder/file-tree-tab.tsx`** + **`.css`** — Shows installed adapter files in the repo tree
- **`src/components/dashboard/project-card.tsx`** — Fixed hydration error: changed nested `<button>` to `<div role="button">`
- **`src/components/session/resume-card.tsx`** + **`.css`** — Removed dismiss button from suggestion banners
- **`src/lib/api.ts`** — Added `installAdapter()` API function
- **`netlify.toml`** — Added `[dev] timeout = 120` for LLM calls

---

## 2026-03-07 17:15 — Refine Dev Status Display

**Commit:** `f45b858`

Moved scan metadata from overview tab footer to the page header so it's visible across all tabs.

### Files Modified (4)

- **`src/app/dev-folder/[id]/page.tsx`** — Added `dev-folder__header-meta` with "Last Scanned:", file count, and "Analysis:" labels
- **`src/app/dev-folder/[id]/page.css`** — Added header meta styles, removed last-scan class
- **`src/components/dev-folder/overview-tab.tsx`** + **`.css`** — Removed footer section (moved to page header)
- **`netlify.toml`** — Fixed timeout config format

---

## 2026-03-07 17:19 — Generate .dev/ for Buffr Itself

**Commit:** `04eb6a5`

Ran the scanner on the buffr repo and committed the generated `.dev/` intelligence folder.

### Files Created (21)

- `.dev/adapters/CLAUDE.md`, `.dev/adapters/.cursorrules`
- `.dev/context/PROJECT.md`, `.dev/context/CONVENTIONS.md`, `.dev/context/DECISIONS.md`
- `.dev/gap-analysis.md`
- `.dev/industry/nextjs.md`, `.dev/industry/security.md`, `.dev/industry/tailwindcss.md`, `.dev/industry/testing.md`, `.dev/industry/typescript.md`
- `.dev/standards/frontend.md`, `.dev/standards/backend.md`, `.dev/standards/css.md`, `.dev/standards/typescript.md`
- `.dev/prompts/audit.md`, `.dev/prompts/cleanup.md`, `.dev/prompts/new-feature.md`
- `.dev/templates/component.md`, `.dev/templates/api-endpoint.md`, `.dev/templates/test.md`

---

## 2026-03-07 17:20 — Install CLAUDE.md Adapter

**Commit:** `0283803`

Installed the Claude Code adapter by creating a `CLAUDE.md` symlink at the repo root pointing to `.dev/adapters/CLAUDE.md`.

### Files Created (1)

- **`CLAUDE.md`** — Symlink to `.dev/adapters/CLAUDE.md`

---

## 2026-03-07 17:23 — Next Action Icon Legend

**Commit:** `eb3c08e`

Added a description line above the Next Actions list explaining what the source icons mean.

### Files Modified (2)

- **`src/components/session/actions-tab.tsx`** — Added icon legend: AI-suggested, From GitHub, From last session
- **`src/components/session/actions-tab.css`** — Added legend styles (`actions-tab__desc`, `actions-tab__desc-icon`, `actions-tab__desc-sep`)

---

## 2026-03-07 17:33 — Fix Next Action Item Format

**Commit:** `96683e2`

Fixed GitHub-sourced action items: icon wasn't showing and text had redundant "Fix #:" prefix.

### Files Modified (1)

- **`src/lib/next-actions.ts`** — Changed `source: "issue"` to `source: "github"` so `SourceIcon` renders correctly. Removed `Fix #${item.id}:` prefix from action text.

---

## 2026-03-07 17:37 — Fix Start Working Button

**Commit:** `d626a96`

Made the "Start Working" suggestion banner clickable when it doesn't have a navigation route.

### Files Modified (2)

- **`src/components/session/resume-card.tsx`** — Changed non-interactive `<span>` to `<button onClick={onEndSession}>` for suggestions without `actionRoute`
- **`src/components/session/resume-card.css`** — Removed unused suggestion dismiss/actions classes

---

## 2026-03-08 — Compile Learning Materials

**Commit:** `595600c`

Generated project documentation for learning AI engineering concepts.

### Files Created (2)

- **`ARCHITECTURE.md`** — Full system architecture with Mermaid diagrams, data models, API surface, and design decisions
- **`LEARNING.md`** — 18-section guide mapping AI engineering concepts to buffr's codebase, with a 12-week learning roadmap

---

## Summary by Area

### .dev/ Intelligence Feature

| What                                                | Commits   |
| --------------------------------------------------- | --------- |
| Fix file tree structure (template-based generation) | `4fbace0` |
| Detect existing .dev/ folder                        | `da1daae` |
| .dev/ link in workspace                             | `89dab6c` |
| Separate tech debt into own feature                 | `c244845` |
| Gap table + overview polish                         | `c2dece9` |
| File preview, diff view, review workflow            | `57fb2e0` |
| Adapter management UI                               | `eb8bc52` |
| Gap analysis → file tree linking                    | `13e4162` |
| Adapter installation (GitHub symlinks)              | `ccc893c` |
| Header meta refinement                              | `f45b858` |
| Generate .dev/ for buffr itself                     | `04eb6a5` |
| Install CLAUDE.md adapter                           | `0283803` |

### Authentication

| What                             | Commits              |
| -------------------------------- | -------------------- |
| JWT auth, login page, middleware | `69aacb7`, `34f5b78` |

### Project Workspace Fixes

| What                          | Commits   |
| ----------------------------- | --------- |
| Next Action icon legend       | `eb3c08e` |
| Fix GitHub action icon + text | `96683e2` |
| Fix Start Working button      | `d626a96` |

### Documentation

| What                          | Commits   |
| ----------------------------- | --------- |
| ARCHITECTURE.md + LEARNING.md | `595600c` |
