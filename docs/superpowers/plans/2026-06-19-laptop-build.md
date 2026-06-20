# Laptop Build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the laptop brain — a terminal-driven, profile-aware RAG agent running locally on Gemma — by implementing the five aptkit packages (A–E) test-first.

**Architecture:** Five aptkit packages: a Gemma `ModelProvider` (Ollama) with emulated tool-calling, a from-scratch adaptable RAG pipeline (`EmbeddingProvider` + `VectorStore` behind contracts, in-memory store now), a profile-injection helper, a precision@k scorer, and a capstone agent wiring them through aptkit's `runAgentLoop`. Reasoning + data stay local; nothing requires Supabase, phone, or sync.

**Tech Stack:** TypeScript (ESM, NodeNext), aptkit packages (`@aptkit/runtime`, `@aptkit/tools`, `@aptkit/context`, `@aptkit/evals`, `@aptkit/provider-local`), Ollama (`gemma2:9b`, `nomic-embed-text`), `node:test` + `node:assert/strict`.

**Canonical spec:** `docs/superpowers/specs/2026-06-19-aptkit-packages-design.md` (this repo). Code lands in the aptkit repo at `/Users/rein/Public/aptkit`.

## Global Constraints

- **Repo for all code:** `/Users/rein/Public/aptkit` (separate git repo; buffr holds the spec/plan only). Commit there.
- **Module system:** ESM, `"type": "module"`, `module`/`moduleResolution` = `NodeNext`. **All relative imports use `.js` extensions** (e.g. `import { x } from './foo.js'`), even from `.ts` source.
- **Package layout (verified convention for packages with tests):** `package.json` has `"main": "./dist/src/index.js"`, `"types": "./dist/src/index.d.ts"`, `"test": "npm run build && node --test dist/test/*.test.js"`. `tsconfig.json` extends the repo base, sets `"rootDir": "."`, `"outDir": "dist"`, `"types": ["node"]`, `"include": ["src/**/*.ts", "test/**/*.ts"]`. Source in `src/`, tests in `test/`, tests import from `../src/index.js`.
- **tsconfig `extends` depth:** `packages/<name>` → `"../../tsconfig.base.json"`; `packages/providers/<name>` and `packages/agents/<name>` → `"../../../tsconfig.base.json"`.
- **tsconfig `references`:** `packages/<name>` → `"../runtime"`; `packages/providers/<name>` & `packages/agents/<name>` → `"../../runtime"` (add `../../tools`, `../../context`, etc. as needed).
- **Test runner:** `node:test` (`describe`/`it`) + `node:assert/strict`. No Jest/Mocha/Vitest.
- **Dependencies:** only `@aptkit/*` workspace packages (version `"0.0.0"`) and `@types/node` (`"^20.0.0"`). No new third-party runtime deps.
- **Ollama:** base URL `http://localhost:11434`. Models: `gemma2:9b` (generation), `nomic-embed-text` (embeddings, **768-dim**). Unit tests must NOT call live Ollama (mock `fetch`); live calls only in the explicitly-marked smoke steps.
- **TDD:** every code change is test-first. Commit after each green test.

---

## File Structure

| Package | Path (under `/Users/rein/Public/aptkit/`) | Responsibility |
| --- | --- | --- |
| A `@aptkit/provider-gemma` | `packages/providers/gemma/` | Ollama→Gemma `ModelProvider`; emulated tool-calling; context guard wrap |
| B `@aptkit/retrieval` | `packages/retrieval/` | chunking, `EmbeddingProvider`, `VectorStore`, index/query pipeline, search tool |
| C `@aptkit/context` (existing) | `packages/context/src/profile-injector.ts` | inject a profile doc into the system prompt |
| D `@aptkit/evals` (existing) | `packages/evals/src/precision-at-k.ts` | precision@k / recall@k scorers |
| E `@aptkit/agent-rag-query` | `packages/agents/rag-query/` | wire A+B+C via `runAgentLoop`; measured by D |

Build order: Task 1 (env) → A (Tasks 2–4) and B (Tasks 5–9) in parallel → C (Task 10), D (Task 11) anytime → E (Task 12) last.

---

### Task 1: Local environment — Ollama + Gemma models

**Files:** none (infra). Deliverable: Ollama serving `gemma2:9b` + `nomic-embed-text`, verified.

**Interfaces:**
- Produces: a running Ollama daemon at `http://localhost:11434` with both models pulled. Every later live/smoke step depends on this.

- [ ] **Step 1: Install Ollama**

```bash
brew install ollama
```

- [ ] **Step 2: Start the daemon (leave running)**

```bash
ollama serve
```
Run in a dedicated terminal (or `brew services start ollama`). Expected: logs `Listening on 127.0.0.1:11434`.

- [ ] **Step 3: Pull both models** (~6 GB total; one-time)

```bash
ollama pull gemma2:9b
ollama pull nomic-embed-text
```
Expected: each ends with `success`.

- [ ] **Step 4: Verify generation**

```bash
curl -s http://localhost:11434/api/chat -d '{"model":"gemma2:9b","stream":false,"messages":[{"role":"user","content":"Reply with the single word: ok"}]}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["message"]["content"])'
```
Expected: prints a short reply containing `ok`.

- [ ] **Step 5: Verify embeddings are 768-dim**

```bash
curl -s http://localhost:11434/api/embeddings -d '{"model":"nomic-embed-text","prompt":"hello"}' | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["embedding"]))'
```
Expected: prints `768`.

---

### Task 2: `@aptkit/provider-gemma` — package scaffold + text-only `complete()`

**Files:**
- Create: `packages/providers/gemma/package.json`
- Create: `packages/providers/gemma/tsconfig.json`
- Create: `packages/providers/gemma/src/index.ts`
- Create: `packages/providers/gemma/src/gemma-provider.ts`
- Test: `packages/providers/gemma/test/gemma-provider.test.ts`

