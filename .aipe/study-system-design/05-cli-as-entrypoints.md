# CLI as Entrypoints

**Industry names:** script-per-command · run-on-import module · short-lived
process · ETL-style CLI · Project-specific (buffr's interface is three scripts)

## Zoom out, then zoom in

buffr has no server. Its entire interface is three Node scripts —
`index`, `ask`, `eval` — each a module that does its work *on import*, then
calls `pool.end()` and exits. There's no router, no request loop, no daemon.
The process *is* the request. That choice is the direct consequence of "one
device, one user": a server in front of a single local client would be
indirection with no caller.

```
  Zoom out — the entrypoints are the top of the system

  ┌─ CLI layer (buffr — the whole interface) ────────────────────┐
  │  npm run index ─► index-cmd.ts   load corpus                  │
  │  npm run ask   ─► ask-cmd.ts      answer a question  ★here★   │
  │  npm run eval  ─► eval-cmd.ts     score retrieval             │
  └────────┬──────────────────────────────────────────────────────┘
           │ each builds the SAME wiring, then exits
  ┌─ Toolkit + Adapter + Storage + Provider ──▼──────────────────┐
  │  pipeline · agent · PgVectorStore · pg · Ollama               │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **a short-lived process per command**, each one a
self-contained wiring of the same parts. Strip it out and there's no way to
*drive* the system — the agent, store, and pipeline are libraries with no
caller. The CLIs are where configuration, wiring, and lifecycle actually
happen.

## Structure pass

**Layers** — the npm script → the run-on-import module → the wired
dependencies → `pool.end()`.

**Axis: lifecycle — when does each thing happen?** Trace one invocation.

```
  One question: "when does this happen in the process lifetime?"

  ┌──────────────────────────────────────────────┐
  │ module import: loadEnv() runs immediately      │ → at IMPORT (top-level)
  └───────────────────────┬──────────────────────┘
      ┌───────────────────▼──────────────────────┐
      │ build: pool → embedder → store → pipeline │ → at IMPORT (top-level await)
      └───────────────────┬──────────────────────┘
          ┌───────────────▼──────────────────────┐
          │ work: index / answer / score          │ → ONE shot, then
          │ teardown: await pool.end()            │   process exits
          └───────────────────────────────────────┘

  there is no idle/request phase — import and run are the same moment
```

**Seam.** The npm-script-to-module boundary is the *entrypoint seam*: above
it, `package.json` scripts (`npm run ask -- "..."`); below it, a module that
runs on load. The thing that flips across it: outside, you're in shell-and-
args land; inside, you're in a single async top-level scope that owns the
process lifecycle. The load-bearing concern at this seam is **teardown** —
forget `pool.end()` and the process hangs on an open pool.

## How it works

### Move 1 — the mental model

You know how a serverless function is just a handler that runs once per
request and returns — no long-lived state between calls? A buffr CLI is that,
but the "request" is the *process invocation itself*. Run it, it wires up,
does one job, tears down, exits.

```
  run-on-import — the process IS the request

  npm run ask -- "question"
        │
        ▼  node loads ask-cmd.js (top-level code runs)
   loadEnv → build wiring → agent.answer → flush → pool.end → exit
        │
        └─ no server, no loop, no next request — one shot
```

### Move 2 — the step-by-step walkthrough

#### Step 1 — config first, fail fast

Every CLI's first acts: `loadEnv()` (dotenv), `loadConfig(process.env)`, then
a hard throw if `DATABASE_URL` is missing. No partial run with a half-config.

```
  pseudocode — the shared preamble (all three CLIs)

  loadEnv()                                    // read .env into process.env
  cfg = loadConfig(process.env)                // pure: env → Config
  if not cfg.databaseUrl: throw                // fail fast, loud
```

What breaks without the throw: the pool is built with `undefined`, and the
failure surfaces later as a cryptic pg error instead of "DATABASE_URL is not
set (see .env)".

#### Step 2 — build the wiring (the part that repeats)

All three CLIs build the same spine: `createPool` → `OllamaEmbeddingProvider`
→ `PgVectorStore` → `createRetrievalPipeline`. `ask` adds the model, tools,
profile, and trace on top.

```
  the shared spine — built three times

  pool     = createPool(cfg.databaseUrl)
  embedder = OllamaEmbeddingProvider({ model, host })
  store    = PgVectorStore({ pool, appId, dimension: embedder.dimension })
  pipeline = createRetrievalPipeline({ embedder, store })
       │
       └─ identical in index-cmd, ask-cmd, eval-cmd. The honest red flag: this
          is duplicated, not factored into a buildPipeline() helper.
```

What this costs: three copies drift independently — change the embedder model
name and you change it in three files. What it buys: each CLI is a single
readable file with no shared-factory indirection. At three small scripts, the
duplication is cheap; past that, extract it.

#### Step 3 — do the one job

Each CLI's body is the only part that differs: `index` loops files and calls
`indexDocumentRow`; `ask` builds the agent and prints the answer; `eval` loops
labeled queries and prints scores.

```
  layers-and-hops — the three jobs, same spine

  ┌─ index ──────────┐  for each file → indexDocumentRow → INSERT + index
  ┌─ ask ────────────┐  startConversation → agent.answer → flush → print
  ┌─ eval ───────────┐  for each query → pipeline.query → score → print
         │
         └─ all three end the same way ▼
  ┌─ teardown ───────┐  await pool.end()   (release every connection)
```

#### Step 4 — teardown, every path

The last line of every CLI is `await pool.end()`. The pool holds open TCP
connections to Postgres; without closing them the process never exits cleanly.

```
  teardown — the line that lets the process die

  ... work ...
  await pool.end()           // close all pooled connections → clean exit
       │
       └─ in ask-cmd, this comes AFTER trace.flush() — flush the trajectory
          writes first, THEN close the pool they were writing through.
```

What breaks if `pool.end()` runs before `flush()` in `ask`: you'd close the
pool out from under in-flight message inserts. The ordering
(`flush()` then `pool.end()`) is load-bearing — see `03-trajectory-capture.md`.

### Move 3 — the principle

When you have exactly one local caller, the simplest correct interface is a
process per command — no server to run, secure, or keep alive. The cost is no
shared warm state between invocations (every run re-embeds, re-pools); the
benefit is radical simplicity and a teardown you can see. Add the server only
when a second, remote caller actually exists.

## Primary diagram

The full entrypoint lifecycle for `ask`, with the shared spine and ordered
teardown.

```
  ask-cmd.ts — one process, start to exit

  npm run ask -- "question"
        │
  ┌─ preamble ──────────────────────────────────────────────┐
  │ loadEnv → loadConfig → throw if no DATABASE_URL          │
  └───────────────────────┬─────────────────────────────────┘
  ┌─ wiring (shared spine) ▼────────────────────────────────┐
  │ pool → embedder → store → pipeline → tool → registry     │
  │ model(guarded Gemma) → profile(loadProfile)              │
  └───────────────────────┬─────────────────────────────────┘
  ┌─ work ─────────────────▼────────────────────────────────┐
  │ startConversation → persist user → agent.answer          │
  └───────────────────────┬─────────────────────────────────┘
  ┌─ teardown (ordered) ───▼────────────────────────────────┐
  │ await trace.flush()  →  print answer  →  await pool.end()│
  └──────────────────────────────────────────────────────────┘
                          │
                          ▼  process exits
```

## Implementation in codebase

**Use cases.** These three scripts are the only way a human drives buffr.
`npm run index -- file.md` loads corpus; `npm run ask -- "q"` asks; `npm run
eval` scores. Each maps to a `package.json` script that builds then runs the
compiled `dist/` module.

**The package.json scripts** — `package.json`

```
  "index": "npm run build && node dist/src/cli/index-cmd.js",
  "ask":   "npm run build && node dist/src/cli/ask-cmd.js",
  "eval":  "npm run build && node dist/src/cli/eval-cmd.js",
        │
        └─ each script compiles TS → JS then runs the entrypoint module.
           No server target — the scripts ARE the interface.
```

**Run-on-import + fail-fast** — `src/cli/ask-cmd.ts:13-17`

```
  loadEnv();                                                    ← 13: runs at import
  const cfg = loadConfig(process.env);                          ← 14
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)'); ← 15
  const question = process.argv.slice(2).join(' ');             ← 16: args
  if (!question) throw new Error('usage: npm run ask -- "your question"');     ← 17
        │
        └─ top-level code, no main() wrapper. Import = execute. Both throws
           fail before any DB connection is attempted.
