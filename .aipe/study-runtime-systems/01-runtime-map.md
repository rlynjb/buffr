# Runtime Map — the process, task, and resource map as-built

**Industry name(s):** runtime / resource topology, process model · **Type:** Project-specific

## Zoom out, then zoom in

Before any single mechanism, here's the whole machine. buffr-laptop is one Node process running one event loop, and that process owns exactly two external resources — a Postgres connection pool and an Ollama HTTP client — plus, in chat mode, the terminal itself.

```
  Zoom out — the runtime as labelled bands

  ┌─ Entry layer ────────────────────────────────────────────────┐
  │  npm run chat        npm run migrate / index / eval           │
  │  (Ink TUI, stays up) (top-level await, runs once, exits)      │ ← we are here:
  └───────────────────────────────┬───────────────────────────────┘   the whole map
                                  │
  ┌─ Process / runtime layer ─────▼───────────────────────────────┐
  │  ONE Node process · ONE event-loop thread · V8 heap           │
  │  createChatSession() / *-cmd.ts hold the live objects         │
  └───────────────────────────────┬───────────────────────────────┘
                                  │  owns these resources:
  ┌─ Resource layer ──────────────▼───────────────────────────────┐
  │  pg.Pool ──TCP──► Postgres (reindb)                            │
  │  fetch   ──HTTP──► Ollama (gemma2:9b + nomic-embed-text)       │
  │  process.stdin (raw-mode TTY) — chat only                     │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: this file answers one question — *what does this process own, and for how long?* Every other file in the guide is a zoom into one band of this picture. The pool is the load-bearing resource; the lifetime question is the load-bearing axis.

## Structure pass

**Layers.** Three nested levels: the **entry** (which npm script you ran), the **process** (the live Node runtime + the objects `createChatSession` or a `*-cmd.ts` builds), and the **resources** (pool, HTTP, stdin).

**The axis to hold constant: lifecycle — "how long does this thing live?"** Trace it down the stack and watch the answer flip.

```
  One axis — "how long does it live?" — traced down the map

  ┌──────────────────────────────────────────────┐
  │ entry: chat process      → until /exit (long) │
  │        migrate/index/eval → one batch (short) │   ← answer SPLITS here
  └───────────────────────┬────────────────────────┘
       ┌──────────────────────────────────────────┐
       │ process objects: pool, agent, session     │   → = the entry's lifetime
       └───────────────────────┬───────────────────┘
            ┌─────────────────────────────────────┐
            │ a single pg connection (per query)   │   → borrowed for ONE query,
            └─────────────────────────────────────┘     then returned to pool

  the answer flips twice: entry shape decides everything below it
```

**The seams.** Two boundaries carry contracts:

- **chat vs one-shot** (vertical seam between sibling entry points): the lifecycle axis flips here. Same `createPool()` on both sides; opposite ownership. → walked in `02`, `06`.
- **pool vs connection** (horizontal seam): the pool lives as long as the process; a *connection* lives for one `query()` or one `connect()/release()` cycle. The pool is the contract that lets every call site pretend it has its own database without paying a TCP handshake each time.

Hand off: the mechanics below hang on those two seams.

## How it works

### Move 1 — the mental model

You already know the shape of a `fetch()`: you don't open a new socket per request, the browser keeps a connection alive and reuses it. A `pg.Pool` is exactly that idea for Postgres — a bounded set of warm TCP connections you borrow and return. The runtime map is just *who holds the pool, and for how long*.

```
  The pattern — borrow / use / return, against a long-lived pool

        ┌─────────── pg.Pool (lives = process) ───────────┐
        │   [conn] [conn] [conn] ... (idle, warm)         │
        └───────┬───────────────────────────▲──────────────┘
        borrow  │ pool.connect()             │ client.release()
                ▼                            │  (or pool.query() does both)
            ┌────────────┐                   │
            │ run a query│ ──── awaits I/O ──┘
            └────────────┘
