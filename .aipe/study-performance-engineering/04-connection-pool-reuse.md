# Connection Pool Reuse — one warm pool across a whole session

**Industry name(s):** connection pooling; connection reuse / warm pool. **Type:** Industry standard.

This is the finding that's a *win*, not a cost. buffr builds one connection pool and keeps it warm across an entire chat session, so no turn pays connection-setup latency. It's the right call, and worth understanding *why* it's right.

## Zoom out, then zoom in

Every database touch in a turn — persist the user message, search the HNSW index, write the trace, remember the exchange — needs a Postgres connection. Opening a fresh TCP+TLS+auth connection per query is expensive. A pool keeps a few open and hands them out.

```
  Zoom out — where the pool lives

  ┌─ Session layer ──────────────────────────────────────────────┐
  │  src/session.ts:39  createPool(databaseUrl)  ← ONCE per session│ ← we are here
  │     │  one warm pg.Pool, held for the whole conversation       │
  │     ├──► PgVectorStore (search + upsert)                      │
  │     ├──► SupabaseTraceSink (trace writes)                     │
  │     ├──► persistMessage / startConversation                  │
  │     └──► loadProfile / memory                                 │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ db.ts ───────────────────▼───────────────────────────────────┐
  │  new pg.Pool({ connectionString })   src/db.ts:4-6            │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Postgres ────────────────▼───────────────────────────────────┐
  │  a small set of reused physical connections                  │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **connection pooling** — amortize the setup cost of a connection over many queries by keeping a warm set and reusing them. The lifecycle decision is the load-bearing part: the pool is created once at session start and closed once at session end, never per query.

## The structure pass

Axis: **lifecycle** — *when* is a connection created and destroyed?

```
  axis = "connection lifetime"

  ┌─ without pooling ───────────────────────────────────────────┐
  │  per query: connect → TCP+auth → query → close              │
  │             ▲ setup cost paid EVERY query                    │
  └──────────────────────────────────────────────────────────────┘
              ═══ buffr flips this ═══
  ┌─ with pooling (buffr) ──────────────────────────────────────┐
  │  session start: pool created, connections warmed            │
  │  per query: borrow from pool → query → release back         │
  │  session end: pool.end()  ← src/session.ts:73               │
  │             ▲ setup cost paid ONCE, amortized over all turns │
  └──────────────────────────────────────────────────────────────┘
```

**Seam:** the boundary between session lifecycle and query lifecycle. Without a pool, connection lifetime = query lifetime. With a pool, connection lifetime = session lifetime and queries just *borrow*. That decoupling is the whole win.

## How it works

### Move 1 — the mental model

You know how `fetch` keep-alive reuses a TCP connection across requests instead of reopening one each time? A connection pool is that for the database — except it also pre-pays the auth handshake and keeps a small set ready so concurrent borrowers don't wait. buffr creates the pool once and every component shares it.

```
  the pool — borrow / use / return

   session ─────────────────────────────────────────────►
            │ create pool (warm)              end pool │
            ▼                                          ▼
   turn 1:  borrow ──query──► release
   turn 2:  borrow ──query──► release   ← same connection,
   turn 3:  borrow ──query──► release      no re-setup
            ▲ setup paid once, here
```

### Move 2 — the step-by-step walkthrough

**Creation — once.** `src/db.ts:4-6` is the whole factory:

```ts
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}
```

Deliberately minimal — pg's defaults (max 10 connections, idle timeout) are fine for one user. It's called exactly once per session at `src/session.ts:39`, and the resulting pool is injected into *every* DB-touching component: the vector store (`:41`), the trace sink (`:56`), `persistMessage`, `startConversation`, `loadProfile`, and memory. One pool, shared.

**Reuse — across every turn.** The session holds the pool for the conversation's whole life. Look at where the pool is *not* re-created: `ask()` (`src/session.ts:60-71`) runs persist → answer → flush → remember, and every one of those borrows from the same warm pool. No turn pays connection setup.

```
  layers-and-hops — one pool, many borrowers, one warm channel

  ┌─ Session (src/session.ts) ───────────────────────────────────┐
  │  pool ──┬─► PgVectorStore.search   (HNSW query)               │
  │         ├─► PgVectorStore.upsert   (pool.connect → borrow)    │
  │         ├─► SupabaseTraceSink      (trace INSERTs)            │
  │         └─► persistMessage         (user/turn INSERTs)        │
  └───────────────────────────┬───────────────────────────────────┘
                              │  borrow / release (no re-connect)
  ┌─ Postgres ────────────────▼───────────────────────────────────┐
  │  warm connections, reused turn after turn                     │
  └───────────────────────────────────────────────────────────────┘
