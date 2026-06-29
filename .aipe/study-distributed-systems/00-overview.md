# Distributed Systems — Overview (`buffr-laptop`)

## The verdict, first

`buffr-laptop` is **not a distributed system**. It's one Node process that talks to two remote dependencies over the network: Postgres (via a `pg.Pool`) and Ollama (via HTTP). There are no peers, no replicas, no message queues, no consensus, no leader election, and — this is the load-bearing fact — **exactly one writer**. Everything writes as `app_id = 'laptop'`.

That single-writer, single-process shape is *why* most of this guide's lenses come back `not yet exercised`. Distributed systems is the study of what stays correct when coordination crosses a boundary and any participant can be slow, duplicated, stale, or unavailable. This repo has one boundary worth that scrutiny (the app↔Postgres seam), one place that buffers async writes (the trace sink), and one *designed-but-unbuilt* distributed problem (a laptop brain and a phone brain sharing one Supabase). The rest of the inventory — replication, quorums, queues, sagas, clocks-as-coordination, split-brain — is genuinely absent. Naming that honestly is the point.

## The coordination map — the whole system in one frame

Here is every boundary the running process crosses. Two of the three are network hops; both are remote dependencies, not peers.

```
  buffr-laptop — the coordination map (one process, two remote deps)

  ┌─ Process layer (one Node process) ───────────────────────────────┐
  │                                                                   │
  │   createChatSession()  src/session.ts:34                          │
  │     ├─ RagQueryAgent.answer()      (aptkit — the agent loop)      │
  │     ├─ SupabaseTraceSink           src/supabase-trace-sink.ts:49  │
  │     └─ ConversationMemory          (aptkit, over buffr's store)   │
  │                                                                   │
  └───────┬───────────────────────────────────────┬──────────────────┘
          │  hop A: SQL over pg.Pool               │  hop B: HTTP
          │  (the ONE client/server seam)          │  (model + embeddings)
          ▼                                        ▼
  ┌─ Storage layer ──────────────┐        ┌─ Provider layer ──────────┐
  │  reindb (Postgres+pgvector)  │        │  Ollama (localhost)        │
  │  schema: agents              │        │   gemma2:9b   (generate)   │
  │  documents·chunks·messages·  │        │   nomic-embed (768-dim)    │
  │  conversations·profiles      │        └────────────────────────────┘
  │  single writer: app_id=laptop│
  └──────────────────────────────┘
```

Hop A is the seam this guide cares about most — it's the only place a client and a server with separate failure domains exchange state. Hop B (Ollama) is a network call too, but its failure handling and retry behavior belong to **`study-networking`** (transport, timeouts, pooling) and **`study-runtime-systems`** (the bounded agent loop); this guide names it on the map and moves on.

## Ranked findings — what's actually here

Verdict-first, most consequential at the top:

1. **The app↔Postgres boundary is the only real client/server seam, and it fails fast with no acquire timeout.** `createPool` (`src/db.ts:4`) hands `pg` a bare `connectionString` — no `connectionTimeoutMillis`, no `statement_timeout`, no `idleTimeoutMillis`. On a single device against a local-ish Postgres this is fine; the first turn errors loudly if the DB is down rather than hanging a user-facing retry. The deep walk and the exact gap are in `01-app-to-postgres-boundary.md`.

2. **The trace sink buffers async writes, but replay ordering is decided at *emit*, not by the flush race — so ordering is sound on one device.** `SupabaseTraceSink.emit()` (`src/supabase-trace-sink.ts:53`) queues one `persistMessage` promise per event and `flush()` awaits them with an **unordered** `Promise.all` (`:92`). The inserts race. But `created_at` is set from `event.timestamp` at emit time (`:55`, coalesced in `persistMessage` at `:30`), so replay-by-`created_at` reconstructs emit order regardless of which insert lands first. This is the most interesting correctness fact in the repo. The deep walk — and the one place it *would* break (cross-device clock skew) — is in `02-trace-sink-write-buffering.md`.

3. **The real distributed problem exists only on paper.** The design spec (`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`) and the parent plan (`agent-layer-plan.md`) describe a future where a laptop brain and a phone brain both write `agents.*` through one Supabase, behind an HTTP gateway with per-app JWTs and RLS. *That* is a genuine distributed system — multiple writers, shared state, isolation-by-token, ordering under two clocks. It is **deferred, design-only, zero lines of code.** Walked — clearly labeled as design — in `03-deferred-two-brain-shared-memory.md`.

4. **Idempotency is storage-level, not request-level.** The writes that *can* collide are made idempotent at the storage layer: `indexDocumentRow` uses `INSERT ... ON CONFLICT (id) DO UPDATE` (`src/runtime.ts:14`), and the design's `PgVectorStore.upsert` is `ON CONFLICT (id) DO UPDATE`. But nothing *retries* a request, so there is no request-level idempotency key, no dedup of duplicated work — because nothing duplicates work yet. Covered in `audit.md` lens 3.

5. **Local transactions only.** `runMigration` wraps a script in `begin/commit/rollback` (`src/migrate.ts:11`). That's a single-node, single-connection transaction — no two-phase commit, no saga, no outbox, because there is no second resource manager to coordinate with. The trace-sink writes are not even wrapped in a transaction (each `persistMessage` is its own autocommit insert). Covered in `audit.md` lens 8.

## The honest ledger — what's `not yet exercised`

Six of the nine lenses find nothing real in the running repo. This table is the guide's spine; `audit.md` walks each in full.

```
  Lens                                         Verdict in this repo
  ──────────────────────────────────────────   ─────────────────────────────────
  1 distributed-system-map                     thin — 1 process, 2 remote deps
  2 partial-failure/timeouts/retries           PARTIAL — fail-fast, no acquire timeout, no retries
  3 idempotency/dedup/delivery semantics       PARTIAL — storage ON CONFLICT yes, request-level no
  4 consistency models / staleness             not yet exercised — one writer, one reader
  5 replication / partitioning / quorums        not yet exercised — no replicas, no shards
  6 queues / streams / ordering / backpressure  thin — in-process promise buffer, no real queue
  7 clocks / coordination / leadership          not yet exercised (one clock) — FUTURE risk named
  8 sagas / outbox / cross-boundary workflows    not yet exercised — local tx only
  9 red-flags audit                            ranked at the end of audit.md
```

Under-claiming is the correct posture here. A repo with one writer and one process does not have a consistency model to reason about; saying it does would be inventing infrastructure. The two places this guide *does* go deep (the Postgres seam, the trace-sink ordering) are real, and the one forward-looking file is fenced off as design throughout.

## Reading order

`README.md` has the full list. Short version: this overview → `audit.md` (every lens) → the three pattern files (`01` Postgres seam, `02` trace-sink ordering, `03` the deferred two-brain design).

## See also

- `study-system-design/07-deferred-body.md` — the same deferred-phone decision from the architecture side.
- `study-database-systems/05-transactions-isolation-and-anomalies.md` — the single-node transaction mechanics this guide cross-links instead of re-teaching.
- `study-debugging-observability/` — the trace sink as an evidence artifact.
