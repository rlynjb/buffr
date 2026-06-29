# 03 · TCP, UDP, Connections, and Sockets

> The connection pool (`pg.Pool`) over TCP — Industry standard
> · pg-wire / libpq protocol; HTTP keep-alive on the model path

## Zoom out, then zoom in

Both of buffr's boundaries run over **TCP** — ordered, reliable, connection-
oriented. No UDP anywhere (no metrics datagrams, no QUIC, no DNS-over-UDP buffr
initiates). The interesting object is the connection pool (`pg.Pool`): a set of
warm TCP connections to Postgres that buffr holds open and lends out, turn after
turn.

```
  Zoom out — connections live at the transport boundary

  ┌─ Process layer ─────────────────────────────────────────────┐
  │  session — borrows + returns connections per query           │
  │     │                                                         │
  │     ▼                                                         │
  │  ★ the connection pool (pg.Pool)  ── src/db.ts:4 ★            │
  │     holds N warm TCP sockets to Postgres                      │
  └───────┬──────────────────────────────────┬──────────────────┘
          │ TCP :5432 (pg-wire)               │ TCP :11434 (HTTP)
          ▼                                   ▼
   [ Postgres ]                         [ Ollama ]
   one socket per pooled connection     fetch() — keep-alive socket
```

Zoom in: a "connection" is one TCP socket plus the protocol handshake layered on
top (libpq auth for Postgres, the HTTP request line for Ollama). The pool is the
thing that decides whether you pay that handshake once or once-per-turn.

## Structure pass

**Layers.** Application (a query call) → Pool (lends a connection) → Socket (the
TCP connection) → Kernel (the actual bytes). This file lives at the Pool/Socket
boundary.

**Axis — trace `connection lifetime` across the two paths.** This is where the
two boundaries diverge sharply:

```
  axis = "how long does one connection live?"

  ┌─ pg-wire path ─────────────┐   seam   ┌─ HTTP path ───────────┐
  │ pool keeps sockets WARM     │ ════════►│ fetch() opens, reuses │
  │ across MANY turns           │ (flips)  │ via keep-alive, but    │
  │ → handshake paid ~once      │          │ buffr doesn't manage it│
  └─────────────────────────────┘          └────────────────────────┘
   buffr explicitly owns this              aptkit/undici owns this
```

**Seam.** The load-bearing seam: on the pg path buffr *explicitly owns
connection lifetime* (it created the pool, it calls `pool.end()` on close). On
the HTTP path buffr owns *nothing* — connection reuse is whatever Node's `fetch`
(undici) does under the hood. The axis-answer flips: explicit pooling vs.
implicit, library-managed sockets.

## How it works

### Move 1 — the mental model

A connection pool is a small set of pre-opened, pre-authenticated sockets that
callers borrow and return — like a checkout desk that hands you an already-warmed
connection instead of making you dial, TLS-handshake, and log into Postgres every
single time. The kernel of it is dead simple:

```
  Pattern — the connection pool kernel

   ┌─────────────── pool (idle warm sockets) ───────────────┐
   │   [conn A]   [conn B]   [conn C]   …                    │
   └───┬──────────────────────────────────────────┬─────────┘
       │ connect(): borrow one         release(): return it
       ▼                                           ▲
   ┌─ caller ───────────────────────────────────────────────┐
   │  client.query(sql, params)  →  use  →  client.release() │
   └─────────────────────────────────────────────────────────┘

   if all warm → reuse instantly (no handshake)
   if none free & under max → open a NEW socket (pay handshake once)
   if at max → caller waits for one to free
```

**The load-bearing parts, named by what breaks if removed:**

- **The warm set.** Remove it (open + close per query) and every turn pays a
  full TCP 3-way handshake + TLS + Postgres auth round-trip. On a long-lived chat
  that's the difference between snappy and sluggish.
- **Borrow/return discipline.** Remove `release()` and connections leak — the
  pool drains to zero, every query then blocks at `max`, and the app hangs.
- **The `max` cap.** Remove it and a burst opens unbounded sockets, exhausting
  Postgres's connection slots. (buffr takes the default `max: 10` — see below.)

The reset (returning the connection cleanly) and the cap are exactly the parts
people forget to mention.

### Move 2 — the walkthrough

**The pool is created once.** This is the entire pool factory (`src/db.ts:1-6`):

```ts
import pg from 'pg';
/** A pg Pool for reindb. Callers load DATABASE_URL via dotenv before this. */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}
```

One line of construction. No `max`, no `idleTimeoutMillis`, no
`connectionTimeoutMillis` — so node-postgres applies its defaults (`max: 10`,
idle sockets kept open, no connect timeout). That default set is fine for a
single-user CLI and is called out as a tuning gap in
`07-timeouts-retries-pooling-and-backpressure.md`.

**The session opens it once and holds it across every turn.** This is the
load-bearing decision (`src/session.ts:39`):

```ts
const pool = createPool(cfg.databaseUrl);
```

That pool is created when `createChatSession()` runs — once, at startup — and
every subsequent `ask()` reuses it. Contrast the docstring at `src/session.ts:13`:
the warm pool is explicitly what distinguishes this from the removed one-shot
`ask` CLI, which opened and closed per call.

**Two borrow styles appear in the code.** The store uses both:

`PgVectorStore.upsert` borrows a *dedicated* connection because it runs a
multi-statement transaction (`src/pg-vector-store.ts:40-64`):

