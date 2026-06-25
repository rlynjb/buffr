# CLI as Entrypoints

**Industry names:** script-per-command · run-on-import module · short-lived
process · ETL-style CLI · long-lived REPL/session · Project-specific (buffr's
interface is one-shot scripts + one held session)

## Zoom out, then zoom in

buffr has no server. Its entire interface is a handful of Node entrypoints in
**two shapes**. Three are *one-shot* — `index`, `eval`, `migrate` — modules
that do their work on import, call `pool.end()`, and exit; the process *is*
the request. The fourth, `chat`, is different: it's a *long-lived* Ink TUI
that wires up ONCE and then holds one warm pool and one conversation across
every turn until you type `/exit`. (The old one-shot `ask` is deleted — `chat`
is now the only interactive surface.) No router, no daemon, no HTTP — just
"one device, one user," where a server in front of a single local client would
be indirection with no caller.

```
  Zoom out — the entrypoints are the top of the system

  ┌─ CLI layer (buffr — the whole interface) ────────────────────┐
  │  ONE-SHOT (wire → run → pool.end → exit):                     │
  │    npm run index   ─► index-cmd.ts   load corpus              │
  │    npm run eval    ─► eval-cmd.ts    score retrieval          │
  │    npm run migrate ─► migrate.ts     apply schema             │
  │  LONG-LIVED (wire ONCE → many turns → /exit):                 │
  │    npm run chat    ─► chat.tsx ─► createChatSession ★here★    │
  └────────┬──────────────────────────────────────────────────────┘
           │ all build the SAME spine; one-shots exit, chat persists
  ┌─ Toolkit + Adapter + Storage + Provider ──▼──────────────────┐
  │  pipeline · agent · memory · PgVectorStore · pg · Ollama      │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: there are two patterns here, not one. One-shots are **a short-lived
process per command** — wire, run, tear down. `chat` is a **long-lived session
behind a TUI** — the wiring (and the conversation it owns) outlives any single
turn. Strip either out and there's no way to *drive* the system: the agent,
store, pipeline, and memory are libraries with no caller. The entrypoints are
where configuration, wiring, and lifecycle actually happen.

## Structure pass

**Layers** — the npm script → the run-on-import module → the wired
dependencies → `pool.end()`.

**Axis: lifecycle — when does each thing happen?** This is the axis that
flips between the two shapes, so hold it constant and watch it change.

```
  One question: "when does this happen, and how long does the wiring live?"

  ONE-SHOT (index / eval / migrate)     LONG-LIVED (chat)
  ───────────────────────────────       ─────────────────────────────
  import: loadEnv (top-level)           render(<Chat>) mounts the TUI
  build: pool→embedder→store→pipeline   createChatSession() builds ONCE
  work: index / score (one shot)        loop: per keystroke-submit → ask()
  teardown: pool.end() → exit           held open until /exit → close()

  import and run are the same moment     the wiring OUTLIVES every turn
```

**Seam.** The entrypoint seam splits in two. For one-shots it's the
*npm-script-to-module* boundary (`npm run index -- file.md` above, a module
that runs on load below) — outside is shell-and-args, inside is a single async
top-level scope that owns the whole process lifecycle. For `chat` there's a
*second* seam below that: the *render-to-session* boundary, where the Ink
component (`chat.tsx`) holds a `ChatSession` handle and calls `session.ask()`
per turn — control flips from "the process is the request" to "each turn is a
request, the process stays alive." The load-bearing concern flips too: for
one-shots it's **teardown** (forget `pool.end()` and the process hangs); for
`chat` it's **lifetime ownership** — the pool and conversation must live across
turns and close exactly once, on `/exit`.

## How it works

### Move 1 — the mental model

You know two flavors of backend already. A serverless function is a handler
that runs once per request and returns — no warm state between calls. A
long-running server (or a REPL) wires up once and then services many requests
on the same warm process. buffr has both: the one-shot CLIs are the serverless
flavor (the *process* is the request), and `chat` is the warm-process flavor
(wire once, then `ask()` over and over).

```
  two shapes — process-as-request vs session-as-warm-process

  ONE-SHOT (index/eval/migrate):
    node loads index-cmd.js (top-level code runs)
    loadEnv → build wiring → do job → pool.end → exit
        └─ no loop, no next request — one shot

  LONG-LIVED (chat):
    render(<Chat session=createChatSession()/>)   ← wire ONCE
      loop:  submit → session.ask(q) → render answer   ← many turns
    /exit → session.close() → pool.end
        └─ ONE pool, ONE conversation, held across every turn
