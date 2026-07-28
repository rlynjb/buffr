# Supabase DB Knowledge Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npm run index:db` — a CLI command that indexes rows from the `loopd` and `contrl` Supabase schemas into the pgvector knowledge base so the agent can retrieve personal data via `search_knowledge_base`.

**Architecture:** A config file (`src/db-sources.ts`) declares one `DbSource` per table with a SQL query, `toId`, and `toText`. A CLI script (`src/cli/index-db-cmd.ts`) iterates the config, queries each table, and calls `indexDocumentRow`. `src/runtime.ts` gets a minor backward-compatible update to accept an optional `sourceType` string.

**Tech Stack:** TypeScript, `node:test`, `pg`, `@buffr/kernel`, Ollama (nomic-embed-text:v1.5), Supabase Postgres

## Global Constraints

- ESM only: `"type": "module"`, all local imports use `.js` extension; package imports (`@buffr/kernel`, `pg`, `dotenv`) have no extension
- `"module": "NodeNext"` / `"moduleResolution": "NodeNext"`
- Tests use `node:test` (no vitest) — flat in `test/` to match glob `dist/test/*.test.js`
- Test command: `npm test` → `npm run build && node --test --test-concurrency=1 dist/test/*.test.js`
- No new npm dependencies
- YAGNI: no features beyond the spec

---

### Task 1: Data layer — `src/runtime.ts` update + `src/db-sources.ts` + unit tests

**Files:**
- Modify: `src/runtime.ts`
- Create: `src/db-sources.ts`
- Create: `test/db-sources.test.ts`

**Interfaces:**
- Produces for Task 2:
  - `DB_SOURCES: DbSource[]` exported from `src/db-sources.ts`
  - `DbSource` type: `{ schema: string; table: string; query: string; toId: (row: Record<string, unknown>) => string; toText: (row: Record<string, unknown>) => string }`
  - `indexDocumentRow(pool, appId, pipeline, doc: { id, text, sourcePath?, sourceType? })` — updated signature

- [ ] **Step 1: Write the failing tests**

Create `test/db-sources.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DB_SOURCES } from '../src/db-sources.js';

test('DB_SOURCES has 8 entries', () => {
  assert.equal(DB_SOURCES.length, 8);
});

test('loopd.entries serializer', () => {
  const source = DB_SOURCES.find((s) => s.schema === 'loopd' && s.table === 'entries')!;
  const row = { id: 'e1', date: '2024-01-15', text: 'Feeling good today.' };
  assert.equal(source.toId(row), 'loopd/entries/e1');
  assert.equal(source.toText(row), 'Journal entry 2024-01-15: Feeling good today.');
});

test('contrl.sessions serializer — passed', () => {
  const source = DB_SOURCES.find((s) => s.table === 'sessions')!;
  const row = { id: 's1', date: '2024-01-15T10:00:00Z', level: 3, category: 'push', notes: 'Hard session.', passed: true };
  assert.equal(source.toId(row), 'contrl/sessions/s1');
  assert.ok(source.toText(row).includes('passed'));
  assert.ok(source.toText(row).includes('Hard session'));
});

test('contrl.sessions serializer — failed, null notes', () => {
  const source = DB_SOURCES.find((s) => s.table === 'sessions')!;
  const row = { id: 's2', date: '2024-01-16T10:00:00Z', level: 2, category: 'pull', notes: null, passed: false };
  assert.ok(source.toText(row).includes('failed'));
  assert.ok(!source.toText(row).includes('null'));
});

test('contrl.exercises serializer — null notes', () => {
  const source = DB_SOURCES.find((s) => s.table === 'exercises')!;
  const row = { id: 'ex1', name: 'Push-up', category: 'push', level: 1, target_sets: 3, target_reps: 10, notes: null };
  assert.ok(source.toText(row).startsWith('Exercise: Push-up'));
  assert.ok(!source.toText(row).includes('null'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`

Expected: build error — `Cannot find module '../src/db-sources.js'`

- [ ] **Step 3: Update `src/runtime.ts`**

Replace the existing `indexDocumentRow` function with:

