# Idempotent migration test

**Industry name:** idempotency test · run-twice / re-apply assertion. *Language-agnostic pattern, here on a transactional SQL migration.*

**Determinism seam:** testing (deterministic). The assertion is exact — after running the migration twice, the `agents` schema contains exactly this set of table names. No threshold, no "good enough."

---

## Zoom out, then zoom in

A migration runs against a database that might be empty, or might already have the schema from a previous run. If re-applying it errors, you can't safely run `npm run migrate` on a database that's already migrated — and that's the common case (every deploy, every test setup). The migration must be *idempotent*: running it twice yields the same state as running it once, with no error. **The runner grew from one SQL file to a list** — `runAllMigrations` now loops `MIGRATION_FILES = ['001_agents_schema.sql', '002_decision_journal.sql']` (`src/migrate.ts:8`), running each through the same `runMigration(pool, sql)` transaction wrapper as before. The test proves the whole sequence is idempotent by running the full list twice in a row.

```
  Zoom out — where the migration sits

  ┌─ CLI / test setup ──────────────────────────────────────────┐
  │  npm run migrate   /   before(): runAllMigrations(pool)      │
  └───────────────────────────┬──────────────────────────────────┘
                              │ for each file in MIGRATION_FILES
  ┌─ migrate.ts ─────────────▼──────────────────────────────────┐
  │  runAllMigrations: loop → readFile → runMigration            │ ← ★ under test ★
  │  runMigration: begin → query(sql) → commit / rollback        │   (per file, unchanged)
  └───────────────────────────┬──────────────────────────────────┘
                              │ create … if not exists; drop … if exists
  ┌─ Storage ────────────────▼──────────────────────────────────┐
  │  agents schema: documents, chunks, conversations, messages,  │
  │  profiles (001)  +  decisions (002)                          │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is still an **idempotency test** — run the operation twice, assert the second run doesn't error and the end state is correct. What changed is the unit of "the operation": it used to be one SQL script, now it's an ordered *sequence* of scripts, and idempotency has to hold for the sequence as a whole, not just for one file in isolation.

---

## The structure pass

**Layers:** (1) the test that calls `runAllMigrations` twice, (2) `runAllMigrations`'s per-file loop, (3) `runMigration`'s transaction wrapper (one per file), (4) each SQL script's `if not exists` / `if exists` guards, (5) the schema in Postgres.

**Axis traced — *what changes on the second run?*** Layer 1 calls the same function twice. Layer 2 walks `MIGRATION_FILES` in the same fixed order both times — order matters now in a way it didn't with one file: `002_decision_journal.sql` runs *after* `001_agents_schema.sql` on every pass, so a rerun can never apply file 2 against a database that hasn't seen file 1 yet. Layer 3 opens one transaction per file, so a failure in file 2 doesn't roll back file 1's already-committed changes — each file's idempotency is independent. Layer 4 is where the answer must be "nothing changes" per file — every statement guarded so a second application is a no-op. Layer 5 ends in the same six-table state either way.

**The seam:** the boundary between "first run creates" and "second run no-ops" is still the `if not exists` / `if exists` guard on each DDL statement — now duplicated across two files instead of one. That's the load-bearing joint per file; strip the guards from either file and its second application throws. The new seam the multi-file runner introduces is **file ordering**: `MIGRATION_FILES` is a hardcoded array, not a directory scan sorted by filename. Nothing enforces that a future `003_*.sql` gets appended in the right position — that's a manual discipline, not a guarantee the code holds. The test doesn't (and can't, with one array) catch an out-of-order entry.

---

## How it works

### Move 1 — the mental model

You know how `mkdir -p` succeeds whether or not the directory exists, while plain `mkdir` errors the second time? Idempotency is the `-p`. The migration is written so every statement is `-p`-style, and the test is the thing that proves you didn't forget the `-p` on one of them.

```
  The idempotency kernel

   run #1:  empty DB ──► create tables ──► schema exists
   run #2:  schema exists ──► create IF NOT EXISTS ──► no-op, no error
                                                         │
                                                         ▼
                            assert: schema still has exactly the right tables
```

### Move 2 — the walkthrough

**`runAllMigrations` is the new outer layer — a loop over a hardcoded file list.** It replaced a single call site (`npm run migrate` used to run one file); now it reads and runs each file through the unchanged `runMigration` transaction wrapper, in order:

```ts
// src/migrate.ts:8-27
const MIGRATION_FILES = ['001_agents_schema.sql', '002_decision_journal.sql'];

export async function runMigration(pool: pg.Pool, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(sql);        // one file, one shot
    await client.query('commit');
  } catch (err) {
    await client.query('rollback'); // any failure → undo THIS file only
    throw err;
  } finally {
    client.release();
  }
}

