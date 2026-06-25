# Data Modeling Audit — buffr-laptop

Pass 1. Seven lenses, walked against `sql/001_agents_schema.sql` and the
code that reads/writes it. Worst-first within each lens. Every claim carries
`file:line` or an honest `not yet exercised`. Where a finding has a dedicated
pattern file, this audit cross-links rather than restating.

**Verdict up front.** The schema is honest and small — five tables, one
schema, one Postgres instance. It does three things right: a real
`vector(768)` column with the correct ANN index (HNSW + `vector_cosine_ops`),
deterministic chunk ids that make re-indexing idempotent, and one genuine
referential constraint where it matters most (messages → conversations,
`on delete cascade`). It carries two deliberate compromises that you must be
able to defend: **text is physically stored twice** in `chunks`, and
`chunks.document_id` is a **soft link with the FK explicitly dropped**. Both
are traceable to the same root cause — the schema is shaped to satisfy an
external `VectorStore` contract that knows nothing about `documents` rows.
Everything tenant-related (`app_id`) is in *shape only*: no RLS, no
token-derivation. That's the highest-risk surface if this ever leaves
single-device.

---

## 1. The data model and its shape

The model is discernible and correct — not a JSON blob, not one wide table.
Five tables across two natural clusters:

- **corpus / retrieval**: `documents` (`sql/001_agents_schema.sql:4-12`) →
  `chunks` (`:14-25`), linked by a soft `document_id`.
- **trajectory**: `conversations` (`:32-38`) → `messages` (`:40-50`), the one
  hard FK in the schema.
- **profile**: `profiles` (`:52-58`), standalone, read latest-by-`updated_at`.

The split matches the access pattern cleanly: corpus is write-once/read-many
under vector search; trajectory is append-only per run; profile is a
single-row lookup. → full diagram + the deep walk in `00-overview.md` and the
pattern files.

One refinement worth naming: `chunks` now holds **two populations** —
corpus chunks (`id = "<docId>#<index>"`) and episodic-memory chunks
(`id = "memory:<conv>:<n>"`, `meta.kind = 'memory'`) written by `@aptkit/memory`
through the same `PgVectorStore` (`src/session.ts:53,67`). Memory rows carry no
`documents` parent — which the dropped FK (lens 6) is exactly what permits.
They're distinguished by `meta.kind` at read time (the recall path over-fetches
then filters on `kind='memory'`), not by a column or a separate table.

No red flag here. The data has real structure and the schema reflects it.

## 2. Normalization and duplication

**This is the worst finding in the repo, and it's deliberate.** Chunk text
is stored in *three* places that must agree:

- `chunks.content` — the text column (`sql/001_agents_schema.sql:22`).
- `chunks.meta` jsonb — the whole aptkit `meta` object is written verbatim
  (`src/pg-vector-store.ts:55`, `$8 = c.meta`), and `meta.text` is the same
  string that `content` was derived from one line earlier
  (`src/pg-vector-store.ts:46`, `content = c.meta.text`).
- On read, `content` is reconstructed back *into* `meta.text`
  (`src/pg-vector-store.ts:83`) so the aptkit citation shape round-trips.

So the same chunk string lives in `content` AND inside the `meta` jsonb of
the same row. Nothing enforces they stay equal — if a future writer updates
one and not the other, the row holds two truths. This is the DB analog of
information leakage (cross-link `study-software-design` → information-hiding).
It's defensible: `content` exists so SQL can read text without parsing jsonb,
and `meta` exists because the `VectorStore` contract hands back an opaque
`meta` blob. But it's a fact stored twice in one row. → full walk in
`02-text-stored-twice.md`.

Second instance, milder: `chunk_index` is a column (`:21`) *and* lives in
`meta.chunkIndex` (`src/pg-vector-store.ts:45`). `document_id` is a column
(`:16`) *and* lives in `meta.docId` (`src/pg-vector-store.ts:44`). Same
sidecar-redundancy pattern, smaller payload. The `content`/`meta.text`
duplication now also applies to **memory rows**: `@aptkit/memory` sets
`meta.text` (`conversation-memory.ts:84`) and the upsert derives `content` from
it (`pg-vector-store.ts:46`) — same finding, second writer.

## 3. Indexing vs query patterns

Two indexes on `chunks`, and both earn their place against a real query:

- **`chunks_embedding_hnsw`** (`sql/001_agents_schema.sql:28-29`) — HNSW over
  `vector_cosine_ops`. Serves the `order by embedding <=> $1::vector`
  ANN search in `src/pg-vector-store.ts:74`. Without it that ORDER BY is a
  full-table sequential scan computing distance to every chunk. → deep walk
  in `01-vector-column-and-ann-index.md`.
