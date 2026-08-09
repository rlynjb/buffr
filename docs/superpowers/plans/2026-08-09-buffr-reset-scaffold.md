# buffr Reset & Bare Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wipe buffr's old implementation and old-project docs down to a true blank slate, then recreate the smallest possible working TypeScript scaffold so the next book-guided phase has a clean floor to build on.

**Architecture:** No architecture yet by design — this plan only removes the old system and stands up `package.json` + `tsconfig.json` + a placeholder `src/index.ts` that compiles and runs. No provider contracts, DB, agent loop, or test framework.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), no runtime dependencies.

## Global Constraints

- Stay TypeScript/Node — do not port to Python (spec: `docs/superpowers/specs/2026-08-09-buffr-reset-scaffold-design.md`).
- `docs/superpowers/` (this plan, the spec, and any future ones) is never deleted.
- `.git/`, `.claude/`, `.superpowers/`, `.gitignore`, `AGENTS.md` are never touched.
- Old code must remain reachable via git history — deletions are plain `git rm`, not `rm` outside git, so the removal itself is a normal, revertable commit.
- No architecture decisions (providers, contracts, DB, agent loop) are made in this plan.

---

### Task 1: Remove old implementation and old-project docs

**Files:**
- Delete (tracked, use `git rm -r`): `packages/`, `src/`, `sql/`, `test/`, `eval/`, `knowledge/`, `.aipe/`, `agent-layer-plan.md`, `.env.example`, `tsconfig.base.json`, `tsconfig.json`, `package.json`, `package-lock.json`
- Delete (tracked, use `git rm -r`), all of `docs/` **except** the `docs/superpowers/` subtree:
  `docs/buffr-decision-intelligence-implementation-plan.md`, `docs/learning-plan.md`, `docs/next-moves.md`, `docs/notes.md`, `docs/thinking-session-slice.spec.md`
- Delete (untracked, use `rm -rf` — already gitignored): `dist/`, `node_modules/`, `.env`, `test-output.txt`
- Modify: `README.md` (replace entire contents)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a clean working tree containing only `.git/`, `.claude/`, `.superpowers/`, `.gitignore`, `AGENTS.md`, `docs/superpowers/`, `README.md`. Task 2 builds the new `package.json`/`tsconfig.json`/`src/` on top of this.

- [ ] **Step 1: Remove tracked old-implementation directories and files**

```bash
git rm -r packages/ src/ sql/ test/ eval/ knowledge/ .aipe/ \
  agent-layer-plan.md .env.example tsconfig.base.json tsconfig.json \
  package.json package-lock.json
```

- [ ] **Step 2: Remove tracked old-project docs (keep docs/superpowers/)**

```bash
git rm docs/buffr-decision-intelligence-implementation-plan.md \
  docs/learning-plan.md docs/next-moves.md docs/notes.md \
  docs/thinking-session-slice.spec.md
```

- [ ] **Step 3: Remove untracked build artifacts and local files**

```bash
rm -rf dist/ node_modules/ .env test-output.txt
```

- [ ] **Step 4: Verify only the expected paths remain**

Run: `git status` and `ls -la`
Expected: `git status` shows only deletions staged (no old implementation files left in the working tree besides what's listed above), and `ls -la` shows just `.git/`, `.claude/`, `.superpowers/`, `.gitignore`, `AGENTS.md`, `docs/` (containing only `superpowers/`), `README.md`.

- [ ] **Step 5: Rewrite README.md as a placeholder**

Replace the full contents of `README.md` with:

```markdown
# buffr

Self-hosted personal agent — being rebuilt from scratch, phase by phase, using
*AI Agents in Action* as a reference.

There is no implementation yet. See `docs/superpowers/specs/` for the design of
the current phase and `docs/superpowers/plans/` for its implementation plan.

Prior implementation (aptkit-based Gemma RAG agent) is available in git history
before the reset commit.
```

- [ ] **Step 6: Commit the reset**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: reset buffr to a blank slate

Removing the aptkit-based implementation and old-project docs to restart
buffr from scratch, building it phase by phase against AI Agents in Action.
Full prior implementation remains available in git history.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

Run: `git log --oneline -1 && git status`
Expected: commit succeeds, `git status` is clean.

---

### Task 2: Scaffold bare TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`

**Interfaces:**
- Consumes: the clean working tree produced by Task 1.
- Produces: a compiling, runnable Node/TypeScript project. Future phases add dependencies to this `package.json` and files under `src/` — no exported symbols yet, since `src/index.ts` is a placeholder with no functions to call.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "buffr",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create src/index.ts**

```typescript
console.log("buffr — reset scaffold. Ready for phase 1.");
```

- [ ] **Step 4: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` and `package-lock.json` are created with no errors.

- [ ] **Step 5: Build and run to verify the scaffold works**

```bash
npm run build && npm start
```

Expected: `tsc` compiles with no errors, and the program prints
`buffr — reset scaffold. Ready for phase 1.`

- [ ] **Step 6: Commit the scaffold**

```bash
git add package.json package-lock.json tsconfig.json src/index.ts
git commit -m "$(cat <<'EOF'
chore: add bare TypeScript scaffold

Minimal package.json + tsconfig.json + src/index.ts — just enough to
compile and run. No architecture decisions yet; those arrive with the
first book-guided phase.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

Run: `git log --oneline -2 && git status`
Expected: commit succeeds, `git status` is clean (aside from gitignored `dist/`, `node_modules/`).
