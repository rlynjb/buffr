# Env-Gated Integration Tests

**Industry names:** environment-gated tests · skip-by-default integration suite ·
"DATABASE_URL present?" guard. **Type:** Industry standard (the *pattern* — a
test that skips when its external dependency is absent).

## Zoom out, then zoom in

Eight of buffr's nine tests need a live Postgres. Run them on a laptop with no
`DATABASE_URL` and they don't fail — they *skip*. That's the pattern: a test
declares its external dependency, checks for it at load time, and gracefully
opts out when it's missing instead of erroring.

```
  Zoom out — where the gate sits in the test run

  ┌─ Test runner ───────────────────────────────────────────────┐
  │  node --test --test-concurrency=1 dist/test/*.test.js        │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ loads each file
  ┌─ Gate layer ──────────────────▼──────────────────────────────┐
  │  const url = process.env.DATABASE_URL                         │
  │  describe('...', { skip: url ? false : '...' }, () => {...})  │ ← ★ HERE
  └──────────────┬────────────────────────────┬───────────────────┘
        url set  │                             │  url absent
  ┌─ Postgres ───▼──────────┐       ┌──────────▼──────────────────┐
  │  reindb / agents schema │       │  describe block SKIPPED     │
  │  test runs for real     │       │  reported green, never ran  │
  └─────────────────────────┘       └─────────────────────────────┘
```

Zoom in: the gate is one expression — `{ skip: url ? false : 'set DATABASE_URL
to run' }` — passed as the options arg to `describe`. When `url` is falsy, the
string becomes the skip reason and the whole block is excluded. The question it
answers: *how do you ship a DB-touching suite that doesn't punish a contributor
who hasn't set up Postgres yet?* The honest cost — covered below — is that the
same gate hides "I tested nothing" behind a green checkmark.

## The structure pass

**Layers.** The runner picks files; the gate decides if a block runs; Postgres
either backs it or doesn't.

**Axis — trace "what guarantees does a green result give?" down the layers:**

```
  One question, held constant: "green means what?"

  ┌───────────────────────────────────────┐
  │ runner: exit 0                         │  → "all selected tests passed"
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ gate: block skipped (no url)         │  → "this contract NOT checked"
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ Postgres: query asserted         │  → "this contract HELD"
          └─────────────────────────────────┘

  green means a STRONG guarantee at the bottom, a WEAK one at the top —
  the gate is exactly where the meaning flips
```

**Seam.** The gate is a load-bearing seam: the *trust* axis flips across it.
Below the gate, a passing test means the SQL actually ran and returned the right
rows. Above it, "passing" can mean "skipped." Same word, two meanings — that's
what makes the boundary worth studying.

## How it works

#### Move 1 — the mental model

You already know the shape from a `fetch()` with a feature check: `if
(!navigator.onLine) return cached;` — you guard the expensive path behind a
precondition and degrade instead of crashing. An env-gated test is the same
move at the suite level: guard the DB-dependent block behind "is the DB
reachable?" and degrade to *skip* instead of *fail*.

```
  The gate pattern

  load test file
        │
        ▼
  read DATABASE_URL ──────────────┐
        │                         │
   present?                    absent?
        │                         │
        ▼                         ▼
  skip: false                skip: "reason string"
        │                         │
        ▼                         ▼
  run before/beforeEach      block excluded entirely
  + it() against real DB     (before/after never fire)
```

The kernel: **a precondition read at load time + a skip directive that takes a
reason.** Drop the precondition and the suite throws `ECONNREFUSED` on every
machine without a DB. Drop the reason string and a skipped run is silent — the
reason is what tells a reader *why* it skipped.

#### Move 2 — the walkthrough

**The gate expression itself.** Every DB test file opens identically. Here's
`pg-vector-store.test.ts:9-12` side by side with what each line does:

```ts
loadEnv();                                  // dotenv: populate process.env from .env
const url = process.env.DATABASE_URL;       // read the precondition ONCE, at load
describe('PgVectorStore',
  { skip: url ? false : 'set DATABASE_URL to run' },  // ← the gate
  () => { /* before/beforeEach/it all live here */ });
```

`skip: false` runs the block. `skip: '<string>'` skips it and prints the string
as the reason. The ternary collapses "is the env var set?" into exactly that.

**Why the gate wraps `describe`, not each `it`.** Put it on the `describe` and
the `before` hook — which calls `createPool(url!)` (`pg-vector-store.test.ts:15`)
— never fires when skipped. That `url!` non-null assertion is *safe precisely
because* the gate guarantees the hook only runs when `url` is truthy. The gate
and the `!` are a matched pair: the gate proves the invariant the `!` assumes.