- **`chunks_app_id`** (`:30`) — B-tree on `app_id`. Serves the
  `where app_id = $2` filter in the same search (`src/pg-vector-store.ts:75`).
  Today with one tenant (`'laptop'`) it's low-value (the whole table is one
  app_id), but it's the correct index for the multi-tenant future. →
  `05-app-id-tenant-column.md`.

**One honest gap.** The HNSW index and the `app_id` filter don't compose. The
query filters `app_id` *and* orders by vector distance, but HNSW can't use a
B-tree predicate inside its graph traversal — Postgres runs ANN, then filters
`app_id`, which under multiple tenants can under-fill `k` (post-filtering an
ANN result). Single-tenant today, so `not yet exercised` as a real problem —
but it's the index-vs-query mismatch to watch. Partial/partitioned HNSW per
tenant is the fix when it bites.

`profiles` lookup (`src/profile.ts:5`,
`where app_id=$1 order by updated_at desc limit 1`) has **no supporting
index** — full scan + sort. Fine at current row counts (a handful of
profiles); name it if profiles ever grow.

No N+1 patterns. `chunks` upsert loops one query per chunk inside a single
transaction (`src/pg-vector-store.ts:43-57`) — that's a batch in a txn, not an
N+1 across a request boundary. `eval-cmd.ts` loops one `pipeline.query` per
eval row (`src/cli/eval-cmd.ts:24-32`), which is the intended shape (one ANN
search per labeled query), not an accidental fan-out.

## 4. Transactions and integrity

**Constraints present:**

- One real FK: `messages.conversation_id → conversations.id on delete cascade`
  (`sql/001_agents_schema.sql:42`). Delete a conversation, its messages go
  with it — atomic at the DB. The one place the DB guards an invariant rather
  than hoping app code does.
- `not null` on every load-bearing column (`content`, `embedding`,
  `chunk_index`, `app_id`, `source_type`). `embedding vector(768) not null`
  (`:22`) is the strongest one — a null or wrong-dim vector can't enter.
- PKs everywhere: `text` PKs on `documents`/`chunks` (deterministic ids),
  `uuid` PKs on the trajectory/profile tables.
- Dimension is enforced twice: at the DB by `vector(768)` (`:22`) and in app
  code by `assertDim` before any write or search
  (`src/pg-vector-store.ts:32-36`). A mismatch throws, never truncates — this
  is a stated must-not-change constraint and the code honors it.

**Atomicity:** chunk upsert wraps all chunks of a document in
`begin … commit` with rollback on error (`src/pg-vector-store.ts:42,58,60`).
The migration runner does the same for the whole DDL script
(`src/migrate.ts:11-14`). Both are real transactions.

**The integrity gap:** `indexDocumentRow` writes the `documents` row, then
calls `pipeline.index` which upserts `chunks` — across **two separate
connections, not one transaction** (`src/runtime.ts:11-17`). If the document
insert commits and chunk indexing then throws, you get a `documents` row with
no `chunks`. There's no FK to catch the inverse either (chunks with no
parent), because the FK was dropped (lens 6 / `04-soft-link-no-fk.md`). The
invariant "a document and its chunks exist together" is enforced by **neither
the DB nor a wrapping transaction** — it's hoped for by call order.

## 5. Migrations and evolution

One migration file, `sql/001_agents_schema.sql`, run transactionally by
`src/migrate.ts`. It's written defensively for live data:

- Every `create` is `if not exists` (`:2,4,14,32,40,52`) — re-runnable.
- Every index is `create index if not exists` (`:28,30`) — idempotent.
- The FK drop is `alter table … drop constraint if exists chunks_document_id_fkey`
  (`:27`) — idempotent, and crucially backward-compatible: it cleans up
  databases that were migrated *before* the FK was removed. This is the one
  genuine schema-evolution event in the repo, and it's done correctly — a
  destructive change (dropping a constraint) made safe-to-replay.

**Honest gaps:**

- **No migration versioning / ledger.** There's no `schema_migrations` table,
  no ordering, no "which migrations have run" record. It's one file replayed
  idempotently. That works for one file; it does not scale to `002`, `003`.
  `not yet exercised` — there is no second migration yet.
- **No down migrations / rollback scripts.** Forward-only by idempotent
  replay.
- **No backfill machinery.** Not needed yet (single device, re-index from
  source is cheap), but there's no pattern for "add a column to a populated
  `chunks`."

## 6. Access patterns and storage choice

The storage shape matches the access pattern, and the one place it bends is
the most interesting modeling decision in the repo.

