# TCP, UDP, Connections, and Sockets

**Industry name(s):** transport-layer connections / socket lifecycle /
connection pooling. **Type:** Industry standard.

## Zoom out, then zoom in

Both of buffr's wire boundaries ride **TCP** — the ordered, reliable,
connection-oriented transport. Neither uses UDP. The interesting story is
on the Postgres side: instead of opening a fresh TCP connection per query,
buffr holds a *pool* of warm connections for the life of the chat session.
That one decision is the most consequential networking choice in the repo.

```
  Zoom out — where connections live and who holds them

  ┌─ Orchestration (src/session.ts) ─────────────────────────┐
  │  createPool(databaseUrl)  →  ★ pg.Pool ★  (held forever) │ ← we are here
  │  Ollama providers (host string, aptkit opens TCP per req)│
  └───────┬───────────────────────────────────┬──────────────┘
          │ POOL of warm TCP conns             │ TCP conn per HTTP req
          ▼ port 5432                          ▼ port 11434
  ┌─ Postgres ─────────────┐          ┌─ Ollama ──────────────┐
  │ accepts pg-wire conns  │          │ accepts HTTP conns    │
  └────────────────────────┘          └───────────────────────┘

  both TCP. no UDP anywhere. the pool is the star of this file.
```

Zoom in. The concept is the **connection lifecycle**: a TCP connection is
expensive to open (handshake + auth + maybe TLS) and cheap to reuse. A
*pool* keeps a set of opened connections alive so the cost is paid once,
not per query. buffr exercises this explicitly for Postgres and implicitly
(via aptkit/the runtime) for Ollama.

## Structure pass

**Layers.** Application (a query) → pool (lease a connection) → TCP socket
(the actual conn) → kernel (the handshake).

**Axis — lifecycle / "when is a TCP connection opened and closed?"** This
is the axis that makes the pool pop:

```
  axis: "when does a TCP connection open & close?"

  ┌─ without a pool ────────────────┐
  │ open → query → close, EVERY     │  → lifecycle = per query
  │ query pays SYN+auth(+TLS)       │
  └─────────────────────────────────┘
  ┌─ with the pool (buffr) ─────────┐
  │ open ONCE on first use,         │  → lifecycle = per SESSION
  │ reused across many turns,       │
  │ closed at pool.end()            │
  └─────────────────────────────────┘

  the pool moves the open/close lifecycle from per-query to per-session
```

**Seam.** The seam is `pool.connect()` / `pool.query()` — above it the
app thinks "I need a connection"; below it the pool decides whether to
hand back a warm one or open a new socket. That seam is where the
per-query→per-session lifecycle flip happens, which is exactly the test
for a load-bearing seam.

## How it works

### Move 1 — the mental model

You know how a React app keeps one WebSocket or one Supabase client alive
and reuses it, instead of reconnecting on every render? A connection pool
is that idea generalized: a small set of live TCP connections kept warm
and lent out one at a time. The kernel of it is *borrow → use → return*,
never *open → use → close*.

```
  The pool kernel — borrow / use / return

         ┌──────────── pool (warm conns) ────────────┐
         │   [conn A]   [conn B]   [conn C: idle]     │
         └───┬──────────────────────────────▲────────┘
       borrow│ connect()                     │ release()
             ▼                               │
        ┌─ your query runs on conn A ────────┘
        │  pool.query() borrows + returns in one call
        └─ conn A goes back to the pool, still OPEN
```

### Move 2 — walk the connection lifecycle

**One pool, built once, for the whole session.** The single most
important line: `src/session.ts:39` — `const pool = createPool(cfg.databaseUrl)`.
`createPool` is a three-line factory, `src/db.ts:4-6`:

```
  src/db.ts:4-6 — the entire pool factory

  export function createPool(databaseUrl: string): pg.Pool {
    return new pg.Pool({ connectionString: databaseUrl });
  }                      └──────────┬──────────┘
                                    │
              every option (max conns, idle timeout, connect
              timeout) is a pg DEFAULT — buffr tunes none of them
              (→ see file 07 for what the defaults are)
```

Because `createChatSession()` runs once at startup and the Ink app lives
until `/exit`, that pool — and the warm TCP connections inside it — survive
across *every* turn the user types. This is stated outright in the
session's own doc comment, `src/session.ts:14-17`: "one warm pg pool and
one conversation held across every turn (unlike the one-shot `ask` CLI,
which opens and closes per call)."

**`pool.query()` — borrow and return in one call.** The read path,
`src/pg-vector-store.ts` `search()`, calls `this.pool.query(...)`. Under
the hood pg leases an idle connection, runs the SQL, and returns the
connection to the pool — you never see the borrow/return. The TCP socket
stays open afterward, warm for the next turn.

```
  search() — one query, one borrow/return, socket stays warm

  ┌─ App ─────────────┐  hop 1: borrow idle conn   ┌─ pg.Pool ─────┐
  │ pgVectorStore     │ ─────────────────────────► │ lease conn A  │
  │ .search(vec, k)   │                            └──────┬────────┘
  └───────────────────┘  hop 4: rows + release ◄──── conn │ A (warm)
                                                          │ TCP 5432
                                          hop 2: SQL ─────▼──────────┐
                                          hop 3: rows ◄── Postgres   │
                                                          └──────────┘
  after hop 4 the TCP connection is RETURNED to the pool, still open
```

