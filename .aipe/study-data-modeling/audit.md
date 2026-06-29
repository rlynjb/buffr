# Pass 1 — the data-modeling audit

Every lens, walked against `buffr-laptop`'s real schema and the code that
reads and writes it. Each lens is named, found-in-this-repo with `file:line`
grounding, or marked **not yet exercised** honestly with a buildable target.
Significant findings cross-link to a Pass-2 pattern file rather than restating
the deep walk.

The 7 lenses (from the data-modeling spec):

```
  1. the-data-model-and-its-shape       ── the entities + relationships
  2. normalization-and-duplication      ── facts once vs copied
  3. indexing-vs-query-patterns         ── indexes that exist vs queries run
  4. transactions-and-integrity         ── FKs, atomicity, what enforces it
  5. migrations-and-evolution           ── how schema changes ship
  6. access-patterns-and-storage-choice ── shape vs read/write pattern
  7. data-modeling-red-flags-audit       ── consolidated checklist (capstone)
```

---

## §1 — the data model and its shape

**Found.** Five tables in `agents` (`sql/001_agents_schema.sql:4-58`):
`documents`, `chunks`, `conversations`, `messages`, `profiles`. The full ER
diagram is in `README.md`. The shape is a small star around `chunks` (the
retrieval workhorse) plus an independent conversation/message pair.

The model is **discernible and well-structured** — this is not "everything in
one JSON blob." The one structural subtlety: `chunks` is overloaded. It holds
retrieval chunks (id `"<docId>#<index>"`) *and* episodic memory (id
`"memory:<conv>:<n>"`, distinguished by `meta.kind='memory'`) in the same
table. That overloading is deliberate — it lets memory resurface through the
same `search_knowledge_base` tool — and it's a real pattern, walked in
`06-trajectory-tables.md` and `01-vector-column-and-ann-index.md`.

→ See `README.md` for the diagram; `02-deterministic-chunk-ids.md` for the
primary key scheme.

---

## §2 — normalization and duplication

**Found — one deliberate denormalization.** The chunk text is stored in two
places: the `content` column (`chunks.content`, `001:21`) and inside the jsonb
as `meta.text`. The write path puts text into both
(`pg-vector-store.ts:46,55`), and the read path rebuilds `meta.text` from the
`content` column on the way back out (`pg-vector-store.ts:83`).

This is the DB analog of information leakage — the same fact editable in two
places — and it's the one normalization call worth a design-review conversation.
It's deliberate (it keeps the in-memory `meta` shape intact so aptkit's
citation code works unchanged), but both copies are independently writable, so
nothing in the database keeps them in sync.

→ Deep walk: `05-text-stored-twice.md`. The "why duplication is leakage"
primitive is taught in **study-software-design**; this guide cross-links
rather than re-teaching it.

Otherwise the schema is well-normalized: `documents` owns source content once,
`profiles` owns the profile blob once, trajectory facts live once in
`messages`.

---

## §3 — indexing vs query patterns

**Found — indexes match the hot queries.** Three indexes on `chunks`:

```
  index                          serves which query
  ─────────────────────────────  ──────────────────────────────────────
  PK on chunks.id                upsert conflict target (pg-vector-store
                                 .ts:50 "on conflict (id)")
  chunks_embedding_hnsw          the ANN search: order by embedding <=>
  (hnsw vector_cosine_ops, :28)  $1 (pg-vector-store.ts:74)
  chunks_app_id (:30)            the tenant filter: where app_id = $2
                                 (pg-vector-store.ts:73)
```

The single hot read — `search()` at `pg-vector-store.ts:67-85` — does
`where app_id = $2 order by embedding <=> $1 limit $3`. Both the filter
(`app_id`) and the ordering (`embedding <=>`) have a supporting index. That's
the right pairing. → `01-vector-column-and-ann-index.md`.

**One honest note:** the HNSW index is built without a `where app_id` predicate,
so it's a global ANN index; the `app_id` filter is applied as a separate
post/pre-filter. On a single-device `'laptop'` tenant that's fine — there's
effectively one tenant — but at multi-tenant scale you'd want the filter pushed
into the index. Not a problem now; named so it's not a surprise later.

**No N+1 in the write path** — `upsert` batches all chunks in a single
transaction with one `INSERT` per chunk inside one `begin/commit`
(`pg-vector-store.ts:42-58`). The messages writes are queued and awaited
together via `flush()` (`supabase-trace-sink.ts:91-93`), not one round-trip
blocking the next.

`conversations`/`messages` have no extra index beyond their primary keys and
the FK column; for single-device volume that's adequate. A `messages
(conversation_id, created_at)` index would help if you ever paginate a long
trajectory — buildable target, not a current gap.

---

## §4 — transactions and integrity

**Found — one real FK, one deliberate non-FK, one non-atomic seam.**

The single database-enforced relationship: `messages.conversation_id →
conversations(id) on delete cascade` (`001:42`). Delete a conversation, its
messages go with it. That's the right cascade for a trajectory log.

The chunks→documents relationship is **not** a foreign key — the constraint is
explicitly dropped (`001:26-27`,
`alter table agents.chunks drop constraint if exists chunks_document_id_fkey`).
Deliberate, with a stated reason. → `03-soft-link-no-fk.md`.

**The integrity gap worth naming: the document + chunk write is non-atomic.**
`indexDocumentRow` (`runtime.ts:11-17`) does two writes in two separate
transactions:

```
  Non-atomic cross-transaction write — runtime.ts:11-17

  ┌─ txn 1 ──────────────────────────────────────────┐
  │ pool.query(insert into agents.documents ...)      │  runtime.ts:11
  │   → commits on its own                            │
  └───────────────────────────────────────────────────┘
                   ╎  crash window: documents row exists,
                   ╎  chunks do not
                   ▼
  ┌─ txn 2 ──────────────────────────────────────────┐
  │ pipeline.index(...) → PgVectorStore.upsert        │  runtime.ts:17
  │   begin / insert chunks / commit                  │  pg-vector-store.ts:42
  └───────────────────────────────────────────────────┘
