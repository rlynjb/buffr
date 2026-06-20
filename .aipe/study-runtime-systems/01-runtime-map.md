# 01 · Runtime Map

**The process / task / resource map as-built** · *Project-specific orientation*

---

## Zoom out, then zoom in

Before any single mechanism, here's the whole machine. buffr-laptop is a
TypeScript ESM project that compiles to `dist/` and runs as a handful of
one-shot Node processes. Each process is born when you type a command, owns a
Postgres connection pool for its life, talks to Postgres and Ollama over the
network, and dies when its `await` chain finishes.

```
  Zoom out — where the runtime sits

  ┌─ Tooling layer ──────────────────────────────────────────────┐
  │  tsc → dist/  ·  npm scripts  ·  node --test                  │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ launches
  ┌─ OS / process layer ──────────▼──────────────────────────────┐
  │  ★ ONE node process per CLI command ★    ← we are here        │
  │   ask-cmd · index-cmd · eval-cmd · migrate                    │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ runs on
  ┌─ Node runtime ────────────────▼──────────────────────────────┐
  │  single thread · one event loop · one pg.Pool resource        │
  └─────────┬───────────────────────────────────────┬─────────────┘
            │ TCP (pg protocol)                      │ HTTP
  ┌─────────▼─────────┐                    ┌─────────▼─────────────┐
  │ Postgres+pgvector │                    │ Ollama (gemma2,nomic) │
  │  Storage layer    │                    │  Provider layer       │
  └───────────────────┘                    └───────────────────────┘
```

Zoom in: the concept this file owns is the **map itself** — the inventory of
what executes, what it owns, and where the boundaries are. Every later file
zooms into one box on this map. Get the map right and the rest is detail
placement.

---

## Structure pass

Four CLI entry points, one shared library layer, two external systems. Read the
skeleton before the mechanics.

**Layers (outer → inner):**

```
  Layer            What lives there                    File
  ───────────────  ──────────────────────────────────  ──────────────────────
  entry / CLI      arg parse, env load, wire-up, exit   src/cli/*.ts, migrate.ts
  domain glue      indexDocumentRow, trace sink, profile src/runtime.ts, etc.
  adapter          PgVectorStore (VectorStore impl)     src/pg-vector-store.ts
  resource         createPool                           src/db.ts
  library          aptkit agent loop / pipeline         @rlynjb/aptkit-core
  external         Postgres, Ollama                     network
```

**Axis traced — "who owns the lifecycle?"** Hold that one question constant and
walk down:

```
  "who decides when this thing lives and dies?"

  ┌────────────────────────────────────────────┐
  │ entry / CLI    → the OS. Process start/exit │  ← lifecycle owner
  └────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ resource (pool) → the CLI. Created line 1,│  ← owns the pool
      │                   ended last line         │
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ library (agent) → borrows the pool,   │  ← borrows, never owns
          │                   never creates/closes│
          └──────────────────────────────────────┘
              ┌──────────────────────────────────┐
              │ external → its own lifecycle,     │  ← independent
              │            survives the process   │
              └──────────────────────────────────┘
```

The answer flips three times going down, and that's the lesson: the CLI owns
the pool, hands it *down* into the library and adapter as a borrowed handle,
and nobody below the CLI is allowed to close it.

**Seams — where an axis flips:**

- **CLI ↔ pool** (`createPool` call): lifecycle ownership begins. The CLI is
  now responsible for `pool.end()`.
- **adapter ↔ pool** (`PgVectorStore` constructor takes `pool`): ownership does
  *not* transfer — the store borrows. It never calls `pool.end()`. That's a
  load-bearing contract; if the store closed the pool, the agent's later writes
  would fail.
- **process ↔ Postgres/Ollama** (TCP / HTTP): the trust and lifecycle boundary.
  The external systems outlive every process.

---

## How it works

### Move 1 — the mental model

You already know the shape from frontend: a page load is one trip — mount,
fetch, render, done. A buffr CLI is the same shape at the process level. One
command = one trip. There's no server holding state between requests because
there are no requests; there's a process, and it runs once.

