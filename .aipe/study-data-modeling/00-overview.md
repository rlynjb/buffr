# 00 · Overview — the data model at a glance

One page. The entity-relationship diagram for `buffr-laptop`, the three
highest-cost findings, and a one-line verdict per audit lens. Open `audit.md`
for the full lens walk; open the numbered pattern files for the deep reads.

## The whole schema in one frame

Five tables in the `agents` schema, one real foreign key, one deliberately
dropped one. Read this before anything else.

```
  agents schema (database reindb) — entities, columns, cardinality

  ┌─ documents ──────────────┐         ┌─ chunks ─────────────────────┐
  │ id            text  (pk) │ 1     N │ id            text  (pk)     │
  │ app_id        text       │◄- - - - │ document_id   text  (soft)   │
  │ source_type   text       │  soft   │ app_id        text           │
  │ source_path   text       │  link   │ chunk_index   int            │
  │ content       text       │ no FK   │ content       text  ◄┐ same  │
  │ meta          jsonb      │         │ embedding     vec(768)│ text  │
  │ created_at    tstz       │         │ embedding_model text │ twice │
  └──────────────────────────┘         │ meta          jsonb ─┘ (.text)│
                                       └──────────────────────────────┘
                                        idx: hnsw(embedding cosine), app_id

  ┌─ conversations ──────────┐         ┌─ messages ───────────────────┐
  │ id            uuid  (pk) │ 1     N │ id            uuid  (pk)     │
  │ app_id        text       │◄════════│ conversation_id uuid (FK,    │
  │ user_id       text       │  REAL   │   on delete cascade)         │
  │ agent_name    text       │  FK     │ role / content text          │
  │ created_at    tstz       │         │ tool_calls    jsonb          │
  └──────────────────────────┘         │ tool_results  jsonb          │
                                       │ model / tokens_used          │
  ┌─ profiles ───────────────┐         │ created_at    tstz           │
  │ id  uuid (pk) / app_id   │         └──────────────────────────────┘
  │ user_id / content / upd  │
  └──────────────────────────┘

  ══ enforced FK (cascade)   - - soft link, FK dropped on purpose
  every table carries app_id default 'laptop'; no RLS anywhere
```

Two clusters. The **retrieval cluster** (`documents` + `chunks`) is where RAG
lives — and where the integrity is deliberately loosened so the chunk table can
double as a `VectorStore`. The **trajectory cluster** (`conversations` +
`messages`) is where every agent run is recorded, and it's the only place a real
foreign key shows up. `profiles` stands alone.

## The three highest-cost findings

Ranked worst-first by what they'd cost you when the data grows or the second
device shows up.

### 1. The document→chunk write is non-atomic across two transactions

`indexDocumentRow` writes the `documents` row on the pool (one implicit
transaction), then calls `pipeline.index(...)` which lands in
`PgVectorStore.upsert` — its **own** `begin/commit` on a *different* pooled
connection. Crash between them and you get a `documents` row with no chunks, or
(on a partial pipeline failure) the inverse. Nothing rolls the pair back
together.

```
  File: src/runtime.ts:11-17   +   src/pg-vector-store.ts:40-65
  Cost: orphaned half-writes; silent corpus drift; no way to detect it
  Fix:  thread one client through both writes, or make indexing
        idempotent + add a reconciliation pass. → 07-non-atomic-...md
```

### 2. Chunk text is stored twice, editable in two places

Every chunk's text lives in `chunks.content` (a real column) **and** in
`chunks.meta.text` (jsonb). `upsert` writes both from the same source;
`search` reads `content` back out and *re-injects* it as `meta.text`. Two copies
of one fact, no constraint keeping them equal. This is information leakage in
data form.

```
  File: src/pg-vector-store.ts:46-56 (write both) / 80-84 (read+rebuild)
  Cost: an update to one copy silently disagrees with the other
  Fix:  pick content as SSOT, drop meta.text, project it on read. → 02-...md
```

### 3. `app_id` looks like tenancy but enforces nothing

Every table has `app_id text default 'laptop'`. It's filtered in the hot
search path (`where app_id = $2`) but there's **no RLS**, and `app_id` is a
constructor default, **not** derived from any auth token. Today (single device)
that's fine. The moment a second app or a second user shares this database, this
column is a filter you can forget, not a boundary the DB enforces.

```
  File: sql/001_agents_schema.sql (every table) / pg-vector-store.ts:74
  Cost: cross-tenant read the day isolation actually matters
  Fix:  RLS policies keyed on a token-derived app_id. → 05-...md (+ study-security)
```

## Verdict per lens

```
  lens                        verdict
  ──────────────────────────  ─────────────────────────────────────────
  1 schema shape              clean 5-table relational model; 2 clusters,
                              jsonb escape hatches used with discipline
  2 normalization             one real duplication (text stored twice);
                              otherwise normalized → 02
  3 indexes vs queries        hot search path fully covered (HNSW + app_id);
                              messages-by-conversation read has NO index → audit
  4 transactions/integrity    upsert is atomic; the cross-call doc+chunk
                              write is NOT; one real FK, rest soft → 07, 03
  5 migrations/evolution      single idempotent file, transactional runner;
                              no versioning table, no down-migrations → audit
  6 access pattern/storage    Postgres earns its place (vector + relational
                              colocated); SQLite-primary is system-design → audit
  7 red-flags capstone        4 flags fired, all understood + deliberate → 07-file
```

## The one-line summary

The dominant shape is a **vector store wearing a relational schema**: the
`chunks` table is engineered to be a drop-in `VectorStore`, which is why its
foreign key is dropped and its text is duplicated — both are parity costs paid
on purpose. The single highest-leverage fix is making the document+chunk write
atomic (finding 1); it's the only finding that corrupts data rather than merely
risking it later. Mostly N/A for this repo: partitioning, soft-deletes, schema
versioning beyond `001`, and RLS — all named honestly in `audit.md` as *not yet
exercised*, with the buildable target for each.
