# Runtime Map — the process, task, and resource map as-built

**Industry name(s):** runtime / execution model, process-and-resource map · *Project-specific (the as-built shape)*

---

## Zoom out, then zoom in

Before any single mechanism, here's the whole machine. Everything `buffr-laptop` does happens inside **one operating-system process** running **one V8 JavaScript thread**, driven by **the event loop**. That process owns exactly two kinds of long-lived runtime resources: a **connection pool (`pgPool`)** to Postgres, and HTTP connections to Ollama opened on demand. The rest is code and short-lived heap objects.

```
  Zoom out — where the runtime map sits

  ┌─ Build layer ────────────────────────────────────────────┐
  │  npm run build:packages  → @buffr/contracts → @buffr/kernel  │
  │                          → @buffr/connectors → @buffr/capabilities │
  │                          → @buffr/domain-pack-investing        │
  │                          → @buffr/engine-investing (monorepo pkgs) │
  │  npm run build  → tsc → dist/src/cli/*.js                 │
  └───────────────────────────┬──────────────────────────────┘
                              │  must precede any runtime invocation
  ┌─ Interface layer ─────────▼──────────────────────────────┐
  │  npm run chat    (OpenTUI · Bun)                           │
  │  npm run migrate/index/index:db/eval  (Node batch)         │
  └───────────────────────────┬──────────────────────────────┘
                              │  one process each
  ┌─ Runtime layer ───────────▼──────────────────────────────┐
  │  ★ THE RUNTIME MAP ★                                      │ ← we are here
  │  chat: Bun/JSC thread · event loop · heap · pool          │
  │  batch: Node/V8 thread · event loop · heap · pool         │
  └───────────────────────────┬──────────────────────────────┘
                              │  async I/O
  ┌─ Storage / Provider ──────▼──────────────────────────────┐
  │  Postgres (agents schema)       Ollama (gemma2 / nomic)   │
  │  Postgres (loopd / contrl)  ← read-only source for index:db │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: this file is the *map* the other seven hang off. It answers three questions once, so the later files can assume them — **where does work run** (one thread, on the event loop), **what resources does the process own** (the pool, HTTP sockets, the heap, stdin/stdout), and **how long does each live** (per-process for batch, per-`/exit` for chat). Name the territory now; the mechanics come later.

---

## The structure pass

**Layers.** Three nested levels: the **interface** (which CLI you ran), the **runtime** (the one thread and its owned resources), and the **backends** (Postgres, Ollama). The interesting contrast lives entirely in the runtime layer.

**Axis — trace `lifecycle`: when does each resource get created and destroyed?** Hold that one question constant down the map.

```
  One axis held constant: "when is this resource born and when does it die?"

  ┌─ the process itself ────────────┐   born: `bun dist/...` (chat) / `node dist/...` (batch)   dies: event loop empties
  └─────────────────────────────────┘   chat: never empties until /exit

      ┌─ the pool (`pgPool`) ───────┐   born: createPool()      dies: pool.end() —
      └─────────────────────────────┘   chat: held across turns, close() now races
                                          pool.end() against a 1s timer (fixed Aug 2)
                                          · batch: ends the run, unbounded

          ┌─ a pooled connection ───┐   born: pool.connect()    dies: client.release()
          └─────────────────────────┘   lives only inside one txn (upsert/migration)

              ┌─ a heap object ─────┐   born: allocation         dies: GC, when unreachable
              └─────────────────────┘   turns[], pending[], hits[]
```

The answer flips at every altitude — and that's the lesson. The process lives as long as the loop has work; the pool lives as long as the *process or the user* keeps it; a connection lives only inside a single transaction; a heap object lives until nothing points at it. Four lifetimes, nested.

**Seams — where the lifecycle answer flips.** The load-bearing seam is `pool.connect()` / `client.release()` (`src/pg-vector-store.ts:40,64`): outside it, the *pool* owns a set of idle connections; inside it, *your code* owns exactly one connection and must give it back. Failure containment flips across that seam — drop the `release()` and you leak a connection out of the pool forever. The second seam is `createChatSession()` vs each batch CLI's top-level: across it, *who decides when the pool dies* flips from the user (`/exit`) to the script (`pool.end()`).

---

## How it works

### Move 1 — the mental model

You already know the shape of a React app: one render tree, one source of truth for state, effects that reach out to the world. A Node (or Bun) process is the same idea one level down — **one thread of control, one event loop deciding what runs next, and a handful of long-lived handles to the outside world.** The runtime map is just the inventory of those handles plus their lifetimes.

The one split: `npm run chat` runs under **Bun** (required by OpenTUI's `bun:ffi` bridge to its Zig rendering core). Every other script (`build`, `test`, `index`, `eval`, `migrate`) runs under **Node**. Both are single-threaded, event-loop-based JavaScript runtimes; the fundamental map below applies to both — only the engine (JSC vs V8) and the entry command differ.

```
  The runtime map — pattern shape

         ┌──────────────────────────────────────────┐
         │  ONE THREAD (Bun/JSC for chat, Node/V8   │
         │   for batch — same model either way)      │
         │   (runs one callback to completion,       │
         │    then asks the loop for the next)       │
         └───────────────────┬──────────────────────┘
                             │ owns ▼
        ┌──────────┬─────────┴─────────┬──────────────┐
        ▼          ▼                   ▼              ▼
   ┌────────┐ ┌─────────┐        ┌──────────┐   ┌──────────┐
   │ heap   │ │ pool    │        │ HTTP      │   │ stdin/   │
   │ objects│ │(`pgPool`)│        │ to Ollama │   │ stdout   │
   └────────┘ └─────────┘        └──────────┘   └──────────┘
    GC-managed  pool.end()        per-request    TTY raw mode
                bounded life       sockets        (chat only)
