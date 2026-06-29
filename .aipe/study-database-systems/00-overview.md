# Study — Database Systems · Overview

> `buffr-laptop`: a single Postgres instance (database `reindb`, schema `agents`)
> with the vector extension (`pgvector`) bolted on. Embeddings, source documents,
> conversation trajectories, and episodic memory all live in **one** engine. There
> is no second datastore, no cache tier, no replica. That makes the storage-engine
> questions sharp and concrete: every read and write you care about goes through
> one query planner, one transaction manager, one buffer pool.

This guide audits the storage-engine and consistency mechanisms *beneath* the repo —
the layer that actually executes and preserves your reads and writes. The neighbours:

```
  study-data-modeling     the SHAPE of the data — is the schema right for the access pattern?
  study-database-systems  the MECHANISMS — how does the engine execute and preserve it?   ← you are here
  study-system-design     WHICH datastore, and how does it scale?
```

When a finding is about *whether the schema fits the queries* (the dropped FK as a
modeling choice, normalization, column types) it belongs to data-modeling and is
cross-linked, not re-taught here. When it's about *what the engine does at runtime*
(the ANN index path, the cross-transaction write, MVCC visibility) it lives here.

---

## The through-line

```
  the question every file answers:

    how does Postgres (with pgvector) EXECUTE this read/write,
    and what guarantee does buffr's code ASSUME it gets back?

  the recurring gap:

    buffr assumes more than the engine is configured to promise.
    every red flag below is a place where the assumption and the
    mechanism have drifted apart.
```

---

## The map in one diagram

The whole storage surface buffr touches, top to bottom — the bands are the
layers every concept file in this guide drops into.

```
  buffr-laptop — the storage surface (one Postgres instance)

  ┌─ Application layer (TypeScript / aptkit) ───────────────────────────┐
  │  PgVectorStore.upsert / .search   indexDocumentRow   SupabaseTrace  │
  │  src/pg-vector-store.ts           src/runtime.ts     src/...-sink.ts│
  └───────────────────────────┬─────────────────────────────────────────┘
                              │  node-postgres (pg) — one Pool, no sizing
  ┌─ Connection layer ────────▼─────────────────────────────────────────┐
  │  pg.Pool  (src/db.ts)   →   pool.connect() borrows a session         │
  └───────────────────────────┬─────────────────────────────────────────┘
                              │  SQL over TCP
  ┌─ Query execution layer ───▼─────────────────────────────────────────┐
  │  parser → planner → executor   (seq scan vs index scan decision)     │
  └───────────────────────────┬─────────────────────────────────────────┘
                              │
  ┌─ Access methods ──────────▼─────────────────────────────────────────┐
  │  the ANN index (HNSW, vector_cosine_ops)   the B-tree PKs   app_id   │
  └───────────────────────────┬─────────────────────────────────────────┘
                              │
  ┌─ Transaction / MVCC layer ▼─────────────────────────────────────────┐
  │  begin/commit/rollback   READ COMMITTED   row versions + visibility  │
  └───────────────────────────┬─────────────────────────────────────────┘
                              │
  ┌─ Storage + durability ────▼─────────────────────────────────────────┐
  │  heap pages (8 KB)   the write-ahead log (WAL)   fsync   (no PITR)   │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## Ranked findings — verdict first

The mechanisms that carry the most weight, and the assumptions most likely to bite,
ranked by consequence. Each has a dedicated file; the full audit with evidence is in
`09-database-systems-red-flags-audit.md`.

1. **The operator/opclass alignment is the load-bearing correctness fact of the
   whole system.** `search()` orders by the cosine-distance operator (`<=>`,
   `src/pg-vector-store.ts:75`) and the ANN index (HNSW) was built with the
   matching opclass (`vector_cosine_ops`, `sql/001_agents_schema.sql:28-29`). They
   align — so the index gets used. **Build the index with a different opclass and
   nothing errors: you get a silent sequential scan and slow, still-correct
   results.** This is the single most important thing to understand about a
   pgvector deployment. → `03`, `04`.

2. **The document+chunk write is non-atomic across two transactions.**
   `indexDocumentRow` (`src/runtime.ts:11-17`) writes the `documents` row on the
   pool directly (autocommit, one transaction), then calls `pipeline.index(...)`
   which lands in `PgVectorStore.upsert` — a *second, separate* transaction
   (`src/pg-vector-store.ts:40-58`). A crash between them leaves a document row
   with no chunks. The dropped FK (a deliberate modeling choice → data-modeling)
   means the engine won't even complain. → `05`.

3. **Isolation is whatever Postgres defaults to — READ COMMITTED — and the code
   never says so.** Every `begin` in the repo (`upsert`, `runMigration`) takes the
   default. No `SET TRANSACTION ISOLATION LEVEL`, no `SELECT ... FOR UPDATE`, no
   optimistic-concurrency version column. That's *fine* for a single-device app
   with one writer — but it's an assumption, not a decision, and it's invisible.
   → `05`, `06`.

4. **MVCC is doing real work you never see, and the index churns under it.** Every
   `on conflict do update` in `upsert` writes a *new row version* and leaves the
   old one dead (`src/pg-vector-store.ts:50-54`). For an HNSW index that re-index
   on update is expensive. Re-indexing the same corpus repeatedly bloats the table
   and the index until autovacuum catches up. → `02`, `06`.

5. **The connection pool is unconfigured.** `new pg.Pool({ connectionString })`
   with no `max`, no timeouts (`src/db.ts:5`). Default `max` is 10. For one CLI
   user that's invisible; it's listed because pool sizing is the first thing that
   matters the moment a second writer appears. → `04`, and performance-engineering.

---

## Reading order

```
  01  database-systems-map ............ the engine, the query paths, where durability ends
  02  records-pages-and-storage-layout . how a chunk row + its 768-dim vector sit on disk
  03  btree-hash-and-secondary-indexes . the B-tree PKs and the ANN index (HNSW)
  04  query-planning-and-execution ..... seq scan vs index scan; the alignment that decides it
  05  transactions-isolation-and-anomalies  the two-transaction write; READ COMMITTED
  06  locks-mvcc-and-concurrency-control    row versions, dead tuples, the single-writer luck
  07  wal-durability-and-recovery ...... what fsync guarantees; what PITR would add (absent)
  08  replication-and-read-consistency . not yet exercised — one instance, no replicas
  09  database-systems-red-flags-audit . the ranked risks, evidence cited
