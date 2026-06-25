# Deterministic Chunk IDs (`"<docId>#<index>"`)

**Industry names:** natural / deterministic / content-addressed key ·
idempotent upsert key. **Type:** Language-agnostic pattern.

## Zoom out, then zoom in

Here's where the chunk id is born and what it buys.

```
  Zoom out — where the deterministic id lives

  ┌─ Pipeline layer (aptkit) ───────────────────────────┐
  │  chunker splits a doc → chunk i gets                 │
  │  id = "<docId>#<i>"   ★ THIS CONCEPT ★               │ ← we are here
  └───────────────────────────┬──────────────────────────┘
                              │  upsert {id, vector, meta}
  ┌─ Storage layer (Postgres) ▼──────────────────────────┐
  │  insert into agents.chunks (id, ...)                 │
  │  on conflict (id) do update set ...                  │  ← id IS the PK
  └──────────────────────────────────────────────────────┘
```

**Zoom in.** The chunk's primary key isn't a random uuid — it's
`"<docId>#<index>"`, computed from the document it came from and its position.
The id *encodes its own identity*. The question: *why does a key you can
recompute matter, and what would break with a random one?*

## The structure pass

**Layers:** (1) id generation in the chunker — deterministic from
`(docId, index)`. (2) the PK constraint on `chunks.id`. (3) the
`on conflict (id) do update` upsert. The same id flows through all three.

**Axis — identity over time:** trace "is chunk #3 of doc X the same row on
re-index?" A random uuid says *no* — re-indexing makes a new row, you must
delete the old. A deterministic id says *yes* — same `(docId, 3)`, same id,
same PK, the upsert overwrites in place. The axis answer flips entirely on
this one choice.

**Seam:** the load-bearing boundary is **re-index = insert-or-update vs
insert-then-orphan**. With deterministic ids, re-indexing a document is
idempotent: chunk count stable, old vectors replaced. With random ids you'd
accumulate duplicate chunks per re-index unless you first delete by
`document_id` — and there's no FK to make that safe (see `04`).

## How it works

### Move 1 — the mental model

You know how a React list needs a stable `key` so re-rendering reconciles
items in place instead of throwing them all away and rebuilding? A
deterministic chunk id is that `key`, but for rows. `"<docId>#<index>"` is the
stable identity that lets a re-index reconcile chunk-by-chunk instead of
duplicate-then-clean.

```
  deterministic id = stable key for reconciliation

  doc "notes.md"  ──chunk──►  notes.md#0   notes.md#1   notes.md#2
                                  │            │            │
  re-index same doc ────────►  notes.md#0   notes.md#1   notes.md#2
                                  │            │            │
                              ON CONFLICT (id) DO UPDATE  (in place)
                                  │            │            │
                              same 3 rows, new vectors — no duplicates
```

### Move 2 — the load-bearing skeleton

The kernel, named by what breaks if removed:

- **the id encodes `(docId, index)`.** Drop the encoding (use a random uuid)
  and re-indexing the same document inserts a *second* set of chunks — the
  PK no longer collides, so `on conflict` never fires, and you get duplicate
  chunks polluting search results. The encoding is what makes the conflict
  *happen*.
- **the PK on `id`.** Drop it and `on conflict (id)` has nothing to conflict
  *on* — the upsert clause is meaningless without a unique constraint behind
  it. The PK is the conflict target.
- **`on conflict (id) do update`.** Drop the `do update` (use
  `do nothing`) and re-indexing a changed document keeps the *stale*
  embedding — the new vector is silently discarded. `do update` is what makes
  re-index actually refresh.

**The thing people miss — no `unique(document_id, chunk_index)`.** You might
expect a composite unique constraint to prevent duplicate chunk positions.
There isn't one (`sql/001_agents_schema.sql` has no such constraint). It's
not needed *because the id already encodes `(docId, index)`* — two chunks at
the same position would compute the same id and collide on the PK. The
deterministic id *is* the uniqueness guarantee for `(document, position)`.
That's the elegant part and the part to name in an interview.

**Skeleton vs hardening.** Kernel: encoded id + PK + `do update`. Hardening
not present: a `unique(document_id, chunk_index)` as a belt-and-suspenders
check (redundant given the id), or a content hash in the id to detect
unchanged chunks and skip re-embedding (a real optimization not done here).

### Move 3 — the principle

A natural key that encodes identity turns "make this write idempotent" from
an application concern into a database one. The upsert becomes safe to replay
because the key collides exactly when it should. Random surrogate keys are
fine when identity is opaque; the moment identity is *derivable* from the
data, encoding it into the key buys idempotency for free.

## Primary diagram

