# Laptop → Supabase Graduation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Graduate the buffr laptop brain from an in-memory RAG pipeline to persistent Supabase pgvector (the `reindb` database, shared `agents` schema), single-device.

**Architecture:** A new Node/TypeScript project in **buffr** that consumes the already-built `@aptkit/*` packages as local dependencies. A `PgVectorStore` implements aptkit's `VectorStore` against pgvector; a `SupabaseTraceSink` persists conversations; an `index`/`ask`/`eval` CLI wires aptkit's Gemma provider + retrieval + `RagQueryAgent` against Postgres. Direct `node-postgres`, no Edge Functions.

**Tech Stack:** TypeScript (ESM, NodeNext), node:test, `pg` (node-postgres), `dotenv`, aptkit packages, Ollama (Gemma2:9b + nomic-embed-text:v1.5).

**Spec:** `docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`

## Global Constraints

- ESM only: `"type": "module"`, `module`/`moduleResolution` = `NodeNext`.
- Tests: `node:test` + `node:assert/strict`; build with `tsc`; run `node --test dist/test/*.test.js`.
- aptkit stays **untouched** — buffr only imports it. aptkit must be built first (`cd ../aptkit && npm run build`).
- Embedding dimension is **768** (nomic-embed-text:v1.5); `vector(768)` everywhere. A dimension mismatch must throw, never silently truncate.
- Schema is `agents` in database `reindb`; every table carries `app_id` (default `'laptop'`); **no RLS this phase**.
- Integration tests that need Postgres are **gated on `process.env.DATABASE_URL`** and SKIP when unset — never fail the default run for a missing DB.
- `app_id` comes from `AGENT_APP_ID` env (default `'laptop'`); schema from `AGENT_DB_SCHEMA` (default `'agents'`).
- Secrets live in `.env` (gitignored). Never commit real creds.
- Chunk ids and document ids are aptkit's deterministic ids: chunk id = `"<docId>#<index>"`, document id = `docId`.

**Local Postgres for TDD:** Tasks 2+ need a live pgvector. Use either Supabase local (`supabase start`) or Docker:
```bash
docker run -d --name reindb-dev -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg16
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
```
Set `DATABASE_URL` in your shell (or `.env`) before doing the DB tasks' TDD.

---

### Task 1: buffr project scaffold + aptkit consumption + env/db helpers

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/config.ts`, `src/db.ts`, `test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(): { databaseUrl?: string; appId: string; schema: string; ollamaHost: string }`; `createPool(databaseUrl: string): Pool`.

- [ ] **Step 1: Create `package.json`** — lists every `@aptkit/*` package buffr touches (transitively) as `file:` deps so their internal `0.0.0` refs resolve to siblings.

```json
{
  "name": "buffr-laptop",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test --test-concurrency=1 dist/test/*.test.js",
    "migrate": "npm run build && node dist/src/migrate.js",
    "index": "npm run build && node dist/src/cli/index-cmd.js",
    "ask": "npm run build && node dist/src/cli/ask-cmd.js",
    "eval": "npm run build && node dist/src/cli/eval-cmd.js"
  },
  "dependencies": {
    "@aptkit/agent-rag-query": "file:../aptkit/packages/agents/rag-query",
    "@aptkit/context": "file:../aptkit/packages/context",
    "@aptkit/evals": "file:../aptkit/packages/evals",
    "@aptkit/prompts": "file:../aptkit/packages/prompts",
    "@aptkit/provider-gemma": "file:../aptkit/packages/providers/gemma",
    "@aptkit/provider-local": "file:../aptkit/packages/providers/local",
    "@aptkit/retrieval": "file:../aptkit/packages/retrieval",
    "@aptkit/runtime": "file:../aptkit/packages/runtime",
    "@aptkit/tools": "file:../aptkit/packages/tools",
    "dotenv": "^16.4.0",
    "pg": "^8.11.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/pg": "^8.11.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": ".",
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Build aptkit, then install**

Run: `cd ../aptkit && npm run build && cd ../buffr && npm install`
Expected: install completes; `node_modules/@aptkit/retrieval` exists.

- [ ] **Step 4: Write the failing test** — `test/config.test.ts`

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('defaults appId, schema, and ollama host when env is sparse', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.appId, 'laptop');
    assert.equal(cfg.schema, 'agents');
    assert.equal(cfg.ollamaHost, 'http://localhost:11434');
    assert.equal(cfg.databaseUrl, undefined);
  });

  it('reads overrides from the provided env', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgres://x', AGENT_APP_ID: 'buffr', AGENT_DB_SCHEMA: 'agents2' });
    assert.equal(cfg.databaseUrl, 'postgres://x');
    assert.equal(cfg.appId, 'buffr');
    assert.equal(cfg.schema, 'agents2');
  });
});
```

- [ ] **Step 5: Run test, verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 6: Implement `src/config.ts`**

```ts
export type Config = {
  databaseUrl?: string;
  appId: string;
  schema: string;
  ollamaHost: string;
};

/** Pure: env in, config out. The CLI passes process.env; tests pass a fixture. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    appId: env.AGENT_APP_ID || 'laptop',
    schema: env.AGENT_DB_SCHEMA || 'agents',
    ollamaHost: env.OLLAMA_HOST || 'http://localhost:11434',
  };
}
```

- [ ] **Step 7: Implement `src/db.ts`**

```ts
import pg from 'pg';

/** A pg Pool for reindb. Callers load DATABASE_URL via dotenv before this. */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}
```

- [ ] **Step 8: Run tests, verify pass**

Run: `npm test`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json src/config.ts src/db.ts test/config.test.ts package-lock.json
git commit -m "Scaffold buffr laptop project + aptkit file deps + config/db helpers"
```

