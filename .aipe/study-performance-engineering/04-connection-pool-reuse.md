# Connection Pool Reuse — one warm pool across a whole session

**Industry name(s):** connection pooling; connection reuse / warm pool. **Type:** Industry standard.

This is the finding that's a *win*, not a cost. buffr builds one connection pool and keeps it warm across an entire chat session, so no turn pays connection-setup latency. It's the right call, and worth understanding *why* it's right — and, as of a recent fix, the file now also covers the other half of a pool's lifecycle: what happens when it *doesn't* shut down cleanly, and how buffr bounded that.

## Zoom out, then zoom in

Every database touch in a turn — persist the user message, search the HNSW index, write the trace, remember the exchange — needs a Postgres connection. Opening a fresh TCP+TLS+auth connection per query is expensive. A pool keeps a few open and hands them out.

```
  Zoom out — where the pool lives

  ┌─ Session layer ──────────────────────────────────────────────┐
  │  src/session.ts:399  createPool(databaseUrl)  ← ONCE per session│ ← we are here
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
  │  session end: close() → pool.end() (bounded)  ← :876          │
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

Deliberately minimal — pg's defaults (max 10 connections, idle timeout) are fine for one user. It's called exactly once per session at `src/session.ts:399`, and the resulting pool is injected into *every* DB-touching component: the vector store (`:409`), the trace sink (`:564`), `persistMessage`, `startConversation`, `loadProfile`, and memory. One pool, shared — and now, transitively, into the `PgJournalStore` too (`src/pg-journal-store.ts`), the newest DB-touching component to join the same warm pool rather than opening its own.

**Reuse — across every turn.** The session holds the pool for the conversation's whole life. Look at where the pool is *not* re-created: `ask()` (`src/session.ts:668-689`) runs persist → answer → flush → remember, and every one of those borrows from the same warm pool. No turn pays connection setup.

```
  layers-and-hops — one pool, many borrowers, one warm channel

  ┌─ Session (src/session.ts) ───────────────────────────────────┐
  │  pool ──┬─► PgVectorStore.search   (HNSW query)               │
  │         ├─► PgVectorStore.upsert   (pool.connect → borrow)    │
  │         ├─► SupabaseTraceSink      (trace INSERTs)            │
  │         ├─► persistMessage         (user/turn INSERTs)        │
  │         └─► PgJournalStore         (decisions INSERT/UPDATE)  │
  └───────────────────────────┬───────────────────────────────────┘
                              │  borrow / release (no re-connect)
  ┌─ Postgres ────────────────▼───────────────────────────────────┐
  │  warm connections, reused turn after turn                     │
  └───────────────────────────────────────────────────────────────┘
