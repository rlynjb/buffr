# Records, Pages, and Storage Layout

**Industry name(s):** heap storage / page layout / row-oriented storage · **Type:** Industry standard

---

## Zoom out, then zoom in

Below the pool seam, every row buffr writes lands in a fixed-size page on disk. The interesting row is `chunks` — it carries a 768-float vector that's far too big to sit inline with the rest of the columns. This file is about what a record physically is and what it costs.

```
  Zoom out — where physical storage sits

  ┌─ Persistence layer ─────────────────────────────────────────┐
  │  PgVectorStore.upsert  →  INSERT … embedding $6::vector      │
  └──────────────────────────┬──────────────────────────────────┘
                             │  SQL
  ┌─ Storage engine ─────────▼──────────────────────────────────┐
  │  ★ THIS FILE: how that row becomes bytes on a page ★         │ ← we are here
  │                                                              │
  │   8KB heap page ──┬── tuple header                           │
  │                   ├── inline columns (id, app_id, content…)  │
  │                   └── embedding → TOAST (out of line)        │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: Postgres is **row-oriented** — a record stores all of one row's columns together, in one place, on one page. That's the opposite of column stores (which keep each column contiguous for analytics). For buffr's access pattern — fetch a whole chunk by similarity, return its content + meta — row orientation is exactly right: one row read gets you everything the citation needs.

---

## The structure pass

Two layers: the logical row (what your SQL sees) and the physical tuple (what the disk holds). Trace one axis: *where does each column physically live?*

```
  Axis = "where do this row's bytes live?"  — traced across one chunks row

  ┌─ logical row (your INSERT) ──────────────────────────────────┐
  │  id, app_id, chunk_index, content, embedding, meta           │  → "all together"
  └──────────────────────────┬───────────────────────────────────┘
                  physical split here ▼  (the seam)
  ┌─ main heap page ─────────┐    ┌─ TOAST table ────────────────┐
  │ id, app_id, chunk_index, │    │ embedding (768 floats ≈ 3KB)  │
  │ small content, meta ptr  │ ──►│ large content, large meta     │
  └──────────────────────────┘    └───────────────────────────────┘
       small + fixed                   big + variable
```

The seam is **TOAST** (The Oversized-Attribute Storage Technique). It flips the "where do the bytes live" answer: small/fixed columns stay inline on the main page; anything over ~2KB gets compressed and pushed to a side table, with only a pointer left inline. The 768-dim `embedding` (≈3KB raw) and long `content` cross that line. **This is the load-bearing fact for the vector column:** every similarity hit that returns `content` may require a second page fetch to de-TOAST it.

---

## How it works

### Move 1 — the mental model

You know how a JS object with a huge string field is still "one object," but the engine stores big strings on the heap and keeps a pointer in the object slot? A Postgres tuple does the same. The page is a fixed 8KB slab; the tuple is a header plus column values; oversized values get a pointer to TOAST.

```
  The pattern — an 8KB heap page holds many tuples

  ┌─ 8KB heap page ───────────────────────────────────┐
  │ page header │ line pointers → → →                  │
  │ ┌────────┐ ┌────────┐ ┌────────┐                   │
  │ │ tuple1 │ │ tuple2 │ │ tuple3 │  …  (grows up)    │
  │ └────────┘ └────────┘ └────────┘                   │
  │            free space                              │
  │   (tuples fill from the bottom, pointers from top) │
  └────────────────────────────────────────────────────┘
       each tuple = header + visibility info + columns
