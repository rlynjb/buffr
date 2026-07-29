# Prompt Registry + Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a named+versioned prompt registry and in-memory caching (embeddings + connector results) to the buffr kernel and connectors, then wire them into `session.ts` so every turn stamps its `promptVersion` on `TurnStats`.

**Architecture:** A `Cache<K,V>` interface + `InMemoryCache` (TTL-optional) lives in `packages/kernel`. A `PromptRegistry` (name+version → template) lives in `packages/kernel`. `CachedEmbeddingProvider` wraps any `EmbeddingProvider` with the cache. `CachedConnector<P,D>` wraps any `DataConnector` in `packages/connectors` (duck-typed cache, no cross-package import). `session.ts` uses all four to wrap providers, register the routing prompt, and expose `promptVersion` on each turn.

**Tech Stack:** TypeScript ESM, `node:test` + `node:assert/strict`, `packages/kernel` and `packages/connectors` local monorepo workspaces, `src/session.ts` root source.

## Global Constraints

- TypeScript ESM, `"type": "module"`, `moduleResolution: NodeNext` — all imports must use `.js` extension.
- Build order: `contracts` → `kernel` → `connectors` — kernel may import contracts; connectors may import contracts but must NOT import kernel (no circular dep).
- `CachedConnector` lives in connectors: its cache arg must be duck-typed (structural interface), not an import from kernel.
- `embed(texts: string[]): Promise<number[][]>` — no extra args; matches `EmbeddingProvider` contract exactly.
- Embedding dimension is 768 everywhere; the cache stores `number[]` per text, never validates dimension.
- Kernel test glob: `dist/test/*.test.js` — test files in `packages/kernel/test/`.
- Connectors test glob: `dist/test/discovery/*.test.js` — test files in `packages/connectors/test/discovery/`.
- No new prod dependencies. No `Date.now()` or `Math.random()` in library code (tests may use them).
- `TurnStats.promptVersion` is optional (`string | undefined`) — existing callers need no changes.

---

### Task 1: `Cache<K,V>` interface + `InMemoryCache`

**Files:**
- Create: `packages/kernel/src/cache/index.ts`
- Create: `packages/kernel/test/cache.test.ts`
- Modify: `packages/kernel/src/index.ts` (add export)

**Interfaces:**
- Produces: `Cache<K, V>` (interface), `InMemoryCache<K, V>` (class) — exported from `@buffr/kernel`. Tasks 3 and 5 import these.

---

- [ ] **Step 1: Write the failing test**

Create `packages/kernel/test/cache.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCache } from '../src/cache/index.js';

describe('InMemoryCache', () => {
  it('returns undefined for missing key', () => {
    const cache = new InMemoryCache<string, number>();
    assert.strictEqual(cache.get('missing'), undefined);
  });

  it('stores and retrieves a value', () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('a', 42);
    assert.strictEqual(cache.get('a'), 42);
  });

  it('returns undefined after TTL expires', async () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('x', 1, 1); // 1 ms TTL
    await new Promise<void>(r => setTimeout(r, 10));
    assert.strictEqual(cache.get('x'), undefined);
  });

  it('does not expire entry without TTL', async () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('y', 2);
    await new Promise<void>(r => setTimeout(r, 10));
    assert.strictEqual(cache.get('y'), 2);
  });

  it('deletes a specific key', () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('a', 1);
    cache.delete('a');
    assert.strictEqual(cache.get('a'), undefined);
  });

  it('clears all entries', () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.strictEqual(cache.size(), 0);
  });

  it('size() counts live entries only', async () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('permanent', 1);
    cache.set('expiring', 2, 1);
    await new Promise<void>(r => setTimeout(r, 10));
    cache.get('expiring'); // triggers eviction
    assert.strictEqual(cache.size(), 1);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd packages/kernel && npm run build && npm test
```

Expected: compile error or `InMemoryCache` not found.

- [ ] **Step 3: Implement `packages/kernel/src/cache/index.ts`**

```typescript
export interface Cache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V, ttlMs?: number): void;
  delete(key: K): void;
  clear(): void;
  size(): number;
}

type Entry<V> = { value: V; expiresAt: number | null };

export class InMemoryCache<K, V> implements Cache<K, V> {
  private readonly store = new Map<K, Entry<V>>();

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : null,
    });
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}
```

- [ ] **Step 4: Export from kernel index**

In `packages/kernel/src/index.ts`, add at the end:

```typescript
export * from './cache/index.js';
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd packages/kernel && npm run build && npm test
```

