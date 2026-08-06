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

**Found.** Six tables in `agents`: five in `sql/001_agents_schema.sql:4-58`
(`documents`, `chunks`, `conversations`, `messages`, `profiles`) plus
`agents.decisions` (`sql/002_decision_journal.sql:1-25`, landed in `699e77b`,
the decision journal behind `/research` and `/review`). The full ER diagram
is in `README.md`. The shape is a small star around `chunks` (the retrieval
workhorse) plus an independent conversation/message pair, plus `decisions`
sitting off to the side with no relationship — soft or hard — to anything
else in the schema.

The model is **discernible and well-structured** — this is not "everything in
one JSON blob." Two structural subtleties, both the *same* move applied
twice:

1. `chunks` is overloaded: it holds retrieval chunks (id `"<docId>#<index>"`)
   *and* episodic memory (id `"memory:<conv>:<n>"`, distinguished by
   `meta.kind='memory'`) in the same table. Deliberate — it lets memory
   resurface through the same `search_knowledge_base` tool. Walked in
   `06-trajectory-tables.md` and `01-vector-column-and-ann-index.md`.
2. `decisions` does the same thing with a `kind` column instead of a
   `meta.kind` tag: `kind = 'hypothesis'` rows leave nine columns null
   (`stake`, `resolution_condition`, `review_at`, both prediction triples,
   both assessment pairs), `kind = 'decision'` rows populate all of them
   (`pg-journal-store.ts:50-66`). Same discriminated-nullable-family
   pattern, different discriminator column. Walked in
   `07-predicted-vs-assessed-columns.md`.

**`documents.source_type`** (`src/runtime.ts:9`, unchanged since the last
sync). The `indexDocumentRow` function accepts `sourceType?: string` (default
`'markdown'`) and writes it into an `INSERT ... ON CONFLICT DO UPDATE` on
`agents.documents`. This distinguishes two corpus populations: markdown files
indexed via `npm run index` (`sourceType='markdown'`) and live DB rows
indexed via `npm run index:db` (`sourceType='db'`). The `source_type` column
is not yet used in retrieval queries — it's a provenance tag, not a filter
key. The DB indexing source is `src/db-sources.ts`: 8 tables across `loopd`
schema (journal entries, todo tasks, nutrition, vlogs, habits) and `contrl`
schema (exercises, workout sessions, week_progress). Each row becomes one
`documents` row with `source_type='db'` and its chunks in `agents.chunks`.

