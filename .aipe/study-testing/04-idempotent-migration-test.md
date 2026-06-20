# Idempotent Migration Test

**Industry names:** idempotency test · re-runnable migration · "run it twice,
assert no error." **Type:** Industry standard.

---

## Zoom out, then zoom in

A migration that can only run once is a landmine: re-run it on a database that's
already migrated and it explodes with "relation already exists." This repo's
schema is written so every statement tolerates already-existing state, and the
test *proves* it by running the whole migration twice in a row and asserting the
second run doesn't throw.

```
  Zoom out — where idempotency is enforced and where it's proven

  ┌─ Test layer ────────────────────────────────────────────┐
  │  runMigration(pool, sql)                                  │
  │  runMigration(pool, sql)   ← run AGAIN, must not throw    │ ← we are here
  └────────────────────────────┬────────────────────────────┘
                               │  one transaction each
  ┌─ Migration runner ─────────▼────────────────────────────┐
  │  begin → query(sql) → commit  (rollback on error)        │
  └────────────────────────────┬────────────────────────────┘
                               │
  ┌─ Schema (SQL) ─────────────▼────────────────────────────┐
  │  create table IF NOT EXISTS · create index IF NOT EXISTS │
  │  drop constraint IF EXISTS  ← the idempotency lives here  │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **assert idempotency by repetition.** The schema earns
idempotency with `if not exists` / `if exists` on every statement; the test
*verifies* that property the only way you can — by doing the thing twice and
checking the second time is a no-op, not a crash.

---

## Structure pass

Two layers, one axis: **failure — what happens when state already exists?**

```
  Axis: "what if the table is already there?" — traced down

  ┌─ runMigration (transaction) ─┐
  │  begin → query → commit       │   → would propagate any error,
  │  catch → rollback → throw     │     rollback, and FAIL the test
  └──────────────┬────────────────┘
       seam: the SQL statements    ← idempotency flips the answer here
  ┌──────────────▼────────────────┐
  │  create table IF NOT EXISTS   │   → already exists? skip, no error
  │  create index IF NOT EXISTS   │   → already exists? skip, no error
  │  drop constraint IF EXISTS    │   → not there? skip, no error
  └────────────────────────────────┘
```

The seam is the SQL statement modifiers. Above them, the runner would faithfully
surface and roll back any "already exists" error. Below them, every statement is
written to *not produce* that error. The `if [not] exists` clauses are the joint
that turns a second run from a crash into a no-op — and the test's job is to
stand on the second run and confirm the joint holds.

---

## How it works

### Move 1 — the mental model

You know how a React effect with the right dependency guard can run twice (Strict
Mode) without double-applying its side effect? Idempotency is that property for a
migration: running it again lands you in the same state, no error, no duplicate.

```
  Idempotency — f(f(x)) == f(x)

   empty DB ──run──► migrated DB ──run AGAIN──► same migrated DB
                                                      │
                                              no error, no dup tables
                                              second run is a no-op
```

### Move 2 — the walkthrough

**Run once to reach the target state.** First `runMigration(pool, sql)` creates
the extension, schema, five tables, and the indexes on an empty (or partial)
database. Standard.

**Run twice to prove the no-op.** The second `runMigration(pool, sql)` — same
SQL, same pool — is the actual test. If any statement lacked `if not exists`,
this call throws `relation "agents.documents" already exists`, the transaction
rolls back (`migrate.ts:13-16`), and the `it` fails. The test passing *is* the
idempotency proof.

```
  The two calls — the second is the assertion

  await runMigration(pool, sql);   ← reach target state
  await runMigration(pool, sql);   ← THE TEST: must be a clean no-op
        │
        └─ if any "create table" lacked IF NOT EXISTS,
           this throws → test fails
```

**Assert the end state, not just the absence of a throw.** After both runs, the
test queries `information_schema.tables` for schema `agents` and asserts all
five tables are present (`chunks`, `conversations`, `documents`, `messages`,
`profiles`). So it proves two things at once: the second run didn't error *and*
the schema is actually complete. A migration that silently did nothing would
pass the "no throw" check but fail the table-presence check.

```
  Two assertions in one test — both halves of "it worked"

  1. second runMigration didn't throw   → idempotent
  2. information_schema has all 5 tables → schema is complete

  passing #1 alone could mean "did nothing"; #2 closes that gap
