# Idempotent-Migration Test

**Industry names:** idempotency test · "run it twice" test · re-entrancy check ·
convergence test. **Type:** Industry standard.

## Zoom out, then zoom in

A migration runs more than once in real life — re-deploys, a CI runner that
re-applies, a `npm run migrate` someone fires by reflex. So the test doesn't just
run the migration; it runs it **twice** and asserts the second run doesn't blow
up and the tables exist. The value of the test is entirely in the second call.

```
  Zoom out — where the migration test sits

  ┌─ Test ───────────────────────────────────────────────────────┐
  │  runMigration(pool, sql)   ← first apply                      │
  │  runMigration(pool, sql)   ← second apply (★ the real test)   │
  │  assert tables exist                                          │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ one transaction each
  ┌─ Migrate layer ───────────────▼──────────────────────────────┐
  │  begin → query(sql) → commit  (rollback on any error)        │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
  ┌─ Postgres ────────────────────▼──────────────────────────────┐
  │  agents schema: documents · chunks · conversations ·          │
  │  messages · profiles                                          │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: idempotency means *applying the operation N times leaves the same state
as applying it once*. The SQL achieves it with `create ... if not exists` and
`drop constraint if exists` — guards that make every statement a no-op when its
effect already exists. The test proves those guards actually hold. The question
it answers: *can I safely re-run this migration without breaking the database?*

## The structure pass

**Layers.** Test → `runMigration` (transaction) → Postgres schema.

**Axis — trace "what does a second run change?" down the stack:**

```
  "what does run #2 change?" — held constant down the layers

  ┌─────────────────────────────────────────┐
  │ test: calls runMigration twice           │  → expects: nothing changes
  └─────────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ migrate: begin/commit, same SQL      │  → re-executes every statement
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ Postgres: if-not-exists guards   │  → each statement no-ops
          └─────────────────────────────────┘

  the answer "nothing changes" must hold at the BOTTOM for the test to pass
```

**Seam.** The seam is the SQL guard clauses themselves (`if not exists`, `if
exists`). The *effect* axis flips across them: without the guard, a second
`create table` is an error; with it, it's a no-op. The test exercises exactly
that flip.

## How it works

#### Move 1 — the mental model

You know idempotency from HTTP: a `PUT` you can retry safely because sending it
twice lands the same state as once, unlike a `POST` that creates a duplicate. A
migration *should* be a `PUT` — re-runnable without damage. The test is the proof
that it is.

```
  Idempotency — run twice, converge to the same state

  state S0  ──runMigration──►  state S1  ──runMigration──►  state S1
   (empty)                      (schema)                     (schema)
                                    │                            │
                                    └──────── identical ─────────┘
                                          f(f(x)) == f(x)
```

The kernel: **apply twice + assert the post-state, where every statement is
guarded to no-op on the second pass.** Drop the guards and run #2 throws
`relation "documents" already exists`. Drop the *second* call and the test proves
nothing about re-runnability — it's just a setup step.

#### Move 2 — the walkthrough

**The double-apply.** `migrate.test.ts:16-19`:

```ts
const sql = await readFile(new URL('../../sql/001_agents_schema.sql', ...), 'utf8');
await runMigration(pool, sql);
await runMigration(pool, sql);   // idempotent — runs twice without error
```

The comment says the quiet part: the second line *is* the test. If `runMigration`
or the SQL weren't idempotent, this line throws and the test fails before any
assertion.

**The transaction that makes a failed run safe.** `migrate.ts:8-20`:

```ts
const client = await pool.connect();
try {
  await client.query('begin');
  await client.query(sql);        // the whole script, atomically
  await client.query('commit');
} catch (err) {
  await client.query('rollback'); // any failure → no partial schema
  throw err;
} finally {
  client.release();
}
```

The whole migration is one transaction. That's a second guarantee on top of
idempotency: if statement 7 of 10 fails, `rollback` undoes 1-6, so you never land
in a half-migrated state. The idempotency test exercises the *commit* branch
twice; the rollback branch is the untested error path (audit lens 5).

**The guards that make the SQL re-runnable.** `001_agents_schema.sql`:

```sql
create table if not exists agents.documents (...);   -- line 4: no-op if present
create table if not exists agents.chunks (...);      -- line 14
alter table agents.chunks
  drop constraint if exists chunks_document_id_fkey;  -- line 27: drops the FK,
                                                      -- no-op if already gone