```

One sentence: **a table is a heap of 8KB pages, each packed with row tuples, oversized columns spilled to TOAST.**

### Move 2 — the walkthrough

**The tuple header carries MVCC bookkeeping.** Every tuple starts with a 23-byte header holding `xmin`/`xmax` — the transaction IDs that decide which snapshots can see this row version. Bridge: it's metadata you never SELECT but always pay for. This is why an `UPDATE` doesn't overwrite in place — it writes a *new* tuple with a new `xmin`. (Full mechanism in `06`.) Drop the header and MVCC can't tell a live row from a dead one.

**Fixed and small columns sit inline.** `id` (text), `app_id` (text), `chunk_index` (int), `embedding_model` (text) — these live directly in the tuple on the main page. Reading them is free once the page is in the buffer cache.

```
  One chunks tuple — inline vs TOASTed

  ┌─ tuple on main heap page ──────────────────────────┐
  │ header(xmin,xmax) │ id │ app_id │ chunk_index │ ... │
  │ │ embedding_model │ content(if small)             │
  │ │ meta(jsonb, if small)                           │
  │ │ embedding → [TOAST pointer] ─────────┐          │
  └────────────────────────────────────────┼──────────┘
                                            ▼
                              ┌─ TOAST table ──────────┐
                              │ 768 floats, compressed  │
                              └─────────────────────────┘
```

**The vector(768) is the TOAST tenant.** pgvector stores a `vector(768)` as a length-prefixed array of 4-byte floats — ≈3076 bytes raw. That's well over the ~2KB TOAST threshold, so embeddings live out-of-line by default. Here's where it bites: a `SELECT embedding` (rare in buffr) pays the de-TOAST cost, but the ANN *index* stores its own copy of the vectors in the HNSW graph, so similarity *search* mostly reads the index, not the TOASTed column. The column is fetched only to return `content`, not the vector itself — `search()` selects `content` and `meta`, never `embedding` (`src/pg-vector-store.ts:71`).

**jsonb meta is binary, not text.** `meta jsonb` (schema line 24) is stored as a parsed binary tree, not a string — so a key lookup doesn't reparse, and small metas stay inline. Bridge: it's the difference between `JSON.parse(str)` on every read versus a pre-parsed object. Large metas TOAST like any oversized value.

### Move 3 — the principle

Row-oriented storage means *the unit of I/O is the row, and big columns leak out to TOAST.* For buffr that's a clean fit: retrieval wants the whole chunk (content + meta) per hit, and the giant vector is read by the index, not re-fetched from the row. The cost model to carry: **a row read is one page fetch; an oversized column read is two.**

---

## Primary diagram

The full picture — logical row, physical split, what the index touches.

```
  chunks storage — logical row to physical bytes

  INSERT into agents.chunks (id, document_id, app_id, chunk_index,
                             content, embedding, embedding_model, meta)
                                  │
        ┌─────────────────────────┴──────────────────────────┐
        ▼                                                     ▼
  ┌─ main heap (8KB pages) ─────────────┐      ┌─ TOAST table ──────────┐
  │ header(xmin/xmax) · id · app_id ·   │      │ embedding: 768×f32 ≈3KB │
  │ chunk_index · embedding_model ·     │ ───► │ (compressed)            │
  │ small content/meta · [TOAST ptrs]   │      │ large content / meta    │
  └──────────────┬──────────────────────┘      └─────────────────────────┘
                 │                                        ▲
        PK btree(id) points here              de-TOAST only when content
                 │                            is returned by search()
  ┌─ HNSW index ─▼──────────────────────┐
  │ its OWN copy of the vectors, in a    │  ← search reads HERE, not the
  │ navigable small-world graph          │     TOASTed embedding column
  └──────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** The storage layout is decided entirely in the `chunks` DDL and exercised by every `upsert`/`search`. There's no code that *manages* pages — Postgres does — but the column choices in the schema determine the physical layout.

```
  sql/001_agents_schema.sql  (lines 14–25)  — the row that TOASTs

  create table if not exists agents.chunks (
    id text primary key,                         ← inline, small
    document_id text,                            ← inline (soft link, see 05)
    app_id text not null default 'laptop',       ← inline
    chunk_index int not null,                    ← inline, 4 bytes
    content text not null,                       ← inline if small, TOAST if big
    embedding vector(768) not null,              ← ≈3KB → TOASTed by default
    embedding_model text not null default '...', ← inline
    meta jsonb not null default '{}'             ← binary; inline if small
  );
       │
       └─ the embedding is the only column guaranteed to TOAST. It's why
          search() never SELECTs it — reading it back would de-TOAST 3KB
          per row for no reason; the score comes from the index instead.
```