**Interfaces:**
- Consumes: `ModelProvider`, `ModelRequest`, `ModelResponse`, `ModelMessage`, `ModelContentBlock` from `@aptkit/runtime`.
- Produces: `class GemmaModelProvider implements ModelProvider` with `id='gemma'`, `defaultModel`, `complete(req): Promise<ModelResponse>`; `type GemmaProviderOptions = { baseUrl?: string; model?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/providers/gemma/test/gemma-provider.test.ts
import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { GemmaModelProvider } from '../src/index.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(jsonBody: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(jsonBody), { status: 200 })) as typeof fetch;
}

describe('GemmaModelProvider.complete (text)', () => {
  it('returns a single text block and usage from an Ollama chat reply', async () => {
    mockFetch({
      message: { role: 'assistant', content: 'hello there' },
      prompt_eval_count: 11,
      eval_count: 3,
    });
    const provider = new GemmaModelProvider();
    const res = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(provider.id, 'gemma');
    assert.deepEqual(res.content, [{ type: 'text', text: 'hello there' }]);
    assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 3, estimated: false });
  });
});
```

- [ ] **Step 2: Create package files so the test can resolve**

```jsonc
// packages/providers/gemma/package.json
{
  "name": "@aptkit/provider-gemma",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/src/index.js",
  "types": "./dist/src/index.d.ts",
  "exports": { ".": { "types": "./dist/src/index.d.ts", "import": "./dist/src/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "npm run build && node --test dist/test/*.test.js" },
  "dependencies": { "@aptkit/runtime": "0.0.0" },
  "devDependencies": { "@types/node": "^20.0.0" }
}
```

```jsonc
// packages/providers/gemma/tsconfig.json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "composite": true, "rootDir": ".", "outDir": "dist", "types": ["node"] },
  "references": [{ "path": "../../runtime" }],
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

```ts
// packages/providers/gemma/src/index.ts
export * from './gemma-provider.js';
```

Then wire the workspace symlink:
```bash
cd /Users/rein/Public/aptkit && npm install
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/provider-gemma`
Expected: FAIL — `gemma-provider.js` has no `GemmaModelProvider` export (or build error: file missing).

- [ ] **Step 4: Write the minimal implementation**

```ts
// packages/providers/gemma/src/gemma-provider.ts
import type {
  ModelContentBlock, ModelMessage, ModelProvider, ModelRequest, ModelResponse,
} from '@aptkit/runtime';

export type GemmaProviderOptions = { baseUrl?: string; model?: string };

type OllamaMsg = { role: 'system' | 'user' | 'assistant'; content: string };

export class GemmaModelProvider implements ModelProvider {
  readonly id = 'gemma';
  readonly defaultModel: string;
  private readonly baseUrl: string;

  constructor(opts: GemmaProviderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    this.defaultModel = opts.model ?? process.env.OLLAMA_MODEL ?? 'gemma2:9b';
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    const messages: OllamaMsg[] = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    for (const m of request.messages) messages.push(...toOllamaMessages(m));

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.defaultModel,
        messages,
        stream: false,
        options: {
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
        },
      }),
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as {
      message?: { content?: string }; prompt_eval_count?: number; eval_count?: number;
    };

    const text = data.message?.content ?? '';
    const content: ModelContentBlock[] = text ? [{ type: 'text', text }] : [];
    return {
      content,
      model: this.defaultModel,
      usage: {
        inputTokens: data.prompt_eval_count,
        outputTokens: data.eval_count,
        estimated: false,
      },
    };
  }
}

function toOllamaMessages(m: ModelMessage): OllamaMsg[] {
  if (typeof m.content === 'string') return [{ role: m.role, content: m.content }];
  // tool_result blocks → fold into a user message
  if (m.content.every((b) => b.type === 'tool_result')) {
    const text = m.content
      .map((b) => `Tool result (${(b as { toolUseId: string }).toolUseId}): ${(b as { content: string }).content}`)
      .join('\n');
    return [{ role: 'user', content: text }];
  }
  // text / tool_use blocks → flatten to text
  const text = m.content
    .map((b) => (b.type === 'text' ? b.text : JSON.stringify(b)))
    .join('\n');
  return [{ role: m.role === 'assistant' ? 'assistant' : 'user', content: text }];
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/provider-gemma`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
cd /Users/rein/Public/aptkit
git add packages/providers/gemma package-lock.json
git commit -m "feat(provider-gemma): scaffold + text-only complete() over Ollama"
```

---

### Task 3: `@aptkit/provider-gemma` — emulated tool-calling (the risky core)

**Files:**
- Create: `packages/providers/gemma/src/tool-emulation.ts`
- Modify: `packages/providers/gemma/src/gemma-provider.ts` (use emulation in `complete()`)
- Modify: `packages/providers/gemma/src/index.ts` (export emulation helpers)
- Test: `packages/providers/gemma/test/tool-emulation.test.ts`

**Interfaces:**
- Consumes: `ModelTool`, `ModelToolUseBlock` from `@aptkit/runtime`.
- Produces: `renderToolInstructions(tools: ModelTool[]): string`; `parseToolCalls(text: string): ModelToolUseBlock[]`. `complete()` now appends tool instructions to the system prompt when `request.tools` is non-empty, and returns `tool_use` blocks parsed from the model's text.

- [ ] **Step 1: Write the failing test**

```ts
// packages/providers/gemma/test/tool-emulation.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToolInstructions, parseToolCalls } from '../src/index.js';

describe('tool emulation', () => {
  it('renders tool names into instructions', () => {
    const text = renderToolInstructions([
      { name: 'search_knowledge_base', description: 'search', inputSchema: { type: 'object' } },
    ]);
    assert.match(text, /search_knowledge_base/);
    assert.match(text, /TOOL_CALL/);
  });

  it('parses a fenced JSON tool call out of messy prose', () => {
    const blocks = parseToolCalls(
      'Sure, let me look that up.\n```json\n{"tool":"search_knowledge_base","input":{"query":"rag"}}\n```\nDone.',
    );
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'tool_use');
    assert.equal(blocks[0].name, 'search_knowledge_base');
    assert.deepEqual(blocks[0].input, { query: 'rag' });
  });

  it('returns no blocks when there is no tool call', () => {
    assert.deepEqual(parseToolCalls('just a plain answer, no tools'), []);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/provider-gemma`
Expected: FAIL — `renderToolInstructions`/`parseToolCalls` not exported.

- [ ] **Step 3: Write the minimal implementation**

```ts
// packages/providers/gemma/src/tool-emulation.ts
import type { ModelTool, ModelToolUseBlock } from '@aptkit/runtime';

export function renderToolInstructions(tools: ModelTool[]): string {
  const list = tools
    .map((t) => `- ${t.name}: ${t.description ?? ''}\n  input schema: ${JSON.stringify(t.inputSchema)}`)
    .join('\n');
  return [
    'You can call tools. To call one, output ONLY a fenced json block of the form:',
    '```json',
    '{"tool":"<tool_name>","input":{ ... }}',
    '```',
    'prefixed with the marker TOOL_CALL on its own line. Do not add prose around it.',
    'Available tools:',
    list,
  ].join('\n');
}

