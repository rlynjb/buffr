# Error Handling

Error handling patterns, logging conventions, and user-facing messaging.

## General Principles

- **Fail fast, fail clearly.** Throw or return errors as early as possible.
- **Handle errors at boundaries.** Catch at the handler/page level, not deep inside utilities.
- **Never swallow errors silently.** Every `catch` must either handle the error meaningfully or re-throw.
- **Separate user-facing messages from developer context.** Users see clean messages; logs get the full stack.

## Backend Error Handling

### Handler Pattern

Every Netlify Function handler wraps its body in a try/catch. Use the shared `classifyError()` to map exceptions to HTTP status codes.

```typescript
// Good — single try/catch at handler level
export default async function handler(req: Request, _context: Context) {
  try {
    // ... route and handle
    return json(result);
  } catch (err) {
    console.error("projects function error:", err);
    const { message, status } = classifyError(err);
    return errorResponse(message, status);
  }
}

// Bad — try/catch inside every helper function
async function handleCreate(req: Request) {
  try {
    const body = await req.json();
    try {
      const saved = await saveProject(body);
      // ... nested catches
    } catch { ... }
  } catch { ... }
}
```

### Error Classification

Use `classifyError()` from `netlify/functions/lib/responses.ts` to map known error patterns to appropriate HTTP status codes:

| Pattern | Status | User Message |
|---------|--------|-------------|
| Insufficient credits | 402 | "Your LLM provider account has insufficient credits." |
| Invalid API key | 401 | "Invalid API key for the selected provider." |
| Rate limited | 429 | "Rate limited by the LLM provider. Wait a moment." |
| Name conflict | 422 | "Name conflict — that name already exists." |
| Missing config | 400 | The original error message |
| Everything else | 500 | The original error message |

When adding new error patterns, add them to `classifyError()` rather than handling them inline in individual handlers.

### Validation Errors

Return 400 with a descriptive message immediately. Do not let invalid data propagate.

```typescript
// Good
if (!id) {
  return errorResponse("Project id required", 400);
}
const project = await getProject(id);
if (!project) {
  return errorResponse("Project not found", 404);
}

// Bad — vague error
if (!id) {
  return errorResponse("Bad request", 400);
}
```

## Frontend Error Handling

### API Call Pattern

The frontend `request()` wrapper in `src/lib/api.ts` throws an `Error` with the server's error message. Catch at the component level and display to the user.

```typescript
// Good — catch in the component, show to user
async function handleSave() {
  try {
    setLoading(true);
    await createProject(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong";
    notify({ type: "error", message });
  } finally {
    setLoading(false);
  }
}

// Bad — no error handling
async function handleSave() {
  await createProject(data);  // unhandled rejection
}
```

### Loading and Error States

- Set `loading` to `true` before the async call, `false` in `finally`
- Display errors via the notification system, not `alert()`
- Disable submit buttons while loading to prevent double-submission

```typescript
// Good
const [loading, setLoading] = useState(false);

async function load() {
  try {
    setLoading(true);
    const data = await listProjects();
    setProjects(data);
  } catch (err) {
    console.error("Failed to load projects:", err);
  } finally {
    setLoading(false);
  }
}
```

### Empty State vs Error State

- **Empty state**: show a helpful message with guidance (e.g., "No projects yet. Create your first project.")
- **Error state**: show what went wrong and what the user can do (e.g., "Failed to load. Check your connection and try again.")
- Never show a blank screen. Always render something.

## Logging

### Backend (Netlify Functions)

- Use `console.error()` for caught exceptions in handlers. Include the function name for context.
- Do not use `console.log()` for debugging in committed code.
- Do not log sensitive data (tokens, API keys, user content).

```typescript
// Good
console.error("projects function error:", err);
console.error("scaffold: GitHub API failed for", ownerRepo, err);

// Bad
console.log("got here");
console.log("token:", process.env.GITHUB_TOKEN);
```

### Frontend

- Use `console.error()` in catch blocks for debugging.
- Do not leave `console.log()` calls in committed code.
- User-visible errors go through the notification system, not the console.

## Custom Error Types

Do not create custom error classes unless you need to carry structured data (e.g., status code + metadata). The `classifyError()` pattern with string matching is sufficient for the current codebase.

If custom errors become necessary:

```typescript
// Acceptable if needed
class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}
```

## Retry and Fallback Strategies

- **Do not auto-retry LLM calls.** Rate limits and credit exhaustion are user-actionable — surface the error.
- **Do not retry storage operations.** Netlify Blobs failures indicate a platform issue.
- **Do retry GitHub API calls** on 5xx errors, up to 2 retries with 1-second delay. (Not currently implemented — add if needed.)
- **Fallback for missing data:** use default values (`|| ""`, `?? null`) when reading from storage, since data might have been saved by an older schema version.

```typescript
// Good — defensive defaults for stored data
const project: Project = {
  ...existing,
  constraints: existing.constraints || "",
  issueCount: existing.issueCount ?? undefined,
};
```

## Stack-Specific: Netlify Functions

- Every handler must return a `Response`. Never throw without catching at the top level.
- The `405 Method Not Allowed` response is the final fallback in every handler.
- Never return HTML error pages from API functions — always return JSON via `errorResponse()`.
