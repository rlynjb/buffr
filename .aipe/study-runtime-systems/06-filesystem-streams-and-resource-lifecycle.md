# Filesystem, Streams, and Resource Lifecycle — handles, descriptors, and cleanup

**Industry name(s):** resource acquisition / release, the connection pool, descriptor lifecycle, RAII / try-finally cleanup, the TTY in raw mode · *Industry standard*

---

## Zoom out, then zoom in

Every long-lived handle the OS hands your process — a file descriptor, a socket, a TTY — has to be given back, or it leaks. This repo holds three kinds: **file reads** (load a `.md`, load the SQL), **pooled Postgres connections** (the `pgPool`, the real lifecycle story), and the **raw-mode TTY** in chat. The discipline that ties them together is `try/finally` and `pool.end()`.

```
  Zoom out — the handles the process holds

  ┌─ Interface layer ────────────────────────────────────────┐
  │  readFile(.md / .sql)   ·   ★ raw-mode TTY stdin (Ink) ★ │ ← chat
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Runtime layer ──────────▼───────────────────────────────┐
  │  ★ the connection pool (`pgPool`) — checkout/release ★   │ ← the deep one
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Storage layer ──────────▼───────────────────────────────┐
  │  Postgres sockets — born at first query, die at pool.end │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: a "resource" here is anything you acquire and must release. The interesting one isn't files (read fully into memory, no streaming, nothing to leak) — it's the **pool**, where one checked-out connection that isn't released starves every future query.

---

## The structure pass

**Layers.** File handles (transient, fully managed by `readFile`) → the connection pool (the resource with real acquire/release semantics) → individual pooled connections (the leaf, checked out per transaction) → the TTY (acquired by Ink, released on exit).

**Axis — trace `failure`: if this resource isn't released, what breaks?**

```
  One axis, the resources: "what breaks if I forget to release this?"

  ┌─ file handle (readFile) ────────┐  nothing — readFile opens+closes
  │  no leak surface                 │  internally; fully buffered
  └──────────────────────────────────┘
      ┌─ pooled connection ─────────┐  THE leak surface — forget release()
      │  must client.release()       │  and one of 10 pool slots is gone
      └──────────────────────────────┘     forever; pool starves
          ┌─ the pool itself ───────┐  forget pool.end() → batch CLI HANGS
          │  must pool.end()         │  (idle sockets keep the loop alive)
          └──────────────────────────┘
              ┌─ raw-mode TTY ──────┐  Ink owns acquire+release; skip exit()
              │  exit() restores it  │  (Ctrl-C) → terminal can be left raw
              └──────────────────────┘
```

The `failure` answer flips hard at the pooled-connection layer: files can't leak, but a missing `release()` permanently removes a connection from circulation.

**Seam — `pool.connect()` / `client.release()`.** The load-bearing joint (`src/pg-vector-store.ts:40,64` and `src/migrate.ts:9,18`). Outside it, the pool owns N idle connections; inside it, your code owns exactly one and must return it. *State ownership* of that connection flips across the seam — and the `finally` block is the contract that guarantees the return even when the body throws.

---

## How it works

### Move 1 — the mental model

You know the rule for a `useEffect` that subscribes: return a cleanup function, or you leak the subscription. A pooled connection is the same contract one layer down — `connect()` is the subscribe, `release()` is the cleanup, and `finally` is what guarantees the cleanup runs even on error. **Acquire in `try`, release in `finally` — every time, no exceptions.**

```
  Acquire / release — the pattern shape

  const client = await pool.connect()   ◄── ACQUIRE (one of N slots)
  try {
    ... use the connection ...           ◄── the work (may throw)
  } finally {
    client.release()                     ◄── RELEASE (runs even if body throws)
  }                                          slot returns to the pool
