# TCP, Sockets & the Connection Lifecycle

**Connection-oriented transport & the pg Pool** · Industry standard

## Zoom out, then zoom in

Both of buffr's wires run on TCP — the pg protocol on top of it, HTTP on top of
it. There's no UDP, no raw socket, nothing connectionless anywhere. The one
thing the repo actually *owns* at this layer is the `pg.Pool`, so this file is
mostly about that: how node-postgres opens, reuses, and closes TCP connections,
and what buffr does (almost nothing) to configure it.

```
  Zoom out — the transport layer

  ┌─ Provider layer ────────────────────────────────────────────────┐
  │   Postgres :5432                       Ollama :11434             │
  └──────┬──────────────────────────────────────┬──────────────────┘
         │ pg binary protocol                    │ HTTP/1.1
  ┌─ Transport (TCP) ───────────────────────────────────────────────┐
  │   pg.Pool — REPO OWNS THIS              fetch's TCP — aptkit owns │ ★ THIS FILE ★
  │   (src/db.ts createPool)                                          │
  └──────┬──────────────────────────────────────┬──────────────────┘
         │                                       │
  ┌─ Service layer ─────────────────────────────────────────────────┐
  │   PgVectorStore / trace-sink / profile  providers (host string)  │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: TCP is the wire that guarantees *ordered, reliable* delivery — the
bytes arrive, in order, or the connection breaks. Both of buffr's protocols
need that guarantee (you can't run SQL over lossy packets), so both sit on TCP.
The interesting part is the *pool* — the thing that decides whether each query
pays for a fresh handshake or reuses a warm connection.

## Structure pass

**Layers.** Pool → connection → socket → TCP segments. Trace *lifecycle* down.

**Axis — "when does the socket open and close?"**

```
  One question down the connection stack

  "when does this open / close?"

  ┌─ Pool (src/db.ts) ──────────────────┐  → opens lazily (first query),
  │  new pg.Pool({ connectionString })  │     never explicitly until pool.end()
  └─────────────────────────────────────┘
      ┌─ Connection (client) ───────────┐  → checked out per query/txn,
      │  pool.connect() / pool.query()  │     released back to pool
      └─────────────────────────────────┘
          ┌─ Socket (TCP) ──────────────┐  → handshake on first checkout,
          │  SYN/SYN-ACK/ACK ... FIN     │     stays warm in the pool, FIN on end
          └─────────────────────────────┘

  the pool's whole job is to make socket-open happen RARELY
```

**Seam.** The seam is `pool.connect()` (an explicit checkout, used by
transactions in `migrate.ts` and `pg-vector-store.ts`) vs `pool.query()` (a
one-shot checkout-query-release, used by `profile.ts` and `trace-sink.ts`). The
*failure* axis flips here: a `connect()` you forget to `release()` leaks a
connection out of the pool forever; a `query()` can't leak because the pool
releases for you.

## How it works

### Move 1 — the mental model

A connection pool is an object cache for expensive-to-create things — the exact
shape as memoizing a `fetch` result, except the cached thing is a live TCP
socket with an authenticated Postgres session on it. You "borrow" one, use it,
give it back.

```
  The pool kernel — borrow / use / return

   ┌──────────── pool (idle connections) ────────────┐
   │   [conn1]  [conn2]  [conn3]   ...  (max 10)      │
   └──┬──────────────────────────────────────────────┘
      │ checkout (connect / query)
      ▼
   [ run query on conn1 ]
      │ release
      ▼
   conn1 back in pool, socket still OPEN, ready for next query

   without the return step, the pool drains and the next checkout
   blocks forever — that's the load-bearing part.