```

**The transaction wrapper is what makes a failed run safe.** `runMigration`
wraps the SQL in `begin/commit` with `rollback` on error (`migrate.ts:9-19`). If
the migration *did* throw on the second run, the rollback leaves the database in
its pre-call state — so the test failure is clean, not a half-applied schema.
The transaction is hardening on top of the idempotency skeleton.

**The skeleton — what breaks without each part:**

- **The second `runMigration` call.** Remove it and you test creation, not
  idempotency — a non-re-runnable migration passes. **This call IS the test.**
- **`if not exists` / `if exists` on every statement.** Remove from any one and
  the second run throws on *that* statement. The whole schema must be idempotent;
  one non-guarded statement breaks it.
- **The table-presence assertion.** Remove it and a do-nothing migration could
  pass. It's what proves the runs actually built something.
- **The transaction wrapper.** Hardening: makes a failing run roll back cleanly
  rather than leave a half-schema. Not required for the *idempotency* proof, but
  required for the test to fail safely.

### Move 3 — the principle

Test a property by exercising it, not by inspecting the code for it. "Is this
migration idempotent?" isn't answered by reading the SQL for `if not exists` —
it's answered by *running it twice and checking nothing broke.* The repetition
is the proof. This generalizes: idempotency, commutativity, retry-safety — the
honest test of "doing it again is safe" is to do it again.

---

## Primary diagram

The full picture — two runs through the transactional runner into an
idempotent schema, then a completeness check.

```
  Idempotent migration test — run twice, then assert the end state

  ┌─ Test (migrate.test.ts) ───────────────────────────────────┐
  │  sql = read('001_agents_schema.sql')                        │
  │  runMigration(pool, sql)   ─── run 1: build                 │
  │  runMigration(pool, sql)   ─── run 2: MUST be a no-op  ◄ test│
  │  query information_schema.tables where schema = 'agents'    │
  │  assert names ⊇ {chunks, conversations, documents,          │
  │                  messages, profiles}                        │
  └──────────────────────────┬─────────────────────────────────┘
                             │  each call: one transaction
  ┌─ runMigration ───────────▼─────────────────────────────────┐
  │  begin → query(sql) → commit     (catch → rollback → throw) │
  └──────────────────────────┬─────────────────────────────────┘
                             │
  ┌─ Schema (idempotent SQL) ▼─────────────────────────────────┐
  │  create extension IF NOT EXISTS vector                      │
  │  create schema IF NOT EXISTS agents                         │
  │  create table IF NOT EXISTS agents.{5 tables}               │
  │  create index IF NOT EXISTS chunks_embedding_hnsw, ...      │
  │  alter table ... drop constraint IF EXISTS ...              │
  │   ► run 2 finds everything already present → no-op, no error│
  └──────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** `npm run migrate` (`migrate.ts:23-32`) applies this schema on a
fresh `reindb`, and may be re-run after edits without dropping the database. The
test pins the re-runnability that makes that safe. Three other test files also
call `runMigration` in their `before` hooks (`pg-vector-store.test.ts:16`,
`profile.test.ts:16`, `runtime.test.ts:23`, `supabase-trace-sink.test.ts:16`) —
all relying on the same idempotency so repeated test runs don't fail on an
already-migrated DB.

The test, annotated:

```
  test/migrate.test.ts  (lines 16-27)

  const sql = await readFile(new URL('../../sql/001_agents_schema.sql', ...), 'utf8');
  await runMigration(pool, sql);
  await runMigration(pool, sql); // idempotent — runs twice without error  ← THE test
  const { rows } = await pool.query(
    `select table_name from information_schema.tables
     where table_schema = 'agents' order by table_name`);  ← end-state probe
  const names = rows.map((r) => r.table_name);
  for (const t of ['chunks', 'conversations', 'documents', 'messages', 'profiles']) {
    assert.ok(names.includes(t), `missing table ${t}`);    ← completeness check
  }
```