```typescript
import pg from 'pg';
import type { RetrievalPipeline } from '@buffr/kernel';

/** Writes the source-of-truth documents row, then indexes its chunks. */
export async function indexDocumentRow(
  pool: pg.Pool,
  appId: string,
  pipeline: RetrievalPipeline,
  doc: { id: string; text: string; sourcePath?: string; sourceType?: string },
): Promise<void> {
  const sourceType = doc.sourceType ?? 'markdown';
  await pool.query(
    `insert into agents.documents (id, app_id, source_type, source_path, content)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update set content = excluded.content, source_path = excluded.source_path`,
    [doc.id, appId, sourceType, doc.sourcePath ?? null, doc.text],
  );
  await pipeline.index({ id: doc.id, text: doc.text });
}
```

- [ ] **Step 4: Create `src/db-sources.ts`**

```typescript
export type DbSource = {
  schema: string;
  table: string;
  query: string;
  toId: (row: Record<string, unknown>) => string;
  toText: (row: Record<string, unknown>) => string;
};

export const DB_SOURCES: DbSource[] = [
  {
    schema: 'loopd',
    table: 'entries',
    query: `SELECT id, date, text FROM loopd.entries WHERE deleted_at IS NULL AND text IS NOT NULL AND text <> ''`,
    toId: (r) => `loopd/entries/${r['id']}`,
    toText: (r) => `Journal entry ${r['date']}: ${r['text']}`,
  },
  {
    schema: 'loopd',
    table: 'todo_meta',
    query: `SELECT todo_id, entry_date, type, stage, expanded_md FROM loopd.todo_meta WHERE deleted_at IS NULL AND expanded_md IS NOT NULL`,
    toId: (r) => `loopd/todo/${r['todo_id']}`,
    toText: (r) => `Task [${r['type']}] (${r['stage']}) on ${r['entry_date']}: ${r['expanded_md']}`,
  },
  {
    schema: 'loopd',
    table: 'nutrition',
    query: `SELECT id, entry_date, name, kcal FROM loopd.nutrition WHERE deleted_at IS NULL`,
    toId: (r) => `loopd/nutrition/${r['id']}`,
    toText: (r) => `Nutrition on ${r['entry_date']}: ${r['name']} (${r['kcal']} kcal)`,
  },
  {
    schema: 'loopd',
    table: 'vlogs',
    query: `SELECT id, date, caption, clip_count FROM loopd.vlogs WHERE deleted_at IS NULL AND caption IS NOT NULL AND caption <> ''`,
    toId: (r) => `loopd/vlogs/${r['id']}`,
    toText: (r) => `Vlog on ${r['date']}: ${r['caption']} (${r['clip_count']} clips)`,
  },
  {
    schema: 'loopd',
    table: 'habits',
    query: `SELECT id, label, cadence_type, time_of_day FROM loopd.habits WHERE (archived IS NOT TRUE) AND deleted_at IS NULL`,
    toId: (r) => `loopd/habits/${r['id']}`,
    toText: (r) => `Habit: ${r['label']} (${r['cadence_type']}, ${r['time_of_day']})`,
  },
  {
    schema: 'contrl',
    table: 'exercises',
    query: `SELECT id, name, category, level, target_sets, target_reps, notes FROM contrl.exercises`,
    toId: (r) => `contrl/exercises/${r['id']}`,
    toText: (r) =>
      `Exercise: ${r['name']} (${r['category']}, level ${r['level']}) — ${r['target_sets']}×${r['target_reps']}. ${r['notes'] ?? ''}`.trimEnd(),
  },
  {
    schema: 'contrl',
    table: 'sessions',
    query: `SELECT id, date, level, category, notes, passed FROM contrl.sessions`,
    toId: (r) => `contrl/sessions/${r['id']}`,
    toText: (r) =>
      `Workout on ${r['date']}: ${r['category']} level ${r['level']}, ${r['passed'] ? 'passed' : 'failed'}. ${r['notes'] ?? ''}`.trimEnd(),
  },
  {
    schema: 'contrl',
    table: 'week_progress',
    query: `SELECT week_start, push_done, pull_done, squat_done FROM contrl.week_progress`,
    toId: (r) => `contrl/week/${r['week_start']}`,
    toText: (r) =>
      `Week of ${r['week_start']}: push=${r['push_done']}, pull=${r['pull_done']}, squat=${r['squat_done']}`,
  },
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`

