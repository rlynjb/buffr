# Connection Pool Reuse

*Connection pooling; amortized connect/handshake cost — Industry standard.*

## Zoom out, then zoom in

Every query an `ask` fires — the profile read, the conversation insert, the
vector search, the trace writes — has to reach Postgres over a connection.
Opening a fresh Postgres connection is *expensive*: a TCP handshake, a startup
packet, auth. The box below is the thing that means you pay that cost once and
reuse it for the whole burst.

```
  Zoom out — where the pool sits

  ┌─ CLI layer (ask-cmd.ts) ────────────────────────────────────┐
  │  loadProfile · startConversation · persistMessage · search  │
  │  · trace flush   — many queries, one operation               │
  └─────────────────────────┬────────────────────────────────────┘
                            │  all go through…
  ┌─ Connection layer (db.ts) ──▼───────────────────────────────┐
  │  pg.Pool   ★ THIS CONCEPT ★                                  │ ← we are here
  │  hands out warm connections, recycles them                   │
  └─────────────────────────┬────────────────────────────────────┘
                            │  TCP (handshake paid ONCE per conn)
  ┌─ Storage — Postgres ────▼────────────────────────────────────┐
  │  reindb / agents schema                                      │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: a `pg.Pool` keeps a set of already-open connections alive. Ask for one,
run a query, give it back — the next query grabs the same warm connection instead
of dialing Postgres again. This is the one place buffr gets a performance property
*for free* by reaching for the right primitive. The pattern is connection pooling;
the finding is that it's quietly doing the right thing.

## Structure pass

**Layers.** Two: the *pool* (`pg.Pool`, owns the connections) and the *callers*
(every `pool.query` / `pool.connect` across `ask-cmd`, `profile`,
`supabase-trace-sink`, `pg-vector-store`).

**Axis — cost (what's paid once vs per-query).** Trace it:

```
  "what does each query pay?" — traced down

  ┌───────────────────────────────────────┐
  │ caller: pool.query(sql)               │   → pays: send SQL, get rows
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ pool: hand out a warm connection     │   → pays: NOTHING (reused)
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ connection: TCP + auth           │   → paid ONCE, at first use
          └─────────────────────────────────┘

  the handshake cost lives at the bottom and is paid once, not per query
```

**Seam — `pool.query` vs `pool.connect`.** Two ways callers reach the pool, and
the difference is load-bearing. `pool.query(sql)` checks out a connection, runs
one statement, checks it back in — auto-managed. `pool.connect()` checks one out
and *holds* it (for the multi-statement transaction in `upsert`) until you
`release()`. The axis "who owns the connection lifecycle" flips across this seam:
the pool owns it for `query`, the caller owns it for `connect`.

## How it works

### Move 1 — the mental model

You know how a browser keeps a `keep-alive` HTTP connection open so the next
request to the same host skips the TCP+TLS handshake? A connection pool is that
for database connections. The strategy: **opening a Postgres connection is slow;
keep a few open and lease them out, so the per-query cost is just the query, not
the dial-up.**

```
  Pool — lease and return (the kernel)

  ┌─ pool (holds N warm connections) ─┐
  │   [conn0] [conn1] [conn2] …       │
  └───┬───────────────────────────────┘
      │ lease
      ▼
   caller runs query  ──► returns conn ──► back in pool
      │
      └─ next caller leases the SAME warm conn, no handshake
```

### Move 2 — the moving parts

**The pool factory.** Bridge: it's a `new pg.Pool({ connectionString })` — buffr's
`createPool` is a one-liner around it. Boundary condition: the pool is *lazy* —
it doesn't open connections until the first query asks for one. So the first query
of a process pays the handshake; every one after rides a warm connection.

**`pool.query` — auto lease/return.** Bridge: like `fetch` where you don't manage
the socket. `loadProfile`, `startConversation`, `persistMessage`, and `search` all
call `pool.query(sql, params)` — each one transparently leases a connection, runs,
returns it. Boundary condition: each `pool.query` is its *own* checkout, so two
`pool.query` calls aren't guaranteed the same physical connection or the same
transaction — fine here because each is a standalone statement.

**`pool.connect` — manual hold.** Bridge: like opening a file you must `close`.
`PgVectorStore.upsert` calls `pool.connect()` because it needs *one* connection to
hold `begin … N inserts … commit` together — a transaction can't span two
connections. Boundary condition: it *must* `release()` in a `finally`, or that
connection leaks out of the pool permanently. buffr does (`pg-vector-store.ts`
`finally { client.release() }`).

```
  An ask's query burst — one process, one pool, warm reuse

  loadProfile        → pool.query  ┐
  startConversation  → pool.query  │  each leases a warm conn,
  persistMessage     → pool.query  ├─ runs, returns it.
  search (in loop)   → pool.query  │  handshake paid once, at the first.
  trace flush (×n)   → pool.query  ┘
        │
        └─ ~5+ queries, ZERO extra handshakes after the first
