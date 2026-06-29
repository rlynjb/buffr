# Distributed Systems — The Lens Audit (`buffr-laptop`)

Pass 1 of the audit-style shape: all nine distributed-systems lenses walked against the **actual repo**, each marked with what the codebase does (with `file:line` grounding) or with `not yet exercised` and *when* it would start to matter. Lenses that find nothing get one honest line. The three lenses with real (or designed) substance cross-link to their pattern files rather than restating them.

The framing for every verdict below: distributed systems is about **correctness when coordination crosses a boundary and any participant can be slow, duplicated, stale, or unavailable.** This repo has one process and two remote dependencies. Hold that fact next to each lens and most of them answer themselves.

---

## Lens 1 — Distributed system map

**Verdict: thin but real.** One Node process; two remote dependencies.

The coordination map is small enough to hold in your head: `createChatSession()` (`src/session.ts:34`) wires an agent that crosses exactly two boundaries — SQL to Postgres over a `pg.Pool` (`src/db.ts:4`), and HTTP to Ollama for generation and embeddings (`src/session.ts:40`, `:46`). There are no peers and no replicas. The only "node" with independent state and an independent failure domain is Postgres itself.

The full map and the ranked findings live in `00-overview.md`. The one boundary worth a deep walk is the Postgres seam → `01-app-to-postgres-boundary.md`.

---

## Lens 2 — Partial failure, timeouts, and retries

**Verdict: PARTIAL — fail-fast, no acquire timeout, no retries.**

There *is* a partial-failure surface: Postgres can be down, slow, or drop a connection mid-query. Here's how the repo handles it today:

- **No timeouts configured.** `createPool` (`src/db.ts:4`) constructs `new pg.Pool({ connectionString })` with nothing else. No `connectionTimeoutMillis` (how long to wait to *acquire* a connection), no `idleTimeoutMillis`, no `statement_timeout`. If Postgres is unreachable, `pool.query` rejects with pg's default behavior; if the pool is exhausted (it won't be here — one process, low concurrency) a `connect()` would wait indefinitely.
- **No retries anywhere.** No `persistMessage` (`src/supabase-trace-sink.ts:19`), no `startConversation` (`:4`), no `pipeline.index` call is wrapped in a retry/backoff/jitter loop. The first failure propagates.
- **Failure classification is binary.** The code does not distinguish a *retryable* failure (transient connection reset) from a *terminal* one (constraint violation). It treats every rejected promise the same: it throws, except the one deliberate swallow below.

The **one** intentional failure-containment decision: `session.ask()` (`src/session.ts:64`) wraps `memory.remember(...)` in a `try/catch` that **swallows** the error, with the comment "memory is best-effort, the turn already succeeded." That's a real classification call — a memory-write failure must not destroy an answer the user already has in hand. Everything else fails loud.

**Why this is the right call now, and the exact gap:** on a single device, fail-fast beats a retry that hangs the only user. The first turn errors visibly if the DB is down. The gap that *would* bite: **no `connectionTimeoutMillis`** means a half-open connection to a remote Supabase (not a local socket) could hang the very first `ask()` with no deadline. The deep walk is in `01-app-to-postgres-boundary.md`.

→ see `01-app-to-postgres-boundary.md`.

---

## Lens 3 — Idempotency, deduplication, and delivery semantics

**Verdict: PARTIAL — storage-level idempotency yes, request-level no.**

Split this lens in two, because the repo answers them differently:

**Storage-level idempotency: present.** The writes that *can* legitimately collide are upserts keyed on a deterministic id:
- `indexDocumentRow` → `INSERT INTO agents.documents ... ON CONFLICT (id) DO UPDATE SET content = excluded.content` (`src/runtime.ts:14`). Re-index the same doc, you replace it, you don't duplicate it.
- The design's `PgVectorStore.upsert` is `INSERT ... ON CONFLICT (id) DO UPDATE` over `agents.chunks`, with chunk ids `"<docId>#<index>"` (deterministic — `context.md`). Same property: re-indexing is naturally idempotent.

So if the `index` CLI runs twice on the same corpus, the corpus state converges to the same rows. That's real at-least-once-safe write design.

**Request-level idempotency: absent, and correctly so.** There is no idempotency *key* on a request, no dedup table, no "have I already processed this message id." `persistMessage` (`src/supabase-trace-sink.ts:19`) inserts a fresh `messages` row every call — `id uuid default gen_random_uuid()` (design schema) — so calling it twice writes two rows. **But nothing retries.** Each event is emitted once, persisted once. At-most-once delivery with no retry means duplicates can't arise, so there's nothing to dedup. The moment a retry is added (lens 2), request-level idempotency becomes a real requirement — the design's deferred HTTP gateway (`agent-layer-plan.md`) is where it would land.

