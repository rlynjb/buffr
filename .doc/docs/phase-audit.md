---
title: phase-audit
category: docs
---
# buffr — Phase Audit Spec

> Snapshot of where buffr stands before the next phase of work.
> Audited against repo at commit `cfa401d` (April 9, 2026).

---

## Changes Since Last Audit

A significant cleanup sweep landed — 15 commits focused on removing dead code, dead features, and dead references. The codebase is materially leaner.

**Removed entirely:**
- Notion integration (all code, env vars, storage, UI references)
- Prompts tab and all associated code (component, API, backend, storage)
- Command palette (component, CSS, Cmd+K button from nav, event listeners from dashboard)
- Action notes feature (UI, API, backend, storage)
- CHANGELOG files and docs directory

**Dead fields removed from types:**
- `DevItem`: removed `communitySource`, `communityVersion`, tags
- `DocItem`: removed tags
- `Session`: removed `gitSnapshot`, `aiSummary`, `linkedSessionIds`
- `Prompt`: removed `projectId` (then entire type removed)

**Data model consolidation:**
- `NextAction` merged into `ManualAction` as single source of truth

**Bug fixes from audit items:**
- Removed dead `add-prompts` suggestion that referenced non-existent Prompt Library tab
- Removed misleading `list_recent_activity` capability (was mapping closed issues as "recent activity")
- Updated `data-sources.test.ts` to test `create_item` instead of removed capability
- Updated `suggestions.test.ts` to remove `add-prompts` from dismissed filter test

**New repo structure:**
- `.ai-rules/` directory with 11 rule files (ai-behavior, architecture, code-style, dependencies, documentation, error-handling, git, output-modes, security, testing)
- `.dev/` directory expanded with subdirectories: adapters, context, industry, prompts, standards, templates, plus `gap-analysis.md`
- `.claude/plans/` directory added

---

## What's Complete

These features are stable, handle their core flows, and can be relied on.

### Authentication
- Login/logout with JWT cookie flow works end-to-end
- Middleware redirects unauthenticated users, redirects authenticated users away from `/login`
- Cookie is HttpOnly, Secure, SameSite=Lax, 7-day expiry
- Provider context, auth context, and app shell gate all coordinate correctly
- Error states shown in login form

### Project CRUD
- Create via GitHub import (analyze → preview → confirm)
- List sorted by `updatedAt`, delete with confirmation modal
- Update with field whitelist preventing arbitrary injection
- GitHub URL parsing handles `owner/repo`, full URLs, `.git` suffix
- Repo rename/redirect handling via `getRepoInfo`

### GitHub Integration
- Full tool registry with 11 registered tools
- Repo analysis: 14 framework detections, 11 dev tool detections, phase heuristic
- Push flow with blob → tree → commit → ref update, empty repo bootstrap, symlink support
- Issue CRUD, commit listing with `since` filter, diff comparison, file reading

### Session Recording
- Create session with goal, whatChanged array, blockers
- List by project sorted by createdAt descending
- Session tab displays all fields cleanly
- Last session surfaced with AI-detected intent

### Manual Actions (Next Actions)
- Full CRUD: add, edit (inline), delete, mark done
- Drag-and-drop reorder with optimistic UI + server persist
- AI rewrite with 6 persona options
- Textarea auto-resize on input and rewrite
- Done actions cleaned up atomically on End Session save

### AI Chains
- Three chains: summarize, intent, paraphrase
- Multi-provider support with per-request provider selection
- JSON response parsing with code fence stripping
- Error classification with user-friendly messages

### .dev File Management
- CRUD with title, filename (auto-generated or custom), content
- Push to GitHub with 6 adapter formats + root symlinks
- Inline preview, search by title/filename

### .doc File Management
- CRUD with category (docs/ideas/plans), scoped to project
- Category filter with counts, push to GitHub, search

### Design System
- Consistent tokens, BEM naming, DM Sans + JetBrains Mono
- All icons as inline SVG, fadeIn/slideDown animations

---

## What's Incomplete

Features that exist but have gaps — missing states, unhappy paths, edge cases.

### End Session — Activity Fetching

**The 24-hour window is still arbitrary.**
- Commits fetched with `since: Date.now() - 24h`. Multi-day gaps between sessions lose commit history from the summary. Should use `lastSession.createdAt` as the `since` timestamp.

**The `list_recent_activity` removal created a gap.**
- The old code fetched closed issues as a secondary activity source (misleading — correctly removed). But now End Session *only* pulls commits + completed manual actions. If a session was mostly issue triage with no commits, the AI gets nothing to summarize.
- The loading text still says `Fetching activity from ${sources.length + 1} source${sources.length + 1 !== 1 ? "s" : ""}...` — the `+1` accounts for manual actions. With only commits + manual actions, the count is technically correct but could confuse if `sources` is empty (shows "1 source" meaning just tasks).

**Error handling during fetch is silently swallowed.**
- Every `try/catch` catches and continues. If GitHub is down, the form loads empty with no feedback about what failed.

### Manual Actions — Optimistic UI Without Rollback

**Three of four mutation paths silently eat server failures:**
- `handleEditManual`: optimistic update, catch only logs — UI keeps edited text even if server rejected it.
- `handleReorder`: fires API in `.catch(() => {})` — if reorder fails, UI stays reordered, server has old order. Next page load snaps back.
- `handleActionDone`: marks done optimistically with `.catch(() => {})` — same silent failure.
- `handleAddManual` is the only path with proper rollback (removes optimistic insert on failure).

**No loading/disabled states during API calls.**
- Rapid "Done" clicks fire parallel PUT requests. Server stores full array each time, last write wins.