```

### Move 2 — the step-by-step walkthrough

#### Step 1 — config first, fail fast

Every entrypoint's first acts: `loadEnv()` (dotenv), `loadConfig(process.env)`,
then a hard throw if `DATABASE_URL` is missing. For one-shots this runs at
module top-level; for `chat` it runs inside `createChatSession()` before the
pool is built (`session.ts:35-37`). No partial run with a half-config.

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

All three build the same spine: `createPool` → `OllamaEmbeddingProvider` →
`PgVectorStore` → `createRetrievalPipeline`. `createChatSession` adds the most
on top: the tool registry, the guarded model, the profile, the conversation +
trace, AND the episodic memory (`createConversationMemory({ embedder, store })`).

```
  the shared spine — built three times

  pool     = createPool(cfg.databaseUrl)
  embedder = OllamaEmbeddingProvider({ model, host })
  store    = PgVectorStore({ pool, appId, dimension: embedder.dimension })
  pipeline = createRetrievalPipeline({ embedder, store })
       │
       └─ identical in index-cmd, eval-cmd, session.ts. The honest red flag:
          this is duplicated, not factored into a buildPipeline() helper.
```

The key lifecycle difference: in a one-shot this spine is built and discarded
per process; in `chat` it's built ONCE inside `createChatSession` and reused
for every turn — the warm-pool win. What the duplication costs: three copies
drift independently — change the embedder model name and you change it in
three files. What it buys: each entrypoint is a single readable file with no
shared-factory indirection. At three call sites, cheap; past that, extract it.

#### Step 3 — do the one job (or many)

The body is where the two shapes diverge most. A one-shot does its single job
once: `index` loops files and calls `indexDocumentRow`; `eval` loops labeled
queries and prints scores. `chat` instead exposes an `ask(question)` that runs
*per turn*, inside a TUI loop that lives until `/exit`.

```
  layers-and-hops — one-shot jobs vs the chat turn-loop

  ┌─ index ──────────┐  for each file → indexDocumentRow → INSERT + index → exit
  ┌─ eval ───────────┐  for each query → pipeline.query → score → exit
  ┌─ chat (per turn) ┐  persist user → agent.answer → flush
  │                  │       → memory.remember (best-effort) → render answer
  │                  └─ loop: the pool stays open for the NEXT turn ──┐
         │                                                            │
         └─ one-shots end with pool.end(); chat loops back up ◄───────┘
```

#### Step 4 — teardown, two lifetimes

A one-shot's last line is `await pool.end()` — the pool holds open TCP
connections to Postgres, and without closing them the process never exits
cleanly. `chat` defers that: `pool.end()` lives in `session.close()`, called
exactly once when the user types `/exit` (`chat.tsx:18-22`, `session.ts:72-74`).

```
  teardown — when the pool actually closes

  ONE-SHOT:  ... work ... → await pool.end() → process exits
  CHAT:      turn → flush → (loop, pool STAYS open) ... → /exit
                   → session.close() → await pool.end() → exit
       │
       └─ inside a chat turn, flush() still precedes any close — the trace
          writes go through this pool, so closing it under in-flight inserts
          would drop them.
```

What breaks if `pool.end()` runs before `flush()` (or mid-turn in `chat`):
you'd close the pool out from under in-flight message inserts. The ordering
(`flush()` then, much later, `close()`) is load-bearing — see
`03-trajectory-capture.md`. And in `chat`, calling `close()` more than once
(or never) is the new failure mode the one-shots never had.

### Move 3 — the principle

When you have exactly one local caller, the simplest correct interface is a
process per command — no server to run, secure, or keep alive. But the moment
the interaction is *conversational* (turn after turn, where re-embedding and
re-pooling every turn would be waste), you reach for the warm-process shape
instead: wire once, hold the state, service many turns. buffr does both, and
the choice is driven by the interaction, not by adding a server: one-shot
ingestion/scoring stays a process-per-command; the chat keeps a long-lived
session. Add the *network* server only when a second, remote caller exists.

## Primary diagram

The full lifecycle of `chat` — wire once, loop over turns, close on `/exit` —
contrasted with the one-shot shape.

```
  chat — wire ONCE, many turns, ordered teardown

  npm run chat
        │
  ┌─ mount (chat.tsx) ───────────────────────────────────────┐
  │ render(<Chat session = await createChatSession() />)      │
  └───────────────────────┬──────────────────────────────────┘
  ┌─ wire ONCE (session.ts) ▼─────────────────────────────────┐
  │ loadEnv → loadConfig → throw if no DATABASE_URL           │
  │ pool → embedder → store → pipeline → tool → registry      │
  │ model(guarded Gemma) → profile → conversation+trace       │
  │ memory = createConversationMemory({ embedder, store })    │
  └───────────────────────┬──────────────────────────────────┘
  ┌─ turn loop (session.ask, per submit) ▼────────────────────┐
  │ persist user → agent.answer → trace.flush()               │
  │ → memory.remember (best-effort) → render answer           │
  │ ◄── pool STAYS open, loop back for next turn ──┐          │
  └────────────────────────────────────────────────┼─────────┘
  ┌─ teardown ON /exit ─────────────────────────────▼─────────┐
  │ session.close() → await pool.end() → exit                 │
  └───────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** These entrypoints are the only way a human drives buffr.