```ts
const client = await this.pool.connect();   // borrow one warm socket
try {
  await client.query('begin');              // ── must be same connection
  for (const c of chunks) { … }             // ── INSERT … on conflict
  await client.query('commit');
} catch (err) {
  await client.query('rollback');
  throw err;
} finally {
  client.release();                         // ── return it (skip this → leak)
}
```

`begin`/`commit` only work if every statement runs on the *same* socket, which is
exactly why `upsert` calls `pool.connect()` and pins one connection. The
`finally { client.release() }` is the load-bearing return — drop it and the pool
leaks a connection per upsert.

`PgVectorStore.search` uses the *convenience* form (`src/pg-vector-store.ts:70`):

```ts
const { rows } = await this.pool.query(`select … <=> $1::vector …`, [...]);
```

`pool.query()` borrows, runs one statement, and auto-returns — no manual
`release` because there's no transaction to keep a socket pinned. This is the
right call: a single `SELECT` doesn't need a dedicated connection.

```
  Layers-and-hops — a query crosses the pool to a TCP socket

  ┌─ Application ─────────────┐
  │ PgVectorStore.search()    │
  └──────────┬────────────────┘
             │ hop 1: pool.query(sql, params)
             ▼
  ┌─ Pool (pg.Pool) ──────────┐
  │ pick a warm socket        │
  └──────────┬────────────────┘
             │ hop 2: pg-wire frames over the warm TCP connection
             ▼
  ┌─ Postgres :5432 ──────────┐
  │ execute, stream rows back │
  └──────────┬────────────────┘
             │ hop 3: result rows ◄──── (socket returns to pool)
             ▼
        rows[] back to search()
```

**The HTTP path has no buffr-owned connection.** Each `fetch` in aptkit's
transport opens (or reuses, via undici keep-alive) a TCP socket to `:11434`.
buffr neither pools nor closes these — they're managed by Node's HTTP stack. So
"connection lifetime" on the model path is implicit, which is why the axis flips
across the seam.

**Why TCP, never UDP.** Both protocols here demand ordered, complete delivery:
SQL results can't arrive out of order, and a JSON response body can't lose a
chunk. TCP gives that; UDP would force buffr to rebuild ordering and
retransmission by hand. There's no datagram use case in the repo (no metrics
firehose, no media), so UDP is simply `not yet exercised`.

### Move 3 — the principle

A connection pool is the canonical answer to "the handshake is expensive and I do
this a lot": amortize the connect cost across many requests by keeping warm
sockets. The discipline that makes it safe is borrow/return — every borrow needs
a matching release, or the pool drains and the app deadlocks. buffr gets this
right (the `finally { release() }` in `upsert`); the thing it leaves on the table
is *tuning* the pool, not *using* it.

## Primary diagram

```
  buffr connections — recap

  boundary 1 — pg-wire over TCP :5432
    one warm pool (pg.Pool), created once  ── src/db.ts:4, src/session.ts:39
    upsert  → pool.connect() + begin/commit + release  (dedicated socket)
    search  → pool.query()  (borrow-run-return, one statement)
    default max 10, no connect/idle timeout overrides

  boundary 2 — HTTP over TCP :11434
    fetch() per request inside aptkit transport
    connection reuse = undici keep-alive (buffr owns nothing)

  UDP: not yet exercised (no datagram use case)
```

## Elaborate

Connection pooling exists because TCP + TLS + database auth is a multi-round-trip
handshake (easily tens of ms), and a chatty app would spend most of its time
re-handshaking. The pattern is identical whether the pool holds Postgres
connections, HTTP connections, or gRPC channels — warm set + borrow/return + cap.
What buffr *doesn't* exercise: the failure-hardening side of pooling (connect
timeouts, validation queries, eviction of dead sockets), all covered in `07`.

## Interview defense

**Q: Why one pool held across turns instead of connecting per query?**

```
  per-query connect:   [handshake][query][close]  ×  every turn  → slow
  pooled:              [handshake once] → [query][query][query…]  → warm
```

Answer: "A chat session fires many queries over its lifetime. Connecting per
query pays a full TCP + TLS + Postgres-auth handshake each time. One warm pool
(`src/db.ts:4`, opened once at `src/session.ts:39`) amortizes that handshake — the
exact reason it replaced the old one-shot `ask` CLI."

**Q: Why does `upsert` call `pool.connect()` but `search` calls `pool.query()`?**

Answer: "`upsert` runs a transaction — `begin`/`commit` must be on one socket, so
it pins a dedicated connection and releases it in a `finally`. `search` is a single
`SELECT`, so the convenience `pool.query()` borrow-run-return is correct — no
transaction means no need to pin." Anchor: `src/pg-vector-store.ts:40` vs `:70`.

**Q: What breaks if you forget `client.release()`?**

Answer: "Connection leak. Each unreleased borrow shrinks the pool; once you've
leaked `max` connections, every future `pool.connect()` blocks forever and the app
hangs. That's why it's in a `finally`."

## See also

- `04-tls-and-trust-establishment.md` — what rides on top of the pg-wire socket
- `07-timeouts-retries-pooling-and-backpressure.md` — the pool's untuned knobs
- `05-http-semantics-caching-and-cors.md` — the other socket (HTTP to Ollama)
- `study-database-systems` — the transaction inside `upsert`, beyond the socket
