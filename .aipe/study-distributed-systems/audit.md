# audit.md — the distributed-systems lens inventory, walked

Pass 1 of the two-pass audit shape. One section per lens from the
distributed-systems spec. Each names what buffr-laptop *actually does* with
`file:line` grounding, or emits `not yet exercised` honestly and says when the
lens becomes relevant.

The headline you should expect before reading: **most of this is `not yet
exercised`, and that's correct.** buffr-laptop is one process with two remote
dependencies. The coordination questions that distributed systems exist to
answer mostly don't arise until a second writer appears — which is deferred
design (see `03`).

---

## 1. Distributed system map — nodes, boundaries, messages, ownership, failure domains

**Present, but minimal.** Nodes: one Node process (the client), one Postgres
(`reindb`/`agents`), one Ollama box. Boundaries: `client → Postgres` over a
pool (`src/db.ts:4`) and `client → Ollama` over HTTP (owned by aptkit; buffr
passes `cfg.ollamaHost` at `src/session.ts:40,46`). Ownership: the single
process owns all control flow and all decisions; the remotes only answer.
Failure domains: three independent processes, but no fan-out — a request
touches Ollama *and* Postgres sequentially within one `ask()`
(`src/session.ts:60-71`), never two replicas of the same thing.

→ The full map and the ranked findings live in `00-overview.md`. The only
boundary deep enough to warrant its own walk is `client → Postgres` →
**`01-app-to-postgres-boundary.md`**.

## 2. Partial failure, timeouts, and retries

**Thin — and deliberately fail-fast.** The pool (`pg.Pool`) is constructed with
*only* a connection string (`src/db.ts:4`): no `connectionTimeoutMillis`, no
`statement_timeout`, no acquire timeout, no `idleTimeoutMillis`. So:

- A slow or unreachable Postgres makes `ask()` wait on `pg`'s defaults rather
  than a buffr-imposed deadline. There is **no timeout the repo controls** on
  the database path.
- **Nothing retries.** `ask()` calls `persistMessage` → `agent.answer` →
  `trace.flush` straight through (`src/session.ts:61-64`); a thrown error
  propagates to the CLI. There is no backoff, no jitter, no retry budget,
  because there's no retry at all.
- The one explicit failure-classification choice: the memory write is wrapped
  `try/catch` and swallowed (`src/session.ts:65-69`) — a memory-write failure
  must not lose the answer the user already has. That's a deliberate
  best-effort classification of one specific operation, named in the code
  comment.

When does this need to change? The day the database call crosses a real
network under load (the deferred HTTP/Edge-Function phase). Then an unbounded
wait becomes a hang, and you need a deadline + a classified retry. Today, on
one device, fail-fast-and-surface is the right call — see the honest note in
`01-app-to-postgres-boundary.md`.

## 3. Idempotency, deduplication, and delivery semantics

**Storage-level idempotency: yes. Request-level: no.**

- **Idempotency (`ON CONFLICT`)** at the storage layer: `indexDocumentRow` does
  `INSERT ... ON CONFLICT (id) DO UPDATE` on `agents.documents`
  (`src/runtime.ts:13-16`), and the design specifies the same `ON CONFLICT
  (id) DO UPDATE` for `PgVectorStore.upsert`
  (`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`
  lines 137-143). Re-indexing the same document is safe — deterministic ids
  (`"<docId>#<index>"`) collide and update rather than duplicate.
- **Request-level idempotency: absent, and not needed yet.** `persistMessage`
  is a plain `INSERT` into `agents.messages` with no conflict clause
  (`src/session.ts:27-36`). Replaying the same user turn would write a second
  row. There's no idempotency key on the request path because **nothing
  retries** (lens 2), so there's no duplicate to deduplicate.
- **Delivery semantics: at-most-once, by omission.** No retry → each turn is
  attempted once; on failure it surfaces and is not re-sent. There is no
  at-least-once machinery (no queue, no ack/redelivery) and therefore no need
  for the effective-exactly-once dedup that at-least-once would force.

→ The trace-sink write path and its `created_at`-from-event ordering are the
nearest thing to delivery-semantics reasoning in the repo →
**`02-trace-sink-write-buffering.md`**.

## 4. Consistency models and staleness

**Trivially consistent — single writer, single reader, one Postgres.** There is
one process writing and reading `agents.*`, so stale reads, read-your-writes,
and convergence don't arise: every read sees the last write because there's
nobody else to race. The vector search reads the same `chunks` table the index
path wrote (`src/session.ts:41-43`); memory written this turn
(`memory.remember`, `:66`) is visible to the next turn's retrieval because it's
the same store on the same database.

`app_id` (default `'laptop'`) tags every row but isolates **by convention
only** — there's one writer, so it's not yet a consistency boundary. The moment
a phone writes with `app_id='buffr'` to the same schema, this lens activates:
two writers, staleness becomes real, and the convention-only isolation must
become enforced (RLS). That's named explicitly as a deferred prerequisite in
the design spec's open questions (lines 191-195) → walked in `03`.

## 5. Replication, partitioning, and quorums

**`not yet exercised.`** No replicas, no shards, no partition key beyond the
`app_id` tag (which partitions logically but isn't queried as a shard key
across nodes), no quorum, no failover. One Postgres instance. The HNSW index on
`agents.chunks` (design lines 97) is an *index*, not a partition — it belongs
to `study-database-systems`, not here. This lens becomes relevant only at a
scale buffr-laptop has explicitly deferred (the design caps the small-corpus
HNSW defaults and flags a revisit "past ~10k chunks", lines 196-198) — and even
then, replication is a separate decision not in any current plan.

