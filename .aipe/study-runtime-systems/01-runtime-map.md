# Runtime Map — the process, task, and resource map as-built

**Industry name(s):** runtime / execution model, process-and-resource map · *Project-specific (the as-built shape)*

---

## Zoom out, then zoom in

Before any single mechanism, here's the whole machine. Everything `buffr-laptop` does happens inside **one operating-system process** running **one V8 JavaScript thread**, driven by **the event loop**. That process owns exactly two kinds of long-lived runtime resources: a **connection pool (`pgPool`)** to Postgres, and HTTP connections to Ollama opened on demand. The rest is code and short-lived heap objects.

```
  Zoom out — where the runtime map sits

  ┌─ Interface layer ────────────────────────────────────────┐
  │  npm run chat (Ink TTY)   ·   npm run migrate/index/eval  │
  └───────────────────────────┬──────────────────────────────┘
                              │  one process each
  ┌─ Runtime layer ───────────▼──────────────────────────────┐
  │  ★ THE RUNTIME MAP ★                                      │ ← we are here
  │  one V8 thread · event loop · heap · pool (`pgPool`)      │
  └───────────────────────────┬──────────────────────────────┘
                              │  async I/O
  ┌─ Storage / Provider ──────▼──────────────────────────────┐
  │  Postgres (pgvector)            Ollama (gemma2 / nomic)   │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: this file is the *map* the other seven hang off. It answers three questions once, so the later files can assume them — **where does work run** (one thread, on the event loop), **what resources does the process own** (the pool, HTTP sockets, the heap, stdin/stdout), and **how long does each live** (per-process for batch, per-`/exit` for chat). Name the territory now; the mechanics come later.

---

## The structure pass

**Layers.** Three nested levels: the **interface** (which CLI you ran), the **runtime** (the one thread and its owned resources), and the **backends** (Postgres, Ollama). The interesting contrast lives entirely in the runtime layer.

**Axis — trace `lifecycle`: when does each resource get created and destroyed?** Hold that one question constant down the map.

```
  One axis held constant: "when is this resource born and when does it die?"

  ┌─ the process itself ────────────┐   born: `node dist/...`   dies: event loop empties
  └─────────────────────────────────┘   chat: never empties until /exit

      ┌─ the pool (`pgPool`) ───────┐   born: createPool()      dies: pool.end()
      └─────────────────────────────┘   chat: held across turns · batch: ends the run

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

You already know the shape of a React app: one render tree, one source of truth for state, effects that reach out to the world. A Node process is the same idea one level down — **one thread of control, one event loop deciding what runs next, and a handful of long-lived handles to the outside world.** The runtime map is just the inventory of those handles plus their lifetimes.

```
  The runtime map — pattern shape

         ┌──────────────────────────────────────────┐
         │            ONE V8 THREAD                  │
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

**The process boundary.** Each `npm run *` script is `node <entry>.js` — a fresh OS process. There is no shared memory between two runs; `npm run index` and a running `npm run chat` are entirely separate processes that happen to talk to the same Postgres. The chat entry is the bottom of `src/cli/chat.tsx`:

```ts
// src/cli/chat.tsx:62-63 — the entire process bootstrap
const session = await createChatSession();   // top-level await: opens the pool, builds the agent
render(<Chat session={session} />);          // hands control to Ink's render loop
```

Two lines, but they set the process's whole character: a `createChatSession()` that opens long-lived resources, then `render()` which *never returns* — Ink takes over the loop until `exit()` is called. Contrast the batch shape:

```ts
// src/cli/index-cmd.ts:17-27 — the batch process bootstrap
const pool = createPool(cfg.databaseUrl);    // open
// ... for (const path of paths) { index } ...
await pool.end();                            // close → loop drains → process exits
```

The difference is the whole `02` file: `render()` keeps the loop alive forever; `await pool.end()` lets it die.

**The pool as the one shared runtime resource.** `createPool` is four lines (`src/db.ts:4`) — it wraps `new pg.Pool({ connectionString })` and nothing else. No `max`, no `idleTimeoutMillis`, so node-postgres' defaults apply (max 10 connections). In the chat process this single pool is created once (`src/session.ts:39`) and every turn's queries — `loadProfile`, `startConversation`, `persistMessage`, every `PgVectorStore.search`/`upsert` — borrow from it. That's the warm-pool win: turn 2 reuses turn 1's TCP connections instead of paying a fresh handshake.

```
  The pool's two lifecycle shapes — layers-and-hops

  ┌─ chat process ─────────────────────────────────────────────┐
  │  createChatSession()                                        │
  │     hop 1: createPool() ─────────────► pool holds N sockets │
  │     turn 1 .. turn K: borrow ◄────────► return (per query)  │
  │     /exit → close() → pool.end() ─────► all sockets closed  │
  └────────────────────────────────────────────────────────────┘

  ┌─ batch process (index/migrate/eval) ───────────────────────┐
  │     hop 1: createPool() ─────────────► pool holds sockets   │
  │     do all work under top-level await                      │
  │     hop 2: pool.end() ───────────────► sockets closed, exit │
  └────────────────────────────────────────────────────────────┘
