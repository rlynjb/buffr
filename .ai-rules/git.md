# Git

Git workflow, commit conventions, and collaboration standards.

## Commit Messages

Use **conventional commits** format:

```
<type>: <short description>

[optional body]
```

### Types

| Type | Use When |
|------|----------|
| `feat` | Adding a new feature or capability |
| `fix` | Fixing a bug |
| `refactor` | Restructuring code without changing behavior |
| `chore` | Build config, dependencies, tooling, cleanup |
| `docs` | Documentation only |
| `style` | Formatting, whitespace, missing semicolons (no code change) |
| `test` | Adding or updating tests |

### Rules

- **Lowercase type**, no capital letter: `feat:` not `Feat:`
- **Imperative mood** in the description: "add project deletion" not "added project deletion"
- **No period** at the end of the subject line
- **Keep the subject under 72 characters**
- Use the body for "why", not "what" — the diff shows what changed

```
// Good
feat: add next-actions engine with session/issue sources
fix: prevent id override on project update
refactor: extract tool page modals into separate components
chore: add shared response helpers for netlify functions

// Bad
Fixed the bug
update stuff
feat: Add The New Feature For The Dashboard Page.
WIP
```

### Body (Optional)

Use the body when the change needs context that isn't obvious from the diff:

```
refactor: split scaffold handler into named functions

The single handler had 7 operations making it hard to navigate.
Each operation is now a named function with the default export
acting as a clean router.
```

## Branch Naming

Use descriptive kebab-case branches prefixed with the type:

```
feat/next-actions-engine
fix/project-update-id-override
refactor/extract-tool-modals
chore/shared-response-helpers
docs/architecture-guide
```

### Rules

- Branch from `main`
- Keep branches short-lived — merge or rebase within a few days
- Delete branches after merging

## PR Size and Scope

- **One concern per PR.** A feature, a bugfix, or a refactor — not all three.
- **Aim for under 400 lines changed.** If a change is larger, split it into sequential PRs.
- **Include context in the PR description.** What changed, why, and how to test it.

### PR Description Format

```markdown
## Summary
- Brief description of what changed and why

## Changes
- List of specific changes made

## Test Plan
- How to verify the changes work correctly
```

## Branching Strategy

- **`main`** is the production branch. It should always be deployable.
- Feature branches merge into `main` via PR (or direct push for solo work).
- No long-lived development branches. No `develop` or `staging` branches.
- Netlify deploys automatically on push to `main`.

## Changelog

- The project maintains a `CHANGELOG.md` at the root
- Update the changelog when adding user-visible features or fixing bugs
- Group entries under version headers with dates
- Use the same types as commit messages: Added, Fixed, Changed, Removed

```markdown
## [Unreleased]

### Added
- Next-actions engine with session, activity, and issue sources

### Fixed
- Project update no longer allows client-side ID override

### Changed
- Tools page refactored into coordinator + 3 modal components
```

## Things to Avoid

- **Do not force-push to `main`.** Ever.
- **Do not commit `.env` files, API keys, or secrets.** Verify with `git diff --cached` before committing.
- **Do not commit `node_modules/`, `.next/`, or build artifacts.** These are gitignored.
- **Do not amend published commits** unless you are the only person working on the branch.
- **Do not use `git add .` blindly.** Review what you're staging with `git status` first.
- **Do not commit commented-out code** unless it's a temporary stub with a clear explanation (e.g., `// TODO: implement when Notion integration is ready`).

## Stack-Specific

- `.gitignore` should include: `node_modules/`, `.next/`, `.env`, `.env.local`, `.netlify/`
- Lock files (`package-lock.json`) should be committed and kept in sync
- Netlify auto-deploys from `main` — treat every merge as a production release
