# Deterministic chunk IDs

**Industry name(s):** natural key / deterministic identifier — here the chunk
primary key (`"<docId>#<index>"`) and the memory key
(`"memory:<conv>:<n>"`). **Type:** Industry standard (natural key vs
surrogate key).

---

## Zoom out, then zoom in

You know the difference between a primary key that's a random UUID (a
*surrogate* key — the database mints it) and one that's derived from the data
itself (a *natural* key — you can compute it). This file is about the second
kind, and why choosing it makes re-indexing an idempotent overwrite instead of
a duplicate-pile.

```
  Zoom out — where the chunk id is decided

  ┌─ aptkit (the pipeline) ──────────────────────────────────┐
  │  chunk a document → id = "<docId>#<index>"  (computed,    │
  │  not random — the natural key)                            │ ← decided here
  └───────────────────────────────┬───────────────────────────┘
                                  │  upsert(chunks)
  ┌─ PgVectorStore ───────────────▼───────────────────────────┐
  │  insert ... on conflict (id) do update  ── id is the      │
  │                                            conflict target │
  └───────────────────────────────┬───────────────────────────┘
                                  │
  ┌─ Postgres (agents.chunks) ────▼───────────────────────────┐
  │  id text primary key  ── the natural key, not a uuid       │ ← lives here
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is "when I re-index the same document, do I get a second
copy of every chunk, or do I overwrite the first?" The answer is entirely the
key choice. A surrogate UUID would mint a new id every run → duplicates. The
natural key `"<docId>#<index>"` computes to the *same* string every run → the
upsert overwrites. The id scheme *is* the dedup strategy.

---

## The structure pass

```
  One axis: "who decides the id, and is it stable across runs?"

  ┌─ documents ──────────────────────────────────────────────┐
  │  id text PK  ── caller-supplied docId (stable)            │  natural
  └─────────────────────────┬────────────────────────────────┘
                            │  seam: chunk id is DERIVED from docId
  ┌─ chunks ────────────────▼────────────────────────────────┐
  │  id = "<docId>#<index>"  OR  "memory:<conv>:<n>"          │  natural,
  │  text PK  ── stable, computed, never random               │  computed
  └─────────────────────────┬────────────────────────────────┘
                            │  seam: the OTHER tables flip to surrogate
  ┌─ conversations / messages / profiles ────────────────────┐
  │  id uuid PK default gen_random_uuid()  ── DB-minted       │  surrogate
  └──────────────────────────────────────────────────────────┘
```

The axis is **who decides the id**. It flips at a clean seam: the corpus side
(`documents`, `chunks`) uses natural keys you can recompute; the
conversation side (`conversations`, `messages`, `profiles`) uses surrogate
UUIDs the database mints (`001:33,41,53`). That flip is not an accident — it
tracks whether re-running the write should overwrite (corpus: yes, so natural)
or always append (a new conversation: yes, so surrogate).

---

## How it works

### Move 1 — the mental model

Think of `key`-ed list rendering in React: `items.map(i => <Row key={i.id}/>)`.
If `key` is the array index, re-ordering breaks identity; if `key` is a stable
id derived from the item, React reconciles correctly across renders. The chunk
id is the same idea at the storage layer — a stable, content-derived key so the
*same* chunk reconciles to the *same* row across re-index runs.

```
  Natural key = stable identity across runs

  run 1:  index(doc "me.md")  → chunks:
            "me.md#0"  "me.md#1"  "me.md#2"
  run 2:  index(doc "me.md")  → SAME ids:
            "me.md#0"  "me.md#1"  "me.md#2"
                  │
                  ▼  on conflict (id) do update
            overwrite in place — no duplicates, no orphans

  (a random uuid each run would have made 6 rows, not 3)
```

### Move 2 — the walkthrough

**The corpus keys are natural — `documents.id` and the derived chunk id.**
`documents.id` is `text primary key` (`sql/001_agents_schema.sql:5`), supplied
by the caller (the `docId`). The chunk id is *derived* from it as
`"<docId>#<index>"` — the document id, a `#`, and the chunk's position. This is
aptkit's deterministic id scheme; buffr consumes it and never edits it (a
must-not-change constraint, `context.md`). The store reads the parts back out of
`meta`:

```ts
// pg-vector-store.ts:43-46  (inside upsert, per chunk)
const docId = typeof c.meta.docId === 'string' ? c.meta.docId : null;     // parent doc
const chunkIndex = typeof c.meta.chunkIndex === 'number' ? c.meta.chunkIndex : 0; // position
const content = typeof c.meta.text === 'string' ? c.meta.text : '';
// c.id arrives already = "<docId>#<chunkIndex>" — computed upstream, not here
```

The store doesn't *mint* the id — it receives `c.id` already formed and uses it
directly. The `docId` and `chunkIndex` it pulls from `meta` are the *parts* the
id was built from, stored as their own columns so you can filter/sort by them
without parsing the string.

**The conflict target is the natural key — that's what makes re-index
idempotent.** The upsert conflicts on `id`:

```ts
// pg-vector-store.ts:48-54
`insert into agents.chunks (id, document_id, app_id, chunk_index,
   content, embedding, embedding_model, meta)
 values ($1, $2, $3, $4, $5, $6::vector, $7, $8)
 on conflict (id) do update set                  // ← id is natural ⇒ same id next run
   document_id = excluded.document_id, app_id = excluded.app_id,
   chunk_index = excluded.chunk_index, content = excluded.content,
   embedding = excluded.embedding, ...`           // overwrite every field
```

