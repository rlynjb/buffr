# Env-Gated Integration Tests

**Industry names:** environment-gated tests · conditional skip ·
"integration tests behind a config flag." **Type:** Industry standard
(the `node:test` `skip` option is the language-specific lever).

---

## Zoom out, then zoom in

You have a suite where one file is a pure function and five files need a live
Postgres with the `vector` extension. You can't assume every machine that runs
`npm test` has that database. So the suite has a switch: a `DATABASE_URL` env
var that decides, per file, whether the file *runs its assertions* or *skips
clean*.

```
  Zoom out — where the gate sits

  ┌─ Test runner layer ─────────────────────────────────────┐
  │  node --test --test-concurrency=1 dist/test/*.test.js    │
  └─────────────────────────────┬───────────────────────────┘
                                │  imports each file, reads env
  ┌─ Gate layer ────────────────▼───────────────────────────┐
  │  const url = process.env.DATABASE_URL                    │
  │  describe('...', { skip: url ? false : '...' }, ...)     │ ← we are here
  └──────────┬───────────────────────────────┬───────────────┘
        url set │                       url unset │
  ┌─ DB layer ─▼─────────────┐    ┌─ skipped ─────▼──────────┐
  │ createPool → runMigration│    │ before/it never run;     │
  │ → real assertions        │    │ runner prints "skipped"  │
  └──────────────────────────┘    └──────────────────────────┘
```

Zoom in: the pattern is a **boolean computed once at module load that's handed
to `describe`'s `skip` option.** When `DATABASE_URL` is unset, the whole
`describe` block — its `before`, its `beforeEach`, its `it`s — is never
scheduled. No connection is attempted, nothing throws, the file reports
"skipped" and the run stays green.

---

## Structure pass

Three layers, one axis traced across them: **failure — where does a missing
database get contained?**

```
  Axis: "what happens when there's no database?" — traced down

  ┌──────────────────────────────────────────┐
  │ runner: node --test                       │  → would surface any
  │                                            │    thrown error as a FAIL
  └────────────────────┬───────────────────────┘
       seam: the skip option (failure flips here)
  ┌────────────────────▼───────────────────────┐
  │ gate: { skip: url ? false : 'set ...' }     │  → CONTAINS it: turns
  │                                             │    "no db" into "skipped",
  │                                             │    not "failed"
  └────────────────────┬───────────────────────┘
  ┌────────────────────▼───────────────────────┐
  │ db code: createPool(url!) in before()       │  → would THROW (connect
  │                                             │    ECONNREFUSED) if reached
  └─────────────────────────────────────────────┘
```

The seam is the `skip` option. Above it, a missing DB would be a noisy failure;
below it, a missing DB is a connection crash. The gate is the joint that flips
"crash" into "quietly skipped." That single boolean is the whole pattern.

---

## How it works

### Move 1 — the mental model

You know how a React component does an early `return null` before it ever
touches the data that isn't there yet? Same shape. The test file computes one
condition up front and, if it fails, the entire block returns before any code
that would crash gets a chance to run.

```
  The gate — one boolean, computed once, guards the block

   module load
        │
        ▼
   url = process.env.DATABASE_URL
        │
        ├── truthy ──► skip = false ──► run before → beforeEach → it (assert)
        │
        └── falsy ───► skip = 'set DATABASE_URL to run'
                          │
                          ▼
                   block never scheduled — file reports "skipped"
```

The string you pass as `skip` isn't just `true` — it's the *reason*, printed in
the runner output so a human reading "skipped: set DATABASE_URL to run" knows
exactly why and how to make it run.

### Move 2 — the walkthrough

**The condition is computed once, at module top level.** Each DB test file does
`const url = process.env.DATABASE_URL` immediately after `loadEnv()`. This runs
when the runner *imports* the file, before any test executes. One read, reused
by the whole block.

```
  Read env once at import — not per test

  import dotenv ──► loadEnv() ──► url = process.env.DATABASE_URL
                                       │
                                       └─► one value, captured for the file
```

**The boolean feeds `describe`'s options object, not an `if`.** The naive way is
to wrap the whole file in `if (url) { describe(...) }`. The `node:test` way is to
pass `{ skip: ... }` as the second argument to `describe`. The difference
matters: with the `skip` option, the runner *knows the block exists and chose to
skip it*, so it prints a skip line. With a bare `if`, the block simply doesn't
exist and the runner reports nothing — you can't tell "skipped" from "forgot to
write tests."

```
  skip option vs bare if — what the runner sees

  { skip: reason }          bare if (url) { ... }
  ───────────────           ─────────────────────
  block registered          block never registered
  runner prints "skipped"   runner prints nothing
  reason is visible         silent — looks like no tests
```

**`before` is where the crash would have been — and the gate is upstream of
it.** Inside the block, `before` does `createPool(url!)` and `runMigration`. The
`!` non-null assertion is safe *only because* the gate guarantees this code is
unreachable when `url` is undefined. The gate and the `!` are a matched pair:
the gate makes the assertion true.

**The skeleton — name each part by what breaks without it:**

- **The env read** (`url = process.env.DATABASE_URL`). Remove it and there's no
  signal to gate on; every machine tries to connect.
- **The `skip` option** (`{ skip: url ? false : reason }`). Remove it and the
  block always runs; a laptop with no DB gets `ECONNREFUSED` in `before` and the
  file *fails* instead of skips. **This is the load-bearing part.**
- **The reason string.** Remove it (use `skip: true`) and it still works, but
  the human reading CI output doesn't know how to turn the tests on. Hardening,
  not skeleton — but cheap hardening worth keeping.

### Move 3 — the principle