Expected: all cache tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/cache/index.ts packages/kernel/test/cache.test.ts packages/kernel/src/index.ts
git commit -m "feat(kernel): add Cache interface + InMemoryCache with optional TTL"
```

---

### Task 2: `PromptRegistry`

**Files:**
- Create: `packages/kernel/src/prompt-registry/index.ts`
- Create: `packages/kernel/test/prompt-registry.test.ts`
- Modify: `packages/kernel/src/index.ts` (add export)

**Interfaces:**
- Produces: `PromptEntry` (type), `PromptRegistry` (class) — exported from `@buffr/kernel`. Tasks 3 and 5 import `PromptRegistry`.

---

- [ ] **Step 1: Write the failing test**

Create `packages/kernel/test/prompt-registry.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PromptRegistry } from '../src/prompt-registry/index.js';

describe('PromptRegistry', () => {
  it('retrieves a registered prompt by name', () => {
    const r = new PromptRegistry();
    r.register('my/prompt', '1.0.0', 'Hello {{name}}');
    const entry = r.get('my/prompt');
    assert.strictEqual(entry.template, 'Hello {{name}}');
    assert.strictEqual(entry.version, '1.0.0');
    assert.strictEqual(entry.name, 'my/prompt');
  });

  it('returns the latest version when no version arg given', () => {
    const r = new PromptRegistry();
    r.register('p', '1.0.0', 'v1');
    r.register('p', '2.0.0', 'v2');
    assert.strictEqual(r.get('p').version, '2.0.0');
    assert.strictEqual(r.get('p').template, 'v2');
  });

  it('retrieves a specific older version', () => {
    const r = new PromptRegistry();
    r.register('p', '1.0.0', 'v1');
    r.register('p', '2.0.0', 'v2');
    assert.strictEqual(r.get('p', '1.0.0').template, 'v1');
  });

  it('throws for unknown name', () => {
    const r = new PromptRegistry();
    assert.throws(() => r.get('unknown'), /No prompt registered for "unknown"/);
  });

  it('throws for unknown version', () => {
    const r = new PromptRegistry();
    r.register('p', '1.0.0', 'v1');
    assert.throws(() => r.get('p', '9.0.0'), /No prompt registered for "p@9\.0\.0"/);
  });

  it('has() returns true for a registered name', () => {
    const r = new PromptRegistry();
    r.register('p', '1.0.0', 'v1');
    assert.strictEqual(r.has('p'), true);
    assert.strictEqual(r.has('p', '1.0.0'), true);
    assert.strictEqual(r.has('missing'), false);
    assert.strictEqual(r.has('p', '9.0.0'), false);
  });

  it('list() returns all registered entries', () => {
    const r = new PromptRegistry();
    r.register('a', '1.0.0', 'A');
    r.register('b', '1.0.0', 'B');
    assert.strictEqual(r.list().length, 2);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd packages/kernel && npm run build && npm test
```

Expected: compile error or `PromptRegistry` not found.

- [ ] **Step 3: Implement `packages/kernel/src/prompt-registry/index.ts`**

```typescript
export type PromptEntry = { name: string; version: string; template: string };

export class PromptRegistry {
  private readonly store = new Map<string, PromptEntry>(); // `name@version` → entry
  private readonly latest = new Map<string, string>(); // name → latest version

  register(name: string, version: string, template: string): void {
    this.store.set(`${name}@${version}`, { name, version, template });
    this.latest.set(name, version);
  }

  get(name: string, version?: string): PromptEntry {
    const v = version ?? this.latest.get(name);
    if (v === undefined) throw new Error(`No prompt registered for "${name}"`);
    const entry = this.store.get(`${name}@${v}`);
    if (!entry) throw new Error(`No prompt registered for "${name}@${v}"`);
    return entry;
  }

  has(name: string, version?: string): boolean {
    const v = version ?? this.latest.get(name);
    if (v === undefined) return false;
    return this.store.has(`${name}@${v}`);
  }

  list(): PromptEntry[] {
    return [...this.store.values()];
  }
}
```

- [ ] **Step 4: Export from kernel index**

In `packages/kernel/src/index.ts`, add:

```typescript
export * from './prompt-registry/index.js';
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd packages/kernel && npm run build && npm test
```

Expected: all prompt-registry tests pass (plus cache tests still green).

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/prompt-registry/index.ts packages/kernel/test/prompt-registry.test.ts packages/kernel/src/index.ts
git commit -m "feat(kernel): add PromptRegistry — named+versioned prompt store"
```

---

### Task 3: `CachedEmbeddingProvider`

**Files:**
- Create: `packages/kernel/src/retrieval/cached-embedding-provider.ts`
- Create: `packages/kernel/test/cached-embedding-provider.test.ts`
- Modify: `packages/kernel/src/retrieval/index.ts` (add export)

**Interfaces:**
- Consumes: `EmbeddingProvider` from `./contracts.js`, `Cache<string, number[]>` from `../cache/index.js` (Task 1).
- Produces: `CachedEmbeddingProvider` (class implementing `EmbeddingProvider`) — exported from `@buffr/kernel`. Task 5 uses it.

---

- [ ] **Step 1: Write the failing test**

Create `packages/kernel/test/cached-embedding-provider.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCache } from '../src/cache/index.js';
import { CachedEmbeddingProvider } from '../src/retrieval/cached-embedding-provider.js';
import type { EmbeddingProvider } from '../src/retrieval/contracts.js';

function makeStub(calls: string[][]): EmbeddingProvider {
  return {
    id: 'stub',
    dimension: 2,
    async embed(texts: string[]) {
      calls.push([...texts]);
      return texts.map(() => [1, 0]);
    },
  };
}

describe('CachedEmbeddingProvider', () => {
  it('exposes id and dimension from the inner provider', () => {
    const p = new CachedEmbeddingProvider(makeStub([]), new InMemoryCache());
    assert.strictEqual(p.id, 'stub');
    assert.strictEqual(p.dimension, 2);
  });

  it('forwards embed call on cache miss', async () => {
    const calls: string[][] = [];
    const p = new CachedEmbeddingProvider(makeStub(calls), new InMemoryCache());
    const result = await p.embed(['hello']);
    assert.deepStrictEqual(result, [[1, 0]]);
    assert.strictEqual(calls.length, 1);
  });

  it('returns cached result on repeated call for same text', async () => {
    const calls: string[][] = [];
    const p = new CachedEmbeddingProvider(makeStub(calls), new InMemoryCache());
    await p.embed(['hello']);
    const result = await p.embed(['hello']);
    assert.strictEqual(calls.length, 1); // inner called only once
    assert.deepStrictEqual(result, [[1, 0]]);
  });

  it('only sends cache-miss texts to the inner provider in a batch', async () => {
    const calls: string[][] = [];
    const p = new CachedEmbeddingProvider(makeStub(calls), new InMemoryCache());
    await p.embed(['a', 'b']);    // both miss → inner called with ['a', 'b']
    await p.embed(['b', 'c']);   // 'b' hits, 'c' misses → inner called with ['c']
    assert.deepStrictEqual(calls[1], ['c']);
  });

  it('preserves output order when mixing cache hits and misses', async () => {
    const calls: string[][] = [];
    const p = new CachedEmbeddingProvider(makeStub(calls), new InMemoryCache());
    await p.embed(['x', 'y']);
    const result = await p.embed(['x', 'z', 'y']); // x=hit, z=miss, y=hit
    assert.strictEqual(result.length, 3);
    for (const vec of result) assert.deepStrictEqual(vec, [1, 0]);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd packages/kernel && npm run build && npm test
```

Expected: compile error or module not found.

- [ ] **Step 3: Implement `packages/kernel/src/retrieval/cached-embedding-provider.ts`**

```typescript
import type { EmbeddingProvider } from './contracts.js';
import type { Cache } from '../cache/index.js';

export class CachedEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimension: number;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly cache: Cache<string, number[]>,
  ) {
    this.id = inner.id;
    this.dimension = inner.dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results = new Array<number[] | undefined>(texts.length);
    const misses: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const hit = this.cache.get(texts[i]!);
      if (hit !== undefined) {
        results[i] = hit;
      } else {
        misses.push(i);
      }
    }

    if (misses.length > 0) {
      const embedded = await this.inner.embed(misses.map(i => texts[i]!));
      for (let j = 0; j < misses.length; j++) {
        const idx = misses[j]!;
        results[idx] = embedded[j]!;
        this.cache.set(texts[idx]!, embedded[j]!);
      }
    }

    return results as number[][];
  }
}
```

- [ ] **Step 4: Export from retrieval index**

In `packages/kernel/src/retrieval/index.ts`, add:

```typescript
export * from './cached-embedding-provider.js';
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd packages/kernel && npm run build && npm test
```

Expected: all cached-embedding-provider tests pass; cache and prompt-registry tests still green.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/retrieval/cached-embedding-provider.ts packages/kernel/test/cached-embedding-provider.test.ts packages/kernel/src/retrieval/index.ts
git commit -m "feat(kernel): add CachedEmbeddingProvider — batch-aware embedding cache"
```

---

### Task 4: `CachedConnector<P,D>`

**Files:**
- Create: `packages/connectors/src/cached-connector.ts`
- Create: `packages/connectors/test/discovery/cached-connector.test.ts`
- Modify: `packages/connectors/src/index.ts` (add export)

**Interfaces:**
- Consumes: `DataConnector<P,D>`, `ConnectorResult<D>`, `FetchOptions` from `./contracts.js` (internal). Cache is a duck-typed structural interface defined inline — no import from `@buffr/kernel`.
- Produces: `CachedConnector<P,D>` (class implementing `DataConnector<P,D>`) — exported from `@buffr/connectors`. Task 5 wraps each connector with it.

---

- [ ] **Step 1: Write the failing test**

Create `packages/connectors/test/discovery/cached-connector.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CachedConnector } from '../../src/cached-connector.js';

// Minimal in-test cache — no import from @buffr/kernel needed.
function makeCache<V>() {
  const store = new Map<string, { value: V; expiresAt: number | null }>();
  return {
    get(key: string): V | undefined {
      const e = store.get(key);
      if (!e) return undefined;
      if (e.expiresAt !== null && Date.now() > e.expiresAt) { store.delete(key); return undefined; }
      return e.value;
    },
    set(key: string, value: V, ttlMs?: number): void {
      store.set(key, { value, expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : null });
    },
  };
}

function makeConnector<P>(calls: P[]) {
  return {
    id: 'stub',
    async fetch(params: P) {
      calls.push(params);
      return {
        data: `result:${JSON.stringify(params)}`,
        fetchedAt: 'now',
        sourceId: 'stub',
        toEvidence: () => [],
      };
    },
  };
}

describe('CachedConnector', () => {
  it('exposes the inner connector id', () => {
    const c = new CachedConnector(makeConnector([]), makeCache());
    assert.strictEqual(c.id, 'stub');
  });

  it('forwards the first fetch to the inner connector', async () => {
    const calls: object[] = [];
    const c = new CachedConnector(makeConnector(calls), makeCache());
    const result = await c.fetch({ q: 'hello' });
    assert.strictEqual(result.data, 'result:{"q":"hello"}');
    assert.strictEqual(calls.length, 1);
  });

  it('returns cached result on second fetch with same params', async () => {
    const calls: object[] = [];
    const c = new CachedConnector(makeConnector(calls), makeCache());
    await c.fetch({ q: 'hello' });
    const second = await c.fetch({ q: 'hello' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(second.data, 'result:{"q":"hello"}');
  });

  it('calls inner connector for different params', async () => {
    const calls: object[] = [];
    const c = new CachedConnector(makeConnector(calls), makeCache());
    await c.fetch({ q: 'hello' });
    await c.fetch({ q: 'world' });
    assert.strictEqual(calls.length, 2);
  });

  it('calls inner connector again after TTL expires', async () => {
    const calls: object[] = [];
    const c = new CachedConnector(makeConnector(calls), makeCache(), 1); // 1 ms TTL
    await c.fetch({ q: 'hi' });
    await new Promise<void>(r => setTimeout(r, 10));
    await c.fetch({ q: 'hi' });
    assert.strictEqual(calls.length, 2);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd packages/connectors && npm run build && npm test
```

Expected: compile error or module not found.

- [ ] **Step 3: Implement `packages/connectors/src/cached-connector.ts`**

```typescript
import type { DataConnector, ConnectorResult, FetchOptions } from './contracts.js';

// Duck-typed cache slot — no import from @buffr/kernel required.
// InMemoryCache<string, ConnectorResult<D>> satisfies this shape.
type CacheSlot<V> = {
  get(key: string): V | undefined;
  set(key: string, value: V, ttlMs?: number): void;
};

export class CachedConnector<P, D> implements DataConnector<P, D> {
  readonly id: string;

  constructor(
    private readonly inner: DataConnector<P, D>,
    private readonly cache: CacheSlot<ConnectorResult<D>>,
    private readonly ttlMs: number = 60 * 60 * 1000, // 1 hour default
  ) {
    this.id = inner.id;
  }

  async fetch(params: P, options?: FetchOptions): Promise<ConnectorResult<D>> {
    const key = JSON.stringify(params);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const result = await this.inner.fetch(params, options);
    this.cache.set(key, result, this.ttlMs);
    return result;
  }
}
```

- [ ] **Step 4: Export from connectors index**

In `packages/connectors/src/index.ts`, add at the end:

```typescript
export { CachedConnector } from './cached-connector.js';
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd packages/connectors && npm run build && npm test
```

Expected: all cached-connector tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/connectors/src/cached-connector.ts packages/connectors/test/discovery/cached-connector.test.ts packages/connectors/src/index.ts
git commit -m "feat(connectors): add CachedConnector — TTL-based connector result cache"
```

---

### Task 5: Wire prompt registry + caches into session + agent

**Files:**
- Modify: `packages/kernel/src/agents/rag-query-agent.ts` (accept `PromptRegistry`, expose `promptVersion` getter)
- Modify: `src/session.ts` (create registry, wrap providers, add `promptVersion` to `TurnStats`)
- Modify: `src/cli/chat.tsx` (show `promptVersion` in `formatStats` if present)

**Interfaces:**
- Consumes: `PromptRegistry` from `../prompt-registry/index.js` (Task 2), `Cache`/`InMemoryCache` from `../cache/index.js` (Task 1), `CachedEmbeddingProvider` from retrieval (Task 3), `CachedConnector` from connectors (Task 4).
- Produces: `TurnStats.promptVersion?: string`; `RagQueryAgent.promptVersion` getter; every live session turn stamps which routing prompt version was used.

---

- [ ] **Step 1: Update `RagQueryAgentOptions` and `RagQueryAgent`**

In `packages/kernel/src/agents/rag-query-agent.ts`, replace the entire file:

```typescript
// packages/kernel/src/agents/rag-query-agent.ts
import { buildSynthesisInstruction, runAgentLoop } from '../workflow-runtime/run-agent-loop.js';
import { renderPromptTemplate, injectProfile } from './prompt-helpers.js';
import { filterToolsForPolicy } from '../tool-runtime/policy.js';
import { SEARCH_KNOWLEDGE_BASE_TOOL_NAME } from '../retrieval/search-tool.js';
import type { CapabilityTraceSink } from '../tracing.js';
import type { ModelProvider } from '../model-gateway/types.js';
import type { ToolRegistry } from '../tool-runtime/registry.js';
import type { PromptRegistry } from '../prompt-registry/index.js';

export const RAG_QUERY_CAPABILITY_ID = 'rag-query-agent';

const DEFAULT_SYSTEM_TEMPLATE = [
  'You are a personal knowledge assistant.',
  '',
  `Always call the ${SEARCH_KNOWLEDGE_BASE_TOOL_NAME} tool first to retrieve relevant`,
  'passages before answering. Ground every answer in the retrieved chunks and cite',
  'their sources. If the knowledge base does not contain the answer, say so plainly',
  'rather than guessing.',
].join('\n');

const PROFILE_HEADING = '# About the person you are assisting';
const FALLBACK_ANSWER = "I couldn't find anything in the knowledge base to answer that.";

export type RagQueryAgentOptions = {
  model: ModelProvider;
  tools: ToolRegistry;
  profile?: string;
  prompt?: string;
  promptRegistry?: PromptRegistry;
  promptName?: string;
  trace?: CapabilityTraceSink;
  allowedTools?: readonly string[];
};

export class RagQueryAgent {
  private readonly system: string;
  private readonly _promptVersion: string | undefined;

  get promptVersion(): string | undefined {
    return this._promptVersion;
  }

  constructor(private readonly options: RagQueryAgentOptions) {
    let template: string;
    let version: string | undefined;

    if (options.promptRegistry && options.promptName) {
      const entry = options.promptRegistry.get(options.promptName);
      template = entry.template;
      version = entry.version;
    } else {
      template = options.prompt ?? DEFAULT_SYSTEM_TEMPLATE;
    }

    this._promptVersion = version;
    const withProfile = options.profile
      ? injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING })
      : template;
    this.system = renderPromptTemplate(withProfile, {});
  }

  async answer(question: string, runOptions: { signal?: AbortSignal } = {}): Promise<string> {
    const allTools = await this.options.tools.listTools();
    const toolSchemas = filterToolsForPolicy(allTools, {
      capabilityId: RAG_QUERY_CAPABILITY_ID,
      allowedTools: this.options.allowedTools ?? [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],
    });

    const { finalText } = await runAgentLoop({
      capabilityId: RAG_QUERY_CAPABILITY_ID,
      model: this.options.model,
      tools: this.options.tools,
      system: this.system,
      userPrompt: question,
      toolSchemas,
      trace: this.options.trace,
      signal: runOptions.signal,
      maxTurns: 6,
      maxToolCalls: 4,
      synthesisInstruction: buildSynthesisInstruction(
        'Now answer the question directly and concisely, citing the sources you retrieved.',
      ),
    });

    return finalText.trim() || FALLBACK_ANSWER;
  }
}
```

- [ ] **Step 2: Build kernel — verify it compiles**

```bash
cd packages/kernel && npm run build
```

Expected: clean compile, no errors.

- [ ] **Step 3: Update `src/session.ts`**

Replace the entire file:

```typescript
import { config as loadEnv } from 'dotenv';
import {
  OllamaEmbeddingProvider, createRetrievalPipeline, createSearchKnowledgeBaseTool,
  InMemoryToolRegistry, GemmaModelProvider, ContextWindowGuardedProvider, RagQueryAgent,
  createConversationMemory, InMemoryCache, CachedEmbeddingProvider, PromptRegistry,
} from '@buffr/kernel';
import {
  RssConnector, GoogleTrendsConnector, AmazonReviewsConnector,
  BraveSearchConnector, TavilySearchConnector, GoogleSearchConnector,
  CachedConnector,
} from '@buffr/connectors';
import { createFetchRssTool } from './connector-tools/rss-tool.js';
import { createFetchTrendsTool } from './connector-tools/trends-tool.js';
import { createFetchReviewsTool } from './connector-tools/amazon-tool.js';
import { createBraveSearchTool } from './connector-tools/brave-tool.js';
import { createTavilySearchTool } from './connector-tools/tavily-tool.js';
import { createGoogleSearchTool } from './connector-tools/google-tool.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { PgVectorStore } from './pg-vector-store.js';
import { loadProfile } from './profile.js';
import { startConversation, persistMessage, SupabaseTraceSink } from './supabase-trace-sink.js';
import type { CapabilityTraceSink, CapabilityEvent } from '@buffr/kernel';

/**
 * A long-lived chat session: one warm pg pool and one conversation held across
 * every turn (unlike the one-shot `ask` CLI, which opens and closes per call).
 * The agent itself is built once; each `ask()` persists the user turn, runs the
 * agent, and flushes the trajectory into that single conversation.
 *
 * Memory model:
 * - Knowledge (indexed docs) and profile are recalled every turn (RAG + system prompt).
 * - Retrievable conversation memory: after each turn the exchange is embedded into the
 *   SAME vector store (tagged kind=memory), so future turns surface relevant past
 *   exchanges via the existing search_knowledge_base tool — across sessions.
 *   The memory engine lives in @buffr/kernel; buffr only injects its PgVectorStore.
 * - Still missing: sequential in-prompt turn history (RagQueryAgent.answer() treats each
 *   question independently). Retrieval-based recall above gives relevance-based memory
 *   without it.
 */
export type TurnStats = {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  promptVersion?: string;
};
export type AskOptions = {
  onStatus?: (msg: string) => void;
  onTokens?: (delta: { input: number; output: number }) => void;
  onComplete?: (stats: TurnStats) => void;
};

const TOOL_LABELS: Record<string, string> = {
  search_knowledge_base: 'searching knowledge base',
  fetch_rss_feed:        'fetching RSS feed',
  web_search_google:     'searching Google',
  web_search_brave:      'searching Brave',
  web_search_tavily:     'searching Tavily',
  fetch_amazon_reviews:  'fetching Amazon reviews',
  fetch_search_trends:   'fetching search trends',
};

function toolStatusLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? `calling ${toolName}`;
}

export type ChatSession = {
  ask(question: string, opts?: AskOptions): Promise<string>;
  close(): Promise<void>;
};

// Bump when the routing prompt rules change so outputs carry the new version.
const ROUTING_PROMPT_VERSION = '1.0.0';

// 1-hour cache for external connector results.
const CONNECTOR_CACHE_TTL_MS = 60 * 60 * 1000;

export async function createChatSession(): Promise<ChatSession> {
  loadEnv();
  const cfg = loadConfig(process.env);
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');

  const pool = createPool(cfg.databaseUrl);

  // Embedding cache persists for the session lifetime (no TTL) — same model,
  // same text → same vector, so stale-embedding risk is zero within a session.
  const embedCache = new InMemoryCache<string, number[]>();
  const embedder = new CachedEmbeddingProvider(
    new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost }),
    embedCache,
  );

  const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
  const pipeline = createRetrievalPipeline({ embedder, store });
  const searchTool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4, minScore: 0.65 });

  const rssTool    = createFetchRssTool(new CachedConnector(new RssConnector(), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS));
  const trendsTool = createFetchTrendsTool(new CachedConnector(new GoogleTrendsConnector(), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS));
  const amazonTool = createFetchReviewsTool(new CachedConnector(new AmazonReviewsConnector(), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS));
  const braveTool  = cfg.braveApiKey
    ? createBraveSearchTool(new CachedConnector(new BraveSearchConnector(cfg.braveApiKey), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS))
    : null;
  const tavilyTool = cfg.tavilyApiKey
    ? createTavilySearchTool(new CachedConnector(new TavilySearchConnector(cfg.tavilyApiKey), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS))
    : null;
  const googleTool = (cfg.googleApiKey && cfg.googleCx)
    ? createGoogleSearchTool(new CachedConnector(new GoogleSearchConnector(cfg.googleApiKey, cfg.googleCx), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS))
    : null;

  const allToolDefs = [
    searchTool.definition,
    rssTool.definition,
    trendsTool.definition,
    amazonTool.definition,
    ...(braveTool  ? [braveTool.definition]  : []),
    ...(tavilyTool ? [tavilyTool.definition] : []),
    ...(googleTool ? [googleTool.definition] : []),
  ];
  const allToolHandlers: Record<string, typeof searchTool.handler> = {
    [searchTool.definition.name]: searchTool.handler,
    [rssTool.definition.name]:    rssTool.handler,
    [trendsTool.definition.name]: trendsTool.handler,
    [amazonTool.definition.name]: amazonTool.handler,
    ...(braveTool  ? { [braveTool.definition.name]:  braveTool.handler }  : {}),
    ...(tavilyTool ? { [tavilyTool.definition.name]: tavilyTool.handler } : {}),
    ...(googleTool ? { [googleTool.definition.name]: googleTool.handler } : {}),
  };
  const tools = new InMemoryToolRegistry(allToolDefs, allToolHandlers);

  const model = new ContextWindowGuardedProvider(new GemmaModelProvider({ host: cfg.ollamaHost }), { maxTokens: 8192 });
  const profile = await loadProfile(pool, cfg.appId);

  // Retrievable episodic memory over buffr's own store. The engine (embed, tag,
  // recall) lives in @buffr/kernel; buffr injects the PgVectorStore. Sharing the
  // document store means memory surfaces via the existing search_knowledge_base
  // tool — memory chunks live with no documents row, which the dropped FK allows.
  const memory = createConversationMemory({ embedder, store });

  const conversationId = await startConversation(pool, cfg.appId);
  const supabaseTrace = new SupabaseTraceSink({ pool, conversationId });

  // Build routing prompt and register it so each turn carries a promptVersion stamp.
  const webSearchTools = [tavilyTool, braveTool, googleTool].filter(Boolean);
  const primaryWebSearch = webSearchTools[0] ?? null;
  const routingPrompt = [
    'You are a personal knowledge assistant. For EVERY question, always call tools to gather information before answering — never answer from memory alone.',
    '',
    'Available tools:',
    `- ${searchTool.definition.name}: search indexed personal knowledge (journal entries, tasks, nutrition, workouts, habits, past conversations).`,
    `- ${rssTool.definition.name}: fetch live articles from an RSS feed. Known-working feeds:`,
    '    AI/ML news: https://www.artificialintelligence-news.com/feed/',
    '    AI on HN:   https://hnrss.org/frontpage?tags=ai',
    '    Tech (TC):  https://techcrunch.com/tag/artificial-intelligence/feed/',
    '    HN front:   https://hnrss.org/frontpage',
    `- ${amazonTool.definition.name}: fetch product reviews from Amazon by product URL or ASIN.`,
    ...(tavilyTool ? [`- ${tavilyTool.definition.name}: search the live web for factual answers, news, and general knowledge.`] : []),
    ...(braveTool  ? [`- ${braveTool.definition.name}: search the live web for general knowledge and current information.`] : []),
    ...(googleTool ? [`- ${googleTool.definition.name}: search the web using Google Custom Search.`] : []),
    '',
    'Tool usage rules (always follow):',
    `1. ALWAYS call ${searchTool.definition.name} first for any question.`,
    primaryWebSearch
      ? `2. ALWAYS also call ${primaryWebSearch.definition.name} for any question about: companies, people, products, news, current events, or anything that might not be in personal records. Do NOT skip this step even if the knowledge base returned results.`
      : `2. For news or current events, call ${rssTool.definition.name} with a relevant feed URL.`,
    `3. For product reviews, call ${amazonTool.definition.name}.`,
    '4. Synthesize ALL tool results into one answer. Do not stop after just one tool.',
    '5. Cite sources when available.',
    '6. If the knowledge base returns zero relevant results (empty results array), say so clearly.',
    '7. NEVER fabricate information. Only use what the tools returned.',
  ].join('\n');

  const registry = new PromptRegistry();
  registry.register('rag-query-agent/routing', ROUTING_PROMPT_VERSION, routingPrompt);

  // Thin wrapper that intercepts events to forward live status and accumulate
  // token usage to the TUI. Mutable slots are swapped per-ask.
  let currentOnStatus: ((msg: string) => void) | undefined;
  let currentOnTokens: ((delta: { input: number; output: number }) => void) | undefined;
  let currentInputTokens = 0;
  let currentOutputTokens = 0;
  const trace: CapabilityTraceSink = {
    emit(event: CapabilityEvent) {
      if (event.type === 'tool_call_start' && currentOnStatus) {
        currentOnStatus(toolStatusLabel(event.toolName));
      }
      if (event.type === 'model_usage') {
        const deltaIn  = event.inputTokens  ?? 0;
        const deltaOut = event.outputTokens ?? 0;
        currentInputTokens  += deltaIn;
        currentOutputTokens += deltaOut;
        currentOnTokens?.({ input: deltaIn, output: deltaOut });
      }
      supabaseTrace.emit(event);
    },
  };

  const agent = new RagQueryAgent({
    model,
    tools,
    profile,
    trace,
    allowedTools: [
      searchTool.definition.name,
      rssTool.definition.name,
      // trendsTool: google-trends-api scrapes an unofficial endpoint that
      // Google frequently blocks with an HTML response. Re-enable when replaced.
      amazonTool.definition.name,
      ...(braveTool  ? [braveTool.definition.name]  : []),
      ...(tavilyTool ? [tavilyTool.definition.name] : []),
      ...(googleTool ? [googleTool.definition.name] : []),
    ],
    promptRegistry: registry,
    promptName: 'rag-query-agent/routing',
  });

  return {
    async ask(question: string, opts?: AskOptions): Promise<string> {
      currentOnStatus = opts?.onStatus;
      currentOnTokens = opts?.onTokens;
      currentInputTokens = 0;
      currentOutputTokens = 0;
      const startMs = Date.now();
      await persistMessage(pool, conversationId, 'user', question);
      const answer = await agent.answer(question);
      currentOnStatus = undefined;
      currentOnTokens = undefined;
      opts?.onComplete?.({
        durationMs: Date.now() - startMs,
        inputTokens: currentInputTokens,
        outputTokens: currentOutputTokens,
        promptVersion: agent.promptVersion,
      });
      await supabaseTrace.flush();
      // Best-effort: a memory-write failure must not lose the answer the user has.
      try {
        await memory.remember({ conversationId, question, answer });
      } catch {
        // swallow: memory is best-effort, the turn already succeeded
      }
      return answer;
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
```

- [ ] **Step 4: Update `formatStats` in `src/cli/chat.tsx`**

In `src/cli/chat.tsx`, replace the `formatStats` function (lines 9-18):

```typescript
function formatStats(s: TurnStats): string {
  const secs = s.durationMs / 1000;
  const time = secs >= 60
    ? `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`
    : `${secs.toFixed(1)}s`;
  const tok = s.inputTokens + s.outputTokens > 0
    ? ` · ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out`
    : '';
  const pv = s.promptVersion ? ` · prompt ${s.promptVersion}` : '';
  return `${time}${tok}${pv}`;
}
```

- [ ] **Step 5: Build all packages and root — verify everything compiles**

```bash
cd /Users/rein/Public/buffr && npm run build:packages && npm run build
```

Expected: clean compile across all three packages and root source. No TypeScript errors.

- [ ] **Step 6: Run all tests**

```bash
cd packages/kernel && npm test
cd packages/connectors && npm test
```

Expected: all tests pass. (Root has no unit tests for session.ts — the build above is the verification.)

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/agents/rag-query-agent.ts src/session.ts src/cli/chat.tsx
git commit -m "feat: wire PromptRegistry + Cache into session — every turn stamps promptVersion"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|---|---|
| `Cache<K,V>` interface + `InMemoryCache` with TTL | Task 1 |
| `PromptRegistry` — named+versioned, get/list/has | Task 2 |
| `CachedEmbeddingProvider` — batch-aware, hits before miss | Task 3 |
| `CachedConnector<P,D>` — TTL cache, no kernel dep | Task 4 |
| `TurnStats.promptVersion?: string` | Task 5 |
| `RagQueryAgent` accepts `promptRegistry`/`promptName`, exposes `promptVersion` getter | Task 5 |
| `session.ts` wraps embedder + all connectors with cache | Task 5 |
| Routing prompt extracted from IIFE into registry | Task 5 |
| `formatStats` in chat.tsx shows `promptVersion` | Task 5 |
| Tests for all four library files | Tasks 1–4 |

### Placeholder scan

None found — all steps contain actual code.

### Type consistency

- `Cache<K,V>.set(key, value, ttlMs?: number)` — matches the duck-typed `CacheSlot<V>` in `CachedConnector` (`set(key, value, ttlMs?)`) ✓
- `PromptRegistry.get()` returns `{ name, version, template }` — matches what `RagQueryAgent` reads (`.template`, `.version`) ✓
- `EmbeddingProvider.embed(texts: string[]): Promise<number[][]>` — `CachedEmbeddingProvider.embed` matches exactly ✓
- `DataConnector<P,D>.fetch(params, options?)` — `CachedConnector.fetch` matches ✓
- `agent.promptVersion` is `string | undefined` — `TurnStats.promptVersion?: string` accepts it ✓