Because `id` recomputes to the same string on the next index run, `on conflict
(id)` fires and the row is *updated in place*. Re-index a document whose content
changed and the chunk's embedding/content get overwritten — no stale duplicate
left behind. Had the id been `gen_random_uuid()`, every run would insert fresh
rows and you'd pile up dead chunks.

**The memory key reuses the scheme on a different namespace.** Episodic memory
chunks ride the same table with id `"memory:<conv>:<n>"` — the conversation id,
the exchange number — minted by `@aptkit/memory` when `memory.remember(...)`
runs (`session.ts:67`). Same natural-key discipline: stable, computed,
overwrites on re-remember. The `memory:` prefix is the namespace that keeps
memory ids from ever colliding with corpus ids (`<docId>#<index>` has no
`memory:` prefix). The id prefix *is* the soft type tag, backed up by
`meta.kind='memory'`.

```
  One PK column, two id namespaces — no collision possible

  corpus:  "me.md#0"           "docs/plan.md#3"
  memory:  "memory:7f3a:0"     "memory:7f3a:1"
            └─ prefix ─┘
           different prefix ⇒ different keyspace ⇒ safe to share one table
```

**The boundary condition — a natural key is only safe if it's truly stable.**
If `docId` or `chunkIndex` ever changed for the *same* logical chunk (say you
re-chunked with a different splitter and chunk 2 became chunk 3), the id would
change, the conflict wouldn't fire, and you'd get a new row plus an orphaned old
one. The scheme is correct precisely because aptkit's chunk indices are
deterministic for the same input. That determinism is the load-bearing
assumption — name it, because it's what people forget when they reach for
natural keys.

### Move 3 — the principle

A natural key makes the write *idempotent*: running it twice has the same effect
as running it once. That property is worth more than it looks — it means
re-indexing is safe to retry, safe to run on a cron, safe after a crash, with no
dedup pass. The price is that the key must be genuinely stable for the same
logical entity; the moment the derivation can shift, a surrogate key plus an
explicit unique constraint is the safer choice. Corpus rows get natural keys
(re-runs should overwrite); conversations get surrogate keys (each run is a new
thing). Matching key-type to write-intent is the whole skill.

---

## Primary diagram

```
  Deterministic chunk ids — derivation, write, dedup

  ┌─ aptkit pipeline ─────────────────────────────────────────┐
  │  doc {id:"me.md", text} → split → chunk[i]                 │
  │  chunk[i].id = "me.md#" + i      ── natural key, computed  │
  └──────────────────────────────┬─────────────────────────────┘
                                 │  upsert(chunks)
  ┌─ PgVectorStore.upsert ───────▼─────────────────────────────┐
  │  insert ... values ($1=id, ...)                            │
  │  on conflict (id) do update set ...   ── re-run overwrites │
  │                                          (pg-vector-store   │
  │                                           .ts:48-54)        │
  └──────────────────────────────┬─────────────────────────────┘
                                 │
  ┌─ agents.chunks ──────────────▼─────────────────────────────┐
  │  id text primary key  (001:15)                             │
  │   corpus:  "me.md#0"    memory:  "memory:<conv>:<n>"        │
  │   one keyspace, two prefixes, zero collisions              │
  └────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Natural vs surrogate keys is one of the oldest data-modeling debates. Surrogate
keys (auto-increment, UUID) decouple identity from data, so the key never has to
change when an attribute does — at the cost that you can't compute the key, you
have to store and look it up. Natural keys let you *derive* the id, which is
exactly what enables idempotent upserts and content-addressed storage — at the
cost that the derivation must stay stable forever.

This repo splits the decision by table on a clean principle: **derive when
re-running should overwrite, surrogate when each run is a distinct event.** That
split is visible in the schema itself — `text primary key` on the corpus tables,
`uuid primary key default gen_random_uuid()` on the event tables (`001:5,15` vs
`001:33,41,53`).

---

## Interview defense

**Q: Why a natural key (`"<docId>#<index>"`) for chunks but a UUID for
conversations?**
Because re-indexing a document *should* overwrite its chunks, and starting a
chat *should* create a new conversation. A natural key recomputes to the same
string, so `on conflict (id) do update` overwrites in place — idempotent
re-index, no duplicates. A conversation has no "same conversation" to overwrite,
so a surrogate UUID minted by the DB is correct. Key-type follows write-intent.

```
  Q: natural vs surrogate — which table, why?
  corpus  (overwrite on re-run)  → natural   "me.md#0"
  events  (append each run)      → surrogate gen_random_uuid()
  the rule: derive when re-run should overwrite
```

**Q: What's the one assumption that breaks the natural key?**
That the derivation is stable for the same logical chunk. Re-chunk with a
different splitter so chunk 2 becomes chunk 3, and the id changes — the conflict
won't fire, you get a new row and an orphan. The natural key is only as safe as
the determinism of `docId` + `chunkIndex`. That stability assumption is the
load-bearing part people forget when they reach for natural keys.

---

## See also

- `01-vector-column-and-ann-index.md` — the upsert this key conflicts on
- `03-soft-link-no-fk.md` — the soft link `document_id` that travels with the id
- `06-trajectory-tables.md` — the `memory:` namespace and `meta.kind='memory'`
- `audit.md` §1, §4 — model shape and integrity lenses
