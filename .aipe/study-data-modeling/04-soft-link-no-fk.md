# Soft Link, No FK (`document_id` without a constraint)

**Industry names:** soft foreign key / application-level reference /
referential integrity traded for contract parity. **Type:** Project-specific.

> **Note vs the original brief.** An earlier reading of this repo assumed a
> hard FK requiring a `documents` row before any `chunks` row. That is **no
> longer true.** The current schema *explicitly drops* the FK
> (`sql/001_agents_schema.sql:16-17` comment, `:27` the `drop constraint`).
> `chunks.document_id` is a soft link with no enforced integrity. This file
> documents the schema as it actually is.

## Zoom out, then zoom in

Here's the corpus cluster and the link that *looks* like a foreign key but
isn't one.

```
  Zoom out — where the (absent) constraint lives

  ┌─ Storage layer (Postgres) ──────────────────────────┐
  │  agents.documents                                    │
  │    id text PK                                         │
  └───────────────────────┬──────────────────────────────┘
                          ╎  document_id  (text column)
                          ╎  ★ NO FK — dropped at :27 ★    ← we are here
  ┌───────────────────────▼──────────────────────────────┐
  │  agents.chunks                                       │
  │    document_id text   (nullable, no reference)        │
  └──────────────────────────────────────────────────────┘
```

**Zoom in.** `chunks.document_id` points at `documents.id` by convention
only. The DB does not check that the parent exists, does not cascade deletes,
does not reject a dangling chunk. The question: *why would you throw away
referential integrity on purpose?*

## The structure pass

**Layers:** (1) the aptkit `VectorStore` contract — `upsert({id, vector,
meta})`, knows nothing about documents. (2) the `chunks` table that
implements it. (3) the `documents` table the app *wishes* chunks pointed at.
The contract is the top layer and it dictates downward.

**Axis — who guarantees the parent exists:** trace it. With a hard FK, the
*database* guarantees every chunk has a `documents` row — insert a chunk with
no parent and it rejects. With the FK dropped, *nobody* guarantees it; it's
true only because `indexDocumentRow` happens to write the document first
(`src/runtime.ts:11-17`). The axis flips from "DB-enforced" to "hoped for by
call order" exactly at the dropped constraint.

**Seam:** the load-bearing boundary is **drop-in parity vs referential
integrity**. A hard FK would make `PgVectorStore` reject any chunk written
before its document — which the `VectorStore` contract is allowed to do,
because the contract has no concept of documents. So the FK and the contract
are mutually exclusive. The schema chose the contract.

## How it works

### Move 1 — the mental model

You know how TypeScript lets you write `as` to assert a type the compiler
can't verify — you're telling it "trust me, this is a `User`"? A soft FK is
the database version of `as`. `document_id` is *typed* like a reference but
*unverified* like a cast. The link is real in your head and in the app's call
order; it's invisible to the DB.

```
  hard FK vs soft link — who checks the arrow

  HARD FK:   chunks.document_id ──► documents.id
                                    │
                          DB checks: parent must exist,
                          delete cascades, orphan rejected

  SOFT LINK: chunks.document_id ┄┄► documents.id
                                    │
                          DB checks: NOTHING. just a text column.
                          orphans allowed, no cascade, no rejection
```

### Move 2 — the load-bearing skeleton

What the dropped FK removes, named by what breaks:

- **insert-order enforcement — gone.** With the FK, a chunk inserted before
  its document is rejected. Without it, that insert succeeds and you have an
  orphan chunk pointing at a non-existent document. Nothing stops it.