The schema clauses that make the second run a no-op:

```
  sql/001_agents_schema.sql  (selected lines)

  create extension if not exists vector;                ← line 1
  create schema if not exists agents;                   ← line 2
  create table if not exists agents.documents (...);    ← line 4
  create table if not exists agents.chunks (...);       ← line 14
  alter table agents.chunks drop constraint
    if exists chunks_document_id_fkey;                  ← line 27 (idempotent drop)
  create index if not exists chunks_embedding_hnsw ...; ← line 28
  create index if not exists chunks_app_id ...;         ← line 30
```

Every `create` carries `if not exists`; the lone `alter ... drop` carries
`if exists`. Drop the guard from any one and the second `runMigration` at
`migrate.test.ts:19` turns red.

The runner that makes a failed run safe:

```
  src/migrate.ts  (lines 8-20)

  await client.query('begin');     ← one transaction per run
  await client.query(sql);         ← throws here if a statement isn't idempotent
  await client.query('commit');
  } catch (err) {
    await client.query('rollback');← failed second run leaves DB unchanged
    throw err;                     ← surfaces to the test as a failure
  }
```

---

## Elaborate

Idempotent migrations are the baseline discipline for any schema you'll evolve
over time — you can't assume a clean database on every apply, so every statement
must tolerate prior state. `if not exists` is Postgres's lever; the
`alter ... drop constraint if exists` at line 27 is the subtle one — it's how the
schema *retires* the old foreign key (see `03-contract-parity-vector-store.md`)
on databases that were created before the FK was dropped, without erroring on
databases that never had it. That single line makes the migration safe to run
across schema generations, not just twice in a row.

What this test does NOT cover (named honestly): the **rollback path**. The test
only drives the success case — both runs commit. The `catch/rollback` branch
(`migrate.ts:13-16`) is never exercised. A test that feeds deliberately broken
SQL and asserts the transaction rolled back (no partial schema) would pin the
transactional guarantee. Currently `not yet exercised` → see `audit.md` lens 5.

---

## Interview defense

**Q: Why run the migration twice in the test?**

Because that's the only honest way to test idempotency. Running it once proves
it *builds* the schema; running it twice proves it's *re-runnable* — that the
second apply on an already-migrated DB is a clean no-op, not a "relation already
exists" crash. The second call is the actual assertion.

```
  run once          run twice
  ────────          ─────────
  tests creation    tests idempotency
  passes even if    fails if any statement
  non-re-runnable   lacks IF NOT EXISTS
```

**Anchor:** "Idempotency is tested by repetition — do it twice, assert no throw."

**Q: Why also check `information_schema` instead of just 'it didn't throw'?**

Because a migration that silently did nothing also doesn't throw. The
table-presence check proves the runs actually built the five tables — so I'm
testing "re-runnable *and* complete," not just "didn't crash."

**Anchor:** "No-throw plus table-presence — both halves of 'it worked.'"

---

## Validate

1. **Reconstruct:** Write the two-line core of an idempotency test for any
   migration. (Run it, run it again, assert no throw.)
2. **Explain:** Why does `migrate.test.ts:19` (the second call) fail if someone
   removes `if not exists` from one `create table`? (That statement throws
   "already exists" on the second apply.)
3. **Apply:** A migration adds a column. Make it idempotent and write the test.
   (`add column if not exists`; run twice, assert column present in
   `information_schema.columns`.)
4. **Defend:** Someone says "idempotency is obvious from reading the SQL, skip
   the test." Argue for the test. (A future edit can drop a guard; the test
   catches it — reading the SQL each time doesn't.)

---

## See also

- `audit.md` — lens 5 (the untested rollback path of this same runner).
- `01-env-gated-integration-tests.md` — this test only runs when the gate opens.
- `03-contract-parity-vector-store.md` — the `drop constraint if exists` at
  schema line 27 is how the FK gets retired idempotently.
- `.aipe/study-software-design/` — `runMigration` split from its CLI entrypoint
  is the deep-module design that makes this testable.
