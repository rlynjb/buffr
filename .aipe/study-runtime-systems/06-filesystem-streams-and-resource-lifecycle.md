# Filesystem, Streams, and Resource Lifecycle — handles, descriptors, cleanup

**Industry name(s):** resource acquisition/release, descriptor pool, TTY raw mode · **Type:** Industry standard

## Zoom out, then zoom in

A "resource" is anything the OS hands you that you have to give back: a file descriptor, a socket, a connection, the terminal in raw mode. buffr holds four kinds — pooled DB connections, HTTP sockets to Ollama, file reads for indexing/migration, and the raw-mode TTY in chat. The runtime question is *who acquires each, and who's responsible for releasing it.*

```
  Zoom out — the resources buffr holds

  ┌─ Chat process ───────────────────────────────────────────────┐
  │  process.stdin raw-mode TTY (Ink) ── released on exit()       │ ← chat-only resource
  │  pg.Pool: a POOL of connection descriptors ── pool.end()      │
  └───────────────────────────────┬───────────────────────────────┘
                                  │
  ┌─ One-shot CLIs ───────────────▼───────────────────────────────┐
  │  fs readFile (migration SQL, corpus md, eval json) — async    │
  │  pg.Pool ── opened, drained, pool.end(), exit                 │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the load-bearing resource is the pool — because it's a *pool of descriptors*, leaking one connection is a slow descriptor leak. The axis is failure/cleanup: *does every acquire have a matching release, even on the error path?*

## Structure pass

**Layers.** Three: **handles** (raw fd-level — files, the TTY), **the pool** (a managed set of connection descriptors), and **process exit** (the final cleanup, or absence of it).

**Axis: failure — "on the error/exit path, does this resource get released?"**

```
  One axis — "released on the bad path?" — traced down

  ┌──────────────────────────────────────────────┐
  │ files: readFile resolves/rejects, fd auto-closed│ → YES (library handles it)
  └───────────────────────┬────────────────────────┘
       ┌──────────────────────────────────────────┐
       │ pool connection: finally{release()}        │ → YES on query error
       │                  Ctrl-C kill                │ → NO (skips finally)
       └───────────────────────┬───────────────────┘
            ┌─────────────────────────────────────┐
            │ pool itself: pool.end() in CLIs       │ → YES on clean exit
            │              chat /exit close()        │ → YES on /exit; NO on Ctrl-C
            └─────────────────────────────────────┘

  the answer is YES on clean paths, NO on signal-kill — that's the gap
```

**The seam: clean exit vs signal kill.** Every resource has a release on the *clean* path (return, `/exit`, end of script). None of them have a release on the *signal* path (Ctrl-C / SIGTERM), because there's no signal handler. That boundary is the one real cleanup gap in the repo.

## How it works

### Move 1 — the mental model

You know the pattern `const f = await fetch(); try { … } finally { /* cleanup */ }` — acquire, use in a `try`, release in `finally` so the release runs even if the body throws. Every resource in buffr is some version of that, and the pool is the same pattern one level up: it acquires *many* connections and you borrow/return them through it.

```
  The pattern — acquire / use / release, release in finally

  acquire ──► try { use } ──► finally { release }
                  │ throws? ──────────┘ (release still runs)
```

### Move 2 — the walkthrough

**The pool is a descriptor pool — leaking a connection leaks an OS resource.** Each pooled connection is a live TCP socket to Postgres (a file descriptor). The explicit-transaction path acquires one and *must* return it:

```ts
// src/pg-vector-store.ts:40-64
const client = await this.pool.connect();   // acquire one descriptor
try {
  await client.query('begin');
  // ...inserts...
  await client.query('commit');
} catch (err) {
  await client.query('rollback');           // error path still inside try
  throw err;
} finally {
  client.release();                          // ← release on BOTH paths
}
```

The `finally` is load-bearing: it runs on success, on a thrown insert, and on the rollback path. Drop it and a thrown insert leaks the connection — and since the pool defaults to max 10, the eleventh leaked-then-needed connection makes every future query hang waiting for one that never comes back. `migrate.ts:9-19` uses the identical acquire/try/finally/release shape for its transaction. The transparent `pool.query(...)` calls (e.g. `src/profile.ts:5`, `src/pg-vector-store.ts:70`) acquire-and-release internally, so you can't leak with them — the leak risk lives only where you `connect()` explicitly.

**File reads are async and self-closing.** Every file buffr touches goes through `node:fs/promises` `readFile`, which opens, reads, and closes the descriptor for you:

```ts
// src/migrate.ts:28 — migration SQL
const sql = await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8');
// src/cli/index-cmd.ts:23 — corpus markdown
const text = await readFile(path, 'utf8');
// src/cli/eval-cmd.ts:20 — eval query set
JSON.parse(await readFile(new URL('../../../eval/queries.json', import.meta.url), 'utf8'));
```

There's no manual `open`/`close`, no `fs.createReadStream`, no streaming of large files — buffr reads whole files into strings. For markdown corpus and a SQL script that's the right call; the files are small. Node `stream` plumbing and backpressured file reads are *not yet exercised* and would only matter for files too big to hold in memory. Note the use of `import.meta.url` to resolve paths relative to the compiled `dist/` location (`migrate.ts:28`, `eval-cmd.ts:20`) — that's ESM/NodeNext resolving against the module URL, not `process.cwd()`.

**The TTY in raw mode is the chat-only resource Ink acquires for you.** When `render(<Chat/>)` runs (`src/cli/chat.tsx:63`), Ink puts `process.stdin` into *raw mode* — it stops the terminal from line-buffering and echoing, so `ink-text-input` can capture keystrokes one at a time. That's a real terminal-state acquisition: raw mode has to be *un*set on exit or the user's shell is left in a broken state (no echo, no line editing). Ink registers the cleanup with `useApp().exit`:

```ts
// src/cli/chat.tsx:10, 18-21 — /exit path restores the terminal
const { exit } = useApp();
if (q === '/exit' || q === '/quit') {
  await session.close();    // release the pool first
  exit();                   // Ink unwinds: restores TTY mode, stops the render loop
  return;
}
```

The order matters: `session.close()` (which calls `pool.end()`, `src/session.ts:72-75`) runs *before* `exit()`, so the pool drains before the process is allowed to wind down. On the `/exit` path, every resource is released in order: pool → TTY → process.

**The gap: a Ctrl-C kill skips all of it.** There is no `process.on('SIGINT', …)` anywhere. If you Ctrl-C the chat instead of typing `/exit`, the process is killed without running `session.close()` — the pool never drains gracefully (Postgres reaps the dropped sockets eventually, but buffr didn't ask it to) and Ink's TTY cleanup may or may not run depending on its own signal handling. For a single-user local CLI this is mostly cosmetic — the OS reclaims fds on process death — but it means the "clean shutdown" path only exists for `/exit`, not for signals. Graceful signal-handled shutdown is *not yet exercised*. → `07` treats this as the shutdown half of bounded-work/cancellation.

```
  Two exit paths — only one releases gracefully

  /exit ──► session.close() (pool.end) ──► exit() (TTY restore) ──► process ends  ✓ clean
  Ctrl-C ──► SIGINT ──► (no handler) ──► process killed                            ✗ skips cleanup