## 6. Queues, streams, ordering, and backpressure

**`not yet exercised` as infrastructure — but the trace sink is the closest
shape.** There is no message queue, no stream, no consumer group, no poison-
message handling, no backpressure mechanism. What exists is an **in-memory
buffer of pending write promises** in `SupabaseTraceSink`
(`src/supabase-trace-sink.ts:50, 87-93`): `emit()` is synchronous (aptkit's
contract requires it), so each write is queued as a promise and drained by
`flush()` with `Promise.all`. That's a flush buffer, not a queue — it's
unbounded (no backpressure: a runaway agent emitting thousands of events would
grow `pending` without limit), single-consumer (`flush` awaits all at once),
and ordering is **not** preserved by the flush (the `Promise.all` race decides
insert completion order). Ordering is recovered at *read* time via
`created_at` = `event.timestamp`. → This is the one place worth a real walk →
**`02-trace-sink-write-buffering.md`**.

## 7. Clocks, coordination, and leadership

**No logical clock; physical timestamps used for replay ordering.** There is no
Lamport clock, no vector clock, no logical sequence number anywhere — **the
logical clock (absent)**. Ordering between persisted events rides entirely on a
**physical wall-clock timestamp**: `event.timestamp` is written into
`created_at` (`src/supabase-trace-sink.ts:54-82`, persisted via the
`coalesce($8::timestamptz, now())` at `src/session.ts:30`), and replay does
`ORDER BY created_at`.

No leadership, no leases, no split-brain risk — there's one process, so there's
nothing to elect and nothing to fence. **This works precisely because all
timestamps come from one machine's clock.** Two machines' clocks can disagree
by seconds; the day a phone emits events into the same `messages` table,
`ORDER BY created_at` can interleave a phone event *before* a laptop event that
actually happened first. That is the single sharpest future-RFC point in this
whole guide, and it's a direct consequence of using a physical clock where a
logical one would be needed. → set up in `02`, projected forward in `03`.

## 8. Sagas, outbox, and cross-boundary workflows

**`not yet exercised` — local transactions only.** No two-phase commit, no
saga, no compensation, no transactional outbox, no reconciliation loop. Each
`ask()` does a sequence of *independent* writes against one Postgres
(`persistMessage` for the user turn, then the trace flush's many inserts, then
the best-effort memory write — `src/session.ts:61-67`). They are **not** wrapped
in a single transaction, so a partial failure can leave the user row written
but the trajectory only partly flushed. On one device that's an acceptable,
named tradeoff (the memory write is even explicitly best-effort). There is no
cross-boundary workflow spanning Postgres *and* Ollama atomically — the Ollama
call is just a function call whose result is then persisted; there's nothing to
compensate. The migration runner *does* use a transaction
(`src/migrate.ts`, per `context.md`), but that's datastore-local DDL atomicity
→ `study-database-systems`, not a distributed saga.

## 9. Distributed-systems red flags — ranked

Ranked by consequence *for the system as it actually is today* (one device),
with the honest note that most "risks" are dormant until the deferred multi-
device phase wakes them up.

| # | finding | severity today | evidence | wakes up when |
| - | --- | --- | --- | --- |
| 1 | No deadline on the Postgres path — unbounded wait on a slow/exhausted pool | low (one user) → high (under load) | `src/db.ts:4` (bare pool, no `connectionTimeoutMillis`/`statement_timeout`) | the call crosses a real network under load |
| 2 | Replay ordering depends on one machine's wall clock (`created_at` = `event.timestamp`) | none today → high cross-device | `src/supabase-trace-sink.ts:54`; `src/session.ts:30` | a second device writes to `agents.messages` |
| 3 | Trace-flush buffer is unbounded, no backpressure | low (short runs) | `src/supabase-trace-sink.ts:50,87-93` | runs get long / agent loops grow |
| 4 | Per-turn writes aren't one transaction — partial-failure can half-write a trajectory | low (best-effort by design) | `src/session.ts:61-67` | durability/audit of trajectories becomes load-bearing |
| 5 | `app_id` isolation is convention-only (no RLS) | none today (one writer) → high multi-tenant | design spec lines 191-195; `context.md` "No RLS this phase" | app #2 / phone writes the shared schema |
| 6 | No request-level idempotency key (duplicate turn → duplicate row) | none today (no retries) | `src/session.ts:27-36` (plain INSERT) | retries are added (network path) |

Findings 2 and 5 are the two that the deferred two-brain design has to solve
*before* it ships — they're the load-bearing prerequisites, not afterthoughts.
Both are projected forward in `03-deferred-two-brain-shared-memory.md`.

## See also

- `00-overview.md` — the map and the ranked top-3.
- `01-app-to-postgres-boundary.md` — lens 1/2 deep walk.
- `02-trace-sink-write-buffering.md` — lens 6/7 deep walk.
- `03-deferred-two-brain-shared-memory.md` — DESIGN-NOT-CODE; lens 4/5/7 future.
- `study-database-systems` — transactions, isolation, the HNSW index, durability
  (the datastore-local half that this audit deliberately doesn't re-teach).
