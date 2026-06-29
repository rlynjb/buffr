# Pure core, impure shell — loadConfig vs the CLIs

**Industry names:** functional core / imperative shell · pure function ·
the seam between policy and I/O · "push I/O to the edges." **Type:**
Industry standard.

The smallest design move in buffr and one of the most useful: keep the
decision-making code *pure* (env in, config out, no side effects) and let
the *shell* (the CLIs) do the impure work of reading `process.env` and
touching the database. The seam between them is what makes the core
testable.

Role-vocabulary for this pattern, named once:

- **the core** — `loadConfig(env)` (`config.ts`); a pure function,
  no side effects, output determined entirely by input.
- **the shell** — `createChatSession`, `cli/chat.tsx`, the index/eval
  CLIs; the impure rim that reads `process.env`, opens pools, prints.
- **the seam** — the `loadConfig(env)` call boundary: the shell passes
  real `process.env`, a test passes a fixture object.

---

## Zoom out, then zoom in

`loadConfig` sits at the very top of the dependency graph — everything
downstream is built from the `Config` it returns, but it itself depends
on nothing impure.

```
  Zoom out — the pure core at the top of the shell

  ┌─ Shell (impure rim) ─────────────────────────────────────┐
  │  cli/chat.tsx  →  createChatSession()                     │
  │                        │                                  │
  │                        │ loadEnv() reads .env  (impure)   │
  │                        ▼                                  │
  │  ┌─ Core (pure) ───────────────────────────────────────┐ │ ← we are
  │  │  ★ loadConfig(process.env)  →  Config ★             │ │   here
  │  │     no I/O · no clock · no randomness · no DB        │ │
  │  └─────────────────────────────────────────────────────┘ │
  │                        │ Config flows down               │
  │                        ▼                                  │
  │  createPool(cfg.databaseUrl)  ·  PgVectorStore(...)  ←── impure again
  └──────────────────────────────────────────────────────────┘
```

Zoom in: `loadConfig` is sixteen lines and does exactly one thing — turn
an environment object into a typed `Config`, applying defaults. It reads
no files, opens no connections, calls no clock. That purity is the whole
point: a pure function is the easiest thing in software to test, because
the same input always gives the same output and nothing else happens.

---

## The structure pass

**Layers:** the CLI shell (impure) · `loadConfig` (pure core) · the
constructed runtime (impure again — pools, stores).

**The axis: does this code have side effects?** Trace it across the seam:

```
  axis traced = "does this code touch the outside world?"

  ┌─ createChatSession ─┐  seam   ┌─ loadConfig ─┐  seam  ┌─ createPool ─┐
  │  reads .env, opens  │ ══╪═══► │  PURE: env   │ ══╪══► │ opens a TCP  │
  │  pool, prints (I/O) │       │  in, obj out  │       │ conn (I/O)   │
  └─────────────────────┘       └───────────────┘       └──────────────┘
       impure                       PURE                    impure
              the purity is an island in the middle of the shell
```

The axis flips *twice*: impure shell → pure core → impure runtime. That
double flip is the signature of functional-core/imperative-shell — a pure
island sandwiched between I/O. The seam that matters for testing is the
left one: `loadConfig(env)`, where you can substitute a fixture for
`process.env`.

---

## How it works

### Move 1 — the mental model

You know this from frontend already: a reducer. `(state, action) => state`
is pure — given the same state and action, the same next state, no
side effects, trivially testable. `loadConfig` is the same shape:
`(env) => Config`. The reactivity/rendering around a reducer is the impure
shell; the reducer is the pure core. Same split, different domain.

In one sentence: **keep the function that decides things pure, push the
functions that *do* things to the edges, and test the decisions without
the doing.**

```
  Functional core / imperative shell

         impure                pure               impure
   ┌──────────────┐      ┌──────────────┐    ┌──────────────┐
   │ read env,    │ env  │  loadConfig  │ cfg│ open pool,   │
   │ open files   ├─────►│  (decisions) ├───►│ run queries  │
   └──────────────┘      └──────────────┘    └──────────────┘
        SHELL                 CORE                SHELL
                    test THIS in isolation
```

### Move 2 — the walkthrough

**1. The core is pure by construction.** Every field is derived from the
`env` argument; nothing else is consulted:

```ts
// config.ts:8-16
/** Pure: env in, config out. The CLI passes process.env; tests pass a fixture. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: env.DATABASE_URL || undefined,     // explicit undefined, not '' — a real decision
    appId: env.AGENT_APP_ID || 'laptop',            // default lives in the core
    schema: env.AGENT_DB_SCHEMA || 'agents',        // ← the dead knob (see below)
    ollamaHost: env.OLLAMA_HOST || 'http://localhost:11434',
  };
}
```

The comment names the seam outright: "The CLI passes `process.env`; tests
pass a fixture." That's the entire benefit in one line — the core can't
tell the difference, so a test never needs a real environment.

**2. The shell does the impure read, then hands off.** `process.env`
isn't populated until `dotenv` reads `.env` — an impure file read. The
shell does that, then calls the pure core:

```ts
// session.ts:35-37  (the shell)
loadEnv();                                   // impure: reads .env into process.env
const cfg = loadConfig(process.env);         // ← the seam: pure core called with real env
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');
```

The order matters: `loadEnv()` (impure) *then* `loadConfig` (pure). The
core never reads the file; it only reads the object the shell already
populated. That keeps the file-read out of the testable unit.