`chunks.document_id` is a `text` column with **the FK deliberately dropped**
(`sql/001_agents_schema.sql:16-17` comment, `:27` the `drop constraint`). The
reason is in the schema comment verbatim: *"the VectorStore contract upserts
chunks with no notion of a documents row, so a hard FK would break drop-in
parity."* aptkit's `VectorStore.upsert` (`src/pg-vector-store.ts:38`) takes
`{id, vector, meta}` — it has never heard of `documents`. A hard FK would
reject any chunk written before its parent document, breaking the contract.
So the relational integrity was traded away to keep the store a drop-in
implementation of an external interface. **This is a relational schema
bending to fit a document-store-shaped contract** — exactly the seam this
lens watches for. → full walk in `04-soft-link-no-fk.md`.

Storage choice itself is right: relational Postgres for the trajectory and
corpus metadata, `pgvector` colocated in the *same* instance for the
embeddings (no separate vector DB to keep in sync). The jsonb `meta` columns
absorb the schemaless aptkit payload without forcing a column per field —
document-shaped data in a jsonb sidecar, relational data in real columns.
That's the correct hybrid for this access pattern.

The dropped FK is no longer hypothetical: episodic memory (`@aptkit/memory`)
writes `memory:<conv>:<n>` chunks with **no `documents` parent at all**
(`src/session.ts:53,67`) into the shared store. A hard FK would have rejected
every memory row. So the contract-driven FK drop (lens 6) is what makes the
"memory shares the corpus store" design possible — the soft link is load-bearing
for a live, second use of `chunks`, not just a theoretical concession.

## 7. Data-modeling red-flags audit (capstone)

| Red flag | This repo | Where |
|---|---|---|
| No discernible model (one blob/table) | **Clear** — 5 tables, 2 clusters | `:4-58` |
| Same fact editable in two places | **PRESENT** — chunk text in `content` + `meta.text` | `pg-vector-store.ts:46,55,83` → `02` |
| Frequent query with no index | **Clear** on hot path (HNSW + app_id both indexed); `profiles` lookup unindexed but cold | `:28-30`; `profile.ts:5` |
| N+1 query in app code | **Clear** — batch-in-txn and one-search-per-eval, not fan-out | `pg-vector-store.ts:43`; `eval-cmd.ts:24` |
| Multi-write with no transaction | **PRESENT** — doc row + chunk index span two connections | `runtime.ts:11-17` |
| Invariant only in app code | **PRESENT** — "doc has chunks" guarded by neither FK nor txn | `runtime.ts`; FK dropped `:27` |
| Destructive migration, no rollback | **Mitigated** — the FK drop is idempotent + back-compatible; no down-scripts though | `:27` |
| Schema fighting access pattern | **Deliberate bend** — FK dropped for VectorStore parity | `:16-17,27` → `04` |
| Tenant isolation enforced | **NOT enforced** — `app_id` column, no RLS, not token-derived | `:6,19`; `config.ts:12` → `05` |

### Not yet exercised (honest)

- **Row-Level Security (RLS).** No `enable row level security`, no policies.
  `app_id` is a filter the app *chooses* to apply
  (`src/pg-vector-store.ts:75`), not a boundary the DB enforces. Any code
  path that forgets `where app_id=$2` sees every tenant. → `05`.
- **`app_id` token-derivation.** `app_id` comes from `AGENT_APP_ID` env /
  config default `'laptop'` (`src/config.ts:12`), passed as a constructor arg
  (`src/pg-vector-store.ts:27`). It is **not** derived from an authenticated
  token. Multi-tenant in shape only.
- **Partitioning / sharding** of `chunks` (per-tenant HNSW). No `partition by`.
  Relevant only once `app_id` has more than one value.
- **Soft deletes.** No `deleted_at` anywhere; deletes are hard. `messages`
  cascade-delete with their conversation; nothing else deletes.
- **Schema versioning beyond `001`.** No migration ledger, no `002`. One
  idempotent file.
- **Unique constraints beyond PKs.** No `unique` on, e.g.,
  `(document_id, chunk_index)` — the deterministic id is the only thing
  preventing duplicate chunks, and it works because the id *encodes*
  `(docId, index)`. → `03`.

---
Updated: 2026-06-24 — §1/§2/§6: `chunks` now holds a second live population,
episodic-memory rows (`memory:<conv>:<n>`, `meta.kind='memory'`) written via
`@aptkit/memory` with no `documents` parent — making the dropped FK (§6)
load-bearing, and extending the `content`/`meta.text` duplication (§2) to those
rows. Trajectory columns (`tool_calls`/`tool_results`/`model`/`tokens_used`,
`created_at`) are now populated by the fixed trace sink → `06`.