export async function runAllMigrations(pool: pg.Pool): Promise<void> {
  for (const file of MIGRATION_FILES) {
    const sql = await readFile(new URL(`../../sql/${file}`, import.meta.url), 'utf8');
    await runMigration(pool, sql);  // ← same per-file transaction as before
  }
}
```

`runMigration` itself is untouched — one transaction, one script, rollback-and-rethrow on failure. What's new is purely the outer loop. That's deliberate scoping: the hardening (atomicity) still lives at the single-file granularity, so a broken `003_*.sql` someday would roll back only its own changes, not undo `001` and `002` that already committed successfully in earlier iterations of the loop.

**Each SQL file guards its own statements.** Idempotency is still a property of the scripts, not the runner — now two scripts instead of one:

```sql
-- sql/001_agents_schema.sql
create table if not exists agents.documents ( … );
create table if not exists agents.chunks ( … );
alter table agents.chunks drop constraint if exists chunks_document_id_fkey;  -- ← if EXISTS
create index if not exists chunks_embedding_hnsw on agents.chunks using hnsw (…);

-- sql/002_decision_journal.sql  (new)
create table if not exists agents.decisions ( … );
create index if not exists decisions_app_id on agents.decisions (app_id);
create index if not exists decisions_status_review on agents.decisions (app_id, user_id, workspace_id, status, review_at);
```

`002` has no `if exists` guard to drop (it adds a table, not a constraint) — but every `create` in it still carries `if not exists`, the same discipline as `001`. Note also what `002` does *not* do: it has no foreign key to `agents.documents` or `agents.chunks` at all, so there's no analogous parity-over-integrity call to make here — `decisions` is a standalone table from day one, not retrofitted into an existing relational shape.

**The test runs the whole sequence twice, then asserts the end state.** Same three-line shape as before, now calling the list-runner:

```ts
// test/migrate.test.ts:15-25
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
```

Two things are asserted, one implicit and one explicit — unchanged in kind, just wider in scope:
- **Implicit: the second `runAllMigrations` doesn't throw.** That's now two files' worth of guards proven in one call — if either script had an unguarded statement, the second pass would reject on that file specifically. The run-twice *is* still half the test, just now covering both files in the same assertion.
- **Explicit: the schema has all six expected tables** — `chunks`, `conversations`, `decisions`, `documents`, `messages`, `profiles`. `decisions` is the one `002` adds; its presence in this list is the only textual change the migration's growth required in the test.

The pair still matters the same way: run-twice catches "throws on re-apply," the table check catches "no-op'd into doing nothing" — now for a two-file sequence instead of one.

```
  Execution trace — the two runs, now two files each

  state before run #1:  agents schema absent
  run #1:  001 → create if not exists × 5   → 5 tables created
           002 → create if not exists × 1   → 1 table created (decisions)
  state after run #1:   {chunks, conversations, decisions, documents, messages, profiles}

  state before run #2:  6 tables present
  run #2:  001 → create if not exists × 5   → 0 created, 0 error
           002 → create if not exists × 1   → 0 created, 0 error   ← the test
  state after run #2:   same 6 tables (unchanged)

  assert: every expected table ∈ final set
```

### Move 3 — the principle

Idempotency is what makes an operation safe to retry, and "safe to retry" is what makes it safe to automate. A migration you can only run on a virgin database is a migration a human has to babysit. The test is cheap — one extra function call — and it converts "I think the `if not exists` guards are all there" into "the suite proves it." That holds at any file count: growing from one script to `N` scripts doesn't change the shape of the proof, it just widens what "the second run" covers. The deeper principle: when an operation claims a property (idempotent, ordered, atomic), the test that *exercises* the property is worth more than ten that assert the happy path once. Run it twice and the second run is the real test — and it stays the real test as the sequence grows, as long as every new file keeps the same guard discipline.

---

## Primary diagram

```
  Idempotent migration test — full picture (multi-file)

  ┌─ test ──────────────────────────────────────────────────────────┐
  │  runAllMigrations(pool)   ── run #1: creates the schema          │
  │  runAllMigrations(pool)   ── run #2: MUST NOT throw               │ ← idempotency
  │                                                                    │
  │  select table_name from information_schema where schema='agents'  │
  │  assert all of {chunks, conversations, decisions, documents,      │
  │                 messages, profiles} present                       │ ← correctness
  └────────────────────────────────┬───────────────────────────────────┘
                                   │ loops, in order
  ┌─ MIGRATION_FILES (the sequence) ──▼──────────────────────────────┐
  │  001_agents_schema.sql  →  002_decision_journal.sql               │ ← order is manual,
  │  hardcoded array, not a directory scan                            │   not enforced
  └────────────────────────────────┬───────────────────────────────────┘
                                   │ per file
  ┌─ SQL guards (the skeleton) ───▼────────────────────────────────┐
  │  create table IF NOT EXISTS · create index IF NOT EXISTS        │
  │  drop constraint IF EXISTS  (001 only, guarded both directions) │
  └─────────────────────────────────────────────────────────────────┘
  ┌─ transaction (the hardening, per file) ──────────────────────────┐
  │  begin → sql → commit / rollback   (failure atomic PER FILE)      │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Idempotency is one of the core safety properties in distributed and operational systems — the reason HTTP `PUT` and `DELETE` are defined as idempotent, the reason retry logic is safe on some operations and dangerous on others. A migration is the database-schema instance of it. The `if not exists` family of guards is Postgres's built-in support; the test is what proves you used them everywhere.

