# The App ↔ Postgres Boundary

**Industry names:** client/server boundary · connection pooling · fail-fast on a remote dependency. **Type:** Industry standard.

## Zoom out, then zoom in

This is the one place in `buffr-laptop` where two things with **separate failure domains** exchange state over a wire. The Node process is one failure domain; Postgres is another. Everything that makes this a distributed-systems topic — partial failure, timeouts, retries, "is the other side even there" — lives at this single seam. Here's where it sits.

```
  Zoom out — where the Postgres boundary lives

  ┌─ Process layer (one Node process) ───────────────────────┐
  │  createChatSession()                                      │
  │    persistMessage() · startConversation() · pipeline.index│
  │                         │                                 │
  │                  ★ pg.Pool ★   ← THIS CONCEPT             │ ← we are here
  └─────────────────────────┼─────────────────────────────────┘
                            │  SQL over TCP (the only client/server seam)
                            ▼
  ┌─ Storage layer (separate failure domain) ────────────────┐
  │  reindb — Postgres + pgvector, schema agents              │
  │  documents · chunks · conversations · messages · profiles │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **connection pool fronting a remote database, configured to fail fast.** The question it answers — the distributed-systems question — is *"what happens to the one user when the other side is slow or gone?"* In this repo the answer is: it throws immediately, with one deliberate exception (the best-effort memory write). There's no retry, no backoff, and — the gap worth naming — no acquire or statement timeout.

## The structure pass

**Layers.** Two: the process (caller) and Postgres (callee), joined by the pool. The pool is itself a thin layer — it owns a set of TCP connections and hands them out.

**The axis: failure — where does it originate, propagate, get contained?** Trace that one question across the seam.

```
  One axis — "what happens on failure?" — traced across the seam

  ┌─ Process side ─────┐   the pg.Pool seam    ┌─ Postgres side ────┐
  │  pool.query(...)   │ ═══════╪════════════►  │  executes or fails │
  │  awaits a Promise  │   (failure flips here) │  (down / slow /    │
  │                    │ ◄══════╪════════════   │   constraint)      │
  └────────────────────┘   reject propagates    └────────────────────┘
         ▲                   up the call stack
         │  contained ONCE:  memory.remember() try/catch (session.ts:64)
         │  everywhere else: throws, no retry
```

**The seam is load-bearing because the failure axis flips across it.** On the process side, a failure is a rejected `Promise` you can catch. On the Postgres side, a failure is a connection reset or a constraint error you can't see until the round-trip comes back. The contract at this seam — what `pool.query` promises the caller — is *"I resolve with rows or I reject; I will not retry for you, and right now I will not time out the acquire."* That contract is the whole lesson; the mechanics below hang off it.

## How it works

### Move 1 — the mental model

You already know the shape from any `fetch()` you've written: you call across a network, you get back a promise, and that promise has a success path and an error path — and if the server hangs, your `fetch` hangs unless *you* gave it an `AbortController` deadline. A `pg.Pool` is the same shape, plus one thing a bare `fetch` doesn't have: it keeps a handful of TCP connections warm and hands one to each query so you don't pay the TCP+TLS+auth handshake every time.

```
  The pattern — a pool fronting a remote dependency

        pool.query(sql, params)
               │
               ▼
        ┌─────────────┐   acquire a warm connection
        │  pg.Pool    │── (or open one, up to a cap) ──┐
        │  [ c1 c2 c3]│                                 ▼
        └─────────────┘                          ┌────────────┐
               ▲                                 │ Postgres   │
               │  resolve(rows)  OR  reject(err) │ executes   │
               └─────────────────────────────────└────────────┘
          no retry · no acquire timeout · fail-fast
```

The kernel: **acquire → execute → resolve-or-reject → release.** Everything else (timeouts, retries, statement deadlines) is hardening layered on top — and this repo has deliberately layered almost none of it.

### Move 2 — the step-by-step walkthrough

**The pool factory — bare by design.** This is the entire boundary constructor:

```ts
// src/db.ts:1
import pg from 'pg';

/** A pg Pool for reindb. Callers load DATABASE_URL via dotenv before this. */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });   // ← nothing but the URL
}
```

Read it line by line. `new pg.Pool({ connectionString })` constructs a pool with **all pg defaults**: default max connections (10), `idleTimeoutMillis` default, and crucially **no `connectionTimeoutMillis`** (the acquire deadline) and **no `statement_timeout`** (the per-query deadline). The comment is honest about what the caller owes it — `DATABASE_URL` loaded first — but says nothing about timeouts, because there are none. On a local or near-local Postgres this is the right amount of code: the handshake is sub-millisecond and the DB is either up or it isn't.

**Where the seam is actually crossed — autocommit inserts.** `persistMessage` (`src/supabase-trace-sink.ts:19`) is a representative crossing:

```ts
// src/supabase-trace-sink.ts:27
await pool.query(
  `insert into agents.messages
     (conversation_id, role, content, tool_calls, tool_results, model, tokens_used, created_at)
   values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))`,
  [ conversationId, role, content, /* ... */ createdAt ],
);
```

`pool.query` is the crossing. It acquires a connection, sends the SQL, awaits the round-trip. There's no transaction wrapping it — it's autocommit — and no `try/catch` here, so a rejection propagates straight up to whoever awaited `persistMessage`. That's fail-fast: the error surfaces at the call site, not swallowed.

**The one deliberate containment.** Compare with the single place the repo *chooses* to absorb a failure:

```ts
// src/session.ts:64
try {
  await memory.remember({ conversationId, question, answer });
} catch {
  // swallow: memory is best-effort, the turn already succeeded
}
```

Here's the boundary-condition reasoning that makes this not-sloppy. By the time `memory.remember` runs, the user already has `answer` in hand. A memory-write failure (a `pool.query` rejection inside `remember`) must not turn a successful turn into a thrown error. So this *one* crossing is contained; every other crossing fails loud. That's failure **classification** done by hand — "this write is best-effort, that write is required" — even though there's no formal retryable/terminal taxonomy in the code.

**The layers-and-hops view of one `ask()`** — watch which hops can fail and what happens:

```
  Layers-and-hops — one ask() turn across the Postgres seam

  ┌─ Process ──────────┐
  │ session.ask()      │
  └─────┬──────────────┘
   hop 1│ persist user turn (pool.query)      → throws on failure (required)
        ▼
  ┌─ Storage ──────────┐
  │ agents.messages    │
  └─────┬──────────────┘
   hop 2│ agent.answer() → trace.flush()       → throws on failure (required)
        │ (many pool.query inserts, raced)
        ▼
  ┌─ Storage ──────────┐
  │ agents.messages    │
  └─────┬──────────────┘
   hop 3│ memory.remember (pool.query)          → SWALLOWED (best-effort)
        ▼
        return answer
