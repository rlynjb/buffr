# Idempotent migration test

**Industry name:** idempotency test · run-twice / re-apply assertion. *Language-agnostic pattern, here on a transactional SQL migration.*

**Determinism seam:** testing (deterministic). The assertion is exact — after running the migration twice, the `agents` schema contains exactly this set of table names. No threshold, no "good enough."

---

## Zoom out, then zoom in

A migration runs against a database that might be empty, or might already have the schema from a previous run. If re-applying it errors, you can't safely run `npm run migrate` on a database that's already migrated — and that's the common case (every deploy, every test setup). The migration must be *idempotent*: running it twice yields the same state as running it once, with no error. The test proves exactly that by running it twice in a row.

```
  Zoom out — where the migration sits

  ┌─ CLI / test setup ──────────────────────────────────────┐
  │  npm run migrate   /   before(): runMigration(pool, sql) │
  └───────────────────────────┬──────────────────────────────┘
                              │ runs sql in one transaction
  ┌─ migrate.ts ─────────────▼──────────────────────────────┐
  │  runMigration: begin → query(sql) → commit / rollback    │ ← ★ under test ★
  └───────────────────────────┬──────────────────────────────┘
                              │ create … if not exists; drop … if exists
  ┌─ Storage ────────────────▼──────────────────────────────┐
  │  agents schema: documents, chunks, conversations,        │
  │  messages, profiles                                      │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is an **idempotency test** — run the operation twice, assert the second run doesn't error and the end state is correct. The idempotency itself lives in the SQL (`create table if not exists`, `drop constraint if exists`); the test is the proof that the SQL actually achieves it.

---

## The structure pass

**Layers:** (1) the test that calls `runMigration` twice, (2) `runMigration`'s transaction wrapper, (3) the SQL script's `if not exists` / `if exists` guards, (4) the schema in Postgres.

**Axis traced — *what changes on the second run?*** Layer 1 calls the same function twice. Layer 2 opens a transaction both times. Layer 3 is where the answer must be "nothing changes" — every statement is guarded so a second application is a no-op. Layer 4 ends in the same state either way.

**The seam:** the boundary between "first run creates" and "second run no-ops" is the `if not exists` / `if exists` guard on each DDL statement. That's the load-bearing joint — strip the guards and the second run throws `relation already exists`, breaking idempotency. The test exists specifically to defend that seam.

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

**The migration runner wraps the script in one transaction.** Atomicity is the safety net: if any statement fails, the whole thing rolls back, so a half-applied schema never persists.

```ts
// src/migrate.ts:8-20
export async function runMigration(pool: pg.Pool, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(sql);       // the whole script, one shot
    await client.query('commit');
  } catch (err) {
    await client.query('rollback'); // any failure → undo everything
    throw err;
  } finally {
    client.release();
  }
}
```

The transaction is the *hardening* layer here — it makes failure safe. The *skeleton* of idempotency is one layer down, in the SQL itself.

**The SQL guards every statement.** Idempotency isn't a property of the runner; it's a property of the script. Each DDL statement is written so a second application does nothing:

```sql
-- sql/001_agents_schema.sql
create table if not exists agents.documents ( … );
create table if not exists agents.chunks ( … );
alter table agents.chunks drop constraint if exists chunks_document_id_fkey;  -- ← if EXISTS
create index if not exists chunks_embedding_hnsw on agents.chunks using hnsw (…);
```

Note the `drop constraint if exists` — that's the parity-over-integrity FK drop (see `03-contract-parity-test.md`), and crucially it's written `if exists` so it's a no-op on a fresh database (where the constraint never existed) *and* on a previously-migrated one (where it was already dropped). Both directions guarded.

**The test runs it twice, then asserts the end state.** This is the whole pattern in three lines:

```ts
// test/migrate.test.ts:16-27
const sql = await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8');
await runMigration(pool, sql);
await runMigration(pool, sql);   // ← idempotent — runs twice without error
const { rows } = await pool.query(
  `select table_name from information_schema.tables where table_schema = 'agents' order by table_name`,
);
const names = rows.map((r) => r.table_name);
for (const t of ['chunks', 'conversations', 'documents', 'messages', 'profiles']) {
  assert.ok(names.includes(t), `missing table ${t}`);
}
```

Two things are asserted, one implicit and one explicit:
- **Implicit: the second `runMigration` doesn't throw.** If any statement weren't guarded, the second call would reject and the test would fail right there, before the assertions. The run-twice *is* half the test.
- **Explicit: the schema has the expected tables.** Query `information_schema.tables` for the `agents` schema and assert all five tables are present. This catches a different failure — a guard so aggressive it skips creating a needed table.

The pair matters: run-twice catches "throws on re-apply," the table check catches "no-op'd into doing nothing." Together they pin idempotency *and* correctness.

```
  Execution trace — the two runs

  state before run #1:  agents schema absent
  run #1:               create if not exists × 5  →  5 tables created
  state after run #1:   {documents, chunks, conversations, messages, profiles}

  state before run #2:  5 tables present
  run #2:               create if not exists × 5  →  0 created, 0 error  ← the test
  state after run #2:   {documents, chunks, conversations, messages, profiles}  (unchanged)

  assert: every expected table ∈ final set
