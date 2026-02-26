# Implementation Approach — buffr

**Date:** 2025-02-25
**Based on:** FEATURES_ENDUSER.md (60 user-facing features)
**Current State:** Core backend + frontend scaffold exists and builds. Most CRUD and AI chains are wired. UI components are functional but several end-to-end flows need polish and gap-filling.

---

## Feature Analysis

### A. First-Time Experience

| Feature | UX Role | Workflow Role | Current State |
|---------|---------|---------------|---------------|
| Empty-state dashboard | Onboarding — tells the user what to do first | Entry point; guides toward project creation | Partially implemented — dashboard exists but empty-state messaging may need review |
| Quick action buttons (Prompts, Tools) | Discovery — surfaces the two secondary pages | Reduces time-to-value by exposing configuration early | Implemented in dashboard |
| Provider switcher (nav) | Configuration — sets the AI engine | Global; affects all AI features downstream | Implemented via `ProviderContext` + localStorage |
| Cmd+K hint | Discoverability — teaches power-user shortcut | Encourages keyboard-driven workflow | Implemented in nav bar |

**UX Summary:** The first-time experience is intentionally minimal — no wizard, no tutorial. The user lands on an empty dashboard and must figure things out through the quick actions and command palette. This works for the target audience (developers self-hosting the app) but relies on the empty states being clear and actionable.

**Workflow Role:** This is the **bootstrap phase**. The user needs to: (1) configure at least one LLM provider, (2) import or create a project, (3) optionally connect integrations. The current flow supports this but the order isn't enforced or guided.

---

### B. Core Features

#### B1. Project Management (Dashboard)

| Feature | UX Role | Workflow Role | Current State |
|---------|---------|---------------|---------------|
| Project cards with metadata | Overview — at-a-glance project health | Hub; the user decides which project to work on | Implemented |
| Phase badges (idea/mvp/polish/deploy) | Status — communicates project maturity | Mental model; helps user prioritize | Implemented |
| Sort by recently updated | Recency bias — surfaces active work | Reduces friction for daily use | Implemented |
| Click to open workspace | Navigation — transitions to work mode | Gateway to the core loop | Implemented |

**UX Summary:** The dashboard is a project picker. It's simple, card-based, sorted by recency. The user glances at it, picks a project, and moves into the workspace. There's no filtering, searching, or grouping — this is fine for <20 projects but may need attention later.

**Workflow Role:** This is the **selection layer**. It sits between "I opened the app" and "I'm working on something." The faster this transition, the better.

---

#### B2. Project Workspace (Resume Card)

| Feature | UX Role | Workflow Role | Current State |
|---------|---------|---------------|---------------|
| Project header (name, phase, links) | Context — anchors the user in the project | Persistent context while working | Implemented |
| Data source checkboxes | Configuration — per-project integration toggle | Controls what feeds into Open Items | Implemented |
| **Tab: Last Session** | Memory — shows what happened last time | Core value: "where did I leave off?" | Implemented |
| **Tab: Open Items** | Aggregation — unified task list from all sources | Shows what needs doing across platforms | Implemented |
| **Tab: Next Actions** | Prioritization — AI + rules-based suggestions | Answers "what should I do right now?" | Implemented (engine + UI) |
| **Tab: Prompts** | Tooling — project-scoped prompt execution | Power-user feature; AI-assisted workflows | Implemented |
| End Session button | Transition — closes the work loop | Triggers session logging (the core habit) | Implemented |

**UX Summary:** The Resume Card is the heart of buffr. It's a tabbed workspace that answers four questions: (1) What did I do last? (2) What's open? (3) What should I do next? (4) Can AI help me? The tab structure keeps the workspace focused — the user sees one concern at a time.

**Workflow Role:** This is the **core work loop**. The user arrives → reviews last session → checks open items → picks a next action → works → ends session. Every tab serves a step in this loop.

---

#### B3. Session Tracking

| Feature | UX Role | Workflow Role | Current State |
|---------|---------|---------------|---------------|
| End Session modal (goal, changes, next, blockers) | Reflection — structured journaling of work | Creates the data that powers the entire app | Implemented |
| AI auto-fill (What Changed) | Assistance — reduces friction of manual logging | Makes session logging less tedious | Implemented (chain exists) |
| AI suggest (Next Step) | Guidance — LLM recommends continuation | Seeds the Next Actions tab for next visit | Implemented (chain exists) |
| Intent detection (auto-tag) | Classification — auto-labels sessions | Enables pattern recognition over time | Implemented (chain exists) |