```

Hops 1 and 2 are required and fail-fast. Hop 3 is contained. That asymmetry *is* the repo's partial-failure policy — there's no config flag for it, it's encoded in where the `try/catch` sits.

### Move 3 — the principle

A boundary to a remote dependency is defined less by how it succeeds than by **what it promises on failure**. This seam promises: reject-or-resolve, no retry, fail-fast — with exactly one write classified as best-effort. That's a coherent policy for a single device and a single user, where a hung retry is worse than a visible error. The principle that generalizes: *name your failure policy at every boundary, even when the policy is "do nothing fancy" — because "we never decided" and "we chose fail-fast" produce identical code and opposite levels of confidence.*

## Primary diagram

The whole boundary, recapped — the pool, the crossings, and the failure policy at each.

```
  The app ↔ Postgres boundary — full recap

  ┌─ Process layer (one failure domain) ─────────────────────────────┐
  │                                                                   │
  │  createChatSession (session.ts:34)                                │
  │    ├─ persistMessage()      ─┐                                    │
  │    ├─ startConversation()    │ required crossings → throw on fail │
  │    ├─ trace.flush() inserts ─┘                                    │
  │    └─ memory.remember()      → contained crossing → swallow       │
  │                          │                                        │
  │                   createPool (db.ts:4)                            │
  │                   new pg.Pool({ connectionString })               │
  │                   • no connectionTimeoutMillis (acquire)          │
  │                   • no statement_timeout (per query)              │
  │                   • no retry / backoff / jitter                   │
  └──────────────────────────┼────────────────────────────────────────┘
                             │ SQL over TCP — the ONE client/server seam
                             ▼
  ┌─ Storage layer (separate failure domain) ────────────────────────┐
  │  reindb — Postgres + pgvector (schema: agents)                    │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

Connection pooling exists because opening a Postgres connection is expensive (TCP, TLS, auth, backend process fork) and you don't want to pay it per query. The pool amortizes it. The *failure* questions a pool raises — acquire timeout, statement timeout, retry — come from the fact that the thing on the other end can fail independently of you, which is the founding observation of distributed systems.

The gap this repo carries is the **missing acquire timeout**. With `connectionTimeoutMillis` unset, if Postgres accepts the TCP connection but never completes the handshake (a half-open connection — common on flaky networks, NAT timeouts, a paused container), `pool.connect()` waits with no deadline. On a local socket this never happens. Against a remote Supabase over the public internet — exactly where the deferred design (`agent-layer-plan.md`) takes this — it can, and it would hang the user's *first* turn with no error to show. The fix is one option object key. It's listed Rank 1 in `audit.md`'s red-flags table for that reason: cheapest possible change, prevents the worst single-device failure mode the future design introduces.

The single-node transaction mechanics behind `pool.query` (autocommit, isolation, what `commit` actually guarantees) are not this guide's to teach — see `study-database-systems/05-transactions-isolation-and-anomalies.md`. The Ollama HTTP boundary's timeout/retry story belongs to `study-networking`.

## Interview defense

**Q: "Walk me through how this app handles the database being down."**

> It fails fast. `createPool` (`src/db.ts:4`) builds a bare `pg.Pool` with no retry layer, so a rejected `pool.query` propagates straight to the call site. There's exactly one deliberate exception — the post-turn `memory.remember()` write is wrapped in a try/catch that swallows (`src/session.ts:64`), because by then the user already has the answer and a best-effort memory write shouldn't destroy a successful turn. So the policy is: required writes throw, the one best-effort write is contained.

```
  required write ──► throws ──► user sees error    (correct: DB is gone)
  memory write   ──► swallowed ──► turn still succeeds (correct: best-effort)
```

> The load-bearing part people skip: **there's no acquire timeout.** `connectionTimeoutMillis` is unset, so against a remote DB a half-open connection hangs the first turn forever. On a local socket it never matters, which is why it was the right call to ship — but it's the first thing I'd add before pointing this at a remote Supabase.

**Anchor:** *"Fail-fast pool, one best-effort write contained, no acquire timeout — fine on a local socket, fix it before going remote."*

## See also

- `02-trace-sink-write-buffering.md` — the other side of this seam: how the buffered writes that cross it are ordered.
- `audit.md` — lens 2 (partial failure) and the Rank-1 red flag.
- `study-database-systems/05-transactions-isolation-and-anomalies.md` — what `pool.query` actually guarantees on the Postgres side.
- `study-networking/` — the Ollama HTTP boundary's timeout/retry behavior.
- `study-system-design/04-long-lived-chat-session.md` — the session that owns this pool across turns.