Growing from a single migration file to a list is also the moment a *new* failure mode appears that a run-twice test doesn't touch: **ordering.** `MIGRATION_FILES` is a hand-maintained array (`migrate.ts:8`), not a directory scan sorted by filename. That's a deliberate simplicity tradeoff — no glob logic, no sort-by-numeric-prefix edge cases — accepted at the cost of a manual step: someone has to remember to append `003_*.sql` to the array, in the right position, when it's added. The idempotency test can't catch "forgot to add the file" or "added it out of order," because both of those are wrong *before* the test ever runs — they're a code-review problem, not a test problem.

There's still an honest gap this test doesn't cover: the **rollback** path of `runMigration` (`migrate.ts:12-20`), unchanged by the multi-file refactor. The success-and-reapply path is tested for both files; a deliberately-broken SQL script that should roll back and rethrow is not. That's noted in `audit.md` lens 5 as part of the thin error-branch coverage — adding it would pin the atomicity-on-failure half the way this test pins the idempotency half, and it would be worth asserting per-file: a broken `002` should roll back cleanly without touching `001`'s already-committed tables.

---

## Interview defense

**Q: Why run the migrations twice in the test?**
Because the second run is the actual test. The first run just sets up state; the second proves the migration sequence is idempotent — that re-applying every file on an already-migrated database is a no-op, not an error. That's the real-world case: every deploy and every test setup runs migrations against a database that may already have some or all of the schema. If any file's second application threw `relation already exists`, the migration would need a human to babysit which files had already run.

```
  run-twice catches the failure that run-once can't

  run-once:  create table → works → looks fine
  run-twice: create table → "already exists" → CAUGHT
                            ↑ only the second run exposes a missing IF NOT EXISTS
                              (now checked across BOTH files, not just one)
```

*Anchor:* "The second run is the test — it proves re-applying the whole migration sequence is a no-op, which is the case every deploy hits."

**Q: Why also query the tables — isn't no-error enough?**
No. No-error proves the migrations don't *break* on re-apply, but a guard that's too aggressive could no-op into creating nothing at all and still not throw. The `information_schema` check asserts all six tables actually exist — five from `001`, one (`decisions`) from `002`. Run-twice pins idempotency; the table check pins correctness. You need both, and the check has to grow every time a migration file adds a table, or a missing table would go unnoticed.

*Anchor:* "Run-twice catches 'throws on re-apply'; the table check catches 'silently created nothing' — different failures, and the second one needs updating every time the schema grows."

**Q: What happens if a future migration file gets added to the array out of order, or not added at all?**
The idempotency test won't catch it — that's outside what run-twice can prove. `MIGRATION_FILES` is a hardcoded array, not a directory scan, so file discovery and ordering are a manual, code-reviewed step, not a guarantee the runner enforces. This is the one honest weak spot the multi-file refactor introduced that the existing test coverage doesn't extend to.

*Anchor:* "The array is hand-maintained — the test proves the files that ARE listed are idempotent, not that the list itself is complete or correctly ordered."

---

## See also

- `03-contract-parity-test.md` — `001_agents_schema.sql` creates the `chunks` table (and drops its FK); `002_decision_journal.sql` creates `agents.decisions`, the table `PgJournalStore` writes to — see that file's new JournalStore section for the second contract-parity instance this migration enables.
- `01-env-gated-integration-tests.md` — this test is DATABASE_URL-gated like the rest of the DB suite.
- `audit.md` lens 5 — the untested rollback path, and the untested migration-ordering seam, both complements to this idempotency test.
- `study-data-modeling` — the schema this migration builds, viewed from the data-modeling side.
