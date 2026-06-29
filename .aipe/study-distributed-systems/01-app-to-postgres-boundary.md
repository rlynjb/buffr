# 01 — The app↔Postgres boundary

## Subtitle

The **client/server boundary** over a **connection pool** — *Industry
standard*. In buffr the client/server boundary is the `pg.Pool`
(`src/db.ts:4`); everything the process knows about its database, it knows
through that pool.

## Zoom out, then zoom in

This is the only place in buffr-laptop where the process talks to something it
doesn't control. Ollama is the other remote, but aptkit owns that client — buffr
just hands it a host string. The database boundary is buffr's own, and it's the
one seam where the distributed-systems questions actually bite.

```
  Zoom out — where the Postgres boundary lives

  ┌─ Client (one Node process) ───────────────────────────────┐
  │  chat.tsx → session.ts → ask()                            │
  │     │                                                      │
  │     ├── RagQueryAgent ── HTTP ──► Ollama  (aptkit's client)│
  │     │                                                      │
  │     └──►  ★ pg.Pool (src/db.ts) ★   ← we are here          │
  └─────────────────────────────────┬──────────────────────────┘
                                    │  pooled TCP connection
  ┌─ Storage layer ─────────────────▼──────────────────────────┐
  │  Postgres  reindb / schema agents                          │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **connection pool** — a bounded set of reusable TCP
connections to Postgres, handed out per query and returned after. The question
it answers in a distributed context: *what happens to a request when the thing
on the other side of this boundary is slow, busy, or gone?*

## Structure pass — layers, one axis, the seam

Three layers stack here. Trace **one axis — failure containment — down through
them** and watch where the answer flips.

```
  axis traced = "where does a slow/unavailable Postgres get contained?"

  ┌─ caller: session.ask() ───────────────┐   → NOT contained:
  │  await persistMessage(...)            │     awaits, surfaces a throw
  └───────────────────┬───────────────────┘
                      │  seam — the pool boundary
  ┌─ pool: pg.Pool (src/db.ts:4) ─────────┐   → NOT bounded:
  │  acquire a conn, run query, release   │     no acquire/connection timeout
  └───────────────────┬───────────────────┘
                      │  TCP
  ┌─ server: Postgres ────────────────────┐   → owns the real work;
  │  parse, plan, execute, return rows    │     can be slow or unreachable
  └────────────────────────────────────────┘

  the axis answer never flips to "contained" — nothing on the buffr side
  bounds the wait. that's the finding.
```

The **seam is the pool boundary** (`pg.Pool`). That's where you *could*
intercept: impose an acquire timeout, a connection timeout, a per-statement
deadline. Right now nothing does — the seam exists but carries no deadline
contract.

## How it works

### Move 1 — the mental model

A connection pool is the same shape as a `fetch()` you've written a hundred
times, with one twist: instead of opening a fresh connection per call (slow —
TCP + TLS + auth handshake every time), you keep a small set of warm
connections and lend one out per query. You already know the loading / success
/ error states of a `fetch()`; a pool adds a fourth state *before* loading:
**waiting for a free connection**. That fourth state is where the
distributed-systems risk lives.

```
  the pool kernel — four states per query

   query arrives
        │
        ▼
   ┌──────────────┐   free conn?
   │  acquire     │──── yes ──► run on conn ──► release back to pool
   └──────┬───────┘
          │ no free conn
          ▼
   ┌──────────────┐   waits until one frees up
   │  WAIT        │   ◄── no deadline here in buffr ──► can wait forever
   └──────────────┘
```

The kernel is: **a bounded set + an acquire step + a release step.** Strip the
bound and it's not a pool (you'd open unbounded connections and crush
Postgres). Strip the release and connections leak until the pool starves. The
WAIT state is implied by the bound — and **the deadline on that wait is the
optional hardening buffr hasn't added.**

### Move 2 — the walkthrough

**The pool is created bare.** Here's the entire database boundary
(`src/db.ts:1-7`):

```ts
import pg from 'pg';

/** A pg Pool for reindb. Callers load DATABASE_URL via dotenv before this. */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });   // ← only a conn string
}
```

Annotate the one load-bearing line: `new pg.Pool({ connectionString })` passes
*nothing else*. No `max` (defaults to 10), no `connectionTimeoutMillis` (so
acquiring a connection waits indefinitely if all 10 are busy), no
`statement_timeout` (so a runaway query runs until Postgres or the OS kills it),
no `idleTimeoutMillis`. The pool's behavior is entirely pg's defaults.

**Every query goes through this one pool.** The pool is created once in
`createChatSession` (`src/session.ts:39`) and threaded into the store, the
trace sink, and the bare `persistMessage` calls. Trace one request:

```
  Layers-and-hops — one ask() turn against the boundary

  ┌─ Client ─────────────┐                       ┌─ Storage ──────────┐
  │ session.ask()        │                       │ Postgres (agents)  │
  │                      │  hop 1: INSERT user    │                    │
  │ persistMessage ──────┼──────────────────────► │ messages row       │
  │                      │  hop 2: agent.answer()  │  (also hits Ollama │
  │ agent.answer() ──────┼── (HTTP to Ollama) ──── │   over HTTP)       │
  │                      │  hop 3: flush() inserts │                    │
  │ trace.flush() ───────┼──────────────────────► │ messages rows ×N   │
  │                      │  hop 4: memory.remember │                    │
  │ memory.remember() ───┼──────────────────────► │ chunks row (best-   │
  │  (try/catch)         │                         │  effort)           │
  └──────────────────────┘                       └────────────────────┘
