# Pure core, impure shell — `loadConfig` vs the `cli/*` edges

**Subtitle:** Functional Core / Imperative Shell — *Industry standard*.
The pure function `loadConfig` is the testable core; the CLI files are the
imperative shell that does all the I/O.

---

## Zoom out, then zoom in

The CLIs are where all the dirty work lives — reading `.env`, opening a pool,
draining it, writing to stdout. But buried in the middle of every one of them is a
single pure function that takes the environment and returns a config object with
no side effects at all. That separation is the whole pattern.

```
  Zoom out — where the pure core sits inside the impure shell

  ┌─ cli/ (impure shell) ────────────────────────────────────────┐
  │  loadEnv()           ← reads .env from disk      (side effect)│
  │  process.env         ← ambient global            (side effect)│
  │     │                                                          │
  │     ▼                                                          │
  │  ┌─ ★ loadConfig(env) ★ ──────────────────────┐               │ ← we are here
  │  │  pure: env in → Config out, no I/O          │  (core)       │
  │  └─────────────────────────────────────────────┘               │
  │     │                                                          │
  │     ▼                                                          │
  │  createPool() · readFile() · agent.answer() · pool.end()       │
  │                       (all side effects)                       │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is *functional core, imperative shell*. `loadConfig`
(`src/config.ts:9`) is the core: deterministic, no I/O, the same env always
produces the same config. Everything around it — `cli/index-cmd.ts`,
`ask-cmd.ts`, `eval-cmd.ts` — is the shell: it gathers the impure inputs, calls
the pure core, then performs the effects the core decided. You test the core
without a database; you keep the shell thin enough that there's little left to
test.

---

## Structure pass — layers · axis · seams

Two layers: the shell (CLI files) and the core (`loadConfig`). The axis that makes
the boundary pop is **side effects** — who is allowed to touch the outside world.

```
  Axis traced = "is a side effect allowed here?"

  ┌─ shell: cli/*.ts ─┐  seam: loadConfig()  ┌─ core: config.ts ─┐
  │  YES — reads .env,│ ════════╪═══════════► │  NO — pure fn,    │
  │  opens pools,     │   (effects flip OFF)  │  env→Config,      │
  │  writes stdout    │                       │  no I/O           │
  └───────────────────┘                       └───────────────────┘
       ▲                                              ▲
       └─ effects live out here ── decisions live in here ─┘
```

- **The seam: `loadConfig(env)`.** Above it, side effects are everywhere. Below
  it, none. The function takes `env` *as an argument* rather than reaching for the
  global `process.env` itself — that's the move that flips the axis. The shell
  passes `process.env`; a test passes a fixture object.
- **Why the seam is load-bearing:** it's the substitution point. Because
  `loadConfig` doesn't read the global, a test calls `loadConfig({ AGENT_APP_ID:
  'x' })` with no environment setup and asserts the output. The effect-free core
  is the only thing in the config path worth unit-testing, and the seam is what
  makes it reachable.
- **The shell's discipline:** every CLI follows the identical preamble —
  `loadEnv()`, `loadConfig(process.env)`, guard `DATABASE_URL`, build objects,
  run, `pool.end()`. The effects are sequenced at the edge, never interleaved into
  the core.

---

## How it works

### Move 1 — the mental model

You know how a React reducer is a pure `(state, action) => state` and the
`dispatch`/effects live outside it in `useEffect`? Same split here. `loadConfig`
is the reducer — pure, total, testable. The CLI is the effect layer that feeds it
inputs and acts on its output. The strategy: **push the side effects to the edges
and keep a deterministic core in the middle.**

```
  The shape — effects funnel in, pure decision, effects funnel out

   .env ─┐
   env   ├─► loadConfig(env) ─► Config ─► createPool · readFile · run
   args ─┘     (pure core)                   (effects, back at the edge)
        impure in            pure              impure out
```

### Move 2 — the step-by-step walkthrough

**The core is total — every field has a defined value.** `loadConfig` never
returns `undefined` for `appId`, `schema`, or `ollamaHost`; each falls back to a
default with `||` (`src/config.ts:11-14`). `databaseUrl` is the one allowed to be
`undefined` — because "no database configured" is a real state the shell must
handle, not a default the core can invent. The boundary condition: pass an empty
env `{}` and you still get a valid `Config` with `appId: 'laptop'`. The core can't
fail.

```
  loadConfig — defaults make it total

   env.AGENT_APP_ID   || 'laptop'     ← always a string
   env.AGENT_DB_SCHEMA|| 'agents'     ← always a string (but see: dead, below)
   env.OLLAMA_HOST    || 'http://...' ← always a string
   env.DATABASE_URL   || undefined    ← deliberately optional: shell decides
```

**The shell guards what the core left optional.** The core returns
`databaseUrl?: undefined`; the shell turns that into a hard failure at the
entrance: `if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set')`
(`src/cli/index-cmd.ts:12`, `ask-cmd.ts:15`, `eval-cmd.ts:11`). This is the right
division of labor — the core *describes* the world (db may be absent), the shell
*decides* what to do about it (die loudly). Move the guard into the core and
you've made `loadConfig` throw, which means tests can no longer call it with a
fixture that omits the URL.

```
  Division of labor across the seam

   core:  "databaseUrl might be undefined"   (describes reality, no opinion)
   shell: "undefined? throw and die"         (acts on it, owns the effect)
```

**The shell drains its own resources.** Every CLI ends with `await pool.end()`
(`src/cli/index-cmd.ts:27`, `ask-cmd.ts:38`, `eval-cmd.ts:34`). The core never
opens a pool, so it never has to close one. All resource lifecycle lives in the
shell — open at the top, drain at the bottom. The boundary: forget `pool.end()`
and the CLI hangs after its work is done because the pool's idle connections keep
the event loop alive.

### Move 2.5 — the dead knob in the core

One honest wart: the core computes a field nothing in the shell reads.
`schema: env.AGENT_DB_SCHEMA || 'agents'` (`src/config.ts:13`) produces
`cfg.schema`, but every SQL string in the persistence layer hardcodes the literal
`agents.` instead of interpolating it. So the core promises a configurable schema
the shell never honors.

```
  Current state vs intended state — the schema knob

   intended:  loadConfig → cfg.schema → SQL uses `${cfg.schema}.chunks`
   current:   loadConfig → cfg.schema → (read by nobody)
                                         SQL hardcodes `agents.chunks`

   fix: pick one — delete cfg.schema, OR thread it into the SQL.
        Today the core's output lies about what's configurable.
```

This is a core/shell mismatch: the pure core offers a decision the impure shell
declines to use. See `audit.md` Lens 3 and Lens 5.

### Move 3 — the principle

The value of the split isn't purity for its own sake — it's that **the only part
worth testing in isolation is the part with no I/O, and you can only reach it if
it doesn't reach for I/O itself.** `loadConfig` takes `env` as a parameter so it
never touches `process.env`. That one choice is what turns "test the config" from
"set up environment variables and a process" into "call a function with an
object." Pure cores are testable cores.

---

## Primary diagram

The whole pattern in one frame.

```
  Functional core / imperative shell across the three CLIs

  ┌─ impure shell (cli/index · ask · eval) ──────────────────────┐
  │  loadEnv() ─► loadConfig(process.env) ─► guard DATABASE_URL   │
  │      │              │                          │              │
  │   reads .env    ┌───▼──────────────┐       throw if unset     │
  │   (effect)      │ config.ts:9      │                          │
  │                 │ pure: env→Config │  ← the only unit-tested  │
  │                 │ no I/O           │     thing in this path   │
  │                 └───┬──────────────┘                          │
  │                     ▼                                         │
  │  createPool ─► OllamaEmbeddingProvider ─► PgVectorStore ─► run│
  │                                                   │           │
  │                                              await pool.end() │
  └──────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Every CLI entry reaches for this split. Indexing
(`src/cli/index-cmd.ts:10-12`), asking (`src/cli/ask-cmd.ts:13-15`), and eval
(`src/cli/eval-cmd.ts:9-11`) all run the identical core call + shell guard. The
migration runner does too (`src/migrate.ts:24-26`), inside its `import.meta.url`
main-module check. The core is one function reused by four shells.

**Code side by side.**

```
  src/config.ts  (loadConfig, lines 9-16)  — the pure core

  export function loadConfig(env: NodeJS.ProcessEnv): Config {
    return {                                  ← no I/O, no globals, just a map
      databaseUrl: env.DATABASE_URL || undefined,  ← optional: shell decides
      appId: env.AGENT_APP_ID || 'laptop',         ← total: always a value
      schema: env.AGENT_DB_SCHEMA || 'agents',      ← DEAD: computed, never read
      ollamaHost: env.OLLAMA_HOST || 'http://localhost:11434',
    };
  }
       │
       └─ takes `env` as a PARAM, not process.env directly. That's the
          whole testability story: test passes {AGENT_APP_ID:'x'}, no
          environment setup, no process. (Lens: pull complexity down.)
```

```
  src/cli/ask-cmd.ts  (the shell, lines 13-19, 38) — effects at the edge

  loadEnv();                                  ← side effect: read .env from disk
  const cfg = loadConfig(process.env);        ← cross into the pure core, once
  if (!cfg.databaseUrl)                        ← shell acts on the core's optional
    throw new Error('DATABASE_URL is not set (see .env)');
  const question = process.argv.slice(2).join(' ');  ← gather impure input
  ...
  const pool = createPool(cfg.databaseUrl);   ← open resource (effect)
  ...
  await pool.end();                            ← drain resource (effect) — drop
                                                  this and the process hangs
```

---

## Elaborate

Functional core / imperative shell (Gary Bernhardt's framing) is the testing-flavored
cousin of dependency inversion. The point is to maximize the surface that's
deterministic and minimize the surface that needs integration tests. buffr applies
it narrowly — only `loadConfig` is a true pure core; the rest of the "core"
(`PgVectorStore`, `loadProfile`) is impure because it talks to Postgres, but those
take an *injected* pool, which is the same testability idea by a different
mechanism (dependency injection rather than purity). The pattern's neighbor is
`04-dependency-as-a-boundary.md`: both are about keeping the parts you reason
about separate from the parts you can't control.

---

## Interview defense

**Q: Why does `loadConfig` take `env` as a parameter instead of reading
`process.env` directly?** Because reaching for the global makes the function
impure and untestable without environment manipulation. As a parameter, the
function is a pure `env → Config` map: a test passes a fixture object and asserts
the result with zero setup (`test/config.test.ts`). The shell passes the real
`process.env`; the core never knows the difference.

```
  reads global (bad)              takes param (chosen)
  ──────────────────              ────────────────────
  loadConfig() { process.env }    loadConfig(env) { env }
  test: mutate process.env        test: pass {AGENT_APP_ID:'x'}
  impure, order-dependent         pure, deterministic
```

**Q: Should the `DATABASE_URL` guard live in `loadConfig`?** No. If the core
throws, it's no longer total — tests can't construct a config without a URL, and
you've coupled "describe the config" to "demand a database." The core describes
(`databaseUrl?: undefined`); the shell decides (`throw`). Keep them apart.

**Q: What's the wart in the core?** `cfg.schema` is computed and read by nobody
(`src/config.ts:13`) — the SQL hardcodes `agents.`. The core promises
configurability the shell doesn't deliver. Fix: delete the field or thread it
through.

---

## Validate

1. **Reconstruct:** which one field of `Config` is allowed to be `undefined`, and
   why is that the core's job to leave open rather than default? (`databaseUrl`,
   `src/config.ts:11`.)
2. **Explain:** why is `loadConfig` the only thing in the config path worth a unit
   test? (No I/O; deterministic; `env` injected.)
3. **Apply:** add an `OLLAMA_TIMEOUT_MS` knob. Which file gets the parse + default,
   which file consumes it? (Core: `config.ts`; shell: a `cli/*` that builds the
   provider.)
4. **Defend:** a reviewer wants the `pool.end()` moved into `loadConfig` "to keep
   cleanup near config." Refute it. (Core must stay effect-free; cleanup is a shell
   concern; `src/cli/ask-cmd.ts:38`.)

---

## See also

- `audit.md` — Lens 5 (the dead `schema` knob), Lens 3 (schema leak).
- `01-adapter-behind-a-contract.md` — the injected pool, the DI cousin of purity.
- `04-dependency-as-a-boundary.md` — the broader dependency-direction story.
- `study-testing` → `test/config.test.ts` is the payoff of this seam.
