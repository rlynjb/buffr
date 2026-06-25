# App-to-Postgres Boundary

**Client/server boundary over a connection pool** · Industry standard

The only genuine "across a boundary" seam in buffr: a single Node process
talking to one Postgres over a `pg.Pool`. Every durable read and write crosses
this wire.

---

## Zoom out, then zoom in

Here's the whole thing. buffr is one process with one durable dependency, and
this one box — the pool between them — is where every distributed-systems
concern that *does* apply to this repo lives.

```
  Zoom out — where this boundary lives

  ┌─ Local process (one Node session) ──────────────────────┐
  │  src/session.ts (ChatSession, via cli/chat.tsx)         │
  │     RagQueryAgent → PgVectorStore.search                 │
  │     SupabaseTraceSink → persistMessage                   │
  └───────────────────────────┬─────────────────────────────┘
                              │  ★ THIS BOUNDARY ★  ← we are here
                              │  pg.Pool over TCP (node-postgres)
  ┌─ Network boundary ────────▼─────────────────────────────┐
  │  Postgres "reindb", schema agents (pgvector + HNSW)      │
  │  owns ALL durable state — the only source of truth      │
  └─────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **a connection pool fronting a remote datastore**.
`src/db.ts` is four lines — it hands back a `pg.Pool` and nothing else. But
that pool is doing the load-bearing distributed-systems work: it multiplexes
queries onto a bounded set of TCP connections, and it's the single point where
"the remote is unreachable" becomes a thrown promise. The question this pattern
answers: *what happens to a query when the thing on the other side of the wire
is slow, busy, or gone?*

---

## Structure pass

**Layers.** Three, top to bottom: the **call sites** (CLI + aptkit agent), the
**pool** (`pg.Pool`), and the **remote engine** (Postgres). The pool is the
seam between the other two.

**Axis — trace *failure containment* down the stack.** Hold one question:
*"when the remote is down, who notices and what do they do?"*

```
  One question down the layers: "remote is down — who handles it?"

  ┌─ call site (session.ts: ChatSession.ask) ─┐
  │  awaits the query; on reject → throws      │  → DOES NOT handle: propagates
  └───────────────────┬────────────────────────┘
                      │  the answer flips here
  ┌─ pg.Pool ─────────▼───────────────────┐
  │  acquires a connection or rejects      │  → DETECTS: surfaces the error
  └───────────────────┬───────────────────┘
                      │
  ┌─ Postgres ────────▼───────────────────┐
  │  the failure ORIGINATES here (or net)  │  → ORIGIN
  └────────────────────────────────────────┘
```

**Seam — the pool boundary is load-bearing because the failure-handling answer
flips across it.** Below the pool, failure *originates* (Postgres down, TCP
reset, pool exhausted). At the pool, failure is *detected and surfaced* as a
rejected promise. Above it, failure is *not contained at all* — it propagates
to a process exit. That flip is exactly what makes this a seam worth studying:
the contract the pool offers upward is "I give you a connection or I reject,"
and buffr's call sites accept that contract by doing nothing with the reject.

Now the mechanics hang on that skeleton.

---

## How it works

### Move 1 — the mental model

You already know `fetch()`: you call it, it might resolve with data or reject if
the network's down, and *you* decide whether to retry or show an error. A
connection pool in front of a database is the same shape — except instead of
opening a fresh connection per call (expensive: TCP + TLS + auth handshake every
time), it keeps a small set of warm connections and lends one out per query.

```
  Pattern — a pool lends warm connections, one per query

         query A ─┐
         query B ─┤      ┌─────────── pool (size N) ───────────┐
         query C ─┼────► │ [conn1] [conn2] ... [connN]         │
                  │      │  ▲ lend on acquire                  │
                  │      │  └ return on release                │
                  │      └──────────────┬──────────────────────┘
                  │   if all N busy ────┘  → queue & wait, or reject
                  ▼                          on timeout
              (more queries than
               connections → backpressure)
