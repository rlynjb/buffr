# audit.md — the seven data-modeling lenses, walked

Pass 1. Every lens checked against the real schema and the real query call
sites, grounded in `file:line`. Lenses that find a deep pattern cross-link to a
Pass-2 file rather than restate it. Lenses with nothing to find say so — the
honest `not yet exercised` is as much a finding as a red flag.

The whole persistent surface is one schema file plus five query call sites:

```
  schema      sql/001_agents_schema.sql            (59 lines, 5 tables)
  migration   src/migrate.ts                       (transactional runner)
  writes      src/pg-vector-store.ts  upsert       (chunks)
              src/runtime.ts          indexDocumentRow (documents)
              src/supabase-trace-sink.ts persist*  (conversations/messages)
  reads       src/pg-vector-store.ts  search       (ANN over chunks)
              src/profile.ts          loadProfile  (profiles)
```

---

## Lens 1 — schema shape

A clean relational model. Five tables, two clusters, no everything-in-one-blob
anti-pattern. `jsonb` shows up three times (`documents.meta`, `chunks.meta`,
`messages.tool_calls`/`tool_results`) and each use is justified: `meta` is
open-ended provenance, and the tool payloads are genuinely schemaless
LLM-shaped data. The structured facts (ids, app_id, embedding, chunk_index,
role, tokens_used) are all promoted to real columns, not buried in jsonb.

```
  cluster              tables                  what it is
  ───────────────────  ──────────────────────  ─────────────────────────
  retrieval            documents, chunks       the RAG corpus + vectors
  trajectory           conversations, messages the replayable agent trace
  standalone           profiles                me.md-style prompt context
```

The one shape decision worth flagging: `chunks` is doing double duty. It's both
"the chunks of my documents" and "the backing store for an `@aptkit` memory
engine" (memory rides the same table tagged `meta.kind='memory'`). One table,
two populations. That's why several other lenses light up here.
**→ see 01-vector-column-and-ann-index.md and 03-soft-link-no-fk.md.**

Verdict: clean. No structural red flag.

## Lens 2 — normalization and duplication

One real duplication: chunk text lives in both `chunks.content` and
`chunks.meta.text`. `pg-vector-store.ts:46-56` writes both on upsert;
`pg-vector-store.ts:80-84` reads `content` and rebuilds `meta.text` from it.
Two editable copies of one fact, no constraint binding them.

```
  the duplicated fact

  write:  c.meta.text ──┬──► chunks.content   (column)
                        └──► chunks.meta       (jsonb, still holds .text)
  read:   chunks.content ──► r.content ──► meta.text  (rebuilt)

  → the fact "what this chunk says" is now in two places
```