- **cascade delete — gone.** With the FK + `on delete cascade`, deleting a
  document removes its chunks. Without it, deleting a `documents` row leaves
  its chunks behind as orphans — they still show up in vector search (the
  search doesn't join `documents`, see `pg-vector-store.ts:72`).
- **the guarantee moves to call order.** `indexDocumentRow` writes the
  document, *then* indexes chunks (`src/runtime.ts:11-17`). The ordering is
  the only thing making `document_id` valid — and it's across two
  connections, not one transaction, so a crash between them leaves a
  document with no chunks (the inverse orphan).

**Why drop it (the deliberate trade).** The schema comment says it outright:
the `VectorStore` contract upserts chunks with no notion of a documents row,
so a hard FK would break drop-in parity. `PgVectorStore` is meant to be a
swappable implementation of aptkit's `VectorStore` — and that interface never
promises a parent document exists. Honoring the interface meant dropping the
FK.

**Skeleton vs hardening.** What's *not* there to compensate: no periodic
orphan-sweep job, no `document_id not null`, no application-side existence
check before chunk upsert. The integrity is genuinely unenforced, not
enforced-elsewhere.

### Move 2.5 — current state vs the path back

```
  Phase A (now)                 Phase B (if integrity matters)
  ─────────────                 ──────────────────────────────
  document_id: text, no FK      document_id: text, FK + cascade
  orphans possible              orphans impossible
  VectorStore parity kept       parity broken (chunk-before-doc rejected)

  the trade is binary: you cannot have both the drop-in
  VectorStore contract AND a hard FK. Pick one.
```

The honest fix isn't "add the FK back" — that re-breaks parity. It's a
*wrapping transaction* in `indexDocumentRow` so document + chunks commit
together (closes the inverse orphan), plus an orphan-sweep keyed on
`document_id` for the forward orphan. Integrity as application discipline,
since the contract forbids it as DB constraint.

### Move 3 — the principle

A foreign key is a guarantee with a cost: it constrains *insert order* and
*delete behavior*. When an external contract forbids those constraints — as a
drop-in interface that knows nothing about parents does — you can't keep the
FK. The integrity doesn't vanish; it *relocates* from the DB to the
application, and you must then enforce it there deliberately or accept the
orphans. Naming where integrity lives — DB vs app — is the whole skill.

## Primary diagram

```
  the contract forces the drop

  ┌─ aptkit VectorStore contract ───────────────────────┐
  │  upsert({ id, vector, meta })   ← no `documents` here │
  └───────────────────────┬───────────────────────────────┘
                          │  PgVectorStore must satisfy this
  ┌─ schema decision ─────▼───────────────────────────────┐
  │  chunks.document_id text  (soft)                       │
  │  alter table chunks drop constraint                    │
  │    if exists chunks_document_id_fkey    ← the trade     │
  └───────────────────────┬───────────────────────────────┘
                          │  integrity now lives in app call order
  ┌─ runtime.ts ──────────▼───────────────────────────────┐
  │  1. insert documents row                               │
  │  2. pipeline.index → upsert chunks                     │
  │     (two connections, NOT one txn → inverse orphan risk)│
  └─────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case.** Every `npm run index` exercises this. A document row is written,
then its chunks — but the DB never checks the link, so the *only* thing
keeping `chunks.document_id` honest is that `indexDocumentRow` writes the
parent first.

**The dropped FK — `sql/001_agents_schema.sql:16-17,27`:**

```
  document_id text,
  -- Soft link to documents.id (no FK): the VectorStore contract upserts
  -- chunks with no notion of a documents row, so a hard FK would break
  -- drop-in parity.
  ...
  alter table agents.chunks drop constraint if exists chunks_document_id_fkey;
        │                                                    │
        │                                                    └─ idempotent:
        │                                                       cleans DBs
        │                                                       migrated when
        │                                                       the FK existed
        └─ the constraint is actively removed, not just absent
```

**The call-order "guarantee" — `src/runtime.ts:11-17`:**

```
  await pool.query(`insert into agents.documents ...`);   ← step 1: parent
  await pipeline.index({ id: doc.id, text: doc.text });   ← step 2: chunks
        │
        └─ two separate pool.query calls = two connections = NOT atomic.
           crash between them → document with no chunks (inverse orphan).
           no FK to catch the forward orphan either.
```

**Search ignores the link — `src/pg-vector-store.ts:72`:** the search selects
`document_id` but never joins `documents`, so an orphan chunk (parent
deleted) still returns in results. The link is metadata for citations, not a
queried relationship.

## Elaborate

Soft FKs show up wherever a storage layer must implement a generic interface
that's narrower than the relational model underneath — ORMs over polymorphic
associations, event stores, and exactly this case: a vector store interface
that predates any notion of source documents. The trade is well-known: you
gain implementation freedom and lose the DB's referential guarantees, and you
*must* replace them with application discipline (transactions, sweeps, checks)
or accept drift. The counter-example lives one table over: `messages →
conversations` *keeps* its FK with `on delete cascade` (see `06`), because
nothing forbids it there. Same schema, opposite call — that contrast is the
lesson.

## Interview defense

**Q: Your `chunks.document_id` has no foreign key. Why throw away referential
integrity?**

```
  VectorStore.upsert({id, vector, meta})  ← contract has NO documents concept
         │
         └─ a hard FK would reject any chunk written before its document,
            breaking drop-in parity → so the FK had to go
```
Answer: it's forced by the `VectorStore` contract, not laziness. aptkit's
interface upserts chunks knowing nothing about documents; a hard FK would
reject a chunk inserted before its parent, breaking the drop-in promise. So
integrity relocates to app call order — `indexDocumentRow` writes the
document first. The honest gap: that's two connections, not one transaction,
so a crash between them orphans the document. The fix is a wrapping txn plus
an orphan sweep, *not* re-adding the FK. **Anchor:**
`sql/001_agents_schema.sql:27` drops it; the comment at `:16` says why.

**Q: Where does the integrity live now, then?**

In the application, partially. Call order makes the forward link valid; a
crash breaks the inverse. The DB guards nothing here. Contrast `messages`,
where the DB *does* — that table has no contract forbidding the FK.
**Anchor:** `:42` keeps the FK, `:27` drops it.

## Validate

1. **Reconstruct:** state what a hard FK + `on delete cascade` would enforce,
   then which of those the soft link loses.
2. **Explain:** why can't `PgVectorStore` keep the FK and still satisfy the
   `VectorStore` contract? (`src/pg-vector-store.ts:38`)
3. **Apply:** you delete a `documents` row by hand. What happens to its
   chunks, and do they still show in search? (`pg-vector-store.ts:72`)
4. **Defend:** the fix is a wrapping transaction, not re-adding the FK.
   Explain why. (`src/runtime.ts:11-17`)

## See also

- `03-deterministic-chunk-ids.md` — why orphans aren't auto-cleaned.
- `06-trajectory-tables.md` — the FK that *was* kept (the contrast).
- `audit.md` §4, §6 — integrity gap + the deliberate schema bend.
- `study-system-design` — the aptkit VectorStore contract boundary.
