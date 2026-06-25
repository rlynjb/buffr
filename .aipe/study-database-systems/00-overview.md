# Database Systems — buffr-laptop

> The storage-engine and consistency mechanisms beneath a single-device, local-first RAG agent that persists to **Postgres 15+ with pgvector**, schema `agents`, database `reindb`. One Postgres process, one laptop, one connection pool, no replicas.

This guide reads buffr through the **mechanisms used to execute and preserve reads and writes** — not the shape of the data (that's `study-data-modeling`), not which datastore was chosen or how it scales (that's `study-system-design`). The question every file answers:

```
  how does Postgres execute and preserve buffr's reads and writes,
  and which engine guarantees does the application actually assume?
```

---

## The repo in one diagram

The whole storage story fits on one page. Every read and write in buffr flows through one `pg.Pool` into one Postgres process; the only exotic part is the `vector(768)` column and its HNSW index.

```
  buffr storage map — one process, one pool, one engine

  ┌─ Application layer (TypeScript, ESM) ───────────────────────────┐
  │                                                                  │
  │  index-cmd     chat (session)  eval-cmd                          │
  │     │             │              │                               │
  │     ▼             ▼              ▼                               │
  │  indexDocumentRow PgVectorStore  PgVectorStore                   │
  │  (runtime.ts)   .upsert/.search  .search                         │
  │                 + memory chunks                                  │
  │                 (createConversationMemory → same .upsert)        │
  │     │             │              │                               │
  └─────┼─────────────┼──────────────┼───────────────────────────────┘
        │             │              │     all share one pg.Pool
  ┌─────▼─────────────▼──────────────▼─── Driver layer (node-postgres) ┐
  │   pg.Pool  →  pooled TCP connections  →  text protocol + $1 params │
  └─────────────────────────┬─────────────────────────────────────────┘
                            │  SQL over TCP (localhost:5432)
  ┌─ Storage engine (Postgres 15+, pgvector) ──────────────────────────┐
  │                                                                     │
  │  agents.documents   ── heap (8KB pages) ── PK btree on id           │
  │  agents.chunks      ── heap ── PK btree on id                       │
  │                       └ knowledge chunks   id "<docId>#<n>"         │
  │                       └ memory chunks       id "memory:<conv>:<n>"  │
  │                       └ embedding vector(768) ── HNSW graph index   │
  │                       └ app_id ── btree index                       │
  │  agents.conversations / messages / profiles ── heap + PK btree      │
  │                                                                     │
  │  MVCC row versions · WAL (write-ahead log) · READ COMMITTED default │
  └─────────────────────────────────────────────────────────────────────┘
```

The interesting surface area is small and worth knowing cold: a vector column, an approximate-nearest-neighbor index, a cosine-distance operator, and exactly two places that open explicit transactions. Everything else is Postgres defaults the code never touches — which is itself the most important finding.

---

## Ranked findings — what's most consequential

**1. The retrieval hot path rides one approximate index, and the operator must match the index opclass.** `search()` in `src/pg-vector-store.ts:67-85` orders by `embedding <=> $1::vector` (cosine distance) and the index `chunks_embedding_hnsw` is built `using hnsw (embedding vector_cosine_ops)` (`sql/001_agents_schema.sql:28-29`). The `<=>` operator and the `vector_cosine_ops` opclass are a matched pair. Use `<->` (L2) or `<#>` (inner product) instead and the planner cannot use this index — it silently falls back to a full scan. This alignment is the single most load-bearing line in the storage layer. → `03-btree-hash-and-secondary-indexes.md`, `04-query-planning-and-execution.md`

**2. Search returns *approximate* nearest neighbors, not exact ones — by design, and the repo never tunes it.** HNSW is an approximate-NN index: it walks a navigable small-world graph and can miss a true top-k neighbor. buffr accepts that tradeoff (recall for speed) but never sets `hnsw.ef_search`, never sizes `m`/`ef_construction`, and `eval-cmd.ts` measures P@1/R@3 on the *approximate* results without knowing the exact baseline. → `03-btree-hash-and-secondary-indexes.md`

**3. Exactly one write path is transactional, and it's the right one.** `upsert()` wraps a batch of chunk inserts in `begin … commit … rollback` (`src/pg-vector-store.ts:40-64`); `runMigration()` does the same for the whole schema (`src/migrate.ts:11-19`). Every *other* write — `indexDocumentRow`, `startConversation`, `persistMessage`, the trace sink — is a bare `pool.query()` running in its own implicit single-statement transaction. That means the documents row and its chunks are **not** written atomically together. → `05-transactions-isolation-and-anomalies.md`