```

**Borrow semantics — two styles, both correct.** Two ways the pool gets used, and the distinction matters:
- `pool.query(...)` (e.g. `search` at `src/pg-vector-store.ts:70`) — borrow, run one query, auto-release. Right for a single statement.
- `pool.connect()` → `client.query(...)` → `client.release()` (e.g. `upsert` at `src/pg-vector-store.ts:40-64`) — pin one connection for a multi-statement transaction, release in `finally`. Right when `begin`/`commit` must run on the *same* connection. **The load-bearing part people forget:** a transaction's statements must all run on one connection — `pool.query` for `begin` then `pool.query` for the INSERT could land on *different* pooled connections and silently break the transaction. `upsert` correctly uses `connect()` for exactly this reason.

**Shutdown — once.** `close()` (`src/session.ts:72-74`) calls `pool.end()`, draining and closing all connections. What breaks without it: connections leak and Postgres eventually refuses new ones. Correct as written.

### Move 3 — the principle

Decouple connection lifetime from query lifetime and the setup cost amortizes to near zero. This is the unambiguous win in buffr's performance story — the right pattern, applied correctly, including the subtle `connect()`-for-transactions detail. The general lesson: any expensive-to-create, reusable resource (DB connections, HTTP keep-alive sockets, model handles) wants a pool whose lifetime tracks the *session*, not the *operation*.

## Primary diagram

```
  Connection pool reuse — lifecycle, end to end

  session start ──► createPool()  src/db.ts:4   [warm, shared]
        │
        ▼
  ┌─ per turn: ask() ────────────────────────────────────────────┐
  │  persistMessage ─┐                                            │
  │  search (HNSW) ──┼─ all borrow from the SAME warm pool        │
  │  trace flush ────┤   no connection setup paid per turn        │
  │  upsert (txn) ───┘   (connect→release for begin/commit)       │
  └───────────────────────────┬───────────────────────────────────┘
        │ repeat across turns  │
        ▼                      ▼
  session end ──► pool.end()  src/session.ts:73  [drain + close]
```

## Elaborate

Connection pooling is one of the oldest database-performance patterns precisely because connection setup (TCP, optional TLS, auth, backend process fork on Postgres) is genuinely expensive — often more than a simple query itself. buffr's choice to hold the pool across the session, rather than the one-shot CLIs' pattern of create-pool / do-work / `pool.end()` (see `index-cmd.ts:17` then `:27`, `eval-cmd.ts:13` then `:34`), is exactly right for a long-lived chat: the CLIs are short-lived so they tear down immediately; the session is long-lived so it keeps the pool warm. Two different lifecycles, both matched to their workload.

For the transport mechanics under a connection — the TCP handshake, what auth costs, keep-alive — see **`study-networking`**. For what happens inside Postgres when a connection is established (backend process, session state), see **`study-database-systems`**. This file owns the *amortization* read.

## Interview defense

**Q: How do you manage database connections across a chat session?**

> One `pg.Pool`, created once at session start and shared by every DB-touching component — the vector store, the trace sink, message persistence, memory. Every turn borrows from the warm pool and releases back, so no turn pays connection setup. It's torn down with `pool.end()` when the session closes. The one-shot CLIs use a different lifecycle — create, work, end immediately — because they're short-lived; the chat session keeps it warm because it isn't.

```
  setup cost paid ONCE at session start, not per query
  borrow ─query─ release × every turn, same warm connections
```

**Q: Any subtlety in how you use the pool?**

> Yes — transactions. For single statements I use `pool.query`, which borrows and auto-releases. But the upsert runs `begin`/INSERTs/`commit`, and those must all land on the *same* connection — so it uses `pool.connect()` to pin one client and releases it in a `finally`. If I'd used `pool.query` for each, `begin` and the INSERT could hit different pooled connections and the transaction would silently not be a transaction. That's the part that's easy to get wrong.

> Anchor: `src/session.ts:39` (created once), `:73` (`pool.end()`), `src/pg-vector-store.ts:40-64` (`connect()` for the txn).

## See also

- `00-overview.md` — the warm pool in the system frame
- `audit.md` — lens 5 (I/O bottlenecks)
- `03-per-chunk-insert-loop.md` — the transaction that borrows via `connect()`
- `05-per-turn-memory-and-trace-cost.md` — the per-turn writes that share this pool
- **`study-networking`** — connection setup cost, keep-alive
- **`study-database-systems`** — what a Postgres connection costs server-side