```

Everything in the later files is one of these handles seen up close.

### Move 2 — the walkthrough

**The process boundary.** Each `npm run *` script spawns a fresh OS process. There is no shared memory between two runs; `npm run index` and a running `npm run chat` are entirely separate processes that happen to talk to the same Postgres. The chat entry (`npm run chat` → `bun dist/src/cli/chat.js`) is the bottom of `src/cli/chat.tsx`:

```ts
// src/cli/chat.tsx:461-472 — the entire process bootstrap (runs under Bun)
const session = await createChatSession();   // top-level await: opens the pool, builds the agent
const renderer = await createCliRenderer({ exitOnCtrlC: false });  // OpenTUI Zig core via bun:ffi
const forceExit = () => { setTimeout(() => process.exit(0), 1500).unref(); session.close().finally(() => process.exit(0)); };
process.on('SIGINT', forceExit);              // fallback for a signal sent from outside the terminal
createRoot(renderer).render(<Chat session={session} onExit={async () => { forceExit(); }} … />);
```

A few more lines than a year ago, but they set the process's whole character: a `createChatSession()` that opens long-lived resources, then `createCliRenderer()` + `createRoot().render()` which *never return* — OpenTUI takes over the loop until `forceExit()` calls `process.exit(0)`, whether that's triggered by `/exit`, a Ctrl-C keystroke caught inside the `useKeyboard` layer, or an external `SIGINT`. Contrast the batch shape (still Node):

```ts
// src/cli/eval-cmd.ts:6-36 — the batch process bootstrap
const pool = createPool(cfg.databaseUrl);    // open
// ... for (const query of queries) { ... } ...
await pool.end();                            // close → loop drains → process exits, unbounded
```

The difference is the whole `02` file: `createRoot().render()` keeps the loop alive forever (OpenTUI holds it open until `forceExit()` fires); `await pool.end()` lets a batch process die on its own, with no timeout wrapping it because there's no TTY to keep hostage if it's slow.

**The pool as the one shared runtime resource.** `createPool` is four lines (`src/db.ts:4`) — it wraps `new pg.Pool({ connectionString })` and nothing else. No `max`, no `idleTimeoutMillis`, so node-postgres' defaults apply (max 10 connections). In the chat process this single pool is created once (`src/session.ts:39`) and every turn's queries — `loadProfile`, `startConversation`, `persistMessage`, every `PgVectorStore.search`/`upsert` — borrow from it. That's the warm-pool win: turn 2 reuses turn 1's TCP connections instead of paying a fresh handshake.

```
  The pool's two lifecycle shapes — layers-and-hops

  ┌─ chat process ─────────────────────────────────────────────┐
  │  createChatSession()                                        │
  │     hop 1: createPool() ─────────────► pool holds N sockets │
  │     turn 1 .. turn K: borrow ◄────────► return (per query)  │
  │     /exit, Ctrl-C, or SIGINT → forceExit() ──────────────────│
  │       → close() races pool.end() vs 1s timer (BOUNDED)      │
  │       → hard 1.5s deadline guarantees exit either way        │
  └────────────────────────────────────────────────────────────┘

  ┌─ batch process (index/migrate/eval) ───────────────────────┐
  │     hop 1: createPool() ─────────────► pool holds sockets   │
  │     do all work under top-level await                      │
  │     hop 2: pool.end() ───────────────► sockets closed, exit │
  │       (unbounded — no timeout, but no TTY to hang either)   │
  └────────────────────────────────────────────────────────────┘