**4. The schema deliberately dropped the chunks→documents foreign key.** `sql/001_agents_schema.sql:16-17` documents the choice in a comment, and line 27 actively drops any pre-existing FK (`alter table … drop constraint if exists chunks_document_id_fkey`). `document_id` is a *soft* link — a plain `text` column with no referential integrity — so the VectorStore contract (which upserts chunks with no notion of a documents row) keeps drop-in parity. This is a real integrity tradeoff made on purpose. The dropped FK now does double duty: episodic **memory chunks** (written by aptkit's `createConversationMemory` into the *same* table via `memory.remember`, `src/session.ts:53,67`, with ids like `memory:<conv>:<n>` and `meta.kind='memory'`) have no documents row at all — a hard FK would reject every one of them. → `05-transactions-isolation-and-anomalies.md`, cross-link `study-data-modeling`

**5. Durability, isolation, concurrency, recovery, and replication all run on untouched Postgres defaults.** READ COMMITTED isolation, MVCC, WAL with `synchronous_commit=on`, no replicas, no backup script in the repo. For a single-device laptop agent with one writer at a time, the defaults are correct — but the code makes no isolation or durability *decisions*, so several mechanisms below are taught against defaults, not against repo configuration. → `06`, `07`, `08`

---

## Reading order

```
  00  overview ......................... you are here
  01  database-systems-map ............. the datastore, engine, query paths, durability edges
  02  records-pages-and-storage-layout . heap pages, the vector(768) type, TOAST, the cost model
  03  btree-hash-and-secondary-indexes . PK btrees, HNSW ANN vs exact scan, app_id btree
  04  query-planning-and-execution ..... how search/upsert plans run, EXPLAIN, N+1 in indexing
  05  transactions-isolation-and-anomalies . the two BEGIN/COMMIT sites, implicit txns, the dropped FK
  06  locks-mvcc-and-concurrency-control . MVCC, row locks, ON CONFLICT, single-writer reality
  07  wal-durability-and-recovery ...... WAL, fsync, crash recovery, the missing backup path
  08  replication-and-read-consistency . not yet exercised — when one replica becomes relevant
  09  database-systems-red-flags-audit . ranked storage/consistency risks with evidence
```

---

## `not yet exercised` — named honestly

The repo is a single-device laptop agent. These mechanisms exist in Postgres but buffr never reaches for them. Each file says so where the topic lands; collected here so the gaps are visible at a glance:

- **Replication / read replicas / failover** — one Postgres process, no standby. There is no replica to lag, no failover to handle, no stale-read window. Becomes relevant the moment a second device reads `reindb`. → `08`
- **Isolation levels beyond READ COMMITTED** — the code never issues `set transaction isolation level`. No REPEATABLE READ, no SERIALIZABLE, no `select … for update`. → `05`, `06`
- **Explicit locking / optimistic concurrency / retry loops** — no `SELECT … FOR UPDATE`, no version columns, no serialization-failure retry. The single-writer reality means lock contention never materializes. → `06`
- **WAL tuning / replication slots / PITR** — `wal_level`, `synchronous_commit`, `archive_command` are all defaults. No point-in-time-recovery setup, no `pg_basebackup`, no WAL archiving. → `07`
- **Backup & restore path** — there is no `pg_dump` script, no restore runbook, no automated snapshot in the repo. Durability against a *disk* loss is unaddressed (WAL only protects against *crash*, not drive failure). → `07`, `09`
- **Query planner work** — no `EXPLAIN`/`EXPLAIN ANALYZE` anywhere, no `ANALYZE` cron, no statistics tuning. The code trusts the planner blind. → `04`
- **HNSW index parameters** — `m`, `ef_construction`, `hnsw.ef_search` are all left at pgvector defaults. The recall/latency knob is never turned. → `03`
- **Connection-pool sizing** — `createPool` takes only a connection string (`src/db.ts:4-6`); `max`, idle timeout, and statement timeout are all driver defaults. → `01`, `04`

---

## Cross-links to neighboring guides

- **`study-data-modeling`** — owns the *shape*: why `chunks.id` is `"<docId>#<index>"`, the jsonb `meta` columns, normalization of the soft `document_id` link, whether indexes match access patterns. This guide owns the *mechanism* that executes against that shape.
- **`study-system-design`** — owns *which* datastore (Postgres+pgvector colocated, single instance) and how it would scale. This guide owns how that one instance executes and preserves reads/writes.
- **`study-performance-engineering`** — owns the latency budget and profiling. This guide explains *why* the HNSW index and connection pooling matter to that budget; the measurement work lives there.
- **`study-networking`** — owns the TCP/connection transport between `pg.Pool` and Postgres. This guide treats the pool as a storage seam; the socket lifecycle and timeouts live there.
- **`study-runtime-systems`** (already generated) — owns the event loop and async lifecycle that drives `await pool.query()`. This guide owns what Postgres does once the query lands.

---

Updated: 2026-06-24 — reconciled against current code: `ask`/`ask-cmd` replaced by the `chat` REPL over a long-lived warm pool (`src/session.ts`); memory chunks now arrive via aptkit's `createConversationMemory` (library, not inline) into `agents.chunks` (`memory:<conv>:<n>`, `meta.kind='memory'`); pinned the `memory.remember` line ref to `src/session.ts:67`. The `<=>`/`vector_cosine_ops` alignment (finding 1) and the cross-transaction document+chunk write (finding 3) re-verified — both unchanged.