```

### Move 2 — the walkthrough

**The pool factory is the same everywhere; the lifetime is not.** Every entry point builds its pool through one tiny factory:

```ts
// src/db.ts:4
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}
```

No options passed — so `max` is the library default (10 connections), no `idleTimeoutMillis` override. That single line is the only place a pool is born. What *differs* is who keeps it.

**In chat, the pool is held by the session closure for the whole run.** `createChatSession()` opens it once and never closes it until `close()`:

```ts
// src/session.ts:39-57
const pool = createPool(cfg.databaseUrl);          // born once
// ...embedder, store, pipeline, model, profile, memory, conversation, trace, agent
const agent = new RagQueryAgent({ model, tools, profile, trace });
// ...returned in a closure that captures `pool`
```

Every `ask()` (`src/session.ts:60-71`) and `close()` (`72-75`) closes over that same `pool`. The agent, the vector store, the trace sink — all built once, all sharing the one pool. This is the "warm" path: turn 50 pays no setup cost that turn 1 didn't already pay.

**In the one-shot CLIs, the pool is opened, drained, and ended in a straight line.** `index-cmd.ts` is the clearest:

```ts
// src/cli/index-cmd.ts:17-27
const pool = createPool(cfg.databaseUrl);   // open
// ...build store + pipeline
for (const path of paths) {                 // do all the work
  await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), text, sourcePath: path });
}
await pool.end();                           // drain + close, process exits
```

`eval-cmd.ts:13,34` and `migrate.ts:27,30` follow the identical open → work → `pool.end()` shape. There's no session, no closure, no second turn — the process *is* the batch.

**A single query borrows one connection, transparently.** `pool.query(...)` checks out a connection, runs the SQL, returns the connection — you never see it. `loadProfile` (`src/profile.ts:5`) is one such call. When you need *several* statements to be atomic, you check out explicitly and hold it:

```ts
// src/pg-vector-store.ts:40-64 — explicit borrow for a transaction
const client = await this.pool.connect();   // borrow ONE connection
try {
  await client.query('begin');
  for (const c of chunks) { /* insert each */ }
  await client.query('commit');
} catch (err) {
  await client.query('rollback');
  throw err;
} finally {
  client.release();                          // ALWAYS return it
}
```

The `finally { client.release() }` is the load-bearing line — drop it and that connection never returns to the pool, and after 10 leaks the pool is dry and every future query hangs forever. → `06` walks descriptor leaks in depth.

### Move 3 — the principle

A runtime map is really a *lifetime map*. Find the longest-lived resource (here, the pool), find what holds it (a session closure vs a script's top-level scope), and you know where every "is this still open?" bug can live. The resource doesn't decide its own lifetime — the entry point does.

## Primary diagram

The full map, both shapes, one frame.

```
  buffr-laptop — runtime map, both process shapes

  ┌─ Entry ──────────────────────────────────────────────────────────────┐
  │  chat.tsx (Ink, long-lived)          index/eval/migrate (one-shot)     │
  └─────────────┬───────────────────────────────────┬─────────────────────┘
                │ createChatSession()                 │ top-level await
  ┌─ Process ───▼──────────────────────┐  ┌──────────▼─────────────────────┐
  │  pool (held in closure)            │  │  pool (held in module scope)   │
  │  agent built once, reused          │  │  pipeline built once, looped   │
  │  ask() per turn ──┐                │  │  for(...) { work } ; pool.end()│
  └───────────────────┼────────────────┘  └──────────┬─────────────────────┘
            borrow conn│ return                       │ borrow/return per query
  ┌─ Resource ─────────▼──────────────────────────────▼─────────────────────┐
  │  pg.Pool (max 10, default) ──TCP──► Postgres reindb / schema agents      │
  │  OllamaEmbeddingProvider / GemmaModelProvider ──HTTP──► Ollama :11434     │
  │  process.stdin raw-mode TTY (chat only)                                   │
  └──────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The pool pattern predates Node — it's the same connection-pooling idea you'd find in a JDBC `DataSource` or a Go `database/sql.DB`. The reason it matters more in a *long-lived* process is that the savings compound: a one-shot script could almost get away with a single connection, but the chat process would pay a TCP + auth handshake on every turn without the pool keeping connections warm. The fact that buffr reuses the *same* factory for both shapes and lets the entry point decide the lifetime is the clean part — the lifetime policy lives at the call site, not baked into `createPool`.

## Interview defense

**Q: What does this process own, and what's the longest-lived thing in it?**
The longest-lived resource is the `pg.Pool`. In chat it's held by the session closure for the whole run; in the batch CLIs it lives for one script execution and is explicitly `pool.end()`-ed.

```
  pool lifetime = entry-point lifetime
  chat:  open ──────────── many turns ──────────── /exit → close()
  batch: open ── one loop of work ── pool.end() → exit
```
Anchor: *the entry point decides the resource's lifetime; `createPool` (`src/db.ts:4`) is identical for both.*

**Q: What's the one line that, if removed, leaks a connection?**
`client.release()` in the `finally` of `PgVectorStore.upsert` (`src/pg-vector-store.ts:63`). Without it a borrowed connection never returns; after 10 leaks (the default pool max) the pool is exhausted and every query hangs.

```
  borrow ──► [no release] ──► conn stuck
  ×10 ──► pool dry ──► next query waits forever
```
Anchor: *the `finally`-release is what makes the explicit-transaction path safe.*

## See also

- `02-processes-threads-and-tasks.md` — why one thread serves this whole map
- `06-filesystem-streams-and-resource-lifecycle.md` — the pool as a descriptor pool, leak + cleanup
- `study-system-design` — the buffr ↔ Postgres ↔ Ollama topology across boundaries
