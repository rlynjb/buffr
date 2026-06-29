# 04 · Deterministic chunk ids

**Subtitle:** content-derived primary keys (`"<docId>#<index>"`,
`"memory:<conv>:<n>"`) enabling idempotent upsert — natural keys over surrogate
keys — *Industry standard*.

---

## Zoom out, then zoom in

The `chunks` primary key isn't a random UUID — it's *constructed* from what the
chunk is. `"doc-readme#3"` means "chunk 3 of document doc-readme."
`"memory:abc-123:0"` means "memory exchange 0 of conversation abc-123." The id
*is* the address, and that's what makes re-indexing safe.

```
  Zoom out — where the id is minted

  ┌─ Retrieval / Memory layer (aptkit) ─────────────────────┐
  │  chunker → id = "<docId>#<index>"                        │
  │  memory  → id = "memory:<conv>:<n>"                      │
  └───────────────────────────┬─────────────────────────────┘
                              │  upsert(chunks)
  ┌─ Storage: agents.chunks ──▼─────────────────────────────┐
  │  id text PRIMARY KEY        ★ the deterministic key ★     │ ← here
  │  on conflict (id) do update ...   ← idempotency hinges    │
  └─────────────────────────────────────────────────────────┘
```

Zoom in: the question is "what happens when you re-index a document you've
already indexed?" With a random surrogate key, you'd get duplicate chunks — same
text, new ids, piling up. With a deterministic key, the second index *updates*
the same rows. The id carries the identity, so `upsert` is naturally idempotent.

## The structure pass

One axis: **identity** — what decides whether two writes are "the same row"?
Trace it across a surrogate-key design and this natural-key design.

```
  axis = "what makes two chunk writes collide vs coexist?"

  ┌─ surrogate key (uuid) ─────────┐  identity = random
  │  re-index → new uuid → NEW row │  → duplicates accumulate
  └────────────────┬────────────────┘
                   │ seam: WHERE identity is decided
  ┌─ natural key (docId#index) ────┐  identity = content address
  │  re-index → same id → UPDATE   │  → idempotent, no dupes
  └─────────────────────────────────┘
```

The seam is *where identity is decided*. Push it into the id-minting (natural
key) and the database's `on conflict (id)` becomes an idempotency engine for
free. Leave identity to a random default and you need application logic to
dedupe.

## How it works

### Move 1 — the mental model

The shape is a **content-addressed key** — the same idea as a React list `key`
derived from a stable item id rather than the array index. The key tells the
reconciler "this is the same item as before," so it updates in place instead of
remounting. Here the key tells Postgres "this is the same chunk as before," so it
updates instead of inserting a duplicate.

```
  deterministic id → idempotent upsert (pattern)

  index "doc-A" first time            index "doc-A" again (edited)
  ──────────────────────              ──────────────────────────
  "doc-A#0" → INSERT                  "doc-A#0" → conflict → UPDATE
  "doc-A#1" → INSERT                  "doc-A#1" → conflict → UPDATE
  "doc-A#2" → INSERT                  "doc-A#2" → conflict → UPDATE

  same ids → same rows → no duplicates, content refreshed in place
```

### Move 2 — the walkthrough

**The id is the primary key — that's the whole leverage.**

```
  File: sql/001_agents_schema.sql
  Lines: 14-15

    create table if not exists agents.chunks (
      id text primary key,     ← text, not uuid; the id IS the address
```

`id text primary key` — not `uuid default gen_random_uuid()` like the
`conversations`, `messages`, and `profiles` tables (`001:33`, `:41`, `:53`). The
choice of a *text* primary key with no default is the signal: the id comes from
the application, deterministically, not from the database randomly.

**The upsert that the id makes idempotent.**
`on conflict (id) do update` is the clause that turns "insert" into "insert or
refresh." It only works because the id collides on re-index — which only happens
because the id is deterministic.

```
  File: src/pg-vector-store.ts
  Function: PgVectorStore.upsert
  Lines: 47-56

    insert into agents.chunks (id, document_id, ..., content, embedding, ...)
      values ($1, $2, ..., $5, $6::vector, ...)
    on conflict (id) do update set        ← collision → refresh in place
      document_id = excluded.document_id,
      content     = excluded.content,      ← new text
      embedding   = excluded.embedding,    ← new vector
      meta        = excluded.meta
```

Re-index an edited document and `"doc-A#0"` collides on the PK; `do update`
overwrites its content and embedding with the new values. No duplicate, no stale
row. `excluded` is the would-be-inserted row — Postgres's name for "the values
you tried to insert that lost the conflict."

**Two id namespaces, one column.**
The same `id text` column holds two kinds of address — document chunks and memory
chunks — distinguished by their prefix shape:

```
  id format            meaning                       has document_id?
  ───────────────────  ───────────────────────────   ─────────────────
  "<docId>#<index>"    chunk #index of document docId  yes
  "memory:<conv>:<n>"  memory exchange n of conv       NO (→ 03)
```

The `"memory:"` prefix and `:`-separation make the namespace self-describing —
you can tell a memory chunk from a document chunk by its id alone, without
reading `meta.kind`. That's the same trick as prefixed Stripe ids (`cus_`,
`ch_`): the type is encoded in the key.

