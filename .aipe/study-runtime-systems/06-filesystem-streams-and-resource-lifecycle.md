# 06 · Filesystem, Streams, and Resource Lifecycle

**Files, pooled clients, `release()`, and `pool.end()`** · *Industry standard*

---

## Zoom out, then zoom in

Every runtime resource buffr touches follows the same lifecycle — acquire, use,
release — and the most consequential one is the pooled Postgres *client*: borrow
it from the pool, run your statements, return it. Get the release wrong and the
pool runs out of clients and the next checkout hangs forever. The file resources
are simpler (`readFile` opens, reads, and closes the descriptor for you), and
the pool *itself* is the outermost resource, closed once per process by
`pool.end()`.

```
  Zoom out — resources and their lifecycles

  ┌─ Process ────────────────────────────────────────────────────┐
  │  outermost resource: the pg.Pool  (createPool → pool.end)     │
  │                                                              │
  │  ┌─ inner: pooled client ───────────────────────────────────┐│
  │  │  ★ pool.connect → use → release ★  borrow/return per txn  ││ ← here
  │  └──────────────────────────────────────────────────────────┘│
  │  ┌─ inner: file descriptor ─────────────────────────────────┐│
  │  │  readFile opens + reads + closes the fd for you           ││
  │  └──────────────────────────────────────────────────────────┘│
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **resource lifecycle and cleanup** — the acquire/use/
release triple, and the discipline (`try/finally`) that guarantees release even
when the use throws.

---

## Structure pass

**Layers, by resource scope:**

```
  Resource          Acquire           Release            Scope
  ────────────────  ────────────────  ─────────────────  ─────────────────
  file descriptor   readFile (opens)  readFile (closes)  one read, auto
  pooled client     pool.connect      client.release()   one transaction
  the pool itself   createPool        pool.end()         batch: whole run
                                       (session.close())  chat: whole session
```

**Axis traced — "who guarantees this gets released?"**

```
  "what guarantees cleanup, even on error?"

  ┌──────────────────────────────────────────────┐
  │ file fd      → readFile owns it; opens, reads,│  GUARANTEED (library)
  │                closes internally even on error │
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ pooled client→ YOU own it; release() in a │  ← GUARANTEED only
      │                finally block               │     because of finally
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ the pool   → YOU own it; pool.end() is│  ← NOT guaranteed on the
          │   batch: last line · chat: in close()  │     error path OR on SIGINT
          │   neither wrapped in finally/handler    │     (gap!)
          └──────────────────────────────────────┘
```

The answer flips from "library guarantees it" (files) to "your `finally`
guarantees it" (clients) to "nothing guarantees it on error" (the pool itself).
That last flip is a real finding — `pool.end()` has no `finally`, and in chat it
lives in `session.close()` (`session.ts:73`) which only `/exit` reaches: a
SIGINT (Ctrl-C) mid-session skips it entirely.

**Seams:**

- **acquire ↔ release (the client seam).** `pool.connect` and `client.release`
  must pair up. The `finally` block is the contract that makes them pair even
  when the body throws. This seam is implemented correctly in `upsert` and
  `runMigration`.
- **normal cleanup ↔ abnormal exit (the `pool.end` seam).** In batch CLIs
  `pool.end()` is the final statement with no `try/finally`; a throw before it
  skips cleanup. In chat it's inside `session.close()` reached only on `/exit`; a
  throw, a crash, or a SIGINT all skip it. The seam is "graceful exit vs anything
  else," and everything-else leaks.

---

## How it works

### Move 1 — the mental model

You know how a `useEffect` returns a cleanup function so the subscription gets
torn down when the component unmounts — and how forgetting it leaks listeners?
Resource lifecycle is the same contract: every acquire needs a matching release,
and you need a guarantee the release runs even on the unhappy path. `finally` is
that guarantee.

```
  Acquire / use / release — the kernel

   acquire ──► use ──► release
      │         │          │
   connect    query×N    release
      │         │          │
      └── if use throws ───┘  ← release MUST still run (finally)

   miss the release → the resource leaks → pool exhausts → next caller hangs
```

### Move 2 — the resources, one at a time

**File descriptors — the library handles cleanup.** `readFile`
(`index-cmd.ts:23`, `eval-cmd.ts:20`, `migrate.ts:28`) opens the file, reads it
whole, and closes the descriptor — all inside one call, even if the read fails.
buffr never holds a raw `fd`, never calls `open`/`close`, never opens a write
stream. So fd leaks are impossible here; the library owns the full lifecycle.
The tradeoff is the whole-file buffering from `05` — you get safe cleanup but no
streaming.

```
  readFile — fd lifecycle owned by the library

  open(path) ──► read all bytes ──► close(fd) ──► return string
       │              │                  │
       └──────────────┴── all inside one call, closes even on error ──┘
       you never see the fd; you never leak it