`npm run index -- file.md` loads corpus (one-shot); `npm run eval` scores
(one-shot); `npm run migrate` applies schema (one-shot); `npm run chat` opens
the interactive session (long-lived). Each maps to a `package.json` script
that builds then runs the compiled `dist/` module.

**The package.json scripts** — `package.json`

```
  "index":   "npm run build && node dist/src/cli/index-cmd.js",
  "eval":    "npm run build && node dist/src/cli/eval-cmd.js",
  "migrate": "npm run build && node dist/src/migrate.js",
  "chat":    "npm run build && node dist/src/cli/chat.js",
        │
        └─ each script compiles TS → JS then runs the entrypoint module.
           No server target — the scripts ARE the interface. (No `ask` — the
           one-shot ask CLI was removed; `chat` replaces it.)
```

**Long-lived mount + fail-fast** — `src/cli/chat.tsx:62-63` calling into
`src/session.ts:34-37`

```
  // chat.tsx (the entrypoint module):
  const session = await createChatSession();      ← 62: build the session ONCE
  render(<Chat session={session} />);             ← 63: hand it to the Ink TUI

  // session.ts (the wiring, fail-fast inside):
  loadEnv();                                        ← 35
  const cfg = loadConfig(process.env);              ← 36
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)'); ← 37
        │
        └─ unlike the one-shots, the wiring lives in a factory (createChatSession),
           not at module top-level — because it must be HELD, not discarded.
           The throw still fires before any DB connection.
```

**The shared spine** — `src/session.ts:39-42` (identical to
`index-cmd.ts:17-20`, `eval-cmd.ts:13-16`)

```
  const pool     = createPool(cfg.databaseUrl);                              ← 39
  const embedder = new OllamaEmbeddingProvider({ model:'...', host: cfg.ollamaHost }); ← 40
  const store    = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension }); ← 41
  const pipeline = createRetrievalPipeline({ embedder, store });             ← 42
        │
        └─ this four-line spine appears verbatim in all three entrypoints — the
           duplication audit.md §8 #5 flags. A buildPipeline(cfg) helper would
           dry it; at three sites it's a readability-vs-DRY toss-up. In session.ts
           the SAME store is then reused twice: by the search tool AND injected
           into createConversationMemory (session.ts:53).
```

**Per-turn work + deferred teardown** — `src/session.ts:60-74`

```
  async ask(question) {                                         ← 60
    await persistMessage(pool, conversationId, 'user', question);← 61: user turn
    const answer = await agent.answer(question);                ← 62
    await trace.flush();                                        ← 63: writes land
    try { await memory.remember({ conversationId, question, answer }); } ← 65-66
    catch { /* best-effort */ }                                 ← 67-69
    return answer;                                              ← 70
  },
  async close() { await pool.end(); },                          ← 72-74: ONE-time teardown
        │
        └─ flush BEFORE return — trace writes go through this pool. pool.end()
           is NOT here; it lives in close(), fired once on /exit. Teardown order
           (flush per turn, close once) is load-bearing.
```

**The TUI owns the session lifetime** — `src/cli/chat.tsx:18-22, 28`