**`agents.decisions`'s identity columns are richer than any other table's.**
Alongside `app_id` it carries `user_id text not null` and `workspace_id text
not null` (`002:4-5`) — a finer-grained identity no other table declares.
Today all three collapse to one value everywhere they're written
(`session.ts:749-750,771-772`: `userId: cfg.appId, workspaceId: cfg.appId`),
so it's shape shipped ahead of need, in the same spirit as `04-app-id-
tenant-column.md`'s central lesson — walked as a second example there now.
It also carries `domain` (always `'market-research'` today) and a
`subject_type`/`subject_id` pair (always `'research-topic'` / the topic
string) — a polymorphic-style reference to something outside this database
entirely, not a link to any table in this schema. See §4 and
`03-soft-link-no-fk.md`'s new "step further" note.

→ See `README.md` for the diagram; `02-deterministic-chunk-ids.md` for the
chunk key scheme; `07-predicted-vs-assessed-columns.md` and
`08-lazy-status-transition.md` for the two new patterns `decisions` earns.

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

**Looks like duplication, isn't — worth naming explicitly.**
`agents.decisions` pairs `predicted_score`/`predicted_dimension`/
`predicted_confidence` (the user's guess, captured blind) against
`assessed_score`/`assessed_confidence` (the engine's score, computed after)
on the same row (`002:17-21`). At a glance that's the same shape as §2's one
real duplication — two column families about one subject — but it isn't the
same pattern: the two sides are different facts, captured by different
authors at different times, and neither is ever declared the "true" one.
Collapsing `content`/`meta.text` to one column loses nothing (§2's finding);
collapsing `predicted_score`/`assessed_score` to one column loses either the
forecast or the outcome — the entire reason the row exists. Correctly
normalized, not a red flag. Full walk, including the test that tells the two
patterns apart: `07-predicted-vs-assessed-columns.md`.

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

**`agents.decisions` — one composite index, sized correctly for the two
queries that actually run.** `decisions_status_review` (`002:27`) is
`(app_id, user_id, workspace_id, status, review_at)`. `PgJournalStore.listDue`
(`pg-journal-store.ts:86-100`) issues exactly two statements against this
table, and both are served by the same index: the `UPDATE` filters on the
first four columns by equality plus `review_at <= $4` (a trailing range
predicate — the correct position for it in a composite index), and the
`SELECT` filters the same four-column equality prefix on `status =
'review-due'` then `order by review_at asc`, which the same index satisfies
for free. `kind = 'decision'` in the `UPDATE`'s `where` isn't part of the
index — a residual filter applied after the indexed columns narrow the scan,
fine at this row count. `decisions_app_id` (`002:26`) is redundant with the
composite's leading column for these two queries but cheap insurance for any
future query that filters on `app_id` alone. Full walk of what triggers this
index's two consumers: `08-lazy-status-transition.md`.

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

**`agents.decisions` has no foreign key to anything, and it's not a soft
link either.** `subject_id`/`subject_type` name a thing outside this
database (`subject_type = 'research-topic'`, `subject_id = <topic string>`,
`session.ts:752-753,773-774`), and `evidence_ids` is a jsonb array of
connector `sourceId` strings (`research-flow.ts:117,149`) that are **never
persisted anywhere in `agents`** — not `documents`, not `chunks`. A soft link
(`chunks.document_id`) at least points at a row that usually exists; these
columns point at identifiers that were never rows. See
`03-soft-link-no-fk.md`'s new "step further" note for the full contrast.

**Three `check` constraints — DB-enforced enums, done right.** `kind in
('hypothesis', 'decision')`, `status in ('open', 'review-due', 'resolved',
'discarded')`, `disposition in ('successful', 'unsuccessful',
'inconclusive')` (`002:9,13,22`) are all enforced by Postgres, not just
TypeScript's union types — an invalid string can't land in any of the three
columns regardless of what app code does. One honest gap: `'discarded'` is a
legal `status` value with **no writer**. The research flow's "discard" choice
never calls `saveDecision`/`saveHypothesis` at all (`research-flow.ts:112-
115` — "Discarded — nothing saved," the row is never created), so there's no
row left to mark `discarded` once a decision exists. The value is
forward-compatible room, not dead code with a bug behind it; named so it
isn't mistaken for either.

**`listDue()` is a query that writes — the transition has no other trigger.**
`PgJournalStore.listDue` runs an `UPDATE` (flip overdue `open` rows to
`review-due`) immediately before the `SELECT` that reads them back
(`pg-journal-store.ts:86-100`). There's no scheduler, cron, or trigger in this
codebase watching `review_at` — the *only* thing that ever notices a review
is due is a human running `/review`, and that same call is what performs the
transition. The two statements aren't wrapped in an explicit
`begin`/`commit` (unlike `pg-vector-store.ts`'s `upsert`), which is fine here
because each auto-commits independently and re-running is idempotent (a row
already flipped to `review-due` just gets selected again, not re-flipped
incorrectly) — but it's worth naming that this is a second place in the
schema, after the document+chunk write above, where a multi-statement
sequence isn't in one transaction. Full walk: `08-lazy-status-transition.md`.

---

## §5 — migrations and evolution

**Found — two idempotent migrations, ordered by an explicit list, still no
version-tracking table.** Since the last sync, `src/migrate.ts` changed from
running a single hardcoded file to running an ordered array:

```ts
// src/migrate.ts:7,24-30
const MIGRATION_FILES = ['001_agents_schema.sql', '002_decision_journal.sql'];

