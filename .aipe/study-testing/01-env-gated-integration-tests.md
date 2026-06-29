# Environment-gated integration tests

**Industry name:** environment-gated / conditionally-skipped integration tests · the `skip` predicate. *Language-agnostic pattern, here on `node:test`.*

**Determinism seam:** testing (deterministic). These are real integration tests asserting exact values against a live database; the gate decides *whether they run*, not *what they assert*.

---

## Zoom out, then zoom in

Most of this suite needs a Postgres with pgvector. CI runners and fresh laptops don't have one. The naive options are both bad: hard-fail (every machine without a DB shows red, so people learn to ignore red) or delete the tests (no integration coverage at all). This pattern is the third option — the tests *announce themselves as skipped* when their dependency is absent, so the suite stays green-and-honest.

```
  Zoom out — where the gate sits in the test run

  ┌─ Test runner (node --test) ─────────────────────────┐
  │  loads dist/test/*.test.js                           │
  └───────────────────────────┬──────────────────────────┘
                              │ each describe() evaluated
  ┌─ Gate layer ─────────────▼──────────────────────────┐
  │  const url = process.env.DATABASE_URL                │
  │  describe('...', { skip: url ? false : 'set ...' })  │ ← ★ THIS PATTERN ★
  └───────────────────────────┬──────────────────────────┘
                  url set?     │
              ┌────────────────┴────────────────┐
              ▼ yes                              ▼ no
  ┌─ Integration ────────┐         ┌─ Skipped (reported, not failed) ─┐
  │  real Postgres        │         │  "1..1 # SKIP set DATABASE_URL"  │
  │  assert.equal(...)    │         │  suite stays green               │
  └───────────────────────┘         └───────────────────────────────────┘
```

Zoom in: the pattern is a **predicate computed once at module load** (is the database reachable?) handed to `node:test`'s `skip` option on the `describe` block. When the predicate says "no," every test inside is marked skipped with a human-readable reason instead of executed. The transferable name is *conditionally-skipped integration test*; the local shape is the `{ skip: url ? false : 'set DATABASE_URL to run' }` argument.

---

## The structure pass

**Layers:** (1) the runner that loads compiled test files, (2) the gate predicate at module top level, (3) the `describe` block whose execution the gate controls, (4) the `before`/`after` lifecycle that opens and closes the real pool.

**Axis traced — *what decides whether this code runs?*** At the runner layer, the runner decides (it always loads the file). At the gate layer, the *environment* decides (`DATABASE_URL` present or not). Inside the block, once admitted, the runner decides again (it runs every `it`).

**The seam:** the boundary between "file always loads" and "tests conditionally run" is the `skip` option. That's where the control axis flips from runner-decides to environment-decides — which makes it the load-bearing joint. Get the predicate wrong (e.g. compute it inside a test instead of at the gate) and you get half-run suites that fail confusingly mid-block.

---

## How it works

### Move 1 — the mental model

You already know the React pattern where you guard a render: `{isLoading ? <Spinner/> : <Data/>}` — the condition decides which subtree exists. The skip gate is the same shape one level up: the predicate decides whether a whole *block of tests* exists in this run. Same ternary, same "compute the condition once, branch the subtree."

```
  The gate kernel — one predicate, two outcomes

   module load
        │
        ▼
   url = process.env.DATABASE_URL    ── read ONCE, at load
        │
        ▼
   skip = url ? false : '<reason>'   ── false means "run"; a string means "skip, here's why"
        │
        ▼
   describe(name, { skip }, body)    ── runner honors skip before entering body
```

### Move 2 — the walkthrough

**Read the gate once, at module top level.** Every gated test file opens identically: load `.env`, then snapshot the URL.

```ts
// test/pg-vector-store.test.ts:9-10
loadEnv();
const url = process.env.DATABASE_URL;
```

`loadEnv()` (dotenv) pulls `DATABASE_URL` from `.env` if it's there. The snapshot into `url` happens *once* — not re-read per test — so the whole block makes one consistent decision. If you read `process.env` inside each `it`, a half-set environment could run some tests and skip others in the same block; reading once at the top removes that whole class of confusion.

**Hand the predicate to `describe`'s skip option.** This is the line that does the work:

```ts
// test/pg-vector-store.test.ts:12
describe('PgVectorStore', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
```

`node:test` reads `skip` *before* executing the body. `false` → run normally. A **string** → skip, and the string becomes the reason printed in the TAP output. Returning the reason string (not just `true`) is the part people forget — it turns a silent skip into a self-documenting one. A developer who runs `npm test` and sees `# SKIP set DATABASE_URL to run` knows exactly why the suite was quiet, and exactly how to make it run.

**Open the real dependency in `before`, close it in `after`.** Because the block only runs when admitted, the lifecycle hooks only fire then — so the pool is never opened on a skip.

