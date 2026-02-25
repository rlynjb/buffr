# Architecture

Architectural rules and boundaries for this project.

## Directory Structure Conventions

Every file has a designated home. Do not create new top-level directories without explicit discussion.

```
src/app/          → Next.js pages (App Router). One page.tsx per route.
src/components/   → React components, organized by domain.
  ui/             → Primitive, reusable UI components (Button, Card, Modal, etc.)
  dashboard/      → Dashboard-specific components
  flow/           → New-project wizard step components
  session/        → Project detail / session tab components
  tools/          → Tools & integrations page components
src/context/      → React context providers
src/hooks/        → Custom React hooks
src/lib/          → Shared utilities, types, constants, and API client

netlify/functions/          → Serverless API handlers (one file per resource)
netlify/functions/lib/      → Shared backend utilities
  ai/                       → LLM provider factory, chains, prompts
  storage/                  → Netlify Blobs store accessors (one per entity)
  tools/                    → MCP-compatible tool registry and definitions
```

### Where Things Go

| You want to... | Put it in... |
|----------------|-------------|
| Add a new page | `src/app/{route}/page.tsx` |
| Add a UI primitive | `src/components/ui/{name}.tsx` |
| Add a domain component | `src/components/{domain}/{name}.tsx` |
| Add a shared type | `src/lib/types.ts` |
| Add a shared constant | `src/lib/constants.ts` |
| Add an API client function | `src/lib/api.ts` |
| Add a pure utility function | `src/lib/{name}.ts` |
| Add a backend endpoint | `netlify/functions/{resource}.ts` |
| Add a storage accessor | `netlify/functions/lib/storage/{entity}.ts` |
| Add an LLM chain | `netlify/functions/lib/ai/chains/{name}.ts` |
| Add a tool integration | `netlify/functions/lib/tools/{name}.ts` |

## Module Boundaries and Dependency Direction

Dependencies flow **downward and inward** only:

```
Pages → Components → UI primitives
Pages → lib/ (types, api, constants, utilities)
Components → lib/ (types, api, constants, utilities)

Functions → lib/ (storage, ai, tools, github, responses)
Functions → src/lib/types (shared types only)
```

### Hard Rules

- **Frontend never imports from `netlify/functions/`.** All server communication goes through `src/lib/api.ts`.
- **Components never call `fetch()` directly.** All API calls are made through typed functions in `src/lib/api.ts`.
- **UI primitives (`src/components/ui/`) never import from domain components.** They are generic and reusable.
- **Backend storage modules never import from other storage modules.** Each store is independent.
- **Backend functions share code only through `netlify/functions/lib/`.** Never import between function handler files.

```typescript
// Good — component uses API layer
import { listProjects } from "@/lib/api";
const projects = await listProjects();

// Bad — component calls fetch directly
const res = await fetch("/.netlify/functions/projects");
```

## Separation of Concerns

### Frontend

- **Pages** (`src/app/`) — orchestrate data fetching, state, and layout. Pages are `"use client"` when they use hooks.
- **Components** — render UI from props. Keep business logic in the page or a hook, not in the component.
- **Lib** — pure functions, types, and the API client. No React imports here (except `types.ts` has no React dependency).
- **Context** — app-wide shared state (LLM provider selection). Use sparingly — most state is local.

### Backend

- **Handlers** (`netlify/functions/*.ts`) — HTTP routing, request parsing, response formatting. Delegate to lib/.
- **Storage** — typed CRUD over Netlify Blobs. No business logic.
- **AI** — LLM provider factory and LangChain chains. No HTTP or storage awareness.
- **Tools** — registry pattern for MCP-compatible tools. Tools are self-contained.

## State Management

- **Local state first.** Use `useState` for component-scoped state.
- **`useReducer` for complex state machines.** The project wizard uses `flowReducer` with a `FlowAction` union type. Follow this pattern for multi-step flows.
- **React context only for truly global state.** Currently: LLM provider selection via `ProviderContext`.
- **No state management library** (Redux, Zustand, etc.). Do not introduce one without discussion.
- **Persist user preferences to `localStorage`** (e.g., selected provider). Do not persist transient state.

```typescript
// Good — useReducer for complex interdependent state
const [state, dispatch] = useReducer(flowReducer, initialFlowState);
dispatch({ type: "SET_PLAN", plan: generatedPlan });

// Good — useState for simple local state
const [loading, setLoading] = useState(false);

// Bad — prop drilling through 4+ levels. Use context or restructure.
```

## API Design Conventions

### URL Pattern

All endpoints live at `/.netlify/functions/{resource}`. Routing within a handler uses **HTTP method + query parameters**, not sub-paths.

```
GET    /projects              → list all
GET    /projects?id=abc       → get one
POST   /projects              → create
PUT    /projects?id=abc       → update
DELETE /projects?id=abc       → delete
```

### Response Format

- Use the shared `json()` and `errorResponse()` helpers from `netlify/functions/lib/responses.ts`
- Success responses return the entity or `{ ok: true }`
- Error responses return `{ error: "message" }` with appropriate HTTP status
- Use `classifyError()` for mapping caught errors to HTTP status codes

```typescript
// Good
return json(project, 201);
return errorResponse("Project not found", 404);

// Bad
return new Response(JSON.stringify(project), {
  status: 201,
  headers: { "Content-Type": "application/json" },
});
```

### Handler Structure

Split handlers with 3+ operations into named functions with a router in the default export.

```typescript
// Good — clean router pattern
export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.searchParams.has("repos")) return handleRepos();
    if (req.method === "GET" && url.searchParams.has("analyze")) return handleAnalyze(url);
    if (req.method === "POST") return handleCreate(req);
    return errorResponse("Method not allowed", 405);
  } catch (err) {
    const { message, status } = classifyError(err);
    return errorResponse(message, status);
  }
}
```

## Component Extraction Rules

- Extract a component when it exceeds **~150 lines** or manages **its own distinct state** (e.g., form inputs, modal open/close)
- Extract tab panels, modals, and form sections into separate files in the parent's domain directory
- Keep the parent component as a coordinator that passes props down

```
// Good — tools page with extracted modals
src/app/tools/page.tsx                  (~200 lines, coordinator)
src/components/tools/add-integration-modal.tsx
src/components/tools/config-modal.tsx
src/components/tools/test-tool-modal.tsx

// Bad — everything in one file
src/app/tools/page.tsx                  (500+ lines, 16 state variables)
```

## Stack-Specific: Next.js + Netlify

- Use **App Router** conventions. Each route gets a directory with `page.tsx`.
- Do not use API routes (`app/api/`). All backend logic goes through Netlify Functions.
- Netlify Functions use the **v2 default export pattern** with `Request`/`Response` web APIs. Do not use the v1 `Handler` callback pattern.
- Import `Context` from `@netlify/functions` as a type only unless you need its methods.