```

**The connection inside the pool.** When a transaction is needed — `PgVectorStore.upsert` and `runMigration` — the code checks out a single connection, runs `begin`/`commit`/`rollback` on *that* connection, and releases it in `finally` (`src/pg-vector-store.ts:40-64`). Simple `pool.query()` calls (`search`, `loadProfile`, `persistMessage`) skip the checkout — node-postgres grabs an idle connection, runs the one query, and returns it automatically. The boundary condition: a thrown error between `connect()` and `release()` that isn't in a `try/finally` leaks the connection. The repo always uses `finally` — that's the discipline that keeps the pool healthy.

**The heap.** Everything else — `turns[]` in the React tree, `pending[]` in the sink, the `rows[]` from a query, the `hits[]` from a search — lives on the managed heap (JSC for chat, V8 for batch) and dies when unreachable. No manual frees. The one place this matters is `turns[]`, which grows unbounded across a long session (`05`).

### Move 3 — the principle

A runtime map is just **resources × lifetimes**. Name every long-lived handle the process owns, then for each one answer "who creates it and who destroys it." Do that and you've found every leak, every shutdown bug, and every place a process can hang — before reading a single mechanism. In this repo that inventory is tiny: one pool, some sockets, the heap, and (chat only) a raw-mode TTY. That smallness is why a single-device personal agent can be reasoned about completely.

---

## Primary diagram

The full map, every resource and its lifetime in one frame.

```
  buffr-laptop runtime map — resources and lifetimes

  ┌─ ONE OS PROCESS · ONE THREAD · ONE EVENT LOOP ─────────────────────┐
  │  chat: Bun/JSC    batch: Node/V8   (same model, different engine)  │
  │                                                                    │
  │  HEAP (GC-managed)          POOL (`pgPool`, src/db.ts:4)           │
  │  turns[]  pending[]         max 10 conns (default)                 │
  │  rows[]   hits[]            ┌────────────────────────────────┐     │
  │  born: alloc               │ chat:  held across turns        │     │
  │  die:  unreachable→GC       │        dies at /exit→pool.end() │     │
  │                            │ batch: dies at end of run       │     │
  │  TTY (chat only)            └──────────────┬─────────────────┘     │
  │  OpenTUI Zig core via bun:ffi              │ checkout/release      │
  └─────────────────────────────┬──────────────┼─────────────────────-┘
            async I/O ▼          │              ▼ one conn per txn
  ┌─ Provider: Ollama (HTTP) ─┐  │   ┌─ Storage: Postgres (pgvector) ─┐
  │ gemma2:9b · nomic-embed   │  │   │ agents schema · HNSW index     │
  └───────────────────────────┘  │   └────────────────────────────────┘
                                 │ stdout: rendered OpenTUI frames
                                 ▼ (chat) / line writes (batch)
```

---

## Elaborate

This map is the deliberately-small version of what a server would carry. A typical web backend owns a request-handler pool, several connection pools, a cache client, background timers, and worker threads — and its lifetime is "until the orchestrator sends SIGTERM." `buffr-laptop` is single-device, so it collapses all of that to one pool and a foreground loop, and it pays the simplification cost honestly: no graceful shutdown (`07`), no worker offload (`02`). The map is the right altitude to *see* those omissions as omissions rather than discover them as bugs.

Where this comes from: the "inventory your long-lived handles" discipline is how you read any unfamiliar service. It predates Node — it's the same question you'd ask of a C daemon (which file descriptors does it hold open?) or a JVM service (which thread pools and connection pools?).

---

## Interview defense

**Q: "Walk me through what resources this process holds open and when each is released."**

> One pool to Postgres, HTTP sockets to Ollama opened per request, the JS heap, and — for chat only — stdin in raw mode. The pool is the only one with an interesting lifecycle: in the batch CLIs it's `createPool` → work → `pool.end()`, unbounded, so the event loop drains and the process exits on its own. In chat it's held across every turn for connection reuse and dies via `forceExit()` — triggered by `/exit`, a Ctrl-C keystroke, or an external SIGINT — which races `session.close()` (itself racing `pool.end()` against a 1s timer) against a hard 1.5s deadline. That used to be a real gap: Ctrl-C had no handler at all until `64f822f`/`9c1b1e6` fixed it. The remaining honest gap is narrower now — the shutdown is *bounded*, not *guaranteed-to-drain*: if the pool doesn't close within its timer, in-flight trace writes can still be lost.

```
  resources × lifetimes — the one-sketch answer

  pool   ──► createPool ... close() races pool.end() vs 1s timer, then forceExit()
                            fires by 1.5s regardless (/exit, Ctrl-C, or SIGINT — chat)
                            ... pool.end() unbounded (end-of-run — batch)
  socket ──► per Ollama request  GC / close
  heap   ──► alloc ............. unreachable → GC
  stdin  ──► OpenTUI raw mode ... process.exit(0) via forceExit() (chat only)
```

**Anchor:** "One pool, opened in `createChatSession` at `src/session.ts:399`, closed via `forceExit()` (`src/cli/chat.tsx:464`) racing a hard 1.5s deadline — that single fact explains the warm-pool speedup, why Ctrl-C used to hang the process, and why the fix is bounded rather than fully graceful. Chat runs under Bun (OpenTUI needs `bun:ffi`); every other script runs under Node — same event-loop model, different engine."

---

## See also

- `02-processes-threads-and-tasks.md` — the two process shapes in depth
- `03-event-loop-and-async-io.md` — how the one thread schedules all this I/O
- `06-filesystem-streams-and-resource-lifecycle.md` — the pool as a descriptor pool, cleanup discipline
- `07-backpressure-bounded-work-and-cancellation.md` — the missing shutdown path