```
  Layers-and-hops — the gate decides whether the pool is ever opened

  ┌─ Test file ──────────┐  url present   ┌─ before() hook ─────────────┐
  │  describe + gate     │ ─────────────► │  pool = createPool(url!)     │
  │                      │                │  runMigration(pool, sql)     │
  └──────────────────────┘                └──────────────┬───────────────┘
            │ url absent                          query   │
            ▼                                             ▼
  ┌─ skipped ────────────┐                        ┌─ Postgres ───────────┐
  │  hooks never run     │                        │  agents schema       │
  │  pool never opened   │                        └──────────────────────┘
  └──────────────────────┘
```

**The pure-function exception proves the rule.** `config.test.ts` has *no* gate
(lines 5-20) — it tests `loadConfig({})`, which needs nothing external. It runs
on every machine. That's the contrast that makes the pattern legible: gate the
tests that need the world, leave the pure ones ungated.

#### Move 2.5 — current state vs the honest gap

```
  Phase A — today                    Phase B — what closes the gap
  ─────────────────────              ───────────────────────────────
  no DATABASE_URL → 8 skip, 1 run    CI provisions Postgres service
  suite reports GREEN                gate sees url → 8 run
  "passing" tested ~1 fn             assert skipped-count == 0,
                                       else FAIL the build
```

The gate is the right *mechanism* — it should stay. What's missing is a CI job
that sets `DATABASE_URL` and then *fails if anything skipped*. Without that
assertion, "tests pass" on a fresh runner means "one pure function passed."

#### Move 3 — the principle

A test that skips when its dependency is absent is honest about *what it can't
check* — but only if something downstream notices the skip. **An env gate
without a CI assertion that the gate opened is a green light wired to nothing.**
The pattern is sound; it's incomplete until the skip count is itself asserted.

## Primary diagram

```
  Env-gated integration test — full picture

  ┌─ Runner ─────────────────────────────────────────────────────┐
  │  node --test  →  loads config/migrate/pg-vector/profile/...   │
  └───────────────────────────────┬──────────────────────────────┘
                                  ▼
  ┌─ Gate (per file) ─────────────────────────────────────────────┐
  │  url = process.env.DATABASE_URL                                │
  │  skip: url ? false : 'set DATABASE_URL to run'                 │
  └──────────┬─────────────────────────────────┬──────────────────┘
       set   │                                 │  absent
  ┌─ run ────▼─────────────────┐    ┌─ skip ───▼──────────────────┐
  │ before: pool + migrate     │    │ block excluded               │
  │ beforeEach: delete app_id  │    │ ★ suite still green          │
  │ it: assert real query      │    │ ★ CI must fail if count > 0  │
  │ after: pool.end()          │    └──────────────────────────────┘
  └────────────────────────────┘
```

## Elaborate

This pattern comes from the classic split between unit tests (no external deps,
run anywhere) and integration tests (need a real service). The skip-don't-fail
choice optimizes for *contributor friction*: a new dev clones, runs `npm test`,
sees green, and isn't blocked by a missing Postgres they haven't set up. The
tradeoff — accepted deliberately — is that green stops meaning "everything
works" until CI enforces the gate opened. Compare `migrate.ts:23`'s
`import.meta.url === ...` main-guard: same family of move (run-only-when-the-
context-is-right), applied to a CLI entry instead of a test block.

## Interview defense

**Q: Eight of nine tests skip without a database. Isn't that suite worthless?**
The mechanism is right, the CI is missing. Skipping rather than failing is
correct — it keeps a contributor without Postgres unblocked, and the gate's
`url ? false : 'reason'` is exactly how `node:test` expresses that. What's
missing is the assertion that the gate *opened*: a CI job that provisions
Postgres, sets `DATABASE_URL`, and fails if the skipped count isn't zero. Without
that, green means "one pure function passed."

```
  the load-bearing part people forget:
  the gate proves nothing UNLESS something asserts it didn't skip
  → CI: run with DB, assert skipped == 0
```

**Anchor:** "Skip-don't-fail is right for contributors; it's a lie to CI until CI
fails on a non-zero skip count."

## See also

- `audit.md` lens 4 — green-by-skip as a determinism/isolation finding.
- `02-fake-embedder-injection.md` — the *other* gate: tests that need a model,
  not a DB, dodge it by injecting a fake instead of skipping.
- `04-idempotent-migration-test.md` — a gated test whose value is the second run.
- `study-debugging-observability` — what a green-by-skip CI run hides.