```

---

## Not yet exercised — honest gaps

These mechanisms are real and important, but `buffr-laptop` doesn't touch them.
Each file names where it *would* become relevant; none are invented into the repo.

```
  mechanism                       status in buffr        becomes relevant when…
  ──────────────────────────────  ─────────────────────  ──────────────────────────────
  replication / read replicas     ABSENT (one instance)  a second device reads the corpus
  WAL archiving / PITR            ABSENT (default fsync)  you need point-in-time restore
  isolation > READ COMMITTED      DEFAULT, unstated      concurrent writers contend
  EXPLAIN / ANALYZE discipline    NOT IN REPO            you must prove the index is used
  HNSW param tuning (m,ef_*)      ALL DEFAULTS          recall or build time disappoints
  pool sizing (max, timeouts)     ALL DEFAULTS          a second writer shares the pool
  failover / stale-read handling  N/A (no replica)      reads move off the primary
```

The honest verdict: this is a *correct single-writer app on a single engine with
default everything*. Nothing above is a bug today. Every one becomes a real
decision the moment a second reader, a second writer, or a recovery requirement
shows up — which is exactly the boundary this guide draws.

---

## Cross-links

- **`study-data-modeling`** — owns the *shape* decisions: the dropped chunks→documents
  FK as a modeling choice, the soft-link id scheme (`"<docId>#<index>"`), column
  types, the `meta jsonb` design. This guide treats those shapes as given and audits
  what the engine *does* with them.
- **`study-performance-engineering`** — owns *measurement and tuning*: pool sizing
  under load, HNSW `ef_search`/`m` recall-vs-latency curves, EXPLAIN-driven
  optimization. This guide names *where* those knobs live in the mechanism; that
  guide turns them.

## See also

- `01-database-systems-map.md` — start here.
- `09-database-systems-red-flags-audit.md` — the ranked risks with evidence.