```

The kernel: **a bounded set of reusable connections + acquire/release +
a what-happens-when-empty policy.** That last part is the distributed-systems
part — it's where backpressure and partial failure show up.

### Move 2 — the walkthrough

**The pool is created once, used everywhere.** Bridge from a module-level
singleton you'd export from a `db.js` in any Node app: that's exactly what
`src/db.ts`'s `createPool` is. One pool per process, passed by reference into
`PgVectorStore`, `SupabaseTraceSink`, and the CLIs. What concretely happens: the
first `pool.query` lazily opens a real TCP connection; subsequent queries reuse
it. Where it breaks if you're not careful: open a pool per request (or per
chunk) instead of per process and you pay the handshake cost every time and can
exhaust Postgres's `max_connections`.

**A query acquires, runs, releases — implicitly or explicitly.**

```
  Layers-and-hops — one query crossing the boundary

  ┌─ Process ──────┐  hop 1: acquire conn   ┌─ pg.Pool ──────┐
  │  pool.query()  │ ─────────────────────► │  lend conn k   │
  │                │  hop 4: rows ◄───────── │                │
  └────────────────┘                        └───────┬────────┘
                                       hop 2 │ send SQL over TCP
                                             ▼
                                      ┌─ Postgres ─────┐
                                      │  execute, plan │
                                      │  hop 3: result │
                                      └────────────────┘
```

`pool.query(sql, params)` does acquire→run→release for you in one call — that's
the path `search` and `persistMessage` take. When you need *several* statements
on the *same* connection (a transaction), you `pool.connect()` to acquire
explicitly, then must `release()` in a `finally` — which is exactly what
`upsert` and `runMigration` do. Where it breaks: forget the `finally` release
and that connection leaks; do it N times and the pool is permanently empty and
every future query hangs.

**What happens when the remote is down — the failure path.** This is the whole
distributed-systems lesson of the file. There are three distinct failures and
buffr treats all three the same way (propagate):

```
  State — the three failure modes at this boundary

  ┌─────────────────┬──────────────────────────┬─────────────────┐
  │ failure         │ where it surfaces         │ buffr's response│
  ├─────────────────┼──────────────────────────┼─────────────────┤
  │ Postgres down   │ acquire rejects (ECONNREF)│ throw → exit    │
  │ query errors    │ query() rejects           │ throw → exit    │
  │ pool exhausted  │ acquire waits, then... ?   │ waits (no t/o)  │
  └─────────────────┴──────────────────────────┴─────────────────┘
```

For a single-user CLI, "throw and let the human re-run" is a *correct* policy,
not a missing feature. The one sharp edge is the third row: with no
`connectionTimeoutMillis` set, an exhausted pool makes `acquire` wait
indefinitely rather than failing fast — invisible today (one caller, never
exhausts), but the first thing to fix if buffr ever fronts concurrent callers.

### Move 2.5 — current state vs future state

This boundary is **shipped and active** in its current form (direct `pg`), but
the design explicitly names a future state: an HTTP layer (supabase-js / Edge
Functions) in front of the same SQL, arriving with the phone/multi-app phase.

```
  Comparison — direct pg now vs HTTP gateway later

  NOW (built)                        LATER (deferred, design spec)
  ┌────────────┐                     ┌────────────┐
  │ process    │                     │ process    │
  │  pg.Pool   │                     │  HTTP client│
  └─────┬──────┘                     └─────┬──────┘
        │ TCP, raw SQL                     │ HTTPS, JWT(app_id)
        ▼                                  ▼
  ┌────────────┐                     ┌────────────┐
  │ Postgres   │                     │ Edge Fn    │ ← new hop, new failure domain
  └────────────┘                     │  → Postgres│
                                     └────────────┘
  one client, no auth hop            many clients, auth + RLS at the edge
