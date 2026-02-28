import { useState, useEffect, useRef, useCallback } from "react";

// ━━━ MOCK DATA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const PROJECTS = [
  { id: "p1", name: "recipe-hub", stack: "Next.js + TypeScript + Tailwind", phase: "mvp", githubRepo: "rein/recipe-hub", netlifySiteUrl: "https://recipe-hub.netlify.app", dataSources: ["github", "jira"], lastGoal: "Wire up Stripe webhook", updatedAt: "2026-02-25T14:30:00Z", dismissedSuggestions: [] },
  { id: "p2", name: "buffr", stack: "Next.js + TypeScript + Tailwind + Netlify", phase: "mvp", githubRepo: "rein/buffr", netlifySiteUrl: "https://buffr.netlify.app", dataSources: ["github"], lastGoal: "Build Phase 2 mapping table", updatedAt: "2026-02-27T10:00:00Z", dismissedSuggestions: ["deploy"] },
  { id: "p3", name: "portfolio-v3", stack: "Astro + Tailwind", phase: "polish", githubRepo: "rein/portfolio-v3", netlifySiteUrl: null, dataSources: ["github", "notion"], lastGoal: "Add case studies section", updatedAt: "2026-02-10T09:00:00Z", dismissedSuggestions: [] },
];

const SESSIONS = {
  p1: { goal: "Wire up Stripe webhook for payment confirmation", whatChanged: ["Added POST /api/webhooks/stripe endpoint", "Created payment confirmation email template", "Updated order status model with 'paid' state"], nextStep: "Test payment flow with Stripe test keys", blockers: "Waiting on Stripe webhook signing secret", createdAt: "2026-02-25T14:30:00Z", detectedIntent: "payment integration" },
  p2: { goal: "Build Phase 2 data source mapping table", whatChanged: ["Defined DATA_SOURCE_TOOLS mapping", "Created consistent tool output shape", "Registered new GitHub tools"], nextStep: "Refactor Session Memory to use mapping table", blockers: null, createdAt: "2026-02-27T10:00:00Z", detectedIntent: "multi-source architecture" },
};

const OPEN_ITEMS = [
  { id: "gh-42", title: "Fix pagination on /recipes page", status: "open", source: "github", labels: ["bug"], url: "https://github.com/rein/recipe-app/issues/42" },
  { id: "gh-38", title: "Add rate limiting to API endpoints", status: "open", source: "github", labels: ["security"], url: "https://github.com/rein/recipe-app/issues/38" },
  { id: "BUFF-15", title: "Implement recipe search with filters", status: "In Progress", source: "jira", labels: ["feature"], url: "https://yourteam.atlassian.net/browse/BUFF-15" },
  { id: "BUFF-18", title: "Add user avatar upload", status: "To Do", source: "jira", labels: ["feature"], url: "https://yourteam.atlassian.net/browse/BUFF-18" },
  { id: "gh-51", title: "Update README with API docs", status: "open", source: "github", labels: ["docs"], url: "https://github.com/rein/recipe-app/issues/51" },
];

const NEXT_ACTIONS = [
  { id: "ai-1", text: "Write integration tests for Stripe webhook handler", source: "ai", scope: "~15 min" },
  { id: "session", text: "Test payment flow with Stripe test keys", source: "session" },
  { id: "gh-42", text: "Fix #42: Fix pagination on /recipes page", source: "github" },
  { id: "BUFF-15", text: "Continue: Implement recipe search with filters", source: "jira" },
];