---

### Task 2: `agents` schema migration

**Files:**
- Create: `sql/001_agents_schema.sql`, `src/migrate.ts`, `test/migrate.test.ts`

**Interfaces:**
- Produces: `runMigration(pool: Pool, sql: string): Promise<void>`; the `agents` schema with `documents/chunks/conversations/messages/profiles` + HNSW index.

- [ ] **Step 1: Create `sql/001_agents_schema.sql`** — copy the schema verbatim from the spec.

```sql
create extension if not exists vector;
create schema if not exists agents;

create table if not exists agents.documents (
  id text primary key,
  app_id text not null default 'laptop',
  source_type text not null,
  source_path text,
  content text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists agents.chunks (
  id text primary key,
  -- Soft link to documents.id (no FK): the VectorStore contract upserts chunks
  -- with no notion of a documents row, so a hard FK would break drop-in parity.
  document_id text,
  app_id text not null default 'laptop',
  chunk_index int not null,
  content text not null,
  embedding vector(768) not null,
  embedding_model text not null default 'nomic-embed-text:v1.5',
  meta jsonb not null default '{}'
);
-- Drop the FK on databases migrated before this change (idempotent).
alter table agents.chunks drop constraint if exists chunks_document_id_fkey;
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_app_id on agents.chunks (app_id);

create table if not exists agents.conversations (
  id uuid primary key default gen_random_uuid(),
  app_id text not null default 'laptop',
  user_id text,
  agent_name text not null default 'rag-query-agent',
  created_at timestamptz not null default now()
);

create table if not exists agents.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references agents.conversations(id) on delete cascade,
  role text not null,
  content text not null default '',
  tool_calls jsonb,
  tool_results jsonb,
  model text,
  tokens_used int,
  created_at timestamptz not null default now()
);

create table if not exists agents.profiles (
  id uuid primary key default gen_random_uuid(),
  app_id text not null default 'laptop',
  user_id text,
  content text not null,
  updated_at timestamptz not null default now()
);
```

- [ ] **Step 2: Write the failing test** — `test/migrate.test.ts` (gated on `DATABASE_URL`).

```ts
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { runMigration } from '../src/migrate.js';

const url = process.env.DATABASE_URL;

describe('agents schema migration', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(() => { pool = createPool(url!); });
  after(async () => { await pool.end(); });

  it('creates the agents tables idempotently', async () => {
    const sql = await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8');
    await runMigration(pool, sql);
    await runMigration(pool, sql); // idempotent — runs twice without error
    const { rows } = await pool.query(
      `select table_name from information_schema.tables where table_schema = 'agents' order by table_name`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ['chunks', 'conversations', 'documents', 'messages', 'profiles']) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/migrate.js'` (or SKIP if `DATABASE_URL` unset — set it first, see header).

- [ ] **Step 4: Implement `src/migrate.ts`**

