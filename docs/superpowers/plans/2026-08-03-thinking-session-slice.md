# Thinking Session Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/research <topic>` into a two-phase deliberate-practice loop — the user predicts an opportunity score and strongest dimension on raw (uninterpreted) evidence, sees a computed gap plus one principle and one reflection question, can promote the result into a tracked decision, and later resolves that decision with what actually happened via `/review`.

**Architecture:** `MarketResearchEngine.run()` is replaced by two methods, `collect()` and `evaluate()`, split exactly at the point where evidence becomes available — `collect()` gathers evidence and returns a safe digest (no interpretation), `evaluate()` runs Analyzer → Scorer → Teacher and computes the prediction comparison in code. `Teacher` gains a required `principle` + `reflectionQuestion` output with deterministic fallbacks. A new `JournalStore` interface (mirroring the existing `VectorStore` interface/in-memory/pg split) persists hypotheses and decisions in a new `agents.decisions` table. Two new pure, TUI-independent flow controllers (`research-flow.ts`, `review-flow.ts`) own the interactive sequencing (digest → prediction → reveal → promote → decision detail capture, and the `/review` per-item loop); `chat.tsx` gains a generic "active flow" state that forwards the next keystroke to whichever controller is running instead of re-parsing it as a slash command.

**Tech Stack:** TypeScript ESM, `node:test` + `node:assert/strict`, `@buffr/capabilities` (Collector/Analyzer/Scorer/Teacher — Collector/Analyzer/Scorer unchanged, Teacher modified), `@buffr/kernel` (new `JournalStore` contracts + `InMemoryJournalStore`), `pg` (new `PgJournalStore` + new migration file), `@opentui/react` (existing `chat.tsx` patterns only — no new UI library).

## Global Constraints

- No new npm dependencies.
- TypeScript ESM; all local imports use `.js` extension.
- No ANSI color codes in any output string (plain text only — `chat.tsx` applies color via `fg` props, never inline escape codes).
- `userId`/`workspaceId` for all new persistence is `cfg.appId` (matches the existing pattern used throughout `session.ts` for `AgentContext`).
- The **existing** `Journal` capability (`packages/capabilities/src/journal/index.ts`) and `DecisionJournalEntry` (`@buffr/contracts`) are dead code today (nothing calls `InvestingEngine` with `input.decision` set) and are **out of scope** — do not modify or delete them. The new persistence introduced here uses distinct type names (`JournalEntry`, `JournalStore`, not `DecisionJournalEntry`) specifically to avoid colliding with that unused code.
- `Collector`, `Analyzer`, `Scorer` are unchanged. Only `Teacher` (capabilities) and `MarketResearchEngine` (engine-market-research) are modified.
- Prediction input is constrained to exactly the four real scorecard dimensions: `frequency`, `trend-velocity`, `specificity`, `monetizability` — never free text.
- Confidence is collected from the user as 0–100 and stored normalized to 0–1 (matches the existing `AgentResult.confidence` / journal convention).
- Partial-text streaming (`onPartial`) during analyze/score/teach is **not** wired into the new interactive flow in this slice — the existing step-by-step progress panel (status line + step list) is sufficient feedback. The engine and session methods still accept an optional `onPartial` for forward compatibility, but `chat.tsx`/the flow controllers do not pass one.
- Per-turn `TurnStats` (elapsed time / token count line) is not attached to messages produced by the new flow controllers in this slice — only the live token counter in the progress panel is wired. This is a scope trim, not an oversight.

---

### Task 1: `@buffr/kernel` — `JournalStore` contracts + `InMemoryJournalStore`

**Files:**
- Create: `packages/kernel/src/journal/contracts.ts`
- Create: `packages/kernel/src/journal/in-memory-journal-store.ts`
- Create: `packages/kernel/src/journal/index.ts`
- Modify: `packages/kernel/src/index.ts` — add `export * from './journal/index.js';`
- Test: `packages/kernel/test/journal.test.ts`

**Interfaces:**
- Produces: `JournalStatus`, `Disposition`, `PredictionRecord`, `AssessmentRecord`, `JournalEntry`, `NewJournalEntry`, `JournalStore`, `InMemoryJournalStore` — all exported from `@buffr/kernel`.

This mirrors the existing `VectorStore` (`packages/kernel/src/retrieval/contracts.ts`) / `InMemoryVectorStore` (`packages/kernel/src/retrieval/in-memory-vector-store.ts`) split exactly.

- [ ] **Step 1: Write the failing test**

Create `packages/kernel/test/journal.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryJournalStore } from '../src/journal/index.js';
import type { NewJournalEntry } from '../src/journal/index.js';

const NOW = '2026-08-03T00:00:00.000Z';
const PAST = '2026-08-01T00:00:00.000Z';
const FUTURE = '2026-09-01T00:00:00.000Z';

const HYPOTHESIS: NewJournalEntry = {
  kind: 'hypothesis',
  userId: 'u1', workspaceId: 'w1', domain: 'market-research',
  subjectType: 'research-topic', subjectId: 'shopify returns management',
  claim: 'shopify returns management', evidenceIds: ['ev-1', 'ev-2'],
};

const DECISION: NewJournalEntry = {
  kind: 'decision',
  userId: 'u1', workspaceId: 'w1', domain: 'market-research',
  subjectType: 'research-topic', subjectId: 'etsy printables',
  claim: 'etsy printables', evidenceIds: ['ev-3'],
  stake: 'Build a landing page and run ads for 2 weeks',
  resolutionCondition: '10+ email signups in 2 weeks',
  reviewAt: PAST,
  prediction: { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 },
  assessment: { score: 78, confidence: 0.7 },
};

describe('InMemoryJournalStore', () => {
  it('creates a hypothesis with status open and no stake/reviewAt', async () => {
    const store = new InMemoryJournalStore();
    const entry = await store.create(HYPOTHESIS, NOW);
    assert.strictEqual(entry.kind, 'hypothesis');
    assert.strictEqual(entry.status, 'open');
    assert.strictEqual(entry.createdAt, NOW);
    assert.strictEqual(entry.stake, undefined);
    assert.strictEqual(entry.reviewAt, undefined);
    assert.ok(entry.id.length > 0);
  });

  it('creates a decision carrying stake, resolutionCondition, reviewAt, prediction, assessment', async () => {
    const store = new InMemoryJournalStore();
    const entry = await store.create(DECISION, NOW);
    assert.strictEqual(entry.kind, 'decision');
    assert.strictEqual(entry.stake, 'Build a landing page and run ads for 2 weeks');
    assert.strictEqual(entry.resolutionCondition, '10+ email signups in 2 weeks');
    assert.strictEqual(entry.reviewAt, PAST);
    assert.deepStrictEqual(entry.prediction, { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 });
    assert.deepStrictEqual(entry.assessment, { score: 78, confidence: 0.7 });
  });

  it('listDue marks an open decision past its reviewAt as review-due and returns it', async () => {
    const store = new InMemoryJournalStore();
    const created = await store.create(DECISION, NOW);
    const due = await store.listDue('u1', 'w1', NOW);
    assert.strictEqual(due.length, 1);
    assert.strictEqual(due[0]?.id, created.id);
    assert.strictEqual(due[0]?.status, 'review-due');
  });

  it('listDue excludes decisions not yet due and hypotheses entirely', async () => {
    const store = new InMemoryJournalStore();
    await store.create(HYPOTHESIS, NOW);
    await store.create({ ...DECISION, reviewAt: FUTURE }, NOW);
    const due = await store.listDue('u1', 'w1', NOW);
    assert.strictEqual(due.length, 0);
  });

  it('listDue scopes by userId/workspaceId', async () => {
    const store = new InMemoryJournalStore();
    await store.create(DECISION, NOW);
    const due = await store.listDue('someone-else', 'w1', NOW);
    assert.strictEqual(due.length, 0);
  });

  it('snooze resets status to open with a new reviewAt', async () => {
    const store = new InMemoryJournalStore();
    const created = await store.create(DECISION, NOW);
    await store.listDue('u1', 'w1', NOW); // marks it review-due first
    const snoozed = await store.snooze(created.id, FUTURE);
    assert.strictEqual(snoozed.status, 'open');
    assert.strictEqual(snoozed.reviewAt, FUTURE);
    const due = await store.listDue('u1', 'w1', NOW);
    assert.strictEqual(due.length, 0, 'should not be due again until FUTURE');
  });

  it('resolve sets status resolved with disposition, note, resolvedAt', async () => {
    const store = new InMemoryJournalStore();
    const created = await store.create(DECISION, NOW);
    const resolved = await store.resolve(created.id, 'successful', 'Hit 14 signups.', NOW);
    assert.strictEqual(resolved.status, 'resolved');
    assert.strictEqual(resolved.disposition, 'successful');
    assert.strictEqual(resolved.note, 'Hit 14 signups.');
    assert.strictEqual(resolved.resolvedAt, NOW);
    const due = await store.listDue('u1', 'w1', NOW);
    assert.strictEqual(due.length, 0, 'resolved entries must not resurface as due');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @buffr/kernel`
Expected: FAIL — `Cannot find module '../src/journal/index.js'`

- [ ] **Step 3: Write the contracts**

Create `packages/kernel/src/journal/contracts.ts`:

```typescript
// packages/kernel/src/journal/contracts.ts

export type JournalStatus = 'open' | 'review-due' | 'resolved' | 'discarded';
export type Disposition = 'successful' | 'unsuccessful' | 'inconclusive';

export type PredictionRecord = {
  expectedScore: number;
  expectedDimension: string;
  confidence: number;
};

export type AssessmentRecord = {
  score: number;
  confidence: number;
};

export type JournalEntry = {
  id: string;
  userId: string;
  workspaceId: string;
  domain: string;
  subjectType: string;
  subjectId: string;
  kind: 'hypothesis' | 'decision';
  claim: string;
  evidenceIds: string[];
  createdAt: string;
  status: JournalStatus;
  // decision-only:
  stake?: string;
  resolutionCondition?: string;
  reviewAt?: string;
  prediction?: PredictionRecord;
  assessment?: AssessmentRecord;
  // resolved-only:
  disposition?: Disposition;
  note?: string;
  resolvedAt?: string;
};

type JournalEntryCommon = {
  userId: string;
  workspaceId: string;
  domain: string;
  subjectType: string;
  subjectId: string;
  claim: string;
  evidenceIds: string[];
};

export type NewJournalEntry =
  | ({ kind: 'hypothesis' } & JournalEntryCommon)
  | ({ kind: 'decision' } & JournalEntryCommon & {
      stake: string;
      resolutionCondition: string;
      reviewAt: string;
      prediction: PredictionRecord;
      assessment: AssessmentRecord;
    });

/**
 * listDue() is also where the open -> review-due transition happens: any
 * decision with status 'open' and reviewAt <= now is flipped to 'review-due'
 * as a side effect of being listed, then returned. Both implementations
 * must do this identically.
 */
export type JournalStore = {
  create(entry: NewJournalEntry, now: string): Promise<JournalEntry>;
  listDue(userId: string, workspaceId: string, now: string): Promise<JournalEntry[]>;
  snooze(id: string, reviewAt: string): Promise<JournalEntry>;
  resolve(id: string, disposition: Disposition, note: string, now: string): Promise<JournalEntry>;
};
```

- [ ] **Step 4: Write the in-memory implementation**

Create `packages/kernel/src/journal/in-memory-journal-store.ts`:

```typescript
// packages/kernel/src/journal/in-memory-journal-store.ts
import type { JournalStore, JournalEntry, NewJournalEntry, Disposition } from './contracts.js';

export class InMemoryJournalStore implements JournalStore {
  private readonly entries = new Map<string, JournalEntry>();
  private seq = 0;

  async create(entry: NewJournalEntry, now: string): Promise<JournalEntry> {
    const id = `journal-${++this.seq}`;
    const base = {
      id,
      userId: entry.userId,
      workspaceId: entry.workspaceId,
      domain: entry.domain,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      kind: entry.kind,
      claim: entry.claim,
      evidenceIds: entry.evidenceIds,
      createdAt: now,
      status: 'open' as const,
    };
    const full: JournalEntry = entry.kind === 'decision'
      ? {
          ...base,
          stake: entry.stake,
          resolutionCondition: entry.resolutionCondition,
          reviewAt: entry.reviewAt,
          prediction: entry.prediction,
          assessment: entry.assessment,
        }
      : base;
    this.entries.set(id, full);
    return full;
  }

  async listDue(userId: string, workspaceId: string, now: string): Promise<JournalEntry[]> {
    for (const e of this.entries.values()) {
      if (e.kind === 'decision' && e.status === 'open' && e.reviewAt && e.reviewAt <= now) {
        e.status = 'review-due';
      }
    }
    return [...this.entries.values()]
      .filter(e => e.userId === userId && e.workspaceId === workspaceId && e.status === 'review-due')
      .sort((a, b) => (a.reviewAt ?? '').localeCompare(b.reviewAt ?? ''));
  }

  async snooze(id: string, reviewAt: string): Promise<JournalEntry> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`journal entry not found: ${id}`);
    e.status = 'open';
    e.reviewAt = reviewAt;
    return e;
  }

  async resolve(id: string, disposition: Disposition, note: string, now: string): Promise<JournalEntry> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`journal entry not found: ${id}`);
    e.status = 'resolved';
    e.disposition = disposition;
    e.note = note;
    e.resolvedAt = now;
    return e;
  }
}
```

- [ ] **Step 5: Wire up exports**

Create `packages/kernel/src/journal/index.ts`:

```typescript
export * from './contracts.js';
export * from './in-memory-journal-store.js';
```

Modify `packages/kernel/src/index.ts` — add this line at the end (after the `prompt-registry` export):