```
  if (q === '/exit' || q === '/quit') {        ← 18
    await session.close();                     ← 19: close the pool exactly once
    exit();                                    ← 20: unmount Ink
  }
  ...
  const answer = await session.ask(q);         ← 28: one turn, pool stays warm
        │
        └─ the component holds the ChatSession handle across renders; close()
           is reached only on the /exit branch, so the pool lives for every turn.
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
no warm state guaranteed — buffr's one-shot CLIs (`index`, `eval`, `migrate`)
are that pattern run locally, with the process boundary as the invocation
boundary. The reader's AdvntrCue used Netlify Functions (serverless) for the
same "no long-lived server" reason in a *cloud* context; buffr reaches the
same conclusion for one-shot work in a *local single-user* context. `chat` is
the deliberate exception: a conversational interface wants warm state (one
pool, one conversation, one in-process agent), so it takes the long-lived
REPL/session shape instead — the same instinct as a `node` REPL or an
interactive `psql`. The `createChatSession` factory is the seam that makes
that lifetime explicit: build returns a handle (`ask`/`close`), and the Ink
component owns when `close` fires. The `import.meta.url` guard in `migrate.ts`
is the ESM equivalent of Python's `if __name__ == '__main__'` — the same
module is both a library export and a runnable script, and the guard keeps the
test suite from running migrations on import.

## Interview defense

**Q: Why CLIs instead of one server with routes — and why is `chat` long-lived
when the others are one-shot?**

One local caller. A server in front of a single local client is indirection
with no one on the other side — you'd pay for a router, a request loop, and a
process to keep alive, to serve yourself. So ingestion and scoring are
process-per-command. `chat` is long-lived for a different reason: it's
*conversational*. Re-pooling and re-wiring the agent on every turn would be
waste, and a held session lets one conversation span every turn (and lets
episodic memory accumulate). That's a warm-process choice, not a server
choice — no network is added. The HTTP API stays deferred to the
phone/multi-app phase (`laptop-supabase-graduation-design.md`).

```
  one-shot work (index/eval)  → process per command
  conversational work (chat)  → long-lived in-process session
  remote callers (deferred)   → server + routes (named, not built)
```

Anchor: `package.json` scripts; `src/session.ts:34`; design doc "direct pg
now, Edge Functions later."

**Q: What's the one ordering bug to watch for here?**

`pool.end()` racing in-flight writes. The trace sink writes through the pool,
so `flush()` must precede any close. In `chat` that's two facts: `flush()`
before `return` each turn (`session.ts:63`), and `pool.end()` deferred entirely
to `close()` on `/exit` (`session.ts:72-74`) — never mid-turn. Close the pool
under in-flight inserts and you drop the trajectory the answer already
triggered.

```
  flush() (per turn) ──► return ... ──► close() (on /exit)   ✓ writes land
  pool.end() mid-turn ──► (flush)                            ✗ inserts dropped
```

Anchor: `src/session.ts:60-74`; `src/cli/chat.tsx:18-22`.

## Validate

1. **Reconstruct.** From memory, list the lifecycle phases of a `chat`
   invocation (mount, wire-once, turn-loop, teardown-on-/exit) and one line
   that lives in each (`session.ts`, `chat.tsx`).
2. **Explain.** Why does `session.ask()` call `trace.flush()` before returning,
   but `pool.end()` lives in `close()` instead? (`session.ts:63` vs `:72-74`.)
3. **Apply.** You add a one-shot `reindex` command. What's the minimum it must
   include to fail fast and exit clean? (preamble throw + `pool.end()`.) How
   does that differ from what `chat` needs (a `close()` the TUI calls once)?
4. **Defend.** Argue whether the duplicated four-line spine
   (`session.ts:39-42` et al.) should be extracted into a helper, or left
   inline. Name the cost of each.

## See also

- `02-retrieval-pipeline.md` — the spine these entrypoints build.
- `03-trajectory-capture.md` — why `flush()` precedes the pool close per turn.
- `04-library-as-dependency-boundary.md` — what the entrypoints import and
  compose, including the memory engine injected with `PgVectorStore`.
- `07-deferred-body.md` — the HTTP server these scripts defer.
- `study-runtime-systems` — process lifecycle, top-level await, the warm-pool
  session, pool teardown.

---

Updated: 2026-06-24 — reframed from "three one-shot scripts" to "one-shot
commands (index/eval/migrate) + the long-lived `chat` Ink session"; `ask` CLI
removed; new lifecycle axis (process-as-request vs warm-process-per-session);
re-anchored to `session.ts`/`chat.tsx`; added `createConversationMemory`
wiring and the per-turn flush / once-on-/exit close ordering.