/** Extract the first balanced JSON object/array out of messy model text. */
function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try { JSON.parse(candidate); return candidate; } catch { /* fall through */ }
  const starts = [candidate.indexOf('{'), candidate.indexOf('[')].filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    const slice = candidate.slice(start, end + 1);
    try { JSON.parse(slice); return slice; } catch { return null; }
  }
  return null;
}

export function parseToolCalls(text: string): ModelToolUseBlock[] {
  const json = extractJson(text);
  if (!json) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as { tool?: unknown; input?: unknown };
  if (typeof obj.tool !== 'string') return [];
  return [{
    type: 'tool_use',
    id: `gemma-${obj.tool}-0`,
    name: obj.tool,
    input: (obj.input && typeof obj.input === 'object' ? obj.input : {}) as Record<string, unknown>,
  }];
}
```

Then wire it into `complete()` and export it:

```ts
// packages/providers/gemma/src/index.ts
export * from './gemma-provider.js';
export * from './tool-emulation.js';
```

In `packages/providers/gemma/src/gemma-provider.ts`, add the import and modify the system-prompt + response handling:

```ts
// add near the top:
import { renderToolInstructions, parseToolCalls } from './tool-emulation.js';
```

```ts
// inside complete(), replace the system-message push with:
    const systemParts: string[] = [];
    if (request.system) systemParts.push(request.system);
    if (request.tools && request.tools.length > 0) systemParts.push(renderToolInstructions(request.tools));
    if (systemParts.length) messages.unshift({ role: 'system', content: systemParts.join('\n\n') });
```

```ts
// inside complete(), replace the `const content` line with:
    const toolUses = request.tools && request.tools.length > 0 ? parseToolCalls(text) : [];
    const content: ModelContentBlock[] =
      toolUses.length > 0 ? toolUses : (text ? [{ type: 'text', text }] : []);
```

(Remove the now-unused `if (request.system) messages.push(...)` block from Task 2.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/provider-gemma`
Expected: PASS (all tests, including Task 2's text test).

- [ ] **Step 5: Commit**

```bash
cd /Users/rein/Public/aptkit
git add packages/providers/gemma
git commit -m "feat(provider-gemma): emulate tool-calling via prompt + JSON parse"
```

---

### Task 4: `@aptkit/provider-gemma` — context-window guard wrap + live smoke

**Files:**
- Modify: `packages/providers/gemma/package.json` (add `@aptkit/provider-local` dep)
- Modify: `packages/providers/gemma/tsconfig.json` (reference `../local`)
- Create: `packages/providers/gemma/src/create-guarded-gemma.ts`
- Modify: `packages/providers/gemma/src/index.ts`
- Test: `packages/providers/gemma/test/guarded.test.ts`
- Create: `packages/providers/gemma/smoke/smoke.mjs` (manual, live Ollama)

**Interfaces:**
- Consumes: `ContextWindowGuardedProvider` from `@aptkit/provider-local`.
- Produces: `createGuardedGemma(opts?: GemmaProviderOptions & { maxTokens?: number }): ModelProvider` — a `GemmaModelProvider` wrapped in the context guard.

- [ ] **Step 1: Verify the guard's exported names**

Run: `cd /Users/rein/Public/aptkit && grep -n "export" packages/providers/local/src/index.ts`
Expected: shows `ContextWindowGuardedProvider` (and `ContextWindowExceededError`) are exported. If the class name differs, use the actual name in Step 4.

- [ ] **Step 2: Write the failing test**

```ts
// packages/providers/gemma/test/guarded.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGuardedGemma } from '../src/index.js';

describe('createGuardedGemma', () => {
  it('throws before calling Ollama when the request blows the window', async () => {
    const guarded = createGuardedGemma({ maxTokens: 64 }); // tiny budget
    const huge = 'x '.repeat(5000); // ~10k chars
    await assert.rejects(
      () => guarded.complete({ messages: [{ role: 'user', content: huge }] }),
      /context|exceed/i,
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/provider-gemma`
Expected: FAIL — `createGuardedGemma` not exported.

- [ ] **Step 4: Add the dependency and implement**

In `packages/providers/gemma/package.json`, add to `dependencies`: `"@aptkit/provider-local": "0.0.0"`.
In `packages/providers/gemma/tsconfig.json`, add to `references`: `{ "path": "../local" }`.

```ts
// packages/providers/gemma/src/create-guarded-gemma.ts
import type { ModelProvider } from '@aptkit/runtime';
import { ContextWindowGuardedProvider } from '@aptkit/provider-local';
import { GemmaModelProvider, type GemmaProviderOptions } from './gemma-provider.js';

export function createGuardedGemma(
  opts: GemmaProviderOptions & { maxTokens?: number } = {},
): ModelProvider {
  const provider = new GemmaModelProvider(opts);
  return new ContextWindowGuardedProvider(provider, {
    maxTokens: opts.maxTokens ?? 8192, // gemma2:9b context window
    capabilityId: 'gemma-context-guard',
  });
}
```

```ts
// packages/providers/gemma/src/index.ts — append:
export * from './create-guarded-gemma.js';
```

Then `cd /Users/rein/Public/aptkit && npm install` (links the new dep).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/provider-gemma`
Expected: PASS.

- [ ] **Step 6: Add a manual live smoke script**

```js
// packages/providers/gemma/smoke/smoke.mjs
// Run with Ollama up: node packages/providers/gemma/smoke/smoke.mjs
import { GemmaModelProvider } from '../dist/src/index.js';

const provider = new GemmaModelProvider();
const res = await provider.complete({
  system: 'Answer in one short sentence.',
  messages: [{ role: 'user', content: 'What is retrieval-augmented generation?' }],
});
console.log(JSON.stringify(res, null, 2));
```

- [ ] **Step 7: Run the smoke (manual, live)**

Run: `cd /Users/rein/Public/aptkit && npm run build -w @aptkit/provider-gemma && node packages/providers/gemma/smoke/smoke.mjs`
Expected: prints a `ModelResponse` with a `text` block and non-zero `usage`. (Requires Task 1.)

- [ ] **Step 8: Commit**

```bash
cd /Users/rein/Public/aptkit
git add packages/providers/gemma package-lock.json
git commit -m "feat(provider-gemma): context-window guard wrapper + live smoke"
```

---

### Task 5: `@aptkit/retrieval` — package scaffold + chunking

**Files:**
- Create: `packages/retrieval/package.json`, `packages/retrieval/tsconfig.json`
- Create: `packages/retrieval/src/index.ts`, `packages/retrieval/src/chunk.ts`
- Test: `packages/retrieval/test/chunk.test.ts`

**Interfaces:**
- Produces: `chunkText(text: string, opts?: { size?: number; overlap?: number }): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/retrieval/test/chunk.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkText } from '../src/index.js';