```
  src/pg-vector-store.ts  (lines 70–78)  — selecting around the TOAST

  select id, content, chunk_index, document_id, meta,
         1 - (embedding <=> $1::vector) as score   ← embedding USED, not RETURNED
  from agents.chunks
       │
       └─ `embedding <=> $1` is computed by the index walk; the column itself
          is never in the SELECT list. So a 4-row search returns 4 small
          tuples + maybe 4 de-TOASTed `content` reads — never 4×3KB vectors.
```

```
  src/pg-vector-store.ts  (lines 15–17, 55)  — the wire format

  function toVectorLiteral(v: number[]): string {
    return `[${v.join(',')}]`;            ← JS array → "[0.1,0.2,...]" text
  }
  // …values ($1,…,$6::vector,…)  with toVectorLiteral(c.vector)
       │
       └─ pgvector accepts the text literal and casts ($6::vector) into its
          packed binary on-disk form. The text form is the WIRE shape;
          the 4-byte-float-array is the STORED shape.
```

---

## Elaborate

TOAST exists because Postgres committed to 8KB pages early and needed a way to store values bigger than a page without redesigning the heap. The threshold (`TOAST_TUPLE_THRESHOLD`, ~2KB) is the point past which a value is pushed out to keep the main tuple small enough that many fit per page — which keeps sequential scans and index lookups touching fewer pages.

For vector workloads this is why the *index* matters so much more than the column: HNSW keeps its own compact copy of the vectors in its graph nodes, so the hot search path never touches the TOASTed column. The column is the source of truth; the index is the working copy. That split is the whole reason an ANN index is fast — covered next in `03`.

Cross-link: `study-data-modeling` owns whether `content` *should* live on the chunk at all (denormalization) and the jsonb `meta` shape. This file owns only the physical consequence of those choices.

---

## Interview defense

**Q: A chunk has a 768-dim vector. Where does it physically live, and does similarity search read it?**

The vector is ≈3KB, over the ~2KB TOAST threshold, so it's stored compressed in a TOAST side-table with a pointer left in the main tuple. Similarity search does *not* read that column — the HNSW index holds its own copy of the vectors, so the search walks the index and only de-TOASTs `content` for the returned rows.

```
  main tuple ──[ptr]──► TOAST(embedding 3KB)   ← NOT read by search
       │
  HNSW index holds its own vector copy  ← search reads THIS
```

Anchor: *"The column is the source of truth; the index is the working copy — search reads the working copy."*

**Q: Why is Postgres row-oriented a good fit here?**

Retrieval wants the whole chunk per hit — content plus meta for the citation. Row orientation puts those on one page, so one row read serves the citation. A column store would scatter them.

Anchor: *"One hit needs the whole row — row storage gives it in one fetch."*

---

## Validate

1. **Reconstruct:** Draw an 8KB heap page with three tuples and show where the `embedding` value actually lives.
2. **Explain:** Why does `search()` (`src/pg-vector-store.ts:71`) select `content` but never `embedding`? What would change if it selected `embedding`?
3. **Apply:** You add a `summary text` column that's usually 5KB. Inline or TOAST? What does that cost a `SELECT *`?
4. **Defend:** Someone says "store the vector as a JSON string column instead of `vector(768)`." Name two physical-storage reasons that's worse.

---

## See also

- `03-btree-hash-and-secondary-indexes.md` — the HNSW index's own copy of the vectors
- `01-database-systems-map.md` — the pool seam above this layer
- `06-locks-mvcc-and-concurrency-control.md` — the `xmin`/`xmax` tuple header in action
- `study-data-modeling` — whether `content`/`meta` belong on the chunk at all