```

### Move 2 — the connection lifecycle, step by step

**Open (lazy, on first checkout).** `new pg.Pool(...)` allocates the manager but
opens no socket. The first `pool.query` or `pool.connect` triggers: TCP
handshake (SYN/SYN-ACK/ACK) to `HOST:5432`, then the pg startup message + auth
(password over the now-established, optionally-TLS connection — see `04`).

```
  Execution trace — first query on a cold pool

  state: pool.idle = [],  pool.total = 0
  call:  pool.query('select ... profiles')
   ├─ no idle conn → open one
   ├─ TCP handshake to HOST:5432         pool.total = 1
   ├─ pg startup + auth                  conn authenticated
   ├─ run the query                      rows returned
   └─ release conn to idle               pool.idle = [conn1]

  state: pool.idle = [conn1], pool.total = 1   ← warm for next query
```

**Reuse (warm path).** The second query (the vector `search`) finds `conn1`
idle and skips the entire handshake+auth. This is the whole point of the pool:
in one `ask` run, hops 2, 4, and 6 (`01-network-map.md`) share one TCP
connection. One handshake amortized across three queries.

**Transaction checkout (explicit).** `migrate.ts` and `PgVectorStore.upsert`
need *several* statements on the *same* connection (`begin` ... `commit` only
work if every statement rides the same socket). They call `pool.connect()` to
pin a connection, run the transaction, and `release()` in a `finally`.

```
  Layers-and-hops — upsert's pinned connection

  ┌─ PgVectorStore.upsert ─┐  pool.connect()   ┌─ pg.Pool ──┐
  │  begin                 │ ────────────────► │ hand out   │
  │  insert chunk 1..n     │                   │ conn (pin) │
  │  commit / rollback     │ ◄──── release() ──│            │
  └────────────────────────┘    in finally     └────────────┘
        │
        └─ the finally block is load-bearing: without release(), a
           failed upsert leaks the connection and the pool shrinks by one
```

**Close.** Every CLI ends with `await pool.end()` — sends FIN on each pooled
socket, drains, and lets the process exit cleanly. Because these are
short-lived CLI processes, the pool's lifetime ≈ the process's lifetime.

### Move 2 variant — the load-bearing skeleton

The pool's irreducible kernel is **checkout → use → release**, plus a **max
size** and the **lazy open**. Strip each:

- Drop *release* → connections never return; after 10 checkouts the pool is
  empty and the 11th `connect()` blocks forever. (This is why `upsert` and
  `migrate` put `release()` in `finally` — `pg-vector-store.ts:63`,
  `migrate.ts:18`.)
- Drop *max size* → unbounded connections; Postgres hits its own
  `max_connections` and rejects new ones. buffr relies on pg's default cap of 10.
- Drop *lazy open* → you'd pay a handshake at pool construction even for
  `migrate`, which... actually does immediately query, so it wouldn't notice.

Everything else — idle timeout, connection timeout, statement timeout — is
*optional hardening* the repo doesn't configure. That's the honest line:
buffr's pool is skeleton-only.

### Move 3 — the principle

Pooling exists because a TCP handshake plus an authenticated session setup is
expensive relative to a query, and you do many queries. The pattern — cache the
expensive resource, lend it out, demand it back — is the same whether the
resource is a DB connection, a thread, or a file handle. The discipline that
makes it safe is always the return step in a `finally`. buffr gets that right
where it matters (the two transaction sites) and leans on the pool's defaults
for everything else.

## Primary diagram

The pool across one CLI lifetime — open lazy, reuse warm, close on end.

```
  pg.Pool lifecycle over one `npm run ask`

  construct          first query        reuse           reuse        end
  ┌────────┐        ┌──────────┐      ┌──────────┐    ┌──────────┐  ┌──────┐
  │ Pool   │  ───►  │ TCP open │ ───► │ same conn│──► │ same conn│─►│ FIN  │
  │ idle=0 │        │ +auth    │      │ (search) │    │ (insert) │  │ close│
  └────────┘        └──────────┘      └──────────┘    └──────────┘  └──────┘
   src/db.ts:5       loadProfile        PgVectorStore   trace-sink    pool.end()
   no socket yet     ask-cmd.ts:27      .search          .flush()     ask-cmd.ts:38

  one handshake, three queries, one close — pooling earns its keep here
