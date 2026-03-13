# Move Tools Page into Project Page Tab

## Context
The standalone `/tools` page is being moved into the project page as a tab alongside Next Actions, Last Session, etc. The standalone route and page will be removed entirely. Tools/integrations are global (not per-project), but since this is a single-user app, embedding it in the project view simplifies navigation.

---

## Plan

### 1. Create `ToolsTab` component
**New file:** `src/components/session/tools-tab.tsx`

Extract the body of `src/app/tools/page.tsx` into a self-contained `ToolsTab` component:
- **No props needed** — fetches its own data (`listIntegrations()`, `getDefaultDataSources()`)
- All state stays internal (integrations, loading, configOpen, testOpen, toolQuery, toolFilter, etc.)
- Remove the back-link (`<Link href="/">`) and page title (`<h1>`)
- Keep importing `ConfigModal` and `TestToolModal` from `@/components/tools/`
- Rename all CSS classes from `tools-page__*` to `tools-tab__*`

### 2. Create `ToolsTab` CSS
**New file:** `src/components/session/tools-tab.css`

Copy `src/app/tools/page.css`, rename BEM prefix `tools-page__` → `tools-tab__`, remove back-link/title styles, update `@reference` path to `"../../app/globals.css"`.

### 3. Wire into ResumeCard
**Modify:** `src/components/session/resume-card.tsx`

- Add `"tools"` to `Tab` type
- Import `ToolsTab`
- Add `{ id: "tools", label: "Tools" }` as last tab entry
- Add `{activeTab === "tools" && <ToolsTab />}` in tab content

### 4. Update suggestion route
**Modify:** `src/lib/suggestions.ts` — change `actionRoute: "/tools"` → `actionRoute: "#tools-tab"`

**Modify:** `src/components/session/resume-card.tsx` — in suggestion rendering, detect `"#tools-tab"` and call `setActiveTab("tools")` instead of rendering a link.

### 5. Remove `/tools` references
- `src/app/page.tsx` (line 79-86) — remove Tools quick-nav button
- `src/components/command-palette.tsx` (line 77-87) — remove "Tools & Integrations" command
- `src/components/nav.tsx` (line 12) — remove `"/tools": "Tools"` entry

### 6. Delete standalone page
- Delete `src/app/tools/page.tsx`
- Delete `src/app/tools/page.css`
- Delete `src/app/tools/` directory

---

## Verification
1. `npm run build` — zero errors
2. `npm test` — all tests pass
3. Navigate to a project page → "Tools" tab appears last in tab bar
4. Tools tab shows integrations, default sources, tool registry, config/test modals work
5. Suggestion "connect a data source" switches to Tools tab (not navigating away)
6. `/tools` route no longer exists
7. Dashboard no longer shows Tools quick-nav button
8. Command palette no longer has Tools command