```

The takeaway is *what doesn't have to change*: `PgVectorStore` implements
aptkit's `VectorStore` contract, so swapping the transport underneath it
(direct pg → HTTP) is a store-implementation change, not an agent change. The
design spec is explicit that adding the HTTP hop now "would add PostgREST
indirection and latency for the only client that exists" — YAGNI, deferred on
purpose.

### Move 3 — the principle

A connection pool is the cheapest way to turn "talk to a remote datastore" into
a bounded, reusable resource — and the place where *every* remote-failure
question for a single-client system collapses to one decision: **propagate or
absorb.** buffr chose propagate, and for one human at a CLI that's right. The
moment a second concurrent caller exists, the same pool needs a timeout and a
retry policy, because "wait forever" stops being acceptable when the waiter
isn't a person who can just re-run.

---

## Primary diagram

The full recap: one process, one pool, three failure modes, all propagated.

```
  App-to-Postgres boundary — the complete picture

  ┌─ Process (one session / CLI run) ───────────────────────────┐
  │  session.ts ─► PgVectorStore.search ─┐                       │
  │            ─► SupabaseTraceSink ─────┤ all share ONE pool    │
  │            ─► runMigration ──────────┘                       │
  └────────────────────────────┬────────────────────────────────┘
                              acquire │ release (finally)
  ┌─ pg.Pool (src/db.ts) ──────▼────────────────────────────────┐
  │  bounded warm connections · lends one per query             │
  │  rejects on: Postgres down · query error · (waits if empty) │
  └────────────────────────────┬────────────────────────────────┘
                       SQL over │ TCP (Network boundary)
  ┌─ Postgres reindb ──────────▼────────────────────────────────┐
  │  schema agents · owns all durable state · pgvector + HNSW   │
  └─────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Every durable operation in buffr reaches for this pool: indexing
a corpus (`index` CLI → `indexDocumentRow` + `upsert`), answering a question
(`chat` CLI → `ChatSession.ask` → `search` + trace writes), running migrations
(`migrate`), and loading the profile (`profile.ts`). One pool per process — held
warm across every turn of a chat session and closed only on `session.close()` —
passed by reference to all of them.

**The pool factory — `src/db.ts` (lines 1-6).**

```
  import pg from 'pg';

  export function createPool(databaseUrl: string): pg.Pool {
    return new pg.Pool({ connectionString: databaseUrl });
  }
       │
       └─ the entire client/server boundary is this one object.
          No connectionTimeoutMillis, no max override → node-postgres
          defaults (max 10, no acquire timeout). That "no acquire
          timeout" is the load-bearing omission: an exhausted pool
          waits forever instead of failing fast.
```

**The acquire/run/release path with a transaction — `src/pg-vector-store.ts`
(lines 40-64).**

```
  const client = await this.pool.connect();   ← hop 1: acquire a connection
  try {
    await client.query('begin');              ← all upserts on THIS one conn
    for (const c of chunks) {
      await client.query(`insert ... on conflict (id) do update ...`, [...]);
    }
    await client.query('commit');             ← atomic: all chunks or none
  } catch (err) {
    await client.query('rollback');           ← failure → undo the batch
    throw err;                                 ← then propagate (no retry)
  } finally {
    client.release();                          ← MUST run, or the conn leaks
  }
       │
       └─ connect() (not pool.query) because a transaction needs the same
          physical connection for begin → inserts → commit. The finally
          release is load-bearing: drop it and N failures drain the pool
          permanently. Note the transaction is LOCAL to one Postgres conn —
          not distributed. See .aipe/study-database-systems/ for the
          isolation/atomicity walk.
```

**The implicit-acquire path — `src/supabase-trace-sink.ts` (lines 13-19).**

```
  await pool.query(
    `insert into agents.messages (...) values ($1,$2,$3,$4,$5)`, [...]);
       │
       └─ pool.query() does acquire→run→release in one call. Fine for a
          single statement. If this rejects (Postgres down), the promise
          lands in the sink's pending[] and surfaces at flush() — see
          02-trace-sink-write-buffering.md for why that timing matters.
```