```

### Move 3 — the principle

Idempotency is what makes an operation safe to retry, and "safe to retry" is what makes it safe to automate. A migration you can only run on a virgin database is a migration a human has to babysit. The test is cheap — one extra function call — and it converts "I think the `if not exists` guards are all there" into "the suite proves it." The deeper principle: when an operation claims a property (idempotent, ordered, atomic), the test that *exercises* the property is worth more than ten that assert the happy path once. Run it twice and the second run is the real test.

---

## Primary diagram

```
  Idempotent migration test — full picture

  ┌─ test ─────────────────────────────────────────────────────────┐
  │  runMigration(pool, sql)    ── run #1: creates the schema       │
  │  runMigration(pool, sql)    ── run #2: MUST NOT throw           │ ← idempotency
  │                                                                  │
  │  select table_name from information_schema where schema='agents' │
  │  assert all of {chunks, conversations, documents,                │
  │                 messages, profiles} present                      │ ← correctness
  └────────────────────────────────┬───────────────────────────────┘
                                   │ relies on
  ┌─ SQL guards (the skeleton) ───▼────────────────────────────────┐
  │  create table IF NOT EXISTS · create index IF NOT EXISTS        │
  │  drop constraint IF EXISTS  (guarded both directions)           │
  └─────────────────────────────────────────────────────────────────┘
  ┌─ transaction (the hardening) ──────────────────────────────────┐
  │  begin → sql → commit / rollback   (failure is atomic)         │
  └─────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Idempotency is one of the core safety properties in distributed and operational systems — the reason HTTP `PUT` and `DELETE` are defined as idempotent, the reason retry logic is safe on some operations and dangerous on others. A migration is the database-schema instance of it. The `if not exists` family of guards is Postgres's built-in support; the test is what proves you used them everywhere.

There's an honest gap this test doesn't cover: the **rollback** path of `runMigration` (`migrate.ts:13-16`). The success-and-reapply path is tested; a deliberately-broken SQL script that should roll back and rethrow is not. That's noted in `audit.md` lens 5 as part of the thin error-branch coverage — adding it would pin the atomicity-on-failure half the way this test pins the idempotency half.

---

## Interview defense

**Q: Why run the migration twice in the test?**
Because the second run is the actual test. The first run just sets up state; the second proves the migration is idempotent — that re-applying it on an already-migrated database is a no-op, not an error. That's the real-world case: every deploy and every test setup runs the migration against a database that may already have the schema. If the second call threw `relation already exists`, the migration would need a human to only ever run it once.

```
  run-twice catches the failure that run-once can't

  run-once:  create table → works → looks fine
  run-twice: create table → "already exists" → CAUGHT
                            ↑ only the second run exposes a missing IF NOT EXISTS
```

*Anchor:* "The second run is the test — it proves re-applying the migration is a no-op, which is the case every deploy hits."

**Q: Why also query the tables — isn't no-error enough?**
No. No-error proves the migration doesn't *break* on re-apply, but a guard that's too aggressive could no-op into creating nothing at all and still not throw. The `information_schema` check asserts the five tables actually exist. Run-twice pins idempotency; the table check pins correctness. You need both.

*Anchor:* "Run-twice catches 'throws on re-apply'; the table check catches 'silently created nothing' — different failures."

---

## See also

- `03-contract-parity-test.md` — relies on this migration to create the `chunks` table (and to drop the FK).
- `01-env-gated-integration-tests.md` — this test is DATABASE_URL-gated like the rest of the DB suite.
- `audit.md` lens 5 — the untested rollback path, the complement to this idempotency test.
- `study-data-modeling` — the schema this migration builds, viewed from the data-modeling side.
