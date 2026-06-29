# 02 — Pure core, impure shell

**Industry name(s):** Functional core / imperative shell · "pure config
seam" · dependency injection at the edge. **Type:** Industry standard.

---

## Zoom out, then zoom in

Every entry point in buffr — the chat session, the migrate runner, the
index CLI, the eval CLI — needs the same answer to one question: *what's my
configuration?* That answer is computed by one pure function, `loadConfig`,
which touches nothing but its `env` argument. Everything *impure* —
reading `.env` off disk, opening pools, hitting Ollama — happens in the
shells around it.

```
  Zoom out — the pure seam, and the impure shells around it

  ┌─ impure shells (do I/O) ───────────────────────────────────┐
  │  chat.tsx · session.ts · migrate.ts · index-cmd · eval-cmd  │
  │  loadEnv() reads .env · createPool opens sockets · fetch    │
  └───────────────────────────┬─────────────────────────────────┘
                              │  pass process.env
  ┌─ pure core ──────────────▼─────────────────────────────────┐
  │  ★ loadConfig(env) ★   config.ts   env in → Config out      │ ← here
  │  no disk, no network, no clock, no globals                  │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: a pure function is one whose output depends only on its inputs and
which causes no side effects — so it's trivially testable (no mocks, no
setup) and trivially reasoned about (read it once, know it forever). The
question this file answers: **how does buffr keep the testable decision
separate from the untestable I/O, and where does the seam earn its keep?**

---

## Structure pass

**Layers.** Two: the shell that does I/O, the core that computes.

```
  one axis traced: "can I test this without a database?"

  ┌─ shell ─────────────────────┐  answer: NO — needs .env, pg, Ollama
  │  loadEnv → createPool → ...  │
  └───────────────┬─────────────┘
        seam ◄── testability flips here ──►
  ┌─ core ───────▼──────────────┐  answer: YES — pass a fixture env object
  │  loadConfig(env): Config    │
  └──────────────────────────────┘
```

**Axis — "can I test this without a database?"** In the shell: no. Every
shell function needs a live `.env`, a reachable Postgres, a running Ollama.
In the core: yes — `loadConfig` takes a plain object and returns a plain
object. **The axis flips at the function boundary**, which is exactly why
that boundary is worth drawing.

**Seam.** The signature `loadConfig(env: NodeJS.ProcessEnv): Config`
(`config.ts:9`) is the seam. The shell passes `process.env` (the real
thing); a test passes `{ DATABASE_URL: '...', AGENT_APP_ID: 'test' }` (a
fixture). Same function, two callers, no I/O in between. The comment at
`config.ts:8` names it outright: "The CLI passes process.env; tests pass a
fixture."

---

## How it works

### Move 1 — the mental model

You've written a React reducer: `(state, action) => newState`, pure, no
side effects, which is *why* you can unit-test it with no DOM. `loadConfig`
is a reducer over the environment: `(env) => Config`. The strategy: **push
all the impurity to the edges and keep one pure function in the middle that
holds every decision.**

```
  functional core / imperative shell — the shape

  ┌────────────── imperative shell ──────────────┐
  │  side effects: read disk, open pool, fetch    │
  │     │                              ▲          │
  │     │ env in                       │ Config   │
  │     ▼                              │ out      │
  │  ┌──────────── pure core ──────────┴───────┐  │
  │  │  loadConfig(env) — no effects, total fn  │  │
  │  └──────────────────────────────────────────┘  │
  └────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the pure function itself (what breaks: testability).**

**File:** `src/config.ts` · **Function:** `loadConfig` · **Lines:** 9-16.

```ts
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    appId:       env.AGENT_APP_ID  || 'laptop',
    schema:      env.AGENT_DB_SCHEMA || 'agents',   // ← the dead knob (§5)
    ollamaHost:  env.OLLAMA_HOST   || 'http://localhost:11434',
  };
}
```

Every line is `env.X || default`. No `readFile`, no `new pg.Pool`, no
`Date.now()`, no module-level mutable state. Make it impure — say, read
`.env` *inside* `loadConfig` — and you've welded the decision to the disk,
and now testing config requires a temp file. Keeping it pure means
`config.test.ts` passes a literal and asserts the output. **This is the
seam's whole value.**

**Part 2 — the shell injecting the real env (what breaks: nothing, by
design).**

**File:** `src/session.ts` · **Lines:** 35-37 (the pattern repeats in
every CLI).

```ts
loadEnv();                          // impure: reads .env off disk
const cfg = loadConfig(process.env);// pure: env → Config
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');
```

The shell does the two impure things — `loadEnv()` (dotenv, disk) and
passing `process.env` — then hands the *result* to the pure core. Notice the
order: load the file into `process.env`, *then* read `process.env`. The pure
function never knows a file existed. This exact three-line dance repeats in
`migrate.ts:24-26`, `index-cmd.ts:10-12`, `eval-cmd.ts:9-11`. Same seam, four
shells.