```

**Pooled clients — you own the release.** This is the load-bearing resource.
`upsert` (`pg-vector-store.ts:40`) and `runMigration` (`migrate.ts:9`) both call
`pool.connect()` to borrow a dedicated client, then *must* call
`client.release()` to return it. They do it in a `finally` block so the release
runs whether the transaction commits or throws. The kernel:

```
  pooled client — borrow, use, return (finally is load-bearing)

  const client = await pool.connect();   ← borrow (pool has N clients)
  try {
    ... begin / queries / commit ...      ← use
  } finally {
    client.release();                     ← return — runs even if body throws
  }

  what breaks without finally:
  • body throws before release  →  client never returns to the pool
  • repeat N times              →  pool exhausted, every future connect HANGS
                                   (no timeout → hangs forever, see 07)
```

This is the part that bites people. The pool has a fixed number of clients
(`pg`'s default is 10). Every un-released client is one fewer available. Leak
all of them and the next `pool.connect()` waits for a client that never comes
back — a silent hang, not an error. The `finally` is what makes that impossible
in `upsert` and `runMigration`. Note that `search` (`pg-vector-store.ts:67`) and
the trace writes use `pool.query` directly, which borrows-and-returns a client
in one call — no manual release needed, no leak risk.

**The pool itself — closed once, on the graceful path only.** `pool.end()` drains
all idle clients and closes their sockets. In batch CLIs it's the *last line*
(`index-cmd.ts:27`, `eval-cmd.ts:34`, `migrate.ts:30`); in chat it's inside
`session.close()` (`session.ts:72-73`), called only when the user types `/exit`
(`chat.tsx:18-20`). Here's the gap, now wider: it's **not** in a `finally`, and in
chat it's behind a user action. A throw above the last line (batch), an
unhandled error mid-session, or a **SIGINT** (Ctrl-C) all jump past it and the
process exits with the pool's sockets still open. The OS reaps them on exit, so
it's not a *leak* in the classic sense — but for the long-lived chat process,
"close only on `/exit`" means any abnormal exit skips the graceful drain.

```
  pool.end() — only the graceful path reaches it

  BATCH:  createPool ──► await work ──► pool.end() ──► exit   ← clean drain
                             │ throws ──► (jumps past) ──► exit  ← gap

  CHAT:   createChatSession ──► [turns]ⁿ ──► /exit ──► session.close()
                                    │                      │
                                    │                      └─ pool.end() ✓
                                    └─ SIGINT / crash ──► process dies, close()
                                       SKIPPED, no drain  ← the gap (see 07, 08)
```

### Move 2.5 — current vs future state

Two clean lifecycles, one leaky one. What *doesn't* have to change: the client
release in `upsert`/`runMigration` is already correct — `finally` guarantees it,
and `session.close()` → `pool.end()` is the right *normal-exit* drain for chat.
What *would* change to close the gap: wrap each batch CLI body in
`try { ... } finally { await pool.end(); }`, and for chat register a
`process.on('SIGINT'/'SIGTERM')` handler that calls `session.close()`. Neither
exists today. The cost at laptop scale is near zero (process exit cleans up); for
chat the cost is real the moment Ctrl-C is the *normal* way users quit, since it
skips the drain entirely. The cost also grows the moment a batch CLI is invoked
in a loop by another process that *doesn't* exit between
calls. → `07` owns the graceful-shutdown treatment.

### Move 3 — the principle

**Every acquired resource needs a matching release on a guaranteed path, and
`finally` is the only thing that makes the guarantee hold under error.** buffr
gets the *inner* resource (pooled clients) right with `finally` and gets the
*outer* one (the pool) almost right — correct on the happy path, skipped on
error. The lesson is the asymmetry: the library-owned fd is bulletproof, the
finally-protected client is bulletproof, the bare last-line cleanup is not.

---

## Primary diagram

```
  Resource lifecycles in buffr — full picture

  ┌─ Process ─────────────────────────────────────────────────────┐
  │  createPool ─────────────────────────────────────► pool.end()  │
  │   (acquire pool)                          (release — LAST line, │
  │        │                                   skipped on error ◄── gap)
  │        │ borrow clients as needed                              │
  │   ┌────▼─────────────────────────────────────────────────┐    │
  │   │ pool.connect → begin…commit → release   (finally ✓)   │    │
  │   │   upsert, runMigration — bulletproof                  │    │
  │   └───────────────────────────────────────────────────────┘    │
  │   ┌───────────────────────────────────────────────────────┐    │
  │   │ pool.query → (auto borrow + return)                    │    │
  │   │   search, profile, trace writes — no manual release    │    │
  │   └───────────────────────────────────────────────────────┘    │
  │   ┌───────────────────────────────────────────────────────┐    │
  │   │ readFile → (library opens + reads + closes fd)         │    │
  │   │   index/eval/migrate — bulletproof, library-owned      │    │
  │   └───────────────────────────────────────────────────────┘    │
  └────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Client lifecycle is reached for on every transactional write
(indexing a corpus, running a migration). File lifecycle on every read (corpus
files, eval queries, the SQL script). Pool lifecycle once per CLI run.

**The correct release** (`src/pg-vector-store.ts`, lines 40, 62–64):

