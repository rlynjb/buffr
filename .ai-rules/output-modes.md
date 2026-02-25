# Output Modes

AI assistants should operate in one of two modes depending on the user's intent. Recognizing which mode is needed — and defaulting to the right one — is critical for usefulness.

## Mode 1: Conceptual

**Purpose:** Understanding, learning, decision-making, communicating with stakeholders.

**Characteristics:**
- High-level overviews and simplified diagrams
- Plain-language explanations without implementation detail
- Trade-off comparisons (pros/cons, when to use X vs Y)
- Mental models and analogies
- Architecture "box and arrow" diagrams with labels, not config

**When to default to this:**
- The user asks "why" or "what is"
- Comparing approaches or technologies
- Onboarding someone to a concept or system
- Early-stage brainstorming before decisions are made
- Stakeholder communication or documentation summaries

**Signals in the prompt:**
- "Explain...", "What's the difference between...", "Help me understand..."
- "Compare...", "What are the trade-offs of..."
- "Give me an overview of...", "How does X work conceptually?"

---

## Mode 2: Actionable

**Purpose:** Building, implementing, executing, deploying, fixing.

**Characteristics:**
- Exact commands, copy-pasteable as-is
- Specific file paths relative to the project root
- Real library names with version numbers
- Concrete data flow with actual field names and types
- Config snippets, schema definitions, environment variables
- Step-by-step procedures with numbered steps
- Working code, not pseudocode

**When to default to this:**
- Any request involving "create", "build", "set up", "implement", "deploy", "fix", "migrate", "add", "configure", "connect"
- Follow-up to a conceptual discussion ("OK, let's do it")
- Debugging or troubleshooting
- Any task where the next step is typing into a terminal or editor

**Signals in the prompt:**
- "Set up...", "Create a...", "Add...", "Fix...", "Implement..."
- "How do I...", "What command...", "Show me the code for..."
- "Make it work", "Deploy this", "Connect X to Y"

---

## Rules

### Default to actionable

Unless explicitly asked for a conceptual overview, assume the user wants something they can execute on. Most prompts to a coding AI are requests for implementation, not education.

### Never stop at boxes and arrows

If generating a diagram, plan, or architecture — always accompany it with the concrete details needed to act on it: commands, file paths, configs, data shapes, API contracts. A diagram without implementation details is a decoration.

### Flag which mode you're using

Start responses with a one-line indicator so the user can redirect if needed:

```
**Mode: Conceptual** — high-level overview of the caching strategy.
```

```
**Mode: Actionable** — implementation steps with commands and config.
```

If the user didn't specify and you're defaulting to actionable, no flag is needed — actionable is the default and doesn't require announcement.

### Offer to upgrade

If you provide a conceptual answer, end with:

> "Want me to make this actionable with specific commands, configs, and implementation details?"

This gives the user a one-click path from understanding to implementation.

### When both are needed, layer them

Lead with a brief conceptual summary (3-5 sentences max), then immediately follow with the full actionable breakdown. Do not make the user ask twice.

```
## How it works

The next-actions engine generates suggested tasks from three priority-ordered
sources: the last session's next step, activity gaps over 7 days, and the top 3
open GitHub issues. Results are capped at 3 actions.

## Implementation

1. Create `src/lib/next-actions.ts`:
   [full implementation]
2. Import and call from the project detail page:
   [exact code]
```

### Actionable means complete

Do not generate half-implementations with TODO comments. If a step requires a command, include the command. If it needs a config file, write the full config file. If it needs types, define the types. If you cannot complete something, state exactly what is missing and why — don't leave a `// TODO: implement this` stub.

---

## Examples: Bad vs Good

### 1. Setting up a CI/CD pipeline

**Bad** (vague when actionable was needed):
```
You'll want to set up a CI/CD pipeline that runs tests on every push
and deploys to your hosting provider on merge to main. Consider using
GitHub Actions or a similar CI tool. You'll need build, test, and
deploy stages.
```

**Good** (actionable):
```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run build
```
```
Netlify handles deploy automatically on push to main via netlify.toml.
No additional deploy step needed in CI.
```

### 2. Designing a database schema

**Bad** (conceptual when actionable was needed):
```
You'll need a users table, a posts table, and a comments table.
Users have many posts, posts have many comments. Use appropriate
foreign keys and indexes for the relationships.
```

**Good** (actionable):
```typescript
// src/lib/types.ts
interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

interface Post {
  id: string;
  authorId: string;       // references User.id
  title: string;
  body: string;
  status: "draft" | "published";
  createdAt: string;
  updatedAt: string;
}

interface Comment {
  id: string;
  postId: string;         // references Post.id
  authorId: string;       // references User.id
  body: string;
  createdAt: string;
}
```
```
Storage keys:
- users store: key = user id, value = User
- posts store: key = `{authorId}:{postId}`, value = Post (prefix scan by author)
- comments store: key = `{postId}:{commentId}`, value = Comment (prefix scan by post)
```

### 3. Creating an API endpoint

**Bad** (hand-wavy):
```
Create a new API endpoint that handles CRUD operations for tasks.
It should support GET, POST, PUT, and DELETE methods with proper
error handling and validation.
```