const PROMPTS = [
  // ── Project Setup & Standards ──
  { id: "pr1", title: "Generate AI Rules", body: "Create an .ai-rules file for {{project.name}} based on the {{project.stack}} stack. Include coding standards, naming conventions, file organization patterns, and common pitfalls to avoid.\n\n{{tool:github_get_repo}}\n{{tool:github_analyze_repo}}", tags: ["setup", "standards"], usageCount: 14, scope: "project" },
  { id: "pr2", title: "Generate Architecture Doc", body: "Write ARCHITECTURE.md for {{project.name}}. Describe the system structure, key directories, data flow, tech decisions and tradeoffs, and deployment model.\n\nStack: {{project.stack}}\nGoals: {{project.goals}}\n\n{{tool:github_analyze_repo}}", tags: ["setup", "docs"], usageCount: 11, scope: "project" },
  { id: "pr3", title: "Update Changelog", body: "Review recent activity and generate/update CHANGELOG.md entries for {{project.name}}. Group by: Added, Changed, Fixed, Removed. Use semantic versioning.\n\n{{tool:github_list_commits}}\n{{tool:github_list_issues:state=closed}}\n{{tool:jira_list_resolved}}", tags: ["docs", "release"], usageCount: 9, scope: "project" },
  { id: "pr4", title: "Generate QA Feature Map", body: "Create features_qa.md for {{project.name}}: a testing-focused feature map.\n\nFor each feature, list:\n- What it does\n- Happy path steps\n- Edge cases to test\n- What \"broken\" looks like\n- Priority: critical / high / medium / low\n\n{{tool:github_list_issues}}\n{{tool:github_analyze_repo}}", tags: ["qa", "docs"], usageCount: 5, scope: "project" },
  { id: "pr5", title: "Generate Product Feature Map", body: "Create features_product.md for {{project.name}}: a product-focused feature map.\n\nFor each feature, describe:\n- User value (why it matters)\n- Current state: shipped / in-progress / planned\n- Dependencies\n- Success criteria\n\n{{tool:github_list_issues}}\n{{tool:notion_list_tasks}}\n{{tool:jira_list_issues}}", tags: ["product", "docs"], usageCount: 4, scope: "project" },
  { id: "pr6", title: "Generate Deployment Guide", body: "Write DEPLOYMENT.md for {{project.name}}. Cover:\n- Environment setup and required env vars\n- Build steps\n- Deploy pipeline\n- Rollback process\n- Monitoring and health checks\n\nStack: {{project.stack}}\nConstraints: {{project.constraints}}", tags: ["setup", "deploy"], usageCount: 3, scope: "project" },

  // ── Active Development ──
  { id: "pr7", title: "Generate Diagram", body: "Create a Mermaid diagram for {{project.name}} showing the system architecture.\n\nInclude: key components, data flow between them, external services, and storage layers.\n\nStack: {{project.stack}}\n{{tool:github_analyze_repo}}", tags: ["visual", "architecture"], usageCount: 8, scope: "project" },
  { id: "pr8", title: "Triage Open Items", body: "Review all open items across my tools for {{project.name}}. Categorize by:\n\n1. Blocking other work (do first)\n2. Quick wins under 30 min\n3. Stale items (>7 days untouched)\n4. Can be deferred\n\nRecommend what to tackle in my next session.\n\n{{tool:github_list_issues:state=open}}\n{{tool:jira_list_issues:status=open}}\n{{tool:notion_list_tasks:status=To Do}}", tags: ["planning", "triage"], usageCount: 12, scope: "global" },
  { id: "pr9", title: "Draft Issue from Context", body: "Based on my last session, draft a GitHub issue for the next piece of work on {{project.name}}.\n\nLast goal: {{lastSession.goal}}\nNext step: {{lastSession.nextStep}}\nBlockers: {{lastSession.blockers}}\n\nInclude: clear title, description, acceptance criteria, and suggested labels.\n\n{{tool:github_list_issues:state=open&limit=5}}", tags: ["github", "workflow"], usageCount: 7, scope: "global" },
  { id: "pr10", title: "Refactor Assessment", body: "Analyze the {{project.name}} codebase and identify areas that need refactoring. Consider:\n\n- Code duplication\n- Oversized components or functions\n- Missing error handling\n- Inconsistent patterns\n- Performance concerns\n\nPrioritize by impact and effort.\n\n{{tool:github_analyze_repo}}\n{{tool:github_get_diffs}}", tags: ["code-quality", "planning"], usageCount: 3, scope: "project" },

  // ── Session Lifecycle ──
  { id: "pr11", title: "Session Kickoff Brief", body: "Give me a 30-second briefing to start my session on {{project.name}}.\n\n- What was I working on?\n- What's the next logical step?\n- What's the current state of open work?\n- Anything I should be aware of?\n\nLast goal: {{lastSession.goal}}\nNext step: {{lastSession.nextStep}}\nBlockers: {{lastSession.blockers}}\n\n{{tool:github_list_issues:state=open&limit=5}}\n{{tool:github_list_commits}}", tags: ["session", "context"], usageCount: 15, scope: "global" },
  { id: "pr12", title: "End-of-Session Summary", body: "Summarize what happened this session on {{project.name}}.\n\nInclude: code changes, closed items, and what's still open. Format as a bullet list I can paste into the session form.\n\n{{tool:github_get_diffs}}\n{{tool:github_list_issues:state=closed}}\n{{tool:jira_list_resolved}}", tags: ["session", "summary"], usageCount: 10, scope: "global" },
  { id: "pr13", title: "Weekly Progress Report", body: "Write a short weekly progress summary for {{project.name}}.\n\nSections: What shipped, What's in progress, What's blocked.\n\n{{tool:github_list_commits}}\n{{tool:github_list_issues:state=closed}}\n{{tool:jira_list_resolved}}\n{{tool:notion_list_tasks:status=Done}}", tags: ["reporting", "summary"], usageCount: 6, scope: "global" },

  // ── Quality & Review ──
  { id: "pr14", title: "Pre-Deploy Checklist", body: "Generate a pre-deploy checklist for {{project.name}} based on {{project.stack}}.\n\nInclude:\n- Env vars verified\n- Build passes locally\n- Tests passing\n- Migration steps (if any)\n- Feature flags\n- Rollback plan\n- Open bugs that might block\n\n{{tool:github_list_issues:state=open&labels=bug}}", tags: ["deploy", "qa"], usageCount: 4, scope: "project" },
  { id: "pr15", title: "Write PR Description", body: "Write a pull request description for {{project.name}}.\n\nRecent commits:\n{{tool:github_list_commits}}\n\nCode changes:\n{{tool:github_get_diffs}}\n\nFeature context: {{lastSession.goal}}\n\nInclude: summary, what changed, how to test, and any notes for reviewers.", tags: ["github", "workflow"], usageCount: 8, scope: "global" },
  { id: "pr16", title: "Dependency Review", body: "Review the dependencies in {{project.name}} for:\n\n- Outdated packages that need updating\n- Known security vulnerabilities\n- Unused imports that can be removed\n- Better alternatives to current packages\n\nStack: {{project.stack}}\n{{tool:github_analyze_repo}}", tags: ["maintenance", "code-quality"], usageCount: 2, scope: "project" },

  // ── Reference Prompts (plain text — copy-paste into Claude Code or other tools) ──
  { id: "pr17", title: "TypeScript System Prompt", body: "You are a senior TypeScript developer. Follow these standards:\n\n- Strict mode always. No `any` unless explicitly justified with a comment.\n- Prefer `interface` over `type` for object shapes. Use `type` for unions and intersections.\n- Use `const` by default. `let` only when reassignment is necessary. Never `var`.\n- Functions: max 40 lines. If longer, extract. Single responsibility.\n- Error handling: never swallow errors. Always `catch` with typed errors or rethrow.\n- Naming: PascalCase for types/interfaces/components, camelCase for variables/functions, UPPER_SNAKE for constants.\n- Imports: group by external → internal → types. No circular imports.\n- No default exports except for React page/layout components.\n- Prefer early returns over nested conditionals.\n- All async functions must have error boundaries.\n- Comments explain WHY, not WHAT. Code should explain what.", tags: ["reference", "standards"], usageCount: 24, scope: "global" },
  { id: "pr18", title: "Code Review Checklist", body: "When reviewing code, check each item:\n\n□ Does it do what the PR description says?\n□ Are there any unhandled edge cases?\n□ Error handling: are errors caught, logged, and surfaced to the user?\n□ Naming: are variables, functions, and files named clearly?\n□ Duplication: is there copy-pasted code that should be extracted?\n□ Performance: any unnecessary re-renders, N+1 queries, or missing memoization?\n□ Security: user input validated? SQL injection? XSS? Auth checks?\n□ Tests: are the important paths covered? Are edge cases tested?\n□ Types: are types accurate, or are there `any` escapes?\n□ Accessibility: semantic HTML? ARIA labels? Keyboard navigation?\n□ Dependencies: any new packages? Are they justified and maintained?\n□ Documentation: do public APIs and complex logic have comments?", tags: ["reference", "code-quality"], usageCount: 18, scope: "global" },
  { id: "pr19", title: "React Component Prompt", body: "Build React components following these rules:\n\n- Functional components only. No class components.\n- Props: define with interface, destructure in signature. Always provide defaults for optional props.\n- State: useState for simple, useReducer for complex. Never mutate state directly.\n- Effects: always include cleanup. Specify dependency arrays explicitly. No missing deps.\n- Memoization: useMemo for expensive computations, useCallback for callbacks passed to children. Don't over-memoize.\n- Composition over prop drilling. Use context sparingly — only for truly global state.\n- One component per file. Co-locate styles, tests, and types.\n- Loading/error/empty states: every component that fetches data must handle all three.\n- Event handlers: prefix with `handle` (handleClick, handleSubmit).\n- Avoid inline styles. Use Tailwind classes or CSS modules.\n- Keep components under 150 lines. Extract sub-components when logic grows.", tags: ["reference", "standards"], usageCount: 16, scope: "global" },
  { id: "pr20", title: "Git Commit Message Format", body: "Write commit messages in this format:\n\ntype(scope): short description\n\nOptional longer body explaining WHY the change was made,\nnot what was changed (the diff shows that).\n\nTypes:\n- feat: new feature\n- fix: bug fix\n- refactor: code restructuring (no behavior change)\n- docs: documentation only\n- style: formatting, semicolons, etc (no code change)\n- test: adding or fixing tests\n- chore: build, CI, deps, tooling\n- perf: performance improvement\n\nRules:\n- Subject line: max 72 chars, imperative mood (\"add\" not \"added\")\n- No period at end of subject\n- Blank line between subject and body\n- Reference issue numbers: \"Closes #42\" or \"Relates to BUFF-15\"", tags: ["reference", "workflow"], usageCount: 20, scope: "global" },
  { id: "pr21", title: "API Endpoint Prompt", body: "When building API endpoints, follow these patterns:\n\n- RESTful naming: /api/resources (plural), /api/resources/:id\n- HTTP methods: GET (read), POST (create), PUT/PATCH (update), DELETE (remove)\n- Always validate request body and query params at the boundary\n- Return consistent response shape: { data, error, meta }\n- Status codes: 200 (ok), 201 (created), 400 (bad request), 401 (unauthorized), 404 (not found), 500 (server error)\n- Error responses include: code, message, and optionally details\n- Pagination: use cursor-based for large datasets, offset for small\n- Rate limiting: include X-RateLimit headers\n- Auth: validate tokens before any business logic\n- Logging: log request method, path, status, and duration. Never log tokens or PII.\n- Timeouts: set reasonable timeouts for external API calls (5s default)\n- Idempotency: POST/PUT should be safe to retry", tags: ["reference", "standards"], usageCount: 10, scope: "global" },
  { id: "pr22", title: "Bug Report Template", body: "## Bug Report\n\n**Title:** [Clear, specific description]\n\n**Environment:**\n- Browser/OS:\n- App version:\n- User role:\n\n**Steps to Reproduce:**\n1. Go to...\n2. Click on...\n3. Observe...\n\n**Expected Behavior:**\nWhat should happen.\n\n**Actual Behavior:**\nWhat actually happens.\n\n**Screenshots/Logs:**\n[Attach if applicable]\n\n**Severity:**\n- Critical: app crashes, data loss\n- High: feature broken, no workaround\n- Medium: feature broken, workaround exists\n- Low: cosmetic, minor inconvenience\n\n**Additional Context:**\nAnything else relevant.", tags: ["reference", "workflow"], usageCount: 8, scope: "global" },
];

const TOOLS_DATA = [
  { name: "GitHub", status: "connected", tools: 10, icon: "github", desc: "Issues, commits, repos, PRs" },
  { name: "Notion", status: "connected", tools: 4, icon: "notion", desc: "Tasks, pages, databases" },
  { name: "Jira", status: "connected", tools: 5, icon: "jira", desc: "Issues, sprints, transitions" },
];

const MCP_TOOLS = [
  { name: "github_list_issues", integration: "github", desc: "List issues for a repo with optional filters", params: "repo, state?, labels?, limit?" },
  { name: "github_create_issue", integration: "github", desc: "Create a new issue in a repo", params: "repo, title, body?, labels?" },
  { name: "github_close_issue", integration: "github", desc: "Close an issue by number", params: "repo, issue_number" },
  { name: "github_list_commits", integration: "github", desc: "List commits since a timestamp", params: "repo, since?" },
  { name: "github_get_diffs", integration: "github", desc: "Get code diffs since a commit", params: "repo, since?" },
  { name: "github_get_repo", integration: "github", desc: "Get repo metadata", params: "repo" },
  { name: "github_list_repos", integration: "github", desc: "List all user repos", params: "per_page?" },
  { name: "github_analyze_repo", integration: "github", desc: "Detect stack, frameworks, dev tools", params: "repo" },
  { name: "github_create_repo", integration: "github", desc: "Create a new GitHub repo", params: "name, visibility?, description?" },
  { name: "github_push_files", integration: "github", desc: "Push files as a commit", params: "repo, files, message" },
  { name: "notion_list_tasks", integration: "notion", desc: "Query tasks from a Notion database", params: "status?, limit?" },
  { name: "notion_get_task", integration: "notion", desc: "Fetch a single Notion page", params: "page_id" },
  { name: "notion_update_task", integration: "notion", desc: "Update task status/properties", params: "page_id, status?" },
  { name: "notion_create_task", integration: "notion", desc: "Create a new task page", params: "title, status?" },
  { name: "jira_list_issues", integration: "jira", desc: "Search open issues via JQL", params: "project?, status?, limit?" },
  { name: "jira_list_resolved", integration: "jira", desc: "Recently resolved issues", params: "project?, since?" },
  { name: "jira_get_issue", integration: "jira", desc: "Fetch issue with details", params: "key" },
  { name: "jira_create_issue", integration: "jira", desc: "Create a new Jira issue", params: "summary, type?, priority?" },
  { name: "jira_transition_issue", integration: "jira", desc: "Move issue through workflow", params: "key, transition" },
];