```

### Move 2 variant — the load-bearing skeleton

The kernel of "cheap repeated queries," and what breaks without each part:

1. **A long-lived pool object** — without it (e.g. `new Client()` + `connect()`
   per query), every query pays a fresh handshake. This is the part that makes
   repeated queries cheap.
2. **Lease/return discipline** — without returning connections (a `release()`
   leak in the `connect` path), the pool drains and eventually every checkout
   blocks waiting for a connection that never comes back.
3. **A bounded pool size** — the implicit default cap (10) is what stops runaway
   concurrency from opening unbounded connections. buffr never approaches it
   (single sequential process), so it's latent, not active.

Skeleton = "long-lived pool + return discipline." The bound is hardening that
matters only under concurrency buffr doesn't have yet.

### Move 3 — the principle

The cost of a database query is "connection setup + the query." Pooling
amortizes the setup to near-zero across a burst, so the marginal query cost
collapses to just the query. Reaching for `pg.Pool` instead of `pg.Client` is the
difference between paying the handshake once per *process* and once per
*statement* — and buffr reached for the right one without ceremony.

## Primary diagram

The full connection lifecycle across an ask.

```
  Connection lifecycle — one ask, one pool

  ┌─ db.ts ──────────────────────────────────────────────────────┐
  │  createPool(databaseUrl) → pg.Pool (lazy, bounded ~10)       │
  └─────────────────────────┬────────────────────────────────────┘
                            │ shared by every module below
  ┌─ Callers ───────────────▼────────────────────────────────────┐
  │  profile.ts        loadProfile      → pool.query  ┐           │
  │  trace-sink.ts     startConversation→ pool.query  │ auto      │
  │  trace-sink.ts     persistMessage   → pool.query  │ lease/    │
  │  pg-vector-store   search           → pool.query  ┘ return    │
  │  pg-vector-store   upsert           → pool.connect ─ manual   │
  │                                       (held for txn, released)│
  └─────────────────────────┬────────────────────────────────────┘
                            │ TCP handshake: paid ONCE at first query
  ┌─ Storage — Postgres (reindb) ───▼────────────────────────────┐
  │  agents.profiles · conversations · messages · chunks         │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every CLI command (`index`, `ask`, `eval`) creates one pool at
startup and tears it down with `pool.end()` at exit. Within an `ask`, the pool
carries the whole query burst; within `index`, it carries every document's
upsert transaction.

**The pool factory — `src/db.ts:4-5`:**

```
  src/db.ts  (lines 4-5)

  export function createPool(databaseUrl: string): pg.Pool {
    return new pg.Pool({ connectionString: databaseUrl });
  }
        │
        └─ Pool, not Client. This one choice is the whole pattern: a Client
           would open/close per use; the Pool keeps warm connections and
           leases them. Lazy — first query pays the handshake, rest reuse.
```

**Auto lease/return — `src/cli/ask-cmd.ts:27-30`:**

```
  src/cli/ask-cmd.ts  (lines 27-30)

  const profile = await loadProfile(pool, cfg.appId);        ← pool.query
  const conversationId = await startConversation(pool, …);   ← pool.query
  await persistMessage(pool, conversationId, 'user', question); ← pool.query
        │
        └─ three statements, three checkouts, ZERO new handshakes after the
           first. Then search() (pool.query, in the agent loop) and the trace
           flush (pool.query ×n) ride the same warm pool.
```

**Manual hold for the transaction — `src/pg-vector-store.ts:40-64`:**

```
  src/pg-vector-store.ts  (lines 40, 64)

  const client = await this.pool.connect();   ← hold ONE conn for the txn
  try { … begin … inserts … commit … }
  finally { client.release(); }               ← MUST return it or pool leaks
        │
        └─ connect (not query) because a transaction needs all its statements
           on the same physical connection. The finally-release is the
           load-bearing discipline: drop it and the pool drains one conn per
           indexed document.
```

## Elaborate

Connection pooling is universal in server-side data access — every mature DB
client (pg, mysql2, JDBC's HikariCP, SQLAlchemy's pool) ships one, because the
handshake cost is real and the fix is well-understood. At single-process laptop
scale the *latency* win is modest (you make a handful of queries), but the
*pattern* is the correct default and scales straight into a multi-request server
without change.

The subtlety worth carrying forward: `query` vs `connect`. Most queries should be
`pool.query` (auto-managed). Reach for `pool.connect` *only* when you need
multiple statements on one connection — a transaction — and then the `finally {
release() }` is non-negotiable. buffr gets both right. What to read next:
`study-networking` for the TCP/TLS handshake the pool amortizes;
`study-database-systems` for why a transaction can't span connections.

## Interview defense

**Q: An ask makes five-plus Postgres queries. Is that a connection-per-query
cost?**
No — they all ride one `pg.Pool` (`src/db.ts:4`). The TCP handshake is paid once,
at the first query of the process; every query after leases an already-warm
connection. That's the difference between `pg.Pool` and `pg.Client` — Pool keeps
connections alive and leases them.

```
  Client: handshake per query   → 5 queries = 5 handshakes
  Pool:   handshake per process → 5 queries = 1 handshake
  buffr uses Pool
```

Anchor: `src/db.ts:4-5` is the pool; `src/cli/ask-cmd.ts:27-30` is the burst that
reuses it.

**Q: The part people forget?**
The `release()` in the `connect` path. `pool.query` returns the connection
automatically, but `pool.connect()` (used for the upsert transaction) hands you a
connection you *own* — and if you don't `release()` it in a `finally`, the pool
leaks one connection per call until it's exhausted. buffr releases in `finally`
(`src/pg-vector-store.ts:64`).

## Validate

1. **Reconstruct:** draw the lease/return cycle and mark where the handshake is
   paid.
2. **Explain:** why does `upsert` use `pool.connect` while `search` uses
   `pool.query`?
3. **Apply:** what happens to the pool if `client.release()` in
   `src/pg-vector-store.ts:64` is removed, after indexing 11 documents (pool
   default max 10)?
4. **Defend:** argue why pooling is a "free" win here yet would be a
   *load-bearing* requirement the moment `ask` is fronted by an HTTP server.

## See also

- `audit.md` § io-network-and-database-bottlenecks, § caching-batching-and-backpressure
- `03-per-chunk-insert-loop.md` — the transaction that holds a connection
- `01-hnsw-approximate-search.md` — the search that rides `pool.query`
- `study-networking` — the TCP/TLS handshake the pool amortizes
- `study-database-systems` — why a transaction is bound to one connection