**3. The seam pays off in tests.** Because the core is pure, a test
constructs `Config` with no environment, no `.env`, no mocking of
`process.env`:

```
  the seam in a test (the payoff)

  ┌─ a test ──────────────────────────────────────────────┐
  │  loadConfig({ AGENT_APP_ID: 'test' })                  │
  │     → { appId: 'test', schema: 'agents',               │
  │         databaseUrl: undefined, ollamaHost: '...' }    │
  │  assert: default applied, undefined preserved          │
  │  no .env, no dotenv, no process.env mutation needed    │
  └────────────────────────────────────────────────────────┘
```

This is what "pure is testable" cashes out to: you pass a fixture object
and assert on the return. No setup, no teardown, no global state. (The
test-coverage story for this seam lives in `study-testing/`.)

**4. The one wart — the schema field is a dead decision.** The core
computes `schema` (`config.ts:13`), but nothing downstream reads
`cfg.schema` — every query hardcodes the literal `agents.` (audit lens
3). The pure core is *correct*; the problem is that one of its outputs is
a knob no shell turns. Purity doesn't save you from computing a useless
value. The fix is to delete the field, shrinking the core to the four
things that actually flow downstream.

### Move 3 — the principle

The reason to split a pure core from an impure shell isn't elegance — it's
that **side effects are the expensive part to test**, and a pure function
has none. Every decision you can move into a pure function is a decision
you can test by passing an argument and reading a return. `loadConfig` is
tiny, so the payoff looks tiny — but the *discipline* scales: the more
decision-logic you keep pure and the more I/O you keep at the edges, the
more of your system is testable without a database, a clock, or a
network. The dead `schema` field is the counter-lesson: purity guarantees
*testability*, not *usefulness* — you still have to delete what nothing
consumes.

---

## Primary diagram

```
  loadConfig — pure core in an impure shell, full recap

  ┌─ Shell: cli/chat.tsx ────────────────────────────────────────┐
  │  await createChatSession()                                    │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
  ┌─ Shell: session.ts:35-37 ─────▼──────────────────────────────┐
  │  loadEnv()                    ← impure: .env → process.env    │
  │  const cfg = loadConfig(process.env)  ← SEAM (pure call)      │
  │  if (!cfg.databaseUrl) throw ← shell validates                │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ cfg
  ┌─ Core: config.ts:9-16 ────────▼──────────────────────────────┐
  │  loadConfig(env) → { databaseUrl, appId, schema†, ollamaHost }│
  │  PURE: output ⟸ input only. test with a fixture object.       │
  │  † schema computed but never read — dead knob (audit lens 3)  │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ cfg flows down
  ┌─ Shell again ─────────────────▼──────────────────────────────┐
  │  createPool(cfg.databaseUrl) · new PgVectorStore({appId,...}) │
  │  impure: TCP, SQL                                             │
  └───────────────────────────────────────────────────────────────┘
```

---

## Elaborate

"Functional core, imperative shell" is Gary Bernhardt's name (2012) for a
discipline older than the phrase: keep the parts that *decide* free of the
parts that *do*, so the deciding is testable in isolation. It's the same
instinct as Ousterhout's "pull complexity downward into deep modules" seen
from the testing side — a pure function is the deepest possible module for
its size, because its entire behaviour is its return value and it hides
*all* of its computation behind a signature with no side effects to mock.

The pattern shows up everywhere once you see it: a reducer vs the store, a
selector vs the component, a parser vs the file reader. buffr's instance
is modest — one config function — but the same seam (`loadConfig(env)`,
fixture-swappable) is the reason the config logic needs no integration
test.

---

## Interview defense

**Q: Why is `loadConfig` taking `env` as a parameter instead of reading
`process.env` directly?** Because the parameter is the seam. Reading
`process.env` inside the function would make it impure — to test it you'd
have to mutate a global, run, and restore. Taking `env` as an argument
makes it pure: a test passes a fixture object and asserts on the return,
no global state touched. The shell (`session.ts:36`) passes the real
`process.env`; a test passes `{ AGENT_APP_ID: 'test' }`. Same function,
different input, no mocking.

```
  reads process.env (impure)     takes env param (pure)
  ┌──────────────────┐           ┌──────────────────┐
  │ mutate global,   │           │ pass fixture,    │
  │ run, restore     │           │ assert return    │
  └──────────────────┘           └──────────────────┘
   hard to test                   trivial to test
```
*Anchor:* "the parameter is the seam — that's why it's a param, not a
global read."

**Q: Is a 16-line config function worth calling a 'pattern'?** The
function isn't the lesson; the *seam* is. The discipline — push I/O to
the shell, keep decisions pure — is what scales. `loadConfig` is the one
place this repo applies it cleanly, so it's the teaching anchor. The same
move keeps `PgVectorStore`'s validation logic (`assertDim`) pure-ish and
the trace sink's event-mapping `switch` pure. The pattern is the
discipline; the function is where you can point at it.
*Anchor:* "the function is small; the seam it demonstrates is the whole
testing strategy."

---

## See also

- `01-adapter-behind-a-contract.md` — `PgVectorStore`, the deep module
  the shell constructs from this `Config`.
- `05-deep-session-facade.md` — `createChatSession`, the shell that calls
  this core.
- `audit.md` lens 3 — the dead `cfg.schema` knob in full.
- `study-testing/` — the test coverage for this pure seam.
