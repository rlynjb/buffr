# Study — Distributed Systems · buffr-laptop

> The honest verdict up front: **buffr is not a distributed system.** It is a
> single-device CLI process that talks to exactly one remote dependency
> (Postgres) over one connection pool, plus a local Ollama HTTP endpoint. There
> is no second node, no replica, no worker, no queue, no consensus, no
> leader election. Most distributed-systems lenses come back `not yet
> exercised` — and that is the correct finding, not a gap in the audit.

This guide deliberately under-claims. Where a lens has no mechanism in the
repo, it says so in one line. The two or three places where a real
distributed-systems *seam* exists — even a thin one — get a pattern file. The
genuinely hard distributed-systems problem in this project (two brains, a
laptop and a phone, sharing one Supabase memory) is **designed but not built**,
and its file is labelled design-not-code throughout.

---

## The system in one diagram

The whole coordination surface of buffr is this: one process, two remote
endpoints, no peers.

```
  buffr coordination map — one node, two remote dependencies

  ┌─ Local device (one Node process) ───────────────────────────┐
  │                                                              │
  │   src/cli/ask-cmd.ts   ── the only "orchestrator"            │
  │        │                                                     │
  │        ├─► RagQueryAgent (aptkit, in-process)               │
  │        │      │                                              │
  │        │      ├─► PgVectorStore.search ──┐                   │
  │        │      └─► SupabaseTraceSink.emit ─┤ (queued)         │
  │        │                                  │                  │
  └────────┼──────────────────────────────────┼─────────────────┘
           │ HTTP (localhost)                  │ TCP (pg Pool)
           ▼                                   ▼
  ┌─ Ollama ─────────────┐         ┌─ Postgres "reindb" ────────┐
  │  gemma2:9b (gen)     │         │  schema agents             │
  │  nomic-embed-text    │         │  pgvector + HNSW           │
  │  (embeddings)        │         │  one writer (app_id=laptop)│
  └──────────────────────┘         └────────────────────────────┘

  No second buffr node. No replica. No queue. No consensus.
  The only "across a boundary" hops are: process → Ollama, process → Postgres.
```

That picture is the reason this guide is thin. The classic distributed-systems
question — *what stays correct when a participant is slow, duplicated, stale,
or unavailable?* — only has two participants to ask it about, and both are
treated as "if it's down, the command fails," which is a legitimate answer for
a single-user laptop tool.

---

## Ranked findings

What's actually here, most consequential first:

1. **The app↔Postgres boundary is the only real client/server seam.**
   `src/db.ts` hands out a `pg.Pool`; every query crosses a process boundary
   over TCP. This is where partial failure, connection limits, and
   "the remote is down" actually live. → `01-app-to-postgres-boundary.md`

2. **The trace sink buffers async writes and flushes them with an unordered
   `Promise.all`.** `src/supabase-trace-sink.ts` queues a `persistMessage`
   promise per event, then awaits them all together after the run. This is the
   one place in the repo with at-least-once / ordering semantics worth naming —
   and it has a real, mild ordering bug: `created_at` order is not guaranteed
   to match emit order. → `02-trace-sink-write-buffering.md`

3. **The two-brain shared-memory consistency problem is designed, not built.**
   `agent-layer-plan.md` and the graduation design spec describe a laptop + a
   phone both writing one Supabase `agents` schema over an HTTP gateway. *That*
   is a genuine distributed-systems problem (two writers, shared state,
   convergence, isolation). It is entirely deferred. → `03-deferred-two-brain-shared-memory.md`
   (design-not-code).

4. **Transactions exist, but they are local-Postgres transactions, not
   distributed ones.** `migrate.ts` and `pg-vector-store.ts` both wrap work in
   `begin`/`commit`/`rollback`. There is no two-phase commit, no saga, no
   cross-service transaction. The atomicity is entirely inside one Postgres
   connection — which means it belongs to **database-systems**, not here. Named
   in the audit, cross-linked out.

---

## What is `not yet exercised`

Said plainly so the file list doesn't over-promise. Each of these is expanded
in `audit.md` with the trigger that would make it real:

- **Coordination across nodes** — `not yet exercised`. One process.
- **Replication / failover** — `not yet exercised`. One Postgres, no replica reads.
- **Partitioning / sharding / quorums** — `not yet exercised`. `app_id` is a
  forward-compat *filter*, not a partition key with routing.
- **Consensus / leader election / leases** — `not yet exercised`. Nothing votes.
- **Queues / streams / backpressure** — `not yet exercised`. The trace sink's
  in-memory array is a buffer, not a queue with a consumer.
- **Idempotency keys / dedup** — partial. `upsert ON CONFLICT` is idempotent at
  the storage layer; there is no request-level dedup because there are no retries.
- **Clocks / ordering across nodes** — `not yet exercised`. Single `created_at`
  clock from one Postgres; no cross-node time reasoning.
- **Sagas / transactional outbox / reconciliation** — `not yet exercised`.

---

## Reading order

```
  00-overview.md   ← you are here
  audit.md         ← Pass 1: every lens walked, mostly "not yet exercised"
  01-app-to-postgres-boundary.md          ← the one real client/server seam
  02-trace-sink-write-buffering.md        ← buffered async writes, ordering
  03-deferred-two-brain-shared-memory.md  ← DESIGN-NOT-CODE: the future problem
```

Read `audit.md` next if you want the full lens sweep. Read the three pattern
files for the only places where coordination-correctness reasoning actually
applies to this repo.

---

## Cross-links

This generator owns **correctness across coordination boundaries**. It does
*not* re-teach its neighbors:

- **System design** — architecture, boundaries, scale tradeoffs:
  `.aipe/study-system-design/` (the local-first / cloud-mirror shape, request flow).
- **Database systems** — the storage-engine and *local* consistency mechanisms:
  `.aipe/study-database-systems/` (pgvector, HNSW, the `begin/commit` transactions,
  isolation). Every "transaction" finding here points there.
- **Debugging & observability** — how the trajectory rows become evidence:
  `.aipe/study-debugging-observability/` (the `agents.messages` trace as the
  primary observability artifact). *Note: this neighbor guide is not yet
  generated; the cross-link names where the material will live.*