```ts
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

/** Runs a SQL script in one transaction. */
export async function runMigration(pool: pg.Pool, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// CLI entry: `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  const cfg = loadConfig(process.env);
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');
  const pool = createPool(cfg.databaseUrl);
  const sql = await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8');
  await runMigration(pool, sql);
  await pool.end();
  process.stdout.write('migration applied\n');
}
```

- [ ] **Step 5: Run test, verify pass** (with `DATABASE_URL` set)

Run: `npm test`
Expected: PASS (migration test).

- [ ] **Step 6: Commit**

```bash
git add sql/001_agents_schema.sql src/migrate.ts test/migrate.test.ts
git commit -m "Add agents schema migration + runner"
```

---

### Task 3: PgVectorStore (implements aptkit's VectorStore)

**Files:**
- Create: `src/pg-vector-store.ts`, `test/pg-vector-store.test.ts`

**Interfaces:**
- Consumes: aptkit `VectorStore` contract — `{ dimension: number; upsert(chunks: { id; vector; meta }[]): Promise<void>; search(vector: number[], k: number): Promise<{ id; score; meta }[]> }`.
- Produces: `class PgVectorStore implements VectorStore` with constructor `{ pool: Pool; appId?: string; embeddingModel?: string; dimension?: number }`.

- [ ] **Step 1: Write the failing test** — `test/pg-vector-store.test.ts` (gated on `DATABASE_URL`). Mirrors the contract `InMemoryVectorStore` passes.

```ts
import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { runMigration } from '../src/migrate.js';
import { PgVectorStore } from '../src/pg-vector-store.js';

const url = process.env.DATABASE_URL;