```
  src/pg-vector-store.ts  (lines 40, 62-64)

  const client = await this.pool.connect();   ← acquire one client from the pool
  try {
    ... begin, inserts, commit ...
  } catch (err) { ... rollback ... throw err; }
  } finally {
    client.release();                          ← ★ return ALWAYS — the guarantee ★
  }
       │
       └─ without finally, a throw mid-batch (e.g. a constraint violation) would
          leak this client. Leak the pool's 10 clients and pool.connect() hangs
          forever (no timeout, see 07). finally is the only correct place.
```

**The graceful-only pool close** (`src/session.ts` + `src/cli/chat.tsx`):

```
  src/session.ts  (lines 39, 72-73)

  const pool = createPool(cfg.databaseUrl);     ← acquire — held for the SESSION
  ...
  async close(): Promise<void> {
    await pool.end();                            ← drain — only via session.close()
  }

  src/cli/chat.tsx  (lines 18-20)

  if (q === '/exit' || q === '/quit') {
    await session.close();                       ← ★ the ONLY caller of close() ★
    exit();
  }
       │
       └─ pool.end() runs only when the user types /exit. A SIGINT (Ctrl-C), a
          crash, or an unhandled error all bypass close() — the process dies with
          the pool's sockets open, no graceful drain. OS reaps them, so no classic
          leak. To fix: process.on('SIGINT', () => session.close().then(...)).
          (see 07, 08)
```

---

## Elaborate

The acquire/use/release triple is one of the oldest patterns in systems
programming — `malloc`/`free`, `open`/`close`, `lock`/`unlock`. Language
features exist specifically to guarantee the release: C#'s `using`, Python's
`with`, Go's `defer`, Java's try-with-resources, and JavaScript's `try/finally`
(plus the newer `using` / `Symbol.dispose`). They all encode the same insight:
the release must run on *every* exit path, and humans forget the error paths.

Connection pools are where this bites hardest in practice, because the failure
is *delayed and silent*: a leaked client doesn't error, it just shrinks the
available pool until a later, unrelated request hangs waiting for a connection
that's gone. The diagnosis is hard precisely because the symptom is far from the
cause. buffr avoids this in its transactional paths with `finally`; the residual
gap is the pool-level close, now wider because the chat process only closes on
`/exit` — a SIGINT skips the drain. → `04` for why those clients carry
transactions, `07` for the missing timeout *and* signal handler, `05` for the
whole-file buffering tradeoff of `readFile`.

**Not yet exercised:** read/write streams, `pipeline()`, `createReadStream`,
file watching, descriptor limits, temp-file cleanup. Every file op is a single
whole-file `readFile`.

---

## Interview defense

**Q: Walk me through a pooled-connection leak. How does buffr avoid it?**

```
  the leak and the guard

  connect ──► use ──► (throws) ──► ✗ no release ──► client gone forever
                                                    repeat → pool empty → HANG

  buffr's guard:  finally { client.release() }  ← runs on throw too
```

A leak is `connect` without a matching `release` on the error path. Do it enough
and the pool empties; the next `connect` hangs waiting for a client that never
returns — silent, not an error. buffr puts `release()` in a `finally`
(`pg-vector-store.ts:64`), so it runs even when the transaction throws. *Anchor:*
the release must be in `finally`; the error path is where leaks are born.

**Q: Is `pool.end()` safe?** On the graceful path, yes. Batch: it's the last
line, not in a `finally`, so a throw above it skips the drain — fix is one
`try/finally`. Chat: it lives in `session.close()` (`session.ts:73`) reached only
on `/exit` (`chat.tsx:18-20`), so a SIGINT or crash skips it — fix is a
`process.on('SIGINT')` handler that calls `session.close()`. Process exit reaps
sockets either way, so no classic leak, but no graceful drain on abnormal exit.
*Anchor:* correct on the graceful path, skipped on everything else — name it
honestly.

---

## Validate

1. **Reconstruct:** draw acquire/use/release and mark where `finally` sits and
   what it guarantees.
2. **Explain:** why does `search` (`pg-vector-store.ts:67`) need no manual
   `release()` while `upsert` (`:40`) does?
3. **Apply:** an exception fires inside `upsert`'s insert loop. Trace the exact
   path — does the client return to the pool? Why?
4. **Defend:** argue whether `pool.end()` living only in `session.close()`
   (`session.ts:73`, reached on `/exit`) is a real bug for the long-lived chat
   process, then name the change (a SIGINT handler) that makes it correct.

---

## See also

- `04-shared-state-races-and-synchronization.md` — why pooled clients carry transactions
- `05-memory-stack-heap-gc-and-lifetimes.md` — the whole-file buffering tradeoff of `readFile`
- `07-backpressure-bounded-work-and-cancellation.md` — the missing timeout + SIGINT handler
- `08-runtime-systems-red-flags-audit.md` — the `pool.end()`-on-abnormal-exit gap ranked

---

Updated: 2026-06-24 — pool close re-grounded on `session.close()`→`pool.end()` (`session.ts:73`), reached only via `/exit` (`chat.tsx:18-20`); widened the cleanup gap to cover SIGINT/crash on the long-lived chat process; purged ask-cmd close snippet.