```
  The one-shot process — the repeating shape of every CLI

   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │ load env │ ─►│ make pool│ ─►│ do work  │ ─►│ pool.end │ ─► exit
   │ + config │   │(resource)│   │ (await…) │   │ + exit   │
   └──────────┘   └──────────┘   └──────────┘   └──────────┘
        │              │              │              │
     dotenv        src/db.ts      await chain    last line
     loadConfig    createPool     pg + ollama    pool.end()

   same four beats in ask / index / eval / migrate — only "do work" differs
```

### Move 2 — the four processes, one at a time

**`migrate` — schema setup.** `src/migrate.ts:23` runs only as a CLI
(`import.meta.url === file://${process.argv[1]}` guard). It reads one SQL file,
runs it in a single transaction (`runMigration`), ends the pool, prints, exits.
The simplest process: no Ollama, no agent.

**`index` — corpus ingestion.** `src/cli/index-cmd.ts`. Loads env, makes a
pool, builds an embedder (Ollama) + a `PgVectorStore` + a retrieval pipeline,
then loops over file paths reading each whole into memory and calling
`indexDocumentRow`. The work crosses two external systems per file: Ollama
(embed) and Postgres (write document row + chunks).

```
  index-cmd — one file's trip across the layers

  ┌─ CLI ─────────┐ readFile  ┌─ adapter ──────┐ embed   ┌─ Ollama ──┐
  │ for each path │ ────────► │ pipeline.index │ ──────► │ nomic-... │
  └───────┬───────┘           └───────┬────────┘ ◄────── └───────────┘
          │                           │ upsert (begin/commit)
          │ indexDocumentRow          ▼
          │ (documents row)    ┌─ Storage ──────┐
          └──────────────────► │ Postgres chunks│
                               └────────────────┘
```

**`ask` — the agent query.** `src/cli/ask-cmd.ts`, the richest process. After
the standard wire-up it loads the profile, opens a conversation row, persists
the user message, builds a `SupabaseTraceSink`, constructs aptkit's
`RagQueryAgent`, awaits `agent.answer(question)`, *then* `await trace.flush()`,
prints, ends the pool. The agent loop (retrieve → tool call → generate) runs
inside aptkit; buffr supplies the model provider, the tool, the store, and the
trace sink.

**`eval` — precision/recall scoring.** `src/cli/eval-cmd.ts`. Reads
`eval/queries.json`, loops queries, runs `pipeline.query` for each, scores with
aptkit's `scorePrecisionAtK`/`scoreRecallAtK`, prints a table, ends the pool.
No agent, no writes — read-only retrieval.

### Move 3 — the principle

The whole repo is **one resource, owned by the entry point, borrowed
downward.** That single rule — the process that creates the pool is the only
one allowed to end it — is the spine the other seven files hang off. Hold the
map and "who owns the pool's lifecycle" and you can place any new file
correctly on the first read.

---

## Primary diagram

The full map, every box and boundary labelled.

```
  buffr-laptop runtime map — every box, every owner

  Tooling:   tsc ──► dist/ ──► npm run ask/index/eval/migrate
                                       │ launches
  ┌─ Process (OS) ──────────────────── ▼ ───────────────────────────┐
  │  ONE node process · argv · env · exits when event loop empties   │
  └───────────────────────────────┬─────────────────────────────────┘
  ┌─ Node runtime (1 thread) ──────▼─────────────────────────────────┐
  │  event loop · microtask queue · call stack                       │
  │                                                                  │
  │  loadEnv → loadConfig → createPool ─────────┐ (owns lifecycle)   │
  │       │                                     │                    │
  │       ▼                                     ▼                    │
  │  build embedder/store/pipeline/agent  ──► borrows pool (no .end) │
  │       │                                                          │
  │       ▼  await … (pg + http)                                     │
  │  pool.end()  ← last line, error path skips it                    │
  └───────┬───────────────────────────────────────────┬─────────────┘
          │ TCP pg protocol                            │ HTTP
  ┌───────▼────────────┐                     ┌─────────▼────────────┐
  │ Postgres+pgvector  │                     │ Ollama gemma2/nomic  │
  │ reindb · agents    │                     │ generation + embed   │
  │ Storage layer      │                     │ Provider layer       │
  └────────────────────┘                     └──────────────────────┘
```

---

## Implementation in codebase