**UX Summary:** Session logging is the single most important user action in buffr. The modal is intentionally simple (4 fields) with AI assistance to reduce effort. The "auto-fill" and "suggest" buttons are optional accelerators — the user can always type manually.

**Workflow Role:** This is the **data creation step**. Every other feature (last session display, next actions, AI suggestions) depends on sessions being logged. If the user doesn't log sessions, the app's value drops significantly. The AI buttons exist to lower the barrier.

---

#### B4. Prompt Library

| Feature | UX Role | Workflow Role | Current State |
|---------|---------|---------------|---------------|
| Searchable prompt list | Catalog — browse and find prompts | Organizes reusable AI interactions | Implemented |
| CRUD (create, edit, delete) | Management — maintain the library | Allows the library to grow and evolve | Implemented |
| Template variables | Personalization — context-aware prompts | Makes prompts reusable across projects | Implemented (client-side resolution) |
| Tool tokens (`{{tool:...}}`) | Integration — inject live data into prompts | Bridges prompts with external tools | Implemented (server-side resolution) |
| Run prompt (in workspace) | Execution — send to LLM and get response | Direct AI interaction within project context | Implemented |
| Usage count + sort | Insights — see which prompts are most used | Helps user build a personal toolkit | Implemented |
| Copy to clipboard | Portability — use prompts outside buffr | Allows use in external tools (ChatGPT, etc.) | Implemented |

**UX Summary:** The prompt library is a personal collection of reusable AI prompts. Template variables make them context-aware (they auto-fill with project data). The ability to run prompts directly from the workspace keeps the user in flow.

**Workflow Role:** This is the **AI toolkit layer**. It sits alongside the core loop as a power-user feature. Developers who build good prompts get compounding returns — each prompt becomes a reusable workflow.

---

#### B5. Data Source Configuration

| Feature | UX Role | Workflow Role | Current State |
|---------|---------|---------------|---------------|
| Per-project toggles (GitHub/Notion/Jira) | Control — user decides what data flows in | Prevents noise; keeps Open Items relevant | Implemented |
| Multi-source aggregation | Unification — single list from many platforms | Eliminates context-switching between tools | Implemented |

**UX Summary:** Simple checkbox toggles per project. The user doesn't need to understand how the integrations work — they just check boxes and items appear.

**Workflow Role:** This is the **data intake layer**. It feeds the Open Items tab and influences Next Actions. Without data sources, those features are empty.

---

### C. Secondary Features

#### C1. Tools & Integrations Page

| Feature | UX Role | Workflow Role | Current State |
|---------|---------|---------------|---------------|
| Integration list with status badges | Visibility — see what's connected | Administrative; set-and-forget | Implemented |
| Credential configuration modal | Setup — enter API tokens | One-time setup per integration | Implemented |
| Tool testing | Debugging — verify tools work | Confidence-building; troubleshooting | Implemented |
| Custom integrations | Extensibility — add new tools | Power-user; extends the platform | Implemented |

**UX Summary:** This is an admin page. Most users visit it during setup, configure their integrations, and rarely return. The tool testing feature is valuable for debugging.

**Workflow Role:** This is the **configuration layer**. It enables data sources and tool tokens. It's a prerequisite for features B5 and B4 (tool tokens).

---

#### C2. LLM Provider Switcher

| Feature | UX Role | Workflow Role | Current State |
|---------|---------|---------------|---------------|
| Provider dropdown | Control — choose AI backend | Affects all AI features | Implemented |
| Auto-detection of configured providers | Simplicity — only show what's available | Reduces confusion | Implemented |
| Persistent selection | Convenience — remembers preference | Set once, forget | Implemented |

**UX Summary:** A simple dropdown. The user picks their preferred LLM and forgets about it. Advanced users might switch between providers for different tasks.

**Workflow Role:** This is a **global setting**. It affects session AI, prompt execution, and next-step suggestions. It's configured once.

---

#### C3. Command Palette

| Feature | UX Role | Workflow Role | Current State |
|---------|---------|---------------|---------------|
| Cmd+K search | Speed — keyboard-first navigation | Power-user acceleration | Implemented |
| Navigate to pages | Navigation — quick jumps | Replaces clicking through nav | Implemented |
| Copy prompts | Quick access — grab prompts without visiting library | Workflow shortcut | Implemented |

