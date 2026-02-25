# Code Style

Coding style and formatting conventions for this project.

## Naming Conventions

### Files

- Use **kebab-case** for all file names: `project-card.tsx`, `flow-state.ts`, `next-actions.ts`
- React component files use `.tsx`; non-JSX modules use `.ts`
- One component per file. The file name matches the component purpose, not the component name.
- Backend handler files are named after their resource: `projects.ts`, `sessions.ts`, `tools.ts`

```
// Good
src/components/dashboard/project-card.tsx
src/lib/flow-state.ts
netlify/functions/projects.ts

// Bad
src/components/dashboard/ProjectCard.tsx
src/lib/FlowState.ts
netlify/functions/handleProjects.ts
```

### Variables and Functions

- Use **camelCase** for variables, functions, and methods
- Use **PascalCase** for React components, interfaces, and type aliases
- Boolean variables: prefix with `is`, `has`, `can`, `should` — or use a natural predicate (`loading`, `open`, `disabled`)
- Event handlers: prefix with `handle` in the defining component, `on` in props

```typescript
// Good
const [loading, setLoading] = useState(false);
const hasRepo = !!project.githubRepo;

function handleDelete(id: string) { ... }
<Button onClick={() => handleDelete(id)} />

interface CardProps {
  onDelete: (id: string) => void;  // "on" prefix in prop interface
}

// Bad
const [isLoadingData, setIsLoadingData] = useState(false);
const repoExists = project.githubRepo ? true : false;
const deleteHandler = (id: string) => { ... };
```

### Constants

- Use **UPPER_SNAKE_CASE** for module-level constants that are shared or represent fixed mappings
- Use `as const` for object literals that should be narrowly typed

```typescript
// Good
export const PHASE_BADGE_VARIANTS: Record<string, "default" | "accent"> = { ... };
export const AVAILABLE_PROJECT_FILES = ["AI_RULES.md", "README.md"] as const;

// Bad
export const phaseBadgeVariants = { ... };
export const availableFiles = ["AI_RULES.md"];
```

### Interfaces and Types

- Use `interface` for object shapes. Use `type` for unions, intersections, and aliases.
- Prefix prop interfaces with the component name: `ButtonProps`, `CardProps`, `SessionTabProps`
- Do not prefix interfaces with `I`

```typescript
// Good
interface Project { ... }
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { ... }
type Variant = "primary" | "secondary" | "ghost" | "danger";
type FlowStep = 1 | 2 | 3 | 4;

// Bad
interface IProject { ... }
type ProjectType = { ... };  // Use interface for object shapes
```

## Formatting

- **Indentation:** 2 spaces
- **Semicolons:** always
- **Trailing commas:** always (arrays, objects, function parameters)
- **Quotes:** double quotes for strings
- **Line length:** aim for under 100 characters; hard wrap at 120
- **Blank lines:** one between logical sections, none between consecutive same-level declarations
- **Parentheses:** omit around single arrow-function parameters only when the body is a single expression

```typescript
// Good
const result = items.map((item) => item.name);
const projects = await listProjects();

// Bad
const result = items.map(item => item.name);
```

## Import Ordering

Group imports in this order, separated by a blank line:

1. React / framework imports (`react`, `next/*`)
2. External libraries (`@langchain/*`, `@netlify/*`, `crypto`)
3. Internal aliases — path alias `@/` (`@/components/*`, `@/lib/*`, `@/context/*`)
4. Relative imports (`./`, `../`)
5. Type-only imports (use `import type`)

```typescript
// Good
import { useState, useEffect } from "react";
import Link from "next/link";

import { getStore } from "@netlify/blobs";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { Project } from "@/lib/types";

import { SessionTab } from "./session-tab";
```

Use `import type` for imports used only as types:

```typescript
// Good
import type { Context } from "@netlify/functions";
import type { Project, Session } from "@/lib/types";

// Bad
import { Context } from "@netlify/functions";  // only used as type annotation
```

## Preferred Patterns

### Early Returns and Guard Clauses

Return early for error/empty cases. Avoid deeply nested if-else chains.

```typescript
// Good
if (!id) {
  return errorResponse("Project id required", 400);
}
const project = await getProject(id);
if (!project) {
  return errorResponse("Project not found", 404);
}
// ... proceed with project

// Bad
if (id) {
  const project = await getProject(id);
  if (project) {
    // ... deeply nested logic
  } else {
    return errorResponse("Project not found", 404);
  }
} else {
  return errorResponse("Project id required", 400);
}
```

### Destructuring

Destructure props in function parameters. Destructure objects when accessing multiple properties.

```typescript
// Good
export function PromptsTab({ prompts, resolvedBodies, copiedId, onCopy }: PromptsTabProps) {

// Bad
export function PromptsTab(props: PromptsTabProps) {
  const prompts = props.prompts;
```

### Conditional Rendering

Use `&&` for show/hide. Use ternary for two-branch rendering. Extract to a variable or early return for complex conditions.

```typescript
// Good
{hasRepo && <Badge>Connected</Badge>}
{loading ? <Skeleton /> : <Content />}

// Bad — nested ternaries
{loading ? <Skeleton /> : error ? <Error /> : <Content />}
```

### Variant Mappings

Use `Record<Variant, string>` maps for styling variants instead of switch/if chains.

```typescript
// Good
const variantClasses: Record<Variant, string> = {
  primary: "bg-accent text-white",
  secondary: "bg-card border border-border",
};
className={variantClasses[variant]}

// Bad
const getClass = (v: Variant) => {
  if (v === "primary") return "bg-accent text-white";
  if (v === "secondary") return "bg-card border border-border";
};
```

## Anti-Patterns to Avoid

- **No `any` type.** Use `unknown` and narrow, or define a proper type.
- **No magic strings/numbers.** Extract to named constants.
- **No `console.log` in committed code.** Use `console.error` in catch blocks for serverless functions only.
- **No default exports except Next.js pages and Netlify function handlers.** Use named exports for components and utilities.
- **No index files** (`index.ts` barrels). Import directly from the module file.
- **No class components.** Use function components with hooks.
- **No `var`.** Use `const` by default, `let` only when reassignment is necessary.
- **No nested ternaries.** Extract to variables or use early returns.
- **No string concatenation for classNames** exceeding 3 segments. Use template literals or array join.

## Stack-Specific: Next.js + React + Tailwind

- Mark client components with `"use client"` at the top of the file. Only add this directive to components that use hooks, event handlers, or browser APIs.
- Use the `@/` path alias for all imports from `src/`. Never use `../../` to navigate upward more than one level.
- Use Tailwind utility classes directly. Do not create CSS modules or styled-components.
- Use semantic color tokens (`text-foreground`, `bg-card`, `border-border`) — never use raw color values like `text-gray-500`.
- Prefer `className` string composition over `clsx`/`cn` utilities — the project does not use a className merging library.
