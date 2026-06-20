# Distributed Systems — Lens Audit (Pass 1)

> One file, every lens, walked against the actual repo. The honest headline:
> **most lenses come back `not yet exercised`.** buffr is a single-device
> process with two remote dependencies (Postgres, Ollama). The lenses that
> *do* land get one tight paragraph and a cross-link to the pattern file that
> walks them. The rest get one line plus the trigger that would make them real.
>
> This is a CREATE-mode audit grounded in `src/` as of the as-built state on
> 2026-06-19. Inferred runtime behavior is labelled. Every applied claim cites
> a `file:line` range.

The lens inventory comes from the generator spec's concept list: coordination
map, partial failure, idempotency/delivery, consistency/staleness,
replication/partitioning/quorums, queues/ordering/backpressure,
clocks/coordination/leadership, and sagas/outbox. Plus the project-asked
lenses: transactions, and the deferred two-brain problem.

---

## Lens 1 — Coordination map (nodes, boundaries, messages, ownership)

**Verdict: one node, two remote dependencies. No peer coordination.**

There is exactly one process — a CLI invocation (`src/cli/ask-cmd.ts:19-38`,
`index-cmd.ts`, `eval-cmd.ts`). It crosses two boundaries:

- **process → Postgres**, over a `pg.Pool` created in `src/db.ts:4-6`. Every
  `pool.query` / `client.query` is a message across this boundary.
- **process → Ollama**, over HTTP (localhost), inside aptkit's
  `OllamaEmbeddingProvider` and `GemmaModelProvider` (wired at
  `ask-cmd.ts:20,26`). buffr does not own this code; it owns the call site.

State ownership is unambiguous: **Postgres owns all durable state** (corpus,
chunks, conversations, messages, profile). The process owns only transient
state for the duration of one command. There is no coordination *between*
nodes because there is only one. → walked in `01-app-to-postgres-boundary.md`.

---

## Lens 2 — Partial failure, timeouts, retries, jitter

**Verdict: fail-fast, no retries, no explicit timeouts. Correct for a CLI.**

When Postgres or Ollama is unavailable, the awaited promise rejects and the
command throws — e.g. `ask-cmd.ts:15` throws on missing `DATABASE_URL`, and any
`pool.query` rejection propagates straight out of `await agent.answer(...)`
(`ask-cmd.ts:34`) to an unhandled process exit. There is **no retry loop, no
backoff, no jitter, no circuit breaker, and no application-level timeout** on
either boundary. The `pg.Pool` carries node-postgres defaults
(`src/db.ts:4-6`); no `connectionTimeoutMillis` / `statement_timeout` is set.

This is the right call for a single-user, human-in-the-loop CLI: a failed
`ask` just prints an error and the user re-runs. Retries would matter the
moment this becomes a server handling concurrent callers. → the failure
semantics of the boundary are walked in `01-app-to-postgres-boundary.md`.

---

## Lens 3 — Idempotency, deduplication, delivery semantics

**Verdict: storage-level idempotent writes; no request-level dedup (none needed).**

Two writes are idempotent by construction:

- `PgVectorStore.upsert` uses `insert ... on conflict (id) do update`
  (`src/pg-vector-store.ts:47-56`). Re-indexing the same chunk id overwrites
  rather than duplicating. Chunk ids are aptkit's deterministic `"<doc>#<index>"`.
- `indexDocumentRow` uses the same `on conflict (id) do update` for the
  documents row (`src/runtime.ts:11-16`).

The trace writes are **not** idempotent and **not** keyed: `persistMessage`
does a bare `insert into agents.messages` (`src/supabase-trace-sink.ts:14-18`)
with a server-generated UUID. If the same event were emitted twice it would
insert twice. That's fine *today* because nothing retries the sink — but it's
the at-least-once seam to watch. → walked in `02-trace-sink-write-buffering.md`.

No at-most-once / exactly-once machinery exists because there is no delivery
layer (no queue, no message broker, no retrying caller).

---

## Lens 4 — Consistency models and staleness

**Verdict: strong, read-your-writes by default. One writer, one reader, one DB.**

Everything reads and writes the single Postgres instance. Within a command, a
write is committed before the next read (the `index` CLI writes the documents
row, then `pipeline.index` populates chunks — `runtime.ts:11-17`). There are no
replicas, so **no replica lag, no stale reads, no eventual-consistency
convergence to reason about.** The only "consistency" subtlety is the HNSW
index being approximate — but that's recall, not a distributed-consistency
property, and it belongs to **database-systems**
(`.aipe/study-database-systems/`).