A test that can't run in an environment should **skip loudly, not fail or
vanish.** The gate converts an environmental precondition into a visible,
reasoned skip — so a green run is honestly green ("these ran, those were
skipped for this reason") instead of dishonestly green (failed-and-hidden) or
misleadingly green (never-existed). The cost you accept: a machine without the
env var proves nothing about the gated code. That's a real cost, paid
knowingly — the fix is CI with the DB, not removing the gate.

---

## Primary diagram

The full picture: one env read, fanned out to five files, each gating its own
block.

```
  Env-gated integration tests — the whole pattern

  ┌─ environment ──────────────────────────────────────────────┐
  │  DATABASE_URL = postgres://...   (set on laptop, unset in   │
  │                                   a fresh clone / plain CI)  │
  └───────────────────────────────┬────────────────────────────┘
                                  │ read once per file at import
   ┌──────────────┬───────────────┼───────────────┬──────────────┐
   ▼              ▼               ▼               ▼              ▼
 migrate     pg-vector-store   profile        runtime      trace-sink
   │              │               │               │              │
   └──────────────┴───── { skip: url ? false : 'set ...' } ──────┘
                                  │
                  url set ────────┼──────── url unset
                       │                         │
              run before/it             skip — report reason,
              against real Postgres     assert nothing, stay green

  (config.test.ts has NO gate — pure unit, always runs)
```

---

## Implementation in codebase

**Use cases.** Every `src/` module that opens a `pg.Pool` is behind this gate.
The author runs the full suite locally with `DATABASE_URL` set in `.env`
(loaded by `dotenv`); anyone cloning the repo without Postgres still gets a
green `npm test` from `config.test.ts` plus five honest skips.

The gate, identical across all five DB files — shown from `migrate.test.ts`:

```
  test/migrate.test.ts  (lines 8-13)

  loadEnv();                                    ← dotenv fills process.env
  const url = process.env.DATABASE_URL;         ← read ONCE at module load
                                                   │
  describe('agents schema migration',           │
    { skip: url ? false : 'set DATABASE_URL to run' },  ← the gate
    () => {                                      │
      let pool: ReturnType<typeof createPool>;   │
      before(() => { pool = createPool(url!); }); ← url! safe ONLY because
                                                   the gate guarantees we're
                                                   here only when url is set
```

The same three lines appear at `pg-vector-store.test.ts:9-12`,
`profile.test.ts:9-12`, `runtime.test.ts:11-19`, and
`supabase-trace-sink.test.ts:9-12`. The contrast that proves the pattern is
deliberate: `config.test.ts` has **no** gate (`config.test.ts:5`) — because
`loadConfig({})` is pure and needs no database, so it always runs.

Why the `delete ... where app_id = 'test'` in each `beforeEach` is safe under
this gate: those deletes only ever execute *inside* the un-skipped block, so
they never touch a database that isn't there.

---

## Elaborate

This pattern comes straight from the test pyramid's oldest tension: integration
tests are the most valuable (they catch real seam bugs) and the most
fragile-to-run (they need real infrastructure). Every ecosystem grows a version
of this gate — JUnit's `@EnabledIfEnvironmentVariable`, pytest's
`skipif`, Go's `testing.Short()`. `node:test`'s `skip` option is Node's.

The honest follow-on is CI. The gate solves "don't fail on a machine without a
DB." It does *not* solve "make sure the gated tests actually run somewhere." A
repo with this gate and no CI that provisions the DB has tests that, in
practice, run only on the author's laptop. The standard completion of the
pattern is a CI job that spins up a Postgres+pgvector container, sets
`DATABASE_URL`, and runs the same suite — flipping every skip to a real
assertion exactly where it counts. → see `audit.md` lens 7, fix #1.

---

## Interview defense

**Q: Why gate on `DATABASE_URL` instead of just mocking the database?**

Because the thing these tests assert is *database behavior* — cosine ranking
via `embedding <=> $1::vector`, `on conflict` upserts, `if not exists`
idempotency. A mock can't have those behaviors; it can only return whatever I
told it to. Mocking here would test the mock. So I run against real Postgres and
gate on its availability instead.

```
  mock the DB          gate on real DB
  ───────────          ──────────────
  returns canned rows  runs real cosine ordering
  proves I wrote       proves pgvector ranks
  the mock             planted#0 first
```

**Anchor:** "I test the SQL contract against real pgvector and skip-with-reason
when it's not reachable."

**Q: What's the danger of this pattern?**

A green run that proves nothing. On any machine without `DATABASE_URL`, five of
six files skip and the check is green having asserted almost nothing. The fix
isn't to drop the gate — it's CI that sets the var so the gate opens.

**Anchor:** "Skip-clean locally, run-for-real in CI — the gate without CI is
half the pattern."

---

## Validate

1. **Reconstruct:** From memory, write the one line that gates a `describe`
   block on an env var in `node:test`, including a human-readable reason.
   (Answer shape: `describe(name, { skip: url ? false : 'reason' }, fn)`.)
2. **Explain:** Why is `createPool(url!)` at `migrate.test.ts:13` type-safe
   despite `url` being `string | undefined`?
3. **Apply:** A new test needs Ollama running, not Postgres. Write the gate.
   (Read `OLLAMA_HOST` or a reachability flag; same `skip` shape.)
4. **Defend:** Your CI shows all tests green but `pg-vector-store.test.ts` never
   ran. Is the suite passing? (No — it skipped; green ≠ ran. Fix: provision the
   DB in CI.)

---

## See also

- `audit.md` — lens 4 (the "green by skipping" trap), lens 7 fix #1 (CI).
- `02-fake-embedder-injection.md` — the *other* way buffr removes an external
  dependency from a test: substitution instead of skipping.
- `04-idempotent-migration-test.md` — what runs once the gate opens.
- `.aipe/study-software-design/` — the injected-pool design that makes these
  tests gate-able in the first place.