```

## Implementation in codebase

**Use cases.** The pool is created once per CLI process and shared across every
DB-touching module in that run. Transactions pin a connection; everything else
uses the auto-release `pool.query`.

**Code side by side.** The pool itself is deliberately bare:

```
  src/db.ts  (lines 4–6)

  export function createPool(databaseUrl: string): pg.Pool {
    return new pg.Pool({ connectionString: databaseUrl });
  }                            │
                               └─ ONLY connectionString. no max, no
                                  connectionTimeoutMillis, no idleTimeoutMillis,
                                  no statement_timeout. all pg defaults.
                                  this is the entire transport-tuning surface
                                  of the repo: there isn't one.
```

The release discipline, done right, in the transaction path:

```
  src/pg-vector-store.ts  (lines 40–64)

  const client = await this.pool.connect();   ← pin one connection
  try {
    await client.query('begin');              ← txn needs the SAME socket
    for (const c of chunks) { ...insert... }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');           ← undo on failure
    throw err;
  } finally {
    client.release();                         ← return to pool, ALWAYS
  }            │
              └─ in finally so a thrown insert still releases. drop this and
                 the pool leaks one connection per failed upsert.
```

## Elaborate

TCP's three-way handshake and ordered-reliable guarantee are why it costs more
than UDP — every byte is acknowledged, retransmitted if lost, delivered in
order. That cost is exactly why pooling matters: you amortize the handshake.
buffr never reaches for UDP because nothing it does tolerates loss or
reordering — SQL and JSON-over-HTTP both need every byte in order. What the pg
*protocol* does on top of this TCP stream (the message framing, the prepared-
statement protocol, the binary row format) is the domain of `study-database-
systems`; this file stops at the socket.

## Interview defense

**Q: You run three queries in one request. How many TCP handshakes?**

```
  q1 ─► open socket + auth ─┐
  q2 ─► reuse warm socket    │  one handshake, three queries
  q3 ─► reuse warm socket ──┘
```

Answer: "One. The pool opens lazily on the first query, then queries two and
three reuse the same warm connection. The handshake is amortized — that's the
pool's entire reason to exist." Anchor: `src/cli/ask-cmd.ts:27,33`,
`src/db.ts:5`.

**Q: What's the load-bearing part of your pool usage?**

Answer: "`client.release()` in a `finally`. The transaction paths pin a
connection with `pool.connect()`; if a thrown insert skipped the release, that
connection leaks out of the pool and after ten leaks the next checkout blocks
forever. The `finally` is what makes it safe." Anchor: `src/pg-vector-store.ts:63`,
`src/migrate.ts:18`.

**Q: How is your pool tuned?**

Answer — and this is the honest one: "It isn't. `createPool` passes only the
connection string; max size, connection timeout, and idle timeout are all pg
defaults. For a single-user CLI that's fine, but a hung connect would block the
process forever — there's no `connectionTimeoutMillis`." Anchor: `src/db.ts:5`.
→ `07-timeouts-retries-pooling-and-backpressure.md`.

## Validate

1. **Reconstruct:** the three-part pool kernel — checkout, use, release — plus
   max size and lazy open.
2. **Explain:** why does `begin/commit` require `pool.connect()` instead of
   three `pool.query()` calls? (statements must ride the same connection;
   `pg-vector-store.ts:40-58`.)
3. **Apply:** an upsert throws mid-loop. Trace what `finally` does and why the
   pool stays healthy. (`pg-vector-store.ts:59-64`.)
4. **Defend:** is stock-default pooling the right call for buffr today? (yes for
   single-user CLI; no `connectionTimeoutMillis` is the one real risk —
   `src/db.ts:5`.)

## See also

- `02-dns-routing-and-addressing.md` — resolving the host before the handshake.
- `04-tls-and-trust-establishment.md` — what rides on top of the TCP stream.
- `07-timeouts-retries-pooling-and-backpressure.md` — the pool tuning that's absent.
- `study-database-systems` — the pg protocol *above* the socket.