```typescript
export * from './journal/index.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -w @buffr/kernel`
Expected: PASS — 7 tests in `journal.test.ts`, plus all pre-existing kernel tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/journal packages/kernel/src/index.ts packages/kernel/test/journal.test.ts
git commit -m "feat(kernel): add JournalStore contracts + InMemoryJournalStore"
```

---

### Task 2: SQL migration for `agents.decisions` + `migrate.ts` runs all migration files

**Files:**
- Create: `sql/002_decision_journal.sql`
- Modify: `src/migrate.ts`
- Modify: `test/migrate.test.ts`

**Interfaces:**
- Produces: `runAllMigrations(pool: pg.Pool): Promise<void>` (new export from `src/migrate.js`, alongside the existing `runMigration`).
- Consumes: table `agents.decisions` used by `PgJournalStore` (Task 3).

- [ ] **Step 1: Write the migration file**

Create `sql/002_decision_journal.sql`:

```sql
create table if not exists agents.decisions (
  id uuid primary key default gen_random_uuid(),
  app_id text not null default 'laptop',
  user_id text not null,
  workspace_id text not null,
  domain text not null,
  subject_type text not null,
  subject_id text not null,
  kind text not null check (kind in ('hypothesis', 'decision')),
  claim text not null,
  evidence_ids jsonb not null default '[]',
  created_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'review-due', 'resolved', 'discarded')),
  stake text,
  resolution_condition text,
  review_at timestamptz,
  predicted_score numeric,
  predicted_dimension text,
  predicted_confidence numeric,
  assessed_score numeric,
  assessed_confidence numeric,
  disposition text check (disposition in ('successful', 'unsuccessful', 'inconclusive')),
  note text,
  resolved_at timestamptz
);
create index if not exists decisions_app_id on agents.decisions (app_id);
create index if not exists decisions_status_review on agents.decisions (app_id, user_id, workspace_id, status, review_at);
```

- [ ] **Step 2: Update `migrate.ts` to run every numbered migration file**

Read the current `src/migrate.ts` first (it's short — 33 lines). Replace its full contents with:

```typescript
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const MIGRATION_FILES = ['001_agents_schema.sql', '002_decision_journal.sql'];

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

/** Runs every numbered migration file in sql/, in order. */
export async function runAllMigrations(pool: pg.Pool): Promise<void> {
  for (const file of MIGRATION_FILES) {
    const sql = await readFile(new URL(`../../sql/${file}`, import.meta.url), 'utf8');
    await runMigration(pool, sql);
  }
}

// CLI entry: `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  const cfg = loadConfig(process.env);
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');
  const pool = createPool(cfg.databaseUrl);
  await runAllMigrations(pool);
  await pool.end();
  process.stdout.write('migrations applied\n');
}
```

Note: `runMigration`'s signature and behavior are unchanged — `test/pg-vector-store.test.ts` (which reads `001_agents_schema.sql` directly and calls `runMigration`) keeps working with no changes needed.

- [ ] **Step 3: Update `test/migrate.test.ts`**

Replace the full contents of `test/migrate.test.ts` with:

```typescript
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { config as loadEnv } from 'dotenv';
import { createPool } from '../src/db.js';
import { runAllMigrations } from '../src/migrate.js';

loadEnv();
const url = process.env.DATABASE_URL;

describe('agents schema migration', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(() => { pool = createPool(url!); });
  after(async () => { await pool.end(); });

  it('creates the agents tables idempotently', async () => {
    await runAllMigrations(pool);
    await runAllMigrations(pool); // idempotent — runs twice without error
    const { rows } = await pool.query(
      `select table_name from information_schema.tables where table_schema = 'agents' order by table_name`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ['chunks', 'conversations', 'decisions', 'documents', 'messages', 'profiles']) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
  });
});
```

- [ ] **Step 4: Run the test (requires DATABASE_URL)**

Run: `npm test`
Expected: if `DATABASE_URL` is set in `.env`, `migrate.test.ts`'s test PASSES and lists `decisions` among the tables. If unset, the whole `describe` block is skipped (existing behavior) — the rest of the suite still runs and passes.

- [ ] **Step 5: Commit**

```bash
git add sql/002_decision_journal.sql src/migrate.ts test/migrate.test.ts
git commit -m "feat(db): add agents.decisions table; migrate.ts runs all migration files"
```

---

### Task 3: `PgJournalStore`

**Files:**
- Create: `src/pg-journal-store.ts`
- Test: `test/pg-journal-store.test.ts`

**Interfaces:**
- Consumes: `JournalStore`, `JournalEntry`, `NewJournalEntry`, `Disposition` from `@buffr/kernel` (Task 1); table `agents.decisions` (Task 2).
- Produces: `PgJournalStore` class, `PgJournalStoreOptions` type — used by `session.ts` (Task 6).

This mirrors `src/pg-vector-store.ts`'s constructor shape (`{ pool, appId }`) and DB-gated test style (`test/pg-vector-store.test.ts`).

- [ ] **Step 1: Write the failing test**

Create `test/pg-journal-store.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, after } from 'node:test';
import { config as loadEnv } from 'dotenv';
import { createPool } from '../src/db.js';
import { runAllMigrations } from '../src/migrate.js';
import { PgJournalStore } from '../src/pg-journal-store.js';
import type { NewJournalEntry } from '@buffr/kernel';

loadEnv();
const url = process.env.DATABASE_URL;