```

**Borrow semantics — two styles, both correct.** Two ways the pool gets used, and the distinction matters:
- `pool.query(...)` (e.g. `search` at `src/pg-vector-store.ts:70`, and every method on `PgJournalStore` — `create`, `listDue`, `snooze`, `resolve`, all single-statement `pool.query` calls with no `begin`/`commit`) — borrow, run one query, auto-release. Right for a single statement.
- `pool.connect()` → `client.query(...)` → `client.release()` (e.g. `upsert` at `src/pg-vector-store.ts:40-64`) — pin one connection for a multi-statement transaction, release in `finally`. Right when `begin`/`commit` must run on the *same* connection. **The load-bearing part people forget:** a transaction's statements must all run on one connection — `pool.query` for `begin` then `pool.query` for the INSERT could land on *different* pooled connections and silently break the transaction. `upsert` correctly uses `connect()` for exactly this reason.

**Shutdown — bounded, not just once.** `close()` (`src/session.ts:876-881`) calls `pool.end()` — but not bare anymore:

```ts
async close(): Promise<void> {
  await Promise.race([
    pool.end(),
    new Promise<void>(resolve => setTimeout(resolve, 1000)),
  ]);
}
```

This is new evidence, and it's a real bug-fix, not a style choice. `pool.end()` waits for every checked-out client to finish and every in-flight query to settle before resolving. If a connection was ever left half-open — a query hung, a network blip, a client that never called `release()` — `pool.end()` could hang forever, and the whole CLI process would freeze on `/exit`. `64f822f` ("fix(chat): prevent freeze on exit") raced `pool.end()` against a **1-second timeout** so shutdown is bounded no matter what state the pool is in: drain if you can, but don't wait past the deadline.

**Two more layers on top, because one deadline didn't fully fix it.** The next commit (`9c1b1e6`, "Ctrl+C exits reliably") found that `pool.end()`'s 1s race wasn't the only way exit could hang — OpenTUI's renderer runs in raw terminal mode with `exitOnCtrlC: false`, so `Ctrl+C` never reaches Node's `SIGINT` handler at all; it's captured as raw bytes by the TUI's own keyboard layer. Two fixes landed together:

- **Explicit Ctrl+C handling inside `useKeyboard`** (`src/cli/chat.tsx:380-383`) — since `SIGINT` isn't reliably delivered, Ctrl+C is caught as a key event and routed to the same exit path as `/exit`, instead of depending on the OS signal.
- **A hard deadline independent of the pool race** (`forceExit`, `src/cli/chat.tsx:464-466`):

```ts
const forceExit = () => {
  setTimeout(() => process.exit(0), 1500).unref();  // hard ceiling, unref'd
  session.close().finally(() => process.exit(0));    // best-effort clean path
};
process.on('SIGINT', forceExit);
```

Two independent timers now guard the same exit: `close()`'s internal 1s race against `pool.end()`, and `forceExit`'s outer 1.5s `setTimeout` that fires `process.exit(0)` regardless of whether `close()` ever resolves. Named by what breaks if each is missing: drop the inner race and one hung connection blocks `pool.end()` forever; drop the outer deadline and a hang *anywhere else* in `close()` — not just the pool — still freezes the process. `.unref()` matters too: an unref'd timer doesn't itself keep the event loop alive, so the process can still exit early via the clean path without waiting out the full 1.5s.

**Does it matter at laptop scale?** This isn't a throughput or latency finding — it's an availability one. A pool that can hang on shutdown means every session risks becoming a process you have to `kill -9`. The fix costs nothing on the happy path (the race and the deadline both no-op if `pool.end()` resolves fast, which it does almost always) and buys a hard upper bound on exit latency (1.5s) on the unhappy path. That's the right shape for a teardown path: optimize for "usually instant," bound the worst case explicitly.

### Move 3 — the principle

Decouple connection lifetime from query lifetime and the setup cost amortizes to near zero. This is the unambiguous win in buffr's performance story — the right pattern, applied correctly, including the subtle `connect()`-for-transactions detail. The general lesson: any expensive-to-create, reusable resource (DB connections, HTTP keep-alive sockets, model handles) wants a pool whose lifetime tracks the *session*, not the *operation* — and the lifecycle isn't done until teardown is also bounded. A pool that amortizes setup cost perfectly but can hang indefinitely on `end()` has only solved half the lifecycle problem; the other half is a worst-case deadline on shutdown, which is exactly what the two timeout layers add here.

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
  session end ──► close()  src/session.ts:876  [bounded teardown]
                    │
                    ├─ pool.end() races a 1s timeout   (src/session.ts:878-879)
                    └─ forceExit() adds a 1.5s hard deadline + Ctrl+C handling
                       (src/cli/chat.tsx:380-383, :464-466)
```

## Elaborate

Connection pooling is one of the oldest database-performance patterns precisely because connection setup (TCP, optional TLS, auth, backend process fork on Postgres) is genuinely expensive — often more than a simple query itself. buffr's choice to hold the pool across the session, rather than the one-shot CLIs' pattern of create-pool / do-work / `pool.end()` (see `index-cmd.ts:17` then `:27`, `eval-cmd.ts:13` then `:34`), is exactly right for a long-lived chat: the CLIs are short-lived so they tear down immediately; the session is long-lived so it keeps the pool warm. Two different lifecycles, both matched to their workload.