**Use cases.** This map is reached for every time you ask "where does X run?"
Indexing a markdown file, asking the agent a question, scoring eval queries,
applying the schema — four distinct processes, one shared shape.

**The shared wire-up, line by line** (`src/cli/ask-cmd.ts`, lines 13–19):

```
  src/cli/ask-cmd.ts  (lines 13–19)

  loadEnv();                                   ← dotenv: .env → process.env
  const cfg = loadConfig(process.env);         ← pure env→config (config.ts:9)
  if (!cfg.databaseUrl) throw new Error(...);   ← fail fast, before pool exists
  const question = process.argv.slice(2)...     ← read argv (process-level input)
  if (!question) throw new Error(...);           ← second fail-fast guard
  const pool = createPool(cfg.databaseUrl);     ← ★ lifecycle ownership BEGINS ★
       │
       └─ from here the process MUST reach pool.end() (line 38) to drain
          cleanly. Any throw between here and line 38 skips it (see 06, 07).
```

**The resource factory** (`src/db.ts`, lines 4–6):

```
  src/db.ts  (lines 4–6)

  export function createPool(databaseUrl: string): pg.Pool {
    return new pg.Pool({ connectionString: databaseUrl });  ← lazy: no socket yet
  }
       │
       └─ a Pool opens NO connection here. The first await pool.query / connect
          dials Postgres. The pool is the single shared runtime resource the
          whole map borrows (see 04 for shared-state, 06 for its lifecycle).
```

**The migrate guard** (`src/migrate.ts`, line 23):

```
  src/migrate.ts  (line 23)

  if (import.meta.url === `file://${process.argv[1]}`) {  ← "am I the entry?"
       │
       └─ migrate.ts is BOTH a library (runMigration is imported by tests)
          and a CLI. This guard runs the CLI block only when the file is the
          process entry point, never when imported. ESM's import.meta.url is
          the runtime's answer to "who launched me?"
```

---

## Elaborate

The "one process per command" shape is the classic Unix tool model — `grep`,
`sort`, `cat`: start, stream, exit. Node inherited it through `process.argv`
and the event loop's natural termination (exit when no work remains). buffr
leans on that natural termination as its shutdown story, which works precisely
because nothing here is long-lived — see `02` for why no daemon exists and `07`
for what that costs.

The `import.meta.url === file://...` idiom is the ESM replacement for CommonJS's
`require.main === module`. It's how a file decides at runtime whether it's the
program or a dependency. Tooling-adjacent, but it's a genuine runtime check.

---

## Interview defense

**Q: Walk me through what happens, process-wise, when I run `npm run ask`.**

```
  npm run ask -- "q"  →  tsc build  →  node ask-cmd.js "q"
                                            │
        ┌───────────────────────────────────┘
        ▼
   load env → config → createPool → load profile → start conversation
        → persist user msg → build agent → await agent.answer
        → await trace.flush → print → pool.end → process exits
```

One process, single-threaded, born at `node`, dead at exit. The pool is created
near the top and ended at the very bottom; the agent borrows it. *Anchor:* one
command, one trip, one owned resource.

**Q: Who's allowed to close the pool?** Only the CLI that created it
(`ask-cmd.ts:38`). `PgVectorStore` and aptkit's agent receive the pool as a
borrowed handle and never call `.end()` — if they did, the agent's mid-run
writes would hit a dead pool. *Anchor:* create it where you'll end it; borrow it
everywhere else.

---

## Validate

1. **Reconstruct:** draw the four-beat shape (env → pool → work → end) from
   memory and place all four CLIs on it.
2. **Explain:** why does `createPool` (`db.ts:4`) open no socket? When does the
   first connection actually dial Postgres?
3. **Apply:** you add a `stats-cmd.ts` that counts chunks. Where does
   `createPool` go, where does `pool.end()` go, and who owns the lifecycle?
4. **Defend:** the `import.meta.url` guard in `migrate.ts:23` — why is it there,
   and what breaks at runtime if you delete it and a test imports the file?

---

## See also

- `02-processes-threads-and-tasks.md` — why every box here is one thread
- `04-shared-state-races-and-synchronization.md` — the pool as shared state
- `06-filesystem-streams-and-resource-lifecycle.md` — the pool's lifecycle close
- `00-overview.md` — ranked findings and the not-yet-exercised list
