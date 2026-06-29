# 02 · Text stored twice

**Subtitle:** denormalized duplicate of a single fact across a column and a jsonb
field — the DB analog of information leakage — *Project-specific*.

---

## Zoom out, then zoom in

Same chunk text, two homes. Here's where the duplication sits in the write/read
path — it's entirely inside the storage layer's `chunks` row, but it's *created*
on the way in and *re-created* on the way out, so it spans both the write and the
read.

```
  Zoom out — where the duplicated fact lives

  ┌─ Retrieval layer ──────────────────────────────────────┐
  │  pipeline.index(doc)  ──write──►   ◄──read── search()   │
  └─────────────┬───────────────────────────────▲──────────┘
                │                                │
  ┌─ Storage: agents.chunks (one row) ──────────┴──────────┐
  │   content text          ★ copy A (column) ★            │ ← here
  │   meta    jsonb {... text: "...", ...}  ★ copy B ★      │ ← and here
  └────────────────────────────────────────────────────────┘
```

Zoom in: the question is "is the same fact stored in two places that can drift
apart?" Normalization's whole job is single source of truth — one fact, one home,
edit it once. This row breaks that: the chunk's text is in `content` *and* in
`meta.text`, with nothing keeping them equal. It's the data version of the
information-leakage smell `study-software-design` names in code — the same secret
known in two modules.

## The structure pass

One axis: **state ownership** — who is the source of truth for this fact? Trace
it across the write boundary and the read boundary and watch the answer
contradict itself.

```
  axis = "who owns the chunk's text?"

  ┌─ write side (upsert) ──────────┐  both written from c.meta.text
  │  content ← c.meta.text          │  → meta.text is the source
  │  meta    ← c.meta (incl. text)  │
  └──────────────┬──────────────────┘
                 │ seam: the row at rest — TWO copies, no owner
  ┌─ read side (search) ───────────┐  content read back, meta.text
  │  meta.text ← r.content          │  → content is the source
  └─────────────────────────────────┘

  the source of truth FLIPS across the round trip → no single owner
```

That flip is the seam. On write, `meta.text` is the source. On read, `content`
is the source and `meta.text` is rebuilt from it. Neither is the durable owner —
the row at rest holds two copies and the code disagrees with itself about which
is canonical.

## How it works

### Move 1 — the mental model

The shape is a **redundant copy with no binding constraint** — you've seen this
exact bug in app state: a value cached in two `useState` hooks, updated in one
handler, stale in the other. Same thing, in a table.

```
  duplicate-with-no-binding (pattern)

       one fact: "this chunk says X"
              │
      ┌───────┴───────┐
      ▼               ▼
   content        meta.text
   (column)        (jsonb)
      │               │
      └─── no FK, no check, no trigger ───┘
            keeps them equal → they CAN drift
```

### Move 2 — the walkthrough

**The write: both copies land from one source.**
`upsert` pulls the text out of the incoming chunk's `meta.text`, writes it to the
`content` column, *and* writes the whole `meta` object (which still contains
`text`) to the jsonb column. One read, two writes.

```
  File: src/pg-vector-store.ts
  Function: PgVectorStore.upsert
  Lines: 44-56

    const content =
      typeof c.meta.text === 'string' ? c.meta.text : '';   ← copy A source
    ...
    insert into agents.chunks
      (id, document_id, app_id, chunk_index, content, ...)
       values ($1, ..., $5, ...)        ← $5 = content (copy A)
    ... meta = excluded.meta            ← copy B: meta STILL holds .text
                              [c.id, ..., content, ..., c.meta]
                                              copy A ──┘    └── copy B
```

Line 46 reads `c.meta.text` into `content`. Line 55 passes `c.meta` — which
still has `text` inside it — as the jsonb param. So the same string is now in two
columns of the same row. Nothing in the schema (no generated column, no check
constraint, no trigger) forces them to stay equal.

**The read: the copy is rebuilt, not just read.**
On the way out, `search` reads the `content` column, then *reconstructs*
`meta.text` from it before handing the hit back — because the calling tool expects
the in-memory chunk shape where text lives at `meta.text`.

```
  File: src/pg-vector-store.ts
  Function: PgVectorStore.search
  Lines: 80-84

    return rows.map((r) => ({
      id: r.id,
      score: Number(r.score),
      meta: { ...(r.meta ?? {}), docId: r.document_id,
              chunkIndex: r.chunk_index,
              text: r.content },   ← meta.text REBUILT from the column,
    }));                              the stored meta.text is overwritten
```

Look at line 83: it spreads the stored `r.meta` (which has its own `text`), then
sets `text: r.content` *after* — so the column wins on read. The stored
`meta.text` is silently shadowed. Which means: **the duplicate in jsonb is dead
weight on read** — it's written, stored, and then ignored every time it's read
back.