```

Skip the `finally` and a thrown error skips the release — the slot is gone for good. That's the whole lifecycle, and the repo applies it identically in two places.

### Move 2 — the walkthrough

**File reads — fully buffered, nothing to leak.** Every file read in the repo is `readFile(path, 'utf8')` — it opens the descriptor, reads the whole file into a string, and closes the descriptor internally. The SQL migration (`src/migrate.ts:28`), each indexed markdown (`src/cli/index-cmd.ts:23`), and the eval query set (`src/cli/eval-cmd.ts:20`) all use it. There's no `createReadStream`, no manual `open`/`close`, no descriptor you hold. The tradeoff: the whole file lands in memory at once. For markdown notes and a SQL script that's nothing; for a multi-gigabyte corpus you'd want streaming — `not yet exercised`, and the line where it'd change is the `readFile` in `index-cmd.ts`.

**The pool checkout — the real lifecycle, shown twice identically.** When code needs a transaction, it checks out one connection, runs `begin`/`commit`/`rollback` on it, and releases it in `finally`. Here's the migration runner:

```ts
// src/migrate.ts:8-20 — acquire/use/release, with rollback on error
export async function runMigration(pool: pg.Pool, sql: string): Promise<void> {
  const client = await pool.connect();        // ACQUIRE one connection
  try {
    await client.query('begin');
    await client.query(sql);                  // the migration body
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');           // undo on failure
    throw err;
  } finally {
    client.release();                         // RELEASE — runs on success OR error
  }
}
```

The `PgVectorStore.upsert` is the same skeleton (`src/pg-vector-store.ts:40-64`): `connect` → `begin` → loop inserts → `commit` / `rollback` on error → `release` in `finally`. Two transactions, one discipline. The `finally` is what makes it leak-proof: even if `client.query(sql)` throws a syntax error, the `rollback` runs *and* the `release` runs, so the connection goes back to the pool clean.

The plain `pool.query()` calls — `search` (`src/pg-vector-store.ts:70`), `loadProfile` (`src/profile.ts:5`), `persistMessage` (`src/supabase-trace-sink.ts:27`), `startConversation` — skip the manual checkout entirely. node-postgres grabs an idle connection, runs the one query, and returns it automatically. No `finally` needed because there's no checked-out handle to leak. Rule of thumb the repo follows: `pool.query` for one-shot queries, `pool.connect` + `finally` only when you need a transaction spanning multiple statements.

```
  pool.query vs pool.connect — when each is used (layers-and-hops)

  ┌─ caller ──────────┐  one statement   ┌─ pool ──────────────────┐
  │ search/loadProfile│ ───────────────► │ auto: grab idle, run,   │
  │ /persistMessage   │ ◄─────────────── │ return — no leak surface │
  └───────────────────┘                  └──────────────────────────┘

  ┌─ caller ──────────┐  multi-statement ┌─ pool ──────────────────┐
  │ upsert / migrate  │  txn (begin..    │ connect() → YOU own one  │
  │                   │  commit)         │ slot until release()     │
  │ try { } finally { │ ───────────────► │ finally release() ──────►│ slot back
  │   release()       │                  │ (forget it → slot leaks) │
  └───────────────────┘                  └──────────────────────────┘
```

**The pool's own lifetime — `pool.end()`.** The pool aggregates sockets; closing it closes them all. Batch CLIs call `await pool.end()` as their last act (`migrate.ts:30`, `index-cmd.ts:27`, `eval-cmd.ts:34`) — without it, the idle sockets keep the event loop alive and the process hangs after printing its result (`02`). The chat session wraps it in `close()` (`src/session.ts:72-74`), called only on `/exit`. This is the resource-lifecycle seam between the two process shapes: batch ends the pool passively at end-of-script; chat ends it on an explicit command.

**The raw-mode TTY — Ink's resource, released on exit.** `render(<Chat/>)` (`src/cli/chat.tsx:63`) puts stdin into raw mode so it reads keystrokes immediately (no line buffering). That's an acquired terminal resource — the terminal's normal "cooked" mode is suspended. Ink's `exit()` (called via `useApp().exit()` at `src/cli/chat.tsx:20`) restores cooked mode and releases stdin. The boundary condition: if the process dies *without* `exit()` — a hard crash, or Ctrl-C with no SIGINT handler — the terminal can be left in raw mode (no echo, no line editing) until reset. Ink installs its own signal handling to mitigate the common Ctrl-C case, but the repo adds none of its own (`07`).

### Move 2 variant — the load-bearing skeleton of resource cleanup

The kernel of "never leak a checked-out resource":

1. **Acquire just before the `try`.** `const client = await pool.connect()`. *Acquire inside the `try`* and a failure during acquisition might run the `finally` on an undefined `client` — release on nothing. The order matters: acquire, then `try`.
2. **Release in `finally`, not at the end of `try`.** `finally { client.release() }`. *Put `release()` at the end of the `try` body instead* and any throw before it skips the release — the leak. `finally` is the entire point: it runs on the happy path *and* the throw path.
3. **For the pool itself: `end()` at the lifecycle boundary.** Batch: end-of-script. Chat: `/exit`. *Skip it* and (batch) the process hangs or (chat) sockets aren't drained cleanly.

Optional hardening, not present: `idleTimeoutMillis` to reap idle connections, a `connectionTimeoutMillis` to bound checkout waits, pool `max` tuning. All default. Fine single-device; named so you know where pool hardening would go.

### Move 3 — the principle

Resource lifecycle is one rule applied at every altitude: **whoever acquires, releases — in a `finally`, so the release survives the error.** A file is the trivial case (`readFile` acquires and releases for you). A pooled connection is the real case: the pool lends you a slot, and `finally { release() }` is your promise to return it. The pool itself is the same rule one level up: `pool.end()` returns the sockets to the OS. Get the `finally` discipline right and you can't leak; get it wrong and the leak is invisible until the pool starves under load.

---

## Primary diagram

The full resource-lifecycle picture across all three handle types.

```
  Resource lifecycle — full recap

  ┌─ Interface ─────────────────────────────────────────────────────┐
  │ readFile(.md/.sql) ── open+read+close internally, fully buffered │
  │ raw-mode TTY ── Ink acquires on render(), releases on exit()     │
  └─────────────────────────────┬───────────────────────────────────┘
  ┌─ Runtime: the pool ─────────▼───────────────────────────────────┐
  │  pool.query   ──► auto checkout/return (no leak surface)         │
  │  pool.connect ──► const client = connect()                       │
  │                   try { begin..commit } catch { rollback }       │
  │                   finally { release() }  ◄── the leak-proof joint │
  │  pool.end     ──► batch: end-of-script · chat: /exit             │
  └─────────────────────────────┬───────────────────────────────────┘
  ┌─ Storage: Postgres ─────────▼───────────────────────────────────┐
  │  sockets: born at first query, all closed by pool.end()          │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

`try/finally` around an acquired resource is the manual version of what C++ calls RAII and Python calls a context manager (`with`) — tie release to a scope so it can't be forgotten. JavaScript has no destructors, so `finally` is the tool, and node-postgres deliberately makes `pool.query` the easy default (auto-managed) so you only reach for manual `connect`/`release` when a transaction forces you to. The repo follows that grain exactly: every multi-statement transaction uses the manual pattern with `finally`; every single query uses `pool.query`.

`not yet exercised`: no streams anywhere (no `createReadStream`/`createWriteStream`, no piping, no backpressure on a stream — that's `07`'s territory), no file watchers, no temp-file cleanup. The repo reads small files fully and talks to Postgres/Ollama; it never holds a streaming handle. The day it indexes a corpus too big to `readFile` into memory is the day streaming and its backpressure become real.

---

## Interview defense

**Q: "How do you make sure a database connection is never leaked back into the pool?"**

> Two rules. For a single query, I use `pool.query` — node-postgres checks out an idle connection, runs it, and returns it automatically, so there's no handle to leak. For a multi-statement transaction I check one out with `pool.connect()`, then the body goes in a `try`, `rollback` in `catch`, and `release()` in `finally`. The `finally` is the whole point — it runs whether the transaction commits or throws, so a failed migration still returns its connection. And the pool itself gets `pool.end()` at the process boundary: end-of-script for batch CLIs, `/exit` for chat.

```
  the leak-proof checkout — one sketch

  connect() ─► try { begin..commit } catch { rollback } finally { release() }
                                                          └─ runs on BOTH paths
  pool.query ─► auto: no handle held, can't leak
  pool.end   ─► returns all sockets to the OS
```

**Anchor:** "Acquire, `try`, release in `finally` — identical in `runMigration` (`src/migrate.ts:9-19`) and `upsert` (`src/pg-vector-store.ts:40-64`); the `finally` is what survives the throw."

---

## See also

- `01-runtime-map.md` — the pool as the central runtime resource
- `02-processes-threads-and-tasks.md` — why batch CLIs must call `pool.end()`
- `03-event-loop-and-async-io.md` — the async writes that run against checked-out connections
- `07-backpressure-bounded-work-and-cancellation.md` — the missing TTY-restore-on-SIGINT, and streaming
