# Connection Pool Reuse

**Industry names:** connection pooling · warm pool · handshake amortization.
**Type:** Industry standard.

---

## Zoom out, then zoom in

Opening a Postgres connection isn't free — it's a TCP handshake, then auth, then setup, all
before a single query runs. buffr opens *one* pool at the start of a chat session and reuses
it for every turn until the session closes. This is the most load-bearing performance
decision in the repo, and it's invisible precisely because it works — nobody notices the
handshake cost they never pay.

```
  Zoom out — the pool's lifetime spans the whole session

  ┌─ Session layer (src/session.ts) ───────────────────────────┐
  │  createChatSession()                                        │
  │    const pool = createPool(databaseUrl)  ← created ONCE     │ ← we are here
  │    ...                                                      │
  │    ask(q1) ─┐                                               │
  │    ask(q2) ─┼─ every turn borrows from the SAME warm pool   │
  │    ask(qN) ─┘                                               │
  │    close() → pool.end()  ← torn down ONCE                   │
  └──────────────────────────────────┬──────────────────────────┘
                                      │ reused TCP connections
  ┌─ Postgres ─────────────────────▼─────────────────────────────┐
  │  reindb  ·  handshake paid once, not per query               │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **warm connection pool** whose lifetime is the whole session. The
question this file answers: what does the pool amortize away, and why is "create once, reuse
across turns" the load-bearing choice that the one-shot CLIs *don't* get to make.

---

## Structure pass

**Layers.** Three: pool creation (`db.ts:4-6`), pool ownership across the session
(`session.ts:39` create, `session.ts:73` end), and per-operation borrowing (`pool.query`
for search, `pool.connect()` for the upsert transaction).

**Axis — lifecycle (when is the handshake paid?).** Hold "when do we pay for the TCP+auth
handshake?" across the layers:

```
  One question — "when is the connection handshake paid?" —

  ┌─ session (long-lived chat) ──────────────────────────┐
  │  pool created once       → handshake amortized to     │  ← the win
  │                            ~once, reused every turn    │
  └──────────────────────────────────────────────────────┘
  ┌─ one-shot CLI (index / eval) ────────────────────────┐
  │  pool created, used, pool.end()  → handshake paid per  │  acceptable: process
  │  process invocation                                    │  exits anyway
  └──────────────────────────────────────────────────────┘

  same pool API; the SEAM is process lifetime — long-lived amortizes, one-shot doesn't.
```

**Seam — process lifetime.** The load-bearing seam is between the long-lived chat session
and the one-shot CLIs. Same `createPool` (`db.ts:4`), opposite payoff: the chat session
reuses the warm pool across many turns; `index-cmd.ts:27` and `eval-cmd.ts:34` call
`pool.end()` and exit. For a one-shot CLI that's correct — there's no next turn to amortize
over. The handshake amortization is a *session* property, not a pool property.

---

## How it works

### Move 1 — the mental model

You know how `fetch()` to the same host reuses an HTTP keep-alive connection instead of
re-doing the TCP+TLS handshake every request? A connection pool is that idea for the
database: a set of already-open, already-authenticated connections you borrow and return.
The strategy: **pay the expensive setup once, then hand the warm connection back and forth.**

```
  Pool — borrow / return, handshake amortized

  ┌─ pg.Pool ──────────────────────────────────┐
  │   [conn A: open+authed]  [conn B]  [conn C] │  ← created once, kept warm
  └───┬───────────────────────▲────────────────┘
      │ borrow                 │ return (release)
      ▼                        │
   ask() / query()  ──────── runs ───────┘

   handshake: ░░ paid here once ░░  then never again for the session
```

### Move 2 — the walkthrough

**The factory — deliberately bare.** `db.ts` is six lines, and that's the point:

```ts
import pg from 'pg';
/** A pg Pool for reindb. Callers load DATABASE_URL via dotenv before this. */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });   // ← a POOL, not a Client
}
```

The single decision encoded here is `new pg.Pool` rather than `new pg.Client`. A `Client`
is one connection you open and close; a `Pool` is a managed set that stays warm. Everything
downstream — the amortization — flows from this one-word choice.

**The session owns the pool for its whole life.** `session.ts:39`:

```ts
const pool = createPool(cfg.databaseUrl);      // ← created once, at session start
...
return {
  async ask(question) {
    await persistMessage(pool, conversationId, 'user', question);  // ← turn 1 borrows
    const answer = await agent.answer(question);                   //   (search uses pool)
    ...                                                            // ← turn 2 borrows...
  },
  async close() { await pool.end(); },          // ← torn down once, at session end
};
```

Every `ask()` — every chat turn — runs its `persistMessage`, its HNSW `search`, its trace
inserts, and its `memory.remember` upsert against this *same* pool. The Ink UI
(`src/cli/chat.tsx`) holds the session open across the whole conversation, so a 20-turn
chat pays the connection handshake essentially once, not 20 times.

**The load-bearing skeleton — what breaks if you remove each part:**

```
  warm-pool kernel — name each part by what breaks without it

  1. pg.Pool (not Client)        remove → one connection; can't serve concurrent borrows
  2. created once per session    remove → handshake per turn; the amortization is gone
  3. borrow/return per op        remove (hold one forever) → pool starves; can't share
  4. pool.end() on close         remove → connections leak; process won't exit cleanly