**Good** (actionable):
```typescript
// netlify/functions/tasks.ts
import type { Context } from "@netlify/functions";
import { json, errorResponse, classifyError } from "./lib/responses";
import { getTask, listTasks, saveTask, deleteTask } from "./lib/storage/tasks";
import { randomUUID } from "crypto";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  try {
    if (req.method === "GET") {
      if (id) {
        const task = await getTask(id);
        if (!task) return errorResponse("Task not found", 404);
        return json(task);
      }
      return json(await listTasks());
    }

    if (req.method === "POST") {
      const body = await req.json();
      if (!body.title) return errorResponse("Title required", 400);
      const task = { id: randomUUID(), ...body, createdAt: new Date().toISOString() };
      return json(await saveTask(task), 201);
    }

    return errorResponse("Method not allowed", 405);
  } catch (err) {
    console.error("tasks function error:", err);
    const { message, status } = classifyError(err);
    return errorResponse(message, status);
  }
}
```

### 4. Describing a deployment architecture

**Bad** (boxes without substance):
```
The app will be deployed with a frontend hosted on a CDN, a serverless
backend, and a managed database. Traffic flows from the user through
a load balancer to the backend services. Use environment variables
for configuration.
```

**Good** (actionable):
```
Deployment: Netlify (auto-deploys from main)

Frontend: Next.js static + SSR at edge via .next/ publish directory
Backend:  Netlify Functions v2 at /.netlify/functions/*
Storage:  Netlify Blobs (KV, per-deploy scoped)

Config (netlify.toml):
  build.command    = "npm run build"
  build.publish    = ".next"
  functions.directory = "netlify/functions"

Required env vars (set in Netlify UI → Site settings → Environment):
  ANTHROPIC_API_KEY    — LLM access
  GITHUB_TOKEN         — repo operations
  NETLIFY_TOKEN        — site creation via API

Deploy: push to main → Netlify CI builds → live in ~60 seconds
```

### 5. Writing a migration plan

**Bad** (vague plan):
```
We'll need to migrate the data from the old format to the new format.
First, create a backup, then transform the data, and finally validate
that everything migrated correctly. Roll back if there are issues.
```

**Good** (actionable):
```typescript
// scripts/migrate-v2.ts
// Migrates projects from v1 (no `phase` field) to v2 (with `phase`)
//
// Run: npx tsx scripts/migrate-v2.ts
// Rollback: restore from the backup JSON written to ./backups/

import { getStore } from "@netlify/blobs";

async function migrate() {
  const store = getStore("projects");
  const { blobs } = await store.list();

  console.log(`Found ${blobs.length} projects to migrate`);

  for (const blob of blobs) {
    const project = await store.get(blob.key, { type: "json" });

    if (!project.phase) {
      const updated = { ...project, phase: "idea" };
      await store.setJSON(blob.key, updated);
      console.log(`Migrated: ${project.name} → phase: idea`);
    }
  }

  console.log("Migration complete");
}

migrate().catch(console.error);
```
```
Steps:
1. Run backup:   npx tsx scripts/backup-store.ts projects > backups/projects-$(date +%s).json
2. Run migration: npx tsx scripts/migrate-v2.ts
3. Verify:       curl /.netlify/functions/projects | jq '.[].phase' — all should be non-null
4. If broken:    npx tsx scripts/restore-store.ts projects < backups/projects-{timestamp}.json
```

---

## Decision Matrix

| Signal in Prompt | Mode | Reasoning |
|-----------------|------|-----------|
| "Explain how X works" | Conceptual | Seeking understanding |
| "Set up X" | Actionable | Seeking implementation |
| "What are the trade-offs of X vs Y?" | Conceptual | Comparing options |
| "Add X to the project" | Actionable | Seeking implementation |
| "How does our auth flow work?" | Conceptual | Seeking understanding of existing system |
| "Fix the auth flow" | Actionable | Seeking implementation |
| "Help me think through..." | Conceptual | Brainstorming |
| "Create a..." | Actionable | Seeking implementation |
| "What should we consider for..." | Conceptual | Planning/decision-making |
| "Implement..." | Actionable | Seeking implementation |

When in doubt, default to actionable and include a brief conceptual lead-in.

---

## Stack-Specific Overrides

Customize what "actionable" means for your stack. Override these defaults to match your project:

```
<!-- Uncomment and edit the lines relevant to your stack -->

<!-- Database output format: -->
<!-- Actionable database output means: Netlify Blobs storage module, not SQL -->

<!-- API output format: -->
<!-- Actionable API output means: Netlify Functions v2 handler, not Express routes -->

<!-- Styling output format: -->
<!-- Actionable styling output means: Tailwind utility classes, not CSS files -->

<!-- Component output format: -->
<!-- Actionable component output means: React function component with TypeScript props interface -->

<!-- Infrastructure output format: -->
<!-- Actionable infra output means: netlify.toml config, not Terraform/Docker -->

<!-- Test output format: -->
<!-- Actionable test output means: Vitest test file, not Jest -->

<!-- Command runner: -->
<!-- Actionable commands use: npm, not yarn or pnpm -->
```
