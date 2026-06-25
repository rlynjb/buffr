# Connection Pool Reuse

*Connection pooling; amortized connect/handshake cost — Industry standard.*

## Zoom out, then zoom in

Every query the chat session fires — the profile read, the conversation insert,
the per-turn user message, the vector search, the trace writes, the memory
upsert — has to reach Postgres over a connection. Opening a fresh Postgres
connection is *expensive*: a TCP handshake, a startup packet, auth. The box below
is the thing that means you pay that cost once and reuse it — not for a single
burst, but for the *entire interactive session*: one warm pool (`session.ts:39`),
held open across every turn until `close()` ends it (`session.ts:73`).

```
  Zoom out — where the pool sits

  ┌─ CLI / session layer (chat.tsx → session.ts) ───────────────┐
  │  loadProfile (once) · startConversation (once) ·            │
  │  per turn: persistMessage · search · trace flush · memory   │
  │  upsert   — many queries, ONE long-lived session             │
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
*for free* by reaching for the right primitive — and the win **strengthened** when
`ask`'s one-shot CLI became `chat`'s long-lived session: the same pool now carries
many turns' worth of queries, so the single handshake amortizes across a whole
conversation instead of a single ask. The pattern is connection pooling; the
finding is that it's quietly doing the right thing, harder than before.

## Structure pass

**Layers.** Two: the *pool* (`pg.Pool`, owns the connections) and the *callers*
(every `pool.query` / `pool.connect` across `session.ts`, `profile`,
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
the socket. `loadProfile`, `startConversation`, `persistMessage`, `search`, and
the trace flush all call `pool.query(sql, params)` — each one transparently leases
a connection, runs, returns it. Boundary condition: each `pool.query` is its *own*
checkout, so two `pool.query` calls aren't guaranteed the same physical connection
or the same transaction — fine here because each is a standalone statement. Note
the trace sink now emits *more* of these per turn — every CapabilityEvent variant
(step, tool_call_start/end, model_usage, warning, error) becomes its own
`persistMessage` insert (`supabase-trace-sink.ts:56-84`), so a turn's flush is
several `pool.query` checkouts, not ~2. All still ride the one warm pool.

**`pool.connect` — manual hold.** Bridge: like opening a file you must `close`.
`PgVectorStore.upsert` calls `pool.connect()` because it needs *one* connection to
hold `begin … N inserts … commit` together — a transaction can't span two
connections. Boundary condition: it *must* `release()` in a `finally`, or that
connection leaks out of the pool permanently. buffr does (`pg-vector-store.ts`
`finally { client.release() }`).

```
  A chat session's query stream — one process, one pool, warm reuse

  SESSION SETUP (once):
  loadProfile        → pool.query  ┐  paid once at session start
  startConversation  → pool.query  ┘  (session.ts:47, 55)

  PER TURN (repeats every question):
  persistMessage     → pool.query  ┐  user turn (session.ts:61)
  search (in loop)   → pool.query  │  each leases a warm conn,
  trace flush (×n)   → pool.query  ├─ runs, returns it.
  memory upsert      → pool.connect│  per-turn memory write (session.ts:66)
                                   ┘  handshake paid once, at the very first.
        │
        └─ MANY turns × several queries each, ZERO extra handshakes
           after the first. The longer the session, the bigger the win.
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
  │  trace-sink.ts     flush (×n events)→ pool.query  │ return    │
  │  pg-vector-store   search           → pool.query  ┘           │
  │  pg-vector-store   upsert           → pool.connect ─ manual   │
  │  (search + memory) memory.remember  → embed + upsert (per turn)│
  │                                       (held for txn, released)│
  └─────────────────────────┬────────────────────────────────────┘
                            │ TCP handshake: paid ONCE at first query
  ┌─ Storage — Postgres (reindb) ───▼────────────────────────────┐
  │  agents.profiles · conversations · messages · chunks         │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every CLI command (`index`, `chat`, `eval`) creates one pool at
startup and tears it down with `pool.end()` at exit. Within a `chat` session, one
pool carries the *entire* multi-turn conversation's query stream — setup queries
once, then several queries per turn (user message, search, the now-larger trace
flush, and the per-turn memory upsert) — until `session.close()` ends it
(`session.ts:72-74`). Within `index`, it carries every document's upsert
transaction.

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

**Auto lease/return — `src/session.ts:47, 55, 60-66`:**

```
  src/session.ts  (session setup + per-turn ask)

  // setup, once per session:
  const profile = await loadProfile(pool, cfg.appId);        ← pool.query  (47)
  const conversationId = await startConversation(pool, …);   ← pool.query  (55)

  // per turn, repeated for every question:
  await persistMessage(pool, conversationId, 'user', question); ← pool.query (61)
  const answer = await agent.answer(question);   ← search() rides pool.query
  await trace.flush();                            ← pool.query ×n events  (63)
  await memory.remember({ conversationId, … });   ← embed + pool upsert   (66)
        │
        └─ setup pays its checkouts once; every turn after reuses the SAME
           warm pool — ZERO new handshakes for the life of the session.
           The trace flush is now ×n inserts (one per event variant) and the
           memory upsert is an added per-turn write, all on the one pool.
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
release() }` is non-negotiable. buffr gets both right. The long-lived `chat`
session sharpens the value: a pool that lives for one interactive conversation
amortizes its single handshake across dozens of turns, not a single ask. What to
read next: `study-networking` for the TCP/TLS handshake the pool amortizes;
`study-database-systems` for why a transaction can't span connections.

## Interview defense

**Q: A chat session makes dozens of Postgres queries across its turns. Is that a
connection-per-query cost?**
No — they all ride one `pg.Pool` (`src/db.ts:4`), held open for the whole session
(`session.ts:39`, closed at `session.ts:73`). The TCP handshake is paid once, at
the first query of the process; every query after — across *every turn* — leases
an already-warm connection. That's the difference between `pg.Pool` and
`pg.Client`, and it matters more now than under the old one-shot `ask`: the
amortization spreads over a whole conversation.

```
  Client: handshake per query   → 30 queries = 30 handshakes
  Pool:   handshake per process → 30 queries = 1 handshake
  buffr uses Pool; a long session makes the win bigger, not smaller
```

Anchor: `src/db.ts:4-5` is the pool; `src/session.ts:60-66` is the per-turn query
stream (user message, search, ×n trace flush, memory upsert) that reuses it.

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
   `src/pg-vector-store.ts:63` is removed, after the per-turn `memory.remember`
   upsert runs 11 times in a long chat session (pool default max 10)?
4. **Defend:** argue why pooling is a "free" win here yet would be a
   *load-bearing* requirement the moment `chat` is fronted by an HTTP server —
   and why the long-lived session already makes the amortization concrete.

## See also

- `audit.md` § io-network-and-database-bottlenecks, § caching-batching-and-backpressure
- `03-per-chunk-insert-loop.md` — the transaction that holds a connection
- `01-hnsw-approximate-search.md` — the search that rides `pool.query`
- `study-networking` — the TCP/TLS handshake the pool amortizes
- `study-database-systems` — why a transaction is bound to one connection

---

Updated: 2026-06-24 — Reframed from one-shot `ask` to long-lived `chat` session
(`session.ts`): one pool now amortizes its handshake across an entire multi-turn
conversation, strengthening the win. Added the per-turn memory upsert
(`session.ts:66`) and the trace flush write-amplification (now ×n event inserts,
`supabase-trace-sink.ts:56-84`) to the query stream. Purged `ask-cmd.ts` refs;
re-grounded line anchors against current code.