### ManualAction Type Mismatch (Partially Fixed)

- The "merge NextAction into ManualAction" commit consolidated the two types, but the backend `ManualAction` interface still only has `{ id, text, done }` while the frontend `ManualActionData` includes `createdAt: string`. The backend never stores or returns `createdAt`. The frontend sets it on optimistic insert but it's ephemeral — gone on reload.
- Less dangerous now that NextAction is gone (no competing types), but `createdAt` is still phantom data.

### Project Sync

**Sync overwrites local edits unconditionally.**
- `handleSync` takes GitHub analysis and overwrites `name`, `stack`, `phase`, `description`. Manual customizations get replaced. No merge strategy.
- No sync error feedback in UI — catch logs to console, button returns to "Sync" silently.

### Project Health

**Week boundary is Sunday-based, binary only.**
- Saturday night activity → "needs attention" Sunday morning.
- No gradient — 6-month idle gets same yellow dot as 2-day idle.

### Provider Switching — Stale Selection

- Selected provider in localStorage isn't validated against currently available providers on load. Removing an API key from `.env` leaves stale `selected` value. AI calls fail with "API key not configured" until manually switched.

### .dev Items — Global Scope Mismatch

- Dev items aren't scoped to any project. All projects show the same dev items. Push sends ALL dev items to whichever repo you're viewing. Intent is undocumented — either shared rules (feature) or a scoping bug.

### GitHub Push — No Conflict Detection

- Push always force-overwrites. No branch protection awareness, no PR workflow, no conflict detection.

### NotificationProvider — Wired But Unused

- `NotificationProvider` is mounted in `app-shell.tsx`, `useNotification` hook exists, but no component calls `notify()`. All error handling goes to `console.error`.

### Modal Accessibility

- No focus trap. Escape and click-outside work, but keyboard users can tab behind the overlay.

---

## What's Blocking the Next Phase

These must be resolved before building the agent system (Phase 3: ReAct loop, session memory, tool routing).

### 1. Session AI endpoint is unauthenticated

`session-ai.ts` still has `// TODO: Add authentication middleware` at the top. Any HTTP client can hit summarize/intent/paraphrase and burn LLM credits. Unchanged since last audit.

**Fix:** Extract auth verification into a shared function. Apply to `session-ai.ts` and all future AI endpoints.

### 2. No rate limiting on LLM calls

Still no debounce, queue, or per-minute cap. The `// TODO: Add rate limiting` comment is still there.

**Fix:** In-memory rate limiter in the function handler, or Blob-based counter for stateless Netlify Functions.

### 3. Storage doesn't scale for session memory

`listSessionsByProject` still full-scans ALL sessions across ALL projects, filtering by `projectId` in memory. The agent phase needs frequent session history reads.

**Fix:** Prefix keys with `{projectId}:` for Blob list prefix filtering, or add a secondary index blob per project.

### 4. Tool execution has no structured error propagation

`executeTool` returns flat `{ ok: false, error: "message" }`. The agent loop needs retryable vs. config vs. logical error distinction. `classifyError` only runs on `session-ai`, not tool execution.

**Fix:** Apply `classifyError` to tool execution. Return `{ ok, error: { code, retryable, message } }`.

### 5. No conversation/message storage model

No `Message` or `Conversation` type, no Blob store for chat history, no API endpoint. Prerequisite for session memory and conversational layer.

**Fix:** Design data model: `{ id, projectId, role, content, toolCalls?, createdAt }` in a `conversations` store with project-prefixed keys.

### 6. Provider validation on server side

Server receives `provider` as POST body field but never validates against `getAvailableProviders()`. Unconfigured provider → `getLLM` throws → 500 error.

**Fix:** Validate `provider` param at start of every AI endpoint. Return 400 if not configured.

---

## What's Explicitly Deferred

Documented decisions. Don't build on top of these assumptions.

### Netlify Deploy Integration
`NETLIFY_TOKEN` in `.env.example`, `netlifySiteUrl` on Project model, but no deploy function or Netlify API code. **Don't build features that depend on automated deploy status.**

### Command Palette
Fully removed in this cleanup. No remnant code. **Don't reference Cmd+K in docs or UI. If it returns, it's a rebuild from scratch.**

### Prompt Library
Fully removed — component, API, backend, storage, types all deleted. The `.dev/prompts/` directory in the repo is static files committed to Git, not managed by the app. **Don't reference a prompts tab or prompt CRUD.**

### Notion Integration
Fully removed — all code, env vars, storage, UI. **Don't add Notion references back. If Notion returns, it's a fresh integration.**

### Action Notes
Removed in this cycle. **Don't reference notes on manual actions.**

### Multi-User Support
Single-user. No user ID on any data model. **Don't add features that assume multiple users.**

### Pagination
No list endpoint supports it. All reads fetch everything. **Don't build reports assuming paginated APIs.**

### Offline / PWA
No service worker, no cache, no offline fallback. **Don't assume local-first data.**

### Blob Store Transactions
No atomic multi-key operations. **Don't build flows requiring multi-entity consistency.**

### GitHub Branch Protection / PR Workflow
Pushes go directly to default branch. **Don't assume push succeeds on protected repos.**

### Test Coverage
Minimal: `data-sources.test.ts` (3 tests) and `suggestions.test.ts` (6 tests). No component, API, or integration tests. **Don't assume refactors are safe without manual testing.**

### CSS Architecture
`@reference` + `@apply` + BEM. Unusual but consistent. **Don't convert to inline Tailwind unless touching every component.**

### ManualAction.createdAt Phantom Field
Frontend has it, backend doesn't store it. **Don't sort or display by `createdAt` — it's not persisted.**