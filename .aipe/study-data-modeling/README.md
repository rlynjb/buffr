# Study — Data Modeling · buffr-laptop

The audit of this repo's **persistent data**: the `agents` Postgres schema in
database `reindb` — how it's shaped, where the same fact lives twice, which
queries have a supporting index and which don't, where invariants are enforced
(the DB vs hopeful app code), and how the schema is allowed to change.

```
  the question:  does the data's shape match how it's actually
                 read and written — and can it stay correct?

  code is cheap to change; a schema with live data in it is not.
  the one migration file here (sql/001_agents_schema.sql) is the
  whole evolution story so far — so every shape decision in it is
  load-bearing until the second migration arrives.
```

## The two seams to keep straight

```
  study-data-modeling   the SHAPE of persistent data: schema,        ← you are here
                        normalization, indexes, queries, integrity.
  study-system-design   WHICH datastore + scaling/replication.
                        "use Postgres, single device, no Edge Fns"
                        is architecture → there, not here.
  study-dsa-foundations IN-MEMORY structures. The HNSW graph as an
                        algorithm is DSA; the HNSW *index on disk*
                        against the search query is data modeling → here.
```

Normalization is information-hiding for data — single source of truth, no fact
stored twice. That's the code analog in `study-software-design`; this guide
shows the **data** side of it (see `02-text-stored-twice.md`).

## Reading order

```
  00-overview.md                    the ER diagram + the 3 highest-cost findings
  audit.md                          Pass 1: all 7 lenses walked, honest gaps named

  Pass 2 — the patterns this repo actually exercises:
  01-vector-column-and-ann-index.md the embedding column + HNSW cosine index
  02-text-stored-twice.md           chunk text in chunks.content AND meta.text
  03-soft-link-no-fk.md             chunks.document_id with the FK deliberately dropped
  04-deterministic-chunk-ids.md     ids as "<docId>#<index>" and "memory:<conv>:<n>"
  05-app-id-tenant-column.md        app_id on every table — tenancy shape, no RLS
  06-trajectory-tables.md           conversations/messages as a replayable agent trace
  07-non-atomic-document-chunk-write.md  the cross-transaction write in runtime.ts
```

## The schema at a glance

```
  agents schema (database reindb) — 5 tables, 1 real FK

  ┌──────────────┐                     ┌──────────────────┐
  │ documents    │   document_id       │ chunks           │
  │ id (pk) text │◄- - - - - - - - - - │ id (pk) text     │
  │ app_id       │   SOFT LINK         │ document_id text │
  │ content      │   (no FK — dropped) │ embedding v(768) │
  │ meta jsonb   │                     │ content text     │
  └──────────────┘                     │ meta jsonb       │
                                       └──────────────────┘
  ┌────────────────┐  conversation_id  ┌──────────────────┐
  │ conversations  │  REAL FK,         │ messages         │
  │ id (pk) uuid   │◄──────────────────│ conversation_id  │
  │ app_id         │  on delete cascade│ role / content   │
  │ agent_name     │                   │ tool_calls jsonb │
  └────────────────┘                   │ tool_results     │
                                       │ model/tokens_used│
  ┌────────────────┐                   │ created_at       │
  │ profiles       │                   └──────────────────┘
  │ id (pk) uuid   │
  │ app_id/content │   (standalone — injected into system prompt)
  └────────────────┘

  ── solid arrow = enforced FK   - - - = soft link, no constraint
```

## Cross-links

- `study-database-systems` — the storage engine *beneath* this schema: how HNSW
  is laid out on disk, how MVCC handles the upsert, how the transaction in
  `pg-vector-store.ts` commits.
- `study-system-design` — the architecture *around* this schema: single-device,
  direct `pg` connection, SQLite-vs-Postgres storage choice.
- `study-security` — the trust side of `app_id`: it's a tenancy *shape* with no
  RLS and no token derivation, so it isolates nothing yet.
