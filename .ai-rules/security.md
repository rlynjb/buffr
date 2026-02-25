# Security

Security rules, input validation, and secrets management.

## Secrets and Environment Variables

### Never Commit Secrets

- API keys, tokens, and credentials live in `.env` (gitignored) and environment variables on the deploy platform
- `.env.example` documents required variables with placeholder values — never actual keys
- Do not log, return in API responses, or embed secrets in frontend code

```typescript
// Good
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

// Bad
const apiKey = "sk-ant-abc123...";  // hardcoded secret
console.log("Using key:", apiKey);   // logged secret
return json({ key: apiKey });        // exposed to client
```

### Environment Variable Access

- Access `process.env` only in backend code (Netlify Functions)
- Frontend code accesses provider info via the `/providers` API endpoint — never reads env vars directly
- Check for required env vars at the start of the function that needs them, not at module level

```typescript
// Good — check when needed
export function getLLM(provider: string): BaseChatModel {
  switch (provider) {
    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
      // ...
    }
  }
}

// Bad — module-level check that crashes on import
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;  // will crash if unset
```

### Tool Config Storage

- Integration config values (tokens, database IDs) are stored in the `tool-config` Netlify Blobs store
- The `configFields` schema marks fields as `secret: boolean` — respect this when displaying config in the UI
- When listing integrations, the tool config values are used to determine status but are not sent to the client

## Input Validation

### Backend: Validate All Inputs

- Validate required fields exist before using them
- Do not trust client-submitted IDs, types, or values without checking
- Use guard clauses (early returns) at the top of each handler branch

```typescript
// Good
if (req.method === "PUT") {
  if (!id) {
    return errorResponse("Project id required", 400);
  }
  const existing = await getProject(id);
  if (!existing) {
    return errorResponse("Project not found", 404);
  }
  const body = await req.json();
  const updated = { ...existing, ...body, id: existing.id };  // prevent id override
  // ...
}

// Bad — no validation
if (req.method === "PUT") {
  const body = await req.json();
  await saveProject(body);  // client controls everything including id
}
```

### Prevent ID Override

When updating entities, always preserve the existing ID from the URL parameter, not from the request body.

```typescript
// Good — server controls the id
const updated = { ...existing, ...body, id: existing.id };

// Bad — client can overwrite the id
const updated = body;
await saveProject(updated);
```

### Frontend: Validate Before Sending

- Validate required fields in the UI before making API calls
- Disable submit buttons when form is incomplete
- Show validation errors inline, not as alerts

## Authentication and Authorization

> **Current state:** buffr has no authentication layer. It relies on Netlify's deploy visibility (private sites, team access) for access control.

### Rules for When Auth Is Added

- Do not implement custom auth. Use an established provider (Netlify Identity, Auth0, Clerk).
- Validate auth tokens in every backend handler, not just the frontend.
- Never trust client-side auth checks alone — the backend is the authority.
- Use middleware or a shared `requireAuth()` helper, not per-handler token parsing.

## Common Vulnerabilities to Guard Against

### XSS (Cross-Site Scripting)

- React escapes output by default. Do not use `dangerouslySetInnerHTML` unless absolutely necessary.
- Never interpolate user content into `href` attributes without validation (e.g., `javascript:` URLs).
- The prompt template system (`resolvePrompt()`) is rendered in `<pre>` tags — maintain this pattern rather than rendering as HTML.

```typescript
// Good — React auto-escapes
<span>{project.name}</span>
<pre>{resolvedBodies[prompt.id]}</pre>

// Bad — raw HTML injection
<div dangerouslySetInnerHTML={{ __html: project.description }} />
```

### Injection

- Netlify Blobs is a KV store, not a SQL database — SQL injection is not a concern
- When constructing GitHub API URLs, use `encodeURIComponent()` for user-supplied path segments
- When constructing Netlify API URLs, validate site names against expected patterns

```typescript
// Good
const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

// Bad
const url = `https://api.github.com/repos/${ownerRepo}`;  // unsanitized
```

### CSRF

- Netlify Functions do not use cookies for auth, so CSRF is not currently a risk
- If cookie-based auth is added, implement CSRF tokens

### Dependency Vulnerabilities

- Run `npm audit` periodically
- Do not install packages with known critical vulnerabilities
- Prefer well-maintained packages with active security response teams

## URL and Link Safety

- External links (`target="_blank"`) must include `rel="noopener noreferrer"`
- Only use `href` values from trusted sources (GitHub URLs from the API, Netlify URLs from deploy)
- Do not construct URLs from user input without validation

```typescript
// Good
<a href={issue.url} target="_blank" rel="noopener noreferrer">
  {issue.title}
</a>

// Bad — missing rel
<a href={issue.url} target="_blank">{issue.title}</a>
```

## Stack-Specific: Netlify Functions

- Netlify Functions are publicly accessible by default. Every function that modifies data should validate the request.
- Do not expose internal error stack traces in API responses. The `classifyError()` pattern maps errors to user-friendly messages.
- Rate limiting is handled by the LLM providers and GitHub API — respect their 429 responses and surface them to the user.