```
  Layers-and-hops — id minted upstream, identity enforced downstream

  ┌─ aptkit chunker ─┐ hop1: chunk{ id:"doc-A#0" } ┌─ upsert ────────┐
  │ id = docId+"#"+i │ ──────────────────────────► │ values ($1=...) │
  └──────────────────┘                             └────────┬────────┘
  ┌─ aptkit memory ──┐ hop2: chunk{ id:"memory:..." }       │ insert
  │ id="memory:c:n"  │ ──────────────────────────► ─────────┤
  └──────────────────┘                                      ▼
                                          ┌─ chunks.id PRIMARY KEY ──┐
                                          │ on conflict → UPDATE      │
                                          │ identity enforced HERE    │
                                          └───────────────────────────┘
```

**The boundary condition.** Determinism cuts both ways. Because `"doc-A#0"` is
fixed, editing document A and re-indexing correctly refreshes chunk 0. But if the
edited document is *shorter* — say it now produces only 2 chunks instead of 4 —
the upsert refreshes `#0` and `#1` but **leaves `#2` and `#3` orphaned**. Nothing
deletes the now-extra chunks; the deterministic id only covers the ones that
still exist. That's the classic upsert-without-delete gap, and it's real here
because there's no "delete chunks for doc where index >= new count" step in
`indexDocumentRow` (`runtime.ts:11-17`).

### Move 2 variant — the load-bearing skeleton

```
  the kernel of "deterministic id → idempotent write"
    1. an id derived from stable content/position, not random
    2. that id as the primary key
    3. on conflict (id) do update — collision means "same thing, refresh"
```

- Drop **(1)** (use a uuid default) → re-index creates duplicates; you'd need
  app-side dedupe.
- Drop **(2)** (id not the PK) → the conflict has nothing to fire on.
- Drop **(3)** (plain insert) → re-index throws a PK violation instead of
  refreshing.

The gap the kernel does *not* cover: shrinking content leaves orphan high-index
chunks. Idempotency for the rows that still exist; no cleanup for the rows that
should stop existing.

### Move 3 — the principle

A natural key — one derived from the data's own identity — collapses three
operations into one: insert, update, and dedupe all become a single idempotent
upsert. The price is that you must compute the key deterministically and the key
must stay stable as the data changes. When both hold, you get re-runnable writes
for free, which is exactly what you want for an indexing pipeline you'll run again
every time a document changes. The trap to remember: idempotency covers writes,
not deletions — a key that's gone needs explicit cleanup.

## Primary diagram

The full idempotency story, including the orphan gap.

```
  Deterministic ids — idempotent upsert + the shrink gap

  doc-A v1 (4 chunks)        doc-A v2 (2 chunks, edited shorter)
  ─────────────────          ──────────────────────────────────
  "doc-A#0" INSERT  ──────►  "doc-A#0" conflict → UPDATE ✓
  "doc-A#1" INSERT  ──────►  "doc-A#1" conflict → UPDATE ✓
  "doc-A#2" INSERT  ──────►  ( not re-written )  → ORPHAN ✗
  "doc-A#3" INSERT  ──────►  ( not re-written )  → ORPHAN ✗
                                              │
                              fix: delete from chunks where
                                   document_id=$doc and chunk_index >= $newCount
```

## Elaborate

Natural keys vs surrogate keys is one of the oldest debates in relational design.
Surrogate keys (random UUIDs, auto-increment ints) win when the data has no
stable natural identity or when you want to decouple the key from the content.
Natural keys win exactly here: an indexing pipeline that re-runs, where "chunk 3
of document X" *is* a stable identity. The repo splits the difference correctly —
natural text keys for `chunks` (where idempotency matters), surrogate UUIDs for
`conversations`/`messages`/`profiles` (where rows are append-only and have no
natural identity). That split is itself a design signal worth defending.

## Interview defense

**Q: Why is `chunks.id` a text natural key while `messages.id` is a UUID?**

Chunks are re-indexed — every time a document changes, you re-run the pipeline —
so they need *idempotent* writes: same chunk, same id, `on conflict do update`,
no duplicates. The id `"<docId>#<index>"` is a stable address that makes that
work. Messages are append-only trajectory events with no natural identity and
never get rewritten, so a random UUID is correct there.

```
  chunks:   re-indexed → need idempotency → natural key + upsert
  messages: append-only → no re-write → surrogate uuid is fine
```

Anchor: "natural key where writes repeat, surrogate key where writes are
append-only."

**Q: What's the failure mode of deterministic chunk ids that people miss?**

Shrinking content. If a re-indexed document produces fewer chunks than before,
the upsert refreshes the surviving ids but leaves the high-index chunks orphaned
— `"doc-A#2"` and `#3` linger with stale content. Idempotency covers the rows
that still exist; it doesn't delete the rows that shouldn't. You need an explicit
`delete where chunk_index >= newCount` to close it.

```
  4 chunks → 2 chunks:  #0,#1 updated · #2,#3 ORPHANED (no delete step)
```

Anchor: "upsert is idempotent for what exists, blind to what should stop
existing."

## See also

- `03-soft-link-no-fk.md` — why the `"memory:..."` ids can carry a NULL
  `document_id`.
- `01-vector-column-and-ann-index.md` — the upsert these ids flow through.
- `07-non-atomic-document-chunk-write.md` — the missing-delete gap is part of the
  same indexing-write weakness.