---

## Elaborate

Connection pooling is one of the oldest patterns in client/server computing —
it exists because the TCP+auth handshake to a database is expensive relative to
a query, so you amortize it across many queries. The distributed-systems angle
is narrow but real: the pool is the chokepoint where a remote dependency's
health becomes your process's problem, and the pool's *empty-policy*
(`connectionTimeoutMillis`, `max`) is a backpressure knob. In a server you tune
it; in a CLI you can ignore it because there's one caller.

What to read next: `02-trace-sink-write-buffering.md` for the one place buffr
issues writes it *doesn't* immediately await, and `audit.md` Lens 2 for why
fail-fast (no retry) is the deliberate, correct choice here. For what happens
*inside* Postgres once the SQL crosses the wire — planning, the HNSW index, MVCC
— that's `.aipe/study-database-systems/`.

---

## Interview defense

**Q: "buffr talks to Postgres over a pool with no timeout and no retries. Isn't
that fragile?"**

```
  who-handles-failure across the boundary

  call site ──throws──► process exit
      ▲
      │ no retry, no timeout
  pg.Pool ──rejects──► (propagated up)
      ▲
  Postgres / network (origin)
```

It's deliberate, and for a single-user CLI it's correct. There's one human
caller who can re-run on failure, so a retry loop would only hide a problem the
user can see directly. The one defect I'd own: with no `connectionTimeoutMillis`,
an exhausted pool waits forever rather than failing fast — invisible with one
caller, but the *first* thing I'd change before this fronts concurrent traffic,
because "wait forever" stops being acceptable when the waiter isn't a person.

*Anchor: `src/db.ts` is the whole boundary; the fix is one option on the Pool.*

**Q: "Where's the distributed transaction?"**

There isn't one, and there shouldn't be. The transactions in `upsert` and
`runMigration` are local to a single Postgres connection (`begin`/`commit` on
one `client`). Nothing spans two services. Reaching for 2PC or a saga here would
be cargo-culting — there's no second resource manager to coordinate with.

*Anchor: `pg-vector-store.ts:42-58` — one connection, one transaction, no second participant.*

---

## Validate

1. **Reconstruct.** Draw the boundary from memory: process → pool → Postgres,
   and name the three failure modes (down / query error / exhausted) and buffr's
   response to each.
2. **Explain.** Why does `upsert` use `pool.connect()` while `persistMessage`
   uses `pool.query()`? (Transaction needs one physical connection across
   multiple statements; a single insert doesn't.) Cite `pg-vector-store.ts:40`
   vs `supabase-trace-sink.ts:27`.
3. **Apply.** A second concurrent caller appears. Walk what breaks first
   (pool exhaustion with no acquire timeout → indefinite wait) and the
   one-line fix (`connectionTimeoutMillis` on `src/db.ts:4`).
4. **Defend.** Argue why no retry logic is the right call today, then name the
   exact condition that flips the decision (concurrent callers / a server
   front-end / the deferred HTTP gateway).

---

## See also

- `02-trace-sink-write-buffering.md` — the writes that cross this boundary
  *without* being immediately awaited.
- `03-deferred-two-brain-shared-memory.md` — what this boundary becomes when a
  second writer shares the datastore.
- `audit.md` — Lens 1 (coordination map), Lens 2 (partial failure), Lens 8
  (local vs distributed transactions).

---

Updated: 2026-06-24 — entry point `ask-cmd.ts` (deleted) → `session.ts`
(`ChatSession`, via `cli/chat.tsx`); the pool is now held warm across a
long-lived chat session and closed on `session.close()` (still one pool per
process). `persistMessage` `pool.query` anchor `:14` → `:27`. The boundary,
failure semantics, and fail-fast verdict are unchanged.
- `.aipe/study-database-systems/` — what happens *inside* Postgres past this
  boundary (transactions, isolation, HNSW).
- `.aipe/study-system-design/` — the local-first architecture this boundary sits in.
