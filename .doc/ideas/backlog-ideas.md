---
title: backlog-ideas
category: ideas
---
# Buffr — Ideas Backlog

Ideas captured during planning and development. Not committed to any phase — just a living list to pull from when the time is right.

---

## Provider-Agnostic Agent Runner

**Problem:** Claude Code, Codex CLI, and similar tools are locked to a single model and require local setup. Buffr already has multi-provider LLM support and a tool registry — it could run agents server-side without vendor lock-in.

**Idea:** A new `agent.ts` Netlify Function that wraps `getLLM()` + `executeTool()` in an agentic loop. The LLM plans steps, calls tools, inspects results, and keeps going until the task is done. Provider-agnostic — works with Claude, GPT, Gemini, Llama. Frontend shows each step with approve/abort checkpoints.

**Connects to:** Phase 3 Task Modules, Conversational Layer, MCP tool registry, `.dev/` context loading, Rules & Skills

**Status:** Idea — not yet in any plan

---

## Project Streak / Scheduler

**Problem:** Solo developers juggle 3-5 projects. They work on whichever feels urgent, and the others rot. Small consistent effort compounds into big results, but there's no structure to ensure every project gets attention.

**Idea:** A scheduling and streak system built into buffr:

- **Weekly schedule** — assign time blocks per project (e.g. buffr Mon/Wed/Fri, recipe-hub Tue/Thu). Buffr shows which project is "up" today on the Dashboard.
- **Streak tracking** — each project gets a streak counter. Open a session on a scheduled day? Streak increments. Miss it? It breaks. Flame icon or badge on Dashboard project cards.
- **Session timer** — lightweight timer that starts with a session. Shows "you put in 35 minutes today." Not a productivity app — just enough to see the investment.
- **Compound view** — weekly/monthly view showing cumulative time per project, streak history, total sessions and commits. The motivational piece — see the compound effect working.
- **Scoped suggestions** — "it's buffr day, you have 30 minutes, here's a Sprint Prep workflow scoped to 30 min." Connects to Phase 3 workflow suggestions.

**Connects to:** Dashboard, Resume Card, Session memory, Phase 3 Workflows

**Status:** Idea — not yet in any plan

---

## VS Code Workspace File Generation

**Problem:** When a developer opens a project, VS Code doesn't know the project's recommended extensions, settings, or task runners. Setting this up manually for each project is repetitive.

**Idea:** Generate a `.code-workspace` file as a new adapter type in `.dev/adapters/`. Includes the project root folder, recommended extensions based on detected stack (ESLint, Tailwind IntelliSense, Prettier), workspace settings derived from `.dev/standards/`, and task definitions from `package.json` scripts. Install via symlink like CLAUDE.md.

**Connects to:** `.dev/` adapter generation, stack detection, `.dev/standards/`

**Status:** Idea — not yet in any plan

---

## AI Governance Layer

**Problem:** Rules, `.dev/standards/`, industry standards, and adapters all govern how AI behaves — but they're disconnected. Updating a rule doesn't automatically update the adapter files or flag conflicting gap analysis entries.

**Idea:** Wire the Rules page as the central governance hub. When a rule is created or updated, buffr automatically updates relevant adapter files (CLAUDE.md picks up the rule), regenerates affected `.dev/standards/` sections, and flags gap analysis conflicts. One source of truth, multiple enforcement points. A skill pushed to `.dev/skills/` gets referenced in adapter configs so AI tools discover it.

**Flow:** Define rule once in buffr → propagates to every project pushed to → every AI tool reading `.dev/` inherits the rule.

**Connects to:** Rules & Skills feature, `.dev/` adapters, gap analysis, `.dev/standards/`

**Status:** Idea — partially exists (Rules page built, governance wiring not yet planned)

---

## Prompt Response Persistence

**Problem:** When a prompt runs via `run-prompt.ts`, the response is ephemeral — shown in the UI and then gone. Phase 3 retrieval memory needs to search past prompt outputs, but there's nothing to index.

**Idea:** Store prompt responses in a new `prompt-responses` Blobs store. Key: response ID, linked to prompt ID + project ID + timestamp. Enables retrieval memory to answer "what did the audit find last time?" and lets users review past outputs.

**Connects to:** Phase 3 Retrieval Memory, Prompt Library, run-prompt.ts

**Status:** Identified as Phase 3 prerequisite — not yet built

---

## How to Use This File

- Add new ideas with a heading, problem, idea description, connections, and status
- Move ideas to a plan doc when they're committed to a phase
- Update status as ideas progress: `Idea` → `Exploring` → `In Plan` → `Building` → `Shipped`
- Keep it messy — this is a jot pad, not a spec

---

*Last updated: 2026-03-08*