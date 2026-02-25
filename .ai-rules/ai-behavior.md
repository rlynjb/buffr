# AI Behavior

Rules and expectations for AI coding assistants working in this codebase.

## Core Principles

1. **Read before you write.** Always read the file and surrounding code before making changes. Understand existing patterns before suggesting modifications.
2. **Minimal, focused changes.** Change only what's needed for the task at hand. Do not refactor unrelated code, add unrelated features, or "improve" code you weren't asked to touch.
3. **Preserve existing patterns.** Match the style, naming, and structure of the surrounding code, even if you would do it differently in a greenfield project.

## Do

- **Ask before deleting files or making destructive changes.** Deletion, renaming, and major restructuring should be confirmed.
- **Prefer editing existing files over creating new ones.** Adding a function to an existing module is better than creating a new file for one function.
- **Implement fully or explain what's missing.** Do not generate placeholder code, `TODO` stubs, or `// implement this` comments. If you can't complete something, explain what's needed.
- **State assumptions explicitly.** If you're unsure about a requirement, say so rather than guessing.
- **Use the project's API layer.** All backend calls from the frontend go through `src/lib/api.ts`. Never use raw `fetch()` in components.
- **Use shared utilities.** Use `json()`, `errorResponse()`, and `classifyError()` from `responses.ts` in all Netlify Functions. Use `PHASE_BADGE_VARIANTS` from `constants.ts` instead of redefining it.
- **Follow the established import style.** Use `import type` for type-only imports. Use the `@/` path alias. Group imports correctly (see [code-style.md](./code-style.md)).

## Do Not

### Code Changes

- **Do not add dependencies without stating why.** If a task requires a new package, explain the need and alternatives considered.
- **Do not over-abstract prematurely.** Three similar lines of code are better than a premature abstraction. Do not create helper functions, utilities, or wrappers for one-time operations.
- **Do not add error handling for impossible scenarios.** Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs, storage reads).
- **Do not add docstrings, comments, or type annotations to code you didn't change.** Only add comments where the logic isn't self-evident.
- **Do not add feature flags or backward-compatibility shims.** If something is being changed, change it directly.
- **Do not rename unused variables with `_` prefix** or add `// removed` comments for deleted code. If code is unused, delete it completely.
- **Do not introduce new styling patterns.** Use Tailwind utility classes with the project's semantic color tokens. Do not add CSS modules, styled-components, or a className merging library.

### Behavior

- **Do not make up URLs.** Only use URLs that exist in the codebase or were provided by the user.
- **Do not guess at API contracts.** Read the actual endpoint implementation before writing frontend code that calls it.
- **Do not assume the presence of files or features.** Check with a file read before referencing.
- **Do not commit changes without being asked.** Stage and commit only when explicitly requested.
- **Do not push to remote without being asked.** And never force-push to `main`.

## When Working on Components

- Check if a UI primitive exists in `src/components/ui/` before creating a new one
- Components over ~150 lines should be considered for extraction (see [architecture.md](./architecture.md))
- Use the existing variant pattern (`Record<Variant, string>`) for styling, not switch/if chains
- Destructure props in the function signature
- Use `"use client"` only when the component uses hooks or browser APIs

```typescript
// Good — follows project conventions
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Project } from "@/lib/types";

interface ProjectActionsProps {
  project: Project;
  onDelete: (id: string) => void;
}

export function ProjectActions({ project, onDelete }: ProjectActionsProps) {
  const [loading, setLoading] = useState(false);
  // ...
}
```

## When Working on Backend Functions

- Use the handler + named-function pattern for multi-operation endpoints
- Use `json()` and `errorResponse()` from `responses.ts` — never construct `new Response()` manually
- Use `classifyError()` in the top-level catch block
- Import types from `../../src/lib/types` — the backend shares types with the frontend
- Add new storage operations to the appropriate module in `netlify/functions/lib/storage/`

```typescript
// Good — follows project conventions
import { json, errorResponse, classifyError } from "./lib/responses";
import type { Context } from "@netlify/functions";

export default async function handler(req: Request, _context: Context) {
  try {
    if (req.method === "GET") return handleList();
    if (req.method === "POST") return handleCreate(req);
    return errorResponse("Method not allowed", 405);
  } catch (err) {
    console.error("resource function error:", err);
    const { message, status } = classifyError(err);
    return errorResponse(message, status);
  }
}
```

## When Unsure

- **Read the existing code first.** The codebase is the source of truth for patterns and conventions.
- **Check this `.ai-rules/` directory.** These files document the conventions.
- **Check `ARCHITECTURE.md`** for high-level design decisions and data flow.
- **Ask rather than guess.** It's better to ask a clarifying question than to make an incorrect assumption and generate wrong code.

## Context Awareness

When starting work on a task:

1. Read the files you'll modify
2. Read the types and interfaces involved
3. Read at least one similar existing implementation for pattern reference
4. Then write code that follows what you found

Do not rely on general knowledge about React/Next.js/Netlify patterns — this project has its own specific conventions, and they take precedence.