**`pool.connect()` — manual lease for a multi-statement transaction.**
The write path needs more than one statement on the *same* connection (a
transaction must be `begin`/`commit` on one connection), so it leases
explicitly. `src/pg-vector-store.ts` `upsert()`:

```
  upsert() — manual lease for a transaction, explicit release

  const client = await this.pool.connect();   // borrow ONE conn
  try {
    await client.query('begin');              // all on the SAME
    for (const c of chunks) { ...insert... }  //   leased socket
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');           // wire still open
    throw err;
  } finally {
    client.release();                         // ★ MUST return it
  }
```

The load-bearing part: `client.release()` in the `finally`. Drop it and
that connection never returns to the pool — it's leaked. Leak enough and
the pool hits its max, every future `connect()` blocks waiting for a
connection that will never come back, and the whole app deadlocks with no
error. The migration runner (`src/migrate.ts`) and the trace path follow
the same connect/try/finally/release discipline. *What breaks if removed:*
the pool, silently, after N leaks. This is the one place buffr's pooling
correctness is entirely on buffr's shoulders.

**Ollama: TCP too, but per-request and not buffr's code.** The HTTP calls
to Ollama also ride TCP — HTTP is built on it. But buffr doesn't pool or
manage those sockets; aptkit's provider issues a `fetch`, and Node's HTTP
agent decides whether to keep-alive the underlying TCP connection.
Whatever connection reuse happens on boundary 2 is the runtime's default,
not a buffr decision. `not yet exercised`: any explicit HTTP agent /
keep-alive tuning by buffr.

**UDP: absent, and correctly so.** No `dgram`, no QUIC, no UDP anywhere.
Both workloads — a database query and an LLM request/response — need
ordered, reliable, complete delivery. TCP gives exactly that. UDP would
mean reimplementing ordering and retransmission for no benefit. `not yet
exercised` is the right state.

### Move 3 — the principle

**A connection pool moves the cost of a TCP connection from per-query to
per-session — and shifts the risk from latency to leaks.** The win is
free latency on every turn after the first. The new failure mode is
forgetting `release()`. buffr earns the win and accepts the risk with
explicit try/finally discipline at every manual lease.

## Primary diagram

The full connection story, both boundaries.

```
  Connections — pooled pg (warm) vs per-request HTTP

  ┌─ session.ts ─────────────────────────────────────────────┐
  │  pool = createPool(databaseUrl)  :39   (built ONCE)       │
  └───────┬───────────────────────────────────┬──────────────┘
          │ POOL: warm conns, per-SESSION      │ per-REQUEST conn
          │                                    │ (runtime keep-alive)
   ┌──────▼───────────────────┐         ┌──────▼─────────────┐
   │ pool.query()  → borrow/   │         │ aptkit fetch()     │
   │   return (search)         │         │   → Ollama         │
   │ pool.connect() → manual   │         │ HTTP over TCP 11434│
   │   lease + release()       │         └────────────────────┘
   │   (upsert txn)            │
   │       TCP 5432            │
   └───────────┬───────────────┘
               ▼
        Postgres reindb       │   pool closed once, at pool.end()
                              │   (chat.tsx /exit → session.close)
```

## Elaborate

The reason pooling is *the* networking decision here, not a footnote:
buffr's whole reason to exist is the long-lived `npm run chat` session
(project context: the one-shot `ask` was removed). A long-lived session is
exactly the workload where pooling pays off — dozens of turns, each
needing several queries (persist user msg, search, persist trace, persist
memory), all reusing the same handful of warm connections. The one-shot
CLIs (`index-cmd`, `eval-cmd`) build a pool, do their work, and call
`pool.end()` — they get the pool's batching-within-a-run benefit but not
the cross-turn warmth. Same primitive, different lifecycle, because the
session lives longer.

## Interview defense

**Q: "How does this app manage database connections?"**

> One `pg.Pool`, built once in `createChatSession` at `session.ts:39`, held
> for the entire chat session. Reads go through `pool.query()` which
> borrows and returns a warm connection in one call; the transactional
> upsert uses `pool.connect()` to lease one connection, runs
> begin/insert/commit on it, and releases it in a `finally`. The win is
> that connect+auth is paid once per session, not once per query.

```
  pool.query   → borrow/return (search, single stmt)
  pool.connect → lease + release() (upsert, transaction)
  built once @ session.ts:39 · closed @ pool.end()
```

Anchor: *"`client.release()` in the `finally` of `upsert()` — drop it and
the pool leaks until it deadlocks."*

**Q: "Why TCP and not UDP? Any UDP in the app?"**

> None, and that's correct. A DB query and an LLM response both need
> ordered, reliable, complete delivery — that's TCP's whole job. UDP would
> force you to reimplement ordering and retransmission for nothing.

Anchor: *"Both boundaries are TCP; `dgram`/QUIC are `not yet exercised`
and shouldn't be."*

## See also

- `02-dns-routing-and-addressing.md` — the IP the socket connects to.
- `04-tls-and-trust-establishment.md` — what wraps the pg TCP connection
  when `sslmode` asks for it.
- `07-timeouts-retries-pooling-and-backpressure.md` — the pool's untuned
  defaults and the missing timeouts around these sockets.
- `study-database-systems` — what happens inside Postgres once connected.