```

Part 2 is the load-bearing one for *performance*: move the `createPool` call inside `ask()`
and you'd re-handshake every turn — the exact cost this pattern exists to avoid.

**Why this is the biggest perf win in the repo — and it's an avoidance.** A fresh Postgres
connection is a TCP handshake + auth round-trip + session setup. Over a local socket that's
small but non-zero; over a network DB it's tens of milliseconds. buffr pays it once per
session. Multiply that over a long conversation and the warm pool is quietly saving the most
latency of any single decision in the codebase. It's invisible because it shows up as a cost
you *don't* see in any trace — the handshakes that never happened.

### Move 3 — the principle

The cheapest latency is the work you don't repeat. Pooling is the canonical version: pay an
expensive setup once, amortize it over every operation in the resource's lifetime. The skill
is matching the resource's lifetime to the work's lifetime — long-lived session → long-lived
pool (amortize); one-shot CLI → open/use/close (nothing to amortize). buffr gets both right.

---

## Primary diagram

```
  Connection pool reuse — one warm pool across a whole session

  ┌─ Session (long-lived, src/session.ts) ────────────────────────────┐
  │  createPool() ── handshake paid ONCE ──┐                           │
  │                                        ▼                           │
  │   ask() turn 1 ─┐   ask() turn 2 ─┐   ask() turn N ─┐              │
  │     persist     │     persist     │     persist     │  all borrow  │
  │     search      ├─►  search       ├─►  search       ├─► the SAME   │
  │     trace×6     │     trace×6     │     trace×6     │  warm pool   │
  │     remember    │     remember    │     remember    │              │
  │                 ┘                 ┘                 ┘              │
  │  close() → pool.end() ── teardown ONCE                            │
  └──────────────────────────────────┬────────────────────────────────┘
                                      │ reused, authed TCP connections
  ┌─ Postgres (reindb) ─────────────▼─────────────────────────────────┐
  │  handshakes that never happened = the latency never paid           │
  └────────────────────────────────────────────────────────────────────┘

  contrast — one-shot CLIs (index-cmd, eval-cmd): createPool → use → pool.end()
  handshake per process; correct, because there's no next turn to amortize over.
```

---

## Elaborate

Connection pooling is foundational because the DB handshake is genuinely expensive relative
to a query — and at scale, unpooled connections also exhaust the server's connection limit.
buffr is single-device so the *exhaustion* problem isn't live; the *amortization* benefit is.
This is the same instinct as HTTP keep-alive and gRPC channel reuse — pay the channel setup
once, stream work over it.

Worth flagging the one thing the pool is *not* doing yet: it uses pg's default sizing. With
one user issuing serial requests that's irrelevant — but it's the knob that would matter the
day buffr served concurrent turns, which is `not yet exercised` (see `audit.md` §3). This
pattern pairs with everything: the per-chunk loop (`03`) and the per-turn writes (`05`) are
cheap *because* they run over a warm pool.

---

## Interview defense

**Q: How does buffr manage database connections across a chat session?**

One `pg.Pool` created at session start (`session.ts:39`) and reused for every turn —
`persistMessage`, the HNSW search, the trace inserts, the memory upsert all borrow from it.
The handshake — TCP plus auth — is paid once and amortized across the whole conversation.

```
  unpooled:  handshake → query → close,  per turn   → N handshakes
  warm pool: handshake ONCE → borrow/return × N turns → 1 handshake
```

The part worth naming: this is the highest-leverage perf decision in the repo, and it's an
*avoidance* — it shows up as latency I never pay, so it's invisible in any trace. The one-shot
CLIs (`index-cmd`, `eval-cmd`) deliberately do the opposite — create, use, `pool.end()` — and
that's correct, because a process that exits immediately has no future turns to amortize over.
Matching pool lifetime to process lifetime is the actual skill, not "always pool."

**Anchor:** `db.ts:4-6` (factory), `session.ts:39` (create once), `session.ts:73` (end once).

---

## See also

- `03-per-chunk-insert-loop.md` — the upsert borrows one connection from this pool per batch.
- `05-per-turn-memory-and-trace-cost.md` — every per-turn write runs over this warm pool.
- `audit.md` §3 (pool sizing under concurrency — not yet exercised), §5.
- `study-networking` — TCP handshake, keep-alive, the pg wire protocol.
- `study-database-systems` — server-side connection limits and backend processes.
