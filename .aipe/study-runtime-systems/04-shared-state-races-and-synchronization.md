# 04 · Shared State, Races, and Synchronization

**The pool as shared state, transactions, and `--test-concurrency=1`** · *Industry standard*

---

## Zoom out, then zoom in

The single thread (`02`) means buffr has *no* JS-level data races — two
functions never mutate the same object simultaneously, because two functions
never run simultaneously. So where does synchronization live here? Two places:
**Postgres transactions** (the database is the shared state, and `begin/commit`
is the lock), and **`--test-concurrency=1`** (the test runner serializes file
execution so they don't trample a shared database).

```
  Zoom out — where synchronization actually lives

  ┌─ JS runtime ─────────────────────────────────────────────────┐
  │  single thread → NO data races on JS objects (free win)       │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ but state is shared HERE:
  ┌─ Shared resource layer ───────▼──────────────────────────────┐
  │  ★ ONE pg.Pool ★  ·  borrowed by store, agent, trace sink     │ ← here
  └───────────────────────────────┬───────────────────────────────┘
                                  │ real concurrency control:
  ┌─ Storage layer ───────────────▼──────────────────────────────┐
  │  Postgres: begin/commit transaction = the lock + atomicity    │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **shared mutable state and the mechanisms that make
concurrent access safe**. buffr's shared state is the pool and the database;
its synchronization is transactions plus a test-runner serialization flag.

---

## Structure pass

**Layers, by "what's shared and what guards it":**

```
  Layer            Shared thing            Guard
  ───────────────  ──────────────────────  ──────────────────────────
  JS objects       nothing concurrent      single thread (no guard needed)
  pg.Pool          connection handles      pool internal queue (built-in)
  Postgres rows    chunks / messages       transactions (begin/commit)
  test database    one real reindb         --test-concurrency=1 (serialize files)
```

**Axis traced — "who can touch this at the same time, and is that safe?"**

```
  "is concurrent access to this safe?"

  ┌──────────────────────────────────────────────┐
  │ JS object  → only one toucher ever (1 thread) │  trivially safe
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ pg.Pool    → many awaits share it; pool   │  ← safe: pool queues
      │              hands out distinct clients    │     checkouts internally
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ DB rows    → concurrent writers exist;│  ← safe ONLY inside a
          │              transaction makes N writes│     transaction
          │              atomic                    │
          └──────────────────────────────────────┘
              ┌──────────────────────────────────┐
              │ test DB    → parallel test files  │  UNSAFE without the flag
              │              would race deletes    │  → serialized to 1
              └──────────────────────────────────┘
```

The answer flips from "trivially safe" at the JS layer to "unsafe without
explicit serialization" at the test-database layer. The repo's two real
synchronization decisions sit at the bottom two rows.

**Seams:**

- **`pool.query` ↔ `pool.connect`.** A direct `pool.query` borrows a client for
  one statement and returns it — fine for a single read. `pool.connect` borrows
  a *dedicated* client you hold across multiple statements — required when those
  statements must share a transaction. The seam is "do these statements need to
  be atomic together?"
- **parallel test files ↔ shared database.** `--test-concurrency=1` is the lock
  that makes this seam safe.

---

## How it works

### Move 1 — the mental model

You know how `useState` is safe in React because only the main thread ever sets
it — no two handlers fight over it? buffr's JS state is the same: one thread,
no contention. The contention that *does* exist is at the database, and a
transaction is the tool that says "these writes happen all-or-nothing, and no
one sees a half-finished version."

```
  Transaction as the unit of atomicity — the shape

   begin ──► write chunk 1 ──► write chunk 2 ──► ... ──► commit
     │                                                     │
     └──── if ANY write throws ──► rollback ──────────────┘
            (nobody ever sees a partial batch)

   the begin/commit pair is the lock + the all-or-nothing guarantee
```

### Move 2 — the synchronization mechanisms, one at a time

**The pool is shared, and that's by design.** `createPool` (`db.ts:4`) makes one
`pg.Pool`. That single pool is passed into `PgVectorStore`, the trace sink,
`indexDocumentRow`, `loadProfile` — everyone shares it. In `chat` it's shared
across an extra dimension too: not just across borrowers *within* one run but
across *every turn* of the session — `createChatSession` builds it once
(`session.ts:39`) and every `ask()` reuses it. This is safe because the pool
*itself* manages concurrent access: each `query`/`connect` checks out a distinct
underlying client from its internal pool, and queues the request if none is free.
You never see two callers on the same socket. → see `06` for the checkout/release
lifecycle.

```
  One pool, many borrowers — the pool's internal queue

  store.search ──┐
  trace write 1 ─┼──► pg.Pool ──► [client A][client B][client C]
  trace write 2 ─┘       │              (handed out, one per checkout)
                         └─ if all busy, the request waits in line
```

**Transactions in `upsert` — multi-statement atomicity.** When indexing, a
document's chunks must all land or none — a half-indexed document gives the
retriever a corrupt corpus. `PgVectorStore.upsert` (`pg-vector-store.ts:38`)
checks out *one* dedicated client, runs `begin`, loops the inserts, `commit`s,
and on any throw `rollback`s in the `catch`. The dedicated client is mandatory:
a transaction lives on a single connection, so you can't `begin` on one pooled
client and `insert` on another.

```
  upsert's transaction — atomic batch on one borrowed client

  pool.connect ──► client ──► begin ──► insert ×N ──► commit ──► release
                                 │                         ▲
                                 └── catch → rollback ─────┘
                                            (release still runs, finally)
```

**`runMigration` — the same shape, one SQL blob.** `migrate.ts:8` does the
identical begin/try/commit/catch-rollback/finally-release dance, wrapping the
whole schema script in one transaction so a failed migration leaves the schema
untouched.

**`--test-concurrency=1` — serializing the shared test database.** This is the
repo's clearest synchronization decision and it's not in the code — it's in
`package.json`. The integration tests all point at one real `reindb`, and
`supabase-trace-sink.test.ts:18` runs `delete from agents.conversations` in a
`beforeEach`. If `node --test` ran files in parallel (its default), file A's
`delete` could fire while file B's `insert` is mid-flight — a classic
shared-resource race producing flaky, order-dependent failures. Forcing
concurrency to 1 makes the test files run strictly one after another.

```
  Why --test-concurrency=1 — the race it prevents

  WITHOUT (parallel):           WITH (serial):
  fileA: delete ──┐             fileA: delete → insert → assert ✓
  fileB: insert ──┴► RACE       fileB:                    delete → insert ✓
         assert ✗ (flaky)              one file fully finishes before next
```

The kernel here: **the test runner's concurrency level is a lock on the shared
database.** Drop the flag (or raise it) and the tests share state unsafely. The
trade is wall-clock speed for determinism — the right call when correctness of a
shared resource is the point. → `study-testing` owns the testing strategy; this
file owns only the runtime-synchronization reason for the flag.

### Move 3 — the principle

**Single-threaded JS gives you race-freedom for free *inside* the process; the
races live wherever state is genuinely shared across concurrent actors — the
database and the parallel test runner.** Reach for transactions when multiple
writes must be atomic, and serialize when independent actors share one mutable
resource. The synchronization isn't in your JS objects; it's at the boundaries
where real concurrency leaks in.

---

## Primary diagram

```
  Shared state and its guards — full picture

  ┌─ JS thread (one) ─────────────────────────────────────────────┐
  │  no shared mutable JS state across concurrent code → no locks  │
  └───────────────────────────┬───────────────────────────────────┘
                              │ shares one resource ▼
  ┌─ pg.Pool (shared handle) ─────────────────────────────────────┐
  │  internal queue hands out distinct clients, one per checkout   │
  │   search → pool.query (1 stmt, autocommit)                     │
  │   upsert → pool.connect → begin … commit (atomic batch)        │
  └───────────────────────────┬───────────────────────────────────┘
                              │ writes land in ▼
  ┌─ Postgres (shared state) ─────────────────────────────────────┐
  │  transactions = atomicity + isolation between writers          │
  └───────────────────────────────────────────────────────────────┘

  Test runtime:  node --test --test-concurrency=1
                 serializes test FILES so they don't race the one reindb
```

---

## Implementation in codebase

**Use cases.** Atomicity is reached for twice — batch chunk upsert and schema
migration. Serialization is reached for once — the integration test suite
against a shared database.

**The transaction guard** (`src/pg-vector-store.ts`, lines 40–64):

```
  src/pg-vector-store.ts  (lines 40–64)

  const client = await this.pool.connect();   ← borrow ONE dedicated client
  try {
    await client.query('begin');              ← open the transaction (the lock)
    for (const c of chunks) {
      await client.query(`insert into agents.chunks ... on conflict ...`);
    }                                          ← N writes, all on the same client
    await client.query('commit');             ← all-or-nothing: make them visible
  } catch (err) {
    await client.query('rollback');           ← any throw → undo the whole batch
    throw err;
  } finally {
    client.release();                          ← return the client to the pool ALWAYS
  }
       │
       └─ pool.connect (not pool.query) is load-bearing: a transaction lives on
          ONE connection. begin on client X then insert on client Y would split
          the transaction across connections and the begin would do nothing.
          assertDim runs BEFORE this block (line 39) so a bad vector never even
          opens a transaction.
```

**The serialization flag** (`package.json`, test script):

```
  package.json  (scripts.test)

  "test": "npm run build && node --test --test-concurrency=1 dist/test/*.test.js"
                                          ▲
                                          └─ runs test FILES one at a time.
       │
       └─ the integration tests share one real reindb and delete rows in
          beforeEach (supabase-trace-sink.test.ts:18). Concurrency 1 is the
          lock that stops file A's delete racing file B's insert. Remove it and
          the suite goes flaky and order-dependent.
```

---

## Elaborate

"Single-threaded means no locks in your code" is Node's biggest ergonomic win
over thread-per-request servers (Java, Go) where you reason about mutexes,
visibility, and memory ordering constantly. The cost is that all your real
concurrency control is pushed to the boundary — the database — where you use the
database's tools (transactions, isolation levels, row locks) instead.

Transaction isolation levels (read-committed, repeatable-read, serializable) are
the database-layer answer to "what can concurrent transactions see of each
other." buffr uses Postgres defaults (read-committed) and never sets an
isolation level — *not yet exercised*, and fine for single-user laptop use where
concurrent writers are rare. `study-database-systems` owns the deep treatment of
isolation; this file owns only the runtime fact that transactions are buffr's
synchronization primitive.

**Not yet exercised:** explicit locks, atomics, `SharedArrayBuffer`, channels,
or any in-process synchronization primitive. There's nothing to synchronize
in-process because the thread count is one.

---

## Interview defense

**Q: buffr is single-threaded. Does it have race conditions?**

```
  where races can and can't happen

  in-process JS  →  one thread  →  NO race (free)
  the pg.Pool    →  pool queues checkouts  →  NO race (built-in)
  DB rows        →  concurrent writers possible  →  race UNLESS in a transaction
  test database  →  parallel files  →  RACE unless --test-concurrency=1
```

Not in the JS — one thread can't race itself. The real concurrency is at the
database (guarded by transactions) and in the test runner (guarded by forcing
concurrency to 1). *Anchor:* single-threaded kills in-process races but pushes
them to wherever state is genuinely shared.

**Q: Why does `upsert` use `pool.connect` but `search` uses `pool.query`?**
`upsert` runs many inserts that must be one atomic transaction — a transaction
lives on a single connection, so you need a dedicated client you hold across all
of them. `search` is one statement; `pool.query` checks out, runs, and returns a
client in one shot — no transaction needed. *Anchor:* `connect` when statements
must share a transaction; `query` when one statement stands alone.

---

## Validate

1. **Reconstruct:** draw the begin/insert×N/commit/rollback/release skeleton from
   `upsert` and name what breaks if you swap `pool.connect` for `pool.query`.
2. **Explain:** why does `--test-concurrency=1` exist? Trace the exact race in
   `supabase-trace-sink.test.ts:18` it prevents.
3. **Apply:** you add a `reindex` command that deletes a document's chunks then
   re-inserts them. Should that be one transaction? Which pool method?
4. **Defend:** argue why buffr has zero in-process locks and why that's correct,
   not a gap — then name the one change (local embedding via workers) that would
   reintroduce in-process shared state.

---

## See also

- `02-processes-threads-and-tasks.md` — why one thread = no JS-level races
- `06-filesystem-streams-and-resource-lifecycle.md` — the client checkout/release lifecycle
- `study-database-systems` — transaction isolation levels (neighbor guide)
- `study-testing` — the testing strategy behind the concurrency flag (neighbor guide)

---

Updated: 2026-06-24 — noted the pool is now shared across every chat turn (built once in `session.ts:39`, reused per `ask()`), not just across borrowers within one run; transaction + test-concurrency findings unchanged.
