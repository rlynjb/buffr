# Documentation

When and where to document code, and in what format.

## Comments

### When to Comment

- Comment **why**, not **what**. The code shows what; comments explain intent that isn't obvious.
- Comment workarounds, non-obvious constraints, and design decisions.
- Do not add comments that restate the code.

```typescript
// Good — explains a non-obvious design choice
// Dynamic import workaround: we import at module level since Netlify bundles
const { ChatAnthropic } = require("@langchain/anthropic");

// Good — explains a business rule
// Deduplicate by id, limit to 3
const seen = new Set<string>();

// Bad — restates the code
// Set loading to true
setLoading(true);

// Bad — obvious from the function name
// Gets the project by id
const project = await getProject(id);
```

### When Not to Comment

- Do not add comments to well-named functions, variables, and types
- Do not add JSDoc to every function — only to exported utilities with non-obvious contracts
- Do not add comments to React components that simply render props
- Do not add file-level comments describing what the file contains (the file name and exports are sufficient)

### Comment Format

- Use `//` for inline comments, placed above the line they reference
- Use `/** */` block comments only for multi-line JSDoc on exported functions
- One space after `//`
- No trailing comments on the same line as code (except very short annotations)

```typescript
// Good
// Classify known error patterns into HTTP status codes
export function classifyError(err: unknown): { message: string; status: number } {

// Bad — trailing comment
const result = items.filter(x => x.active); // filter active items
```

## JSDoc

Use JSDoc sparingly — only on exported functions where the signature alone doesn't convey the contract.

```typescript
// Good — adds information beyond the signature
/**
 * Shared HTTP response helpers for Netlify Functions.
 */

/**
 * Classifies common provider / API errors into user-friendly messages
 * with appropriate HTTP status codes.
 */
export function classifyError(
  err: unknown,
  fallbackMessage = "Something went wrong"
): { message: string; status: number } {

// Bad — JSDoc that just restates the type signature
/**
 * @param id - The project id
 * @returns The project
 */
export async function getProject(id: string): Promise<Project> {
```

Do not add `@param` and `@returns` tags when the TypeScript types already document them clearly. Only add JSDoc tags when there are constraints, side effects, or non-obvious behavior to document.

## Inline TODOs

Use `TODO:` (uppercase) with a brief description of what needs to be done. Include context on when or why.

```typescript
// Good
// TODO: implement when Notion integration is ready
// TODO: add retry logic for GitHub 5xx errors
// TODO: replace with proper auth middleware

// Bad — no context
// TODO
// todo: fix this
// FIXME
// HACK
```

Do not use `FIXME`, `HACK`, `XXX`, or other variant tags. Use `TODO:` consistently.

## README

- The project root `README.md` covers: what the project is, how to set it up, how to run it, and how to deploy it
- Do not create README files inside subdirectories unless the directory is a standalone package
- Keep the README focused on getting started — link to `ARCHITECTURE.md` for deep dives

## Architecture Decision Records (ADRs)

Major architectural decisions are documented in the `## Design Decisions & Trade-offs` section of `ARCHITECTURE.md`, not as separate ADR files.

If the project grows to need formal ADRs:

- Create a `docs/adr/` directory
- Name files `001-use-netlify-blobs.md`, `002-multi-provider-llm.md`, etc.
- Follow the format: Context → Decision → Consequences

For now, add significant decisions to `ARCHITECTURE.md` section 10.

## Changelog

- Maintain `CHANGELOG.md` at the project root
- Update when merging user-visible changes
- Format: type-grouped entries under version headers
- See [git.md](./git.md) for format details

## API Documentation

- The API surface is documented in `ARCHITECTURE.md` section 7
- Each endpoint lists: method, query parameters, request body type, and response type
- Keep this in sync when adding or modifying endpoints
- Do not generate separate OpenAPI/Swagger specs unless the project needs external API consumers

## Type Documentation

- Types are self-documenting through their field names and TypeScript annotations
- All shared types live in `src/lib/types.ts`
- Add a comment above a type field only when the value range or purpose isn't obvious from the name

```typescript
// Good — comment explains non-obvious semantics
interface Prompt {
  scope: "global" | string; // "global" or a projectId
}

// Bad — comment restates the type
interface Project {
  name: string; // the project name
}
```

## Stack-Specific

- Do not create `.md` files inside `src/` — documentation lives at the project root or in `docs/`
- React component props are documented through their TypeScript interface, not JSDoc
- Tailwind class usage does not need comments — the utility names are self-documenting