// ━━━ ICONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const I = {
  github: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>,
  jira: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 00-.84-.84H11.53zM6.77 6.8a4.362 4.362 0 004.34 4.34h1.78v1.72a4.362 4.362 0 004.34 4.34V7.63a.84.84 0 00-.83-.83H6.77zM2 11.6c0 2.4 1.95 4.34 4.34 4.34h1.78v1.72c0 2.4 1.95 4.34 4.35 4.34v-9.57a.84.84 0 00-.84-.83H2z"/></svg>,
  notion: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.98-.7-2.055-.607L2.84 2.298c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.166V6.354c0-.606-.233-.933-.748-.886l-15.177.887c-.56.046-.747.326-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952l1.448.327s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.234 4.764 7.28v-6.44l-1.215-.14c-.093-.514.28-.886.747-.933zM1.936 1.035l13.31-.933c1.635-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.933.653.933 1.213v16.378c0 1.026-.373 1.632-1.68 1.726l-15.458.933c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.448-1.632z"/></svg>,
  sparkle: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.912 5.813a2 2 0 001.275 1.275L21 12l-5.813 1.912a2 2 0 00-1.275 1.275L12 21l-1.912-5.813a2 2 0 00-1.275-1.275L3 12l5.813-1.912a2 2 0 001.275-1.275L12 3z"/></svg>,
  check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  x: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  copy: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
  play: <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  chevron: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>,
  loader: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="animate-spin"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>,
  link: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
  search: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  plus: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  back: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  folder: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>,
  cmd: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 3a3 3 0 00-3 3v12a3 3 0 003 3 3 3 0 003-3 3 3 0 00-3-3H6a3 3 0 00-3 3 3 3 0 003 3 3 3 0 003-3V6a3 3 0 00-3-3 3 3 0 00-3 3 3 3 0 003 3h12a3 3 0 003-3 3 3 0 00-3-3z"/></svg>,
  globe: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>,
  tool: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>,
  edit: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  trash: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>,
  prompt: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
};

const srcIcon = (s) => s === "github" ? I.github : s === "jira" ? I.jira : s === "notion" ? I.notion : s === "ai" ? I.sparkle : s === "session" ? I.back : null;
const srcColor = (s) => s === "github" ? "#8b949e" : s === "jira" ? "#2684FF" : s === "notion" ? "#ffffffcc" : s === "ai" ? "#c084fc" : s === "session" ? "#a78bfa" : "#666";
const phaseColor = (p) => p === "idea" ? "#fbbf24" : p === "mvp" ? "#818cf8" : p === "polish" ? "#34d399" : p === "deploy" ? "#f472b6" : "#888";

function timeAgo(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 3600) return `${Math.floor(d/60)}m ago`;
  if (d < 86400) return `${Math.floor(d/3600)}h ago`;
  return `${Math.floor(d/86400)}d ago`;
}

// ━━━ TYPING HOOK ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function useTypingEffect(text, speed = 10, trigger = true) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!trigger || !text) { setDisplayed(""); setDone(false); return; }
    setDisplayed(""); setDone(false);
    let i = 0;
    const iv = setInterval(() => { i++; setDisplayed(text.slice(0, i)); if (i >= text.length) { clearInterval(iv); setDone(true); } }, speed);
    return () => clearInterval(iv);
  }, [text, trigger]);
  return { displayed, done };
}

// ━━━ SHARED COMPONENTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const fonts = `'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif`;
const mono = `'JetBrains Mono', 'SF Mono', 'Fira Code', monospace`;

function Badge({ children, color = "#888", small }) {
  return <span className={`inline-flex items-center gap-1 ${small ? "px-1 py-0.5 text-[9px]" : "px-1.5 py-0.5 text-[10px]"} rounded font-semibold uppercase tracking-wider`} style={{ color, background: `${color}18`, border: `1px solid ${color}30` }}>{children}</span>;
}

function SourceBadge({ source }) {
  return <Badge color={srcColor(source)}>{srcIcon(source)} {source}</Badge>;
}

function Btn({ children, variant = "default", size = "md", onClick, disabled, className = "" }) {
  const base = "inline-flex items-center justify-center gap-1.5 font-medium rounded-lg transition-all disabled:opacity-40";
  const sizes = { sm: "px-2.5 py-1 text-xs", md: "px-4 py-2 text-sm", lg: "px-6 py-2.5 text-sm" };
  const variants = {
    default: "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700/60",
    primary: "bg-purple-600 hover:bg-purple-500 text-white border border-purple-500/40",
    ghost: "hover:bg-white/5 text-zinc-400 hover:text-zinc-200",
    danger: "bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20",
  };
  return <button onClick={onClick} disabled={disabled} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}>{children}</button>;
}

