# buffr reset — clean-slate scaffold

## Context

buffr currently has a working single-agent RAG system (aptkit-based, Gemma + Supabase pgvector,
kernel/engines/connectors/capabilities packages, chat TUI, evals). The owner is restarting the
project from scratch, using *AI Agents in Action* as a reference/guide, building it phase by
phase as they read each chapter. This is not a full rewrite plan — it's the reset step that
clears the way for that incremental process. Each future phase gets its own brainstorm → design
→ plan cycle when the owner brings the relevant chapter.

Decisions locked in for this reset:
- Stay TypeScript/Node (not switching to the book's Python samples — port concepts, not code).
- True blank slate: delete the old implementation and old-project docs outright. Nothing is
  actually lost — full history remains in git.
- No architecture decisions made now (no provider contracts, no agent loop, no DB). Those get
  decided when the first book chapter forces them.
- Model/service providers (e.g. Vertex AI, Ollama) will eventually be pluggable rather than
  hard-wired, mirroring the old `GemmaModelProvider`-style contract pattern — but that pattern
  is designed fresh when the first phase needs it, not scaffolded preemptively.

## Scope of this change

**Delete:**
- `packages/`, `src/`, `sql/`, `test/`, `dist/`, `eval/`, `knowledge/`
- `docs/*` except `docs/superpowers/` (the specs/plans working area, kept so this process has
  somewhere to live)
- `agent-layer-plan.md`, `.env`, `.env.example`, `test-output.txt`, `.aipe/`
- `tsconfig.base.json`, `tsconfig.json`, `package.json`, `package-lock.json`, `node_modules/`

**Keep unchanged:**
- `.git/`, `.claude/`, `.superpowers/`, `.gitignore`, `AGENTS.md` (generic AIPE workflow
  instructions, not buffr-specific), `docs/superpowers/`

**Rewrite:**
- `README.md` → short placeholder: project name, one-line description, pointer to
  `docs/superpowers/specs/` for the current phase.

**Recreate (bare minimum only):**
- `package.json` — name `buffr`, `"type": "module"`, TypeScript devDependency, no framework
  or provider deps yet.
- `tsconfig.json` — standard strict Node/ESM config.
- `src/index.ts` — placeholder entry point (e.g. a single log statement), enough to prove the
  toolchain compiles and runs.

No test framework, no lint config, no CI, no database, no agent code. Those arrive with the
phase that needs them.

## Out of scope

- Any book-chapter-specific implementation (agent loop, tools, memory, RAG, multi-agent,
  eval harness, Vertex AI integration). Each is its own future design.
- Deciding the long-term provider/contract architecture. Revisit once at least one real
  provider (e.g. a first LLM call) is needed.

## Done means

- Old implementation and old-project docs are gone from the working tree (recoverable via git
  history only).
- Repo builds (`tsc` runs clean) against the new bare `src/index.ts`.
- `README.md` reflects the reset, not the old system.
- Nothing beyond the bare scaffold exists — ready for the first book-guided phase.