There's a *second*, softer duplication worth naming: `documents.content` holds
the full source text and `chunks.content` holds slices of that same text. That
one is a deliberate denormalization — it's the read optimization that makes ANN
search possible (you can't run cosine over a 10k-token document). The text-twice
case is the accidental one. **→ see 02-text-stored-twice.md.**

Verdict: one accidental duplication (fix it), one deliberate (keep it).

## Lens 3 — indexes vs query patterns

Two indexes exist on `chunks`, both earning their place against the hot path:

```
  query (pg-vector-store.ts:70-77)          supporting index
  ────────────────────────────────────────  ──────────────────────────────
  order by embedding <=> $vec  (ANN)        chunks_embedding_hnsw (cosine)
  where app_id = $appId                     chunks_app_id
```

The search query — the single most frequent read in the system, run on every
agent turn — is fully covered. The HNSW index makes the cosine ordering
sublinear; the `app_id` btree narrows the candidate set first.
**→ see 01-vector-column-and-ann-index.md.**

The gap: **`messages` has no index on `conversation_id`.** It's a foreign key
(`001_agents_schema.sql:42`), but a FK doesn't auto-create an index in Postgres.
Today nothing reads messages back by conversation — the trajectory is
write-only (`supabase-trace-sink.ts` only inserts). So it's not a *missing* index
yet; it's a **latent** one. The day you build "replay this conversation" or a
transcript view, `select ... where conversation_id = $1 order by created_at`
does a sequential scan over every message ever written.

```
  not-yet-a-problem, but pre-loaded:
    messages.conversation_id  → FK, NO index
    the read that will need it doesn't exist yet (write-only table)
    → add  create index on agents.messages (conversation_id, created_at)
      the moment a by-conversation read ships
```

No N+1 patterns: `upsert` loops chunk-by-chunk but inside one transaction on one
connection, and `search` is a single round trip. No unused indexes.

Verdict: hot path covered; one latent index gap on `messages`, gated behind a
read that doesn't exist yet.

## Lens 4 — transactions and integrity

Two transaction stories, opposite verdicts.

**Atomic, correct:** `PgVectorStore.upsert` (`pg-vector-store.ts:40-65`) checks
out one client, `begin`s, loops the chunk inserts, `commit`s, and `rollback`s
on any throw. A batch of chunks is all-or-nothing. The migration runner
(`migrate.ts:8-20`) wraps the whole schema script the same way.

**Not atomic:** `indexDocumentRow` (`runtime.ts:11-17`) writes the `documents`
row on the *pool*, then calls `pipeline.index(...)` which opens its own
`begin/commit` on a *different* connection. The pair has no shared transaction.

```
  one logical write, two physical transactions

  ┌─ runtime.ts:11 ──────────┐   ┌─ pg-vector-store.ts:42 ─────┐
  │ pool.query(insert docs)  │   │ client.begin                │
  │   ── implicit txn A ──   │   │   insert chunks...          │
  │        commits           │   │ client.commit ── txn B ──   │
  └──────────┬───────────────┘   └──────────┬──────────────────┘
             │                              │
             └─── crash here = doc row, ────┘
                  zero chunks, no rollback
```

**→ see 07-non-atomic-document-chunk-write.md.**

Integrity enforced by the DB: primary keys on all five tables; `not null` on the
load-bearing columns (`embedding`, `content`, `app_id`); one real FK
(`messages.conversation_id → conversations(id) on delete cascade`,
`001:42`). That cascade is the one place the DB guarantees referential cleanup —
delete a conversation and its messages go with it.

Integrity *not* enforced by the DB, left to app code:
- the document↔chunk relationship (FK dropped → **03-soft-link-no-fk.md**)
- `content == meta.text` (no check → **02-text-stored-twice.md**)
- `app_id` as a boundary (no RLS → **05-app-id-tenant-column.md**)
- `embedding` dimension == 768: enforced in TypeScript (`pg-vector-store.ts:32-36`,
  `assertDim` throws), **not** in the column type — `vector(768)` rejects wrong
  dims at insert too, so here the DB and app agree. Good belt-and-suspenders.

Verdict: per-write atomicity is solid; the cross-write atomicity is the hole.

## Lens 5 — migrations and evolution

One migration file, `sql/001_agents_schema.sql`, run through a transactional
runner (`migrate.ts`). The discipline that's present:

- **Idempotent.** Every statement is `create ... if not exists` or `create index
  if not exists`. Re-running the file is safe.
- **Forward-fixing in place.** `001:27` does
  `alter table agents.chunks drop constraint if exists chunks_document_id_fkey` —
  this file *also* repairs databases that were created before the FK was
  dropped. The migration carries its own backfill of the schema change.
- **Transactional.** `migrate.ts:11-19` wraps the whole script in `begin/commit`,
  so a syntax error halfway leaves the schema untouched.

What's `not yet exercised`:

```
  capability            state        buildable target
  ────────────────────  ───────────  ───────────────────────────────
  schema versioning     absent       a schema_migrations(version) table;
                                     today "which migrations ran?" is unknowable
  down / rollback        absent       no reverse script; forward-only
  online/zero-downtime   N/A          single device, no live traffic to
                                     migrate around — add lock-aware DDL
                                     only when concurrency arrives
  data backfill          N/A so far   no column has needed populating from
                                     old rows yet (the FK drop is the
                                     closest thing, and it needs no data move)
```

The risk to name honestly: with one file and no versioning table, the schema's
identity is "whatever `001` currently says," and re-running it is the only
deploy primitive. That's correct *for one device with one schema file*. The
second migration is where you'll want `schema_migrations` — adding it
retroactively means assuming every existing DB is at `001`.

Verdict: clean and idempotent for its size; versioning is the first thing to add
when `002` arrives.

## Lens 6 — access patterns and storage choice

Does Postgres earn its place? Yes, and for one specific reason: **vector and
relational data are colocated in one instance.** The `search` query joins a
cosine-distance ANN ordering with an `app_id` equality filter in a single SQL
statement (`pg-vector-store.ts:70-77`). Split the vectors into a dedicated
vector DB and that becomes a cross-store join you do in app code.

```
  access pattern            storage answer
  ────────────────────────  ──────────────────────────────────
  "k nearest chunks for     pgvector HNSW + btree, one query,
   this query, this app"    one round trip
  "full agent trajectory"   relational rows, one FK, jsonb for
                            the schemaless tool payloads
  "the user's profile"      single-row lookup by app_id
```

The storage *architecture* — Postgres here, SQLite as the canonical local store
in the broader buffr design, single-device, direct `pg` connection, no Edge
Functions — is a **system-design** question, not a schema-shape one. It lives in
`study-system-design`, not here. What's in scope here: the *shape* matches the
*access*, and it does.

`not yet exercised`: local-first sync, multi-device reconciliation, and the
SQLite↔Postgres mirror are all system-design concerns this schema doesn't
encode yet (no `synced_at`, no conflict columns, no tombstones).

Verdict: relational + vector colocated is the right call for this access shape.

## Lens 7 — the red-flags capstone

The consolidated checklist, marked against this repo. The deep version with
fixes is **07-non-atomic-document-chunk-write.md** (the capstone pattern file);
this is the scorecard.

```
  red flag                                          fired?  where
  ────────────────────────────────────────────────  ──────  ──────────────────
  everything in one JSON blob / one table            no     5 clean tables
  same fact editable in two places                   YES    chunks text twice → 02
  frequent query with no supporting index            no*    hot path covered;
                                                            messages latent → L3
  a loop issuing one query per row (N+1)             no     upsert is batched txn
  multi-write operation with no transaction          YES    doc+chunk write → 07
  invariant enforced only in hopeful app code        YES    doc↔chunk soft link → 03
                                                            content==meta.text → 02
  tenancy filter mistakable for a boundary           YES    app_id, no RLS → 05
  destructive migration with no rollback             no     forward-fix, idempotent
  column drop with no backfill plan                  no     FK drop needs no data move
```

Four flags fired. Every one is understood and, in the retrieval cluster,
**deliberate** — the soft link and the text duplication are both costs paid to
keep `chunks` a drop-in `VectorStore`. The `app_id`-no-RLS flag is a phase
decision (single device), not an oversight. The non-atomic write is the one
flag that's a genuine bug-in-waiting rather than a tradeoff.

Verdict: a small, honest schema. The flags that fired are mostly priced-in
parity costs; the one to actually fix is the non-atomic write.