export async function runAllMigrations(pool: pg.Pool): Promise<void> {
  for (const file of MIGRATION_FILES) {
    const sql = await readFile(new URL(`../../sql/${file}`, import.meta.url), 'utf8');
    await runMigration(pool, sql);      // each file: its own begin/commit
  }
}
```

Each file still runs inside its own transaction (`runMigration`,
`migrate.ts:10-22`: `begin` / run / `commit` / rollback-on-error) — that part
is unchanged from the last sync, just now called once per file instead of
once total. Both files remain written defensively: every `create` is
`if not exists`, the chunks FK drop is `drop constraint if exists`, indexes
are `create index if not exists`, and `002_decision_journal.sql`'s single
`create table if not exists` follows the same discipline. Running
`runAllMigrations` twice in a row is still a no-op on either file.

`sql/001_agents_schema.sql`'s FK drop (`001:26-27`) remains a worked
migration-evolution example on its own: an earlier schema *had* the foreign
key, and that migration removes it idempotently on already-migrated
databases — no destructive `drop table`, just a guarded constraint drop.

**Refined finding: ordering is now explicit in code, but there's still no
recorded applied-state.** `MIGRATION_FILES` is an ordered array, so which
file runs before which is no longer implicit — that half of "schema
versioning" is now real. What's still missing is a `schema_migrations`
table: the runner has no record of which files have already been applied to
a given database, so `runAllMigrations` always re-applies every file, every
invocation, and correctness rests entirely on every file staying idempotent
forever. That's fine at two files; it gets more fragile as the list grows
and a later migration can't safely assume what state an *already-migrated*
database is in without re-deriving it from `if not exists` checks. Buildable
target unchanged in spirit, refined in detail: a
`schema_migrations(version, applied_at)` table, and a runner that applies
only the files not yet recorded, in `MIGRATION_FILES` order.

**Not yet exercised: rollback / down-migrations.** No `.down.sql`, for either
file. For a single-device personal tool that's a reasonable omission; named
for completeness.

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

`agents.decisions`'s access pattern is "append a journal row once, then
either flip its status on periodic re-read or resolve it once" — a small
number of structured, comparable columns (`status`, `review_at`, the
tenant/identity triple) doing the filtering and ordering work, plus two free
text columns (`stake`, `resolution_condition`) that only ever get read by a
human, never queried on. That split — structure what the database compares,
leave free text alone otherwise — matches the access pattern cleanly.
`07-predicted-vs-assessed-columns.md` walks the structured/free-text line in
detail.

---

## §7 — data-modeling red-flags audit (capstone)

The consolidated checklist, marked against this repo.

```
  red flag                                    this repo
  ──────────────────────────────────────────  ───────────────────────────────
  no discernible model (one JSON blob)        ✅ clear 6-table model
  same fact editable in two places            ⚠️  text twice (content +
                                                 meta.text), both writable
                                                 — deliberate, §2 / file 05
                                               ✅ predicted_* vs assessed_* on
                                                 decisions LOOKS like this but
                                                 isn't — two facts, not one,
                                                 §2 / file 07
  frequent query with no supporting index     ✅ HNSW + app_id both indexed;
                                                 decisions_status_review
                                                 serves both listDue queries
  N+1 query in app code                       ✅ batched upsert, queued
                                                 message flush
  multi-write op with no transaction          ⚠️  document+chunk write spans
                                                 two txns (non-atomic) — §4
                                               ⚠️  listDue's UPDATE-then-SELECT
                                                 isn't one transaction either
                                                 — idempotent, low risk, §4
  invariant only in app code, DB doesn't       ✅ 768-dim enforced in BOTH
  guard it                                       app (assertDim) and column
                                                 type vector(768)
                                               ✅ kind/status/disposition all
                                                 DB-enforced via check — §4
  destructive migration, no rollback           ✅ FK drop is guarded +
                                                 idempotent; no drop table;
                                                 002 follows the same
                                                 discipline
  column drop with no backfill plan            ✅ n/a — no column drops
  document-shaped access vs relational schema  ✅ shape matches (vector col +
                                                 jsonb meta for flex;
                                                 decisions' structured-vs-
                                                 free-text split, §6)
```

Three `⚠️` items now, all deliberate and all named with their reason and a
buildable fix: text-stored-twice (§2, file 05), the non-atomic
document+chunk write (§4), and the non-transactional (but idempotent)
`listDue` write-then-read (§4, file 08). None is a panic; all three are
exactly what a staff reviewer flags, and one item that reads like a fourth
red flag on first glance (`decisions`' twin prediction/assessment columns)
turns out, on inspection, to be correctly normalized rather than a
duplication — worth a ✅ specifically *because* it looks suspicious at first.

---

## Not yet exercised — the honest list

These data-modeling concerns don't appear in the repo. Each gets a one-line
buildable target so the gap is constructive, not just an absence.

```
  concern              status              buildable target
  ───────────────────  ──────────────────  ─────────────────────────────────
  RLS                  not yet exercised   policy on app_id (and now
                       (app_id/user_id/    user_id/workspace_id on
                       workspace_id are    decisions) once identity is
                       shape-only, NO RLS, token-derived → study-security;
                       not token-derived)  file 04
  partitioning         not yet exercised   partition chunks / messages by
                                           app_id or created_at at scale
  soft-deletes         not yet exercised   deleted_at column + filtered
                                           index (currently hard cascade only;
                                           decisions' 'discarded' status is
                                           the nearest thing, and it has no
                                           writer yet — §4, file 08)
  recorded migration    not yet exercised  schema_migrations(version,
  applied-state (order                    applied_at) + a runner that skips
  is now explicit in                      already-applied files — §5
  MIGRATION_FILES, but
  applied-state isn't
  recorded anywhere)
  down-migrations      not yet exercised   paired .down.sql per migration
  scheduled transition  not yet exercised  a job running listDue's UPDATE
  for decisions.status                    independently of any human read
  (today: read-triggered                  → file 08
  only)
```