```
  Layers-and-hops — the fact's round trip

  ┌─ caller ──────┐ hop1: chunk{meta.text}  ┌─ upsert ────────┐
  │ pipeline.index│ ──────────────────────► │ content←meta.text│
  └───────────────┘                         │ meta←meta (dup)  │
                                            └────────┬─────────┘
                                              hop2 insert│ BOTH
                                                         ▼
                                            ┌─ chunks row ─────┐
                                            │ content = "X"     │
                                            │ meta.text = "X"   │ ← redundant
                                            └────────┬─────────┘
                  hop4: meta.text=content   hop3 read│
  ┌─ caller ──────┐ ◄────────────────────── ┌─ search ─┴──────┐
  │ tool citations│   (column wins)         │ rebuild meta     │
  └───────────────┘                         └──────────────────┘
```

**The boundary condition — where it bites.** Today nothing edits a chunk's text
in place; chunks are upserted wholesale, so both copies are always written
together and never independently. The duplication is latent, not active. It bites
the day *anything* updates `content` without going through `upsert` — a
data-fix SQL, a backfill, a `migrate` script touching text. Then `content` says
one thing, `meta.text` says another, and which one your code trusts depends on
whether it reads the column or the jsonb. Search reads the column, so search would
be right; any consumer reading `meta.text` straight from a raw row query would be
wrong.

### Move 2 variant — the load-bearing skeleton

The kernel of *the bug* (not the feature):

```
  what makes it a duplication
    1. the same fact written to two stores in one operation
    2. no constraint binding the two equal
    3. divergent read paths that pick different copies
```

- Remove **(2)** by adding a generated column or a check → they can't drift; the
  duplication becomes safe denormalization.
- Remove **(1)** by storing the fact once → the canonical fix (below).
- **(3)** is the latent danger: as long as every read uses the same copy you
  never *see* the drift, which is exactly why it's dangerous.

### Move 3 — the principle

Denormalization is fine — `documents.content` and `chunks.content` hold
overlapping text on purpose, because slicing the doc into chunks is the read
optimization that makes ANN search possible. The line between *good*
denormalization and *bad* duplication is: did you choose a single source of
truth and derive the rest, or do you have two editable originals? Here, `content`
should be the SSOT and `meta.text` should not exist at rest — it should be
*projected* on read, which is exactly what `search` already does. The bug is that
it's also *stored*.

## Primary diagram

The whole duplication, write to read, with the fix overlaid.

```
  Text stored twice — and where to cut it

  WRITE (upsert:44-56)              READ (search:80-84)
  ─────────────────────            ──────────────────────
  c.meta.text                       r.content ──┐
      │                                          │ rebuild
      ├──► content   ●  SSOT  ●  ◄───────────────┘ meta.text
      │     (keep)                      (project on read — already done)
      │
      └──► meta.text ✗  drop  ✗     ← the redundant copy: written,
            (jsonb)                    stored, then SHADOWED on read

  fix: strip `text` from meta before the insert (line 55);
       search already reconstructs it from content (line 83),
       so no read path breaks.
```

## Elaborate

This is a textbook *update anomaly* setup from relational normalization theory:
a fact duplicated across two locations with no functional dependency enforcing
equality, so an update to one leaves the other stale. The classic cure is to
normalize to a single source of truth. Here the cure is unusually cheap because
the read side *already* projects `meta.text` from `content` — the system is one
`delete c.meta.text` away from being correct, and zero read paths would notice.
The reason it exists at all: the in-memory `VectorStore` contract speaks in
`meta.text`, so the simplest "just store the meta object" write carried the
duplicate along. Parity made it easy to do the redundant thing.

## Interview defense

**Q: Your `chunks` table stores the text in both a column and a jsonb field. Why
is that a problem, and why hasn't it bitten yet?**

It's an update-anomaly setup: two editable copies of one fact with no constraint
binding them. It hasn't bitten because every write goes through one `upsert` that
sets both together, and every read goes through `search`, which rebuilds
`meta.text` from `content` — so the column is effectively the source of truth and
the jsonb copy is never actually read.

```
  write: both set from c.meta.text   read: meta.text ← content
         (always together)                  (column wins, jsonb shadowed)
  → drift only possible if something writes content OUT of band
```

Anchor: "two copies, one constraint short of safe — the read path already
treats the column as canonical, so the fix is to stop storing the other copy."

**Q: When would you keep a denormalized copy on purpose?**

When it's a *derived* read optimization with a clear source of truth — like
`chunks.content` being slices of `documents.content`. That's deliberate: you
can't run cosine over a whole document, so you store the slices. The test is
whether you can name which copy is the original and whether the others are
regenerable from it. `meta.text` fails that test (it's a peer copy, not a
derivation); `chunks.content` passes it.

## See also

- `01-vector-column-and-ann-index.md` — the `search` query whose result rows get
  the `meta.text` rebuild.
- `03-soft-link-no-fk.md` — the *other* relationship the schema doesn't enforce.
- `audit.md` Lens 2 — normalization, with the deliberate-vs-accidental split.
- `study-software-design` — information hiding / duplication, the code analog.