create index if not exists chunks_embedding_hnsw ...; -- line 28
```

Every statement is guarded. Line 27 is the interesting one: it *drops* the FK on
databases migrated before the parity change, and `if exists` makes it a no-op on
fresh databases and on the second run. This is how the migration converges to the
same schema whether the DB is brand new, mid-upgrade, or already current.

**The assertion — the tables landed.** `migrate.test.ts:20-27`:

```ts
const { rows } = await pool.query(
  `select table_name from information_schema.tables
   where table_schema = 'agents' order by table_name`);
const names = rows.map((r) => r.table_name);
for (const t of ['chunks','conversations','documents','messages','profiles'])
  assert.ok(names.includes(t), `missing table ${t}`);
```

It queries `information_schema` (Postgres' catalog) and asserts all five tables
exist. It checks *existence*, not the second-run *delta* — the delta is implied:
if run #2 had errored, control never reaches this assertion.

```
  Execution trace — schema state across two runs

  step                         documents  chunks  FK present?
  ───────────────────────────  ─────────  ──────  ───────────
  start (fresh DB)             absent     absent  n/a
  run #1: create + drop-FK     present    present  no (dropped)
  run #2: create-if-not-exists present    present  no (idempotent)
          drop-FK-if-exists     present    present  no (no-op)
  assert: all 5 tables exist   ✓ pass
```

#### Move 3 — the principle

The test that catches the bug a single-run test can't is the one that runs the
operation *again*. Idempotency only shows up on the second application, so a
migration test that runs once tests setup, not re-runnability. **Apply twice,
assert the state converged — that's the whole technique, and the second call is
where the value is.**

## Primary diagram

```
  Idempotent-migration test — full picture

  ┌─ Test ───────────────────────────────────────────────────────┐
  │  runMigration(pool, sql)      run #1 ─┐                       │
  │  runMigration(pool, sql)      run #2 ─┤ throws here if NOT    │
  │                                       │ idempotent → test fails│
  │  query information_schema             ▼                        │
  │  assert {chunks,conversations,documents,messages,profiles}     │
  └───────────────────────────────┬──────────────────────────────┘
                                  ▼
  ┌─ runMigration: one transaction ──────────────────────────────┐
  │  begin → sql → commit   (rollback + rethrow on error)        │
  └───────────────────────────────┬──────────────────────────────┘
                                  ▼
  ┌─ SQL guards (what makes run #2 a no-op) ─────────────────────┐
  │  create table IF NOT EXISTS · create index IF NOT EXISTS ·   │
  │  alter ... drop constraint IF EXISTS                         │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Idempotent migrations are a deployment-safety discipline: deploys retry, blue-
green rollouts re-apply, and a human will eventually run `migrate` on an
already-migrated database. The `if not exists` / `if exists` family is Postgres'
built-in support for it. The pattern generalizes far past schemas — any setup
step that might run twice (creating a queue, seeding a config row, registering a
webhook) wants the same "run twice, assert converged" test. buffr's version is
notable for what it's protecting: the dropped-FK line (`001_agents_schema.sql:27`)
is the migration step that enables the contract-parity design in
`03-contract-parity-testing.md` — and the idempotency test is what proves that
drop survives a re-run.

## Interview defense

**Q: Why run the migration twice in one test?** Because idempotency only fails on
the second application. The first run tests that the schema *can* be created; the
second tests that re-applying it is safe — which is the property that actually
matters in deployment, where migrations get re-run. If the SQL weren't guarded
with `if not exists` / `if exists`, the second call throws and the test fails
before the assertion. The assertion checks the tables exist; the *second call*
checks they exist without erroring.

```
  the load-bearing part people forget:
  the SECOND runMigration is the test. drop it and you've only tested setup.
  f(f(x)) == f(x) — proven by calling f twice
```

**Anchor:** "Run it twice and assert it converged — the second call is the test;
the first is just setup."

## See also

- `audit.md` lens 5 — idempotency as the edge case that's covered; the rollback
  branch as the one that isn't.
- `03-contract-parity-testing.md` — the dropped FK this migration applies, and
  why the parity test depends on it.
- `01-env-gated-integration-tests.md` — this test skips without `DATABASE_URL`
  like every DB test.