describe('PgVectorStore', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(async () => {
    pool = createPool(url!);
    const sql = await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8');
    await runMigration(pool, sql);
  });
  beforeEach(async () => {
    await pool.query("delete from agents.chunks where app_id = 'test'");
  });
  after(async () => { await pool.end(); });

  function vec(seed: number): number[] {
    const v = new Array(768).fill(0);
    v[seed] = 1;
    return v;
  }

  it('upserts and ranks the planted chunk on top', async () => {
    const store = new PgVectorStore({ pool, appId: 'test' });
    await store.upsert([
      { id: 'planted#0', vector: vec(5), meta: { docId: 'planted', chunkIndex: 0, text: 'the planted passage' } },
      { id: 'other#0', vector: vec(200), meta: { docId: 'other', chunkIndex: 0, text: 'unrelated passage' } },
    ]);
    const hits = await store.search(vec(5), 2);
    assert.equal(hits[0]?.id, 'planted#0');
    assert.equal(hits[0]?.meta.text, 'the planted passage');
    assert.ok(hits[0]!.score >= hits[1]!.score);
  });

  it('throws on a dimension mismatch', async () => {
    const store = new PgVectorStore({ pool, appId: 'test' });
    await assert.rejects(() => store.upsert([{ id: 'x#0', vector: [1, 2, 3], meta: {} }]), /dimension/);
    await assert.rejects(() => store.search([1, 2, 3], 1), /dimension/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/pg-vector-store.js'`.

- [ ] **Step 3: Implement `src/pg-vector-store.ts`**

```ts
import pg from 'pg';
import type { VectorStore } from '@aptkit/retrieval';

type Chunk = { id: string; vector: number[]; meta: Record<string, unknown> };
type Hit = { id: string; score: number; meta: Record<string, unknown> };

export type PgVectorStoreOptions = {
  pool: pg.Pool;
  appId?: string;
  embeddingModel?: string;
  dimension?: number;
};

/** Serialize a JS number[] into pgvector's text literal: [0.1,0.2,...]. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

export class PgVectorStore implements VectorStore {
  readonly dimension: number;
  private readonly pool: pg.Pool;
  private readonly appId: string;
  private readonly embeddingModel: string;

  constructor(opts: PgVectorStoreOptions) {
    this.pool = opts.pool;
    this.appId = opts.appId ?? 'laptop';
    this.embeddingModel = opts.embeddingModel ?? 'nomic-embed-text:v1.5';
    this.dimension = opts.dimension ?? 768;
  }

  private assertDim(v: number[]): void {
    if (v.length !== this.dimension) {
      throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
    }
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    for (const c of chunks) this.assertDim(c.vector);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const c of chunks) {
        const docId = typeof c.meta.docId === 'string' ? c.meta.docId : null;
        const chunkIndex = typeof c.meta.chunkIndex === 'number' ? c.meta.chunkIndex : 0;
        const content = typeof c.meta.text === 'string' ? c.meta.text : '';
        await client.query(
          `insert into agents.chunks (id, document_id, app_id, chunk_index, content, embedding, embedding_model, meta)
           values ($1, $2, $3, $4, $5, $6::vector, $7, $8)
           on conflict (id) do update set
             document_id = excluded.document_id, app_id = excluded.app_id,
             chunk_index = excluded.chunk_index, content = excluded.content,
             embedding = excluded.embedding, embedding_model = excluded.embedding_model,
             meta = excluded.meta`,
          [c.id, docId, this.appId, chunkIndex, content, toVectorLiteral(c.vector), this.embeddingModel, c.meta],
        );
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async search(vector: number[], k: number): Promise<Hit[]> {
    this.assertDim(vector);
    // <=> is cosine DISTANCE; cosine similarity score = 1 - distance.
    const { rows } = await this.pool.query(
      `select id, content, chunk_index, document_id, meta,
              1 - (embedding <=> $1::vector) as score
       from agents.chunks
       where app_id = $2
       order by embedding <=> $1::vector
       limit $3`,
      [toVectorLiteral(vector), this.appId, k],
    );
    // Rebuild the in-memory meta shape so the search_knowledge_base tool's citations work.
    return rows.map((r) => ({
      id: r.id,
      score: Number(r.score),
      meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
    }));
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: PASS (both PgVectorStore tests).

- [ ] **Step 5: Commit**

```bash
git add src/pg-vector-store.ts test/pg-vector-store.test.ts
git commit -m "Add PgVectorStore implementing aptkit VectorStore over pgvector"
```

---

### Task 4: `index` CLI — write documents + chunks to Postgres

**Files:**
- Create: `src/cli/index-cmd.ts`, `src/runtime.ts`, `test/runtime.test.ts`

**Interfaces:**
- Consumes: aptkit `createRetrievalPipeline`, `OllamaEmbeddingProvider`; `PgVectorStore`.
- Produces: `buildPipeline(pool, cfg)`; `indexMarkdownFile(pool, cfg, path)` → writes one `agents.documents` row then calls `pipeline.index`.

- [ ] **Step 1: Write the failing test** — `test/runtime.test.ts` (gated on `DATABASE_URL`; uses a FAKE embedder injected so no Ollama needed).

```ts
import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { runMigration } from '../src/migrate.js';
import { indexDocumentRow } from '../src/runtime.js';
import { PgVectorStore } from '../src/pg-vector-store.js';
import { createRetrievalPipeline, type EmbeddingProvider } from '@aptkit/retrieval';

const url = process.env.DATABASE_URL;
const fakeEmbedder: EmbeddingProvider = {
  id: 'fake', dimension: 768,
  async embed(texts) { return texts.map(() => { const v = new Array(768).fill(0); v[1] = 1; return v; }); },
};

describe('indexDocumentRow', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(async () => {
    pool = createPool(url!);
    await runMigration(pool, await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8'));
  });
  beforeEach(async () => {
    await pool.query("delete from agents.documents where app_id = 'test'");
  });
  after(async () => { await pool.end(); });

  it('writes a documents row and its chunks', async () => {
    const store = new PgVectorStore({ pool, appId: 'test' });
    const pipeline = createRetrievalPipeline({ embedder: fakeEmbedder, store });
    await indexDocumentRow(pool, 'test', pipeline, { id: 'notes/a', text: 'hello world from notes', sourcePath: 'notes/a.md' });

    const docs = await pool.query("select id from agents.documents where id = 'notes/a'");
    assert.equal(docs.rowCount, 1);
    const chunks = await pool.query("select id from agents.chunks where document_id = 'notes/a'");
    assert.ok(chunks.rowCount! >= 1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/runtime.js'`.

- [ ] **Step 3: Implement `src/runtime.ts`**

```ts
import pg from 'pg';
import type { RetrievalPipeline } from '@aptkit/retrieval';

/** Writes the source-of-truth documents row, then indexes its chunks. */
export async function indexDocumentRow(
  pool: pg.Pool,
  appId: string,
  pipeline: RetrievalPipeline,
  doc: { id: string; text: string; sourcePath?: string },
): Promise<void> {
  await pool.query(
    `insert into agents.documents (id, app_id, source_type, source_path, content)
     values ($1, $2, 'markdown', $3, $4)
     on conflict (id) do update set content = excluded.content, source_path = excluded.source_path`,
    [doc.id, appId, doc.sourcePath ?? null, doc.text],
  );
  await pipeline.index({ id: doc.id, text: doc.text });
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Implement `src/cli/index-cmd.ts`** (the `npm run index <path...>` entry; reads markdown files, embeds via real Ollama).

```ts
import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { OllamaEmbeddingProvider, createRetrievalPipeline } from '@aptkit/retrieval';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { PgVectorStore } from '../pg-vector-store.js';
import { indexDocumentRow } from '../runtime.js';

loadEnv();
const cfg = loadConfig(process.env);
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error('usage: npm run index -- <file.md> [more.md...]');

const pool = createPool(cfg.databaseUrl);
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });

for (const path of paths) {
  const text = await readFile(path, 'utf8');
  await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), text, sourcePath: path });
  process.stdout.write(`indexed ${path}\n`);
}
await pool.end();
```

- [ ] **Step 6: Commit**

```bash
git add src/runtime.ts src/cli/index-cmd.ts test/runtime.test.ts
git commit -m "Add index CLI: write documents + chunks to Postgres"
```

---

### Task 5: SupabaseTraceSink — persist conversations + messages

**Files:**
- Create: `src/supabase-trace-sink.ts`, `test/supabase-trace-sink.test.ts`

**Interfaces:**
- Consumes: aptkit `CapabilityTraceSink` (`{ emit(event): void }`); events `step` (role `assistant`, `content`), `tool_call_end` (`toolName`, `result`, `durationMs`).
- Produces: `startConversation(pool, appId): Promise<string>` (returns conversation id); `class SupabaseTraceSink implements CapabilityTraceSink` constructed with `{ pool, conversationId }`; `persistMessage(pool, conversationId, role, content, extra?)`.

- [ ] **Step 1: Write the failing test** — `test/supabase-trace-sink.test.ts` (gated on `DATABASE_URL`).

```ts
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { runMigration } from '../src/migrate.js';
import { startConversation, SupabaseTraceSink } from '../src/supabase-trace-sink.js';

const url = process.env.DATABASE_URL;

describe('SupabaseTraceSink', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(async () => {
    pool = createPool(url!);
    await runMigration(pool, await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8'));
  });
  after(async () => { await pool.end(); });

  it('persists assistant steps and tool results as messages', async () => {
    const conversationId = await startConversation(pool, 'test');
    const sink = new SupabaseTraceSink({ pool, conversationId });
    sink.emit({ type: 'step', capabilityId: 'rag', role: 'assistant', content: 'thinking out loud', timestamp: '' } as never);
    sink.emit({ type: 'tool_call_end', capabilityId: 'rag', toolName: 'search_knowledge_base', result: { results: [] }, durationMs: 5, timestamp: '' } as never);
    await sink.flush();

    const { rows } = await pool.query(
      'select role from agents.messages where conversation_id = $1 order by created_at', [conversationId]);
    const roles = rows.map((r) => r.role);
    assert.ok(roles.includes('assistant'));
    assert.ok(roles.includes('tool'));
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/supabase-trace-sink.js'`.

- [ ] **Step 3: Implement `src/supabase-trace-sink.ts`** — emit is sync (the aptkit interface), so queue writes and expose `flush()`.

```ts
import pg from 'pg';
import type { CapabilityTraceSink, CapabilityEvent } from '@aptkit/runtime';

export async function startConversation(pool: pg.Pool, appId: string, agentName = 'rag-query-agent'): Promise<string> {
  const { rows } = await pool.query(
    'insert into agents.conversations (app_id, agent_name) values ($1, $2) returning id', [appId, agentName]);
  return rows[0].id as string;
}

export async function persistMessage(
  pool: pg.Pool, conversationId: string, role: string, content: string,
  extra?: { toolResults?: unknown; model?: string },
): Promise<void> {
  await pool.query(
    `insert into agents.messages (conversation_id, role, content, tool_results, model)
     values ($1, $2, $3, $4, $5)`,
    [conversationId, role, content, extra?.toolResults ?? null, extra?.model ?? null],
  );
}

/** Captures the agent's trajectory. emit() is sync (aptkit's contract); writes
 *  are queued and awaited via flush() after the run. */
export class SupabaseTraceSink implements CapabilityTraceSink {
  private readonly pending: Promise<void>[] = [];
  constructor(private readonly opts: { pool: pg.Pool; conversationId: string }) {}

  emit(event: CapabilityEvent): void {
    const { pool, conversationId } = this.opts;
    if (event.type === 'step' && event.role === 'assistant' && event.content) {
      this.pending.push(persistMessage(pool, conversationId, 'assistant', event.content));
    } else if (event.type === 'tool_call_end') {
      this.pending.push(
        persistMessage(pool, conversationId, 'tool', event.toolName, { toolResults: event.result }));
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.pending);
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/supabase-trace-sink.ts test/supabase-trace-sink.test.ts
git commit -m "Add SupabaseTraceSink for conversation/trajectory persistence"
```

---

### Task 6: `ask` CLI — RagQueryAgent over Postgres + profile + trajectory

**Files:**
- Create: `src/cli/ask-cmd.ts`, `src/profile.ts`, `test/profile.test.ts`

**Interfaces:**
- Consumes: aptkit `RagQueryAgent`, `GemmaModelProvider`, `ContextWindowGuardedProvider`, `OllamaEmbeddingProvider`, `createRetrievalPipeline`, `createSearchKnowledgeBaseTool`, `InMemoryToolRegistry`; `PgVectorStore`, `SupabaseTraceSink`, `startConversation`, `persistMessage`.
- Produces: `loadProfile(pool, appId): Promise<string>`.

- [ ] **Step 1: Write the failing test** — `test/profile.test.ts` (gated on `DATABASE_URL`).

```ts
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { runMigration } from '../src/migrate.js';
import { loadProfile } from '../src/profile.js';

const url = process.env.DATABASE_URL;

describe('loadProfile', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(async () => {
    pool = createPool(url!);
    await runMigration(pool, await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8'));
    await pool.query("delete from agents.profiles where app_id = 'test'");
  });
  after(async () => { await pool.end(); });

  it('returns the stored profile content, or empty string when none', async () => {
    assert.equal(await loadProfile(pool, 'test'), '');
    await pool.query("insert into agents.profiles (app_id, content) values ('test', 'I prefer terse answers.')");
    assert.match(await loadProfile(pool, 'test'), /terse/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/profile.js'`.

- [ ] **Step 3: Implement `src/profile.ts`**

```ts
import pg from 'pg';

/** Reads the most recent profile (me.md) for an app, or '' if none stored. */
export async function loadProfile(pool: pg.Pool, appId: string): Promise<string> {
  const { rows } = await pool.query(
    'select content from agents.profiles where app_id = $1 order by updated_at desc limit 1', [appId]);
  return rows[0]?.content ?? '';
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Implement `src/cli/ask-cmd.ts`** (wires everything; real Gemma + Ollama).

```ts
import { config as loadEnv } from 'dotenv';
import { OllamaEmbeddingProvider, createRetrievalPipeline, createSearchKnowledgeBaseTool } from '@aptkit/retrieval';
import { InMemoryToolRegistry } from '@aptkit/tools';
import { GemmaModelProvider } from '@aptkit/provider-gemma';
import { ContextWindowGuardedProvider } from '@aptkit/provider-local';
import { RagQueryAgent } from '@aptkit/agent-rag-query';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { PgVectorStore } from '../pg-vector-store.js';
import { loadProfile } from '../profile.js';
import { startConversation, persistMessage, SupabaseTraceSink } from '../supabase-trace-sink.js';

loadEnv();
const cfg = loadConfig(process.env);
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');
const question = process.argv.slice(2).join(' ');
if (!question) throw new Error('usage: npm run ask -- "your question"');

const pool = createPool(cfg.databaseUrl);
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
const tools = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });

const model = new ContextWindowGuardedProvider(new GemmaModelProvider({ host: cfg.ollamaHost }), { maxTokens: 8192 });
const profile = await loadProfile(pool, cfg.appId);

const conversationId = await startConversation(pool, cfg.appId);
await persistMessage(pool, conversationId, 'user', question);
const trace = new SupabaseTraceSink({ pool, conversationId });

const agent = new RagQueryAgent({ model, tools, profile, trace });
const answer = await agent.answer(question);
await trace.flush();

process.stdout.write(`\n${answer}\n`);
await pool.end();
```

- [ ] **Step 6: Commit**

```bash
git add src/profile.ts src/cli/ask-cmd.ts test/profile.test.ts
git commit -m "Add ask CLI: RagQueryAgent over Postgres with profile + trajectory persistence"
```

---

### Task 7: `eval` CLI — precision@k over the pg corpus

**Files:**
- Create: `src/cli/eval-cmd.ts`, `eval/queries.json`

**Interfaces:**
- Consumes: aptkit `scorePrecisionAtK`, `scoreRecallAtK`; `PgVectorStore`, `OllamaEmbeddingProvider`, `createRetrievalPipeline`.

- [ ] **Step 1: Create `eval/queries.json`** — a labeled set over whatever corpus you indexed (edit doc ids to match your `index` run).

```json
[
  { "query": "how do vector embeddings work", "relevant": ["embeddings.md"] },
  { "query": "how do I bake bread", "relevant": ["bread.md"] }
]
```

- [ ] **Step 2: Implement `src/cli/eval-cmd.ts`** (no unit test — it's a reporting script over real data; correctness of the scorers is already covered by aptkit's evals tests).

```ts
import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { OllamaEmbeddingProvider, createRetrievalPipeline } from '@aptkit/retrieval';
import { scorePrecisionAtK, scoreRecallAtK } from '@aptkit/evals';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { PgVectorStore } from '../pg-vector-store.js';

loadEnv();
const cfg = loadConfig(process.env);
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');

const pool = createPool(cfg.databaseUrl);
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });

const queries: { query: string; relevant: string[] }[] = JSON.parse(
  await readFile(new URL('../../../eval/queries.json', import.meta.url), 'utf8'));

const K = 3;
let p1 = 0, rk = 0;
for (const { query, relevant } of queries) {
  const hits = await pipeline.query(query, K);
  const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];
  p1 += scorePrecisionAtK(docs, new Set(relevant), 1).score;
  rk += scoreRecallAtK(docs, new Set(relevant), K).score;
  process.stdout.write(`${query.padEnd(40)} P@1 ${scorePrecisionAtK(docs, new Set(relevant), 1).score.toFixed(2)}\n`);
}
process.stdout.write(`\nmean P@1 ${(p1 / queries.length).toFixed(2)}  mean R@${K} ${(rk / queries.length).toFixed(2)}\n`);
await pool.end();
```

- [ ] **Step 3: Manual end-to-end verification** (real Ollama + reindb)

Run:
```bash
npm run migrate
npm run index -- path/to/some-notes/*.md
npm run ask -- "a question your notes answer"
npm run eval
```
Expected: `ask` prints a grounded answer; `agents.messages` has rows for the conversation; `eval` prints precision numbers.

- [ ] **Step 4: Commit**

```bash
git add src/cli/eval-cmd.ts eval/queries.json
git commit -m "Add eval CLI: precision@k over the pg corpus"
```

---

## Self-Review

**Spec coverage:**
- Schema (`agents`, forward-compat, HNSW) → Task 2 ✓
- PgVectorStore (contract parity, meta reconstruction, dimension guard) → Task 3 ✓
- Direct `pg` connection → Tasks 1, 3 ✓
- SupabaseTraceSink (trajectory capture) → Task 5 ✓
- Profile from `agents.profiles` → Task 6 ✓
- `index` / `ask` / `eval` CLI → Tasks 4, 6, 7 ✓
- DATABASE_URL-gated integration tests → Tasks 2–6 ✓
- buffr consumes aptkit untouched → Task 1 ✓
- Reindex (named operation) → **deferred to a follow-up task** (spec lists it as first-class but not required for the done-criteria; add when an embedder swap is actually needed).

**Type consistency:** `VectorStore.search` returns `{ id, score, meta }` with `meta` carrying `docId`/`chunkIndex`/`text` (Task 3) — matches what `createSearchKnowledgeBaseTool` reads (aptkit) and what the `ask` CLI relies on (Task 6). `startConversation` → `conversationId: string` consumed by `SupabaseTraceSink` and `persistMessage` (Tasks 5, 6). Consistent.

**Placeholder scan:** no TBD/TODO; every code step is complete. The only intentionally editable content is `eval/queries.json` (user data).

**Note on reindex:** the spec calls reindex "first-class." It's omitted from the done-criteria tasks because nothing swaps the embedder in this phase. Flagging rather than hiding — add a `reindex(embedder)` task when changing `embedding_model`.

**As-built notes (this plan reflects them inline):** the chunks→documents FK was dropped (it broke `VectorStore` parity); `esModuleInterop` and `--test-concurrency=1` were required; `eval-cmd` reads `../../../eval/...`. Two aptkit-side fixes were also needed for the live run with Gemma — a `minTopK` floor and `search_knowledge_base` ignoring hallucinated filter keys (both in `@aptkit/retrieval`). See the spec's "As-built deviations".