This lens becomes real *only* in the deferred two-brain design, where a laptop
and a phone both write the shared `agents` schema and each holds a local cache.
→ `03-deferred-two-brain-shared-memory.md` (design-not-code).

---

## Lens 5 — Replication, partitioning, quorums, failover

**Verdict: `not yet exercised`.**

One Postgres instance, no read replicas, no write failover, no quorum reads or
writes. `app_id` (`pg-vector-store.ts:27`, default `'laptop'`; column on every
table in `sql/001_agents_schema.sql`) looks like a partition key but is a
forward-compat **filter** — `search` does `where app_id = $2`
(`pg-vector-store.ts:74`), not partition routing. There is one value (`laptop`)
in practice. **Trigger:** this lens activates when a second writer appears and
`app_id` becomes a real tenant boundary with RLS — explicitly deferred in the
design spec's open questions.

---

## Lens 6 — Queues, streams, ordering, backpressure

**Verdict: `not yet exercised` as infrastructure; one in-memory buffer with a
real ordering quirk.**

There is no queue, no stream, no broker, no consumer, no poison-message
handling, no backpressure. The closest thing is `SupabaseTraceSink.pending`
(`src/supabase-trace-sink.ts:24`) — an in-memory array of in-flight write
promises drained by `flush()`'s `Promise.all` (`:37-39`). That is a *buffer*,
not a queue: no consumer loop, no bound, no spillover.

It does carry one honest **ordering bug**: each `emit` fires its
`persistMessage` immediately and independently (`:30,32-33`), and `flush` awaits
them with an unordered `Promise.all`. The `agents.messages.created_at` default
is `now()` evaluated *server-side at insert time* — so two events emitted in
order A-then-B can land with B's `created_at` ≤ A's if B's insert wins the race.
Replaying the trajectory by `created_at` can scramble turn order under
concurrency. → walked in `02-trace-sink-write-buffering.md`, including the
one-line fix (sequence column or `await` per emit).

---

## Lens 7 — Clocks, coordination, leadership, split-brain

**Verdict: `not yet exercised`.**

Time comes from one source: Postgres `now()` on insert
(`sql/001_agents_schema.sql:11,37,49,57`). With a single DB there is no clock
skew across nodes, no logical clocks, no leases, no leader election, no
split-brain risk — there is nothing to elect a leader *of*. **Trigger:** two
writers (laptop + phone) sharing state would introduce cross-node ordering, and
*then* you'd need either a logical clock or last-writer-wins on a trusted clock.
Named in `03-deferred-two-brain-shared-memory.md`.

---

## Lens 8 — Sagas, transactional outbox, cross-boundary workflows

**Verdict: `not yet exercised`. Local transactions only.**

There are real transactions, but they are **single-Postgres-connection**
transactions, not distributed workflows:

- `runMigration` wraps the whole schema script in one
  `begin`/`commit`/`rollback` (`src/migrate.ts:10-20`).
- `PgVectorStore.upsert` wraps a batch of chunk upserts in one transaction
  (`src/pg-vector-store.ts:40-64`) so a partial batch can't half-commit.

Neither crosses a service boundary. There is **no saga** (no compensating
actions across steps), **no transactional outbox** (the trace sink writes
directly to `agents.messages`, not to an outbox table drained by a relay), and
**no reconciliation job**. The atomicity guarantee here is entirely a
database-engine property → see `.aipe/study-database-systems/` for the
transaction/isolation walk; this guide only notes that the boundary is *not*
crossed.

The one place a cross-boundary workflow *almost* exists: `index` writes the
`documents` row (Postgres) and then calls `pipeline.index`, which embeds via
Ollama (HTTP) and writes chunks (Postgres) — `runtime.ts:11-17`. If Ollama
fails after the documents row commits, you get a documents row with no chunks.
That's a real two-step-without-compensation hole, but at single-device scale
the fix is "re-run `index`," and `on conflict do update` makes the re-run
clean. Worth knowing; not worth a saga.

---

## Cross-links

- Transactions / isolation / HNSW recall → `.aipe/study-database-systems/`
- Architecture, boundaries, the local-first shape → `.aipe/study-system-design/`
- Trajectory rows as observability evidence → `.aipe/study-debugging-observability/`
  (not yet generated; named for where it will live)