describe('chunkText', () => {
  it('windows long text with overlap', () => {
    const chunks = chunkText('a'.repeat(3000), { size: 1200, overlap: 200 });
    assert.equal(chunks.length, 3); // step=1000 → starts 0,1000,2000
    assert.equal(chunks[0].length, 1200);
  });
  it('returns one chunk for short text', () => {
    assert.deepEqual(chunkText('short', { size: 1200, overlap: 200 }), ['short']);
  });
  it('rejects overlap >= size', () => {
    assert.throws(() => chunkText('x', { size: 100, overlap: 100 }), /overlap/);
  });
});
```

- [ ] **Step 2: Create package files**

```jsonc
// packages/retrieval/package.json
{
  "name": "@aptkit/retrieval",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/src/index.js",
  "types": "./dist/src/index.d.ts",
  "exports": { ".": { "types": "./dist/src/index.d.ts", "import": "./dist/src/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "npm run build && node --test dist/test/*.test.js" },
  "dependencies": { "@aptkit/runtime": "0.0.0", "@aptkit/tools": "0.0.0" },
  "devDependencies": { "@types/node": "^20.0.0" }
}
```

```jsonc
// packages/retrieval/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "composite": true, "rootDir": ".", "outDir": "dist", "types": ["node"] },
  "references": [{ "path": "../runtime" }, { "path": "../tools" }],
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

```ts
// packages/retrieval/src/index.ts
export * from './chunk.js';
```

Then: `cd /Users/rein/Public/aptkit && npm install`

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/retrieval`
Expected: FAIL — `chunkText` not found.

- [ ] **Step 4: Implement**

```ts
// packages/retrieval/src/chunk.ts
export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): string[] {
  const size = opts.size ?? 1200;
  const overlap = opts.overlap ?? 200;
  if (size <= 0) throw new Error('chunk size must be > 0');
  if (overlap >= size) throw new Error('overlap must be < size');
  if (text.length <= size) return [text];
  const step = size - overlap;
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return chunks;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/retrieval`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/rein/Public/aptkit
git add packages/retrieval package-lock.json
git commit -m "feat(retrieval): scaffold + fixed-window chunkText"
```

---

### Task 6: `@aptkit/retrieval` — `EmbeddingProvider` + `OllamaEmbeddingProvider`

**Files:**
- Create: `packages/retrieval/src/embedding.ts`
- Modify: `packages/retrieval/src/index.ts`
- Test: `packages/retrieval/test/embedding.test.ts`

**Interfaces:**
- Produces: `type EmbeddingProvider = { id: string; dimension: number; embed(texts: string[]): Promise<number[][]> }`; `class OllamaEmbeddingProvider implements EmbeddingProvider` (`id='ollama-nomic'`, `dimension=768`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/retrieval/test/embedding.test.ts
import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { OllamaEmbeddingProvider } from '../src/index.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('OllamaEmbeddingProvider', () => {
  it('embeds each text via /api/embeddings', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      calls.push(JSON.parse(String((init as RequestInit).body)).prompt);
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 });
    }) as typeof fetch;

    const e = new OllamaEmbeddingProvider();
    assert.equal(e.dimension, 768);
    const vecs = await e.embed(['a', 'b']);
    assert.equal(vecs.length, 2);
    assert.deepEqual(vecs[0], [0.1, 0.2, 0.3]);
    assert.deepEqual(calls, ['a', 'b']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/retrieval`
Expected: FAIL — `OllamaEmbeddingProvider` not found.

- [ ] **Step 3: Implement**

```ts
// packages/retrieval/src/embedding.ts
export type EmbeddingProvider = {
  id: string;
  dimension: number;
  embed(texts: string[]): Promise<number[][]>;
};

export type OllamaEmbeddingOptions = { baseUrl?: string; model?: string };

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'ollama-nomic';
  readonly dimension = 768;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: OllamaEmbeddingOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    this.model = opts.model ?? 'nomic-embed-text';
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status} ${res.statusText}`);
      const data = (await res.json()) as { embedding?: number[] };
      if (!data.embedding) throw new Error('Ollama returned no embedding');
      out.push(data.embedding);
    }
    return out;
  }
}
```

```ts
// packages/retrieval/src/index.ts — append:
export * from './embedding.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/retrieval`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/rein/Public/aptkit
git add packages/retrieval
git commit -m "feat(retrieval): EmbeddingProvider contract + Ollama nomic adapter"
```

---

### Task 7: `@aptkit/retrieval` — `VectorStore` + `InMemoryVectorStore`

**Files:**
- Create: `packages/retrieval/src/vector-store.ts`
- Modify: `packages/retrieval/src/index.ts`
- Test: `packages/retrieval/test/vector-store.test.ts`

**Interfaces:**
- Produces: `type StoredChunk = { id: string; vector: number[]; meta: Record<string, unknown> }`; `type SearchHit = { id: string; score: number; meta: Record<string, unknown> }`; `type VectorStore = { dimension: number; upsert(chunks: StoredChunk[]): Promise<void>; search(vector: number[], k: number): Promise<SearchHit[]> }`; `class InMemoryVectorStore implements VectorStore` (constructor takes `dimension`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/retrieval/test/vector-store.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryVectorStore } from '../src/index.js';

describe('InMemoryVectorStore', () => {
  it('returns nearest by cosine, top-k', async () => {
    const store = new InMemoryVectorStore(2);
    await store.upsert([
      { id: 'a', vector: [1, 0], meta: { text: 'east' } },
      { id: 'b', vector: [0, 1], meta: { text: 'north' } },
    ]);
    const hits = await store.search([0.9, 0.1], 1);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 'a');
    assert.equal(hits[0].meta.text, 'east');
  });
  it('throws on dimension mismatch in upsert', async () => {
    const store = new InMemoryVectorStore(2);
    await assert.rejects(() => store.upsert([{ id: 'x', vector: [1, 2, 3], meta: {} }]), /dimension/);
  });
  it('throws on dimension mismatch in search', async () => {
    const store = new InMemoryVectorStore(2);
    await assert.rejects(() => store.search([1, 2, 3], 1), /dimension/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/retrieval`
Expected: FAIL — `InMemoryVectorStore` not found.

- [ ] **Step 3: Implement**

```ts
// packages/retrieval/src/vector-store.ts
export type StoredChunk = { id: string; vector: number[]; meta: Record<string, unknown> };
export type SearchHit = { id: string; score: number; meta: Record<string, unknown> };

export type VectorStore = {
  dimension: number;
  upsert(chunks: StoredChunk[]): Promise<void>;
  search(vector: number[], k: number): Promise<SearchHit[]>;
};

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export class InMemoryVectorStore implements VectorStore {
  readonly dimension: number;
  private readonly rows = new Map<string, StoredChunk>();

  constructor(dimension: number) { this.dimension = dimension; }

  async upsert(chunks: StoredChunk[]): Promise<void> {
    for (const c of chunks) {
      if (c.vector.length !== this.dimension) {
        throw new Error(`vector dimension ${c.vector.length} != store dimension ${this.dimension}`);
      }
      this.rows.set(c.id, c);
    }
  }

  async search(vector: number[], k: number): Promise<SearchHit[]> {
    if (vector.length !== this.dimension) {
      throw new Error(`query dimension ${vector.length} != store dimension ${this.dimension}`);
    }
    return [...this.rows.values()]
      .map((r) => ({ id: r.id, score: cosine(vector, r.vector), meta: r.meta }))
      .sort((x, y) => y.score - x.score)
      .slice(0, k);
  }
}
```

```ts
// packages/retrieval/src/index.ts — append:
export * from './vector-store.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/retrieval`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/rein/Public/aptkit
git add packages/retrieval
git commit -m "feat(retrieval): VectorStore contract + in-memory cosine store"
```

---

### Task 8: `@aptkit/retrieval` — index + query pipeline (with dimension guard)

**Files:**
- Create: `packages/retrieval/src/pipeline.ts`
- Modify: `packages/retrieval/src/index.ts`
- Test: `packages/retrieval/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider`, `VectorStore`, `SearchHit`, `chunkText`.
- Produces: `indexDocument(opts: { id: string; text: string; meta?: Record<string, unknown>; embedder: EmbeddingProvider; store: VectorStore; chunk?: { size?: number; overlap?: number } }): Promise<number>`; `queryKnowledgeBase(opts: { query: string; k?: number; embedder: EmbeddingProvider; store: VectorStore }): Promise<SearchHit[]>`. Both throw if `embedder.dimension !== store.dimension`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/retrieval/test/pipeline.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryVectorStore, indexDocument, queryKnowledgeBase } from '../src/index.js';
import type { EmbeddingProvider } from '../src/index.js';

// deterministic fake embedder: dimension 3, vector = [#a, #b, length]
const fake: EmbeddingProvider = {
  id: 'fake', dimension: 3,
  async embed(texts) {
    return texts.map((t) => [
      (t.match(/a/g) ?? []).length,
      (t.match(/b/g) ?? []).length,
      t.length,
    ]);
  },
};

describe('pipeline', () => {
  it('indexes chunks then retrieves the closest', async () => {
    const store = new InMemoryVectorStore(3);
    const n = await indexDocument({ id: 'doc1', text: 'aaa bbb', embedder: fake, store, chunk: { size: 1200, overlap: 200 } });
    assert.equal(n, 1);
    const hits = await queryKnowledgeBase({ query: 'aaa', k: 1, embedder: fake, store });
    assert.equal(hits[0].id, 'doc1#0');
    assert.equal(hits[0].meta.text, 'aaa bbb');
  });
  it('throws on embedder/store dimension mismatch', async () => {
    const store = new InMemoryVectorStore(768);
    await assert.rejects(
      () => indexDocument({ id: 'd', text: 'x', embedder: fake, store }),
      /dimension/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/retrieval`
Expected: FAIL — `indexDocument`/`queryKnowledgeBase` not found.

- [ ] **Step 3: Implement**

```ts
// packages/retrieval/src/pipeline.ts
import { chunkText } from './chunk.js';
import type { EmbeddingProvider } from './embedding.js';
import type { SearchHit, StoredChunk, VectorStore } from './vector-store.js';

function assertDims(embedder: EmbeddingProvider, store: VectorStore): void {
  if (embedder.dimension !== store.dimension) {
    throw new Error(`embedder dimension ${embedder.dimension} != store dimension ${store.dimension}`);
  }
}

export async function indexDocument(opts: {
  id: string; text: string; meta?: Record<string, unknown>;
  embedder: EmbeddingProvider; store: VectorStore;
  chunk?: { size?: number; overlap?: number };
}): Promise<number> {
  assertDims(opts.embedder, opts.store);
  const pieces = chunkText(opts.text, opts.chunk);
  const vectors = await opts.embedder.embed(pieces);
  const rows: StoredChunk[] = pieces.map((text, i) => ({
    id: `${opts.id}#${i}`,
    vector: vectors[i],
    meta: { ...(opts.meta ?? {}), docId: opts.id, chunkIndex: i, text },
  }));
  await opts.store.upsert(rows);
  return rows.length;
}

export async function queryKnowledgeBase(opts: {
  query: string; k?: number; embedder: EmbeddingProvider; store: VectorStore;
}): Promise<SearchHit[]> {
  assertDims(opts.embedder, opts.store);
  const [vec] = await opts.embedder.embed([opts.query]);
  return opts.store.search(vec, opts.k ?? 5);
}
```

```ts
// packages/retrieval/src/index.ts — append:
export * from './pipeline.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/retrieval`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/rein/Public/aptkit
git add packages/retrieval
git commit -m "feat(retrieval): index/query pipeline with dimension guard"
```

---

### Task 9: `@aptkit/retrieval` — `search_knowledge_base` tool

**Files:**
- Create: `packages/retrieval/src/search-tool.ts`
- Modify: `packages/retrieval/src/index.ts`
- Test: `packages/retrieval/test/search-tool.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition`, `ToolHandler`, `InMemoryToolRegistry` from `@aptkit/tools`; `EmbeddingProvider`, `VectorStore`, `queryKnowledgeBase`.
- Produces: `const searchKnowledgeBaseDefinition: ToolDefinition`; `createSearchKnowledgeBaseHandler(opts: { embedder: EmbeddingProvider; store: VectorStore; k?: number }): ToolHandler`. Handler returns `{ chunks: { id: string; score: number; text: string }[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/retrieval/test/search-tool.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryToolRegistry } from '@aptkit/tools';
import {
  InMemoryVectorStore, indexDocument,
  searchKnowledgeBaseDefinition, createSearchKnowledgeBaseHandler,
} from '../src/index.js';
import type { EmbeddingProvider } from '../src/index.js';

const fake: EmbeddingProvider = {
  id: 'fake', dimension: 3,
  async embed(texts) { return texts.map((t) => [(t.match(/a/g) ?? []).length, (t.match(/b/g) ?? []).length, t.length]); },
};

describe('search_knowledge_base tool', () => {
  it('runs through the registry and returns ranked chunks', async () => {
    const store = new InMemoryVectorStore(3);
    await indexDocument({ id: 'doc1', text: 'aaa bbb', embedder: fake, store });
    const registry = new InMemoryToolRegistry(
      [searchKnowledgeBaseDefinition],
      { search_knowledge_base: createSearchKnowledgeBaseHandler({ embedder: fake, store, k: 3 }) },
    );
    const { result, durationMs } = await registry.callTool('search_knowledge_base', { query: 'aaa' });
    assert.ok(durationMs >= 0);
    const r = result as { chunks: { id: string; text: string }[] };
    assert.equal(r.chunks[0].id, 'doc1#0');
    assert.equal(r.chunks[0].text, 'aaa bbb');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/retrieval`
Expected: FAIL — `searchKnowledgeBaseDefinition`/`createSearchKnowledgeBaseHandler` not found.

- [ ] **Step 3: Implement**

```ts
// packages/retrieval/src/search-tool.ts
import type { ToolDefinition, ToolHandler } from '@aptkit/tools';
import type { EmbeddingProvider } from './embedding.js';
import type { VectorStore } from './vector-store.js';
import { queryKnowledgeBase } from './pipeline.js';

export const searchKnowledgeBaseDefinition: ToolDefinition = {
  name: 'search_knowledge_base',
  description: 'Search the user\'s knowledge base for relevant passages via semantic similarity.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'natural-language search query' },
      k: { type: 'number', description: 'max results (default 5)' },
    },
    required: ['query'],
  },
};

export function createSearchKnowledgeBaseHandler(opts: {
  embedder: EmbeddingProvider; store: VectorStore; k?: number;
}): ToolHandler {
  return async (args, callOptions) => {
    callOptions?.signal?.throwIfAborted();
    const hits = await queryKnowledgeBase({
      query: String(args.query ?? ''),
      k: typeof args.k === 'number' ? args.k : opts.k ?? 5,
      embedder: opts.embedder,
      store: opts.store,
    });
    return { chunks: hits.map((h) => ({ id: h.id, score: h.score, text: String(h.meta.text ?? '') })) };
  };
}
```

```ts
// packages/retrieval/src/index.ts — append:
export * from './search-tool.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/retrieval`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/rein/Public/aptkit
git add packages/retrieval
git commit -m "feat(retrieval): search_knowledge_base tool over the query path"
```

---

### Task 10: `@aptkit/context` — profile injector

**Files:**
- Create: `packages/context/src/profile-injector.ts`
- Modify: `packages/context/src/index.ts` (add export)
- Test: `packages/context/test/profile-injector.test.ts`

**Interfaces:**
- Produces: `injectProfile(systemTemplate: string, profileText: string, opts?: { position?: 'start' | 'end'; heading?: string }): string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/context/test/profile-injector.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { injectProfile } from '../src/index.js';

describe('injectProfile', () => {
  it('prepends the profile by default with a heading', () => {
    const out = injectProfile('SYSTEM RULES', 'I think visually.', { heading: '## About me' });
    assert.match(out, /^## About me\n\nI think visually\.\n\nSYSTEM RULES$/);
  });
  it('can append instead', () => {
    const out = injectProfile('RULES', 'P', { position: 'end', heading: 'H' });
    assert.match(out, /^RULES\n\nH\n\nP$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/context`
Expected: FAIL — `injectProfile` not found.

- [ ] **Step 3: Implement**

```ts
// packages/context/src/profile-injector.ts
export function injectProfile(
  systemTemplate: string,
  profileText: string,
  opts: { position?: 'start' | 'end'; heading?: string } = {},
): string {
  const heading = opts.heading ?? '## About the person you are helping';
  const block = `${heading}\n\n${profileText.trim()}`;
  return opts.position === 'end'
    ? `${systemTemplate}\n\n${block}`
    : `${block}\n\n${systemTemplate}`;
}
```

Add the export (append to the existing barrel; do not remove existing lines):
```ts
// packages/context/src/index.ts — append:
export * from './profile-injector.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/context`
Expected: PASS (existing context tests still green).

- [ ] **Step 5: Commit**

```bash
cd /Users/rein/Public/aptkit
git add packages/context
git commit -m "feat(context): pure injectProfile for system-prompt memory seam"
```

---

### Task 11: `@aptkit/evals` — precision@k / recall@k

**Files:**
- Create: `packages/evals/src/precision-at-k.ts`
- Modify: `packages/evals/src/index.ts` (add export)
- Test: `packages/evals/test/precision-at-k.test.ts`

**Interfaces:**
- Produces: `scorePrecisionAtK(retrieved: readonly string[], relevant: ReadonlySet<string>, k: number, threshold?: number): { ok: boolean; score: number; matched: number; total: number }`; `scoreRecallAtK(retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): { score: number; matched: number; total: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/evals/test/precision-at-k.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scorePrecisionAtK, scoreRecallAtK } from '../src/index.js';

describe('scorePrecisionAtK', () => {
  it('scores matches in the top-k', () => {
    const r = scorePrecisionAtK(['a', 'x', 'b', 'y'], new Set(['a', 'b', 'c']), 4);
    assert.equal(r.matched, 2);
    assert.equal(r.total, 4);
    assert.equal(r.score, 0.5);
    assert.equal(r.ok, false); // default threshold 0.8
  });
  it('passes ok at/above threshold', () => {
    const r = scorePrecisionAtK(['a', 'b', 'c', 'd', 'e'], new Set(['a', 'b', 'c', 'd']), 5, 0.8);
    assert.equal(r.score, 0.8);
    assert.equal(r.ok, true);
  });
  it('divides by retrieved count when fewer than k', () => {
    const r = scorePrecisionAtK(['a'], new Set(['a']), 5);
    assert.equal(r.total, 1);
    assert.equal(r.score, 1);
  });
});

describe('scoreRecallAtK', () => {
  it('scores recall against the relevant set', () => {
    const r = scoreRecallAtK(['a', 'b', 'x'], new Set(['a', 'b', 'c', 'd']), 3);
    assert.equal(r.matched, 2);
    assert.equal(r.total, 4);
    assert.equal(r.score, 0.5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/evals`
Expected: FAIL — scorers not found.

- [ ] **Step 3: Implement**

```ts
// packages/evals/src/precision-at-k.ts
export function scorePrecisionAtK(
  retrieved: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
  threshold = 0.8,
): { ok: boolean; score: number; matched: number; total: number } {
  const topK = retrieved.slice(0, k);
  const matched = topK.filter((id) => relevant.has(id)).length;
  const total = Math.min(k, retrieved.length);
  const score = total === 0 ? 0 : matched / total;
  return { ok: score >= threshold, score, matched, total };
}

export function scoreRecallAtK(
  retrieved: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): { score: number; matched: number; total: number } {
  const topK = new Set(retrieved.slice(0, k));
  let matched = 0;
  for (const id of relevant) if (topK.has(id)) matched += 1;
  const total = relevant.size;
  return { score: total === 0 ? 0 : matched / total, matched, total };
}
```

```ts
// packages/evals/src/index.ts — append:
export * from './precision-at-k.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/evals`
Expected: PASS (existing evals tests still green).

- [ ] **Step 5: Commit**

```bash
cd /Users/rein/Public/aptkit
git add packages/evals
git commit -m "feat(evals): precision@k and recall@k retrieval scorers"
```

---

### Task 12: `@aptkit/agent-rag-query` — capstone agent

**Files:**
- Create: `packages/agents/rag-query/package.json`, `packages/agents/rag-query/tsconfig.json`
- Create: `packages/agents/rag-query/src/index.ts`, `packages/agents/rag-query/src/rag-query-agent.ts`
- Test: `packages/agents/rag-query/test/rag-query-agent.test.ts`
- Create: `packages/agents/rag-query/smoke/smoke.mjs` (manual, live Ollama)

**Interfaces:**
- Consumes: `runAgentLoop`, `ModelProvider` from `@aptkit/runtime`; `InMemoryToolRegistry` from `@aptkit/tools`; `injectProfile` from `@aptkit/context`; `searchKnowledgeBaseDefinition`, `createSearchKnowledgeBaseHandler`, `EmbeddingProvider`, `VectorStore` from `@aptkit/retrieval`.
- Produces: `class RagQueryAgent` with constructor `{ model: ModelProvider; embedder: EmbeddingProvider; store: VectorStore; profileText: string; k?: number }` and `answer(question: string): Promise<string>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/agents/rag-query/test/rag-query-agent.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelProvider, ModelRequest, ModelResponse } from '@aptkit/runtime';
import { InMemoryVectorStore, indexDocument } from '@aptkit/retrieval';
import type { EmbeddingProvider } from '@aptkit/retrieval';
import { RagQueryAgent } from '../src/index.js';

const fake: EmbeddingProvider = {
  id: 'fake', dimension: 3,
  async embed(texts) { return texts.map((t) => [(t.match(/a/g) ?? []).length, (t.match(/b/g) ?? []).length, t.length]); },
};

// scripted provider: turn 1 → call the tool, turn 2 → final answer
class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  readonly requests: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly responses: ModelResponse[]) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const r = this.responses[this.i++];
    if (!r) throw new Error('no scripted response');
    return r;
  }
}

describe('RagQueryAgent', () => {
  it('retrieves then answers, with the profile in the system prompt', async () => {
    const store = new InMemoryVectorStore(3);
    await indexDocument({ id: 'note', text: 'aaa bbb', embedder: fake, store });

    const model = new ScriptedProvider([
      { content: [{ type: 'tool_use', id: 't1', name: 'search_knowledge_base', input: { query: 'aaa' } }] },
      { content: [{ type: 'text', text: 'Per your notes: aaa bbb.' }] },
    ]);

    const agent = new RagQueryAgent({ model, embedder: fake, store, profileText: 'I think visually.' });
    const answer = await agent.answer('what did I note?');

    assert.match(answer, /aaa bbb/);
    assert.match(String(model.requests[0].system), /I think visually\./); // profile injected
  });
});
```

- [ ] **Step 2: Create package files**

```jsonc
// packages/agents/rag-query/package.json
{
  "name": "@aptkit/agent-rag-query",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/src/index.js",
  "types": "./dist/src/index.d.ts",
  "exports": { ".": { "types": "./dist/src/index.d.ts", "import": "./dist/src/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "npm run build && node --test dist/test/*.test.js" },
  "dependencies": {
    "@aptkit/runtime": "0.0.0",
    "@aptkit/tools": "0.0.0",
    "@aptkit/context": "0.0.0",
    "@aptkit/retrieval": "0.0.0"
  },
  "devDependencies": { "@types/node": "^20.0.0" }
}
```

```jsonc
// packages/agents/rag-query/tsconfig.json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "composite": true, "rootDir": ".", "outDir": "dist", "types": ["node"] },
  "references": [
    { "path": "../../runtime" }, { "path": "../../tools" },
    { "path": "../../context" }, { "path": "../../retrieval" }
  ],
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

```ts
// packages/agents/rag-query/src/index.ts
export * from './rag-query-agent.js';
```

Then: `cd /Users/rein/Public/aptkit && npm install`

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/agent-rag-query`
Expected: FAIL — `RagQueryAgent` not found.

- [ ] **Step 4: Implement**

```ts
// packages/agents/rag-query/src/rag-query-agent.ts
import { runAgentLoop, type ModelProvider } from '@aptkit/runtime';
import { InMemoryToolRegistry } from '@aptkit/tools';
import { injectProfile } from '@aptkit/context';
import {
  searchKnowledgeBaseDefinition, createSearchKnowledgeBaseHandler,
  type EmbeddingProvider, type VectorStore,
} from '@aptkit/retrieval';

const BASE_SYSTEM = [
  'You are a personal assistant for one user.',
  'When a question may depend on the user\'s own notes, call search_knowledge_base first,',
  'then answer grounded ONLY in the retrieved passages. If nothing relevant is found, say so.',
].join(' ');

export type RagQueryAgentOptions = {
  model: ModelProvider;
  embedder: EmbeddingProvider;
  store: VectorStore;
  profileText: string;
  k?: number;
};

export class RagQueryAgent {
  constructor(private readonly opts: RagQueryAgentOptions) {}

  async answer(question: string): Promise<string> {
    const registry = new InMemoryToolRegistry(
      [searchKnowledgeBaseDefinition],
      { search_knowledge_base: createSearchKnowledgeBaseHandler({
        embedder: this.opts.embedder, store: this.opts.store, k: this.opts.k ?? 5,
      }) },
    );
    const system = injectProfile(BASE_SYSTEM, this.opts.profileText);
    const { finalText } = await runAgentLoop({
      capabilityId: 'rag-query',
      model: this.opts.model,
      tools: registry,
      system,
      userPrompt: question,
      toolSchemas: [searchKnowledgeBaseDefinition],
    });
    return finalText.trim();
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/rein/Public/aptkit && npm test -w @aptkit/agent-rag-query`
Expected: PASS.

> If `runAgentLoop`'s option names differ in your runtime version, run
> `grep -n "RunAgentLoopOptions" packages/runtime/src/run-agent-loop.ts` and align
> the keys (`capabilityId`, `model`, `tools`, `system`, `userPrompt`, `toolSchemas`) and
> the returned `finalText` field to the actual signature.

- [ ] **Step 6: Add the live end-to-end smoke (manual)**

```js
// packages/agents/rag-query/smoke/smoke.mjs
// Live: requires Ollama (Task 1). Indexes a real file, asks a question.
// Run: node packages/agents/rag-query/smoke/smoke.mjs <path-to-markdown> "<question>"
import { readFileSync } from 'node:fs';
import { createGuardedGemma } from '../../../providers/gemma/dist/src/index.js';
import { InMemoryVectorStore, OllamaEmbeddingProvider, indexDocument } from '../../../retrieval/dist/src/index.js';
import { RagQueryAgent } from '../dist/src/index.js';

const [, , file, question] = process.argv;
const embedder = new OllamaEmbeddingProvider();
const store = new InMemoryVectorStore(embedder.dimension);
await indexDocument({ id: file, text: readFileSync(file, 'utf8'), embedder, store });

const agent = new RagQueryAgent({
  model: createGuardedGemma(),
  embedder, store,
  profileText: 'Prefers terse, direct, diagram-first answers. No hedging.',
});
console.log(await agent.answer(question ?? 'Summarize this document.'));
```

- [ ] **Step 7: Run the live smoke (manual)**

Run:
```bash
cd /Users/rein/Public/aptkit
npm run build -w @aptkit/provider-gemma && npm run build -w @aptkit/retrieval && npm run build -w @aptkit/agent-rag-query
node packages/agents/rag-query/smoke/smoke.mjs ../aipe/specs/me.md "How do I prefer explanations?"
```
Expected: a grounded answer mentioning diagram-first / visual / terse, drawn from `me.md`. This is the living laptop brain. (Gemma's emulated tool-calling may need prompt tuning if it doesn't call the tool — iterate on `BASE_SYSTEM` / `renderToolInstructions`.)

- [ ] **Step 8: Commit**

```bash
cd /Users/rein/Public/aptkit
git add packages/agents/rag-query package-lock.json
git commit -m "feat(agent-rag-query): capstone profile-aware local RAG agent"
```

---

## Self-Review

- **Spec coverage:** Package A → Tasks 2–4; Package B → Tasks 5–9; Package C → Task 10; Package D → Task 11; Package E → Task 12; local env → Task 1. The deferred body (pgvector, Supabase, phone, sync, gateway) is intentionally absent — out of scope per the spec.
- **Adaptability requirement (spec's core driver):** met via the `EmbeddingProvider`/`VectorStore` contracts (Tasks 6–7); `OllamaEmbeddingProvider` and `InMemoryVectorStore` are adapters; the dimension one-way door is enforced in Tasks 7–8.
- **Tool-calling risk (spec package A):** isolated in Task 3 with its own test; the two failure surfaces (output vs tool-call decoding) are exercised separately (Task 2 text, Task 3 tool parse).
- **Judge-with-Claude / faithfulness:** precision@k is built (Task 11); the `RubricJudge` faithfulness path reuses the existing `@aptkit/evals` class and is a follow-on eval, not a build task here.
- **Type consistency:** `EmbeddingProvider.dimension`, `VectorStore.dimension`, `StoredChunk`/`SearchHit`, `searchKnowledgeBaseDefinition`/`createSearchKnowledgeBaseHandler`, and `RagQueryAgentOptions` are used identically across Tasks 6–12.
- **Open risk flagged, not hidden:** live Gemma tool-calling reliability (Task 12 Step 7) — the smoke step calls out prompt iteration if Gemma doesn't emit the tool call. That's the project's known long-pole risk.
