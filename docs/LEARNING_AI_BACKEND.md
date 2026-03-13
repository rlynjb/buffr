# Learning Guide: Buffr AI & Backend System Design

A hands-on walkthrough of how Buffr's AI and backend systems work — from request to response.

---

## Prerequisites

Before reading, familiarize yourself with:
- [LangChain.js Concepts](https://js.langchain.com/docs/concepts/) — Runnables, chat models, messages
- Netlify Functions — serverless handlers that receive `Request` and return `Response`
- Netlify Blobs — key-value storage with `getStore`, `setJSON`, `get`, `list`

---

## System Overview

```mermaid
graph TB
    subgraph Frontend["Frontend · Next.js App Router"]
        UI["React Components"]
        ProvCtx["Provider Context<br/><i>selected: openai</i>"]
        API["api.ts<br/><i>HTTP client</i>"]
    end

    subgraph Backend["Backend · Netlify Functions"]
        EP["Endpoints<br/>session-ai · projects · sessions<br/>tools · prompts · generate-dev"]

        subgraph AI["AI Layer · LangChain.js"]
            Factory["getLLM(provider)"]
            Chains["Chains"]
            Factory -->|"anthropic"| Claude["Claude<br/>Sonnet 4"]
            Factory -->|"openai"| GPT["GPT-4o"]
            Factory -->|"google"| Gemini["Gemini 1.5"]
            Factory -->|"ollama"| Ollama["Llama 3"]
        end

        subgraph Storage["Storage · Netlify Blobs"]
            Projects[("projects")]
            Sessions[("sessions")]
            Scans[("scan-results")]
            Prompts[("prompts")]
            Manual[("manual-actions")]
        end

        subgraph Tools["Tool Registry"]
            GH["GitHub<br/>13 tools"]
            NO["Notion<br/>4 tools"]
        end
    end

    subgraph External["External Services"]
        GHAPI["GitHub API"]
        NOAPI["Notion API"]
    end

    UI --> API
    API -->|"POST /session-ai?summarize<br/>{ provider: 'openai' }"| EP
    EP --> Chains
    Chains --> Factory
    EP --> Storage
    EP --> Tools
    GH --> GHAPI
    NO --> NOAPI
    ProvCtx -.->|"selected"| API
```

---

## Part 1: The Provider System

**Goal**: Understand how Buffr supports multiple LLM providers behind a single interface.

### Architecture

```mermaid
sequenceDiagram
    participant UI as Provider Switcher
    participant Ctx as Provider Context
    participant LS as localStorage
    participant API as api.ts
    participant BE as session-ai.ts
    participant Fac as getLLM()
    participant LLM as LLM Provider

    Note over UI,LLM: User switches provider
    UI->>Ctx: setSelected("openai")
    Ctx->>LS: store "buffr-provider" = "openai"

    Note over UI,LLM: Later — AI call
    API->>BE: POST /session-ai?summarize<br/>{ provider: "openai", ... }
    BE->>Fac: getLLM("openai")
    Fac-->>BE: ChatOpenAI instance
    BE->>LLM: invoke([SystemMsg, HumanMsg])
    LLM-->>BE: response
    BE-->>API: { goal, bullets }
```

### Provider Factory Decision Tree

```mermaid
flowchart TD
    A["getLLM(provider)"] --> B{provider?}
    B -->|"anthropic"| C["Check ANTHROPIC_API_KEY"]
    B -->|"openai"| D["Check OPENAI_API_KEY"]
    B -->|"google"| E["Check GOOGLE_API_KEY"]
    B -->|"ollama"| F["Check OLLAMA_BASE_URL"]
    B -->|unknown| G["throw Error"]

    C -->|exists| C1["require(@langchain/anthropic)<br/>ChatAnthropic<br/>model: claude-sonnet-4"]
    C -->|missing| C2["throw 'ANTHROPIC_API_KEY<br/>not configured'"]

    D -->|exists| D1["require(@langchain/openai)<br/>ChatOpenAI<br/>model: gpt-4o"]
    D -->|missing| D2["throw 'OPENAI_API_KEY<br/>not configured'"]

    E -->|exists| E1["require(@langchain/google-genai)<br/>ChatGoogleGenerativeAI<br/>model: gemini-1.5-pro"]
    E -->|missing| E2["throw 'GOOGLE_API_KEY<br/>not configured'"]

    F -->|exists| F1["require(@langchain/ollama)<br/>ChatOllama<br/>model: llama3"]
    F -->|missing| F2["throw 'OLLAMA_BASE_URL<br/>not configured'"]
```

### Read these files in order:

1. **`netlify/functions/lib/ai/provider.ts`** — The core factory

   `getLLM(provider)` returns a LangChain `BaseChatModel`. Every AI feature calls this one function.

   Key observations:
   - Uses `require()` instead of `import` — why? Netlify bundles all code at build time. Dynamic require prevents loading unused SDKs (e.g., don't load `@langchain/anthropic` when using OpenAI).
   - Temperature is 0.7 everywhere — this is a balance between creativity (higher) and consistency (lower).
   - `getAvailableProviders()` checks env vars to determine what's available at runtime.

2. **`netlify/functions/providers.ts`** — The endpoint

   Simple GET endpoint that calls `getAvailableProviders()` and `getDefaultProvider()`. The frontend calls this on app load.

3. **`src/context/provider-context.tsx`** — Frontend state

   React Context that manages which provider is selected. Persists to localStorage so it survives page refreshes. Every component that calls an AI endpoint reads `selected` from this context.

4. **`src/components/provider-switcher.tsx`** — The UI control

### Exercise: Trace a provider switch

Follow what happens when a user changes from "Claude" to "GPT" in the UI:
1. `ProviderSwitcher` → `setSelected("openai")`
2. Context updates → localStorage stores `"openai"`
3. Next AI call → `body: { ..., provider: "openai" }` sent to backend
4. Backend → `getLLM("openai")` → `ChatOpenAI` instance
5. Chain runs with GPT-4o instead of Claude

---

## Part 2: Chain Architecture

**Goal**: Understand how LangChain chains transform data through AI.

### The Chain Pipeline

```mermaid
flowchart LR
    A["Typed Input<br/><i>{ text, goal, ... }</i>"] --> B["Build Messages<br/><i>SystemMessage<br/>+ HumanMessage</i>"]
    B --> C["llm.invoke()"]
    C --> D["Raw String<br/><i>response.content</i>"]
    D --> E["Parse Output<br/><i>stripCodeBlock()<br/>JSON.parse()</i>"]
    E --> F["Typed Output<br/><i>{ intent, bullets, ... }</i>"]

    style A fill:#1e1b4b,stroke:#7c3aed,color:#e9d5ff
    style C fill:#14532d,stroke:#22c55e,color:#bbf7d0
    style F fill:#1e1b4b,stroke:#7c3aed,color:#e9d5ff
```

### Chain Complexity Ladder

```mermaid
graph LR
    subgraph L1["Level 1 · Simple"]
        P["Paraphraser<br/>text → text"]
    end
    subgraph L2["Level 2 · JSON Output"]
        I["Intent Detector<br/>3 fields → { intent }"]
    end
    subgraph L3["Level 3 · Array I/O"]
        S["Summarizer<br/>items[] → { goal, bullets[] }"]
    end
    subgraph L4["Level 4 · Optional Context"]
        N["Next Step Suggester<br/>5 optional fields → step"]
    end
    subgraph L5["Level 5 · Flexible Schema"]
        PR["Prompt Runner<br/>any → text + actions? + artifact?"]
    end
    subgraph L6["Level 6 · Full Generation"]
        D["Dev Scanner<br/>project → stack[] + patterns[]<br/>+ gaps[] + files[]"]
    end

    L1 --> L2 --> L3 --> L4 --> L5 --> L6
```

### Read in order (simplest to most complex):

#### Chain 1: Paraphraser (simplest)

**File**: `netlify/functions/lib/ai/chains/paraphraser.ts`

This is the simplest chain — no structured output, no prompt builder. Read it to understand the skeleton:

```
{ text: string } → SystemMessage + HumanMessage → LLM → { text: string }
```

Note how it handles the LLM response: `response.content` could be a string or an array (multi-modal responses). The chain normalizes this.

#### Chain 2: Intent Detector

**File**: `netlify/functions/lib/ai/chains/intent-detector.ts`

Adds **structured JSON output parsing**:

```
{ goal, whatChanged, phase } → prompt → LLM → JSON parse → { intent: string }
```

Look at:
- `buildIntentPrompt()` in `prompts/session-prompts.ts` — how context is formatted
- The system prompt asks for JSON: `Return valid JSON: { "intent": "..." }`
- `parseIntentOutput()` uses `stripCodeBlock()` to handle LLMs that wrap JSON in markdown fences

#### Chain 3: Session Summarizer

**File**: `netlify/functions/lib/ai/chains/session-summarizer.ts`

Same pattern but with **array input** and **multi-field output**:

```
{ activityItems[] } → format as bullet list → LLM → { goal, bullets[] }
```

The prompt in `session-prompts.ts` shows how to format lists:
```
- [github] Fixed login bug
- [tasks] Updated docs
- [github] Closed issue #42
```

#### Chain 4: Next Step Suggester

**File**: `netlify/functions/lib/ai/chains/next-step-suggester.ts`

Adds **optional context fields**:

```
{ goal, whatChanged, currentNextStep?, projectContext?, openItems? }
```

The prompt builder conditionally appends sections. This is how you enrich AI context without bloating every request.

#### Chain 5: Prompt Runner (most complex)

**File**: `netlify/functions/lib/ai/chains/prompt-chain.ts`

This chain handles **arbitrary user prompts** with optional tool awareness. The output schema is flexible:

```typescript
{
  text: string,              // Always present
  suggestedActions?: Array,  // Optional tool calls
  artifact?: boolean         // Flag for long-form output
}
```

Note the graceful fallback: if the LLM doesn't return JSON, the raw text becomes the `text` field.

#### Chain 6: Dev Scanner (largest)

**File**: `netlify/functions/lib/ai/chains/dev-scanner.ts`

The most complex chain. Generates an entire `.dev/` folder structure:

```
project metadata + industry standards → LLM → stack[], patterns[], gaps[], files[]
```

### Exercise: Build a new chain

Create a hypothetical "code review" chain:
1. Define input: `{ code: string, language: string }`
2. Define output: `{ issues: Array<{ line: number, severity: string, message: string }> }`
3. Write a system prompt
4. Implement using the `RunnableSequence.from([...])` pattern

---

## Part 3: Serverless API Design

**Goal**: Understand how endpoints are structured and how they route requests.

### Endpoint Routing Model

```mermaid
flowchart TD
    REQ["Incoming Request"] --> MG{Method?}

    MG -->|GET| QG{Query Params?}
    MG -->|POST| QP{Query Params?}
    MG -->|PUT| QU{Query Params?}
    MG -->|DELETE| QD{id?}

    QG -->|none| LIST["List All"]
    QG -->|"?id=xxx"| GET1["Get One"]

    QP -->|none| CREATE["Create"]
    QP -->|"?summarize"| CHAIN_S["Summarizer Chain"]
    QP -->|"?intent"| CHAIN_I["Intent Chain"]
    QP -->|"?suggest"| CHAIN_N["Suggest Chain"]
    QP -->|"?paraphrase"| CHAIN_P["Paraphrase Chain"]
    QP -->|"?execute"| EXEC["Execute Tool"]

    QU -->|"?id=xxx"| UPDATE["Update"]
    QU -->|"?integrationId"| CONFIG["Save Config"]

    QD -->|yes| DELETE["Delete"]
    QD -->|no| ERR["400 Error"]

    style CHAIN_S fill:#14532d,stroke:#22c55e,color:#bbf7d0
    style CHAIN_I fill:#14532d,stroke:#22c55e,color:#bbf7d0
    style CHAIN_N fill:#14532d,stroke:#22c55e,color:#bbf7d0
    style CHAIN_P fill:#14532d,stroke:#22c55e,color:#bbf7d0
```

### The Handler Pattern

**File**: `netlify/functions/session-ai.ts`

This is the best file to study because it shows Buffr's routing strategy:

```typescript
export default async function handler(req: Request, _context: Context) {
  // 1. Method guard
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  // 2. Parse body + resolve provider
  const body = await req.json();
  const llm = getLLM(body.provider || "anthropic");

  // 3. Route by query parameter
  if (url.searchParams.has("summarize")) { /* chain A */ }
  if (url.searchParams.has("intent"))    { /* chain B */ }
  if (url.searchParams.has("suggest"))   { /* chain C */ }
  if (url.searchParams.has("paraphrase")){ /* chain D */ }

  // 4. Fallback
  return errorResponse("Unknown action", 400);
}
```

**Why query params instead of separate files?** All four operations share:
- The same LLM provider resolution
- The same error handling
- The same auth context (when added)

Grouping them avoids duplicating boilerplate across four separate files.

### CRUD Pattern

**File**: `netlify/functions/projects.ts`

Standard REST CRUD with method + query param routing:

```
GET  /projects              → list all
GET  /projects?id=xxx       → get one
POST /projects              → create
PUT  /projects?id=xxx       → update
DELETE /projects?id=xxx     → delete
```

### Error Classification

```mermaid
flowchart LR
    ERR["catch(err)"] --> CL["classifyError(err)"]
    CL --> M{error message<br/>contains?}

    M -->|"credit balance"| S402["402<br/>Payment Required"]
    M -->|"api key"| S401["401<br/>Unauthorized"]
    M -->|"rate limit"| S429["429<br/>Too Many Requests"]
    M -->|"name conflict"| S422["422<br/>Unprocessable"]
    M -->|"config missing"| S400["400<br/>Bad Request"]
    M -->|other| S500["500<br/>Internal Error"]

    S402 --> R["errorResponse(msg, status)"]
    S401 --> R
    S429 --> R
    S422 --> R
    S400 --> R
    S500 --> R
```

**File**: `netlify/functions/lib/responses.ts`

Three helpers used everywhere:

```typescript
json(data, 200)              // Success response
errorResponse("msg", 400)    // Error response
classifyError(err)           // Map LLM errors → HTTP status codes
```

---

## Part 4: Storage Layer

**Goal**: Understand how data persists with Netlify Blobs.

### Storage Architecture

```mermaid
graph TB
    subgraph Functions["Netlify Functions"]
        P["projects.ts"]
        S["sessions.ts"]
        T["tools.ts"]
        MA["manual-actions.ts"]
    end

    subgraph StorageLib["lib/storage/"]
        PS["projects.ts<br/><i>getProject · listProjects<br/>saveProject · deleteProject</i>"]
        SS["sessions.ts<br/><i>getSession · listByProject<br/>saveSession · deleteSession</i>"]
        TC["tool-config.ts<br/><i>listToolConfigs<br/>saveToolConfig</i>"]
        MAS["manual-actions.ts<br/><i>getManualActions<br/>saveManualActions</i>"]
    end

    subgraph Blobs["Netlify Blobs"]
        B1[("projects<br/><i>key: project.id</i>")]
        B2[("sessions<br/><i>key: session.id</i>")]
        B3[("tool-config<br/><i>key: integrationId</i>")]
        B4[("manual-actions<br/><i>key: projectId</i>")]
        B5[("prompt-library<br/><i>key: prompt.id</i>")]
        B6[("scan-results<br/><i>key: scan.id</i>")]
        B7[("industry-kb<br/><i>key: technology</i>")]
    end

    P --> PS --> B1
    S --> SS --> B2
    T --> TC --> B3
    MA --> MAS --> B4
```

### Query Pattern (No Index)

```mermaid
sequenceDiagram
    participant Fn as Function
    participant Lib as Storage Module
    participant Blob as Netlify Blobs

    Fn->>Lib: listSessionsByProject("proj-1")
    Lib->>Blob: store.list()
    Blob-->>Lib: { blobs: [key1, key2, key3, ...] }

    par Fetch all values
        Lib->>Blob: store.get(key1)
        Lib->>Blob: store.get(key2)
        Lib->>Blob: store.get(key3)
    end

    Blob-->>Lib: [session1, session2, session3, ...]
    Note over Lib: Filter in memory:<br/>sessions.filter(s => s.projectId === "proj-1")
    Lib-->>Fn: filtered & sorted sessions
```

### The Blob Pattern

**File**: `netlify/functions/lib/storage/projects.ts`

Every storage module follows the same structure:

```typescript
import { getStore } from "@netlify/blobs";

const STORE_NAME = "projects";

// Get one
async function getProject(id: string): Promise<Project | null> {
  const store = getStore(STORE_NAME);
  return store.get(id, { type: "json" });
}

// List all (with in-memory filter)
async function listProjects(): Promise<Project[]> {
  const store = getStore(STORE_NAME);
  const { blobs } = await store.list();
  const all = await Promise.all(
    blobs.map(b => store.get(b.key, { type: "json" }))
  );
  return all.filter(Boolean).sort(/* by date */);
}

// Save
async function saveProject(project: Project): Promise<void> {
  const store = getStore(STORE_NAME);
  await store.setJSON(project.id, project);
}
```

### Key Limitation

Blobs have no indexes or query support. Every "query" is:
1. `store.list()` — get all keys
2. `Promise.all(...)` — fetch all values
3. `.filter(...)` — filter in memory

This works fine for < 100 items per store. At scale, you'd need a database.

---

## Part 5: Tool & Integration System

**Goal**: Understand how external services (GitHub, Notion) plug in.

### Registry Architecture

```mermaid
flowchart TB
    subgraph Boot["Cold Start"]
        RA["registerAllTools()"]
        RA --> RG["registerGitHubTools()<br/><i>13 tools</i>"]
        RA --> RN["registerNotionTools()<br/><i>4 tools</i>"]
    end

    subgraph Registry["Global Tool Map"]
        T1["github_list_issues"]
        T2["github_list_commits"]
        T3["github_push_files"]
        T4["notion_list_tasks"]
        T5["...more"]
    end

    subgraph Runtime["Request Time"]
        REQ["POST /tools?execute<br/>{ tool: 'github_list_issues',<br/>  input: { owner, repo } }"]
        EXEC["executeTool()"]
        API["GitHub API"]
    end

    RG --> T1
    RG --> T2
    RG --> T3
    RN --> T4

    REQ --> EXEC
    EXEC -->|"lookup by name"| T1
    T1 -->|"tool.execute(input)"| API
    API -->|"{ items: [...] }"| EXEC
```

**File**: `netlify/functions/lib/tools/registry.ts`

Each tool is a self-contained unit:

```typescript
registerTool({
  name: "github_list_issues",
  integrationId: "github",
  description: "List repository issues",
  inputSchema: { owner: "string", repo: "string", state: "string" },
  execute: async (input) => {
    // Call GitHub API, return structured data
  }
});
```

### Tool Token Resolution in Prompts

```mermaid
flowchart LR
    A["Prompt Template<br/><code>Review: ﹛﹛tool:github_list_issues﹜﹜</code>"] --> B["Regex Match<br/><i>find all ﹛﹛tool:...﹜﹜</i>"]
    B --> C["Execute Tool<br/><i>registry.executeTool()</i>"]
    C --> D["GitHub API"]
    D --> E["JSON Result"]
    E --> F["Resolved Prompt<br/><code>Review: [{title: 'Bug #1'}, ...]</code>"]
    F --> G["LLM.invoke()"]

    style A fill:#1e1b4b,stroke:#7c3aed,color:#e9d5ff
    style F fill:#14532d,stroke:#22c55e,color:#bbf7d0
```

**File**: `netlify/functions/lib/resolve-tools.ts`

Prompts can embed live data using `{{tool:name}}` tokens:

```
Review these issues: {{tool:github_list_issues:{"owner":"me","repo":"app"}}}
```

Resolution happens server-side before the prompt hits the LLM:
1. Regex finds all `{{tool:...}}` tokens
2. Each tool is executed via the registry
3. Results replace the tokens as JSON strings
4. The fully-resolved prompt goes to the LLM

This keeps API keys on the server and lets prompts reference real-time data.

### Exercise: Add a new integration

To add a new integration (e.g., Linear):
1. Create `lib/linear.ts` — API client with fetch calls
2. Create `lib/tools/linear.ts` — register tools (`linear_list_issues`, etc.)
3. Add `registerLinearTools()` call in `lib/tools/register-all.ts`
4. Add config fields in `tools.ts` endpoint
5. Frontend gets the new integration automatically via `GET /tools`

---

## Part 6: Frontend → Backend Communication

**Goal**: Understand how the frontend calls all these backend services.

### Request Flow

```mermaid
flowchart LR
    subgraph Frontend
        C["Component<br/><i>useProvider()</i>"]
        A["api.ts<br/><i>request()</i>"]
    end

    subgraph Network
        F["fetch()<br/><i>/.netlify/functions/...</i>"]
    end

    subgraph Backend
        H["Handler<br/><i>req: Request</i>"]
        R["Response<br/><i>json() / errorResponse()</i>"]
    end

    C -->|"summarizeSession(items, selected)"| A
    A -->|"POST, JSON body"| F
    F --> H
    H --> R
    R -->|"{ goal, bullets }"| A
    A -->|"typed result"| C
```

### API Client

**File**: `src/lib/api.ts`

Single `request<T>()` function wraps all fetch calls:

```typescript
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/.netlify/functions${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(data.error);
  return data as T;
}
```

Every API method is a thin wrapper:

```typescript
export const summarizeSession = (items, provider?) =>
  request("/session-ai?summarize", {
    method: "POST",
    body: JSON.stringify({ activityItems: items, provider }),
  });
```

### Pattern: Provider Threading

```mermaid
flowchart LR
    PC["ProviderContext<br/><i>selected: 'openai'</i>"]
    -->|"useProvider()"| COMP["Component"]
    -->|"selected"| API["api.summarizeSession(<br/>items, 'openai')"]
    -->|"body.provider"| BE["Backend<br/>getLLM('openai')"]
    -->|ChatOpenAI| LLM["GPT-4o"]
```

Components that call AI endpoints pull `selected` from `useProvider()` and pass it explicitly.

---

## Part 7: Putting It All Together

### Complete Request Lifecycle: "End Session"

```mermaid
sequenceDiagram
    actor U as User
    participant FE as Frontend
    participant SA as session-ai
    participant TL as tools
    participant MA as manual-actions
    participant SS as sessions
    participant GH as GitHub API
    participant LLM as LLM Provider
    participant DB as Netlify Blobs

    U->>FE: Click "End Session"

    Note over FE,DB: Phase 1 — Fetch Activity (parallel)
    par
        FE->>TL: POST /tools?execute<br/>{tool: "github_list_issues"}
        TL->>GH: GET /repos/owner/repo/issues
        GH-->>TL: issues[]
        TL-->>FE: { ok: true, result: items }
    and
        FE->>MA: GET /manual-actions?projectId=xxx
        MA->>DB: get("manual-actions", projectId)
        DB-->>MA: ManualAction[]
        MA-->>FE: done actions
    end

    Note over FE,DB: Phase 2 — AI Summary
    FE->>SA: POST /session-ai?summarize<br/>{activityItems, provider: "openai"}
    SA->>LLM: SystemMessage + HumanMessage
    LLM-->>SA: JSON string
    SA-->>FE: { goal, bullets[] }

    Note over FE,DB: Phase 3 — User Review
    FE-->>U: Pre-filled form<br/>(goal, whatChanged, nextStep)
    U->>FE: Edit & submit

    Note over FE,DB: Phase 4 — Save + AI Enrich (parallel)
    FE->>SS: POST /sessions<br/>{projectId, goal, whatChanged, ...}
    SS->>DB: setJSON("sessions", session)

    par
        FE->>SA: POST /session-ai?intent
        SA->>LLM: detect intent
        LLM-->>SA: { intent }
    and
        FE->>SA: POST /session-ai?suggest
        SA->>LLM: suggest next step
        LLM-->>SA: { suggestedNextStep }
    end

    SA-->>FE: AI fields

    Note over FE,DB: Phase 5 — Cleanup
    FE->>MA: DELETE done manual actions
    MA->>DB: remove done items
```

### Complete Request Lifecycle: "Generate .dev/ Folder"

```mermaid
sequenceDiagram
    actor U as User
    participant FE as Frontend
    participant GD as generate-dev
    participant GH as GitHub API
    participant KB as Industry KB
    participant LLM as LLM Provider
    participant DB as Netlify Blobs

    U->>FE: Click "Scan Repository"
    FE->>GD: POST /generate-dev<br/>{projectId, provider}

    Note over GD,GH: Gather repo data
    GD->>GH: GET repo metadata
    GD->>GH: GET file tree
    GD->>GH: GET package.json, tsconfig, etc.
    GH-->>GD: repo data

    Note over GD,KB: Load standards
    GD->>KB: getStandard("react")<br/>getStandard("typescript")
    KB->>DB: get("industry-kb", tech)
    DB-->>GD: IndustryStandard[]

    Note over GD,LLM: AI Analysis (largest LLM call)
    GD->>LLM: Dev Scanner Chain<br/>project + repo + standards
    LLM-->>GD: { detectedStack, patterns,<br/>gapAnalysis, generatedFiles }

    Note over GD,DB: Persist
    GD->>DB: setJSON("scan-results", result)
    GD-->>FE: ScanResult

    Note over FE,GH: Optional push
    U->>FE: Click "Push to GitHub"
    FE->>GD: POST /generate-dev?push
    GD->>GH: Create blobs → tree → commit
    GH-->>GD: { sha }
    GD-->>FE: success
```

### Prompt Execution with Tool Resolution

```mermaid
sequenceDiagram
    actor U as User
    participant FE as Frontend
    participant RP as run-prompt
    participant DB as Netlify Blobs
    participant TR as Tool Registry
    participant GH as GitHub API
    participant LLM as LLM Provider

    U->>FE: Select prompt & click "Run"
    FE->>RP: POST /run-prompt<br/>{promptId, projectId, provider}

    Note over RP,DB: Load template
    RP->>DB: getPrompt(promptId)
    DB-->>RP: "Review {{project.name}} for<br/>{{tool:github_list_issues}}"

    Note over RP: Phase 1 — Sync resolution
    RP->>RP: Replace {{project.name}}<br/>→ "Review MyApp for<br/>{{tool:github_list_issues}}"

    Note over RP,GH: Phase 2 — Async tool resolution
    RP->>TR: executeTool("github_list_issues")
    TR->>GH: GET /repos/.../issues
    GH-->>TR: issues[]
    TR-->>RP: JSON result
    RP->>RP: Replace {{tool:...}}<br/>→ "Review MyApp for<br/>[{title: 'Bug'}, ...]"

    Note over RP,LLM: Phase 3 — LLM call
    RP->>LLM: Prompt Chain<br/>(fully resolved prompt)
    LLM-->>RP: { text, suggestedActions? }

    RP->>DB: Increment usageCount
    RP-->>FE: { text, suggestedActions }
```

---

## Part 8: Authentication Flow

```mermaid
sequenceDiagram
    actor U as User
    participant FE as Login Page
    participant LG as /login
    participant MW as middleware.ts
    participant API as Protected Endpoint

    U->>FE: Enter username + password
    FE->>LG: POST /login<br/>{username, password}

    alt Valid credentials
        LG->>LG: createToken()<br/>JWT: HS256, 7d expiry
        LG-->>FE: 200 + Set-Cookie:<br/>buffr-token=jwt;<br/>HttpOnly; Secure; SameSite=Lax
        FE->>FE: Redirect to dashboard
    else Invalid
        LG-->>FE: 401 Unauthorized
    end

    Note over FE,API: Subsequent requests
    FE->>MW: GET /projects<br/>Cookie: buffr-token=jwt
    MW->>MW: verifyToken(jwt)
    alt Valid token
        MW->>API: Forward request
        API-->>FE: Response
    else Expired / invalid
        MW-->>FE: 302 Redirect to /login
    end
```

---

## Quick Reference: File Locations

| Concept | File |
|---------|------|
| LLM factory | `netlify/functions/lib/ai/provider.ts` |
| All AI chains | `netlify/functions/lib/ai/chains/` |
| All system prompts | `netlify/functions/lib/ai/prompts/session-prompts.ts` |
| All storage modules | `netlify/functions/lib/storage/` |
| Tool registry | `netlify/functions/lib/tools/registry.ts` |
| Tool registration | `netlify/functions/lib/tools/register-all.ts` |
| GitHub/Notion clients | `netlify/functions/lib/{github,notion}.ts` |
| API client | `src/lib/api.ts` |
| Provider context | `src/context/provider-context.tsx` |
| Response helpers | `netlify/functions/lib/responses.ts` |
| Auth (JWT) | `netlify/functions/lib/auth.ts` |
