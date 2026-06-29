# Study — Database Systems (buffr-laptop)

> The storage-engine and consistency mechanisms beneath `buffr-laptop`:
> how Postgres + pgvector executes and preserves the reads and writes this
> repo issues, and which engine guarantees the application code assumes.

This is the **applied** database-systems guide. It does not re-teach the
*shape* of the data (that's `study-data-modeling`) or *which* datastore was
chosen and how it scales (that's `study-system-design`). It teaches the
**mechanisms** — storage layout, indexes, query execution, transactions,
isolation, concurrency, durability, replication — grounded in the real files
of this repo.

```
  Where this guide sits

  study-data-modeling     the SHAPE of persistent data, does it match access?
  study-database-systems  the MECHANISMS that execute & preserve reads/writes  ← here
  study-system-design     WHICH datastore is selected and how it scales
```

---

## The repo in one diagram

The whole storage story of `buffr-laptop` is one Postgres instance (`reindb`),
one schema (`agents`), reached over one `pg.Pool`, with the `vector` extension
turning the `chunks.embedding` column into a similarity-searchable index.

```
  buffr-laptop — the datastore map

  ┌─ Application (Node, ESM) ───────────────────────────────────────┐
  │                                                                  │
  │  session.ts ── ask() ──┬─► persistMessage()  (autocommit write) │
  │                        ├─► agent.answer() ─► search() (read)     │
  │                        └─► memory.remember() ─► upsert() (txn)   │
  │                                                                  │
  │  runtime.ts ── indexDocumentRow() ─┬─► documents INSERT (txn A)  │
  │                                    └─► pipeline.index → upsert    │
  │                                                       (txn B) ⚠   │
  │  pg-vector-store.ts ── upsert() / search()                       │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  node-postgres (pg.Pool)
                                   │  bare Pool, no sizing — db.ts:4
  ┌─ Storage (Postgres + pgvector) ▼─────────────────────────────────┐
  │  database reindb · schema agents                                 │
  │                                                                  │
  │  documents ─soft link─► chunks (embedding vector(768))           │
  │                          │  HNSW (vector_cosine_ops) ◄── ANN     │
  │                          │  btree (app_id)                       │
  │  conversations ─FK─► messages (full trajectory)                  │
  │  profiles                                                        │
  │                                                                  │
  │  WAL · MVCC · READ COMMITTED (all Postgres defaults, untuned)    │
  └──────────────────────────────────────────────────────────────────┘
```

---

## The findings, ranked by consequence

The guide is verdict-first. Here's the ranking before you open a single
concept file.

**1. The `<=>` operator and the `vector_cosine_ops` opclass must match — and
here they do (`pg-vector-store.ts:75` ↔ `001_agents_schema.sql:29`).** This is
the single most consequential alignment in the repo. The HNSW index is built
`using hnsw (embedding vector_cosine_ops)`; the query orders by `embedding <=>
$1::vector`. `<=>` is cosine distance, `vector_cosine_ops` is the cosine
opclass — they agree, so the planner can use the index. Swap the query to `<->`
(L2) or `<#>` (inner product) and Postgres **silently** falls back to a
sequential scan: no error, just a full-table scan that gets slower every time
you index a document. → `03`, `04`.

**2. Documents and chunks are written in two separate transactions — a real
atomicity gap (`runtime.ts:11` vs `pg-vector-store.ts:40`).** `indexDocumentRow`
writes the `documents` row via a bare `pool.query` (autocommit), then calls
`pipeline.index()`, which routes into `PgVectorStore.upsert()` — its own
`begin`/`commit`. Two transactions, no shared atomicity. Crash between them and
you get an orphaned `documents` row with no chunks, or (on the soft link) the
reverse. This is kept on purpose — it buys `VectorStore` drop-in parity — but
it's an honest anomaly. → `05`.

**3. The chunks→documents foreign key is deliberately dropped
(`001_agents_schema.sql:16-27`).** `document_id` is a soft link: no FK, plus an
idempotent `alter table ... drop constraint if exists` to strip it from
already-migrated databases. The integrity *shape* of that choice belongs to
`study-data-modeling`; what matters here is the **mechanism** — without the FK,
Postgres does no referential lock or cascade on chunk writes, which is exactly
what lets memory chunks (`meta.kind='memory'`) ride the same table with no
`documents` row at all. → `05`, `08`, and `study-data-modeling`.

**4. Every write goes through one bare `pg.Pool` with no sizing
(`db.ts:4`).** `new pg.Pool({ connectionString })` — no `max`, no
`idleTimeoutMillis`, no `connectionTimeoutMillis`. node-postgres defaults to
`max: 10`. For a single-device CLI that's fine; the moment two `ask()` turns
overlap or a long index run holds a client, the pool is the contention point. →
`06`, `07`.

**5. The transactions that exist are correct, manual, and minimal
(`migrate.ts:8-20`, `pg-vector-store.ts:40-65`).** `begin` → work →
`commit`/`rollback` in `finally release()`. Textbook. No savepoints, no
isolation escalation, no retry loop. → `05`, `06`.

---

## Reading order

```
  01  database-systems-map ............. the engine, the query paths, the boundaries
  02  records-pages-and-storage-layout .. how a row + a 768-dim vector sit on disk
  03  btree-hash-and-secondary-indexes .. HNSW (ANN) vs btree vs seq scan
  04  query-planning-and-execution ...... the <=>/opclass alignment, EXPLAIN
  05  transactions-isolation-and-anomalies  the two-txn write, READ COMMITTED
  06  locks-mvcc-and-concurrency-control .. MVCC, ON CONFLICT, pooling contention
  07  wal-durability-and-recovery ....... WAL, fsync, what survives a crash
  08  replication-and-read-consistency .. single-node today; what changes later
  09  database-systems-red-flags-audit .. ranked risks with evidence
```

---

## Not yet exercised

This repo is a single-device, single-Postgres CLI. Honest gaps — the
mechanisms are real and the files teach them, but nothing in the repo drives
them yet:

- **Replication / failover / read replicas** — one node, no standby. There's no
  primary/replica split, no lag to reason about, no stale-read window. → `08`.
- **WAL / PITR tuning** — Postgres writes a WAL by default; nothing in the repo
  configures `wal_level`, archiving, or point-in-time restore. Durability is
  whatever the default `fsync=on` gives. → `07`.
- **Isolation beyond READ COMMITTED** — every transaction runs at the Postgres
  default. No `repeatable read`, no `serializable`, no `set transaction
  isolation level` anywhere. → `05`, `06`.
- **EXPLAIN discipline** — no `EXPLAIN`/`EXPLAIN ANALYZE` is run anywhere in the
  repo or tests. The index-vs-seq-scan claim in `04` is reasoned from the
  opclass, not measured. → `04`.
- **HNSW parameter tuning** — the index is created with default `m` and
  `ef_construction`; `ef_search` is never set per-query. → `03`.
- **Connection-pool sizing** — `db.ts:4` takes every node-postgres default. No
  `max`, no timeouts, no health checks. → `06`.

---

## Cross-links

- `study-data-modeling` — the *shape* of `documents`/`chunks`/`messages`, the
  normalization call behind the dropped FK, the soft-link integrity tradeoff.
- `study-performance-engineering` — the latency/throughput consequences of the
  HNSW index, the unsized pool, and the per-turn embed+search hot path.
- `study-system-design` — why pgvector-in-Postgres (one instance, colocated
  vector + relational) over a dedicated vector DB, and the single-device scope.
