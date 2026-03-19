# Learning AI Backend — A Frontend Developer's Guide

> Grounded in the buffr, poselab, and contrl codebases. Every concept maps to real code you can read and modify.
> Last updated: 2026-03-18

---

## Table of Contents

1. [Backend Architecture Concepts](#1-backend-architecture-concepts)
2. [AI / ML Fundamentals](#2-ai--ml-fundamentals)
3. [MediaPipe & On-Device ML](#3-mediapipe--on-device-ml)
4. [Industry Context](#4-industry-context)
5. [Architecture Reference](#5-architecture-reference)

---

## 1. Backend Architecture Concepts

### 1.1 Request/Response Lifecycle

Every HTTP interaction follows the same pattern you already know from `fetch()` — but on the backend, you're writing the *other side*.

```
┌──────────┐    HTTP Request     ┌───────────────────┐    Storage     ┌──────────────┐
│  Browser  │ ──────────────────▶│  Netlify Function  │ ────────────▶ │ Netlify Blobs│
│ (Next.js) │                    │   (handler fn)     │               │  (KV store)  │
│           │ ◀──────────────────│                    │ ◀──────────── │              │
└──────────┘    HTTP Response    └───────────────────┘               └──────────────┘
```

**How buffr does it**: Every backend handler in `netlify/functions/` follows this shape:

```typescript
// netlify/functions/sessions.ts
export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);

  if (req.method === "GET") {
    // Read from storage, return JSON
    return json(data);
  }

  if (req.method === "POST") {
    const body = await req.json();
    // Write to storage, return created resource
    return json(saved, 201);
  }

  return errorResponse("Method not allowed", 405);
}
```

The `Request` object is the same Web API `Request` you use in the browser. That's the key insight — serverless functions use standard web platform APIs, not some foreign runtime.

**Response helpers** (`netlify/functions/lib/responses.ts`) wrap the raw `Response` constructor:

```typescript
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

**buffr's 13 serverless functions** — each one is a self-contained handler:

| Function | Purpose | Methods |
|----------|---------|---------|
| `projects.ts` | Project CRUD | GET, POST, PUT, DELETE |
| `sessions.ts` | Session history | GET, POST, DELETE |
| `prompts.ts` | Prompt library CRUD | GET, POST, PUT, DELETE |
| `dev-items.ts` | .dev files + push to GitHub | GET, POST, PUT, DELETE, POST?push |
| `manual-actions.ts` | Task list with reordering | GET, POST, PUT, PATCH, DELETE |
| `action-notes.ts` | Notes on action items | GET, PUT |
| `session-ai.ts` | LLM chains (4 sub-actions) | POST?summarize/intent/suggest/paraphrase |
| `run-prompt.ts` | Resolve + run user prompts | POST |
| `tools.ts` | Tool execution gateway | GET, POST?execute |
| `providers.ts` | LLM provider config | GET, PUT |
| `auth-check.ts` | Auth verification | GET |
| `login.ts` / `logout.ts` | Authentication | POST |

### 1.2 REST vs WebSocket vs Streaming

**REST** (what buffr uses): Stateless request-response. Client sends a request, server returns a complete response. Every request is independent.

```
Client: POST /sessions  {goal: "Add auth"}
Server: 201  {id: "abc", goal: "Add auth", ...}

Client: GET /sessions?projectId=xyz
Server: 200  [{id: "abc", ...}, {id: "def", ...}]
```

**WebSocket**: Persistent connection. Both sides can send messages at any time. Useful for real-time features (chat, live collaboration). buffr doesn't use this.

**Streaming**: The server sends data in chunks. The LLM providers support streaming — tokens arrive one at a time instead of waiting for the full response. buffr currently waits for the full response, but switching to streaming would make the AI feel faster.

```
Without streaming:  [wait 3 seconds...] "Here is your complete summary."
With streaming:     "Here" → "is" → "your" → "complete" → "summary."
```

> **What to explore next**
> - Read the [MDN Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API) docs
> - Try adding streaming to the `session-summarizer` chain — LangChain supports `.stream()` on all models
> - Look at how Vercel AI SDK handles streaming in Next.js: `useChat()` hook

### 1.3 Serverless vs Edge vs Traditional Server

```
┌─────────────────────────────────────────────────────────┐
│                    Traditional Server                    │
│  Boot once → handle req 1 → req 2 → req 3 → ...        │
│  Always running. You pay for idle time.                  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                      Serverless                          │
│  Request arrives → cold start → handle → shut down       │
│  Request arrives → cold start → handle → shut down       │
│  Only runs (and charges) when invoked.                   │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                     Edge Functions                        │
│  Like serverless, but deployed to 200+ locations.        │
│  Runs close to the user. Limited runtime (no Node.js).   │
└─────────────────────────────────────────────────────────┘
```

**In buffr**: Every file in `netlify/functions/` is a serverless function. They share no in-memory state between invocations.

**The tradeoff**: Serverless functions have "cold starts" (first request is slow). They can't hold persistent connections (WebSockets). But they scale to zero cost when idle, and to thousands of concurrent requests when busy.

### 1.4 State Management on the Server Side

On the frontend, state lives in React hooks. On the backend, there's no component tree — state must be stored explicitly.

**Netlify Blobs** (buffr's storage): A key-value store. Think of it as `localStorage` but for the server.

```typescript
// netlify/functions/lib/storage/dev-items.ts
import { getStore } from "@netlify/blobs";

const STORE_NAME = "dev-items";
function store() { return getStore(STORE_NAME); }

// CRUD operations — identical mental model to localStorage
export async function getDevItem(id: string) {
  const data = await store().get(id, { type: "text" });
  return data ? JSON.parse(data) : null;
}

export async function saveDevItem(item: DevItem) {
  await store().set(item.id, JSON.stringify(item));
  return item;
}

export async function listDevItems() {
  const { blobs } = await store().list();
  // Fetch each blob individually — there's no "SELECT * FROM" here
  const items = [];
  for (const blob of blobs) {
    const data = await store().get(blob.key, { type: "text" });
    if (data) items.push(JSON.parse(data));
  }
  return items;
}
```

**buffr uses 8 Blob stores** — each one is a separate namespace:

| Store | Key strategy | What's stored |
|-------|-------------|---------------|
| `projects` | One blob per project | Project metadata, settings |
| `sessions` | One blob per session | Goal, what changed, blockers, AI summary |
| `prompt-library` | One blob per prompt | Title, body, tags, scope |
| `dev-items` | One blob per dev item | AI rules, skills, community skills |
| `manual-actions` | One blob per project (array) | Task list for a project |
| `action-notes` | One blob per project (record) | Notes keyed by action ID |
| `tool-config` | One blob per integration | GitHub/Notion credentials |
| `settings` | Single blob | App-wide settings |

Two storage patterns emerge:

1. **One-blob-per-record** (prompts, dev-items, sessions): Each item is its own blob. Listing requires fetching all blobs. Good for items that are created/edited independently.

2. **One-blob-per-project** (manual-actions, action-notes): All items for a project in one blob (as a JSON array or record). Faster to list, but concurrent writes can conflict.

**The hierarchy of server state** (simplest to most complex):

| Storage | Example | When to use |
|---------|---------|-------------|
| KV store (Blobs) | Netlify Blobs, Vercel KV | Small JSON objects, config, user data |
| Document DB | MongoDB, Firestore | Nested objects, flexible schema |
| Relational DB | PostgreSQL, MySQL | Complex queries, joins, transactions |
| Vector DB | Pinecone, pgvector | Semantic search, embeddings, RAG |
| File storage | S3, R2, Blobs (binary) | Images, PDFs, large assets |

> **What to explore next**
> - Compare `netlify/functions/lib/storage/manual-actions.ts` (array-per-project) with `prompts.ts` (blob-per-record)
> - Think about when you'd outgrow Blobs — if you needed to query "all sessions across all projects from last week", a database would be better

### 1.5 API Design Patterns

**REST** (what buffr uses): Resources at URLs, HTTP methods for actions.

```
GET    /sessions?projectId=xyz     → list sessions for a project
POST   /sessions                   → create a session
DELETE /sessions?id=abc            → delete a session
```

**Sub-actions via query params** — buffr uses this pattern when a single endpoint handles multiple related operations:

```
POST /session-ai?summarize     → summarize session activity
POST /session-ai?intent        → detect what the user was working on
POST /session-ai?suggest       → suggest next step
POST /session-ai?paraphrase    → rewrite text more clearly

POST /dev-items?push           → compile and push to GitHub repo
```

This is a pragmatic hybrid between REST and RPC. buffr uses query params as the discriminator — it's the simplest approach for serverless.

**The client mirrors the backend 1:1** — every endpoint has a typed function in `src/lib/api.ts`:

```typescript
// One generic request helper with error handling
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...options, headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Each endpoint is a typed wrapper
export async function listDevItems(scope?: string): Promise<DevItem[]> {
  const q = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  return request<DevItem[]>(`/dev-items${q}`);
}

export async function pushDevItems(projectId: string, repo: string, adapterIds?: string[]): Promise<{ sha: string }> {
  return request<{ sha: string }>("/dev-items?push", {
    method: "POST",
    body: JSON.stringify({ projectId, repo, adapterIds }),
  });
}
```

| Pattern | Best for | buffr example |
|---------|----------|---------------|
| REST | CRUD resources | `/sessions`, `/projects`, `/prompts`, `/dev-items` |
| RPC-style | Actions, commands | `/session-ai?summarize`, `/dev-items?push` |
| GraphQL | Complex queries, mobile apps | Not used (would add unnecessary complexity) |

### 1.6 Git-as-Deployment: The Push-to-Repo Pattern

buffr's .dev tab demonstrates a pattern where **the app manages files that live in a Git repository**. The user creates AI rules and skills in the UI, and the app commits them directly via GitHub's API.

```
┌──────────┐   CRUD    ┌──────────────┐   Persist    ┌──────────────┐
│  .dev tab │ ────────▶│  dev-items.ts │ ──────────▶ │ Netlify Blobs│
│  (React)  │          │  (function)   │              │  (source of  │
│           │          │               │              │   truth)     │
└──────────┘          └──────┬───────┘              └──────────────┘
                              │
                    POST ?push│
                              │
                     ┌────────▼────────┐
                     │  Build Files     │
                     │                  │
                     │ 1. Raw .dev/ files│
                     │ 2. Adapter files │
                     │    (compiled)     │
                     └────────┬────────┘
                              │
              ┌───────────────▼───────────────┐
              │     GitHub Trees API            │
              │                                │
              │ 1. Get HEAD commit SHA          │
              │ 2. Create blobs (file contents) │
              │ 3. Create tree (file paths)     │
              │ 4. Create commit (with parent)  │
              │ 5. Update ref (move main)       │
              └───────────────────────────────┘
```

**The adapter compilation step** is key — raw dev items are combined into tool-specific config files:

```typescript
// netlify/functions/dev-items.ts — buildAdapterContent()
// All your ai-rules + skills get compiled into one file per tool:
//
// .dev/ai-rules/strict-types.md  ─┐
// .dev/ai-rules/no-any.md        ─┤
// .dev/skills/code-review.md     ─┼──▶ CLAUDE.md (for Claude Code)
// .dev/skills/refactor.md        ─┤    .cursorrules (for Cursor)
// .dev/community-skills/audit.md ─┘    copilot-instructions.md (for Copilot)
//                                      .windsurfrules (for Windsurf)
//                                      .aider.conf.yml (for Aider)
//                                      .continuerules (for Continue)
```

Six adapters are supported. Each formats the combined content for its target tool.

> **What to explore next**
> - Read `netlify/functions/dev-items.ts` — trace the full `?push` flow from item list to git commit
> - Read `netlify/functions/lib/github.ts` `pushFiles()` — the low-level Git Trees API calls
> - Try adding a new adapter (e.g., for Cody, Tabnine, or a custom format)

---

## 2. AI / ML Fundamentals

### 2.1 How Inference Works

"Inference" just means "asking a trained model to do its thing." The model already learned its patterns during training. You're just giving it input and getting output.

```
┌──────────┐     ┌─────────────┐     ┌──────────┐
│   Input   │────▶│    Model    │────▶│  Output   │
│ (prompt)  │     │  (weights)  │     │  (text)   │
└──────────┘     └─────────────┘     └──────────┘
```

**For LLMs** (buffr): Input is text (a prompt). The model predicts the next token, one at a time, until it's done. The model runs on someone else's GPU (Anthropic's, OpenAI's, Google's).

**For pose estimation** (poselab/contrl): Input is a video frame (pixel data). The model outputs 33 landmark coordinates. The model runs on YOUR device's GPU via WebAssembly.

```
LLM Inference (buffr):
┌──────────────┐  HTTP   ┌──────────────┐  GPU   ┌──────────────┐
│  Your browser │ ──────▶│ Claude API   │ ─────▶│  Claude Model │
│  sends prompt │        │ (Anthropic)  │        │  (their GPU)  │
└──────────────┘        └──────────────┘        └──────────────┘

On-Device Inference (poselab):
┌──────────────┐  WASM   ┌──────────────┐  WebGL  ┌──────────────┐
│  Camera frame │ ──────▶│  MediaPipe   │ ──────▶│  TFLite Model │
│  (pixels)     │        │  (in browser)│        │  (your GPU)   │
└──────────────┘        └──────────────┘        └──────────────┘
```

### 2.2 Tokens, Embeddings, Vector Search

**Tokens**: LLMs don't read words — they read tokens. A token is roughly 3/4 of a word. "Understanding" → ["Under", "standing"]. You pay per token (input + output).

Why it matters: When buffr sends a prompt to Claude, the cost and latency scale with token count. The `resolve-prompt.ts` template system keeps prompts compact:

```typescript
// src/lib/resolve-prompt.ts — variables are replaced BEFORE sending to the LLM
// "Build {{project.name}} with {{project.stack}}" → "Build MyApp with Next.js"
// This is cheaper than sending the entire project object
```

**Embeddings**: A way to convert text into a list of numbers (a vector) that captures meaning. "Happy" and "joyful" would have similar vectors. "Happy" and "refrigerator" would not.

```
"How do I deploy?"  → [0.12, -0.34, 0.56, 0.78, ...]  (1536 numbers)
"Deploy my app"     → [0.11, -0.33, 0.55, 0.79, ...]  (similar!)
"Best pizza recipe" → [0.89, 0.12, -0.67, 0.01, ...]  (very different)
```

**Vector search**: Store embeddings in a database. When a user asks a question, convert it to a vector, then find the most similar stored vectors. This is the core of **RAG** (Retrieval-Augmented Generation) — feed relevant context to the LLM.

buffr doesn't use embeddings yet, but if you wanted to add "search my past sessions for relevant context," you'd embed each session summary, store the vectors, and search them.

> **What to explore next**
> - Count tokens in a prompt using [Anthropic's tokenizer](https://docs.anthropic.com/en/docs/build-with-claude/token-counting)
> - Experiment with OpenAI's embedding API — embed a few sentences and compute cosine similarity
> - Read about RAG: retrieve relevant documents, stuff them into the prompt, then ask the LLM

### 2.3 Client-Side vs Server-Side AI Tradeoffs

buffr makes LLM calls from the server. poselab runs ML in the browser. Here's why:

| Factor | Server-side (buffr LLM) | Client-side (poselab pose) |
|--------|------------------------|---------------------------|
| **Latency** | Network round-trip (1-5s) | Instant (~30ms per frame) |
| **Privacy** | Data sent to API provider | Data never leaves device |
| **Cost** | Per-token API pricing | Free after model download |
| **Model size** | Huge (100B+ params) | Small (<25MB for lite) |
| **Capability** | Complex reasoning, generation | Perception, classification |
| **Offline** | Requires internet | Works offline after load |

**The hybrid pattern** (what these apps demonstrate): Use server-side AI for complex reasoning (summarization, suggestion, intent detection). Use client-side AI for real-time perception (pose detection, gesture recognition).

### 2.4 LLM Tool Calling, Function Routing, and Orchestration

"Tool calling" means the LLM can request to execute external functions. Instead of just generating text, it says "I need to call `github_list_issues` with these parameters."

**buffr's tool system** has three layers:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Tool Registry                                      │
│  netlify/functions/lib/tools/registry.ts                     │
│                                                              │
│  tools.set("github_list_issues", {                           │
│    name, description, inputSchema, execute()                 │
│  })                                                          │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Tool Resolution (in prompts)                       │
│  netlify/functions/lib/resolve-tools.ts                      │
│                                                              │
│  "Issues: {{tool:github_list_issues}}"                       │
│        ↓ resolve                                             │
│  "Issues: #42 Fix login, #43 Add tests"                     │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: LLM Orchestration                                  │
│  netlify/functions/lib/ai/chains/prompt-chain.ts             │
│                                                              │
│  Prompt → resolve variables → resolve tools → send to LLM    │
│  LLM response → parse JSON → extract suggestedActions        │
└─────────────────────────────────────────────────────────────┘
```

**Registration pattern** — tools declare their interface upfront (JSON Schema):

```typescript
// netlify/functions/lib/tools/github.ts
registerTool({
  name: "github_list_issues",
  description: "List open issues for a repository",
  integrationId: "github",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      limit: { type: "number" },
    },
    required: ["owner", "repo"],
  },
  execute: async (input) => {
    return getIssues(input.owner, input.repo, input.limit);
  },
});
```

**Template tokens** — prompts reference tools with `{{tool:name}}` syntax:

```typescript
// netlify/functions/lib/resolve-tools.ts
// Regex: /\{\{tool:(\w+)(?::([^}]+))?\}\}/g
// "{{tool:github_list_issues}}" → calls the tool → replaces with result
// "{{tool:github_list_issues:{"owner":"me","repo":"app"}}}" → with params
```

**The execution flow** when a user runs a prompt:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ User clicks  │────▶│  Resolve     │────▶│  Resolve     │
│ "Run Prompt" │     │  variables   │     │  tool tokens │
└──────────────┘     │ {{project.*}}│     │ {{tool:*}}   │
                     └──────────────┘     └──────┬───────┘
                                                  │
                     ┌──────────────┐     ┌──────▼───────┐
                     │  Parse JSON  │◀────│  Send to LLM │
                     │  response    │     │  (Claude)    │
                     └──────┬───────┘     └──────────────┘
                            │
                     ┌──────▼───────┐
                     │ Return:       │
                     │ • text        │
                     │ • actions[]   │
                     │ • artifact    │
                     └──────────────┘
```

### 2.5 LLM Chain Patterns

A "chain" is a multi-step process where each step transforms data before or after calling the LLM. buffr uses LangChain's `RunnableSequence` for this.

**The common pattern across all 5 chains**:

```typescript
// Every chain in netlify/functions/lib/ai/chains/ follows this structure:
const chain = RunnableSequence.from([
  // Step 1: Build the prompt and call the LLM
  async (input) => {
    const response = await llm.invoke([
      new SystemMessage("You are a helpful assistant..."),
      new HumanMessage(`Given: ${input.data}\n\nRespond in JSON...`),
    ]);
    return response.content as string;
  },
  // Step 2: Parse the response
  (raw: string) => {
    const cleaned = stripCodeBlock(raw);  // Remove ```json wrappers
    return JSON.parse(cleaned);
  },
]);

const result = await chain.invoke({ data: "..." });
```

**buffr's 5 chains**:

| Chain | File | Input | Output | Purpose |
|-------|------|-------|--------|---------|
| `session-summarizer` | `session-summarizer.ts` | Activity items | `{goal, bullets[]}` | Summarize what happened in a session |
| `intent-detector` | `intent-detector.ts` | Goal + changes + phase | 2-5 word intent | Detect what user was doing |
| `next-step-suggester` | `next-step-suggester.ts` | Full context | Single suggestion | Recommend what to do next |
| `paraphraser` | `paraphraser.ts` | Raw text | Cleaner text | Rewrite task descriptions |
| `prompt-chain` | `prompt-chain.ts` | Resolved prompt | `{text, actions[], artifact}` | Run user prompts with tool output |

**How chains are routed** — the `session-ai.ts` handler dispatches to the right chain based on query params:

```typescript
// netlify/functions/session-ai.ts — a single endpoint, 4 AI operations
if (url.searchParams.has("summarize"))  → sessionSummarizerChain.invoke(...)
if (url.searchParams.has("intent"))     → intentDetectorChain.invoke(...)
if (url.searchParams.has("suggest"))    → nextStepSuggesterChain.invoke(...)
if (url.searchParams.has("paraphrase")) → paraphraserChain.invoke(...)
```

### 2.6 Multi-Provider LLM Architecture

buffr supports four LLM providers through a single abstraction:

```typescript
// netlify/functions/lib/ai/provider.ts
export function getLLM(provider?: string): BaseChatModel {
  switch (provider) {
    case "anthropic":
      return new ChatAnthropic({ model: "claude-sonnet-4-20250514", temperature: 0.7 });
    case "openai":
      return new ChatOpenAI({ model: "gpt-4o", temperature: 0.7 });
    case "google":
      return new ChatGoogleGenerativeAI({ model: "gemini-1.5-pro", temperature: 0.7 });
    case "ollama":
      return new ChatOllama({ model: "llama3", temperature: 0.7 });
    default:
      return new ChatAnthropic({ ... });  // Anthropic is the default
  }
}
```

All chains call `getLLM()` and don't care which provider is behind it. The LangChain `BaseChatModel` interface unifies them — same `.invoke()` method, same message format.

```
┌─────────────────────────────────────────────────────────┐
│              getLLM(provider)                             │
│                                                          │
│  ┌───────────┐  ┌──────────┐  ┌────────┐  ┌──────────┐ │
│  │ Anthropic │  │  OpenAI  │  │ Google │  │  Ollama  │ │
│  │ Claude    │  │  GPT-4o  │  │ Gemini │  │  Llama3  │ │
│  │ Sonnet 4  │  │          │  │ 1.5Pro │  │ (local)  │ │
│  └─────┬─────┘  └────┬─────┘  └───┬────┘  └────┬─────┘ │
│        └──────────────┴────────────┴─────────────┘       │
│                       │                                   │
│              BaseChatModel                                │
│              .invoke([messages])                          │
│              .stream([messages])                          │
└─────────────────────────────────────────────────────────┘
```

The frontend provider switcher (`src/context/provider-context.tsx`) lets users pick their provider. The choice is passed through the API to the backend chains.

### 2.7 Prompt Engineering as Product Engineering

Prompt engineering isn't about magic phrases — it's about **structuring input so the model produces reliable, parseable output**.

**Patterns from buffr's chains**:

1. **System message sets the role and format**:
```
You are a session summarizer. Given a list of activity items,
return a JSON object with: goal (string), bullets (string[]).
```

2. **Structured output via JSON**:
All chains ask for JSON and parse it. This makes LLM output programmatically useful — not just readable text.

3. **Fallback handling** (`parse-utils.ts`):
```typescript
export function stripCodeBlock(raw: string): string {
  // LLMs often wrap JSON in ```json ... ``` — strip it
  return raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}
```

4. **Context injection** — the `prompt-chain` resolves `{{tool:*}}` tokens before sending to the LLM. The LLM sees the actual data, not the template.

5. **Variable resolution** — `resolve-prompt.ts` replaces `{{project.name}}`, `{{lastSession.goal}}` etc. with real values. Unknown variables become empty strings (graceful degradation).

> **What to explore next**
> - Read each chain file in `netlify/functions/lib/ai/chains/` — compare how they structure their system messages
> - Try modifying `next-step-suggester.ts` to return 3 suggestions instead of 1
> - Read Anthropic's [prompt engineering guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering)

---

## 3. MediaPipe & On-Device ML

### 3.1 What MediaPipe Is

MediaPipe is Google's framework for running pre-trained ML models directly in the browser (or on mobile). No server, no API key, no network — the model runs on the user's device via WebAssembly + WebGL.

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Browser                             │
│                                                              │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────┐  │
│  │  Camera   │───▶│ MediaPipe    │───▶│  33 Landmarks     │  │
│  │  (video)  │    │ WASM + WebGL │    │  (x,y,z per point)│  │
│  └──────────┘    └──────────────┘    └───────────────────┘  │
│                                                              │
│  No network. No API key. ~30ms per frame.                    │
└─────────────────────────────────────────────────────────────┘
```

**The ML stack for the browser**:

| Layer | Technology | Role |
|-------|-----------|------|
| Model format | TFLite (TensorFlow Lite) | Optimized model weights |
| Runtime | WASM (WebAssembly) | CPU fallback, cross-browser |
| Acceleration | WebGL / WebGPU | GPU inference in browser |
| Framework | MediaPipe Tasks API | High-level pose/hand/face detection |
| Your code | TypeScript + React | Consume landmarks, render UI |

### 3.2 The Pose Estimation Pipeline

**poselab** implements a full multi-detector pipeline. **contrl** uses a streamlined version for fitness tracking.

```
Camera → Video Element → PoseLandmarker → 33 Landmarks → Angles/Distances → Canvas Overlay
  │                           │                 │                │              │
  │  getUserMedia()           │  detectForVideo()│  x,y,z per    │  Math        │  drawImage()
  │  useCamera hook           │  pose-detector.ts│  landmark      │  angles.ts   │  useOverlay
  │                           │                 │                │              │  Renderer
  ▼                           ▼                 ▼                ▼              ▼
 720p                      ~30ms            NormalizedLandmark  Degrees       Skeleton
 stream                    per frame        {x:0-1, y:0-1,     + distances   drawn on
                                             z, visibility}                   canvas
```

**Step 1: Load the model** (happens once)

```typescript
// poselab: src/lib/mediapipe/vision-runtime.ts
// Singleton pattern — shared WASM fileset, cached so multiple detectors reuse it
let cachedFileset: VisionFileset | null = null;
let loadingPromise: Promise<VisionFileset> | null = null;

export async function getVisionFileset(): Promise<VisionFileset> {
  if (cachedFileset) return cachedFileset;
  if (loadingPromise) return loadingPromise;  // Coalesce concurrent loads
  loadingPromise = FilesetResolver.forVisionTasks(WASM_CDN).then(fileset => {
    cachedFileset = fileset;
    return fileset;
  });
  return loadingPromise;
}
```

**Step 2: Initialize the detector**

```typescript
// poselab: src/lib/mediapipe/pose-detector.ts
this.landmarker = await PoseLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath: MODEL_URLS[variant],  // lite (3MB), full (6MB), or heavy (25MB)
    delegate: "GPU",                       // Use WebGL for inference
  },
  runningMode: "VIDEO",
  numPoses: 1,
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
});
```

**Step 3: Run inference every frame**

```typescript
// poselab: src/lib/hooks/useDetectionLoop.ts
// requestAnimationFrame polling with frame skipping
function loop() {
  if (video.currentTime !== lastTime) {  // New frame available
    frameCount++;
    for (const fn of processors.every)  fn();           // Every frame: pose
    if (frameCount % 2 === 0) for (const fn of processors.even)  fn();  // Every 2nd: face
    if (frameCount % 3 === 0) for (const fn of processors.third) fn();  // Every 3rd: segmentation
  }
  requestAnimationFrame(loop);
}
```

**Step 4: Process the output**

The model returns 33 landmarks — one for each body point:

```
Landmark indices (MediaPipe Pose):

        0 (nose)
       / \
   7,8     9,10 (ears)
  11─────────12 (shoulders)
  │           │
  13         14 (elbows)
  │           │
  15         16 (wrists)
  │           │
  23─────────24 (hips)
  │           │
  25         26 (knees)
  │           │
  27         28 (ankles)
  │           │
  29         30 (heels)
  │           │
  31         32 (toes)
```

Each landmark: `{ x: 0-1, y: 0-1, z: depth, visibility: 0-1 }`

**poselab detectors** — 5 models run on staggered frames:

| Detector | Model | Landmarks | Frame cadence |
|----------|-------|-----------|---------------|
| Pose | `pose_landmarker` (lite/full/heavy) | 33 body points | Every frame |
| Face | `face_landmarker` (with blendshapes) | 468 mesh points | Every 2nd frame |
| Hand | `hand_landmarker` | 21 per hand (×2) | Every 2nd frame |
| Gesture | `gesture_recognizer` | Gesture classification | Every 2nd frame |
| Segmentation | `selfie_segmenter` | Per-pixel mask | Every 3rd frame |

### 3.3 Joint Angle Calculation

**contrl** uses landmark positions to calculate joint angles for exercise tracking:

```typescript
// contrl: src/lib/pose/angles.ts
export function calculateAngle(a: Landmark, b: Landmark, c: Landmark): number {
  // b is the joint (vertex of the angle)
  // a and c are the connected body parts
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };
  const dot = ba.x * bc.x + ba.y * bc.y;
  const cosAngle = dot / (magnitude(ba) * magnitude(bc));
  return Math.acos(cosAngle) * (180 / Math.PI);  // Radians → degrees
}
```

**Smoothing** prevents jitter from frame-to-frame noise:

```typescript
// Exponential moving average — smoothingFactor (0-1) controls responsiveness
export function smoothAngle(current: number, previous: number, factor: number): number {
  return previous + factor * (current - previous);
}
// factor=0.3: very smooth, slow to react
// factor=0.8: responsive, some jitter
```

**Bilateral averaging** — average left and right sides for robust angle readings:

```typescript
export function averageLandmarks(a: Landmark, b: Landmark): Landmark {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2, visibility: Math.min(a.visibility, b.visibility) };
}
```

### 3.4 Rep Counting State Machine

**contrl** counts exercise reps using a finite state machine driven by joint angles:

```
                    angle >= ready
        ┌──────────────────────────────┐
        │                              │
        ▼                              │
     ┌──────┐  angle < ready  ┌──────┐ │
     │ READY│────────────────▶│ DOWN │ │
     └──────┘                 └──┬───┘ │
                                 │      │
                    angle <= bottom     │
                                 │      │
                              ┌──▼───┐  │
                              │BOTTOM│  │
                              └──┬───┘  │
                                 │      │
                    angle > bottom      │
                                 │      │
                              ┌──▼───┐  │
                              │  UP  │──┘  ← rep counted here
                              └──────┘
```

```typescript
// contrl: src/lib/pose/rep-counter.ts
// Generic state machine — works for any exercise
interface RepCounterConfig {
  readyAngle: number;    // e.g., 160° (standing straight)
  bottomAngle: number;   // e.g., 90° (full squat depth)
  hysteresis: number;    // e.g., 10° (prevents false triggers)
}

// Exercise-specific wrappers:
// squat.ts:  readyAngle=160, bottomAngle=90, hysteresis=10, smoothing=0.4
//            angle = average(left knee, right knee)
// pushup.ts: same thresholds, angle = average(left elbow, right elbow)
// plank.ts:  different thresholds for hold detection
```

The state machine runs every frame (~33ms at 30fps). Joint angles drive the transitions. Each `up → ready` transition increments the rep counter. **Hysteresis** prevents false triggers — the angle must cross the threshold by a margin before the state changes.

### 3.5 Real-Time Rendering Pipeline

**poselab** renders 8 layers on a single canvas:

```
Drawing order (back to front):

1. Segmentation mask   ← Float32Array → ImageData → drawImage
2. Face mesh           ← 468 landmarks tessellated into triangles
3. Face contours       ← eyes, lips, face oval with distinct colors
4. Hand skeleton       ← 21 landmarks × 2 hands, connected
5. Pose skeleton       ← 33 landmarks + connections (visibility > 0.3)
6. Angle arcs          ← drawn at joint vertices with degree labels
7. Distance lines      ← dashed lines with measurements
8. Landmark IDs        ← text overlay showing point indices
```

**Coordinate transform**: Model outputs normalized coords (0-1). Canvas needs pixels:

```typescript
function toPixel(lm: NormalizedLandmark, w: number, h: number) {
  return { x: lm.x * w, y: lm.y * h };
}
```

**contrl's simplified renderer** — only draws pose skeleton with visibility filtering:

```typescript
// Only draw connections where both landmarks are visible
if (a.visibility > 0.6 && b.visibility > 0.6) {
  ctx.beginPath();
  ctx.moveTo(a.x * w, a.y * h);
  ctx.lineTo(b.x * w, b.y * h);
  ctx.stroke();
}
```

### 3.6 On-Device vs Cloud Inference

| Factor | On-Device (MediaPipe) | Cloud (LLM API) |
|--------|----------------------|-----------------|
| **Latency** | ~30ms (real-time) | 1-5s (network + inference) |
| **Privacy** | Data stays on device | Data sent to provider |
| **Cost** | Free (user's hardware) | Per-token pricing |
| **Model size** | 3-25MB | 100GB+ (hosted by provider) |
| **Offline** | Works after initial load | Requires internet |
| **Capability** | Perception (see, hear) | Reasoning (think, write) |
| **Updates** | New model = new download | Provider updates transparently |

**When to use each**:
- Real-time perception (camera, audio, gesture) → **on-device**
- Complex reasoning, generation, summarization → **cloud API**
- Privacy-sensitive data → **on-device** (or self-hosted with Ollama)
- Prototype/experiment → **cloud API** (faster to iterate)

> **What to explore next**
> - Run poselab and open Chrome DevTools → Performance tab to see the inference loop
> - Try switching between lite/full/heavy models and measure FPS difference
> - Read [MediaPipe Tasks Vision API docs](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
> - Look at TensorFlow.js for running custom models in the browser

---

## 4. Industry Context

### 4.1 What "AI Product Engineer" Means

The job market is shifting. "Frontend engineer" and "backend engineer" are merging with "ML engineer" into a new role: **AI product engineer** — someone who can build complete products that use AI as a core feature, not just a bolt-on.

```
Traditional roles:                  Emerging role:

┌────────────┐  ┌────────────┐     ┌─────────────────────────┐
│  Frontend   │  │  Backend   │     │  AI Product Engineer     │
│  Engineer   │  │  Engineer  │     │                          │
│             │  │            │     │  • UI/UX (React, etc.)   │
│  HTML/CSS   │  │  APIs      │     │  • API design            │
│  React      │  │  DBs       │     │  • LLM integration       │
│  State mgmt │  │  Auth      │     │  • Prompt engineering    │
└────────────┘  └────────────┘     │  • On-device ML          │
                                    │  • Evaluation & testing  │
┌────────────┐                     │  • Product thinking      │
│  ML         │                     └─────────────────────────┘
│  Engineer   │
│             │
│  Python     │
│  PyTorch    │
│  Training   │
└────────────┘
```

**What this means for you**: You don't need to train models or write Python. You need to know how to **use** models effectively — call APIs, structure prompts, handle streaming responses, run on-device inference, and build UIs that make AI useful.

### 4.2 Skills That Bridge Frontend and AI

**You already have** (from frontend experience):
- TypeScript fluency (all AI SDKs have TS clients)
- Async programming (API calls, streaming, real-time loops)
- State management (critical for AI UI: loading states, streaming text, error handling)
- UI/UX intuition (AI features need great UX to feel natural)

**You need to add**:

| Skill | Why | How these codebases teach it |
|-------|-----|------|
| LLM API integration | Core of most AI products | buffr's multi-provider chain system |
| Prompt engineering | Makes LLMs reliable | buffr's 5 chain templates and structured JSON output |
| Tool calling / function routing | LLMs need to interact with systems | buffr's tool registry + resolve-tools |
| Adapter compilation | Ship AI rules across tools | buffr's .dev tab push with 6 adapter formats |
| On-device ML | Real-time features | poselab's 5 MediaPipe detectors |
| State machines for ML output | Turn raw predictions into features | contrl's rep counter |
| Evaluation | How to know if AI output is good | Compare chain outputs across buffr's 4 providers |
| RAG (retrieval) | Give LLMs context from your data | Not in buffr yet — great next project |

### 4.3 Tools and Frameworks Worth Knowing

**LLM Integration**:

| Tool | What it does | Complexity | Used here? |
|------|-------------|------------|------------|
| **LangChain** | Multi-provider chains, tool calling, memory | High | buffr — all AI chains |
| **Vercel AI SDK** | Streaming, React hooks for AI | Low | No — would simplify streaming |
| **Anthropic SDK** | Direct Claude API access | Low | Via LangChain |
| **OpenAI SDK** | Direct GPT API access | Low | Via LangChain |
| **Claude Code / Agent SDK** | Build AI agents | Medium | No — worth exploring |

**On-Device ML**:

| Tool | What it does | Used here? |
|------|-------------|-----|
| **MediaPipe** | Pre-trained vision models in browser | poselab (5 detectors) + contrl (pose) |
| **TensorFlow.js** | Run/train any model in browser | No |
| **ONNX Runtime Web** | Run ONNX models in browser | No |
| **Transformers.js** | Run Hugging Face models in browser | No |

**Vector Search / RAG**:

| Tool | What it does |
|------|-------------|
| **Pinecone** | Managed vector database |
| **pgvector** | PostgreSQL extension for vectors |
| **LlamaIndex** | Data ingestion + retrieval framework |
| **Chroma** | Open-source embedding database |

**Deployment**:

| Platform | Serverless | Edge | AI-specific features |
|----------|-----------|------|---------------------|
| **Netlify** | Functions | Edge Functions | buffr uses this |
| **Vercel** | Functions | Edge Runtime | AI SDK, streaming |
| **Cloudflare** | Workers | Workers | Workers AI (on-edge inference) |
| **AWS** | Lambda | Lambda@Edge | Bedrock (managed LLMs) |

### 4.4 Your Learning Path

Based on what's in these codebases, here's a practical progression:

```
Week 1-2: Understand what's already here
├── Read every chain in netlify/functions/lib/ai/chains/
├── Trace a full request: button click → API → chain → LLM → response → UI
├── Trace the .dev push flow: create item → push button → adapter compile → git commit
├── Run poselab, observe the inference loop in DevTools Performance tab
└── Modify a chain (change output format, add a field)

Week 3-4: Add new AI features to buffr
├── Add a new chain (e.g., "code reviewer" that analyzes git diffs)
├── Add streaming to an existing chain (tokens arrive in real-time)
├── Add a new adapter to the .dev tab (for a different AI tool)
├── Experiment with different LLM providers — same prompt, different results
└── Add a "community skills" browser with installable templates

Week 5-6: Expand on-device ML
├── Add a new MediaPipe detector to poselab (hand gestures?)
├── Add a new exercise to contrl (lunges? pull-ups?)
├── Try TensorFlow.js for a custom classification task
└── Explore Transformers.js for in-browser text embeddings

Week 7-8: Build something new
├── Add RAG to buffr (embed session summaries, search for context)
├── Add voice input using Web Speech API + LLM
├── Deploy an edge AI function on Cloudflare Workers AI
└── Build a prototype that combines on-device + cloud AI

Ongoing:
├── Read Anthropic's docs on tool use and function calling
├── Follow AI engineering blogs (Simon Willison, Lilian Weng, Latent Space)
├── Build small projects that combine frontend + AI
└── Contribute to open-source AI tools
```

> **What to explore next**
> - [Anthropic Cookbook](https://github.com/anthropics/anthropic-cookbook) — practical examples of Claude integration
> - [Vercel AI SDK docs](https://sdk.vercel.ai/docs) — the simplest way to add streaming AI to Next.js
> - [MediaPipe Solutions Guide](https://ai.google.dev/edge/mediapipe/solutions/guide) — all available on-device models
> - [LangChain.js docs](https://js.langchain.com/docs/) — deep dive into chains, agents, and tools
> - [Hugging Face Transformers.js](https://huggingface.co/docs/transformers.js) — run any HF model in the browser

---

## 5. Architecture Reference

### 5.1 buffr — Complete System Map

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend (Next.js)                         │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐  ┌──────────┐ │
│  │  Actions  │  │ Session  │  │ Prompts  │  │ .dev │  │  Tools   │ │
│  │   Tab     │  │  Tab     │  │  Tab     │  │ Tab  │  │   Tab    │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──┬───┘  └────┬─────┘ │
│       │              │              │            │            │       │
│  ┌────▼──────────────▼──────────────▼────────────▼────────────▼────┐ │
│  │                     src/lib/api.ts                               │ │
│  │         Typed fetch wrappers for every endpoint                  │ │
│  └────────────────────────────┬────────────────────────────────────┘ │
└───────────────────────────────┼──────────────────────────────────────┘
                                │  HTTP (/.netlify/functions/*)
┌───────────────────────────────▼──────────────────────────────────────┐
│                        Backend (Netlify Functions)                     │
│                                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  ┌────────────┐  │
│  │ projects.ts │  │ session-ai.ts│  │ dev-items.ts│  │  tools.ts  │  │
│  │ sessions.ts │  │              │  │             │  │            │  │
│  │ prompts.ts  │  │ 4 AI chains  │  │ CRUD + push │  │ Tool exec  │  │
│  │ manual-     │  │ via LangChain│  │ to GitHub   │  │ gateway    │  │
│  │ actions.ts  │  │              │  │ + adapters  │  │            │  │
│  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘  └──────┬─────┘ │
│         │                │                  │                 │       │
│  ┌──────▼────┐    ┌──────▼──────┐    ┌──────▼──────┐  ┌──────▼────┐ │
│  │  Netlify  │    │  LLM APIs   │    │  GitHub API │  │  GitHub/  │ │
│  │  Blobs    │    │ Claude/GPT/ │    │  Trees API  │  │  Notion   │ │
│  │ (8 stores)│    │ Gemini/Llama│    │  (push)     │  │  APIs     │ │
│  └───────────┘    └─────────────┘    └─────────────┘  └───────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 File Inventory (current as of 2026-03-18)

**Backend — 13 functions + 20 lib files**:
```
netlify/functions/
├── action-notes.ts          ← Notes on action items
├── auth-check.ts            ← Auth verification
├── dev-items.ts             ← .dev file CRUD + GitHub push + adapter compilation
├── login.ts / logout.ts     ← Authentication
├── manual-actions.ts        ← Task list CRUD + reorder
├── projects.ts              ← Project CRUD
├── prompts.ts               ← Prompt library CRUD
├── providers.ts             ← LLM provider config
├── run-prompt.ts            ← Variable + tool resolution → LLM
├── session-ai.ts            ← Dispatcher for 4 AI chains
├── sessions.ts              ← Session history CRUD
├── tools.ts                 ← Tool execution gateway
└── lib/
    ├── ai/
    │   ├── provider.ts      ← 4 LLM providers (Anthropic/OpenAI/Google/Ollama)
    │   ├── parse-utils.ts   ← JSON extraction from LLM output
    │   ├── prompts/session-prompts.ts
    │   └── chains/
    │       ├── session-summarizer.ts
    │       ├── intent-detector.ts
    │       ├── next-step-suggester.ts
    │       ├── paraphraser.ts
    │       └── prompt-chain.ts
    ├── storage/
    │   ├── projects.ts      ← Blob store: projects
    │   ├── sessions.ts      ← Blob store: sessions
    │   ├── prompts.ts       ← Blob store: prompt-library
    │   ├── dev-items.ts     ← Blob store: dev-items
    │   ├── manual-actions.ts← Blob store: manual-actions
    │   ├── action-notes.ts  ← Blob store: action-notes
    │   ├── tool-config.ts   ← Blob store: tool-config
    │   └── settings.ts      ← Blob store: settings
    ├── tools/
    │   ├── registry.ts      ← Tool Map + registerTool/executeTool
    │   ├── register-all.ts  ← Boot: register GitHub + Notion tools
    │   ├── github.ts        ← 10+ GitHub tools
    │   └── notion.ts        ← 3 Notion tools
    ├── github.ts            ← GitHub API: pushFiles, analyzeRepo, getIssues, etc.
    ├── notion.ts            ← Notion API: queryTasks, createTask, etc.
    ├── resolve-tools.ts     ← {{tool:name}} token resolution
    ├── responses.ts         ← json() and errorResponse() helpers
    ├── auth.ts              ← Auth utilities
    └── netlify-api.ts       ← Netlify platform API calls
```

**Frontend — 6 tabs + supporting lib**:
```
src/components/session/
├── resume-card.tsx          ← Main project view with tab system
├── actions-tab.tsx          ← Drag-to-reorder task list with numbering
├── session-tab.tsx          ← Last session history
├── prompts-tab.tsx          ← Prompt library with categories + AI run
├── dev-tab.tsx              ← .dev file management + adapter push
├── tools-tab.tsx            ← Integration management
├── end-session-modal.tsx    ← Session end with AI summarization
└── (+ CSS for each)

src/lib/
├── api.ts                   ← ~35 typed API functions
├── types.ts                 ← Project, Session, DevItem, Prompt, etc.
├── next-actions.ts          ← Generate suggested actions from context
├── suggestions.ts           ← Project suggestions engine
├── resolve-prompt.ts        ← {{variable}} template resolution
├── data-sources.ts          ← Tool capability mapping
├── format.ts                ← Date formatting (timeAgo)
├── constants.ts             ← Phase colors
└── prompt-utils.tsx         ← Prompt token rendering
```

---

*This document is a living reference. Update it as you learn — add notes, mark what you've explored, link to your own experiments.*