**UX Summary:** A standard command palette pattern (like VS Code, Linear, Notion). It surfaces navigation and prompts in a single searchable interface.

**Workflow Role:** This is an **acceleration layer**. Everything it does can be done through the normal UI — the palette just makes it faster for keyboard-oriented developers.

---

#### C4. Adaptive Suggestions

| Feature | UX Role | Workflow Role | Current State |
|---------|---------|---------------|---------------|
| Contextual hints | Guidance — nudges toward underused features | Reduces feature blindness | Implemented (logic exists) |
| Dismissable | Non-intrusive — user controls visibility | Prevents annoyance | Implemented |

**UX Summary:** Subtle banners that appear based on project state. They're educational ("you haven't connected a data source") and actionable (links to the relevant page).

**Workflow Role:** This is a **soft onboarding layer**. Since there's no wizard, these suggestions serve as contextual guidance.

---

#### C5. Action Notes

| Feature | UX Role | Workflow Role | Current State |
|---------|---------|---------------|---------------|
| Expandable notes per action | Annotation — attach context to tasks | Captures decisions and reasoning | Implemented |
| Persistent across sessions | Memory — notes survive reloads | Long-running context preservation | Implemented |

**UX Summary:** A simple text area that expands below each next action. The user jots down thoughts, links, or decisions. Notes persist, so they're available next time.

**Workflow Role:** This is a **micro-journaling layer**. It supplements session tracking with per-action context.

---

## Overall Workflow Map

