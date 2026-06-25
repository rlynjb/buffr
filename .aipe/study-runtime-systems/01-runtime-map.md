# 01 · Runtime Map

**The process / task / resource map as-built** · *Project-specific orientation*

---

## Zoom out, then zoom in

Before any single mechanism, here's the whole machine. buffr-laptop is a
TypeScript ESM project that compiles to `dist/` and runs in **two process
shapes**. The batch CLIs (`index`, `eval`, `migrate`) are one-shot: born when
you type a command, own a Postgres pool for one run, die when the `await` chain
finishes. The primary path — `npm run chat` — is **long-lived**: it builds the
pool and one conversation once (`src/session.ts:34`), starts an Ink/React render
loop (`src/cli/chat.tsx:63`), and holds all of it in memory across many turns
until you type `/exit`.

```
  Zoom out — where the runtime sits

  ┌─ Tooling layer ──────────────────────────────────────────────┐
  │  tsc → dist/  ·  npm scripts  ·  node --test                  │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ launches
  ┌─ OS / process layer ──────────▼──────────────────────────────┐
  │  ★ LONG-LIVED: chat (Ink loop, holds state across turns) ★    │  ← we are here
  │  ★ ONE-SHOT:   index · eval · migrate (born → run → exit) ★    │
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

Three batch CLIs plus one long-lived chat session, one shared library layer, two
external systems. Read the skeleton before the mechanics.

**Layers (outer → inner):**

```
  Layer            What lives there                    File
  ───────────────  ──────────────────────────────────  ──────────────────────
  entry / CLI      arg parse, env load, wire-up, exit   src/cli/*.ts, migrate.ts
  session          createChatSession (held across turns) src/session.ts
  domain glue      indexDocumentRow, trace sink, profile src/runtime.ts, etc.
  adapter          PgVectorStore (VectorStore impl)     src/pg-vector-store.ts
  resource         createPool                           src/db.ts
  library          aptkit agent loop / pipeline / memory @rlynjb/aptkit-core
  external         Postgres, Ollama                     network
```

**Axis traced — "who owns the lifecycle?"** Hold that one question constant and
walk down:

```
  "who decides when this thing lives and dies?"

  ┌────────────────────────────────────────────┐
  │ entry / CLI    → the OS. Process start/exit │  ← lifecycle owner
  │   batch: dies at end of run                 │
  │   chat:  stays up until /exit (Ink loop)    │
  └────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ resource (pool) → the entry. Batch: made  │  ← owns the pool
      │   line 1, ended last line. Chat: made once│
      │   in createChatSession, ended in close()  │
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

The answer flips three times going down, and that's the lesson: the entry point
owns the pool, hands it *down* into the library and adapter as a borrowed handle,
and nobody below it is allowed to close it. What differs by process shape is
*how long* "owns" lasts: one run for the batch CLIs, the whole session for chat
(`session.close()` → `pool.end()`, `session.ts:72-73`).

**Seams — where an axis flips:**

- **entry ↔ pool** (`createPool` call): lifecycle ownership begins. The entry
  point is now responsible for `pool.end()` — at the end of the run for batch
  CLIs, inside `session.close()` (`session.ts:73`) for chat.
- **adapter ↔ pool** (`PgVectorStore` constructor takes `pool`): ownership does
  *not* transfer — the store borrows. It never calls `pool.end()`. That's a
  load-bearing contract; if the store closed the pool, the agent's later writes
  would fail.
- **process ↔ Postgres/Ollama** (TCP / HTTP): the trust and lifecycle boundary.
  The external systems outlive every process.

---

## How it works

### Move 1 — the mental model

You already know two shapes from frontend. A batch CLI is a page load: one trip
— mount, fetch, render, done. The chat session is a single-page app: mounted
once, it holds state and reacts to events until you navigate away. buffr has
both, and the difference is entirely *how long the pool lives*.

```
  Two process shapes — batch (one trip) vs chat (held loop)

  BATCH (index / eval / migrate):
   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │ load env │ ─►│ make pool│ ─►│ do work  │ ─►│ pool.end │ ─► exit
   │ + config │   │(resource)│   │ (await…) │   │ + exit   │
   └──────────┘   └──────────┘   └──────────┘   └──────────┘

  CHAT (createChatSession + Ink render loop):
   ┌──────────┐   ┌──────────┐   ┌─ render loop ────────────────┐
   │ load env │ ─►│ make pool│ ─►│ [ ask → answer → flush →      │
   │ + agent  │   │ + agent  │   │   remember ]ⁿ  until /exit    │─► close()
   └──────────┘   │ ONCE     │   └──────────────────────────────┘   → pool.end
                  └──────────┘     pool + conversation held warm
```

### Move 2 — the processes, one at a time

**`migrate` — schema setup (batch).** `src/migrate.ts:23` runs only as a CLI
(`import.meta.url === file://${process.argv[1]}` guard). It reads one SQL file,
runs it in a single transaction (`runMigration`), ends the pool, prints, exits.
The simplest process: no Ollama, no agent.

**`index` — corpus ingestion (batch).** `src/cli/index-cmd.ts`. Loads env, makes
a pool, builds an embedder (Ollama) + a `PgVectorStore` + a retrieval pipeline,
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

**`chat` — the long-lived agent session.** `src/cli/chat.tsx` + `src/session.ts`,
the richest path and the primary one. `createChatSession` (`session.ts:34`) does
the wire-up *once*: pool, embedder, store, pipeline, tool, model, profile,
episodic memory (`createConversationMemory`, `session.ts:53`), one conversation
row, the `SupabaseTraceSink`, and the `RagQueryAgent`. Then `chat.tsx:63` renders
the Ink UI and the process stays up. Each turn, `session.ask()` (`session.ts:60`)
persists the user message, awaits `agent.answer(question)`, `await trace.flush()`,
then best-effort `memory.remember(...)`. The pool and conversation are reused
every turn; nothing is rebuilt. `session.close()` → `pool.end()` runs only on
`/exit` (`chat.tsx:18-20`).

```
  chat — one turn inside the held session (state reused, not rebuilt)

  ┌─ Ink UI ───────┐ ask(q)  ┌─ session ──────┐ answer  ┌─ aptkit agent ┐
  │ TextInput      │ ──────► │ persist user    │ ──────► │ retrieve→tool │
  │ onSubmit       │ ◄────── │ → answer → flush│ ◄────── │ → generate    │
  └────────────────┘ render  │ → remember      │         └───────────────┘
                             └───────┬─────────┘
                              warm pool + same conversationId, every turn
```

**`eval` — precision/recall scoring (batch).** `src/cli/eval-cmd.ts`. Reads
`eval/queries.json`, loops queries, runs `pipeline.query` for each, scores with
aptkit's `scorePrecisionAtK`/`scoreRecallAtK`, prints a table, ends the pool.
No agent, no writes — read-only retrieval.

### Move 3 — the principle

The whole repo is **one resource, owned by the entry point, borrowed
downward.** That single rule — the entity that creates the pool is the only one
allowed to end it — is the spine the other seven files hang off. What the chat
path adds: that ownership can outlive a single request. The pool is now a
*genuinely long-lived* resource held across turns, ended once in
`session.close()`. Hold the map and "who owns the pool's lifecycle, and for how
long" and you can place any new file correctly on the first read.

---

## Primary diagram

The full map, every box and boundary labelled.

```
  buffr-laptop runtime map — every box, every owner

  Tooling:   tsc ──► dist/ ──► npm run chat/index/eval/migrate
                                       │ launches
  ┌─ Process (OS) ──────────────────── ▼ ───────────────────────────┐
  │  ONE node process · argv · env                                   │
  │   batch: exits when event loop empties                           │
  │   chat:  stays up (Ink loop on raw-mode stdin) until /exit       │
  └───────────────────────────────┬─────────────────────────────────┘
  ┌─ Node runtime (1 thread) ──────▼─────────────────────────────────┐
  │  event loop · microtask queue · call stack                       │
  │                                                                  │
  │  loadEnv → loadConfig → createPool ─────────┐ (owns lifecycle)   │
  │       │                                     │                    │
  │       ▼                                     ▼                    │
  │  build embedder/store/pipeline/agent  ──► borrows pool (no .end) │
  │       │                                                          │
  │       ▼  await … (pg + http)   [chat: repeated per turn]         │
  │  pool.end()  ← batch: last line · chat: session.close()/exit     │
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
Holding an interactive conversation, indexing a markdown file, scoring eval
queries, applying the schema — one long-lived session plus three batch
processes, one shared resource shape.

**The session wire-up, line by line** (`src/session.ts`, lines 34–57):

```
  src/session.ts  (lines 34–57)

  loadEnv();                                   ← dotenv: .env → process.env
  const cfg = loadConfig(process.env);         ← pure env→config (config.ts:9)
  if (!cfg.databaseUrl) throw new Error(...);   ← fail fast, before pool exists
  const pool = createPool(cfg.databaseUrl);     ← ★ lifecycle ownership BEGINS — held warm ★
  const embedder = ...; const store = ...;       ← built ONCE, reused every turn
  const memory = createConversationMemory({...});← episodic memory over the same store
  const conversationId = await startConversation(pool, ...);  ← one row, all turns
  const agent = new RagQueryAgent({ model, tools, profile, trace });
       │
       └─ this whole block runs ONCE. The returned ChatSession.ask() reuses pool,
          conversation, and agent across every turn. The pool is closed only in
          close() → pool.end() (line 73), reached on /exit. Any throw before
          render skips the loop entirely; a SIGINT mid-session skips close()
          (see 06, 07).
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

The batch "one process per command" shape is the classic Unix tool model —
`grep`, `sort`, `cat`: start, stream, exit. Node inherited it through
`process.argv` and the event loop's natural termination (exit when no work
remains). The batch CLIs lean on that natural termination as their shutdown
story. Chat is the deliberate exception: an Ink render loop keeps the event loop
alive on raw-mode stdin, so the process *won't* terminate naturally — it exits
only when `exit()` (`chat.tsx:20`) tears the loop down. That's a real
long-lived-process shape, not a daemon (no socket bind, no request mux) — see
`02` for the distinction and `07` for the shutdown cost.

The `import.meta.url === file://...` idiom is the ESM replacement for CommonJS's
`require.main === module`. It's how a file decides at runtime whether it's the
program or a dependency. Tooling-adjacent, but it's a genuine runtime check.

---

## Interview defense

**Q: Walk me through what happens, process-wise, when I run `npm run chat`.**

```
  npm run chat  →  tsc build  →  node chat.js
                                      │
        ┌─────────────────────────────┘
        ▼
   createChatSession: load env → config → createPool (held warm)
        → build embedder/store/pipeline/agent/memory ONCE → start conversation
        ▼
   render(<Chat/>) → Ink loop on raw-mode stdin → process STAYS UP
        ▼  per turn:
   persist user msg → agent.answer → trace.flush → memory.remember
        ▼  /exit:
   session.close() → pool.end() → exit()
```

One process, single-threaded, born at `node`, *alive across many turns*. The
pool and conversation are built once and reused; the Ink loop keeps the event
loop alive. *Anchor:* one session, many trips, one warm resource held until
`/exit`.

**Q: Who's allowed to close the pool?** Only the entity that created it —
`session.close()` for chat (`session.ts:73`), the last line for batch CLIs.
`PgVectorStore` and aptkit's agent receive the pool as a borrowed handle and
never call `.end()` — if they did, the agent's next-turn writes would hit a dead
pool. *Anchor:* create it where you'll end it; borrow it everywhere else.

---

## Validate

1. **Reconstruct:** draw both shapes — the batch four-beat (env → pool → work →
   end) and the chat held-loop (build once → [turn]ⁿ → close) — and place
   `index`/`eval`/`migrate` on the first, `chat` on the second.
2. **Explain:** why does `createPool` (`db.ts:4`) open no socket? When does the
   first connection actually dial Postgres in a chat session?
3. **Apply:** you add a `stats-cmd.ts` that counts chunks. Is it batch or held?
   Where does `createPool` go, where does `pool.end()` go, who owns the lifecycle?
4. **Defend:** in chat, the pool is built once in `createChatSession`
   (`session.ts:39`) and ended in `close()` (`:73`). Why is rebuilding it per
   turn (the old `ask` shape) wrong now, and what would a SIGINT skip?

---

## See also

- `02-processes-threads-and-tasks.md` — why every box here is one thread; the long-lived chat shape
- `04-shared-state-races-and-synchronization.md` — the pool as shared state held across turns
- `06-filesystem-streams-and-resource-lifecycle.md` — the pool's lifecycle close (`session.close()`)
- `00-overview.md` — ranked findings and the not-yet-exercised list

---

Updated: 2026-06-24 — reframed as two process shapes (batch CLIs + long-lived chat); purged ask-cmd/`npm run ask`; re-grounded wire-up on `session.ts`, lifecycle on `session.close()`.