```

**The shared spine** — `src/cli/ask-cmd.ts:19-22` (identical to
`index-cmd.ts:17-20`, `eval-cmd.ts:13-16`)

```
  const pool     = createPool(cfg.databaseUrl);                              ← 19
  const embedder = new OllamaEmbeddingProvider({ model:'...', host: cfg.ollamaHost }); ← 20
  const store    = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension }); ← 21
  const pipeline = createRetrievalPipeline({ embedder, store });             ← 22
        │
        └─ this four-line spine appears verbatim in all three CLIs — the
           duplication audit.md §8 #5 flags. A buildPipeline(cfg) helper would
           dry it; at three files it's a readability-vs-DRY toss-up.
```

**Ordered teardown** — `src/cli/ask-cmd.ts:35-38`

```
  await trace.flush();                                          ← 35: writes land
  process.stdout.write(`\n${answer}\n`);                        ← 37: print
  await pool.end();                                             ← 38: close pool
        │
        └─ flush BEFORE pool.end — the trace writes go through this pool, so
           closing it first would drop them. Teardown order is load-bearing.
```

**The migrate entrypoint guards on `import.meta.url`** —
`src/migrate.ts:23`

```
  if (import.meta.url === `file://${process.argv[1]}`) {   ← run only when invoked directly
        │
        └─ migrate.ts exports runMigration() AND is a CLI. This guard lets the
           tests import runMigration without triggering the CLI side effects.
```

## Elaborate

Run-on-import scripts are the Node ESM idiom for short-lived tooling — the
same shape as a database seed script or a one-off ETL job. The serverless
analogy is exact: AWS Lambda handlers are short-lived, wire-up-per-invocation,
no warm state guaranteed — buffr's CLIs are that pattern run locally, with the
process boundary as the invocation boundary. The reader's AdvntrCue used
Netlify Functions (serverless) for the same "no long-lived server" reason in a
*cloud* context; buffr reaches the same conclusion for a *local single-user*
context. The `import.meta.url` guard in `migrate.ts` is the ESM equivalent of
Python's `if __name__ == '__main__'` — the same module is both a library
export and a runnable script, and the guard keeps the test suite from running
migrations on import.

## Interview defense

**Q: Why three CLI scripts instead of one server with three routes?**

One local caller. A server in front of a single local client is indirection
with no one on the other side — you'd pay for a router, a request loop, and a
process to keep alive, to serve yourself. The process-per-command is the
simplest correct interface; the design defers the HTTP API explicitly to the
phone/multi-app phase (`laptop-supabase-graduation-design.md`).

```
  one caller  → process per command (now)
  many callers → server + routes (deferred, named)
```

Anchor: `package.json` scripts; design doc "direct pg now, Edge Functions
later."

**Q: What's the one ordering bug to watch for in these scripts?**

`pool.end()` racing in-flight writes. In `ask`, the trace sink writes through
the pool, so `flush()` must come *before* `pool.end()` (`ask-cmd.ts:35` then
`:38`). Close the pool first and you drop the trajectory inserts the answer
already triggered.

```
  flush() ──► pool.end()   ✓ writes land, then close
  pool.end() ──► (flush)   ✗ pool closed under in-flight inserts
```

Anchor: `src/cli/ask-cmd.ts:35-38`.

## Validate

1. **Reconstruct.** From memory, list the four phases of an `ask` invocation
   (preamble, wiring, work, teardown) and one line that lives in each.
2. **Explain.** Why does `ask-cmd.ts` call `trace.flush()` before
   `pool.end()`? (`ask-cmd.ts:35-38`.)
3. **Apply.** You add a fourth command, `reindex`. What's the minimum it must
   include to fail fast and exit clean? (preamble throw + `pool.end()`.)
4. **Defend.** Argue whether the duplicated four-line spine
   (`ask-cmd.ts:19-22` et al.) should be extracted into a helper, or left
   inline. Name the cost of each.

## See also

- `02-retrieval-pipeline.md` — the spine these CLIs build.
- `03-trajectory-capture.md` — why `flush()` precedes `pool.end()` in `ask`.
- `04-library-as-dependency-boundary.md` — what the CLIs import and compose.
- `07-deferred-body.md` — the HTTP server these scripts defer.
- `study-runtime-systems` — process lifecycle, top-level await, pool teardown.