For the transport mechanics under a connection — the TCP handshake, what auth costs, keep-alive — see **`study-networking`**. For what happens inside Postgres when a connection is established (backend process, session state), see **`study-database-systems`**. This file owns the *amortization* read; the bounded-shutdown addition is the *availability* half of the same lifecycle story — for the terminal-raw-mode reason `SIGINT` doesn't reach Node directly, see **`study-frontend-engineering`** (OpenTUI / terminal input handling) or **`study-debugging-observability`** for the "process won't exit" failure-mode class more generally.

## Interview defense

**Q: How do you manage database connections across a chat session?**

> One `pg.Pool`, created once at session start and shared by every DB-touching component — the vector store, the trace sink, message persistence, memory. Every turn borrows from the warm pool and releases back, so no turn pays connection setup. The one-shot CLIs use a different lifecycle — create, work, end immediately — because they're short-lived; the chat session keeps it warm because it isn't.

```
  setup cost paid ONCE at session start, not per query
  borrow ─query─ release × every turn, same warm connections
```

**Q: Any subtlety in how you use the pool?**

> Yes — transactions. For single statements I use `pool.query`, which borrows and auto-releases. But the upsert runs `begin`/INSERTs/`commit`, and those must all land on the *same* connection — so it uses `pool.connect()` to pin one client and releases it in a `finally`. If I'd used `pool.query` for each, `begin` and the INSERT could hit different pooled connections and the transaction would silently not be a transaction.

**Q: What happens when the session ends — does teardown ever get you in trouble?**

> It did, and I fixed it. `pool.end()` waits for every checked-out connection to settle, and if one was ever left in a bad state, that wait could hang forever — the whole CLI would freeze on `/exit` instead of returning to the shell. The fix is two independent timeouts: `close()` races `pool.end()` against a 1-second timer, and the exit handler adds its own 1.5-second hard deadline that calls `process.exit(0)` no matter what `close()` is doing. I also had to catch Ctrl+C explicitly inside the TUI's keyboard handler, because the terminal renderer runs in raw mode and `SIGINT` doesn't reliably reach Node — the OS signal path and the app's own input path aren't the same thing once you're in raw mode.

```
  teardown, bounded two ways
  close():    pool.end()  races  1s timeout     (src/session.ts:876-881)
  forceExit(): session.close()  races  1.5s hard deadline, unref'd
                                                  (src/cli/chat.tsx:464-466)
  happy path: both no-op, exit is instant
  unhappy path: worst-case exit latency is capped at 1.5s, not unbounded
```

> Anchor: `src/session.ts:399` (pool created once), `src/session.ts:876-881` (bounded `close()`), `src/cli/chat.tsx:380-383` (Ctrl+C caught in `useKeyboard`), `src/cli/chat.tsx:464-466` (`forceExit`'s hard deadline), `src/pg-vector-store.ts:40-64` (`connect()` for the txn).

## See also

- `00-overview.md` — the warm pool in the system frame
- `audit.md` — lens 5 (I/O bottlenecks), lens 8 (red flags)
- `03-per-chunk-insert-loop.md` — the transaction that borrows via `connect()`
- `05-per-turn-memory-and-trace-cost.md` — the per-turn writes that share this pool
- `07-connector-fan-out.md` — another place a bounded wait matters: `Promise.all` over connector fetches has no per-source timeout today
- **`study-networking`** — connection setup cost, keep-alive
- **`study-database-systems`** — what a Postgres connection costs server-side
- **`study-frontend-engineering`** — OpenTUI raw-mode input handling, why `SIGINT` needed a TUI-layer fallback