```
┌─────────────────────────────────────────────────────────────────┐
│                        DAILY WORKFLOW                           │
│                                                                 │
│  1. ARRIVE         Open buffr → Dashboard                      │
│       │                                                         │
│  2. SELECT         Pick a project → Workspace                  │
│       │                                                         │
│  3. ORIENT         Last Session tab → "where was I?"           │
│       │                                                         │
│  4. ASSESS         Open Items tab → "what needs doing?"        │
│       │            Next Actions tab → "what should I do now?"  │
│       │                                                         │
│  5. WORK           (external: IDE, browser, terminal)          │
│       │            Optional: Run prompts for AI help           │
│       │                                                         │
│  6. CLOSE          End Session → log goal, changes, next step  │
│       │                                                         │
│  7. LOOP           Next Actions update → ready for tomorrow    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      SETUP (ONE-TIME)                           │
│                                                                 │
│  1. Configure LLM provider (env vars + switcher)               │
│  2. Configure integrations (Tools page)                        │
│  3. Import projects (Dashboard → Import)                       │
│  4. Create prompts (Prompt Library)                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Gap Analysis

Based on comparing FEATURES_ENDUSER.md against the current codebase:

### Fully Implemented (Backend + Frontend Wired)
- Project CRUD and dashboard display
- Session CRUD and End Session modal
- AI chains (summarize, intent, suggest)
- Prompt library CRUD with template resolution
- Tool registry and execution
- Provider switcher and context
- Command palette
- Action notes persistence
- Data source configuration
- Adaptive suggestions logic

### Needs Verification & Polish
| Area | Gap | Priority |
|------|-----|----------|
| Empty states | Verify all empty-state messages match spec wording | Medium |
| Last Session tab | Verify intent badge rendering and empty state | Medium |
| Open Items tab | Verify count in tab label, source badges render correctly | Medium |
| Next Actions tab | Verify Done/Skip buttons, note expansion, action source labels | High |
| Prompt Run response | Verify inline response display + suggested action buttons | High |
| End Session AI buttons | Verify "Auto-fill with AI" and "AI Suggest" buttons work end-to-end | High |
| Tool testing UI | Verify input parameter forms and raw output display | Medium |
| Command palette prompt sort | Verify prompts sorted by usage count | Low |
| Adaptive suggestions | Verify dismissal persistence and all 4 suggestion types render | Medium |
| Toast notifications | Verify all user actions produce appropriate feedback | Medium |

### Potential Gaps (Not Found in Code)
| Area | Gap | Priority |
|------|-----|----------|
| Project creation from UI | FEATURES_ENDUSER.md says "No project creation from the UI" — only import exists. Confirm this is intentional. | Clarify |
| Session history | Only "last session" is displayed. No way to browse past sessions. Intentional per spec but worth noting. | N/A (by design) |
| Error handling UX | Backend classifies errors but frontend error display needs verification. | Medium |
| Loading states | Async fetches need skeleton/spinner states across all tabs. | Medium |

---

## Recommended Implementation Approach

### Strategy: **Verify-First, Then Polish**

The codebase is largely feature-complete at the backend level. The recommended approach is NOT to build new features but to systematically verify each feature works end-to-end, fix gaps, and polish the UX.

---

### Phase 1: Critical Path Verification (Core Loop)

**Goal:** Ensure the daily workflow (arrive → select → orient → work → close) works flawlessly.

**Why first:** If the core loop breaks, nothing else matters. These features are used every single session.

| Step | Task | Files Likely Involved |
|------|------|-----------------------|
| 1.1 | **Verify project import flow** — Import from GitHub, confirm project appears on dashboard with correct metadata | `src/components/dashboard/`, `netlify/functions/projects.ts`, `netlify/functions/tools.ts` |
| 1.2 | **Verify Last Session tab** — Log a session, confirm it displays correctly with intent badge | `src/app/project/[id]/page.tsx`, `netlify/functions/sessions.ts` |
| 1.3 | **Verify End Session modal** — All 4 fields save correctly, AI auto-fill and suggest buttons work | `src/components/session/`, `netlify/functions/session-ai.ts` |
| 1.4 | **Verify Next Actions tab** — Actions appear with correct sources, Done/Skip work, notes expand/save | `src/lib/next-actions.ts`, `src/app/project/[id]/page.tsx` |
| 1.5 | **Verify Open Items tab** — Enable GitHub data source, confirm issues appear with source badges and count | `src/lib/data-sources.ts`, `netlify/functions/tools.ts` |

**Estimated scope:** ~5 focused verification sessions. Fix issues as found.

---

### Phase 2: AI Features Polish

**Goal:** Ensure all AI-powered features produce quality results and handle errors gracefully.

**Why second:** AI features are the differentiator but also the most fragile (API keys, rate limits, model availability).

| Step | Task | Files Likely Involved |
|------|------|-----------------------|
| 2.1 | **Test session summarization** across all providers (Anthropic, OpenAI, Google, Ollama) | `netlify/functions/lib/ai/chains/summarizer.ts` |
| 2.2 | **Test intent detection** — verify it produces expected labels (feature, bugfix, refactor, etc.) | `netlify/functions/lib/ai/chains/intent-detector.ts` |
| 2.3 | **Test next-step suggestion** — verify quality and relevance of suggestions | `netlify/functions/lib/ai/chains/next-step-suggester.ts` |
| 2.4 | **Test prompt execution** with template variables and tool tokens | `netlify/functions/run-prompt.ts`, `netlify/functions/lib/resolve-tools.ts` |
| 2.5 | **Add error handling UI** — display clear messages for API key errors, rate limits, model failures | Frontend components + `netlify/functions/lib/responses.ts` |
| 2.6 | **Verify provider switching** — switch provider mid-session, confirm all AI features use new provider | `src/context/ProviderContext.tsx` |

**Estimated scope:** ~4 focused sessions. Primarily testing + error handling.

---

### Phase 3: Integration Hardening

**Goal:** Ensure GitHub, Notion, and Jira integrations work reliably and display correctly.

**Why third:** Integrations are high-value but depend on external services. Testing them requires real API tokens.

| Step | Task | Files Likely Involved |
|------|------|-----------------------|
| 3.1 | **GitHub integration end-to-end** — configure token, list repos, import project, fetch issues, see in Open Items | `netlify/functions/lib/tools/github.ts`, `netlify/functions/lib/github.ts` |
| 3.2 | **Notion integration end-to-end** — configure, fetch tasks, display in Open Items | `netlify/functions/lib/tools/notion.ts`, `netlify/functions/lib/notion.ts` |
| 3.3 | **Jira integration end-to-end** — configure, fetch issues, display in Open Items | `netlify/functions/lib/tools/jira.ts`, `netlify/functions/lib/jira.ts` |
| 3.4 | **Tool testing UI** — verify each tool can be tested from the Tools page | `src/components/tools/` |
| 3.5 | **Custom integration flow** — create, configure, test, and use a custom integration | `netlify/functions/lib/storage/custom-integrations.ts` |

**Estimated scope:** ~3 sessions. Requires real API tokens for each service.

---

### Phase 4: UX Polish & Edge Cases

**Goal:** Handle all edge cases, empty states, loading states, and visual polish.

**Why fourth:** Polish builds on top of working features. Don't polish what isn't verified.

| Step | Task | Files Likely Involved |
|------|------|-----------------------|
| 4.1 | **Empty states** — verify every empty state has the correct message per spec | All page/tab components |
| 4.2 | **Loading states** — add skeleton/spinner states for all async operations | Tab components, modal components |
| 4.3 | **Toast notifications** — verify all actions (save, delete, copy, error) show appropriate toasts | `src/components/ui/Notification.tsx` |
| 4.4 | **Adaptive suggestions** — verify all 4 suggestion types render, dismiss works, persistence works | `src/lib/suggestions.ts`, workspace component |
| 4.5 | **Command palette polish** — verify search, keyboard nav, prompt copy, usage-count sort | `src/components/CommandPalette.tsx` |
| 4.6 | **Responsive layout check** — verify the app works on tablet-sized screens (not mobile-optimized per spec) | Global CSS, layout components |
| 4.7 | **Keyboard accessibility** — ensure focus management in modals, palette, and tab navigation | All interactive components |

**Estimated scope:** ~3 sessions. Primarily CSS, conditional rendering, and UX details.

---

### Phase 5: Testing & Stability

**Goal:** Ensure reliability through automated tests and manual testing.

**Why last:** Tests codify the behavior established in Phases 1-4.

| Step | Task | Files Likely Involved |
|------|------|-----------------------|
| 5.1 | **Expand unit tests** — cover next-actions edge cases, prompt resolution edge cases, suggestion logic | `src/lib/*.test.ts` |
| 5.2 | **Add integration tests** — test API endpoints with mock storage | `netlify/functions/*.ts` |
| 5.3 | **Manual end-to-end test** — run through the entire daily workflow from empty state to 3rd session | All |
| 5.4 | **Error scenario testing** — invalid API keys, network failures, malformed data | All |
| 5.5 | **Fix any regressions** found during testing | As needed |

**Estimated scope:** ~3 sessions. Test writing + manual QA.

---

## Implementation Priority Matrix

```
                    HIGH IMPACT
                        │
          Phase 1       │       Phase 2
       (Core Loop)      │     (AI Features)
                        │
   LOW EFFORT ──────────┼────────── HIGH EFFORT
                        │
          Phase 4       │       Phase 3
        (UX Polish)     │    (Integrations)
                        │
                    LOW IMPACT
```

Phase 5 (Testing) spans all quadrants and runs in parallel with or after each phase.

---

## Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| AI API costs during testing | Each test call costs money | Use Ollama (local) for development; only test cloud providers in final verification |
| Integration API rate limits | GitHub/Notion/Jira may throttle during testing | Add basic caching; test with small datasets |
| Netlify Blobs latency | Cold starts may cause slow initial loads | Add loading states (Phase 4); consider optimistic UI updates |
| No undo for destructive actions | Accidental delete of project/session/prompt is permanent | Add confirmation modals for all delete actions (verify in Phase 4) |
| Single-user assumption | No auth means anyone with the URL can access | Accept for now (per spec); document as known limitation |

---

## Definition of Done

A feature is "done" when:

1. It works end-to-end (backend + frontend) as described in FEATURES_ENDUSER.md
2. Empty states display the correct message
3. Loading states are present for async operations
4. Errors are caught and displayed with clear messages
5. Toast notification fires for user-initiated actions
6. The feature works with at least 2 LLM providers
7. No console errors in the browser
8. Existing tests still pass

---

## Quick Reference: Feature → Phase Mapping

| Feature | Phase |
|---------|-------|
| Project dashboard + cards | Phase 1 |
| Project workspace (Resume Card) | Phase 1 |
| Last Session tab | Phase 1 |
| Open Items tab | Phase 1 + Phase 3 |
| Next Actions tab | Phase 1 |
| Prompts tab (workspace) | Phase 1 + Phase 2 |
| End Session modal | Phase 1 |
| AI auto-fill | Phase 2 |
| AI suggest | Phase 2 |
| Intent detection | Phase 2 |
| Prompt execution | Phase 2 |
| Provider switcher | Phase 2 |
| GitHub integration | Phase 3 |
| Notion integration | Phase 3 |
| Jira integration | Phase 3 |
| Tool testing UI | Phase 3 |
| Custom integrations | Phase 3 |
| Empty states | Phase 4 |
| Loading states | Phase 4 |
| Toast notifications | Phase 4 |
| Adaptive suggestions | Phase 4 |
| Command palette | Phase 4 |
| Action notes | Phase 4 |
| Unit tests | Phase 5 |
| Integration tests | Phase 5 |
| End-to-end QA | Phase 5 |