```ts
// test/pg-vector-store.test.ts:13-22
before(async () => {
  pool = createPool(url!);                       // url! — the gate guarantees it's set here
  const sql = await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8');
  await runMigration(pool, sql);                 // schema exists before any test runs
});
beforeEach(async () => {
  await pool.query("delete from agents.chunks where app_id = 'test'");  // isolation by app_id
});
after(async () => { await pool.end(); });        // release the pool so the runner can exit
```

The `url!` non-null assertion (`createPool(url!)`) is safe *only because* the gate already proved `url` is set — the type system can't see that, but the runtime guarantee holds. The `before` migrates the schema so each file is self-sufficient; the `after` ends the pool so node doesn't hang with an open connection.

```
  Layers-and-hops — what crosses the boundary on a run

  ┌─ Test file ──────┐  hop 1: createPool(url)     ┌─ Storage ────────┐
  │  before()        │ ──────────────────────────► │  pg Pool         │
  │                  │  hop 2: runMigration(sql)    │  → reindb        │
  │                  │ ──────────────────────────► │  agents schema   │
  │  beforeEach()    │  hop 3: delete app_id='test' │                  │
  │                  │ ──────────────────────────► │  (isolation)     │
  │  after()         │  hop 4: pool.end()           │                  │
  │                  │ ──────────────────────────► │  (release)       │
  └──────────────────┘                              └──────────────────┘
```

### Move 3 — the principle

A test that fails for a reason unrelated to the code under test trains people to ignore failures. The gate keeps the signal clean: red means *the code is broken*, not *your laptop lacks a database*. The cost — stated honestly — is that the gate can hide the absence of coverage. A suite that's all-green because everything skipped looks identical to one that's all-green because everything passed. **The pattern is only complete when paired with a CI job that sets `DATABASE_URL`**, so the gated half is guaranteed to run somewhere. This repo has the gate; it does not yet have that CI job (see `audit.md` lens 7).

---

## Primary diagram

```
  Environment-gated integration test — full picture

  ┌─ module load ────────────────────────────────────────────────┐
  │  loadEnv()  →  url = process.env.DATABASE_URL                 │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ skip = url ? false : 'set DATABASE_URL to run'
  ┌─ describe(name, { skip }, …) ─▼───────────────────────────────┐
  │                                                                │
  │   url SET ──────────────────►  before(): pool + migrate        │
  │                                beforeEach(): delete app_id=test │
  │                                it(): assert.equal against pg    │
  │                                after(): pool.end()              │
  │                                                                │
  │   url UNSET ────────────────►  # SKIP set DATABASE_URL to run   │
  │                                (green, honest, never opens pg)  │
  └────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is the test-suite cousin of feature flags: a runtime condition that gates whether a code path executes, with a human-readable reason attached. The reason-string convention comes from TAP (Test Anything Protocol), which `node:test` emits — `# SKIP <reason>` is a first-class TAP directive, so tooling that reads TAP can distinguish skips from passes and failures.

The same gate appears in five files in this repo (`migrate`, `pg-vector-store`, `profile`, `runtime`, `supabase-trace-sink`) — only `config.test.ts` is ungated because `loadConfig` is pure. That consistency is what makes the suite trustworthy: there's exactly one rule for "does this test need a database," and it's visible in the first ten lines of every file.

Where to read next: `02-fake-embedder-injection.md` (the *other* external dependency, faked rather than gated — because Ollama can be substituted, but Postgres can't be faked without losing the point of the test).

---

## Interview defense

**Q: Why skip instead of mocking the database?**
Because the thing under test *is* the SQL. `PgVectorStore.search` is a cosine-distance query against an HNSW index — mock the database and you've tested your mock's idea of ranking, not pgvector's. The honest options are "run against real Postgres" or "don't test it"; the gate lets the same file do the first when a DB is present and degrade to the second cleanly when it isn't.

```
  why gate, not mock

  mock the DB  →  assert on a fake ranking  →  proves nothing about pgvector
  gate the DB  →  assert on real ranking when present, skip when absent
                  ↑ the only assertion that's actually about the code
```

*Anchor:* "Mocking the database here would test the mock, not the cosine ranking."

**Q: What's the load-bearing part people forget?**
Returning the *reason string*, not `skip: true`. `true` gives a silent skip; the string (`'set DATABASE_URL to run'`) makes the TAP output self-documenting — a developer sees why and how to fix it. And the second half: the gate is incomplete without a CI job that sets the variable, or the suite is green-by-skip forever.

*Anchor:* "Skip with a reason, and pair it with a CI job that actually sets the var — otherwise you've shipped a permanently-green no-op."

---

## See also

- `02-fake-embedder-injection.md` — the dependency that's faked instead of gated, and why.
- `03-contract-parity-test.md` — what these gated tests actually assert about `PgVectorStore`.
- `audit.md` lens 4 (isolation) and lens 7 (the green-by-skip red flag).
- `00-overview.md` gap 3 — the missing CI job that would make the gate complete.