function Input({ label, value, onChange, placeholder, textarea, mono: useMono }) {
  const cls = `w-full px-3 py-2 rounded-lg bg-zinc-900/80 border border-zinc-700/50 text-zinc-200 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-colors ${useMono ? "" : ""}`;
  return (
    <div className="space-y-1.5">
      {label && <label className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">{label}</label>}
      {textarea
        ? <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={3} className={cls} style={useMono ? { fontFamily: mono } : {}} />
        : <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className={cls} style={useMono ? { fontFamily: mono } : {}} />
      }
    </div>
  );
}

// ━━━ COMMAND PALETTE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function CommandPalette({ open, onClose, onAction, prompts }) {
  const [q, setQ] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    if (open && ref.current) { ref.current.focus(); setQ(""); }
  }, [open]);

  useEffect(() => {
    const handler = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); onAction("toggle-palette"); } if (e.key === "Escape" && open) onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, onAction]);

  if (!open) return null;

  const commands = [
    { id: "load", label: "Load Existing", desc: "Import a GitHub repo", icon: I.folder, action: "load-existing" },
    { id: "end", label: "End Session", desc: "Save progress and close session", icon: I.check, action: "end-session" },
    { id: "dash", label: "Dashboard", desc: "View all projects", icon: I.back, action: "dashboard" },
    { id: "tools", label: "Tools & Integrations", desc: "Manage connected services", icon: I.tool, action: "tools" },
    { id: "prompts-lib", label: "Prompt Library", desc: "Manage and create prompts", icon: I.prompt, action: "prompts" },
    ...prompts.map(p => ({ id: `p-${p.id}`, label: p.title, desc: p.tags.join(", "), icon: I.sparkle, action: `run-prompt-${p.id}`, isPrompt: true })),
  ];

  const filtered = commands.filter(c => c.label.toLowerCase().includes(q.toLowerCase()) || c.desc.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg rounded-xl border border-zinc-700/60 bg-zinc-900 shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()} style={{ animation: "slideDown .15s ease-out" }}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
          {I.search}
          <input ref={ref} value={q} onChange={e => setQ(e.target.value)} placeholder="Search commands, prompts…" className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none" />
          <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] text-zinc-500 border border-zinc-700/50">ESC</kbd>
        </div>
        <div className="max-h-[320px] overflow-y-auto py-1.5">
          {filtered.length === 0 && <div className="px-4 py-6 text-center text-sm text-zinc-500">No results</div>}
          {filtered.map(c => (
            <button key={c.id} onClick={() => { onAction(c.action); onClose(); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-white/[0.04] transition-colors group">
              <span className={`${c.isPrompt ? "text-purple-400" : "text-zinc-500"} group-hover:text-zinc-300 transition-colors`}>{c.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-zinc-200">{c.label}</div>
                <div className="text-[11px] text-zinc-500 truncate">{c.desc}</div>
              </div>
              {c.isPrompt && <span className="flex gap-1"><Badge color="#c084fc" small>Run</Badge><Badge color="#888" small>Copy</Badge></span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ━━━ NAV BAR ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function NavBar({ page, onNavigate, onPalette }) {
  const [provider, setProvider] = useState("anthropic");
  const providers = [
    { id: "anthropic", label: "Claude", model: "claude-sonnet-4-20250514" },
    { id: "openai", label: "GPT", model: "gpt-4o" },
  ];

  return (
    <nav className="sticky top-0 z-40 flex items-center justify-between px-4 sm:px-6 py-3 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md">
      <div className="flex items-center gap-4">
        <button onClick={() => onNavigate("dashboard")} className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center">
            <span className="text-[10px] font-black text-white" style={{ fontFamily: mono }}>b</span>
          </div>
          <span className="text-sm font-semibold text-zinc-200 hidden sm:inline" style={{ fontFamily: mono }}>buffr</span>
        </button>
        <div className="flex items-center gap-1 text-xs text-zinc-600">
          {["dashboard", "project", "tools", "prompts"].map(p => page === p && (
            <span key={p} className="px-2 py-0.5 rounded bg-zinc-800/60 text-zinc-400 capitalize">{p === "project" ? "Resume Card" : p === "prompts" ? "Prompt Library" : p}</span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={onPalette} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-zinc-300 text-xs transition-colors">
          {I.cmd} <span className="hidden sm:inline">Cmd+K</span>
        </button>
        <select value={provider} onChange={e => setProvider(e.target.value)} className="bg-zinc-800/80 border border-zinc-700/50 rounded-lg px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-purple-500/40 cursor-pointer">
          {providers.map(p => <option key={p.id} value={p.id}>{p.label} — {p.model}</option>)}
        </select>
      </div>
    </nav>
  );
}

// ━━━ DASHBOARD ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function Dashboard({ onNavigate, externalShowLoad, onLoadShown }) {
  const [showLoad, setShowLoad] = useState(false);

  useEffect(() => {
    if (externalShowLoad) { setShowLoad(true); onLoadShown(); }
  }, [externalShowLoad, onLoadShown]);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Projects</h1>
        <Btn variant="primary" size="sm" onClick={() => setShowLoad(true)}>{I.folder} Load Existing</Btn>
      </div>

      {/* Quick nav */}
      <div className="flex gap-2 mb-5">
        <button onClick={() => onNavigate("prompts")} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-800/50 bg-zinc-900/20 hover:bg-zinc-800/30 hover:border-zinc-700/50 text-sm text-zinc-400 hover:text-zinc-200 transition-all">
          {I.prompt} <span>Prompt Library</span> <span className="text-[10px] text-zinc-600">{PROMPTS.length}</span>
        </button>
        <button onClick={() => onNavigate("tools")} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-800/50 bg-zinc-900/20 hover:bg-zinc-800/30 hover:border-zinc-700/50 text-sm text-zinc-400 hover:text-zinc-200 transition-all">
          {I.tool} <span>Tools</span> <span className="text-[10px] text-zinc-600">{MCP_TOOLS.length}</span>
        </button>
      </div>
      <div className="space-y-2">
        {PROJECTS.map(p => (
          <button key={p.id} onClick={() => onNavigate("project", p.id)} className="w-full flex items-center gap-4 px-4 py-3.5 rounded-xl border border-zinc-800/60 bg-zinc-900/30 hover:bg-zinc-800/30 hover:border-zinc-700/60 transition-all text-left group">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2.5 mb-1">
                <span className="text-sm font-medium text-zinc-200" style={{ fontFamily: mono }}>{p.name}</span>
                <Badge color={phaseColor(p.phase)}>{p.phase}</Badge>
                {p.dataSources.map(ds => <span key={ds} style={{ color: srcColor(ds) }} className="opacity-50">{srcIcon(ds)}</span>)}
              </div>
              <div className="flex items-center gap-3 text-[12px] text-zinc-500">
                <span>{p.stack}</span>
                <span>·</span>
                <span>{timeAgo(p.updatedAt)}</span>
                {p.lastGoal && <><span>·</span><span className="truncate max-w-[200px]">{p.lastGoal}</span></>}
              </div>
            </div>
            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              {p.githubRepo && <span className="text-zinc-500">{I.github}</span>}
              {p.netlifySiteUrl && <span className="text-zinc-500">{I.globe}</span>}
              <span className="text-zinc-600">{I.chevron}</span>
            </div>
          </button>
        ))}
      </div>

      {showLoad && <LoadExistingModal onClose={() => setShowLoad(false)} onNavigate={onNavigate} />}
    </div>
  );
}
function LoadExistingModal({ onClose, onNavigate }) {
  const [url, setUrl] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);

  const handleAnalyze = () => {
    setAnalyzing(true);
    setTimeout(() => {
      setAnalyzing(false);
      setResult({
        name: "recipe-hub", stack: ["Next.js", "TypeScript", "Tailwind CSS", "Prisma"],
        phase: "mvp", devTools: [".eslintrc.json", "tsconfig.json", ".prettierrc"],
        openIssues: 8, lastCommit: "2d ago",
        missingFiles: ["AI_RULES.md", "ARCHITECTURE.md", "DEPLOYMENT.md", "CONTRIBUTING.md"],
      });
    }, 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg rounded-2xl border border-zinc-700/60 bg-zinc-900 shadow-2xl" onClick={e => e.stopPropagation()} style={{ animation: "slideDown .2s ease-out" }}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/60">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Load Existing Project</h3>
            <p className="text-xs text-zinc-500 mt-0.5">Enter a GitHub repo URL. buffr will analyze it and set up tracking.</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">{I.x}</button>
        </div>

        <div className="px-5 py-4">
          <div className="flex gap-2">
            <div className="flex-1"><Input value={url} onChange={setUrl} placeholder="rein/recipe-hub or https://github.com/rein/recipe-hub" mono /></div>
            <Btn variant="primary" onClick={handleAnalyze} disabled={!url.trim() || analyzing}>{analyzing ? <>{I.loader} Analyzing…</> : "Analyze"}</Btn>
          </div>

          {result && (
            <div className="mt-5 rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-4 space-y-4" style={{ animation: "fadeIn .3s ease-out" }}>
              <div className="flex items-center gap-3">
                <span className="text-zinc-200 font-medium text-sm" style={{ fontFamily: mono }}>{result.name}</span>
                <Badge color={phaseColor(result.phase)}>{result.phase}</Badge>
                <span className="text-xs text-zinc-500">{result.openIssues} open issues · last commit {result.lastCommit}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {result.stack.map(s => <Badge key={s} color="#818cf8">{s}</Badge>)}
                {result.devTools.map(t => <Badge key={t} color="#666" small>{t}</Badge>)}
              </div>
              {result.missingFiles.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Missing project files (apply?)</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {result.missingFiles.map(f => (
                      <label key={f} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/[0.02] cursor-pointer">
                        <input type="checkbox" defaultChecked className="accent-purple-500 w-3.5 h-3.5" />
                        <span className="text-xs text-zinc-300" style={{ fontFamily: mono }}>{f}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Btn onClick={onClose}>Cancel</Btn>
                <Btn variant="primary" onClick={() => { onClose(); onNavigate("project", "p1"); }}>{I.plus} Import Project</Btn>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ━━━ RESUME CARD (PROJECT VIEW) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function ResumeCard({ project, onNavigate }) {
  const [tab, setTab] = useState("session");
  const [sources, setSources] = useState(project.dataSources);
  const [endSession, setEndSession] = useState(false);
  const session = SESSIONS[project.id];
  const tabs = [
    { id: "session", label: "Last Session" },
    { id: "items", label: "Open Items" },
    { id: "actions", label: "Next Actions" },
    { id: "prompts", label: "Prompts" },
  ];

  const suggestions = [];
  if (!project.netlifySiteUrl && !project.dismissedSuggestions.includes("deploy")) suggestions.push("Set up deploy — connect to Netlify for automatic deployments");
  if (project.dataSources.length <= 1 && !project.dismissedSuggestions.includes("sources")) suggestions.push("Connect a data source — add Notion or Jira for richer context");

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <button onClick={() => onNavigate("dashboard")} className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 mb-4 transition-colors">{I.back} Dashboard</button>

      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <span className="text-lg font-semibold text-zinc-100" style={{ fontFamily: mono }}>{project.name}</span>
            <Badge color={phaseColor(project.phase)}>{project.phase}</Badge>
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span>{project.stack}</span>
            {project.githubRepo && <a className="flex items-center gap-1 hover:text-zinc-300 transition-colors">{I.github} {project.githubRepo}</a>}
            {project.netlifySiteUrl && <a className="flex items-center gap-1 hover:text-zinc-300 transition-colors">{I.globe} Site</a>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Btn variant="primary" size="sm" onClick={() => setEndSession(true)}>End Session</Btn>
        </div>
      </div>

      {/* Adaptive Suggestions */}
      {suggestions.slice(0, 2).map((s, i) => (
        <div key={i} className="flex items-center justify-between px-3 py-2 mb-2 rounded-lg border border-amber-500/20 bg-amber-500/5 text-amber-200 text-[13px]">
          <span className="flex items-center gap-2"><span className="text-amber-400">💡</span>{s}</span>
          <span className="flex gap-1.5">
            <button className="px-2.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 text-xs font-medium transition-colors">Do it</button>
            <button className="px-2 py-0.5 rounded hover:bg-white/5 text-amber-300/50 text-xs transition-colors">Dismiss</button>
          </span>
        </div>
      ))}

      {/* Detected Intent */}
      {session?.detectedIntent && (
        <div className="flex items-center gap-2 mb-3 px-3 py-1.5 rounded-lg bg-purple-500/[0.05] border border-purple-500/15">
          <span className="text-purple-400">{I.sparkle}</span>
          <span className="text-xs text-purple-300/80">You were working on: <strong className="text-purple-200">{session.detectedIntent}</strong></span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-zinc-800/60">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === t.id ? "text-zinc-200 border-purple-500" : "text-zinc-500 border-transparent hover:text-zinc-300"}`}>{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ animation: "fadeIn .2s ease-out" }}>
        {tab === "session" && <SessionTab session={session} />}
        {tab === "items" && <ItemsTab sources={sources} onChangeSources={setSources} />}
        {tab === "actions" && <ActionsTab />}
        {tab === "prompts" && <PromptsTab />}
      </div>

      {/* End Session Modal */}
      {endSession && <EndSessionModal onClose={() => setEndSession(false)} session={session} sources={sources} />}
    </div>
  );
}

function SessionTab({ session }) {
  if (!session) return <div className="py-8 text-center text-sm text-zinc-600">No sessions yet. Start your first session!</div>;
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-1">Goal</div>
        <div className="text-sm text-zinc-200">{session.goal}</div>
      </div>
      <div>
        <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5">What Changed</div>
        <div className="space-y-1">{session.whatChanged.map((w, i) => <div key={i} className="text-sm text-zinc-300 flex items-start gap-2"><span className="text-zinc-600 mt-0.5">·</span>{w}</div>)}</div>
      </div>
      <div>
        <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-1">Next Step</div>
        <div className="text-sm text-zinc-200">{session.nextStep}</div>
      </div>
      {session.blockers && (
        <div>
          <div className="text-[11px] text-red-400/60 uppercase tracking-wider font-semibold mb-1">Blockers</div>
          <div className="text-sm text-red-300/80">{session.blockers}</div>
        </div>
      )}
      <div className="text-[11px] text-zinc-600">{timeAgo(session.createdAt)}</div>
    </div>
  );
}

function ItemsTab({ sources, onChangeSources }) {
  const filtered = OPEN_ITEMS.filter(item => sources.includes(item.source));
  return (
    <div>
      <div className="flex items-center gap-3 pb-3 mb-3 border-b border-zinc-800/50">
        <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">Filter</span>
        {["github", "jira", "notion"].map(s => (
          <label key={s} className="flex items-center gap-1.5 cursor-pointer group">
            <input type="checkbox" checked={sources.includes(s)} onChange={() => onChangeSources(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])} className="accent-purple-500 w-3 h-3" />
            <span className="flex items-center gap-1 text-[11px] group-hover:opacity-100 transition-opacity" style={{ color: sources.includes(s) ? srcColor(s) : "#555", opacity: sources.includes(s) ? 1 : 0.5 }}>
              {srcIcon(s)}
              <span className="capitalize">{s}</span>
            </span>
          </label>
        ))}
        <span className="text-[10px] text-zinc-700 ml-auto">{filtered.length} item{filtered.length !== 1 ? "s" : ""}</span>
      </div>
      {filtered.length === 0
        ? <div className="py-8 text-center text-sm text-zinc-600">No open items from enabled sources.</div>
        : <div className="space-y-1">{filtered.map(item => (
            <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.02] transition-colors group cursor-pointer" style={{ textDecoration: "none" }}>
              <span style={{ color: srcColor(item.source) }}>{srcIcon(item.source)}</span>
              <span className="text-sm text-zinc-300 group-hover:text-zinc-100 flex-1 transition-colors">{item.title}</span>
              <span className="text-xs text-zinc-600" style={{ fontFamily: mono }}>{item.id}</span>
              {item.labels?.map(l => <Badge key={l} color="#666" small>{l}</Badge>)}
              <span className="text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity">{I.link}</span>
            </a>
          ))}</div>
      }
    </div>
  );
}

function ActionsTab() {
  const [done, setDone] = useState({});
  const [noteOpen, setNoteOpen] = useState(null);

  const defaultNotes = {
    "ai-1": "Impact: Prevents regressions in payment flow — webhook failures silently lose revenue.\nOutcome: Stripe webhook handler has full test coverage for success, failure, and duplicate events.",
    "session": "Impact: Validates the entire checkout-to-confirmation flow before shipping to users.\nOutcome: Payment flow works end-to-end with Stripe test keys, including edge cases like declined cards.",
    "gh-42": "Impact: Users on /recipes can't browse past page 1 — blocks content discovery.\nOutcome: Pagination loads correctly for all pages, URL state syncs with page number.",
    "BUFF-15": "Impact: Search is the #1 requested feature — unlocks recipe discovery for all users.\nOutcome: Users can search recipes by name and filter by cuisine, diet, and cook time.",
  };

  return (
    <div className="space-y-1.5">
      {NEXT_ACTIONS.map(a => (
        <div key={a.id} className={`rounded-lg border transition-all ${done[a.id] ? "border-emerald-500/20 bg-emerald-500/5 opacity-60" : "border-zinc-800/40 hover:bg-white/[0.02]"}`}>
          <div className="flex items-center gap-3 px-3 py-2.5">
            <span style={{ color: srcColor(a.source) }}>{srcIcon(a.source)}</span>
            <span className={`text-sm flex-1 ${done[a.id] ? "line-through text-zinc-500" : "text-zinc-200"}`}>{a.text}</span>
            {a.scope && <span className="text-[10px] text-zinc-600">{a.scope}</span>}
            {a.source !== "ai" && a.source !== "session" && <SourceBadge source={a.source} />}
            <div className="flex gap-1">
              <button onClick={() => setNoteOpen(noteOpen === a.id ? null : a.id)} className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors">Note</button>
              <button onClick={() => setDone(p => ({ ...p, [a.id]: true }))} className="px-2 py-0.5 rounded text-[10px] text-emerald-400 hover:bg-emerald-500/10 transition-colors" disabled={done[a.id]}>Done</button>
              <button className="px-2 py-0.5 rounded text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors">Skip</button>
            </div>
          </div>
          {noteOpen === a.id && (
            <div className="px-3 pb-2.5">
              <textarea rows={3} defaultValue={defaultNotes[a.id] || `Impact: Why this matters for the project.\nOutcome: What "done" looks like.`} className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-900/80 border border-zinc-700/50 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/40 transition-colors leading-relaxed" />
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[10px] text-zinc-600 flex items-center gap-1">{I.sparkle} AI-suggested — edit freely</span>
                <button className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors">Clear</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PromptsTab() {
  const [expanded, setExpanded] = useState(null);
  const [running, setRunning] = useState(null);
  const [responses, setResponses] = useState({});
  const [actionStates, setActionStates] = useState({});
  const [catFilter, setCatFilter] = useState("all");

  const categories = [
    { id: "all", label: "All" },
    { id: "setup", label: "Setup & Standards", tags: ["setup", "docs"] },
    { id: "dev", label: "Active Dev", tags: ["planning", "triage", "github", "workflow", "code-quality", "visual", "architecture"] },
    { id: "session", label: "Session", tags: ["session", "context", "summary", "reporting"] },
    { id: "qa", label: "Quality & Review", tags: ["qa", "deploy", "maintenance"] },
    { id: "reference", label: "Reference", tags: ["reference"] },
  ];

  const filtered = catFilter === "all" ? PROMPTS : PROMPTS.filter(p => {
    const cat = categories.find(c => c.id === catFilter);
    return cat && p.tags.some(t => cat.tags.includes(t));
  });

  const hasToolTokens = (body) => /{{tool:/.test(body);
  const hasAnyTokens = (body) => /{{/.test(body);
  const isRunnable = (body) => hasAnyTokens(body);

  const mockResponses = {
    pr1: { text: "Here's your .ai-rules file for buffr:\n\n**Coding Standards**\n- Use TypeScript strict mode\n- Prefer const > let, never var\n- Functions: max 40 lines, single responsibility\n\n**Naming**\n- Components: PascalCase\n- Utils/hooks: camelCase\n- Files match export name\n\n**File Organization**\n- Features grouped by domain, not type\n- Shared components in /components/ui/", actions: [{ tool: "github_push_files", label: "Push .ai-rules to repo", source: "github" }], artifact: true },
    pr2: { text: "# Architecture — buffr\n\n**System Overview**\nbuffr is a Next.js 16 application deployed on Netlify. The frontend communicates with Netlify Functions for all server-side logic.\n\n**Key Directories**\n- /app — Next.js pages and layouts\n- /netlify/functions — Serverless API endpoints\n- /netlify/functions/lib/ai — LangChain chains\n- /netlify/functions/lib/data-sources — Mapping table\n\n**Data Flow**\nFrontend → Netlify Functions → (Blobs | GitHub | Notion | Jira | LLM)\n\n**Tech Decisions**\n- Netlify Blobs over a database for zero-config persistence\n- LangChain sequential chains over agents for predictability\n- Direct fetch over SDKs for GitHub and Jira to avoid CJS issues", actions: [{ tool: "github_push_files", label: "Push ARCHITECTURE.md to repo", source: "github" }], artifact: true },
    pr3: { text: "## [0.4.0] — 2026-02-28\n\n### Added\n- Prompt-tool bidirectional integration with {{tool:name}} syntax\n- Jira integration with 5 MCP-compatible tools\n- Tool Registry table on /tools page\n- Dedicated /prompts page with full CRUD\n\n### Changed\n- Load Existing moved from page to modal\n- Data source filters moved into Open Items tab\n- Prompts tab now uses accordion pattern\n\n### Removed\n- Project Creation Wizard (deferred to future phase)", actions: [{ tool: "github_push_files", label: "Append to CHANGELOG.md", source: "github" }], artifact: true },
    pr4: { text: "# QA Feature Map — buffr\n\n## Load Existing Project\n- **What:** Import a GitHub repo into buffr via modal\n- **Happy path:** Enter URL → Analyze → see stack detection → Import\n- **Edge cases:** Invalid URL, private repo without token, repo with no package.json, repo already imported\n- **Broken looks like:** Spinner never stops, stack shows empty, modal doesn't close after import\n- **Priority:** Critical\n\n## Session Memory (Resume Card)\n- **What:** View last session context across 4 tabs\n- **Happy path:** Open project → see last session goal, open items, next actions\n- **Edge cases:** No previous sessions, all data sources disconnected, very long session notes\n- **Broken looks like:** Tabs don't switch, stale data shown, items from wrong project", actions: [{ tool: "github_push_files", label: "Push features_qa.md to repo", source: "github" }], artifact: true },
    pr7: { text: "```mermaid\ngraph TD\n  A[Next.js Frontend] --> B[Netlify Functions]\n  B --> C[Netlify Blobs]\n  B --> D[GitHub API]\n  B --> E[Notion API]\n  B --> F[Jira API]\n  B --> G[LangChain.js]\n  G --> H[Anthropic]\n  G --> I[OpenAI]\n  G --> J[Ollama]\n```\n\nThis diagram shows buffr's core architecture with the frontend communicating through serverless functions to all external services.", actions: [], artifact: true },
    pr8: { text: "Based on your open items across all sources, here's my triage:\n\n**🔴 Blocking (do first):**\n1. Fix pagination bug (#42) — affecting users now, ~15 min fix\n\n**⚡ Quick wins (<30 min):**\n2. Update README badges (#39)\n3. Close stale BUFF-12 (already resolved)\n\n**🟡 Stale (>7 days):**\n4. Recipe search feature (BUFF-15) — needs design decision\n\n**⏸️ Defer:**\n5. Rate limiting (#38) — important but not urgent", actions: [
      { tool: "github_close_issue", label: "Close #42 after fix", source: "github" },
      { tool: "jira_transition_issue", label: "Move BUFF-12 to Done", source: "jira" },
    ], artifact: false },
    pr11: { text: "**Session Brief for buffr:**\n\nLast time you were implementing the prompt-tool bidirectional integration. You finished the input side ({{tool:name}} resolution) and your next step was wiring up the output side — rendering suggested actions from the LLM response.\n\nThere are 5 open GitHub issues, 2 in Jira. Nothing is blocking. The most relevant open item is BUFF-15 (recipe search) which you noted depends on the search endpoint.\n\nRecommended focus: Complete the suggested actions UI, then tackle BUFF-15.", actions: [], artifact: false },
    pr12: { text: "**Session Summary:**\n\n• Implemented prompt-tool output UI with action buttons and confirm/execute flow\n• Added typing effect to AI responses in Prompts tab\n• Fixed accordion state not persisting when switching tabs\n• Closed #42 (pagination bug) and pushed hotfix\n\n**Still open:** BUFF-15 (recipe search), #38 (rate limiting)\n**Next:** Write integration tests for webhook handler", actions: [], artifact: false },
    pr13: { text: "**Weekly Progress — buffr (Feb 21–28)**\n\n**Shipped:**\n- Prompt-tool bidirectional integration (input + output)\n- Tool Registry on /tools page\n- Load Existing modal (replaced standalone page)\n- 16 prompt templates across 4 categories\n\n**In Progress:**\n- Jira tool implementations (3 of 5 done)\n- Smart session memory auto-fill\n\n**Blocked:**\n- Notion API rate limits during bulk task sync (investigating)", actions: [], artifact: false },
  };

  const defaultResp = { text: "Prompt executed successfully. The AI analyzed your project context and tool data to generate the requested output. In production, this would return the full generated content based on your project's actual data.", actions: [], artifact: false };

  const handleRun = (id, e) => {
    e.stopPropagation();
    setExpanded(id);
    setRunning(id);
    setTimeout(() => { setRunning(null); setResponses(p => ({ ...p, [id]: mockResponses[id] || defaultResp })); }, 2200);
  };

  const renderBody = (body) => body.split(/({{.*?}})/).map((p, i) =>
    p.startsWith("{{tool:") ? <span key={i} className="px-1 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[11px]" style={{ fontFamily: mono }}>{p}</span>
    : p.startsWith("{{") ? <span key={i} className="px-1 py-0.5 rounded bg-blue-500/15 text-blue-300 text-[11px]" style={{ fontFamily: mono }}>{p}</span>
    : <span key={i}>{p}</span>
  );

  return (
    <div>
      {/* Category filter */}
      <div className="flex items-center gap-1.5 pb-3 mb-3 border-b border-zinc-800/50">
        {categories.map(c => (
          <button key={c.id} onClick={() => setCatFilter(c.id)} className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${catFilter === c.id ? "bg-zinc-700/50 text-zinc-200" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"}`}>{c.label}</button>
        ))}
        <span className="text-[10px] text-zinc-600 ml-auto">{filtered.length} prompt{filtered.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="space-y-1.5">
        {filtered.map(p => {
          const isExp = expanded === p.id;
          const resp = responses[p.id];
          return (
            <div key={p.id} className={`rounded-xl border transition-colors ${isExp ? "border-zinc-700/60 bg-zinc-800/20" : "border-transparent hover:bg-white/[0.02]"}`}>
              <div onClick={() => setExpanded(isExp ? null : p.id)} className="flex items-center justify-between py-2.5 px-3 cursor-pointer group">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className={`transition-transform duration-200 text-zinc-500 ${isExp ? "rotate-0" : "-rotate-90"}`}>{I.chevron}</span>
                  <span className="text-sm text-zinc-200 font-medium truncate">{p.title}</span>
                  {p.tags.map(t => <Badge key={t} color="#555" small>{t}</Badge>)}
                  <span className="text-[10px] text-zinc-600">{p.usageCount}×</span>
                  {p.scope === "project" && <Badge color="#60a5fa" small>project</Badge>}
                </div>
                <div className="flex items-center gap-1 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                  <button onClick={e => e.stopPropagation()} className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors">{I.copy} Copy</button>
                  {isRunnable(p.body) && <button onClick={e => handleRun(p.id, e)} disabled={running === p.id} className="flex items-center gap-1 px-2 py-1 rounded text-xs text-purple-400 hover:text-purple-200 hover:bg-purple-500/10 transition-colors disabled:opacity-50">{running === p.id ? I.loader : I.play} {running === p.id ? "Running…" : "Run"}</button>}
                </div>
              </div>
              {isExp && (
                <div className="px-3 pb-3" style={{ animation: "fadeIn .2s ease-out" }}>
                  <div className="ml-6 mb-3 px-3 py-2.5 rounded-lg bg-zinc-900/80 border border-zinc-800/60">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">
                        {!hasAnyTokens(p.body) ? "Reference Prompt" : hasToolTokens(p.body) ? "Template — resolves tools + variables" : "Template — resolves variables"}
                      </div>
                      {!hasAnyTokens(p.body) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700/40 text-zinc-400">Copy-paste ready</span>}
                    </div>
                    <div className="text-[13px] text-zinc-400 leading-relaxed whitespace-pre-wrap">{renderBody(p.body)}</div>
                  </div>
                  {!hasAnyTokens(p.body) && (
                    <div className="ml-6 flex gap-2">
                      <button onClick={e => e.stopPropagation()} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-zinc-800/50 hover:bg-zinc-800 text-zinc-200 border border-zinc-700/50 transition-colors">{I.copy} Copy to Clipboard</button>
                    </div>
                  )}
                  {isRunnable(p.body) && running === p.id && <div className="ml-6 flex items-center gap-2 px-3 py-3 text-sm text-zinc-400">{I.loader} Resolving tools and calling AI…</div>}
                  {isRunnable(p.body) && resp && running !== p.id && <PromptResponse response={resp} promptId={p.id} actionStates={actionStates} setActionStates={setActionStates} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PromptResponse({ response, promptId, actionStates, setActionStates }) {
  const { displayed, done } = useTypingEffect(response.text, 8, true);
  const [copied, setCopied] = useState(false);

  const handleCopyRefine = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="ml-6 rounded-xl border border-purple-500/20 bg-purple-500/[0.03] overflow-hidden">
      <div className="px-4 py-3">
        <div className="text-[11px] text-purple-400/60 uppercase tracking-wider font-semibold mb-2 flex items-center gap-1.5">{I.sparkle} AI Response</div>
        <div className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
          {displayed.split(/(\*\*.*?\*\*)/).map((p, i) => p.startsWith("**") && p.endsWith("**") ? <strong key={i} className="text-zinc-100">{p.slice(2,-2)}</strong> : p.startsWith("##") ? <span key={i} className="text-zinc-100 font-semibold">{p.replace(/^##\s*/, "")}</span> : <span key={i}>{p}</span>)}
          {!done && <span className="inline-block w-0.5 h-4 bg-purple-400 ml-0.5 animate-pulse align-text-bottom" />}
        </div>
      </div>

      {done && (response.actions.length > 0 || response.artifact) && (
        <div className="border-t border-purple-500/10 px-4 py-3 space-y-3">
          {/* Suggested tool actions */}
          {response.actions.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Apply</div>
              {response.actions.map((a, idx) => {
                const k = `${promptId}-${idx}`;
                const st = actionStates[k] || "idle";
                return (
                  <button key={idx} onClick={() => { if (st === "idle") { setActionStates(p => ({...p, [k]: "running"})); setTimeout(() => setActionStates(p => ({...p, [k]: "success"})), 1200); }}} disabled={st !== "idle"} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition-all ${st === "idle" ? "bg-zinc-800/50 hover:bg-zinc-800 text-zinc-200 border border-zinc-700/50" : st === "running" ? "bg-zinc-800/30 text-zinc-400 border border-zinc-700/30" : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"}`}>
                    <span style={{ color: srcColor(a.source) }}>{srcIcon(a.source)}</span>
                    <span className="flex-1 truncate">{a.label}</span>
                    {st === "running" && I.loader}
                    {st === "success" && <span className="text-emerald-400">{I.check}</span>}
                  </button>
                );
              })}
            </div>
          )}

          {/* Refine in Claude Code — shown for artifact responses */}
          {response.artifact && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Refine with local context</div>
              <button onClick={handleCopyRefine} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition-all border ${copied ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20" : "bg-zinc-800/50 hover:bg-zinc-800 text-zinc-200 border-zinc-700/50"}`}>
                <span className="text-blue-400">{copied ? I.check : I.copy}</span>
                <span className="flex-1">{copied ? "Copied to clipboard" : "Copy response + context for Claude Code"}</span>
              </button>
              <p className="text-[11px] text-zinc-600 px-1">Copies the AI output with your project context. Paste into Claude Code to refine with your local codebase.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ━━━ END SESSION MODAL ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function EndSessionModal({ onClose, session, sources }) {
  const [phase, setPhase] = useState("fetching"); // fetching → summarizing → ready
  const [goal, setGoal] = useState("");
  const [whatChanged, setWhatChanged] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [blockers, setBlockers] = useState("");
  const [aiLabel, setAiLabel] = useState("");

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("summarizing"), 1500);
    const t2 = setTimeout(() => {
      setPhase("ready");
      setGoal(session?.goal || "");
      setWhatChanged("• Added Stripe webhook endpoint at /api/webhooks/stripe\n• Created payment confirmation email with order details\n• Updated Order model to include 'paid' status transition\n• Added webhook signature verification middleware");
      setNextStep("Write integration tests for the Stripe webhook handler, then test with Stripe CLI");
      setAiLabel(`AI-generated from 5 commits and 2 tasks across ${sources.length} sources`);
    }, 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg rounded-2xl border border-zinc-700/60 bg-zinc-900 shadow-2xl" onClick={e => e.stopPropagation()} style={{ animation: "slideDown .2s ease-out" }}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/60">
          <h3 className="text-sm font-semibold text-zinc-100">End Session</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">{I.x}</button>
        </div>

        {phase !== "ready" && (
          <div className="px-5 py-8 text-center">
            <div className="flex items-center justify-center gap-2 text-sm text-zinc-400 mb-3">
              {I.loader}
              {phase === "fetching" ? `Fetching activity from ${sources.length} sources…` : "Summarizing with AI…"}
            </div>
            <div className="flex justify-center gap-2">
              {sources.map(s => <Badge key={s} color={srcColor(s)}>{srcIcon(s)} {s}</Badge>)}
            </div>
          </div>
        )}

        {phase === "ready" && (
          <div className="px-5 py-4 space-y-4" style={{ animation: "fadeIn .3s ease-out" }}>
            {aiLabel && <div className="flex items-center gap-1.5 text-[11px] text-purple-400/70">{I.sparkle} {aiLabel}</div>}
            <Input label="Goal (1 sentence)" value={goal} onChange={setGoal} placeholder="What were you working on?" />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">What Changed</label>
                <div className="flex gap-1">
                  <button className="px-1.5 py-0.5 rounded text-[10px] text-emerald-400 hover:bg-emerald-500/10 transition-colors">Accept</button>
                  <button onClick={() => setWhatChanged("")} className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:bg-white/5 transition-colors">Clear</button>
                </div>
              </div>
              <textarea value={whatChanged} onChange={e => setWhatChanged(e.target.value)} rows={4} className="w-full px-3 py-2 rounded-lg bg-zinc-900/80 border border-zinc-700/50 text-zinc-200 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/50 transition-colors" placeholder="What did you change?" />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Next Step</label>
                <div className="flex gap-1">
                  <button className="px-1.5 py-0.5 rounded text-[10px] text-emerald-400 hover:bg-emerald-500/10 transition-colors">Accept</button>
                  <button onClick={() => setNextStep("")} className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:bg-white/5 transition-colors">Clear</button>
                </div>
              </div>
              <input value={nextStep} onChange={e => setNextStep(e.target.value)} className="w-full px-3 py-2 rounded-lg bg-zinc-900/80 border border-zinc-700/50 text-zinc-200 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/50 transition-colors" placeholder="What's next?" />
            </div>
            <Input label="Blockers (optional)" value={blockers} onChange={setBlockers} placeholder="Anything blocking progress?" />
            <div className="flex justify-end gap-2 pt-2">
              <Btn onClick={onClose}>Cancel</Btn>
              <Btn variant="primary">Save Session</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ━━━ TOOLS PAGE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function ToolsPage({ onNavigate }) {
  const [configuring, setConfiguring] = useState(null);
  const [defaultSources, setDefaultSources] = useState(["github"]);
  const [toolFilter, setToolFilter] = useState("all");
  const [toolSearch, setToolSearch] = useState("");

  const filteredTools = MCP_TOOLS.filter(t =>
    (toolFilter === "all" || t.integration === toolFilter) &&
    (toolSearch === "" || t.name.toLowerCase().includes(toolSearch.toLowerCase()) || t.desc.toLowerCase().includes(toolSearch.toLowerCase()))
  );

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <button onClick={() => onNavigate("dashboard")} className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 mb-6 transition-colors">{I.back} Dashboard</button>
      <h1 className="text-lg font-semibold text-zinc-100 mb-6">Tools & Integrations</h1>

      {/* Default Sources */}
      <div className="mb-6 p-4 rounded-xl border border-zinc-800/60 bg-zinc-900/30">
        <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-2">Default Data Sources for New Projects</div>
        <div className="flex gap-3">
          {["github", "notion", "jira"].map(s => (
            <label key={s} className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={defaultSources.includes(s)} onChange={() => setDefaultSources(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s])} className="accent-purple-500 w-3.5 h-3.5" />
              <span className="flex items-center gap-1 text-sm" style={{ color: srcColor(s) }}>{srcIcon(s)} <span className="capitalize">{s}</span></span>
            </label>
          ))}
        </div>
      </div>

      {/* Built-in Integrations */}
      <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-3">Integrations</div>
      <div className="grid gap-3 mb-8">
        {TOOLS_DATA.map(t => (
          <div key={t.name} className="flex items-center gap-4 px-4 py-3.5 rounded-xl border border-zinc-800/60 bg-zinc-900/30 hover:border-zinc-700/60 transition-colors">
            <span className="w-9 h-9 rounded-lg bg-zinc-800 flex items-center justify-center" style={{ color: srcColor(t.icon) }}>{srcIcon(t.icon)}</span>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-200">{t.name}</span>
                <Badge color="#34d399" small>{t.status}</Badge>
                <span className="text-[10px] text-zinc-600">{t.tools} tools</span>
              </div>
              <div className="text-xs text-zinc-500">{t.desc}</div>
            </div>
            <div className="flex gap-2">
              <Btn size="sm" variant="ghost" onClick={() => setConfiguring(t.name)}>Configure</Btn>
              <Btn size="sm" variant="ghost">Test</Btn>
            </div>
          </div>
        ))}
      </div>

      {/* Tool Registry */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Tool Registry ({filteredTools.length})</div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600">{I.search}</span>
            <input value={toolSearch} onChange={e => setToolSearch(e.target.value)} placeholder="Search tools…" className="pl-8 pr-3 py-1.5 rounded-lg bg-zinc-900/80 border border-zinc-700/50 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/40 w-48 transition-colors" />
          </div>
          <div className="flex rounded-lg border border-zinc-700/50 overflow-hidden">
            {["all", "github", "notion", "jira"].map(f => (
              <button key={f} onClick={() => setToolFilter(f)} className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors ${toolFilter === f ? "bg-zinc-700/50 text-zinc-200" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"}`}>
                {f === "all" ? "All" : <span className="flex items-center gap-1" style={{ color: srcColor(f) }}>{srcIcon(f)} <span className="capitalize">{f}</span></span>}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800/60 overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-4 py-2 bg-zinc-900/50 border-b border-zinc-800/40 text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">
          <span>Tool</span><span>Parameters</span><span>Source</span>
        </div>
        <div className="divide-y divide-zinc-800/30">
          {filteredTools.map(t => (
            <div key={t.name} className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center px-4 py-2.5 hover:bg-white/[0.015] transition-colors">
              <div>
                <span className="text-sm text-zinc-200" style={{ fontFamily: mono }}>{t.name}</span>
                <span className="text-xs text-zinc-500 ml-2">{t.desc}</span>
              </div>
              <span className="text-[11px] text-zinc-600" style={{ fontFamily: mono }}>{t.params}</span>
              <span style={{ color: srcColor(t.integration) }}>{srcIcon(t.integration)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Configure Modal */}
      {configuring && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setConfiguring(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-md rounded-2xl border border-zinc-700/60 bg-zinc-900 shadow-2xl p-5" onClick={e => e.stopPropagation()} style={{ animation: "slideDown .15s ease-out" }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-zinc-100">Configure {configuring}</h3>
              <button onClick={() => setConfiguring(null)} className="text-zinc-500 hover:text-zinc-300">{I.x}</button>
            </div>
            {configuring === "GitHub" && <Input label="Token" value="ghp_••••••••••••••••" onChange={() => {}} placeholder="GITHUB_TOKEN" mono />}
            {configuring === "Notion" && <><Input label="Token" value="" onChange={() => {}} placeholder="NOTION_TOKEN" mono /><div className="mt-3"><Input label="Database ID" value="" onChange={() => {}} placeholder="NOTION_DATABASE_ID" mono /></div></>}
            {configuring === "Jira" && <><Input label="Base URL" value="" onChange={() => {}} placeholder="https://yourteam.atlassian.net" mono /><div className="mt-3"><Input label="Email" value="" onChange={() => {}} placeholder="you@example.com" /></div><div className="mt-3"><Input label="API Token" value="" onChange={() => {}} placeholder="JIRA_API_TOKEN" mono /></div><div className="mt-3"><Input label="Project Key" value="" onChange={() => {}} placeholder="BUFF" mono /></div></>}
            <div className="flex justify-end gap-2 mt-5">
              <Btn onClick={() => setConfiguring(null)}>Cancel</Btn>
              <Btn variant="primary" onClick={() => setConfiguring(null)}>Save</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ━━━ PROMPTS LIBRARY PAGE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function PromptsLibrary({ onNavigate }) {
  const [prompts, setPrompts] = useState(PROMPTS);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const [editing, setEditing] = useState(null); // null | "new" | prompt object
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editScope, setEditScope] = useState("global");

  const allTags = [...new Set(prompts.flatMap(p => p.tags))];

  const filtered = prompts.filter(p =>
    (tagFilter === "all" || p.tags.includes(tagFilter)) &&
    (search === "" || p.title.toLowerCase().includes(search.toLowerCase()) || p.body.toLowerCase().includes(search.toLowerCase()))
  ).sort((a, b) => b.usageCount - a.usageCount);

  const openEdit = (prompt) => {
    if (prompt === "new") {
      setEditTitle(""); setEditBody(""); setEditTags(""); setEditScope("global");
    } else {
      setEditTitle(prompt.title); setEditBody(prompt.body); setEditTags(prompt.tags.join(", ")); setEditScope(prompt.scope);
    }
    setEditing(prompt);
  };

  const handleSave = () => {
    if (editing === "new") {
      setPrompts(prev => [...prev, {
        id: `pr${Date.now()}`, title: editTitle, body: editBody,
        tags: editTags.split(",").map(t => t.trim()).filter(Boolean),
        usageCount: 0, scope: editScope,
      }]);
    } else {
      setPrompts(prev => prev.map(p => p.id === editing.id ? {
        ...p, title: editTitle, body: editBody,
        tags: editTags.split(",").map(t => t.trim()).filter(Boolean),
        scope: editScope,
      } : p));
    }
    setEditing(null);
  };

  const handleDelete = (id) => {
    setPrompts(prev => prev.filter(p => p.id !== id));
  };

  const renderTokens = (body) => body.split(/({{.*?}})/).map((part, i) =>
    part.startsWith("{{tool:") ? <span key={i} className="px-1 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[11px]" style={{ fontFamily: mono }}>{part}</span>
    : part.startsWith("{{") ? <span key={i} className="px-1 py-0.5 rounded bg-blue-500/15 text-blue-300 text-[11px]" style={{ fontFamily: mono }}>{part}</span>
    : <span key={i}>{part}</span>
  );

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <button onClick={() => onNavigate("dashboard")} className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 mb-6 transition-colors">{I.back} Dashboard</button>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Prompt Library</h1>
        <Btn variant="primary" size="sm" onClick={() => openEdit("new")}>{I.plus} New Prompt</Btn>
      </div>

      {/* Search + Tag Filter */}
      <div className="flex items-center gap-3 mb-5">
        <div className="relative flex-1">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600">{I.search}</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search prompts…" className="w-full pl-8 pr-3 py-2 rounded-lg bg-zinc-900/80 border border-zinc-700/50 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/40 transition-colors" />
        </div>
        <div className="flex rounded-lg border border-zinc-700/50 overflow-hidden">
          <button onClick={() => setTagFilter("all")} className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors ${tagFilter === "all" ? "bg-zinc-700/50 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}>All</button>
          {allTags.map(t => (
            <button key={t} onClick={() => setTagFilter(t)} className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors ${tagFilter === t ? "bg-zinc-700/50 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}>{t}</button>
          ))}
        </div>
      </div>

      {/* Prompt List */}
      <div className="space-y-2">
        {filtered.length === 0 && <div className="py-12 text-center text-sm text-zinc-600">No prompts found. Create your first one!</div>}
        {filtered.map(p => {
          const hasTool = /{{tool:/.test(p.body);
          const hasToken = /{{/.test(p.body);
          const isRef = !hasToken;
          return (
          <div key={p.id} className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 hover:border-zinc-700/60 transition-colors overflow-hidden">
            <div className="flex items-start gap-3 px-4 py-3.5">
              <span className={`mt-0.5 ${isRef ? "text-zinc-500" : "text-purple-400"}`}>{I.prompt}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-sm font-medium text-zinc-200">{p.title}</span>
                  {isRef && <Badge color="#78716c" small>reference</Badge>}
                  {p.tags.map(t => <Badge key={t} color="#555" small>{t}</Badge>)}
                  {p.scope === "project" && <Badge color="#60a5fa" small>project</Badge>}
                  <span className="text-[10px] text-zinc-600">{p.usageCount}× used</span>
                </div>
                <div className="text-[13px] text-zinc-500 leading-relaxed line-clamp-2 whitespace-pre-wrap">{renderTokens(p.body)}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => openEdit(p)} className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors">{I.edit}</button>
                <button className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors">{I.copy}</button>
                <button onClick={() => handleDelete(p.id)} className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors">{I.trash}</button>
              </div>
            </div>
          </div>
          );
        })}
      </div>

      {/* Available tools hint */}
      <div className="mt-6 p-4 rounded-xl border border-zinc-800/40 bg-zinc-900/20">
        <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-2">Available Tools for Prompts</div>
        <div className="flex flex-wrap gap-1.5">
          {MCP_TOOLS.map(t => (
            <span key={t.name} className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800/60 border border-zinc-700/30" style={{ fontFamily: mono, color: srcColor(t.integration) }}>{t.name}</span>
          ))}
        </div>
        <p className="text-xs text-zinc-600 mt-2">Use <span className="text-purple-400" style={{ fontFamily: mono }}>{"{{tool:name}}"}</span> in prompt body to fetch data before sending to AI.</p>
      </div>

      {/* Create/Edit Modal */}
      {editing !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-lg rounded-2xl border border-zinc-700/60 bg-zinc-900 shadow-2xl" onClick={e => e.stopPropagation()} style={{ animation: "slideDown .15s ease-out" }}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/60">
              <h3 className="text-sm font-semibold text-zinc-100">{editing === "new" ? "New Prompt" : "Edit Prompt"}</h3>
              <button onClick={() => setEditing(null)} className="text-zinc-500 hover:text-zinc-300">{I.x}</button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <Input label="Title" value={editTitle} onChange={setEditTitle} placeholder="e.g. Triage open items" />
              <div className="space-y-1.5">
                <label className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Body</label>
                <textarea value={editBody} onChange={e => setEditBody(e.target.value)} rows={6} placeholder={"Use {{project.name}}, {{lastSession.goal}} for context.\nUse {{tool:github_list_issues}} to fetch tool data."} className="w-full px-3 py-2 rounded-lg bg-zinc-900/80 border border-zinc-700/50 text-zinc-200 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/50 transition-colors" style={{ fontFamily: mono }} />
              </div>
              <Input label="Tags (comma-separated)" value={editTags} onChange={setEditTags} placeholder="planning, github, workflow" />
              <div className="space-y-1.5">
                <label className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Scope</label>
                <div className="flex gap-2">
                  {["global", "project"].map(s => (
                    <button key={s} onClick={() => setEditScope(s)} className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${editScope === s ? "bg-purple-500/10 border-purple-500/30 text-purple-300" : "border-zinc-700/50 text-zinc-400 hover:border-zinc-600"}`}>
                      <span className="capitalize">{s}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Btn onClick={() => setEditing(null)}>Cancel</Btn>
                <Btn variant="primary" onClick={handleSave} disabled={!editTitle.trim() || !editBody.trim()}>
                  {editing === "new" ? "Create Prompt" : "Save Changes"}
                </Btn>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ━━━ MAIN APP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function App() {
  const [page, setPage] = useState("dashboard");
  const [activeProject, setActiveProject] = useState(null);
  const [palette, setPalette] = useState(false);
  const [showLoadModal, setShowLoadModal] = useState(false);

  const navigate = useCallback((target, projectId) => {
    if (target === "project" && projectId) {
      setActiveProject(PROJECTS.find(p => p.id === projectId) || PROJECTS[0]);
      setPage("project");
      setShowLoadModal(false);
    } else {
      setPage(target);
      if (target === "dashboard") setActiveProject(null);
    }
  }, []);

  const handleAction = useCallback((action) => {
    if (action === "toggle-palette") setPalette(p => !p);
    else if (action === "dashboard") navigate("dashboard");
    else if (action === "load-existing") { navigate("dashboard"); setShowLoadModal(true); }
    else if (action === "tools") navigate("tools");
    else if (action === "prompts") navigate("prompts");
    else if (action === "end-session") {}
  }, [navigate]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300" style={{ fontFamily: fonts }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideDown { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        * { scrollbar-width: thin; scrollbar-color: #333 transparent; }
        input[type="checkbox"] { cursor: pointer; }
        ::selection { background: #7c3aed40; }
      `}</style>

      <NavBar page={page} onNavigate={navigate} onPalette={() => setPalette(true)} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} onAction={handleAction} prompts={PROMPTS} />

      {page === "dashboard" && <Dashboard onNavigate={navigate} externalShowLoad={showLoadModal} onLoadShown={() => setShowLoadModal(false)} />}
      {page === "project" && activeProject && <ResumeCard project={activeProject} onNavigate={navigate} />}
      {page === "tools" && <ToolsPage onNavigate={navigate} />}
      {page === "prompts" && <PromptsLibrary onNavigate={navigate} />}
    </div>
  );
}