```

A crash between them leaves a documents row with zero chunks — a document
that's "indexed" but unsearchable. The soft link makes this *recoverable* (you
can re-index without a FK violation), but the window is real. On a
single-device tool driven by a human at a CLI it's low-risk; the buildable fix
is to pass the documents `INSERT` into the same transaction as the chunk
upsert, or make indexing idempotent + retried. Named here, not hidden.

Within `upsert` itself, atomicity **is** correct: all chunks for a batch
commit together or roll back together (`pg-vector-store.ts:42-64`), and the
dimension check throws *before* any write (`assertDim`, `:32-36,39`) so a
768-mismatch never half-writes.

The invariant "embeddings are 768-dim" is enforced in app code (`assertDim`)
*and* by the column type `vector(768)` (`001:22`) — belt and suspenders, the
right call.

---

## §5 — migrations and evolution

**Found — one idempotent migration, transactional runner, no version table.**

`sql/001_agents_schema.sql` is written defensively: every `create` is
`if not exists`, the FK drop is `drop constraint if exists`, indexes are
`create index if not exists`. So it's re-runnable — applying it twice is a
no-op. The runner wraps the whole script in one transaction
(`migrate.ts:8-20`, `begin` / run / `commit` / rollback-on-error), so a partial
migration can't land.

The FK drop at `001:26-27` is itself a worked migration-evolution example: an
earlier schema *had* the foreign key, and this migration removes it idempotently
on already-migrated databases. That's the "safe under live data" pattern done
right — no destructive `drop table`, just a guarded constraint drop.

**Not yet exercised: schema versioning beyond 001.** There's exactly one
migration file and no `schema_migrations` / version-tracking table. The runner
always applies `001` (`migrate.ts:28`), relying on idempotency rather than a
recorded version. That works for one file; it doesn't scale to an ordered
sequence where order and applied-state matter. Buildable target: a
`schema_migrations(version, applied_at)` table and a runner that applies only
unapplied files in order. Honest gap, not a defect at one file.

**Not yet exercised: rollback / down-migrations.** No `.down.sql`. For a
single-device personal tool that's a reasonable omission; named for
completeness.

---

## §6 — access patterns and storage choice

**Found — relational + vector colocated, matching the access shape.** The
read pattern is "embed the query, find the k nearest chunks for this tenant,
return them with citation metadata" — and the storage is exactly that: a
relational table with a `vector(768)` column and an ANN index, queried with
`order by embedding <=> $1 limit k` (`pg-vector-store.ts:67-85`). The shape
fits the access pattern; there's no relational schema fighting a document-shaped
access pattern here.

The jsonb `meta` columns (`documents.meta`, `chunks.meta`,
`001:10,24`) carry the document-shaped, schema-flexible part (arbitrary
provenance, `kind='memory'` tags) alongside the relational columns. That's the
correct split: structured facts in columns, flexible facts in jsonb.

Storage choice rationale — Postgres + pgvector colocated in one instance,
single-device — is a **system-design** decision; it lives in
**study-system-design**, not here. The buffr-mobile sibling runs SQLite as the
canonical store; that local-first storage-choice story is also next door.

---

## §7 — data-modeling red-flags audit (capstone)

The consolidated checklist, marked against this repo.

```
  red flag                                    this repo
  ──────────────────────────────────────────  ───────────────────────────────
  no discernible model (one JSON blob)        ✅ clear 5-table model
  same fact editable in two places            ⚠️  text twice (content +
                                                 meta.text), both writable
                                                 — deliberate, §2 / file 05
  frequent query with no supporting index     ✅ HNSW + app_id both indexed
  N+1 query in app code                       ✅ batched upsert, queued
                                                 message flush
  multi-write op with no transaction          ⚠️  document+chunk write spans
                                                 two txns (non-atomic) — §4
  invariant only in app code, DB doesn't       ✅ 768-dim enforced in BOTH
  guard it                                       app (assertDim) and column
                                                 type vector(768)
  destructive migration, no rollback           ✅ FK drop is guarded +
                                                 idempotent; no drop table
  column drop with no backfill plan            ✅ n/a — no column drops
  document-shaped access vs relational schema  ✅ shape matches (vector col +
                                                 jsonb meta for flex)
```

Two `⚠️` items, both deliberate and both named with their reason and a
buildable fix: text-stored-twice (§2, file 05) and the non-atomic document+chunk
write (§4). Neither is a panic; both are exactly what a staff reviewer flags.

---

## Not yet exercised — the honest list

These data-modeling concerns don't appear in the repo. Each gets a one-line
buildable target so the gap is constructive, not just an absence.

```
  concern              status              buildable target
  ───────────────────  ──────────────────  ─────────────────────────────────
  RLS                  not yet exercised   policy on app_id once app_id is
                       (app_id is shape-   token-derived → study-security;
                       only, NO RLS, not   file 04
                       token-derived)
  partitioning         not yet exercised   partition chunks / messages by
                                           app_id or created_at at scale
  soft-deletes         not yet exercised   deleted_at column + filtered
                                           index (currently hard cascade only)
  schema versioning    not yet exercised   schema_migrations(version,
  beyond 001                               applied_at) + ordered runner — §5
  down-migrations      not yet exercised   paired .down.sql per migration
```