describe('PgJournalStore', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(async () => {
    pool = createPool(url!);
    await runAllMigrations(pool);
  });
  beforeEach(async () => {
    await pool.query("delete from agents.decisions where app_id = 'test'");
  });
  after(async () => { await pool.end(); });

  const HYPOTHESIS: NewJournalEntry = {
    kind: 'hypothesis',
    userId: 'u1', workspaceId: 'w1', domain: 'market-research',
    subjectType: 'research-topic', subjectId: 'shopify returns management',
    claim: 'shopify returns management', evidenceIds: ['ev-1', 'ev-2'],
  };

  const DECISION: NewJournalEntry = {
    kind: 'decision',
    userId: 'u1', workspaceId: 'w1', domain: 'market-research',
    subjectType: 'research-topic', subjectId: 'etsy printables',
    claim: 'etsy printables', evidenceIds: ['ev-3'],
    stake: 'Build a landing page and run ads for 2 weeks',
    resolutionCondition: '10+ email signups in 2 weeks',
    reviewAt: '2026-08-01T00:00:00.000Z',
    prediction: { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 },
    assessment: { score: 78, confidence: 0.7 },
  };

  it('creates and round-trips a hypothesis', async () => {
    const store = new PgJournalStore({ pool, appId: 'test' });
    const entry = await store.create(HYPOTHESIS, '2026-08-03T00:00:00.000Z');
    assert.strictEqual(entry.kind, 'hypothesis');
    assert.strictEqual(entry.status, 'open');
    assert.deepStrictEqual(entry.evidenceIds, ['ev-1', 'ev-2']);
    assert.strictEqual(entry.stake, undefined);
  });

  it('creates and round-trips a decision', async () => {
    const store = new PgJournalStore({ pool, appId: 'test' });
    const entry = await store.create(DECISION, '2026-08-03T00:00:00.000Z');
    assert.strictEqual(entry.kind, 'decision');
    assert.strictEqual(entry.stake, DECISION.kind === 'decision' ? DECISION.stake : undefined);
    assert.strictEqual(entry.reviewAt, '2026-08-01T00:00:00.000Z');
    assert.deepStrictEqual(entry.prediction, { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 });
    assert.deepStrictEqual(entry.assessment, { score: 78, confidence: 0.7 });
  });

  it('listDue marks a past-due decision review-due and returns it, scoped by user/workspace', async () => {
    const store = new PgJournalStore({ pool, appId: 'test' });
    const created = await store.create(DECISION, '2026-08-03T00:00:00.000Z');
    const due = await store.listDue('u1', 'w1', '2026-08-03T00:00:00.000Z');
    assert.strictEqual(due.length, 1);
    assert.strictEqual(due[0]?.id, created.id);
    assert.strictEqual(due[0]?.status, 'review-due');

    const dueOther = await store.listDue('someone-else', 'w1', '2026-08-03T00:00:00.000Z');
    assert.strictEqual(dueOther.length, 0);
  });

  it('snooze and resolve update status correctly', async () => {
    const store = new PgJournalStore({ pool, appId: 'test' });
    const created = await store.create(DECISION, '2026-08-03T00:00:00.000Z');
    await store.listDue('u1', 'w1', '2026-08-03T00:00:00.000Z');

    const snoozed = await store.snooze(created.id, '2026-12-01T00:00:00.000Z');
    assert.strictEqual(snoozed.status, 'open');
    assert.strictEqual(snoozed.reviewAt, '2026-12-01T00:00:00.000Z');

    const resolved = await store.resolve(created.id, 'inconclusive', 'Ran out of time.', '2026-08-04T00:00:00.000Z');
    assert.strictEqual(resolved.status, 'resolved');
    assert.strictEqual(resolved.disposition, 'inconclusive');
    assert.strictEqual(resolved.note, 'Ran out of time.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/pg-journal-store.js'` (or skipped entirely if `DATABASE_URL` unset — in that case, set it locally per `.env` before continuing this task).

- [ ] **Step 3: Write `PgJournalStore`**

Create `src/pg-journal-store.ts`:

```typescript
import pg from 'pg';
import type { JournalStore, JournalEntry, NewJournalEntry, Disposition } from '@buffr/kernel';

export type PgJournalStoreOptions = {
  pool: pg.Pool;
  appId?: string;
};

function rowToEntry(row: Record<string, unknown>): JournalEntry {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    workspaceId: row.workspace_id as string,
    domain: row.domain as string,
    subjectType: row.subject_type as string,
    subjectId: row.subject_id as string,
    kind: row.kind as 'hypothesis' | 'decision',
    claim: row.claim as string,
    evidenceIds: row.evidence_ids as string[],
    createdAt: (row.created_at as Date).toISOString(),
    status: row.status as JournalEntry['status'],
    stake: (row.stake as string | null) ?? undefined,
    resolutionCondition: (row.resolution_condition as string | null) ?? undefined,
    reviewAt: row.review_at ? (row.review_at as Date).toISOString() : undefined,
    prediction: row.predicted_score != null
      ? {
          expectedScore: Number(row.predicted_score),
          expectedDimension: row.predicted_dimension as string,
          confidence: Number(row.predicted_confidence),
        }
      : undefined,
    assessment: row.assessed_score != null
      ? { score: Number(row.assessed_score), confidence: Number(row.assessed_confidence) }
      : undefined,
    disposition: (row.disposition as Disposition | null) ?? undefined,
    note: (row.note as string | null) ?? undefined,
    resolvedAt: row.resolved_at ? (row.resolved_at as Date).toISOString() : undefined,
  };
}

export class PgJournalStore implements JournalStore {
  private readonly pool: pg.Pool;
  private readonly appId: string;

  constructor(opts: PgJournalStoreOptions) {
    this.pool = opts.pool;
    this.appId = opts.appId ?? 'laptop';
  }

  async create(entry: NewJournalEntry, now: string): Promise<JournalEntry> {
    const decisionFields = entry.kind === 'decision'
      ? {
          stake: entry.stake,
          resolution_condition: entry.resolutionCondition,
          review_at: entry.reviewAt,
          predicted_score: entry.prediction.expectedScore,
          predicted_dimension: entry.prediction.expectedDimension,
          predicted_confidence: entry.prediction.confidence,
          assessed_score: entry.assessment.score,
          assessed_confidence: entry.assessment.confidence,
        }
      : {
          stake: null, resolution_condition: null, review_at: null,
          predicted_score: null, predicted_dimension: null, predicted_confidence: null,
          assessed_score: null, assessed_confidence: null,
        };

    const { rows } = await this.pool.query(
      `insert into agents.decisions
        (app_id, user_id, workspace_id, domain, subject_type, subject_id, kind, claim, evidence_ids, created_at,
         status, stake, resolution_condition, review_at, predicted_score, predicted_dimension, predicted_confidence,
         assessed_score, assessed_confidence)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'open',$11,$12,$13,$14,$15,$16,$17,$18)
       returning *`,
      [
        this.appId, entry.userId, entry.workspaceId, entry.domain, entry.subjectType, entry.subjectId,
        entry.kind, entry.claim, JSON.stringify(entry.evidenceIds), now,
        decisionFields.stake, decisionFields.resolution_condition, decisionFields.review_at,
        decisionFields.predicted_score, decisionFields.predicted_dimension, decisionFields.predicted_confidence,
        decisionFields.assessed_score, decisionFields.assessed_confidence,
      ],
    );
    return rowToEntry(rows[0]);
  }

  async listDue(userId: string, workspaceId: string, now: string): Promise<JournalEntry[]> {
    await this.pool.query(
      `update agents.decisions set status = 'review-due'
       where app_id = $1 and user_id = $2 and workspace_id = $3
         and kind = 'decision' and status = 'open' and review_at <= $4`,
      [this.appId, userId, workspaceId, now],
    );
    const { rows } = await this.pool.query(
      `select * from agents.decisions
       where app_id = $1 and user_id = $2 and workspace_id = $3 and status = 'review-due'
       order by review_at asc`,
      [this.appId, userId, workspaceId],
    );
    return rows.map(rowToEntry);
  }

  async snooze(id: string, reviewAt: string): Promise<JournalEntry> {
    const { rows } = await this.pool.query(
      `update agents.decisions set status = 'open', review_at = $2 where id = $1 returning *`,
      [id, reviewAt],
    );
    return rowToEntry(rows[0]);
  }

  async resolve(id: string, disposition: Disposition, note: string, now: string): Promise<JournalEntry> {
    const { rows } = await this.pool.query(
      `update agents.decisions set status = 'resolved', disposition = $2, note = $3, resolved_at = $4 where id = $1 returning *`,
      [id, disposition, note, now],
    );
    return rowToEntry(rows[0]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 4 tests in `pg-journal-store.test.ts` (or skipped if `DATABASE_URL` unset), plus all pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/pg-journal-store.ts test/pg-journal-store.test.ts
git commit -m "feat(db): add PgJournalStore"
```

---

### Task 4: `Teacher` — principle + reflection question, with fallbacks

**Files:**
- Modify: `packages/capabilities/src/teacher/index.ts`
- Test: `packages/capabilities/test/teacher.test.ts`

**Interfaces:**
- Produces: `TeacherOutput.principle: string`, `TeacherOutput.reflectionQuestion: string` (both always non-empty) — consumed by `MarketResearchEngine.evaluate()` (Task 5).

- [ ] **Step 1: Write the failing tests**

Append to `packages/capabilities/test/teacher.test.ts` (after the existing `describe('Teacher', ...)` block, before the final closing — i.e. add a new top-level `describe` block at the end of the file):

```typescript
describe('Teacher — principle and reflection question', () => {
  it('falls back to a derived principle and canned reflection question when the model omits them', async () => {
    const teacher = new Teacher(new TeacherStubModel());
    const result = await teacher.execute(
      { subjectDescription: 'ACME Corp', findings: sampleFindings, totalScore: 72, confidence: 0.8, warnings: [] },
      ctx,
    );
    assert.ok(result.data.principle.length > 0);
    assert.ok(
      result.data.principle.includes('profitability'),
      `expected fallback principle to reference the strongest dimension, got: ${result.data.principle}`,
    );
    assert.strictEqual(result.data.reflectionQuestion, 'What additional evidence would make this worth validating?');
  });

  it('uses the model-supplied principle and reflection question when present', async () => {
    class ModelWithPrinciple implements ModelProvider {
      readonly id = 'teacher-stub-with-principle';
      private callCount = 0;
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        this.callCount++;
        if (this.callCount === 1) {
          return {
            content: [{
              type: 'tool_use',
              id: 'call_1',
              name: 'submit_explanation',
              input: {
                ...prebuiltExplanation,
                principle: 'Strong margins compound when capex is strategic, not defensive.',
                reflectionQuestion: 'Would this margin hold if capex growth slowed?',
              },
            }],
          };
        }
        return { content: [{ type: 'text', text: 'done' }] };
      }
    }
    const teacher = new Teacher(new ModelWithPrinciple());
    const result = await teacher.execute(
      { subjectDescription: 'ACME Corp', findings: sampleFindings, totalScore: 72, confidence: 0.8, warnings: [] },
      ctx,
    );
    assert.strictEqual(result.data.principle, 'Strong margins compound when capex is strategic, not defensive.');
    assert.strictEqual(result.data.reflectionQuestion, 'Would this margin hold if capex growth slowed?');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @buffr/capabilities`
Expected: FAIL — `result.data.principle` is `undefined`, `TypeError: Cannot read properties of undefined (reading 'length')`.

- [ ] **Step 3: Modify `Teacher`**

Replace the full contents of `packages/capabilities/src/teacher/index.ts` with:

```typescript
import { runAgentLoop } from '@buffr/kernel';
import type { ToolExecutor, ModelTool, ModelProvider } from '@buffr/kernel';
import type { AgentContext, AgentResult, Capability } from '@buffr/contracts';
import type { AnalysisFinding } from '../analyzer/index.js';

export type TeacherInput = {
  subjectDescription: string;
  findings: AnalysisFinding[];
  totalScore: number;
  confidence: number;
  warnings: string[];
  audience?: string;
  instructions?: string[];
};

export type TeacherOutput = {
  explanation: string;
  keyLessons: string[];
  actionableNext: string[];
  principle: string;
  reflectionQuestion: string;
};

const SUBMIT_EXPLANATION_TOOL: ModelTool = {
  name: 'submit_explanation',
  description: 'Submit the plain-language explanation, key lessons, actionable next steps, one transferable principle, and one reflection question.',
  inputSchema: {
    type: 'object',
    required: ['explanation', 'keyLessons', 'actionableNext', 'principle', 'reflectionQuestion'],
    properties: {
      explanation: { type: 'string', description: '2–4 paragraph plain-language summary' },
      keyLessons: { type: 'array', items: { type: 'string' }, description: '3–5 bullet takeaways' },
      actionableNext: { type: 'array', items: { type: 'string' }, description: 'concrete next steps' },
      principle: { type: 'string', description: 'one transferable, general principle this result illustrates — something the user could apply to a different subject' },
      reflectionQuestion: { type: 'string', description: 'one question that would help the user decide whether this is worth validating further' },
    },
  },
};

function fallbackPrinciple(findings: AnalysisFinding[]): string {
  if (findings.length === 0) return 'No dimension stood out clearly — treat this result as low-signal.';
  const strongest = findings.reduce((max, f) => (f.score > max.score ? f : max), findings[0]!);
  return `${strongest.dimensionId} was the strongest signal (${Math.round(strongest.score)}/100) — ${strongest.summary}`;
}

const FALLBACK_REFLECTION_QUESTION = 'What additional evidence would make this worth validating?';

export class Teacher implements Capability<TeacherInput, TeacherOutput> {
  readonly name = 'teacher';
  readonly version = '1.0.0';

  constructor(private readonly model: ModelProvider) {}

  async execute(input: TeacherInput, context: AgentContext): Promise<AgentResult<TeacherOutput>> {
    const start = performance.now();
    const audience = input.audience ?? 'general';

    const findingsSummary = input.findings
      .map(f => {
        const pros = f.positives.length ? `Positives: ${f.positives.join(', ')}` : '';
        const cons = f.negatives.length ? `Concerns: ${f.negatives.join(', ')}` : '';
        const unk = f.unknowns.length ? `Unknowns: ${f.unknowns.join(', ')}` : '';
        return `[${f.dimensionId}] Score: ${f.score}/100 — ${f.summary}\n${[pros, cons, unk].filter(Boolean).join('; ')}`;
      })
      .join('\n\n');

    const warningSection = input.warnings.length
      ? `\nWarnings: ${input.warnings.join('; ')}`
      : '';

    const system = `You are a clear, concise educator. Explain analysis results in plain language for a ${audience} audience. Call submit_explanation exactly once.`;

    const instructionSection = input.instructions?.length
      ? `\n\nAdditional context:\n${input.instructions.join('\n')}`
      : '';

    const userPrompt = `Subject: ${input.subjectDescription}
Overall score: ${Math.round(input.totalScore)}/100 (confidence: ${Math.round(input.confidence * 100)}%)${warningSection}

Findings by dimension:
${findingsSummary}${instructionSection}

Produce:
- explanation: 2–4 paragraphs summarising what this score means for the subject and why
- keyLessons: list the specific problems and frustrations found in the evidence (3–5 items)
- actionableNext: concrete product or solution ideas that address those problems (3–5 items)
- principle: one transferable, general principle this result illustrates
- reflectionQuestion: one question that would help decide whether this is worth validating further

Call submit_explanation now.`;

    const captured: { args: Record<string, unknown> | null } = { args: null };
    const tools: ToolExecutor = {
      async callTool(_name: string, args: Record<string, unknown>) {
        if (captured.args === null) { captured.args = args; }
        return { result: { ok: true }, durationMs: 0 };
      },
    };

    await runAgentLoop({
      capabilityId: 'teacher@1.0.0',
      model: this.model,
      tools,
      system,
      userPrompt,
      toolSchemas: [SUBMIT_EXPLANATION_TOOL],
      maxTurns: 4,
    });

    const latencyMs = Math.round(performance.now() - start);
    const args = captured.args ?? {};
    const principle = typeof args.principle === 'string' && args.principle.trim().length > 0
      ? args.principle
      : fallbackPrinciple(input.findings);
    const reflectionQuestion = typeof args.reflectionQuestion === 'string' && args.reflectionQuestion.trim().length > 0
      ? args.reflectionQuestion
      : FALLBACK_REFLECTION_QUESTION;

    const output: TeacherOutput = {
      explanation: (args.explanation as string) ?? '',
      keyLessons: (args.keyLessons as string[]) ?? [],
      actionableNext: (args.actionableNext as string[]) ?? [],
      principle,
      reflectionQuestion,
    };

    return {
      data: output,
      confidence: input.confidence,
      evidence: [],
      assumptions: [],
      warnings: [],
      traceId: context.traceId,
      promptVersion: 'teacher@1.0.0',
      latencyMs,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @buffr/capabilities`
Expected: PASS — all `teacher.test.ts` tests (5 existing + 2 new), plus `journal.test.ts`, `collector.test.ts`, `analyzer.test.ts`, `scorer.test.ts` unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/teacher/index.ts packages/capabilities/test/teacher.test.ts
git commit -m "feat(capabilities): Teacher emits a principle and reflection question, with fallbacks"
```

---

### Task 5: `MarketResearchEngine` — split `run()` into `collect()` / `evaluate()`, safe digest, prediction comparison

**Files:**
- Modify: `packages/engines/market-research/src/types.ts`
- Modify: `packages/engines/market-research/src/engine.ts`
- Modify: `packages/engines/market-research/test/engine.test.ts`

**Interfaces:**
- Consumes: `TeacherOutput.principle` / `.reflectionQuestion` (Task 4).
- Produces: `EvidenceDigest`, `EvidenceDigestSource`, `CollectedResearch`, `ResearchDimensionId`, `ResearchPrediction`, `PredictionComparison`, `MarketResearchCollectInput`, `MarketResearchEvaluateOptions`, updated `MarketResearchOutput` (now includes `summary.principle`, `summary.reflectionQuestion`, and top-level `comparison`) — all exported from `@buffr/engine-market-research`, consumed by `session.ts` (Task 6).
- Removes: `MarketResearchEngine.run()`, `MarketResearchInput` (replaced by the two-phase methods above).

- [ ] **Step 1: Replace `types.ts`**

Replace the full contents of `packages/engines/market-research/src/types.ts` with:

```typescript
import type { DataConnector } from '@buffr/connectors';
import type { ModelProvider, ConversationMemory } from '@buffr/kernel';
import type { AnalysisFinding, ScoredMetric } from '@buffr/capabilities';
import type { Evidence } from '@buffr/contracts';

export type MarketResearchSource = {
  connector: DataConnector<unknown, unknown>;
  paramsFor: (topic: string) => unknown;
  optional?: boolean;
};

export type MarketResearchEngineOptions = {
  model: ModelProvider;
  sources: MarketResearchSource[];
  memory?: ConversationMemory;
};

export type ProgressEvent =
  | { type: 'engine-start'; label: string }
  | { type: 'connector-start'; id: string; label: string }
  | { type: 'connector-done';  id: string; label: string; count: number }
  | { type: 'connector-failed'; id: string; label: string; optional: boolean }
  | { type: 'stage-start'; id: string; label: string; model?: string }
  | { type: 'stage-done';  id: string; detail: string };

export type MarketResearchCollectInput = {
  topic: string;
  conversationId?: string;
  onStatus?: (msg: string) => void;
  onProgress?: (event: ProgressEvent) => void;
};

export type MarketResearchEvaluateOptions = {
  onStatus?: (msg: string) => void;
  onPartial?: (text: string) => void;
  onProgress?: (event: ProgressEvent) => void;
};

export type EvidenceDigestSource = {
  source: string;
  count: number;
  titles: string[];
};

export type EvidenceDigest = {
  totalCount: number;
  sources: EvidenceDigestSource[];
};

/**
 * Result of collect(). Contains only evidence + a safe digest — no
 * interpretation. evaluate() assumes evidence.length > 0 (the caller checks
 * digest.totalCount before prompting for a prediction and calling evaluate()).
 */
export type CollectedResearch = {
  topic: string;
  conversationId?: string;
  evidence: Evidence[];
  failed: Array<{ sourceId: string; reason: string }>;
  digest: EvidenceDigest;
  warnings: string[];
};

export type ResearchDimensionId = 'frequency' | 'trend-velocity' | 'specificity' | 'monetizability';

export type ResearchPrediction = {
  expectedScore: number;
  expectedDimension: ResearchDimensionId;
  confidence: number;
};

export type PredictionComparison = {
  prediction: ResearchPrediction;
  actualScore: number;
  actualDimension: string;
  scoreGap: number;
  dimensionMatched: boolean;
};

export type MarketResearchOutput = {
  summary: {
    topic: string;
    totalScore: number;
    confidence: number;
    explanation: string;
    keyProblems: string[];
    productAngles: string[];
    warnings: string[];
    principle: string;
    reflectionQuestion: string;
  };
  detail: {
    findings: AnalysisFinding[];
    metrics: ScoredMetric[];
    evidence: Evidence[];
    failed: Array<{ sourceId: string; reason: string }>;
  };
  comparison: PredictionComparison;
};
```

- [ ] **Step 2: Replace `engine.ts`**

Replace the full contents of `packages/engines/market-research/src/engine.ts` with:

```typescript
import { Collector, Analyzer, Scorer, Teacher } from '@buffr/capabilities';
import type { Engine, AgentContext, AgentResult, Evidence } from '@buffr/contracts';
import type { ConversationMemory } from '@buffr/kernel';
import {
  MARKET_RESEARCH_DIMENSIONS,
  MARKET_RESEARCH_SCORECARD,
  MARKET_RESEARCH_PROMPTS,
} from '@buffr/domain-pack-market-research';
import type {
  MarketResearchCollectInput, MarketResearchEvaluateOptions, MarketResearchOutput,
  MarketResearchSource, MarketResearchEngineOptions, CollectedResearch, EvidenceDigest,
  EvidenceDigestSource, ResearchPrediction, PredictionComparison,
} from './types.js';

export class MarketResearchEngine implements Engine<MarketResearchCollectInput, CollectedResearch> {
  readonly id = 'market-research-engine';
  readonly version = '1.0.0';

  private readonly collector: Collector;
  private readonly analyzer: Analyzer;
  private readonly scorer: Scorer;
  private readonly teacher: Teacher;
  private readonly sources: MarketResearchSource[];
  private readonly memory?: ConversationMemory;
  private readonly modelId: string;

  constructor(opts: MarketResearchEngineOptions) {
    this.collector = new Collector();
    this.analyzer = new Analyzer(opts.model);
    this.scorer = new Scorer();
    this.teacher = new Teacher(opts.model);
    this.sources = opts.sources;
    this.memory = opts.memory;
    this.modelId = opts.model.id;
  }

  private static friendlyName(connectorId: string): string {
    const map: Record<string, string> = {
      'discovery.google-trends': 'Google Trends',
      'discovery.google-search': 'Google Search',
      'discovery.reddit-search': 'Reddit',
      'discovery.brave-search': 'Brave Search',
      'discovery.tavily-search': 'Tavily',
    };
    // strip CachedConnector wrapper id prefix if present
    const base = connectorId.replace(/^cached:/, '');
    return map[base] ?? connectorId;
  }

  /**
   * Gathers evidence and returns a safe digest (count, source, titles only —
   * no findings, scores, or synthesized text). Runs each source through the
   * (unchanged) Collector separately so the digest can be grouped by source
   * while keeping full cross-source parallelism.
   */
  async collect(input: MarketResearchCollectInput, context: AgentContext): Promise<AgentResult<CollectedResearch>> {
    const status = input.onStatus ?? (() => {});
    const progress = input.onProgress;

    progress?.({ type: 'engine-start', label: 'Market Research Engine' });

    const collectorSources = this.sources.map(s => ({
      connector: s.connector,
      params: s.paramsFor(input.topic),
      optional: s.optional ?? false,
    }));

    const sourceNames = collectorSources.map(s => MarketResearchEngine.friendlyName(s.connector.id)).join(' · ');
    status(`fetching ${sourceNames}…`);

    const allEvidence: Evidence[] = [];
    const allFailed: Array<{ sourceId: string; reason: string }> = [];
    const allWarnings: string[] = [];
    const digestSources: EvidenceDigestSource[] = [];

    await Promise.all(collectorSources.map(async (source) => {
      const label = MarketResearchEngine.friendlyName(source.connector.id);
      const result = await this.collector.execute({
        sources: [source],
        onEvent: progress ? (e) => {
          if (e.type === 'start') {
            progress({ type: 'connector-start', id: e.sourceId, label });
          } else if (e.type === 'done') {
            progress({ type: 'connector-done', id: e.sourceId, label, count: e.count });
          } else {
            progress({ type: 'connector-failed', id: e.sourceId, label, optional: e.optional });
          }
        } : undefined,
      }, context);

      const { evidence, failed } = result.data;
      allEvidence.push(...evidence);
      allFailed.push(...failed);
      allWarnings.push(...result.warnings);
      if (evidence.length > 0) {
        digestSources.push({ source: label, count: evidence.length, titles: evidence.map(e => e.title ?? e.sourceId) });
      }
    }));

    const digest: EvidenceDigest = { totalCount: allEvidence.length, sources: digestSources };

    return {
      data: {
        topic: input.topic,
        conversationId: input.conversationId,
        evidence: allEvidence,
        failed: allFailed,
        digest,
        warnings: allWarnings,
      },
      confidence: 1,
      evidence: allEvidence,
      assumptions: [],
      warnings: allWarnings,
      traceId: context.traceId,
    };
  }

  /**
   * Runs Analyzer -> Scorer -> Teacher and computes the prediction
   * comparison in code (never asks the model to invent the gap). Assumes
   * collected.evidence.length > 0 — the caller must check
   * collected.digest.totalCount before calling this.
   */
  async evaluate(
    collected: CollectedResearch,
    prediction: ResearchPrediction,
    opts: MarketResearchEvaluateOptions,
    context: AgentContext,
  ): Promise<AgentResult<MarketResearchOutput>> {
    const partial = opts.onPartial ?? (() => {});
    const status = opts.onStatus ?? (() => {});
    const progress = opts.onProgress;
    const { evidence, failed, topic, conversationId } = collected;

    partial('Analyzing…');
    status(`analyzing ${evidence.length} results…`);
    progress?.({ type: 'stage-start', id: 'analyzer', label: 'Analyzer', model: this.modelId });
    const analyzerResult = await this.analyzer.execute(
      {
        subjectDescription: topic,
        evidence,
        dimensions: MARKET_RESEARCH_DIMENSIONS,
        instructions: [MARKET_RESEARCH_PROMPTS['analyzer-context']],
      },
      context,
    );
    progress?.({ type: 'stage-done', id: 'analyzer', detail: `${analyzerResult.data.findings.length} findings` });

    const findingsText = analyzerResult.data.findings.map(f =>
      `  ${f.dimensionId.padEnd(18)} ${String(Math.round(f.score)).padStart(3)}/100  ${f.summary}`
    ).join('\n');
    partial(`Findings:\n${findingsText}\n\nScoring…`);
    status('scoring…');
    progress?.({ type: 'stage-start', id: 'scorer', label: 'Scorer' });
    const scorerResult = await this.scorer.execute(
      { findings: analyzerResult.data.findings, scorecard: MARKET_RESEARCH_SCORECARD, evidenceCount: evidence.length },
      context,
    );
    progress?.({ type: 'stage-done', id: 'scorer', detail: `${Math.round(scorerResult.data.totalScore)}/100` });

    partial(`Findings:\n${findingsText}\n\nScore: ${Math.round(scorerResult.data.totalScore)}/100 · Confidence: ${Math.round(scorerResult.data.confidence * 100)}%\n\nSummarizing…`);
    status('summarizing…');
    progress?.({ type: 'stage-start', id: 'teacher', label: 'Teacher', model: this.modelId });
    const allWarnings = [...collected.warnings, ...scorerResult.data.warnings];
    const teacherResult = await this.teacher.execute(
      {
        subjectDescription: topic,
        findings: analyzerResult.data.findings,
        totalScore: scorerResult.data.totalScore,
        confidence: scorerResult.data.confidence,
        warnings: allWarnings,
        audience: 'solo creator building digital products and Shopify apps',
        instructions: [MARKET_RESEARCH_PROMPTS['teacher-context']],
      },
      context,
    );
    progress?.({ type: 'stage-done', id: 'teacher', detail: 'done' });

    if (this.memory && conversationId) {
      const memoryAnswer = `${teacherResult.data.explanation}\n\nTop problems: ${teacherResult.data.keyLessons.join('; ')}`;
      await this.memory.remember({ conversationId, question: `Research market: ${topic}`, answer: memoryAnswer });
    }

    const keyProblems = teacherResult.data.keyLessons.length > 0
      ? teacherResult.data.keyLessons
      : analyzerResult.data.findings.flatMap(f => f.negatives).filter(Boolean).slice(0, 5);

    const productAngles = teacherResult.data.actionableNext.length > 0
      ? teacherResult.data.actionableNext
      : analyzerResult.data.findings.flatMap(f => f.positives).filter(Boolean).slice(0, 5);

    const explanation = teacherResult.data.explanation.trim() ||
      analyzerResult.data.findings.map(f => `${f.dimensionId}: ${f.summary}`).join(' ');

    const strongestFinding = analyzerResult.data.findings.reduce(
      (max, f) => (f.score > max.score ? f : max),
      analyzerResult.data.findings[0]!,
    );
    const comparison: PredictionComparison = {
      prediction,
      actualScore: scorerResult.data.totalScore,
      actualDimension: strongestFinding.dimensionId,
      scoreGap: scorerResult.data.totalScore - prediction.expectedScore,
      dimensionMatched: strongestFinding.dimensionId === prediction.expectedDimension,
    };

    return {
      data: {
        summary: {
          topic,
          totalScore: scorerResult.data.totalScore,
          confidence: scorerResult.data.confidence,
          explanation,
          keyProblems,
          productAngles,
          warnings: allWarnings,
          principle: teacherResult.data.principle,
          reflectionQuestion: teacherResult.data.reflectionQuestion,
        },
        detail: {
          findings: analyzerResult.data.findings,
          metrics: scorerResult.data.metrics,
          evidence,
          failed,
        },
        comparison,
      },
      confidence: scorerResult.data.confidence,
      evidence,
      assumptions: analyzerResult.data.findings.flatMap(f => f.unknowns),
      warnings: allWarnings,
      traceId: context.traceId,
    };
  }
}
```

Note: `Engine<TInput, TOutput>` (from `@buffr/contracts`) requires a `run()` method — `MarketResearchEngine` no longer has one, so it no longer structurally satisfies `Engine<...>`. The `implements Engine<...>` clause above intentionally types it against `collect()`'s shape for documentation purposes only; TypeScript will **not** actually enforce the `Engine` interface here since there's no `run` method. This is fine — nothing else in the codebase requires `MarketResearchEngine` to satisfy `Engine<>` (verify with `npm run build` in Step 4; if it errors, remove the `implements Engine<...>` clause entirely rather than fighting the interface).

- [ ] **Step 3: Replace `engine.test.ts`**

Replace the full contents of `packages/engines/market-research/test/engine.test.ts` with:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MarketResearchEngine } from '../src/engine.js';
import type { MarketResearchEngineOptions, MarketResearchCollectInput, ResearchPrediction } from '../src/types.js';
import type { AgentContext, Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult } from '@buffr/connectors';
import type { ModelProvider, ModelRequest, ModelResponse, ConversationMemory, MemoryTurn } from '@buffr/kernel';
import type { AnalysisFinding } from '@buffr/capabilities';

const ctx: AgentContext = {
  userId: 'u1', workspaceId: 'w1', traceId: 't1',
  domain: 'market-research', now: '2026-08-02T00:00:00.000Z', permissions: [],
};

const RESEARCH_FINDINGS: AnalysisFinding[] = [
  { dimensionId: 'frequency',      summary: 'High volume of complaints', positives: ['Many mentions'], negatives: [],                  unknowns: [], score: 80, confidence: 0.85, evidenceIds: ['stub-1'] },
  { dimensionId: 'trend-velocity', summary: 'Rising interest',           positives: ['Trending up'],   negatives: [],                  unknowns: [], score: 75, confidence: 0.80, evidenceIds: ['stub-1'] },
  { dimensionId: 'specificity',    summary: 'Concrete pain point',       positives: ['Actionable'],    negatives: ['Some vagueness'],   unknowns: [], score: 70, confidence: 0.80, evidenceIds: ['stub-2'] },
  { dimensionId: 'monetizability', summary: 'Clear product opportunity',  positives: ['Sellable'],      negatives: [],                  unknowns: [], score: 72, confidence: 0.78, evidenceIds: ['stub-2'] },
];

class StubModel implements ModelProvider {
  readonly id = 'stub-model';
  private analysisSubmitted = false;
  private explanationSubmitted = false;

  constructor(private readonly findings: AnalysisFinding[]) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const toolName = req.tools?.[0]?.name;

    if (toolName === 'submit_analysis' && !this.analysisSubmitted) {
      this.analysisSubmitted = true;
      return {
        content: [{
          type: 'tool_use',
          id: 'call_1',
          name: 'submit_analysis',
          input: { findings: this.findings },
        }],
      };
    }

    if (toolName === 'submit_explanation' && !this.explanationSubmitted) {
      this.explanationSubmitted = true;
      return {
        content: [{
          type: 'tool_use',
          id: 'call_2',
          name: 'submit_explanation',
          input: {
            explanation: 'Test explanation.',
            keyLessons: ['Problem A', 'Problem B'],
            actionableNext: ['App idea A', 'App idea B'],
            principle: 'Test principle.',
            reflectionQuestion: 'Test reflection question?',
          },
        }],
      };
    }

    return { content: [{ type: 'text', text: 'done' }] };
  }
}

class StubConnector implements DataConnector<unknown, unknown> {
  readonly id = 'stub-connector';

  async fetch(_params: unknown): Promise<ConnectorResult<unknown>> {
    const evidence: Evidence[] = [
      { sourceId: 'stub-1', sourceType: 'search-trends', title: 'Trend data',   excerpt: 'Trend excerpt.', retrievedAt: ctx.now },
      { sourceId: 'stub-2', sourceType: 'web-search',    title: 'Forum post',   excerpt: 'Forum excerpt.', retrievedAt: ctx.now },
    ];
    return {
      data: {},
      fetchedAt: ctx.now,
      sourceId: 'stub-connector',
      toEvidence: () => evidence,
    };
  }
}

function makeEngine(findings: AnalysisFinding[], extra: Partial<MarketResearchEngineOptions> = {}): MarketResearchEngine {
  return new MarketResearchEngine({
    model: new StubModel(findings),
    sources: [{ connector: new StubConnector(), paramsFor: () => ({}) }],
    ...extra,
  });
}

const PREDICTION: ResearchPrediction = { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 };

describe('MarketResearchEngine.collect()', () => {
  it('gathers evidence and builds a digest', async () => {
    const engine = makeEngine(RESEARCH_FINDINGS);
    const input: MarketResearchCollectInput = { topic: 'shopify returns management' };
    const result = await engine.collect(input, ctx);

    assert.strictEqual(result.data.topic, 'shopify returns management');
    assert.strictEqual(result.data.evidence.length, 2);
    assert.strictEqual(result.data.digest.totalCount, 2);
    assert.strictEqual(result.data.digest.sources.length, 1);
    assert.strictEqual(result.data.digest.sources[0]?.count, 2);
    assert.deepStrictEqual(result.data.digest.sources[0]?.titles, ['Trend data', 'Forum post']);
  });
});

describe('MarketResearchEngine.collect() — safe digest', () => {
  const FORBIDDEN_KEYS = ['summary', 'positives', 'negatives', 'unknowns', 'score', 'confidence', 'sentiment', 'relevance', 'findings', 'explanation'];

  function walkKeys(value: unknown, found: Set<string>): void {
    if (Array.isArray(value)) {
      for (const item of value) walkKeys(item, found);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        found.add(key);
        walkKeys(v, found);
      }
    }
  }

  it('digest contains only count/source/titles — no analysis fields', async () => {
    const engine = makeEngine(RESEARCH_FINDINGS);
    const result = await engine.collect({ topic: 'shopify returns management' }, ctx);

    const keys = new Set<string>();
    walkKeys(result.data.digest, keys);

    for (const forbidden of FORBIDDEN_KEYS) {
      assert.ok(!keys.has(forbidden), `digest leaked analysis field: ${forbidden}`);
    }
    assert.deepStrictEqual([...keys].sort(), ['count', 'source', 'sources', 'titles', 'totalCount'].sort());
  });

  it('titles are plain strings', async () => {
    const engine = makeEngine(RESEARCH_FINDINGS);
    const result = await engine.collect({ topic: 'shopify returns management' }, ctx);
    for (const source of result.data.digest.sources) {
      for (const title of source.titles) {
        assert.strictEqual(typeof title, 'string');
      }
    }
  });
});

describe('MarketResearchEngine.evaluate()', () => {
  it('topic happy path: score > 0, keyProblems set, 4 findings, comparison computed', async () => {
    const engine = makeEngine(RESEARCH_FINDINGS);
    const { data: collected } = await engine.collect({ topic: 'shopify returns management' }, ctx);
    const result = await engine.evaluate(collected, PREDICTION, {}, ctx);

    assert.ok(result.data.summary.totalScore > 0, 'totalScore should be > 0');
    assert.strictEqual(result.data.summary.explanation, 'Test explanation.');
    assert.deepStrictEqual(result.data.summary.keyProblems, ['Problem A', 'Problem B']);
    assert.deepStrictEqual(result.data.summary.productAngles, ['App idea A', 'App idea B']);
    assert.strictEqual(result.data.summary.principle, 'Test principle.');
    assert.strictEqual(result.data.summary.reflectionQuestion, 'Test reflection question?');
    assert.strictEqual(result.data.detail.findings.length, 4);
    assert.strictEqual(result.data.comparison.actualDimension, 'frequency');
    assert.strictEqual(result.data.comparison.dimensionMatched, true);
    assert.ok(Math.abs(result.data.comparison.scoreGap - (result.data.comparison.actualScore - 60)) < 0.001);
  });

  it('memory write: remember() called once with correct conversationId and explanation in answer', async () => {
    let rememberCalled = 0;
    let capturedTurn: MemoryTurn | undefined;

    const stubMemory: ConversationMemory = {
      async remember(turn: MemoryTurn): Promise<void> {
        rememberCalled++;
        capturedTurn = turn;
      },
      async recall(_query: string, _k?: number) {
        return [];
      },
    };

    const engine = makeEngine(RESEARCH_FINDINGS, { memory: stubMemory });
    const { data: collected } = await engine.collect({ topic: 'etsy printables', conversationId: 'conv-1' }, ctx);
    await engine.evaluate(collected, PREDICTION, {}, ctx);

    assert.strictEqual(rememberCalled, 1, 'remember should be called exactly once');
    assert.strictEqual(capturedTurn?.conversationId, 'conv-1');
    assert.ok(
      typeof capturedTurn?.answer === 'string' && capturedTurn.answer.includes('Test explanation.'),
      `answer should contain 'Test explanation.', got: ${capturedTurn?.answer}`,
    );
  });

  it('dimension mismatch: comparison reflects a wrong guess', async () => {
    const engine = makeEngine(RESEARCH_FINDINGS);
    const { data: collected } = await engine.collect({ topic: 'shopify returns management' }, ctx);
    const wrongPrediction: ResearchPrediction = { expectedScore: 90, expectedDimension: 'monetizability', confidence: 0.9 };
    const result = await engine.evaluate(collected, wrongPrediction, {}, ctx);

    assert.strictEqual(result.data.comparison.dimensionMatched, false);
    assert.strictEqual(result.data.comparison.actualDimension, 'frequency');
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @buffr/engine-market-research`
Expected: PASS — 7 tests across the four `describe` blocks.

- [ ] **Step 5: Commit**

```bash
git add packages/engines/market-research/src/types.ts packages/engines/market-research/src/engine.ts packages/engines/market-research/test/engine.test.ts
git commit -m "feat(engine-market-research): split run() into collect()/evaluate(), add safe digest and prediction comparison"
```

---

### Task 6: `session.ts` — wire `PgJournalStore`, add two-phase research + journal methods, remove `research()`

**Files:**
- Modify: `src/session.ts`

**Interfaces:**
- Consumes: `PgJournalStore` (Task 3), `JournalEntry`/`Disposition`/`NewJournalEntry` from `@buffr/kernel` (Task 1), `CollectedResearch`/`ResearchPrediction`/`MarketResearchOutput` from `@buffr/engine-market-research` (Task 5).
- Produces (new `ChatSession` methods, consumed by `research-flow.ts` / `review-flow.ts` in Tasks 7–8):
  - `researchCollect(topic: string, opts?: { onStatus?: (msg: string) => void; onProgress?: (event: ProgressEvent) => void }): Promise<{ collected: CollectedResearch }>`
  - `researchEvaluate(collected: CollectedResearch, prediction: ResearchPrediction, opts?: { onStatus?: (msg: string) => void; onProgress?: (event: ProgressEvent) => void; onTokens?: (delta: { input: number; output: number }) => void }): Promise<{ output: MarketResearchOutput }>`
  - `saveHypothesis(input: { topic: string; evidenceIds: string[] }): Promise<void>`
  - `saveDecision(input: { topic: string; evidenceIds: string[]; stake: string; resolutionCondition: string; reviewAt: string; prediction: ResearchPrediction; assessment: { score: number; confidence: number } }): Promise<void>`
  - `dueReviewCount(): Promise<number>`
  - `listDueReviews(): Promise<JournalEntry[]>`
  - `snoozeReview(id: string, reviewAt: string): Promise<void>`
  - `resolveReview(id: string, disposition: Disposition, note: string): Promise<void>`
- Removes: `research(topic, opts)` from `ChatSession`, and the `formatResearch()` helper function.

- [ ] **Step 1: Update imports**

In `src/session.ts`, find this line near the top:

```typescript
import { MarketResearchEngine } from '@buffr/engine-market-research';
import type { MarketResearchSource, MarketResearchOutput, ProgressEvent } from '@buffr/engine-market-research';
```

Replace with:

```typescript
import { MarketResearchEngine } from '@buffr/engine-market-research';
import type { MarketResearchSource, MarketResearchOutput, ProgressEvent, CollectedResearch, ResearchPrediction } from '@buffr/engine-market-research';
import { PgJournalStore } from './pg-journal-store.js';
import type { JournalEntry, Disposition } from '@buffr/kernel';
```

- [ ] **Step 2: Update the `ChatSession` type**

Find:

```typescript
export type ChatSession = {
  ask(question: string, opts?: AskOptions): Promise<string>;
  analyze(ticker: string, entityType: 'company' | 'etf', opts?: AskOptions): Promise<string>;
  evalInvesting(): Promise<string>;
  research(topic: string, opts?: AskOptions): Promise<string>;
  evalResearch(): Promise<string>;
  suggestResearchTopics(): Promise<string>;
  connectorStatus(): ConnectorStatus;
  close(): Promise<void>;
};
```

Replace with:

```typescript
export type ResearchCallbacks = {
  onStatus?: (msg: string) => void;
  onProgress?: (event: ProgressEvent) => void;
};

export type ResearchEvaluateCallbacks = ResearchCallbacks & {
  onTokens?: (delta: { input: number; output: number }) => void;
};

export type ChatSession = {
  ask(question: string, opts?: AskOptions): Promise<string>;
  analyze(ticker: string, entityType: 'company' | 'etf', opts?: AskOptions): Promise<string>;
  evalInvesting(): Promise<string>;
  evalResearch(): Promise<string>;
  suggestResearchTopics(): Promise<string>;
  connectorStatus(): ConnectorStatus;
  researchCollect(topic: string, opts?: ResearchCallbacks): Promise<{ collected: CollectedResearch }>;
  researchEvaluate(collected: CollectedResearch, prediction: ResearchPrediction, opts?: ResearchEvaluateCallbacks): Promise<{ output: MarketResearchOutput }>;
  saveHypothesis(input: { topic: string; evidenceIds: string[] }): Promise<void>;
  saveDecision(input: {
    topic: string;
    evidenceIds: string[];
    stake: string;
    resolutionCondition: string;
    reviewAt: string;
    prediction: ResearchPrediction;
    assessment: { score: number; confidence: number };
  }): Promise<void>;
  dueReviewCount(): Promise<number>;
  listDueReviews(): Promise<JournalEntry[]>;
  snoozeReview(id: string, reviewAt: string): Promise<void>;
  resolveReview(id: string, disposition: Disposition, note: string): Promise<void>;
  close(): Promise<void>;
};
```

- [ ] **Step 3: Remove `formatResearch()`**

Find and delete this entire function (it becomes unused once `research()` is removed):

```typescript
function formatResearch(output: MarketResearchOutput): string {
  const { summary } = output;
  const confidence = Math.round(summary.confidence * 100);
  const lines: string[] = [
    `Market Research: ${summary.topic}`,
    '',
    `Score: ${summary.totalScore.toFixed(0)}/100 · Confidence: ${confidence}%`,
    '',
    summary.explanation,
    '',
    'Problems people face:',
  ];

  for (const problem of summary.keyProblems) {
    lines.push(`• ${problem}`);
  }

  lines.push('', 'Product opportunities:');
  for (const angle of summary.productAngles) {
    lines.push(`• ${angle}`);
  }

  if (summary.warnings.length > 0) {
    lines.push('', `Warnings: ${summary.warnings.join(', ')}`);
  }

  return lines.join('\n');
}
```

(Leave `ResearchEvalFixture` and `formatResearchEval` — those are untouched, used by `evalResearch()`.)

- [ ] **Step 4: Construct `PgJournalStore`**

Find where `PgVectorStore` is constructed (near the top of `createChatSession()`):

```typescript
  const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
```

Add immediately after it:

```typescript
  const journalStore = new PgJournalStore({ pool, appId: cfg.appId });
```

- [ ] **Step 5: Replace the `research()` method with the new methods**

Find:

```typescript
    async research(topic: string, opts?: AskOptions): Promise<string> {
      currentOnStatus = opts?.onStatus;
      currentOnTokens = opts?.onTokens;
      currentInputTokens = 0;
      currentOutputTokens = 0;
      const startMs = Date.now();
      const agentCtx: AgentContext = {
        userId: cfg.appId,
        workspaceId: cfg.appId,
        traceId: `research-${topic}-${Date.now()}`,
        domain: 'market-research',
        now: new Date().toISOString(),
        permissions: [],
      };
      const result = await researchEngine.run({ topic, conversationId, onStatus: opts?.onStatus, onPartial: opts?.onPartial, onProgress: opts?.onProgress }, agentCtx);
      currentOnStatus = undefined;
      currentOnTokens = undefined;
      opts?.onComplete?.({
        durationMs: Date.now() - startMs,
        inputTokens: currentInputTokens,
        outputTokens: currentOutputTokens,
      });
      return formatResearch(result.data);
    },
```

Replace with:

```typescript
    async researchCollect(topic: string, opts?: ResearchCallbacks): Promise<{ collected: CollectedResearch }> {
      currentOnStatus = opts?.onStatus;
      const agentCtx: AgentContext = {
        userId: cfg.appId,
        workspaceId: cfg.appId,
        traceId: `research-collect-${topic}-${Date.now()}`,
        domain: 'market-research',
        now: new Date().toISOString(),
        permissions: [],
      };
      const result = await researchEngine.collect({ topic, conversationId, onStatus: opts?.onStatus, onProgress: opts?.onProgress }, agentCtx);
      currentOnStatus = undefined;
      return { collected: result.data };
    },
    async researchEvaluate(collected: CollectedResearch, prediction: ResearchPrediction, opts?: ResearchEvaluateCallbacks): Promise<{ output: MarketResearchOutput }> {
      currentOnStatus = opts?.onStatus;
      currentOnTokens = opts?.onTokens;
      currentInputTokens = 0;
      currentOutputTokens = 0;
      const agentCtx: AgentContext = {
        userId: cfg.appId,
        workspaceId: cfg.appId,
        traceId: `research-evaluate-${collected.topic}-${Date.now()}`,
        domain: 'market-research',
        now: new Date().toISOString(),
        permissions: [],
      };
      const result = await researchEngine.evaluate(collected, prediction, { onStatus: opts?.onStatus, onProgress: opts?.onProgress }, agentCtx);
      currentOnStatus = undefined;
      currentOnTokens = undefined;
      return { output: result.data };
    },
    async saveHypothesis(input: { topic: string; evidenceIds: string[] }): Promise<void> {
      const now = new Date().toISOString();
      await journalStore.create({
        kind: 'hypothesis',
        userId: cfg.appId,
        workspaceId: cfg.appId,
        domain: 'market-research',
        subjectType: 'research-topic',
        subjectId: input.topic,
        claim: input.topic,
        evidenceIds: input.evidenceIds,
      }, now);
    },
    async saveDecision(input: {
      topic: string;
      evidenceIds: string[];
      stake: string;
      resolutionCondition: string;
      reviewAt: string;
      prediction: ResearchPrediction;
      assessment: { score: number; confidence: number };
    }): Promise<void> {
      const now = new Date().toISOString();
      await journalStore.create({
        kind: 'decision',
        userId: cfg.appId,
        workspaceId: cfg.appId,
        domain: 'market-research',
        subjectType: 'research-topic',
        subjectId: input.topic,
        claim: input.topic,
        evidenceIds: input.evidenceIds,
        stake: input.stake,
        resolutionCondition: input.resolutionCondition,
        reviewAt: input.reviewAt,
        prediction: input.prediction,
        assessment: input.assessment,
      }, now);
    },
    async dueReviewCount(): Promise<number> {
      const due = await journalStore.listDue(cfg.appId, cfg.appId, new Date().toISOString());
      return due.length;
    },
    async listDueReviews(): Promise<JournalEntry[]> {
      return journalStore.listDue(cfg.appId, cfg.appId, new Date().toISOString());
    },
    async snoozeReview(id: string, reviewAt: string): Promise<void> {
      await journalStore.snooze(id, reviewAt);
    },
    async resolveReview(id: string, disposition: Disposition, note: string): Promise<void> {
      await journalStore.resolve(id, disposition, note, new Date().toISOString());
    },
```

- [ ] **Step 6: Type-check and run the existing suite**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (If `MarketResearchEngine implements Engine<...>` from Task 5 caused a build error there, it must already be resolved before this step — this step only concerns `session.ts`'s own usage.)

Run: `npm run build && npm test`
Expected: PASS — `commands.test.ts` (only tests `detectEntityType`, unaffected), `db-sources.test.ts`, `config.test.ts`, `migrate.test.ts`, `pg-vector-store.test.ts`, `pg-journal-store.test.ts` all still pass.

- [ ] **Step 7: Commit**

```bash
git add src/session.ts
git commit -m "feat(session): wire PgJournalStore; replace research() with researchCollect/researchEvaluate + journal methods"
```

---

### Task 7: `src/cli/research-flow.ts` — the interactive predict/reveal/promote loop

**Files:**
- Create: `src/cli/research-flow.ts`
- Create: `src/cli/parse-review-date.ts` (shared with `review-flow.ts`, Task 8 — the "N days or an ISO date" parser used by both the decision review-date capture and the `/review` snooze-date capture; kept in its own file so Task 8 doesn't duplicate it)
- Test: `test/research-flow.test.ts`

**Interfaces:**
- Consumes: `ChatSession.researchCollect`/`researchEvaluate`/`saveHypothesis`/`saveDecision` (Task 6); `CollectedResearch`/`ResearchPrediction`/`MarketResearchOutput` from `@buffr/engine-market-research`.
- Produces: `createResearchFlow(session, topic, callbacks): ResearchFlow`, `ResearchFlow` (`{ start(); submit(input) }`), `ResearchFlowResult`, `ResearchFlowStep`, `ResearchFlowCallbacks`, `parseDayCountOrDate(input: string): string | null` — consumed by `chat.tsx` (Task 9) and by `review-flow.ts` (Task 8, which imports `parseDayCountOrDate` from `./parse-review-date.js` rather than redefining it).

This is a pure TypeScript module with no `@opentui`/React dependency, so it's fully unit-testable against a stub `ChatSession`.

- [ ] **Step 1: Write the failing test**

Create `test/research-flow.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createResearchFlow } from '../src/cli/research-flow.js';
import type { ChatSession } from '../src/session.js';
import type { CollectedResearch, MarketResearchOutput, ResearchPrediction } from '@buffr/engine-market-research';

const COLLECTED: CollectedResearch = {
  topic: 'shopify returns management',
  evidence: [
    { sourceId: 'stub-1', sourceType: 'web-search', title: 'Merchants hate manual tagging', retrievedAt: '2026-08-03T00:00:00.000Z' },
  ],
  failed: [],
  digest: { totalCount: 1, sources: [{ source: 'Brave Search', count: 1, titles: ['Merchants hate manual tagging'] }] },
  warnings: [],
};

const EMPTY_COLLECTED: CollectedResearch = {
  topic: 'an extremely obscure topic with no hits',
  evidence: [],
  failed: [],
  digest: { totalCount: 0, sources: [] },
  warnings: [],
};

function makeOutput(comparisonOverrides: Partial<MarketResearchOutput['comparison']> = {}): MarketResearchOutput {
  return {
    summary: {
      topic: 'shopify returns management',
      totalScore: 78,
      confidence: 0.8,
      explanation: 'Strong signal.',
      keyProblems: ['Manual tagging is tedious'],
      productAngles: ['Auto-tagging app'],
      warnings: [],
      principle: 'High-frequency manual work is a strong automation signal.',
      reflectionQuestion: 'Would merchants pay monthly for this?',
    },
    detail: { findings: [], metrics: [], evidence: COLLECTED.evidence, failed: [] },
    comparison: {
      prediction: { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 },
      actualScore: 78,
      actualDimension: 'frequency',
      scoreGap: 18,
      dimensionMatched: true,
      ...comparisonOverrides,
    },
  };
}

function makeStubSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const base: ChatSession = {
    ask: async () => '',
    analyze: async () => '',
    evalInvesting: async () => '',
    evalResearch: async () => '',
    suggestResearchTopics: async () => '',
    connectorStatus: () => ({ chat: [], chatKnowledgeBase: '', research: [], investing: [] }),
    researchCollect: async () => ({ collected: COLLECTED }),
    researchEvaluate: async () => ({ output: makeOutput() }),
    saveHypothesis: async () => {},
    saveDecision: async () => {},
    dueReviewCount: async () => 0,
    listDueReviews: async () => [],
    snoozeReview: async () => {},
    resolveReview: async () => {},
    close: async () => {},
  };
  return { ...base, ...overrides };
}

describe('research-flow — happy path to discard', () => {
  it('collects, prompts for a prediction, reveals, and discards on request', async () => {
    const session = makeStubSession();
    const flow = createResearchFlow(session, 'shopify returns management', {});

    const started = await flow.start();
    assert.strictEqual(started.step, 'prediction');
    assert.ok(started.messages[0]!.includes('Merchants hate manual tagging'));

    const predicted = await flow.submit('60 frequency 50');
    assert.strictEqual(predicted.step, 'promote');
    assert.ok(predicted.messages[0]!.includes('78'));

    const done = await flow.submit('discard');
    assert.strictEqual(done.step, 'done');
    assert.ok(done.messages[0]!.toLowerCase().includes('discarded'));
  });
});

describe('research-flow — zero evidence', () => {
  it('ends immediately with no prediction prompt', async () => {
    const session = makeStubSession({ researchCollect: async () => ({ collected: EMPTY_COLLECTED }) });
    const flow = createResearchFlow(session, EMPTY_COLLECTED.topic, {});
    const started = await flow.start();
    assert.strictEqual(started.step, 'done');
  });
});

describe('research-flow — invalid prediction input', () => {
  it('re-prompts without calling researchEvaluate', async () => {
    let evaluateCalls = 0;
    const session = makeStubSession({
      researchEvaluate: async () => { evaluateCalls++; return { output: makeOutput() }; },
    });
    const flow = createResearchFlow(session, 'shopify returns management', {});
    await flow.start();

    const badFormat = await flow.submit('not a valid prediction');
    assert.strictEqual(badFormat.step, 'prediction');
    assert.strictEqual(evaluateCalls, 0);

    const badDimension = await flow.submit('60 made-up-dimension 50');
    assert.strictEqual(badDimension.step, 'prediction');
    assert.strictEqual(evaluateCalls, 0);

    const badRange = await flow.submit('150 frequency 50');
    assert.strictEqual(badRange.step, 'prediction');
    assert.strictEqual(evaluateCalls, 0);

    const ok = await flow.submit('60 frequency 50');
    assert.strictEqual(ok.step, 'promote');
    assert.strictEqual(evaluateCalls, 1);
  });
});

describe('research-flow — save as hypothesis', () => {
  it('calls saveHypothesis with the topic and evidence ids', async () => {
    let captured: { topic: string; evidenceIds: string[] } | undefined;
    const session = makeStubSession({
      saveHypothesis: async (input) => { captured = input; },
    });
    const flow = createResearchFlow(session, 'shopify returns management', {});
    await flow.start();
    await flow.submit('60 frequency 50');
    const result = await flow.submit('hypothesis');

    assert.strictEqual(result.step, 'done');
    assert.deepStrictEqual(captured, { topic: 'shopify returns management', evidenceIds: ['stub-1'] });
  });
});

describe('research-flow — track as decision', () => {
  it('walks stake -> resolution -> review-date -> saveDecision', async () => {
    let captured: {
      topic: string; evidenceIds: string[]; stake: string; resolutionCondition: string;
      reviewAt: string; prediction: ResearchPrediction; assessment: { score: number; confidence: number };
    } | undefined;
    const session = makeStubSession({
      saveDecision: async (input) => { captured = input; },
    });
    const flow = createResearchFlow(session, 'shopify returns management', {});
    await flow.start();
    await flow.submit('60 frequency 50');

    const afterPromote = await flow.submit('decision');
    assert.strictEqual(afterPromote.step, 'stake');

    const afterStake = await flow.submit('Build a landing page and run ads for 2 weeks');
    assert.strictEqual(afterStake.step, 'resolution');

    const afterResolution = await flow.submit('10+ email signups in 2 weeks');
    assert.strictEqual(afterResolution.step, 'review-date');

    const afterReviewDate = await flow.submit('30');
    assert.strictEqual(afterReviewDate.step, 'done');

    assert.ok(captured);
    assert.strictEqual(captured!.topic, 'shopify returns management');
    assert.strictEqual(captured!.stake, 'Build a landing page and run ads for 2 weeks');
    assert.strictEqual(captured!.resolutionCondition, '10+ email signups in 2 weeks');
    assert.strictEqual(captured!.prediction.expectedScore, 60);
    assert.strictEqual(captured!.assessment.score, 78);
    assert.ok(new Date(captured!.reviewAt).getTime() > Date.now());
  });

  it('re-prompts on an unparseable review date without saving', async () => {
    let saveCalls = 0;
    const session = makeStubSession({ saveDecision: async () => { saveCalls++; } });
    const flow = createResearchFlow(session, 'shopify returns management', {});
    await flow.start();
    await flow.submit('60 frequency 50');
    await flow.submit('decision');
    await flow.submit('stake text');
    await flow.submit('resolution text');

    const bad = await flow.submit('not a date');
    assert.strictEqual(bad.step, 'review-date');
    assert.strictEqual(saveCalls, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/cli/research-flow.js'`

- [ ] **Step 3: Write `parse-review-date.ts` and `research-flow.ts`**

Create `src/cli/parse-review-date.ts`:

```typescript
/**
 * Parses "<N>" (a positive integer — days from now) or a future ISO date
 * string into a future ISO timestamp. Returns null if unparseable or not
 * in the future. Shared by research-flow.ts (decision review-date capture)
 * and review-flow.ts (snooze-date capture) — one parser, one set of rules.
 */
export function parseDayCountOrDate(input: string): string | null {
  const trimmed = input.trim();
  const asInt = Number(trimmed);
  if (Number.isInteger(asInt) && asInt > 0) {
    const d = new Date();
    d.setDate(d.getDate() + asInt);
    return d.toISOString();
  }
  const asDate = new Date(trimmed);
  if (!Number.isNaN(asDate.getTime()) && asDate.getTime() > Date.now()) {
    return asDate.toISOString();
  }
  return null;
}
```

Create `src/cli/research-flow.ts`:

```typescript
import type { ChatSession, ResearchEvaluateCallbacks } from '../session.js';
import type { CollectedResearch, ResearchPrediction, MarketResearchOutput } from '@buffr/engine-market-research';
import { parseDayCountOrDate } from './parse-review-date.js';

const VALID_DIMENSIONS = ['frequency', 'trend-velocity', 'specificity', 'monetizability'] as const;
type Dimension = typeof VALID_DIMENSIONS[number];

export type ResearchFlowStep = 'prediction' | 'promote' | 'stake' | 'resolution' | 'review-date' | 'done';

export type ResearchFlowResult = {
  messages: string[];
  step: ResearchFlowStep;
};

// Same shape session.ts already uses for researchEvaluate()'s options —
// reused directly rather than re-derived, since collect() only needs the
// onStatus/onProgress subset and evaluate() needs onTokens too.
export type ResearchFlowCallbacks = ResearchEvaluateCallbacks;

export type ResearchFlow = {
  start(): Promise<ResearchFlowResult>;
  submit(input: string): Promise<ResearchFlowResult>;
};

function formatDigest(topic: string, collected: CollectedResearch): string {
  const lines = [
    `Collected evidence for "${topic}" — ${collected.digest.totalCount} result${collected.digest.totalCount === 1 ? '' : 's'}:`,
    '',
  ];
  for (const source of collected.digest.sources) {
    lines.push(`${source.source} (${source.count}):`);
    for (const title of source.titles) lines.push(`  • ${title}`);
  }
  return lines.join('\n');
}

const PREDICTION_PROMPT =
  'Before buffr scores this: what\'s your read?\n\n' +
  'Reply with: <expected score 0-100> <strongest dimension> <confidence 0-100>\n' +
  'Dimensions: frequency, trend-velocity, specificity, monetizability\n' +
  'Example: 72 frequency 60';

function parsePrediction(input: string): ResearchPrediction | null {
  const parts = input.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const [scoreStr, dimension, confidenceStr] = parts;
  const score = Number(scoreStr);
  const confidence = Number(confidenceStr);
  if (!Number.isFinite(score) || score < 0 || score > 100) return null;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) return null;
  if (!VALID_DIMENSIONS.includes(dimension as Dimension)) return null;
  return { expectedScore: score, expectedDimension: dimension as Dimension, confidence: confidence / 100 };
}

function formatReveal(output: MarketResearchOutput): string {
  const c = output.comparison;
  const matchLine = c.dimensionMatched
    ? `Dimension match: yes — both picked ${c.actualDimension}.`
    : `Dimension match: no — you picked ${c.prediction.expectedDimension}, strongest was ${c.actualDimension}.`;
  const gapSign = c.scoreGap >= 0 ? '+' : '';
  return [
    `Your call: ${c.prediction.expectedScore}   buffr: ${Math.round(output.summary.totalScore)}   gap: ${gapSign}${c.scoreGap.toFixed(0)}`,
    matchLine,
    '',
    `Principle: ${output.summary.principle}`,
    `Reflect: ${output.summary.reflectionQuestion}`,
  ].join('\n');
}

const PROMOTE_PROMPT = 'discard / hypothesis / decision — what do you want to do with this?';

export function createResearchFlow(session: ChatSession, topic: string, callbacks: ResearchFlowCallbacks): ResearchFlow {
  let step: ResearchFlowStep = 'prediction';
  let collected: CollectedResearch | null = null;
  let output: MarketResearchOutput | null = null;
  let prediction: ResearchPrediction | null = null;
  let stake = '';
  let resolutionCondition = '';

  return {
    async start(): Promise<ResearchFlowResult> {
      const { collected: c } = await session.researchCollect(topic, { onStatus: callbacks.onStatus, onProgress: callbacks.onProgress });
      collected = c;
      if (collected.digest.totalCount === 0) {
        step = 'done';
        return { messages: [`No evidence found for "${topic}". Try a different topic.`], step };
      }
      return { messages: [formatDigest(topic, collected), PREDICTION_PROMPT], step };
    },

    async submit(input: string): Promise<ResearchFlowResult> {
      if (!collected) throw new Error('research flow: submit() called before start()');

      if (step === 'prediction') {
        const parsed = parsePrediction(input);
        if (!parsed) {
          return {
            messages: ['Could not parse that. Format: <score 0-100> <dimension> <confidence 0-100>. Dimensions: frequency, trend-velocity, specificity, monetizability.'],
            step,
          };
        }
        prediction = parsed;
        const { output: o } = await session.researchEvaluate(collected, prediction, callbacks);
        output = o;
        step = 'promote';
        return { messages: [formatReveal(output), PROMOTE_PROMPT], step };
      }

      if (step === 'promote') {
        const choice = input.trim().toLowerCase();
        if (choice === 'discard') {
          step = 'done';
          return { messages: ['Discarded — nothing saved.'], step };
        }
        if (choice === 'hypothesis') {
          await session.saveHypothesis({ topic, evidenceIds: collected.evidence.map(e => e.sourceId) });
          step = 'done';
          return { messages: ['Saved as a hypothesis.'], step };
        }
        if (choice === 'decision') {
          step = 'stake';
          return { messages: ['What\'s the stake — what will you actually do, and what do you risk if you\'re wrong?'], step };
        }
        return { messages: [PROMOTE_PROMPT], step };
      }

      if (step === 'stake') {
        if (input.trim().length === 0) return { messages: ['Stake can\'t be empty — what will you actually do?'], step };
        stake = input.trim();
        step = 'resolution';
        return { messages: ['Resolution condition — what measurable outcome would prove this right or wrong?'], step };
      }

      if (step === 'resolution') {
        if (input.trim().length === 0) return { messages: ['Resolution condition can\'t be empty.'], step };
        resolutionCondition = input.trim();
        step = 'review-date';
        return { messages: ['Review date — when should buffr remind you? (e.g. "30" for 30 days, or an ISO date like 2026-09-01)'], step };
      }

      // step === 'review-date'
      const reviewAt = parseDayCountOrDate(input);
      if (!reviewAt) {
        return { messages: ['Could not parse that. Enter a number of days from now (e.g. "30") or an ISO date (e.g. "2026-09-01").'], step };
      }
      await session.saveDecision({
        topic,
        evidenceIds: collected.evidence.map(e => e.sourceId),
        stake,
        resolutionCondition,
        reviewAt,
        prediction: prediction!,
        assessment: { score: output!.summary.totalScore, confidence: output!.summary.confidence },
      });
      step = 'done';
      const reviewDate = reviewAt.slice(0, 10);
      return { messages: [`Tracked as a decision. buffr will remind you to review this around ${reviewDate}.`], step };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `research-flow.test.ts` tests, plus everything from prior tasks still passing.

- [ ] **Step 5: Commit**

```bash
git add src/cli/research-flow.ts src/cli/parse-review-date.ts test/research-flow.test.ts
git commit -m "feat(cli): add research-flow — interactive predict/reveal/promote loop"
```

---

### Task 8: `src/cli/review-flow.ts` — the `/review` per-item loop

**Files:**
- Create: `src/cli/review-flow.ts`
- Test: `test/review-flow.test.ts`

**Interfaces:**
- Consumes: `ChatSession.listDueReviews`/`snoozeReview`/`resolveReview` (Task 6); `JournalEntry`/`Disposition` from `@buffr/kernel`; `parseDayCountOrDate` from `./parse-review-date.js` (Task 7 — do not redefine it here, import it).
- Produces: `createReviewFlow(session): ReviewFlow`, `ReviewFlow` (`{ start(); submit(input) }`), `ReviewFlowResult`, `ReviewFlowStep` — consumed by `chat.tsx` (Task 9).

- [ ] **Step 1: Write the failing test**

Create `test/review-flow.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createReviewFlow } from '../src/cli/review-flow.js';
import type { ChatSession } from '../src/session.js';
import type { JournalEntry } from '@buffr/kernel';

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'j-1',
    userId: 'u1', workspaceId: 'w1', domain: 'market-research',
    subjectType: 'research-topic', subjectId: 'shopify returns management',
    kind: 'decision', claim: 'shopify returns management', evidenceIds: ['ev-1'],
    createdAt: '2026-08-01T00:00:00.000Z', status: 'review-due',
    stake: 'Build a landing page', resolutionCondition: '10+ signups', reviewAt: '2026-08-03T00:00:00.000Z',
    prediction: { expectedScore: 60, expectedDimension: 'frequency', confidence: 0.5 },
    assessment: { score: 78, confidence: 0.7 },
    ...overrides,
  };
}

function makeStubSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const base: ChatSession = {
    ask: async () => '',
    analyze: async () => '',
    evalInvesting: async () => '',
    evalResearch: async () => '',
    suggestResearchTopics: async () => '',
    connectorStatus: () => ({ chat: [], chatKnowledgeBase: '', research: [], investing: [] }),
    researchCollect: async () => { throw new Error('not used'); },
    researchEvaluate: async () => { throw new Error('not used'); },
    saveHypothesis: async () => {},
    saveDecision: async () => {},
    dueReviewCount: async () => 0,
    listDueReviews: async () => [],
    snoozeReview: async () => {},
    resolveReview: async () => {},
    close: async () => {},
  };
  return { ...base, ...overrides };
}

describe('review-flow — nothing due', () => {
  it('ends immediately', async () => {
    const session = makeStubSession({ listDueReviews: async () => [] });
    const flow = createReviewFlow(session);
    const result = await flow.start();
    assert.strictEqual(result.step, 'done');
    assert.ok(result.messages[0]!.toLowerCase().includes('nothing due'));
  });
});

describe('review-flow — keep open', () => {
  it('moves to the next entry without calling any store method', async () => {
    let snoozeCalls = 0, resolveCalls = 0;
    const entries = [makeEntry({ id: 'j-1' }), makeEntry({ id: 'j-2' })];
    const session = makeStubSession({
      listDueReviews: async () => entries,
      snoozeReview: async () => { snoozeCalls++; },
      resolveReview: async () => { resolveCalls++; },
    });
    const flow = createReviewFlow(session);
    const started = await flow.start();
    assert.strictEqual(started.step, 'action');

    const afterKeep = await flow.submit('keep');
    assert.strictEqual(afterKeep.step, 'action');
    assert.strictEqual(snoozeCalls, 0);
    assert.strictEqual(resolveCalls, 0);

    const afterKeep2 = await flow.submit('keep');
    assert.strictEqual(afterKeep2.step, 'done');
  });
});

describe('review-flow — snooze', () => {
  it('prompts for a date, then calls snoozeReview with a parsed ISO date', async () => {
    let captured: { id: string; reviewAt: string } | undefined;
    const session = makeStubSession({
      listDueReviews: async () => [makeEntry()],
      snoozeReview: async (id, reviewAt) => { captured = { id, reviewAt }; },
    });
    const flow = createReviewFlow(session);
    await flow.start();

    const afterSnoozeChoice = await flow.submit('snooze');
    assert.strictEqual(afterSnoozeChoice.step, 'snooze-date');

    const afterDate = await flow.submit('14');
    assert.strictEqual(afterDate.step, 'done');
    assert.strictEqual(captured?.id, 'j-1');
    assert.ok(new Date(captured!.reviewAt).getTime() > Date.now());
  });

  it('re-prompts on an unparseable date', async () => {
    let snoozeCalls = 0;
    const session = makeStubSession({
      listDueReviews: async () => [makeEntry()],
      snoozeReview: async () => { snoozeCalls++; },
    });
    const flow = createReviewFlow(session);
    await flow.start();
    await flow.submit('snooze');
    const bad = await flow.submit('whenever');
    assert.strictEqual(bad.step, 'snooze-date');
    assert.strictEqual(snoozeCalls, 0);
  });
});

describe('review-flow — resolve', () => {
  it('prompts for disposition then note, then calls resolveReview', async () => {
    let captured: { id: string; disposition: string; note: string } | undefined;
    const session = makeStubSession({
      listDueReviews: async () => [makeEntry()],
      resolveReview: async (id, disposition, note) => { captured = { id, disposition, note }; },
    });
    const flow = createReviewFlow(session);
    await flow.start();

    const afterResolveChoice = await flow.submit('resolve');
    assert.strictEqual(afterResolveChoice.step, 'disposition');

    const afterBadDisposition = await flow.submit('maybe');
    assert.strictEqual(afterBadDisposition.step, 'disposition');

    const afterDisposition = await flow.submit('successful');
    assert.strictEqual(afterDisposition.step, 'note');

    const afterNote = await flow.submit('Hit 14 signups.');
    assert.strictEqual(afterNote.step, 'done');
    assert.deepStrictEqual(captured, { id: 'j-1', disposition: 'successful', note: 'Hit 14 signups.' });
  });

  it('accepts an empty note', async () => {
    let captured: { note: string } | undefined;
    const session = makeStubSession({
      listDueReviews: async () => [makeEntry()],
      resolveReview: async (_id, _disposition, note) => { captured = { note }; },
    });
    const flow = createReviewFlow(session);
    await flow.start();
    await flow.submit('resolve');
    await flow.submit('inconclusive');
    await flow.submit('');
    assert.strictEqual(captured?.note, '');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/cli/review-flow.js'`

- [ ] **Step 3: Write `review-flow.ts`**

Create `src/cli/review-flow.ts`:

```typescript
import type { ChatSession } from '../session.js';
import type { JournalEntry, Disposition } from '@buffr/kernel';
import { parseDayCountOrDate } from './parse-review-date.js';

export type ReviewFlowStep = 'action' | 'snooze-date' | 'disposition' | 'note' | 'done';

export type ReviewFlowResult = {
  messages: string[];
  step: ReviewFlowStep;
};

export type ReviewFlow = {
  start(): Promise<ReviewFlowResult>;
  submit(input: string): Promise<ReviewFlowResult>;
};

function formatEntry(entry: JournalEntry): string {
  return [
    `${entry.subjectId} — staked: ${entry.stake}`,
    `Resolution condition: ${entry.resolutionCondition}`,
    `Predicted ${entry.prediction?.expectedScore} (${entry.prediction?.expectedDimension}) · buffr scored ${entry.assessment?.score?.toFixed(0)}`,
  ].join('\n');
}

const ACTION_PROMPT = 'keep / snooze / resolve — what do you want to do?';

function parseDisposition(input: string): Disposition | null {
  const v = input.trim().toLowerCase();
  if (v === 'successful' || v === 'unsuccessful' || v === 'inconclusive') return v;
  return null;
}

export function createReviewFlow(session: ChatSession): ReviewFlow {
  let due: JournalEntry[] = [];
  let index = 0;
  let step: ReviewFlowStep = 'action';
  let pendingDisposition: Disposition | null = null;

  function currentEntry(): JournalEntry {
    const e = due[index];
    if (!e) throw new Error('review flow: no current entry');
    return e;
  }

  function advance(message: string): ReviewFlowResult {
    index += 1;
    if (index >= due.length) {
      step = 'done';
      return { messages: [message, 'Review complete.'], step };
    }
    step = 'action';
    return { messages: [message, formatEntry(currentEntry()), ACTION_PROMPT], step };
  }

  return {
    async start(): Promise<ReviewFlowResult> {
      due = await session.listDueReviews();
      if (due.length === 0) {
        step = 'done';
        return { messages: ['Nothing due for review.'], step };
      }
      index = 0;
      step = 'action';
      return { messages: [formatEntry(currentEntry()), ACTION_PROMPT], step };
    },

    async submit(input: string): Promise<ReviewFlowResult> {
      if (due.length === 0) throw new Error('review flow: submit() called before start()');

      if (step === 'action') {
        const choice = input.trim().toLowerCase();
        if (choice === 'keep') {
          return advance('Kept open.');
        }
        if (choice === 'snooze') {
          step = 'snooze-date';
          return { messages: ['Snooze until when? (e.g. "14" for 14 days, or an ISO date)'], step };
        }
        if (choice === 'resolve') {
          step = 'disposition';
          return { messages: ['Disposition — successful / unsuccessful / inconclusive?'], step };
        }
        return { messages: [ACTION_PROMPT], step };
      }

      if (step === 'snooze-date') {
        const reviewAt = parseDayCountOrDate(input);
        if (!reviewAt) {
          return { messages: ['Could not parse that. Enter a number of days from now or an ISO date.'], step };
        }
        await session.snoozeReview(currentEntry().id, reviewAt);
        return advance(`Snoozed until ${reviewAt.slice(0, 10)}.`);
      }

      if (step === 'disposition') {
        const disposition = parseDisposition(input);
        if (!disposition) {
          return { messages: ['Enter one of: successful, unsuccessful, inconclusive.'], step };
        }
        pendingDisposition = disposition;
        step = 'note';
        return { messages: ['Any note? (or leave blank)'], step };
      }

      // step === 'note'
      await session.resolveReview(currentEntry().id, pendingDisposition!, input.trim());
      pendingDisposition = null;
      return advance('Resolved.');
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `review-flow.test.ts` tests, plus everything from prior tasks still passing.

- [ ] **Step 5: Commit**

```bash
git add src/cli/review-flow.ts test/review-flow.test.ts
git commit -m "feat(cli): add review-flow — /review per-item keep/snooze/resolve loop"
```

---

### Task 9: `chat.tsx` — active-flow state, `/research` rewire, `/review` command, startup due-count

**Files:**
- Modify: `src/cli/chat.tsx`

**Interfaces:**
- Consumes: `createResearchFlow`/`ResearchFlow` (Task 7), `createReviewFlow`/`ReviewFlow` (Task 8), `ChatSession.dueReviewCount` (Task 6).

No automated test — `chat.tsx` is a TUI component with no existing unit test coverage in this codebase (consistent with how every prior `/research`/`/investing` UI change in this project was verified via `tsc --noEmit` + manual smoke test, never a component test). This task's correctness is verified by type-checking plus the manual checklist in Task 10.

- [ ] **Step 1: Update imports**

Find:

```typescript
import { createChatSession, detectEntityType, type ChatSession, type TurnStats, type ProgressEvent } from '../session.js';
```

Replace with:

```typescript
import { createChatSession, detectEntityType, type ChatSession, type TurnStats, type ProgressEvent } from '../session.js';
import { createResearchFlow, type ResearchFlow } from './research-flow.js';
import { createReviewFlow, type ReviewFlow } from './review-flow.js';
```

- [ ] **Step 2: Add `activeFlow` state and seed `turns` from `initialDueCount`**

Find:

```typescript
function Chat({ session, onExit }: { session: ChatSession; onExit: () => Promise<void> }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
```

Replace with:

```typescript
function Chat({ session, onExit, initialDueCount }: { session: ChatSession; onExit: () => Promise<void>; initialDueCount: number }) {
  const [turns, setTurns] = useState<Turn[]>(
    initialDueCount > 0
      ? [{ role: 'buffr', text: `${initialDueCount} decision${initialDueCount === 1 ? '' : 's'} due for review. Run /review when ready.` }]
      : [],
  );
  const [busy, setBusy] = useState(false);
  const [activeFlow, setActiveFlow] = useState<
    | { kind: 'research'; controller: ResearchFlow }
    | { kind: 'review'; controller: ReviewFlow }
    | null
  >(null);
```

- [ ] **Step 3: Intercept input at the top of `handleSubmit` when a flow is active**

Find:

```typescript
  const handleSubmit = (): void => {
    const q = (taRef.current?.plainText as string | undefined)?.trim() ?? '';
    if (busy || !q) return;
    taRef.current?.setText('');
    if (q === '/exit' || q === '/quit') {
```

Replace with:

```typescript
  const handleSubmit = (): void => {
    const q = (taRef.current?.plainText as string | undefined)?.trim() ?? '';
    if (busy || !q) return;
    taRef.current?.setText('');

    if (activeFlow) {
      if (q.toLowerCase() === '/cancel') {
        setTurns(t => [...t, { role: 'you', text: q }, { role: 'buffr', text: 'Cancelled.' }]);
        setActiveFlow(null);
        return;
      }
      setTurns(t => [...t, { role: 'you', text: q }]);
      progressStepsRef.current = [];
      setProgressSteps([]);
      setBusy(true);
      activeFlow.controller.submit(q).then(result => {
        const steps = progressStepsRef.current.map(s => s.state === 'running' ? { ...s, state: 'done' as const } : s);
        setTurns(t => [
          ...t,
          ...result.messages.map((text, i) => ({
            role: 'buffr' as const,
            text,
            ...(i === 0 && steps.length > 0 ? { progressSteps: steps } : {}),
          })),
        ]);
        setBusy(false);
        if (result.step === 'done') setActiveFlow(null);
      });
      return;
    }

    if (q === '/exit' || q === '/quit') {
```

- [ ] **Step 4: Rewire the `/research <topic>` branch to use the flow controller**

Find the full `/research` branch:

```typescript
    if (q === '/research' || q.startsWith('/research ')) {
      const topic = q === '/research' ? '' : q.slice('/research '.length).trim();
      if (!topic) {
        setTurns(t => [...t, { role: 'you', text: q }]);
        setBusy(true); setStatus('finding trending topics…');
        session.suggestResearchTopics().then(
          text => { setTurns(t => [...t, { role: 'buffr', text }]); setBusy(false); },
          err  => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]); setBusy(false); },
        );
        return;
      }
      setTurns(t => [...t, { role: 'you', text: q }, { role: 'buffr', text: '' }]);
      progressStepsRef.current = [];
      setProgressSteps([]);
      setBusy(true); setStatus('researching…'); setLiveTokens({ input: 0, output: 0 });
      let capturedStats: TurnStats | undefined;
      session.research(topic, {
        onStatus: (msg) => setStatus(msg),
        onTokens: (d) => setLiveTokens(t => ({ input: t.input + d.input, output: t.output + d.output })),
        onComplete: (s) => { capturedStats = s; },
        onPartial: (text) => setTurns(t => { const c = [...t]; c[c.length - 1] = { role: 'buffr', text }; return c; }),
        onProgress: (event: ProgressEvent) => {
          if (event.type === 'engine-start') {
            updateProgressSteps(s => [...s, { id: '__engine__', label: event.label, kind: 'engine', state: 'running' }]);
          } else if (event.type === 'connector-start') {
            updateProgressSteps(s => [...s, { id: event.id, label: event.label, kind: 'connector', state: 'running' }]);
          } else if (event.type === 'connector-done') {
            updateProgressSteps(s => s.map(step => step.id === event.id
              ? { ...step, state: 'done', detail: event.count > 0 ? `${event.count} result${event.count !== 1 ? 's' : ''}` : undefined }
              : step));
          } else if (event.type === 'connector-failed') {
            updateProgressSteps(s => s.map(step => step.id === event.id
              ? { ...step, state: event.optional ? 'skipped' : 'failed' }
              : step));
          } else if (event.type === 'stage-start') {
            updateProgressSteps(s => [...s, { id: event.id, label: event.label, kind: 'stage', state: 'running', model: event.model }]);
          } else if (event.type === 'stage-done') {
            updateProgressSteps(s => s.map(step => step.id === event.id
              ? { ...step, state: 'done', detail: event.detail !== 'done' ? event.detail : undefined }
              : step));
          }
        },
      }).then(
        answer => {
          const finalSteps = progressStepsRef.current.map(s => s.state === 'running' ? { ...s, state: 'done' as const } : s);
          setTurns(t => { const c = [...t]; c[c.length - 1] = { ...c[c.length - 1], text: c[c.length - 1].text + '\n\n' + answer, stats: capturedStats, progressSteps: finalSteps }; return c; });
          setBusy(false);
        },
        err => {
          const finalSteps = progressStepsRef.current.map(s => s.state === 'running' ? { ...s, state: 'failed' as const } : s);
          setTurns(t => { const c = [...t]; c[c.length - 1] = { ...c[c.length - 1], text: c[c.length - 1].text + `\n\nerror: ${(err as Error).message}`, progressSteps: finalSteps }; return c; });
          setBusy(false);
        },
      );
      return;
    }
```

Replace with:

```typescript
    if (q === '/research' || q.startsWith('/research ')) {
      const topic = q === '/research' ? '' : q.slice('/research '.length).trim();
      if (!topic) {
        setTurns(t => [...t, { role: 'you', text: q }]);
        setBusy(true); setStatus('finding trending topics…');
        session.suggestResearchTopics().then(
          text => { setTurns(t => [...t, { role: 'buffr', text }]); setBusy(false); },
          err  => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]); setBusy(false); },
        );
        return;
      }
      setTurns(t => [...t, { role: 'you', text: q }]);
      progressStepsRef.current = [];
      setProgressSteps([]);
      setBusy(true); setStatus('researching…'); setLiveTokens({ input: 0, output: 0 });
      const controller = createResearchFlow(session, topic, {
        onStatus: (msg) => setStatus(msg),
        onTokens: (d) => setLiveTokens(t => ({ input: t.input + d.input, output: t.output + d.output })),
        onProgress: (event: ProgressEvent) => {
          if (event.type === 'engine-start') {
            updateProgressSteps(s => [...s, { id: '__engine__', label: event.label, kind: 'engine', state: 'running' }]);
          } else if (event.type === 'connector-start') {
            updateProgressSteps(s => [...s, { id: event.id, label: event.label, kind: 'connector', state: 'running' }]);
          } else if (event.type === 'connector-done') {
            updateProgressSteps(s => s.map(step => step.id === event.id
              ? { ...step, state: 'done', detail: event.count > 0 ? `${event.count} result${event.count !== 1 ? 's' : ''}` : undefined }
              : step));
          } else if (event.type === 'connector-failed') {
            updateProgressSteps(s => s.map(step => step.id === event.id
              ? { ...step, state: event.optional ? 'skipped' : 'failed' }
              : step));
          } else if (event.type === 'stage-start') {
            updateProgressSteps(s => [...s, { id: event.id, label: event.label, kind: 'stage', state: 'running', model: event.model }]);
          } else if (event.type === 'stage-done') {
            updateProgressSteps(s => s.map(step => step.id === event.id
              ? { ...step, state: 'done', detail: event.detail !== 'done' ? event.detail : undefined }
              : step));
          }
        },
      });
      controller.start().then(result => {
        const steps = progressStepsRef.current.map(s => s.state === 'running' ? { ...s, state: 'done' as const } : s);
        setTurns(t => [
          ...t,
          ...result.messages.map((text, i) => ({
            role: 'buffr' as const,
            text,
            ...(i === 0 && steps.length > 0 ? { progressSteps: steps } : {}),
          })),
        ]);
        setBusy(false);
        if (result.step === 'done') setActiveFlow(null); else setActiveFlow({ kind: 'research', controller });
      });
      return;
    }
```

Note: `TurnStats` import stays used elsewhere (`/investing`, `/ask`), so don't remove that import even though the `/research` branch no longer references it.

- [ ] **Step 5: Add the `/review` command**

Find the `/eval` usage-hint branch:

```typescript
    if (q === '/eval') {
      setTurns(t => [...t, { role: 'you', text: q }]);
      setTurns(t => [...t, { role: 'buffr', text: 'Usage: /eval investing | /eval research' }]);
      return;
    }
```

Add immediately after it:

```typescript
    if (q === '/review') {
      setTurns(t => [...t, { role: 'you', text: q }]);
      setBusy(true);
      const controller = createReviewFlow(session);
      controller.start().then(result => {
        setTurns(t => [...t, ...result.messages.map(text => ({ role: 'buffr' as const, text }))]);
        setBusy(false);
        if (result.step !== 'done') setActiveFlow({ kind: 'review', controller });
      });
      return;
    }
```

- [ ] **Step 6: Update `/help` text**

Find (inside the `/help` branch's `helpLines` array):

```typescript
        '/research <topic>',
        '  Market research — finds trending problems and product opportunities.',
        `  Connectors: ${connectors.research.join(', ')}`,
        '  Example: /research digital planners for students',
        '  Run /research with no topic to see trending suggestions.',
        '',
```

Replace with:

```typescript
        '/research <topic>',
        '  Market research — predict the score first, then see buffr\'s read and the gap.',
        `  Connectors: ${connectors.research.join(', ')}`,
        '  Example: /research digital planners for students',
        '  Run /research with no topic to see trending suggestions.',
        '  Type /cancel at any point during the loop to bail out without saving.',
        '',
```

Find:

```typescript
        '/exit  or  /quit',
        '  Close the session.',
```

Replace with:

```typescript
        '/review',
        '  Review decisions that are due — keep open, snooze, or resolve each one.',
        '',
        '/exit  or  /quit',
        '  Close the session.',
```

- [ ] **Step 7: Wire `initialDueCount` at the bottom of the file**

Find:

```typescript
const session = await createChatSession();
const renderer = await createCliRenderer({ exitOnCtrlC: false });

const forceExit = () => { setTimeout(() => process.exit(0), 1500).unref(); session.close().finally(() => process.exit(0)); };

process.on('SIGINT', forceExit);

createRoot(renderer).render(
  <Chat
    session={session}
    onExit={async () => { forceExit(); }}
  />,
);
```

Replace with:

```typescript
const session = await createChatSession();
const initialDueCount = await session.dueReviewCount();
const renderer = await createCliRenderer({ exitOnCtrlC: false });

const forceExit = () => { setTimeout(() => process.exit(0), 1500).unref(); session.close().finally(() => process.exit(0)); };

process.on('SIGINT', forceExit);

createRoot(renderer).render(
  <Chat
    session={session}
    onExit={async () => { forceExit(); }}
    initialDueCount={initialDueCount}
  />,
);
```

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/cli/chat.tsx
git commit -m "feat(chat): wire the interactive research/review flows into the TUI"
```

---

### Task 10: Full verification against the spec's "done means" checklist

**Files:** none (verification only).

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: builds every workspace package plus the app with zero errors.

- [ ] **Step 2: Full test suite, package by package**

Run each of the following and confirm all PASS:

```bash
npm test -w @buffr/kernel
npm test -w @buffr/capabilities
npm test -w @buffr/connectors
npm test -w @buffr/engine-market-research
npm test
```

(`npm test` at the root also rebuilds everything first, so this is a final end-to-end confirmation. `@buffr/engine-investing`, the domain packs, and `@buffr/contracts` have no test scripts — nothing to run there, and none of those packages were touched by this plan.)

- [ ] **Step 3: Walk the spec's "done means" list**

Open `docs/thinking-session-slice.spec.md` and confirm each line against what was built:

- `/research <topic>` collects evidence before asking for a prediction — Task 7 `start()`.
- Prediction-time output contains no findings, interpretation, or score — Task 5's digest-exclusion tests.
- The user records: expected opportunity score, expected strongest dimension, confidence — Task 7 `parsePrediction`.
- Analysis output is not revealed until a prediction exists — Task 7: `evaluate()` only runs inside `submit()`'s `'prediction'` branch.
- Reveal shows: user score, buffr score, numeric gap, predicted vs actual strongest dimension, one principle, one reflection question — Task 7 `formatReveal`.
- Default disposition is discard — Task 7: `'discard'` is a plain no-op branch, no store call.
- A hypothesis persists without a stake or review date — Task 1/3 tests.
- A decision requires a stake, a measurable resolution condition, and a review date — Task 7's stake/resolution/review-date chain (each step re-prompts on empty/invalid input).
- Journal persistence survives session restart — `PgJournalStore` (Task 3), a real Postgres table, not in-memory.
- Startup shows a nonblocking count of due decisions; `/review` lists them — Task 9 Steps 5 and 7.
- A due decision can be snoozed or resolved (disposition + note), and resolving stops it resurfacing — Task 8 + Task 1/3's `listDue` excludes `resolved` status.
- Cancelling during prediction creates no partial journal entry — true by construction (journal writes only happen at the end of the `'hypothesis'`/`'decision'` branches), and `/cancel` (Task 9 Step 3) gives an explicit way to bail at any step.
- Existing `/research` scoring and eval tests still pass — Task 5 rewrote `engine.test.ts` with equivalent coverage against the new `collect()`/`evaluate()` API; `evalResearch()`/`formatResearchEval` (unchanged, Scorer-only) still pass via `npm test`.
- A new test proves no analysis fields leak into the prediction digest — Task 5's `'MarketResearchEngine.collect() — safe digest'` block.
- No workflow-definition or orchestration framework is introduced — confirmed: the flow controllers are plain closures with an explicit `step` string, no new dependency, no generic "workflow engine" abstraction.

- [ ] **Step 4: Manual smoke test (TUI — not automatable)**

Run: `npm run chat` (this is `package.json`'s existing script: `npm run build && bun dist/src/cli/chat.js`).

Walk through, in order:
1. `/research <a topic with likely hits>` — confirm the digest appears with only titles/counts (no scores/findings), then the prediction prompt.
2. Type a valid prediction (`60 frequency 50`) — confirm the reveal shows both scores, the gap, dimension match, principle, and reflection question.
3. Type `discard` — confirm "Discarded — nothing saved." and that the input box returns to normal (no longer in a flow).
4. Run `/research` again, predict, then type `decision` — walk through stake/resolution/review-date with a `1` (1 day) review date so it's immediately due.
5. Exit (`/exit`) and relaunch — confirm the startup line shows "1 decision due for review."
6. Run `/review` — confirm the entry appears, resolve it with a disposition + note, confirm "Review complete."
7. Run `/review` again — confirm "Nothing due for review."

- [ ] **Step 5: Commit (only if Step 4 required fixes)**

If the manual smoke test surfaced any bugs, fix them and commit:

```bash
git add -A
git commit -m "fix: smoke-test fixes for the thinking session slice"
```

If no fixes were needed, there is nothing to commit for this task.