```

Each hop borrows a connection from the pool, runs, releases. They're
*sequential within a turn* — `await` chains them (`src/session.ts:61-66`) — so
one turn never needs more than a couple of connections at once. That's *why*
the missing acquire timeout doesn't bite on one device: with one user, the pool
is never exhausted.

**The one deliberate failure classification.** Most of `ask()` lets errors
propagate — a failed `persistMessage` or `agent.answer` throws straight to the
CLI. The single exception is the memory write (`src/session.ts:65-69`):

```ts
try {
  await memory.remember({ conversationId, question, answer });
} catch {
  // swallow: memory is best-effort, the turn already succeeded
}
```

This is the only place buffr *classifies* a failure rather than surfacing it:
a memory-write failure must not lose the answer the user already holds. Every
other database failure is fail-fast-and-surface.

### Move 3 — the principle

A connection pool is a **bounded resource with an implicit WAIT state**, and the
distributed-systems discipline is to *put a deadline on every wait that crosses
a boundary you don't control.* buffr-laptop hasn't — and that's the right call
*today*, because one user never exhausts the pool, and a deadline you can't
test under load is a deadline you'll tune wrong. The principle to carry: the
deadline isn't missing because it was forgotten; it's missing because the
condition that makes it load-bearing (contention) doesn't exist yet. Add it
with the load that justifies it.

## Primary diagram

The full boundary, recapped — the seam, the missing deadline, the one
classified failure.

```
  The app↔Postgres boundary — the complete picture

  ┌─ Client: one Node process ─────────────────────────────────┐
  │                                                            │
  │  session.ask()                                             │
  │    ├─ persistMessage ─────┐                                │
  │    ├─ agent.answer ──┐    │   (errors here: SURFACE)       │
  │    ├─ trace.flush ───┤    │                                │
  │    └─ memory.remember┼────┤   (error here: SWALLOW, :65)   │
  │                      │    │                                │
  │              ┌───────▼────▼────────┐                       │
  │              │ pg.Pool (db.ts:4)   │  ← SEAM               │
  │              │ max=10 (default)    │    no acquire timeout │
  │              │ no statement_timeout│    no conn timeout    │
  │              └─────────┬───────────┘                       │
  └────────────────────────┼───────────────────────────────────┘
                           │ pooled TCP
  ┌─ Storage: Postgres reindb/agents ──▼───────────────────────┐
  │  documents · chunks · conversations · messages · profiles  │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Connection pooling exists because the per-connection handshake to Postgres
(TCP + auth, and over a network, TLS) costs more than most queries do; pooling
amortizes it. `pg`'s pool is a simple one — fixed max, FIFO-ish acquire — versus
something like PgBouncer that pools *server-side* across many clients. buffr
doesn't need PgBouncer: one client, one pool. The interesting boundary to read
next is what Postgres itself guarantees once a query lands — isolation,
durability, the HNSW index scan — which is `study-database-systems`. The
*shape* decision of "direct `pg` now, HTTP/Edge Functions later" is a
system-design call, walked in `study-system-design` and in the design spec
(direct-pg rationale, lines 54-64).

## Interview defense

**Q: Your database client has no timeout. Isn't that a bug?**

Verdict first: on one device, no — it's a deliberate fail-fast with the deadline
deferred to the load that justifies it. Here's the boundary:

```
  acquire → [WAIT: unbounded] → run → release
            ▲
            └─ the deadline goes HERE (connectionTimeoutMillis)
               + statement_timeout for the run step
```

The load-bearing part people forget: a pool has an *acquire* wait *before* the
query even starts. With one user and `max=10`, that wait is always zero — the
pool is never contended — so a `connectionTimeoutMillis` would only ever fire
on a real outage, where surfacing the error is already the behavior I want. The
day this crosses a network under concurrent load, two deadlines go in:
`connectionTimeoutMillis` on the acquire and `statement_timeout` on the run.
Anchor: `src/db.ts:4` — the pool is one line, and adding those two options is
the whole fix.

**Q: What's the one thing you'd watch as this scales?**

Pool exhaustion → the unbounded acquire WAIT turning into a hang. Today
sequential per-turn `await`s (`src/session.ts:61-66`) keep concurrency at ~1.
Under many concurrent turns, all 10 connections get borrowed and turn 11 waits
forever. Anchor: the WAIT state in the pool kernel diagram.

## See also

- `00-overview.md` — finding #1.
- `02-trace-sink-write-buffering.md` — the write path that fans across this
  boundary inside one `flush()`.
- `audit.md` — lens 2 (timeouts/retries), lens 1 (the map).
- `study-database-systems` — what Postgres guarantees once a query lands.
- `study-system-design` — why direct-`pg` over an HTTP gateway this phase.
