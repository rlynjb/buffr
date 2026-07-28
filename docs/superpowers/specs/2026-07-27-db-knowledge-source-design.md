# Supabase DB Knowledge Source Design

**Date:** 2026-07-27
**Status:** Approved

## Goal

Index rows from the `loopd` and `contrl` Supabase schemas into the pgvector knowledge base so the agent can retrieve personal journal entries, tasks, nutrition logs, habits, vlog captions, and fitness data via `search_knowledge_base`.

## Architecture

Config-driven (Option A). A new `src/db-sources.ts` file declares one `DbSource` per table — each with a SQL query, a `toId(row)` function, and a `toText(row)` function. A new `src/cli/index-db-cmd.ts` CLI reads the config, queries each table, serializes every row to text, and calls `indexDocumentRow`. One command re-indexes everything: `npm run index:db`.

`src/runtime.ts` gets a minor update: `indexDocumentRow` accepts an optional `sourceType` string (defaults to `'markdown'`) so DB rows are stored with `source_type: 'db'` in `agents.documents`.

## New Files

```
src/db-sources.ts          ← DbSource config for all 8 tables
src/cli/index-db-cmd.ts    ← CLI: query → serialize → indexDocumentRow
```

## Modified Files

```
src/runtime.ts             ← add sourceType?: string to doc param
package.json               ← add "index:db" script
```

## DbSource Interface

```typescript
type DbSource = {
  schema: string;
  table: string;
  query: string;              // full SQL, including WHERE filters
  toId: (row: Record<string, unknown>) => string;
  toText: (row: Record<string, unknown>) => string;
};
```

## Table Config (`src/db-sources.ts`)

### loopd.entries
```sql
SELECT id, date, text FROM loopd.entries
WHERE deleted_at IS NULL AND text IS NOT NULL AND text <> ''
```
- `toId`: `loopd/entries/${row.id}`
- `toText`: `Journal entry ${row.date}: ${row.text}`

### loopd.todo_meta
```sql
SELECT todo_id, entry_date, type, stage, expanded_md FROM loopd.todo_meta
WHERE deleted_at IS NULL AND expanded_md IS NOT NULL
```
- `toId`: `loopd/todo/${row.todo_id}`
- `toText`: `Task [${row.type}] (${row.stage}) on ${row.entry_date}: ${row.expanded_md}`

### loopd.nutrition
```sql
SELECT id, entry_date, name, kcal FROM loopd.nutrition
WHERE deleted_at IS NULL
```
- `toId`: `loopd/nutrition/${row.id}`
- `toText`: `Nutrition on ${row.entry_date}: ${row.name} (${row.kcal} kcal)`

### loopd.vlogs
```sql
SELECT id, date, caption, clip_count FROM loopd.vlogs
WHERE deleted_at IS NULL AND caption IS NOT NULL AND caption <> ''
```
- `toId`: `loopd/vlogs/${row.id}`
- `toText`: `Vlog on ${row.date}: ${row.caption} (${row.clip_count} clips)`

### loopd.habits
```sql
SELECT id, label, cadence_type, time_of_day FROM loopd.habits
WHERE archived IS NOT TRUE AND deleted_at IS NULL
```
- `toId`: `loopd/habits/${row.id}`
- `toText`: `Habit: ${row.label} (${row.cadence_type}, ${row.time_of_day})`

### contrl.exercises
```sql
SELECT id, name, category, level, target_sets, target_reps, notes FROM contrl.exercises
```
- `toId`: `contrl/exercises/${row.id}`
- `toText`: `Exercise: ${row.name} (${row.category}, level ${row.level}) — ${row.target_sets}×${row.target_reps}. ${row.notes ?? ''}`

### contrl.sessions
```sql
SELECT id, date, level, category, notes, passed FROM contrl.sessions
```
- `toId`: `contrl/sessions/${row.id}`
- `toText`: `Workout on ${row.date}: ${row.category} level ${row.level}, ${row.passed ? 'passed' : 'failed'}. ${row.notes ?? ''}`

### contrl.week_progress
```sql
SELECT week_start, push_done, pull_done, squat_done FROM contrl.week_progress
```
- `toId`: `contrl/week/${row.week_start}`
- `toText`: `Week of ${row.week_start}: push=${row.push_done}, pull=${row.pull_done}, squat=${row.squat_done}`

## runtime.ts Change

Add `sourceType?: string` to the `doc` parameter of `indexDocumentRow`. Default: `'markdown'`. DB sources pass `'db'`.

```typescript
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

## CLI (`src/cli/index-db-cmd.ts`)

Reads `DB_SOURCES`, queries each table, serializes rows, calls `indexDocumentRow` with `sourceType: 'db'`. Prints `indexed loopd.entries (423 rows)` per table. Closes pool on completion.

## Package.json Script

```json
"index:db": "npm run build && node dist/src/cli/index-db-cmd.js"
```

Run with: `npm run index:db`

## Scale Note

~1,300 rows total on first run. Each row is embedded via local Ollama (`nomic-embed-text:v1.5`). Expect 5–15 minutes. Re-runs upsert unchanged rows — embedding still fires for all rows (optimization deferred).

## What Does Not Change

- `src/session.ts` — untouched; retrieval already works via `search_knowledge_base`
- `src/cli/index-cmd.ts` — untouched; markdown indexing unchanged
- `@buffr/kernel` — untouched
- `@buffr/connectors` — untouched
