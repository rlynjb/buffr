# .ai-rules/

Universal AI assistant rules for the buffr codebase. These are tool-agnostic conventions written as plain Markdown that any coding AI can follow.

## Rule Files

| File | Covers |
|------|--------|
| [code-style.md](./code-style.md) | Naming, formatting, imports, preferred patterns, anti-patterns |
| [architecture.md](./architecture.md) | Directory structure, module boundaries, dependency direction, state management, API design |
| [testing.md](./testing.md) | Test framework, file placement, what to test, mocking, naming, coverage |
| [error-handling.md](./error-handling.md) | Try/catch patterns, error classification, logging, user-facing messages |
| [security.md](./security.md) | Input validation, secrets management, XSS/injection prevention |
| [git.md](./git.md) | Commit format, branch naming, PR conventions, changelog |
| [documentation.md](./documentation.md) | Comments, JSDoc, TODOs, README, ADRs |
| [dependencies.md](./dependencies.md) | Preferred libraries, libraries to avoid, evaluation criteria, versioning |
| [ai-behavior.md](./ai-behavior.md) | Rules specifically for AI assistants: do/don't, context awareness, when to ask |
| [output-modes.md](./output-modes.md) | Conceptual vs actionable output modes, when to use each, good/bad examples |

## How to Use

These rules are written as plain Markdown and can be integrated with any AI coding tool. The integration method varies by tool:

### Claude Code

Add to your `CLAUDE.md`:

```markdown
Follow the conventions documented in .ai-rules/. Key files:
- .ai-rules/ai-behavior.md — AI-specific rules
- .ai-rules/code-style.md — Code style conventions
- .ai-rules/architecture.md — Architectural boundaries
```

Or reference specific rules:

```markdown
@.ai-rules/code-style.md
@.ai-rules/architecture.md
```

### Cursor

Add to `.cursorrules` or `.cursor/rules`:

```
Read and follow all rules in .ai-rules/ directory.
Priority files: ai-behavior.md, code-style.md, architecture.md
```

Or create `.cursor/rules` files that include specific rules:

```
@.ai-rules/ai-behavior.md
@.ai-rules/code-style.md
```

### GitHub Copilot

Add a `.github/copilot-instructions.md` that references the rules:

```markdown
Follow the project conventions documented in:
- .ai-rules/code-style.md
- .ai-rules/architecture.md
- .ai-rules/ai-behavior.md
```

### Windsurf

Add to `.windsurfrules`:

```
Follow the conventions in .ai-rules/. Prioritize:
- ai-behavior.md for general conduct
- code-style.md for formatting and naming
- architecture.md for file placement and boundaries
```

### Aider

Reference in `.aider.conf.yml`:

```yaml
read:
  - .ai-rules/ai-behavior.md
  - .ai-rules/code-style.md
  - .ai-rules/architecture.md
```

### Cline

Add to `.clinerules`:

```
Read and follow all rules in .ai-rules/ directory.
Start with: ai-behavior.md, code-style.md, architecture.md
```

### Other Tools

For any AI coding tool that supports custom instructions or context files, point it at the `.ai-rules/` directory. The files are self-contained Markdown — no special format or syntax required.

## Priority Order

When rules conflict or time is limited, prioritize in this order:

1. **ai-behavior.md** — How the AI should approach work
2. **output-modes.md** — Whether to give conceptual or actionable output
3. **architecture.md** — Where code belongs and dependency rules
4. **code-style.md** — How code should look
5. **security.md** — What not to expose or break
6. **error-handling.md** — How to handle failures
7. **git.md** — How to commit and collaborate
8. **documentation.md** — When and how to document
9. **dependencies.md** — What to install and avoid
10. **testing.md** — How to test (when test framework is added)

## Updating Rules

- Rules should reflect the actual codebase conventions, not aspirational ones
- Update rules when the codebase patterns change
- Add concrete examples from the actual codebase when possible
- Keep each file focused — don't let files grow beyond what's scannable
- The `## Stack-Specific` section at the bottom of each file contains framework-specific details