```
  layers-and-hops — env crosses the seam once per entry point

  ┌─ Disk ──────┐ hop1: dotenv reads ┌─ process.env ─┐
  │  .env file  │ ─────────────────► │  (mutated)    │
  └─────────────┘                    └───────┬───────┘
                              hop2: passed by value
                                             ▼
                                    ┌─ pure core ────┐
                                    │  loadConfig    │
                                    └───────┬────────┘
                              hop3: Config returned
                                             ▼
                                    ┌─ shell uses it ┐
                                    │  createPool... │
                                    └────────────────┘
```

**Part 3 — the crack in the seam: the dead `schema` field.**

The seam is clean except for one thing it computes and nobody uses:
`schema` (`config.ts:13`). It's pure (good), but it's a *pure computation of
a value no impure shell ever reads* — every SQL site hardcodes `agents.`
(audit §3, §5). A pure function that returns a field no one consumes isn't a
seam, it's dead code wearing a seam's clothes. The pure-core discipline makes
this *easy to fix*: delete the line, the function stays pure, every test still
passes, and the interface stops promising a knob that does nothing. The
purity is what makes the deletion safe.

### Move 3 — the principle

Separate the *decision* from the *effect*. Decisions (what's my config, what's
my dimension, which schema) are pure functions of their inputs and belong in a
core you can test with literals. Effects (disk, network, clock, pool) belong
in a thin shell that injects real inputs and consumes the decision. The payoff
is asymmetric: the core holds the logic worth testing and is the easiest thing
to test; the shell holds the I/O and barely needs testing because it has no
logic. When a pure function grows a field nobody reads, the purity is also
what makes it cheap to cut.

---

## Primary diagram

The seam, its four shells, and the dead field, in one frame.

```
  loadConfig — one pure seam, four impure shells

  ┌─ shells (impure, do I/O) ──────────────────────────────────┐
  │  session.ts  migrate.ts  index-cmd.ts  eval-cmd.ts          │
  │     each: loadEnv() → loadConfig(process.env) → createPool  │
  └──────────────────────────┬──────────────────────────────────┘
                  process.env │  (real)        fixture │ (tests)
                             ▼                         ▼
  ┌─ pure core ──────────────────────────────────────────────────┐
  │  loadConfig(env): Config         config.ts:9-16               │
  │    databaseUrl ─┐                                             │
  │    appId        ├─ consumed by shells ✓                       │
  │    ollamaHost  ─┘                                             │
  │    schema ───────  consumed by NOBODY ✗  ← delete (audit §5)  │
  └──────────────────────────────────────────────────────────────┘
```

---

## Elaborate

"Functional core, imperative shell" is Gary Bernhardt's framing of a much
older idea (referential transparency from FP). APOSD's angle: pure functions
are *deep* in a specific way — a huge amount of "what's the right config"
logic could live behind a trivial `(env) => Config` interface, and it's
maximally testable because it has no hidden dependencies.

You use this shape everywhere without naming it — a Redux reducer, a Vue
computed property, a pure `formatPrice(cents)` helper. buffr's contribution
is doing it at the *config boundary*, which is where most apps get sloppy and
read `process.env` deep inside business logic. Keeping config a pure function
of `env` means every CLI shares one tested decision.

Read next: `audit.md` §5 (the `schema` knob as the pull-complexity-downward
finding) and `.aipe/study-testing/` *(when generated)* — this seam is the
design reason the test suite can run without a database for config.

---

## Interview defense

**Q: Why is `loadConfig` a separate pure function instead of just reading
`process.env` where you need it?**
Testability and single-source-of-truth. Pure `(env) => Config` means
`config.test.ts` passes a literal object and asserts the result — no temp
files, no env mutation, no mocks. And every entry point gets the *same*
defaults (`appId = 'laptop'`, `ollamaHost = localhost:11434`) instead of four
copies drifting apart. The shell does I/O; the core does the decision.

```
  why pure: the test needs no world

  test ─► loadConfig({DATABASE_URL:'x'}) ─► assert cfg.appId === 'laptop'
          no disk · no pool · no network · runs in microseconds
```

**Q: Is there a flaw in the current config?**
Yes — `schema` (`config.ts:13`) is computed from `AGENT_DB_SCHEMA` and never
read; every query hardcodes `agents.`. It's a pure field with no consumer, so
the env knob is a false promise. Because the function is pure, deleting the
field is a one-line, fully-safe change — that's a side benefit of the
discipline.

**Anchor:** "Decisions are pure functions of their inputs; effects live in a
thin shell that injects the inputs and consumes the decision."

---

## See also

- `audit.md` §5 (pull complexity downward — the `schema` knob), §1.
- `03-dependency-as-a-boundary.md` — the impure shell wires aptkit's deps.
- `.aipe/study-testing/` *(when generated)* — the seam's payoff in tests.