```

**The connection inside the pool.** When a transaction is needed — `PgVectorStore.upsert` and `runMigration` — the code checks out a single connection, runs `begin`/`commit`/`rollback` on *that* connection, and releases it in `finally` (`src/pg-vector-store.ts:40-64`). Simple `pool.query()` calls (`search`, `loadProfile`, `persistMessage`) skip the checkout — node-postgres grabs an idle connection, runs the one query, and returns it automatically. The boundary condition: a thrown error between `connect()` and `release()` that isn't in a `try/finally` leaks the connection. The repo always uses `finally` — that's the discipline that keeps the pool healthy.

**The heap.** Everything else — `turns[]` in the React tree, `pending[]` in the sink, the `rows[]` from a query, the `hits[]` from a search — lives on V8's managed heap and dies when unreachable. No manual frees. The one place this matters is `turns[]`, which grows unbounded across a long session (`05`).

### Move 3 — the principle

A runtime map is just **resources × lifetimes**. Name every long-lived handle the process owns, then for each one answer "who creates it and who destroys it." Do that and you've found every leak, every shutdown bug, and every place a process can hang — before reading a single mechanism. In this repo that inventory is tiny: one pool, some sockets, the heap, and (chat only) a raw-mode TTY. That smallness is why a single-device personal agent can be reasoned about completely.

---

## Primary diagram

The full map, every resource and its lifetime in one frame.

```
  buffr-laptop runtime map — resources and lifetimes

  ┌─ ONE OS PROCESS · ONE V8 THREAD · ONE EVENT LOOP ─────────────────┐
  │                                                                   │
  │  HEAP (GC-managed)          POOL (`pgPool`, src/db.ts:4)          │
  │  turns[]  pending[]         max 10 conns (default)                │
  │  rows[]   hits[]            ┌────────────────────────────────┐    │
  │  born: alloc               │ chat:  held across turns        │    │
  │  die:  unreachable→GC       │        dies at /exit→pool.end() │    │
  │                            │ batch: dies at end of run       │    │
  │  TTY stdin (chat only)      └──────────────┬─────────────────┘    │
  │  raw mode, Ink owns it                     │ checkout/release     │
  └─────────────────────────────┬──────────────┼────────────────────-┘
            async I/O ▼          │              ▼ one conn per txn
  ┌─ Provider: Ollama (HTTP) ─┐  │   ┌─ Storage: Postgres (pgvector) ─┐
  │ gemma2:9b · nomic-embed   │  │   │ agents schema · HNSW index     │
  └───────────────────────────┘  │   └────────────────────────────────┘
                                 │ stdout: rendered Ink frames
                                 ▼ (chat) / line writes (batch)
```

---

## Elaborate

This map is the deliberately-small version of what a server would carry. A typical web backend owns a request-handler pool, several connection pools, a cache client, background timers, and worker threads — and its lifetime is "until the orchestrator sends SIGTERM." `buffr-laptop` is single-device, so it collapses all of that to one pool and a foreground loop, and it pays the simplification cost honestly: no graceful shutdown (`07`), no worker offload (`02`). The map is the right altitude to *see* those omissions as omissions rather than discover them as bugs.

Where this comes from: the "inventory your long-lived handles" discipline is how you read any unfamiliar service. It predates Node — it's the same question you'd ask of a C daemon (which file descriptors does it hold open?) or a JVM service (which thread pools and connection pools?).

---

## Interview defense

**Q: "Walk me through what resources this process holds open and when each is released."**

> One pool to Postgres, HTTP sockets to Ollama opened per request, the V8 heap, and — for chat only — stdin in raw mode. The pool is the only one with an interesting lifecycle: in the batch CLIs it's `createPool` → work → `pool.end()`, so the event loop drains and the process exits. In chat it's held across every turn for connection reuse and only dies when the user types `/exit`, which calls `session.close()` → `pool.end()`. The honest gap: there's no SIGINT handler, so Ctrl-C skips that release path.

```
  resources × lifetimes — the one-sketch answer

  pool   ──► createPool ........ pool.end()   (/exit in chat, end-of-run in batch)
  socket ──► per Ollama request  GC / close
  heap   ──► alloc ............. unreachable → GC
  stdin  ──► Ink raw mode ...... exit() restores cooked mode (chat only)
```

**Anchor:** "One pool, opened in `createChatSession` at `src/session.ts:39`, closed only at `/exit` — that single fact explains both the warm-pool speedup and the missing graceful shutdown."

---

## See also

- `02-processes-threads-and-tasks.md` — the two process shapes in depth
- `03-event-loop-and-async-io.md` — how the one thread schedules all this I/O
- `06-filesystem-streams-and-resource-lifecycle.md` — the pool as a descriptor pool, cleanup discipline
- `07-backpressure-bounded-work-and-cancellation.md` — the missing shutdown path