Expected: all existing tests pass + 5 new `db-sources` tests pass. Smoke test appears as skipped (or passing if `LIVE_SMOKE=1`). Zero failures.

- [ ] **Step 6: Commit**

```bash
git add src/runtime.ts src/db-sources.ts test/db-sources.test.ts
git commit -m "feat: add DbSource config and update indexDocumentRow to accept sourceType"
```

---

### Task 2: CLI — `src/cli/index-db-cmd.ts` + package.json script

**Files:**
- Create: `src/cli/index-db-cmd.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes from Task 1:
  - `DB_SOURCES: DbSource[]` from `'../db-sources.js'`
  - `indexDocumentRow(pool, appId, pipeline, { id, text, sourceType })` from `'../runtime.js'`
- Consumes existing:
  - `OllamaEmbeddingProvider`, `createRetrievalPipeline` from `'@buffr/kernel'`
  - `loadConfig` from `'../config.js'`
  - `createPool` from `'../db.js'`
  - `PgVectorStore` from `'../pg-vector-store.js'`

- [ ] **Step 1: Create `src/cli/index-db-cmd.ts`**

```typescript
import { config as loadEnv } from 'dotenv';
import { OllamaEmbeddingProvider, createRetrievalPipeline } from '@buffr/kernel';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { PgVectorStore } from '../pg-vector-store.js';
import { indexDocumentRow } from '../runtime.js';
import { DB_SOURCES } from '../db-sources.js';

loadEnv();
const cfg = loadConfig(process.env);
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');

const pool = createPool(cfg.databaseUrl);
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });

for (const source of DB_SOURCES) {
  const { rows } = await pool.query(source.query);
  for (const row of rows) {
    await indexDocumentRow(pool, cfg.appId, pipeline, {
      id: source.toId(row),
      text: source.toText(row),
      sourceType: 'db',
    });
  }
  process.stdout.write(`indexed ${source.schema}.${source.table} (${rows.length} rows)\n`);
}

await pool.end();
```

- [ ] **Step 2: Add `index:db` script to `package.json`**

In the `"scripts"` block, add after the `"index"` line:

```json
"index:db": "npm run build && node dist/src/cli/index-db-cmd.js",
```

Full scripts block after the change:

```json
"scripts": {
  "build:packages": "npm run build -w @buffr/contracts && npm run build -w @buffr/kernel && npm run build -w @buffr/connectors",
  "build": "npm run build:packages && tsc -p tsconfig.json",
  "test": "npm run build && node --test --test-concurrency=1 dist/test/*.test.js",
  "test:kernel": "npm run build -w @buffr/kernel && node --test --test-concurrency=1 packages/kernel/dist/test/*.test.js",
  "migrate": "npm run build && node dist/src/migrate.js",
  "index": "npm run build && node dist/src/cli/index-cmd.js",
  "index:db": "npm run build && node dist/src/cli/index-db-cmd.js",
  "eval": "npm run build && node dist/src/cli/eval-cmd.js",
  "chat": "npm run build && bun dist/src/cli/chat.js"
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`

Expected: exits 0, no TypeScript errors.

- [ ] **Step 4: Run `npm run index:db`**

Prerequisite: Ollama running with `nomic-embed-text:v1.5` pulled, `.env` has `DATABASE_URL` set.

Run: `npm run index:db`

Expected output (one line per table, ~1–15 min depending on Ollama speed):
```
indexed loopd.entries (NNN rows)
indexed loopd.todo_meta (NNN rows)
indexed loopd.nutrition (NNN rows)
indexed loopd.vlogs (NNN rows)
indexed loopd.habits (NNN rows)
indexed contrl.exercises (NNN rows)
indexed contrl.sessions (NNN rows)
indexed contrl.week_progress (NNN rows)
```

If you see a Postgres error like `relation "loopd.entries" does not exist`, your Supabase user may need `USAGE` permission on those schemas: `GRANT USAGE ON SCHEMA loopd TO postgres; GRANT SELECT ON ALL TABLES IN SCHEMA loopd TO postgres;` (and same for `contrl`).

- [ ] **Step 5: Commit**

```bash
git add src/cli/index-db-cmd.ts package.json
git commit -m "feat: add index:db CLI command to index Supabase schemas into knowledge base"
```
