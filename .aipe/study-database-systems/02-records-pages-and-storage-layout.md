# Records, pages, and storage layout

**Subtitle:** heap tuples / 8KB pages / TOAST / the cost model of persistence — *Industry standard*

---

## Zoom out, then zoom in

Every row you've ever inserted lives somewhere physical: a fixed-size block on
disk, read into a buffer in RAM, mutated, and logged. This file is the bottom of
the stack — below the planner, below the index. It's where a `chunks` row and
its 768-dimensional vector actually sit.

```
  Zoom out — storage layout under everything else

  ┌─ SQL / planner ─────────────────────────────────────┐
  │  search() · upsert() · pool.query()                 │
  └───────────────────────┬──────────────────────────────┘
  ┌─ Access methods ──────▼──────────────────────────────┐
  │  HNSW · btree · heap scan                            │
  └───────────────────────┬──────────────────────────────┘
  ┌─ ★ Storage layout ★ ──▼──────────────────────────────┐ ← THIS FILE
  │  heap pages (8KB) · tuples · TOAST · buffer cache    │
  └──────────────────────────────────────────────────────┘
```

Zoom in: a **page** is the unit Postgres reads and writes — 8KB, always, even
to fetch one row. A **tuple** is one row's bytes inside a page. The question
here: when buffr stores a `chunks` row with a 768-float embedding plus a `text`
content blob, *where do those bytes go*, and what does that cost on read?

---

## The structure pass

**Layers.** Storage decomposes into three nested levels:

```
  ┌─ Relation (table) ───────────────┐  agents.chunks — a set of pages
  │   heap file + index files         │
  └──────────────┬────────────────────┘
  ┌─ Page (8KB block) ▼───────────────┐  header + line pointers + tuples
  │   the I/O unit                     │
  └──────────────┬────────────────────┘
  ┌─ Tuple (one row) ▼────────────────┐  header + column values (or TOAST ptr)
  │   the addressable record           │
  └────────────────────────────────────┘
```

**Axis — trace `cost` (bytes moved per operation) down the layers.** *What does
it cost to touch this level?*

- Relation: a seq scan reads **every page** — cost grows with row count.
- Page: one page fetch is one I/O (or one buffer-cache hit) — 8KB regardless of
  how many bytes you wanted.
- Tuple: a wide value (the embedding, a long `content`) may not fit inline and
  gets pushed **out-of-line to TOAST** — turning one logical row into extra page
  fetches.

**Seam — the TOAST threshold (~2KB).** Below it: the value lives inline in the
tuple, one page fetch gets it. Above it: Postgres compresses and/or moves the
value to a side table, and reading it costs extra I/O. A 768-float vector is
~3KB of raw float data — it's *over* the line. This seam is the most important
storage fact in the repo, and nobody configured it; it's automatic.

---

## How it works

### Move 1 — the mental model

You already know an array of structs: fixed-size slots, each holding one
record's fields, packed contiguously so you can index in. A Postgres heap page
is that array — except the slots grow from the bottom, the pointers grow from
the top, and when a field is too big to fit, it's stored elsewhere with a
pointer left behind. Same idea as a JS object holding a giant string by
reference rather than inline.

```
  A heap page — 8KB, two growing ends

  ┌─ page header (24 B) ──────────────────────────┐
  ├─ line pointers ──►  [ptr0][ptr1][ptr2] ...     │  grow down ▼
  │                                                 │
  │              ... free space ...                 │
  │                                                 │
  │   ▲ grow up   ... [tuple2][tuple1][tuple0]      │
  └─────────────────────────────────────────────────┘
   a line pointer (ItemId) → byte offset of its tuple
```

### Move 2 — walk a `chunks` row onto disk

Take one row written by `PgVectorStore.upsert()` (`pg-vector-store.ts:47`) and
follow its bytes.

**The tuple header comes first.** Every Postgres tuple carries a ~23-byte
header before any column data: transaction IDs (`xmin`/`xmax` — the MVCC
versioning from `06`), a null bitmap, and the line-pointer back-reference. You
pay this on every row. For `chunks`, with its small scalar columns, the header
is a real fraction of the inline tuple.

```
  one chunks tuple, inline portion

  ┌ header ┐┌ id ┐┌ document_id ┐┌ app_id ┐┌ chunk_index ┐┌ meta? ┐┌ emb ptr ┐
  │ ~23 B  ││text││ text (soft) ││ text   ││ int4 (4 B)  ││ jsonb ││ TOAST → │
  └────────┘└────┘└─────────────┘└────────┘└─────────────┘└───────┘└────┬────┘
                                                                         │
                                          embedding vector(768) ~3 KB ───┘
                                          (over the TOAST threshold)
```

**The embedding gets TOASTed.** Here's the load-bearing part for this repo. The
schema declares `embedding vector(768) not null` (`001_agents_schema.sql:22`).
768 four-byte floats is ~3072 bytes of payload — above Postgres's ~2KB inline
limit. So the vector is pushed to the TOAST side table, and the main tuple keeps
an 18-byte pointer. **Consequence:** a query that needs the embedding (the
`order by embedding <=> ...` in `search()`) may touch *two* storage locations
per row on an exact scan — the heap tuple and the TOAST chunk. This is one more
reason the HNSW index matters: the index stores its own copy of the vectors in
its graph nodes, so the index walk doesn't pay the TOAST detour the way a seq
scan would.