```

### Move 3 — the principle

Resource safety is about the *unhappy* path. Anyone can release on success; the discipline is releasing on the throw (the `finally`) and on the kill (the signal handler). buffr nails the throw path everywhere it acquires explicitly, and leaves the kill path unhandled — which is a defensible call for a local single-user CLI where the OS is the backstop, but it's exactly the line you'd have to draw differently for a long-running server.

## Primary diagram

```
  buffr — resource lifecycle, acquire to release

  ┌─ acquire ─────────────────────────────────────────────────────────────┐
  │  Ink → process.stdin RAW MODE     pool.connect() → 1 conn descriptor   │
  │  fs readFile → fd (auto-closed)   createPool → pool of ≤10 descriptors │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ use inside try { ... }
  ┌─ release: clean path ─────────▼───────────────────────────────────────┐
  │  finally{ client.release() }  ── per query/transaction                 │
  │  /exit: session.close()→pool.end()  then  exit()→TTY restore           │
  │  CLIs: pool.end() at end of script → process exits                     │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ release: signal path
  ┌─ Ctrl-C / SIGINT ─────────────▼───────────────────────────────────────┐
  │  NO handler → process killed → finally + close() SKIPPED (OS reclaims) │  ← the gap
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The acquire/try/finally idiom is JavaScript's hand-rolled version of what other languages give you syntactically — Python's `with`, C#'s `using`, Go's `defer`, C++ RAII. They all encode the same invariant: a resource acquired in a scope is released when the scope ends, *including* on the error path. `pool.connect()/release()` is the manual form; `pool.query()` is the convenience form that wraps it so you can't forget. The signal-handling gap is the one place this idiom doesn't reach — `try/finally` covers exceptions, not `SIGINT`, which bypasses the call stack entirely. A production long-running process closes that gap with a `process.on('SIGINT', async () => { await pool.end(); process.exit(0); })`; buffr hasn't, and for a local CLI backed by the OS's fd-reclamation that's a reasonable place to stop — but it's the first thing you'd add the day this became a daemon.

## Interview defense

**Q: Why is the pool the resource to watch, and what's the one line guarding it?**
Because the pool is a *pool of socket descriptors* — leaking one connection leaks an OS fd, and after 10 leaks (the default max) the pool is dry and every query hangs forever. The guard is `client.release()` in the `finally` of the explicit-transaction paths (`src/pg-vector-store.ts:63`, `src/migrate.ts:18`), which runs on success, on a thrown query, and on rollback.

```
  connect() ─► try{...} ─► finally{ release() } ← runs even on throw
  miss it ×10 ─► pool exhausted ─► every query waits forever
```
Anchor: *transparent `pool.query` can't leak; only explicit `connect()` can — so guard those.*

**Q: What happens to cleanup if I Ctrl-C the chat?**
It's skipped. There's no SIGINT handler, so the process is killed without running `session.close()`/`pool.end()` or guaranteed TTY restore. `/exit` is the only path that drains the pool then restores the terminal in order. Graceful signal shutdown is *not yet exercised*; for a single-user local CLI the OS reclaims the fds, so it's defensible — but it's the first thing to add if this became a daemon.

```
  /exit  → close()→pool.end() → exit()→TTY restore  ✓
  Ctrl-C → no handler → killed → cleanup skipped     ✗
```
Anchor: *try/finally covers throws, not signals — that's the uncovered path.*

## See also

- `01-runtime-map.md` — the pool's lifetime across chat vs one-shot
- `07-backpressure-bounded-work-and-cancellation.md` — graceful shutdown as the cancellation story
- `study-system-design` — the buffr ↔ Postgres ↔ Ollama connection topology