```
  index → re-index, idempotent by construction

  ┌─ aptkit pipeline ────────────────────────────────────┐
  │  doc {id:"notes.md", text}                            │
  │  chunk i  →  id = "notes.md#" + i                     │
  └───────────────────────┬───────────────────────────────┘
                          │  upsert per chunk, in a txn
  ┌─ Postgres agents.chunks ▼─────────────────────────────┐
  │  insert (id, document_id, chunk_index, content, ...)  │
  │  on conflict (id) do update set                       │
  │    content=excluded.content, embedding=excluded...    │
  │       │                                               │
  │       └─ same (docId,index) → same id → PK collision  │
  │          → UPDATE in place. Re-index never duplicates.│
  └────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case.** Re-running `npm run index -- notes.md` after editing the file.
Chunk count stays stable, embeddings refresh in place, no orphans, no
duplicates — all because the ids are deterministic and the upsert keys on
them.

**The upsert — `src/pg-vector-store.ts:47-56`:**

```
  insert into agents.chunks (id, document_id, app_id, chunk_index,
                             content, embedding, embedding_model, meta)
  values ($1, $2, $3, $4, $5, $6::vector, $7, $8)
  on conflict (id) do update set        ← id ($1) is the conflict target
    document_id = excluded.document_id,
    chunk_index = excluded.chunk_index,
    content     = excluded.content,      ← refreshed text on re-index
    embedding   = excluded.embedding,    ← refreshed vector — the point of
    embedding_model = excluded....,         do update over do nothing
    meta        = excluded.meta
       │
       └─ excluded.* = the row that would have been inserted; do update
          copies it over the existing row → in-place refresh
```

**The id source — `src/pg-vector-store.ts:44`, `sql/...:14`:** the id arrives
in `c.id` from aptkit's chunker as `"<docId>#<index>"` (a documented
must-not-change constraint per project context), and lands in the `text`
PK at `sql/001_agents_schema.sql:14`. `c.meta.docId` (`:44`) and
`c.meta.chunkIndex` (`:45`) carry the same `(docId, index)` redundantly into
columns — note this is the same column/`meta` duplication called out in `02`.

**Document ids too — `src/runtime.ts:14`:** `documents` upserts on
`conflict (id) do update set content = excluded.content`, same idempotent
pattern at the document level, keyed on the deterministic `docId`
(`basename(path)`, `src/cli/index-cmd.ts:24`).

## Elaborate

This is the natural-key vs surrogate-key debate, settled by the data. RAG
chunks have a derivable identity — "chunk N of document D" — so encoding it
into the key is the right call; it makes the pipeline replay-safe with no
delete-then-insert dance and no FK needed to clean orphans. The cost of
natural keys generally is that they're brittle if the underlying identity
changes (rename the doc → all chunk ids change → orphans). Here `docId` is
`basename(path)`, so renaming a source file *does* orphan the old chunks —
a real edge the deterministic scheme doesn't cover (and with no FK, nothing
cleans them; see `04`). Worth knowing the seam.

The same encoded-id discipline now appears on a second writer: `@aptkit/memory`
keys its rows `memory:<conversationId>:<n>` (`conversation-memory.ts:82`) and
upserts through the *same* `on conflict (id) do update` path. It's the identical
move — identity encoded into the key so re-`remember` is idempotent — just with
a per-conversation counter `n` instead of `<docId>#<index>`. One upsert, two
deterministic-id schemes sharing it.

## Interview defense

**Q: Why deterministic chunk ids instead of uuids?**

```
  uuid:           re-index → new ids → duplicate chunks (unless you delete)
  "<docId>#<i>":  re-index → same ids → PK collision → update in place
```
Answer: idempotent re-indexing. The id encodes `(docId, index)`, so
re-indexing the same document collides on the PK and `on conflict do update`
refreshes the row in place — stable chunk count, no duplicates, no
delete-then-insert. **Anchor:** `pg-vector-store.ts:50`, the `on conflict (id)`.

**Q: There's no `unique(document_id, chunk_index)`. Bug?**

No — the deterministic id makes it redundant. Two chunks at the same
`(docId, index)` compute the same id and collide on the PK. The id *is* the
composite-uniqueness guarantee. Adding the constraint would be
belt-and-suspenders, not a fix. **Anchor:** no such constraint in
`sql/001_agents_schema.sql`; the PK at `:14` carries it.

## Validate

1. **Reconstruct:** write the `on conflict do update` upsert from memory and
   say what `excluded.*` refers to.
2. **Explain:** why is there no `unique(document_id, chunk_index)` and why is
   that fine? (`sql/001_agents_schema.sql:14`)
3. **Apply:** you rename `notes.md` → `journal.md` and re-index. What happens
   to the old chunks, and what (doesn't) clean them up?
4. **Defend:** natural key vs surrogate uuid for chunks — make the call and
   name the one case where the natural key bites.

## See also

- `04-soft-link-no-fk.md` — why orphaned chunks aren't cleaned (no FK).
- `02-text-stored-twice.md` — `docId`/`chunkIndex` column + meta redundancy.
- `audit.md` §4 — integrity, the upsert as idempotency mechanism.

---
Updated: 2026-06-24 — noted `@aptkit/memory` reuses the same `on conflict (id)`
upsert with its own deterministic key `memory:<conv>:<n>` (`conversation-memory.ts:82`).
