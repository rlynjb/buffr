# Dependencies

Dependency management, preferred libraries, and evaluation criteria.

## Current Stack

These are the project's established dependencies. Prefer these over alternatives.

| Need | Library | Why |
|------|---------|-----|
| Framework | Next.js | App Router, server components, built-in routing |
| UI | React | Component model, ecosystem, team familiarity |
| Styling | Tailwind CSS v4 | Utility-first, no CSS modules, design token system |
| Backend | Netlify Functions v2 | Serverless, co-deployed with frontend, web API compatible |
| Storage | @netlify/blobs | Zero-config KV, works locally and in production |
| LLM abstraction | LangChain.js | Multi-provider support, chain composition, prompt templates |
| LLM: Anthropic | @langchain/anthropic | Claude models |
| LLM: OpenAI | @langchain/openai | GPT models |
| LLM: Google | @langchain/google-genai | Gemini models |
| LLM: Local | @langchain/ollama | Local model inference |

## Libraries to Avoid

Do not introduce these without explicit discussion:

| Library | Reason |
|---------|--------|
| Redux / Zustand / Jotai | Unnecessary — local state + context is sufficient |
| styled-components / Emotion / CSS Modules | Project uses Tailwind — do not mix styling systems |
| clsx / classnames / tailwind-merge | Project concatenates className strings directly |
| Axios | `fetch()` is sufficient; the typed `request()` wrapper handles all needs |
| Lodash | Use native JS methods (`.map`, `.filter`, `.reduce`, `structuredClone`) |
| Moment.js / date-fns | Use native `Date`, `toLocaleDateString()`, `toLocaleTimeString()` |
| Express / Fastify | Backend is Netlify Functions, not a Node server |
| Prisma / Drizzle / any ORM | Storage is KV (Netlify Blobs), not a SQL database |
| TypeORM / Sequelize | Same as above |
| Jest | Use Vitest when testing is introduced (better ESM/TS support) |
| Prettier (as dependency) | Formatting is handled by editor config and conventions |

## Evaluating New Dependencies

Before adding a new package, answer these questions:

1. **Can the native platform do this?** Browser APIs, Node APIs, and TypeScript's type system cover many cases. Check first.
2. **Is it worth the bundle size?** Check bundlephobia.com. Frontend dependencies should justify their weight.
3. **Is it maintained?** Check: last commit date, open issue count, security advisories. Avoid abandoned packages.
4. **Does it duplicate something we already have?** Check the existing stack table above.
5. **Is this a direct dependency or a transitive one?** Do not add packages just to get a sub-feature that a simpler solution covers.

### Decision Threshold

- **Under 10kb gzipped + well-maintained + solves a real problem:** Add it.
- **Large bundle or niche use:** Discuss before adding. Consider: can we implement the needed functionality in under 50 lines?
- **"Nice to have" utility:** Do not add. Write the 3 lines of code instead.

## Version Pinning

- Use **caret ranges** (`^`) for dependencies in `package.json` (npm default)
- Commit `package-lock.json` to lock exact versions across environments
- Do not use `*` or `>=` version ranges
- Run `npm audit` periodically and address critical vulnerabilities

```json
// Good
"next": "16.1.6",
"react": "19.2.3",
"@netlify/blobs": "^10.7.0"

// Bad
"next": "*",
"react": ">=18"
```

## Adding a Dependency

When you must add a dependency:

1. Install it: `npm install <package>`
2. Verify it works: test the feature that needs it
3. Check the lockfile diff is reasonable (not pulling in 200 transitive deps)
4. State **why** in the commit message: `chore: add vitest for unit testing framework`

## Updating Dependencies

- Update dependencies one at a time, not all at once
- Test after each update
- Read the changelog for breaking changes before updating major versions
- Pay special attention to Next.js and React major version updates

## Dev Dependencies

- Development-only tools go in `devDependencies`: linters, type checkers, test frameworks, build plugins
- Do not put `typescript`, `eslint`, `tailwindcss`, or `@types/*` in `dependencies`

## Stack-Specific

- **Tailwind v4** uses `@tailwindcss/postcss` — this is a `devDependency`, not a runtime dependency
- **LangChain provider packages** (`@langchain/anthropic`, etc.) are runtime dependencies because they're used in Netlify Functions
- **`@netlify/functions`** provides only types and helpers — it's tiny and appropriate as a runtime dependency
- All `@types/*` packages are dev dependencies