**Delivery semantics, named plainly:** the trace pipeline is **at-most-once** (emit once, flush once, no retry, errors propagate after `Promise.all`). The corpus index is effectively **idempotent-write** (re-runnable to the same state). Neither is exactly-once; exactly-once isn't needed because there's no duplication source.

---

## Lens 4 — Consistency models and staleness

**Verdict: `not yet exercised`.**

A consistency model is a contract about what a *reader* can observe given concurrent *writers*. This repo has **one writer** (`app_id = 'laptop'`) and reads happen in the same process that wrote. There is no replica to read stale data from, no read-your-writes question, no convergence to reason about — Postgres gives you the single-node guarantees and that's the end of it (those guarantees are **`study-database-systems`**' territory: see `study-database-systems/05-transactions-isolation-and-anomalies.md`).

**When it starts to matter:** the instant a second writer appears — the deferred phone brain writing `agents.*` through the same Supabase. Then "did the laptop see the phone's latest memory write?" becomes a real staleness question. Named, not built: `03-deferred-two-brain-shared-memory.md`.

---

## Lens 5 — Replication, partitioning, and quorums

**Verdict: `not yet exercised`.**

No replicas, no read-replicas, no shards, no partition keys used for routing, no quorum reads or writes, no failover. There is one Postgres database (`reindb`) and one connection pool to it. `app_id` exists on every table (`context.md`) and *looks* like a partition key — but it's a tenant/isolation column with exactly one value in use (`'laptop'`), not a routing dimension across nodes. The HNSW index on `agents.chunks` (`sql/001_agents_schema.sql`) is a single-node ANN index, not a sharded one.

**When it starts to matter:** never, for this project's stated scope — the parent plan explicitly says "Don't centralize *data*; centralize the *agent layer*" (`agent-layer-plan.md`) and the corpus is small. If `reindb` itself grows read-replicas, replica staleness becomes a `study-database-systems` concern (`08-replication-and-read-consistency.md`), not this guide's.

---

## Lens 6 — Queues, streams, ordering, and backpressure

**Verdict: thin — an in-process promise buffer, not a queue.**

There *is* a buffering mechanism, and it's the second-most-interesting thing in the repo, so be precise about what it is and isn't:

`SupabaseTraceSink` keeps `private readonly pending: Promise<void>[]` (`src/supabase-trace-sink.ts:50`). `emit()` is synchronous (aptkit's contract requires it) so it can't await; it *pushes* a `persistMessage(...)` promise onto `pending` and returns immediately (`:87`). `flush()` then `await Promise.all(this.pending)` (`:92`).

Why this is **not** a distributed queue:
- It's in-process, in-memory. Crash the process before `flush()` and the buffered writes are gone — no durability, no redelivery.
- There's no consumer, no poison-message handling, no dead-letter, no offset/ack.
- There's no **backpressure**: `pending` grows unbounded for the duration of one turn. On a single turn's worth of events that's tiny (a handful of inserts); at scale it would be a memory and connection-pool problem, but the turns are short and the volume is low, so it never bites.

What it *does* expose — and this is the real lesson — is an **ordering** question. `Promise.all` resolves the inserts in an **unordered race**: whichever SQL round-trip finishes first commits first. So the row *insertion order* is nondeterministic. The repo defuses this by setting `created_at` from `event.timestamp` at emit time (`:55`, `:30`) so replay-by-`created_at` reconstructs emit order regardless of the race. Ordering is decided at *emit*, not by the flush.

→ see `02-trace-sink-write-buffering.md` for the full walk and the one place it breaks (two clocks).

---

## Lens 7 — Clocks, coordination, and leadership

**Verdict: `not yet exercised` today — but the future clock dependency is named.**

There is no distributed coordination here: no leader election, no leases, no locks across nodes, no split-brain risk, because there is only one process. There is exactly **one clock** — the laptop's — and the repo leans on it: `event.timestamp` becomes `created_at` (`src/supabase-trace-sink.ts:55`), and trajectory replay order is *defined* by that single clock's monotonicity within a run. On one device, that's sound. A single clock is always internally consistent for ordering events emitted under it.

**The forward-RFC point — write it down now because it's a one-way door:** the trace sink's ordering correctness depends on `created_at` being comparable across all events in a conversation. With one device, one clock, that holds. Add the deferred phone brain writing into the *same* `agents.messages` conversation and you now have **two clocks with skew**. `created_at`-ordering across devices would silently interleave wrong — a message stamped on a phone whose clock is 400ms behind sorts before a laptop message that actually happened first. The fix when that day comes is a logical clock (Lamport/hybrid) or server-assigned sequence, *not* wall-clock `created_at`. This is a real distributed-systems hazard the current design quietly avoids by having one writer. Named in `02-trace-sink-write-buffering.md` (Move 2.5) and `03-deferred-two-brain-shared-memory.md`.

---

## Lens 8 — Sagas, outbox, and cross-boundary workflows

**Verdict: `not yet exercised` — local transactions only.**

No multi-step distributed workflow, no compensation logic, no transactional outbox, no reconciliation job. What exists:

- **One real transaction**, and it's single-node: `runMigration` does `begin` → run script → `commit`, with `rollback` on error (`src/migrate.ts:11`). One connection, one resource manager. That's a database transaction, not a distributed one — its mechanics belong to `study-database-systems/05-transactions-isolation-and-anomalies.md`.
- **`session.ask()` is a multi-step sequence but not a transactional one** (`src/session.ts:60`): persist user turn → `agent.answer()` → `trace.flush()` → `memory.remember()`. Each step is its own autocommit write to Postgres. If `agent.answer()` throws after the user turn was persisted, you're left with a user `messages` row and no assistant reply — a partial write. There's no compensation and no outbox; the design accepts this because a dangling user turn in a single-user trajectory log is harmless (it's an observability record, not a financial ledger).

The closest thing to outbox-shaped thinking is the trace **buffer** (lens 6) — collect side-effects, flush after the main work — but it's an in-memory buffer, not a durable outbox table, so it doesn't survive a crash.

**When it starts to matter:** the deferred HTTP gateway turns `session.ask()`'s steps into cross-service calls (app → gateway → Postgres + Ollama). At that point the partial-write window becomes a cross-boundary workflow and the outbox/saga question is real. Deferred: `03-deferred-two-brain-shared-memory.md`.

---

## Lens 9 — Red-flags audit (ranked by consequence)

Ranked by what would actually bite, given the single-device reality. Most of these are **latent** — they're correct today and become risks only at the named trigger.

```
  Rank  Risk                                  Status today        Trigger that makes it real
  ────  ────────────────────────────────────  ──────────────────  ──────────────────────────────
  1     No pool acquire/statement timeout      latent (local DB)   remote Supabase + flaky network
  2     created_at-ordering = one clock         sound (1 clock)     2nd writer (phone) → clock skew
  3     ask() partial-write window              harmless (log only) cross-service gateway + retries
  4     Trace buffer unbounded, no backpressure tiny (short turns)  high event volume / long runs
  5     No request-level idempotency            moot (no retries)   any retry layer added (lens 2)
  6     app_id isolation by convention only     fine (1 tenant)     2nd app writes → needs RLS
```

**Rank 1 — no timeouts (`src/db.ts:4`).** The single most actionable gap. Add `connectionTimeoutMillis` and a `statement_timeout` before the DB stops being effectively-local. Cheap now, prevents a hung first turn later. Deep walk: `01-app-to-postgres-boundary.md`.

**Rank 2 — wall-clock ordering (`src/supabase-trace-sink.ts:55`).** Correct on one device, a silent corruption source with two. This is the design's most important deferred decision and it's already written down (lens 7). Deep walk: `02-trace-sink-write-buffering.md`.

**Rank 3 — partial-write window in `ask()` (`src/session.ts:60`).** Acceptable for a single-user observability log; revisit when it becomes a cross-service workflow.

**Ranks 4–6** are all "moot until scale/second-writer." Listing them is the audit doing its job: the risks are *named and located*, with the trigger that flips each from latent to live. None of them justify infrastructure today, and adding any would be inventing scale this repo doesn't have.

---

## What the audit found, in one paragraph

Nine lenses, three with substance. The app↔Postgres boundary is the only true client/server seam and it fails fast with no acquire timeout (real, fixable). The trace sink buffers async writes whose replay order is fixed at emit by `created_at`, not by the unordered flush race — sound on one device, a clock-skew hazard the moment a second writer exists. The genuine distributed system (laptop + phone sharing Supabase) is designed and deferred — zero code. The remaining six lenses (consistency, replication, quorums, real queues, coordination/leadership, sagas/outbox) are `not yet exercised`, and the honest verdict for a one-process, one-writer repo is exactly that.