```
  Layers-and-hops — reading the embedding without an index

  ┌─ Planner ──┐  seq scan plan   ┌─ Heap ────────┐
  │ ORDER BY   │ ───────────────► │ tuple → ptr    │
  │ <=> (no    │                   └──────┬─────────┘
  │  index)    │   hop: deref ptr         ▼
  │            │ ◄──────────────── ┌─ TOAST table ─┐
  └────────────┘   3KB vector       │ embedding blob│
                                    └───────────────┘
   two page fetches per row, for every row → the seq-scan cost cliff
```

**The `content` column may TOAST too.** `content` holds the chunk text. Short
chunks stay inline; a long one crosses the same threshold and gets compressed or
moved. Same mechanism, different column.

**`meta` is `jsonb`, and `jsonb` is binary.** The `meta jsonb` column
(`001_agents_schema.sql:24`) is stored in Postgres's decomposed binary jsonb
format, not as text — which is why `supabase-trace-sink.ts:25` has that comment
about stringifying explicitly: node-postgres needs help to not mistake a JS
array payload for a Postgres array literal. The binary format means key lookups
inside `meta` don't reparse the whole document, but for this repo `meta` is read
whole anyway (rebuilt into the in-memory hit shape at `pg-vector-store.ts:83`).

### Move 3 — the principle

The page is the atom of database I/O, and **the cost of a query is mostly the
count of pages it touches**, not the count of rows it returns. The single
biggest storage fact in this repo — that a 768-dim vector overflows the inline
tuple into TOAST — is exactly why an index that keeps its own copy of the
vectors turns a two-fetch-per-row scan into a sub-linear graph walk. Storage
layout is *why* indexes pay off.

---

## Primary diagram

The full layout: relation → page → tuple → TOAST, with the embedding's path
marked.

```
  agents.chunks — storage layout, full

  ┌─ Relation: agents.chunks (heap file) ──────────────────────┐
  │  page 0          page 1          page 2     ...            │
  │  ┌────────┐      ┌────────┐      ┌────────┐                │
  │  │ tuples │      │ tuples │      │ tuples │  ← 8KB each     │
  │  └───┬────┘      └────────┘      └────────┘                │
  └──────┼──────────────────────────────────────────────────────┘
         │ each tuple:
         ▼
  ┌ header(~23B) ┐ id, document_id, app_id, chunk_index (inline)
  │ + null bitmap│ content ──┐  embedding ──┐  meta(jsonb) ──┐
  └──────────────┘           ▼              ▼                ▼
                        TOAST if >2KB   TOAST (~3KB) ✓    inline/TOAST
                        ┌──────────────────────────────────────┐
                        │  TOAST side table (out-of-line blobs) │
                        └──────────────────────────────────────┘
```

---

## Elaborate

TOAST (The Oversized-Attribute Storage Technique) exists because Postgres pages
are a fixed 8KB and a row must fit in a page — without TOAST you couldn't store
a value larger than ~8KB at all. It kicks in automatically at ~2KB per tuple,
compressing first and moving out-of-line if compression isn't enough. You can
tune it per-column (`alter table ... set storage`), but this repo doesn't and
shouldn't — the default behavior is exactly right for a vector column. The
deeper lesson connects forward to `03`: the reason a vector index isn't just
"nice to have" is that the alternative — scanning TOASTed vectors row by row —
pays the page-fetch cost twice per row, every row.

---

## Interview defense

**Q: A `chunks` row has a 768-dim vector. Where does that vector physically
live?**

> Not inline in the heap tuple. 768 floats is ~3KB, over Postgres's ~2KB TOAST
> threshold, so the vector is pushed to the TOAST side table and the main tuple
> keeps an ~18-byte pointer. On a sequential scan that means two page fetches
> per row to compare an embedding — heap tuple, then deref to TOAST. The HNSW
> index avoids that by keeping its own vector copies in its graph nodes.

```
  tuple ──ptr──► TOAST(3KB vector)   ← seq scan pays this twice per row
  HNSW node ──── vector copy inline  ← index walk doesn't
```

> Anchor: the vector overflows the tuple into TOAST — that's *why* the index
> earns its keep.

**Q: Why does the row count barely matter but the page count does?**

> Postgres reads 8KB at a time, hit or miss — one page fetch is one unit of I/O
> whether you wanted one byte or the whole page. A query's cost is the number of
> pages it has to bring into the buffer cache. A seq scan over `chunks` reads
> every page (plus TOAST derefs); the HNSW index touches a handful. Same rows
> exist either way; the page count is what changed.

```
  seq scan:   all pages + all TOAST derefs   → O(pages)
  HNSW walk:  a few index pages              → O(log-ish)
```

> Anchor: cost is pages-touched, not rows-returned.

---

## See also

- `03-btree-hash-and-secondary-indexes.md` — why the HNSW index's own vector
  copies beat scanning TOASTed heap rows.
- `06-locks-mvcc-and-concurrency-control.md` — the `xmin`/`xmax` in the tuple
  header and what they buy.
- `study-performance-engineering` — the page-fetch cost model applied to the
  per-turn hot path.
