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
  the pool itself   createPool        pool.end()         whole process
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
          │                the LAST line, no finally│     error path (gap!)
          └──────────────────────────────────────┘
```

The answer flips from "library guarantees it" (files) to "your `finally`
guarantees it" (clients) to "nothing guarantees it on error" (the pool itself).
That last flip is a real finding — `pool.end()` has no `finally`.

**Seams:**

- **acquire ↔ release (the client seam).** `pool.connect` and `client.release`
  must pair up. The `finally` block is the contract that makes them pair even
  when the body throws. This seam is implemented correctly in `upsert` and
  `runMigration`.
- **last-line cleanup ↔ error path (the `pool.end` seam).** `pool.end()` sits as
  the final statement of each CLI with no protection. A throw before it skips
  cleanup. The seam is "happy path vs error path," and the error path leaks.

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

**The pool itself — closed once, on the happy path only.** `pool.end()`
(`ask-cmd.ts:38`, `index-cmd.ts:27`, `eval-cmd.ts:34`, `migrate.ts:30`) drains
all idle clients and closes their sockets. It sits as the *last line* of each
CLI. Here's the gap: it's **not** in a `finally`. If any `await` above it throws
— a failed query, an Ollama timeout, a dimension mismatch
(`pg-vector-store.ts:33`) — execution jumps past `pool.end()` and the process
exits with the pool's sockets still open. The OS reaps them on exit, so it's not
a *leak* in the classic sense, but it's not a graceful drain either.

```
  pool.end() — last line, no finally → skipped on error

  createPool ──► await work ──► pool.end() ──► exit   ← happy path: clean drain
                     │
                     └─ throws ──► (jumps past pool.end) ──► exit
                                    sockets torn down by process death,
                                    not by graceful drain  ← the gap (see 07, 08)
```

### Move 2.5 — current vs future state

Two clean lifecycles, one leaky one. What *doesn't* have to change: the client
release in `upsert`/`runMigration` is already correct — `finally` guarantees it.
What *would* change to close the gap: wrap each CLI's body in
`try { ... } finally { await pool.end(); }`, or register a
`process.on('SIGINT'/'SIGTERM')` handler. Neither exists today. The cost of the
gap at laptop scale is near zero (process exit cleans up); the cost grows the
moment a CLI is invoked in a loop by another process that *doesn't* exit between
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

**The leaky pool close** (`src/cli/ask-cmd.ts`, lines 19, 33–38):

```
  src/cli/ask-cmd.ts  (lines 19, 33-38)

  const pool = createPool(cfg.databaseUrl);     ← acquire (line 19)
  ...
  const agent = new RagQueryAgent({ ... });
  const answer = await agent.answer(question);  ← ANY throw here ...
  await trace.flush();                          ← ... or here ...
  process.stdout.write(`\n${answer}\n`);
  await pool.end();                             ← ... skips this release entirely
       │
       └─ pool.end() is the last line, not in a finally. agent.answer throwing
          (Ollama down, context overflow) jumps past it. Process exit reaps the
          sockets, so no classic leak — but it's not a graceful drain. To fix:
          try { ...all of it... } finally { await pool.end(); }  (see 07, 08)
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
cause. buffr avoids this in its transactional paths with `finally`; the only
residual gap is the pool-level close on the error path. → `04` for why those
clients carry transactions, `07` for the missing timeout that turns a leak into
a *forever* hang, `05` for the whole-file buffering tradeoff of `readFile`.

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

**Q: Is `pool.end()` safe in these CLIs?** On the happy path, yes. On the error
path, no — it's the last line, not in a `finally`, so a throw above it skips the
graceful drain (`ask-cmd.ts:38`). Process exit reaps the sockets so it's not a
classic leak, but the fix is one `try/finally` around the CLI body. *Anchor:*
correct for the happy path, skipped on error — name it honestly.

---

## Validate

1. **Reconstruct:** draw acquire/use/release and mark where `finally` sits and
   what it guarantees.
2. **Explain:** why does `search` (`pg-vector-store.ts:67`) need no manual
   `release()` while `upsert` (`:40`) does?
3. **Apply:** an exception fires inside `upsert`'s insert loop. Trace the exact
   path — does the client return to the pool? Why?
4. **Defend:** argue whether `pool.end()` not being in a `finally`
   (`ask-cmd.ts:38`) is a real bug for a laptop CLI, then name the change that
   makes it correct.

---

## See also

- `04-shared-state-races-and-synchronization.md` — why pooled clients carry transactions
- `05-memory-stack-heap-gc-and-lifetimes.md` — the whole-file buffering tradeoff of `readFile`
- `07-backpressure-bounded-work-and-cancellation.md` — the missing timeout behind a forever-hang
- `08-runtime-systems-red-flags-audit.md` — the `pool.end()`-on-error gap ranked
