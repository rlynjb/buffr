# Records, pages, and storage layout

**Industry name:** heap storage / tuples and pages / the row-store layout —
*Industry standard*

---

## Zoom out — where this concept lives

This is the bottom band of the map — below the planner, below MVCC, where rows
actually become bytes on disk. You almost never write code at this level, but it
explains *cost*: why a 768-dim vector row is heavy, why TOAST exists, and why
re-indexing the same corpus bloats the table.

```
  where storage layout sits

  ┌─ Execution layer ───────────────────────────────────┐
  │  planner / executor — asks the access method for rows│
  └───────────────────────────┬──────────────────────────┘
                              │  "give me tuple at (page, offset)"
  ┌─ Access methods ──────────▼──────────────────────────┐
  │  B-tree / HNSW point at heap locations (ctid)        │
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ Storage layer ───────────▼──────────────────────────┐
  │  ★ heap pages (8 KB each) ★                           │
  │  page → tuples → columns → bytes      + TOAST + WAL   │
  └───────────────────────────────────────────────────────┘
```

That starred band is this file.

---

## Zoom in — narrow to the concept

The question: *when buffr inserts one chunk row, what physically gets written, and
why does it cost what it costs?* A chunk row carries an `embedding vector(768)` —
768 four-byte floats, ~3 KB of raw vector. That single column is most of the row's
weight, and it shapes everything below: page packing, TOAST, and how expensive an
update is. Name the unit (the *tuple*), the container (the *page*), and the overflow
mechanism (*TOAST*), then walk how a buffr chunk lands.

---

## The structure pass

### Layers

```
  table (agents.chunks)
    └─ relation file on disk
         └─ pages          (fixed 8 KB blocks)
              └─ tuples     (one row version each)
                   └─ columns (id, document_id, embedding, content, meta…)
```

### Axis: trace *"where does this byte live?"* down the layers

```
  "where does the byte physically live?"  — traced down a chunk row

  ┌────────────────────────────────────────────┐
  │ row: id, document_id, app_id, chunk_index   │  → inline in the tuple,
  │      embedding_model, embedding(768), …     │     on the heap page
  └───────────────────────┬─────────────────────┘
      ┌───────────────────▼───────────────────┐
      │ content (long markdown text)           │  → maybe TOASTed: pushed to a
      │ meta (jsonb)                           │     side table if the row > ~2KB
      └───────────────────┬───────────────────┘
          ┌───────────────▼───────────────────┐
          │ embedding vector(768) ≈ 3 KB       │  → big enough to FORCE TOAST,
          │                                    │     stored compressed/out-of-line
          └────────────────────────────────────┘

  the answer flips: small scalar columns stay inline; the 3 KB vector and long
  text get pushed out-of-line via TOAST. that flip is the seam.
```

### Seams

```
  seam 1  tuple ↔ TOAST     the ~2 KB threshold. Postgres wants 4 tuples per 8 KB
                            page; a 3 KB vector blows that, so the vector is
                            TOASTed out-of-line. A vector search must then chase
                            the TOAST pointer to read the embedding back.
  seam 2  live ↔ dead tuple  an UPDATE doesn't overwrite — it writes a NEW tuple and
                            marks the old one dead (MVCC, file 06). The dead tuple
                            occupies the page until vacuum. This is where bloat lives.
```

Hand off: rows are tuples on 8 KB pages; the 768-dim vector is heavy enough to TOAST;
updates leave dead tuples behind.

---

## How it works

### Move 1 — the mental model

You know how a JS array of objects is just a contiguous block of memory, and a big
string field gets a pointer to a heap allocation elsewhere? A Postgres table is the
same idea on disk: a sequence of fixed-size *pages*, each page packed with *tuples*
(row versions), and any column too big for the page gets a pointer to an overflow
area (TOAST). The chunk's 768-dim vector is the "big string" here.

```
  one 8 KB heap page — chunks table

  ┌─ page (8192 bytes) ───────────────────────────────┐
  │ header │ line ptr │ line ptr │ ...                 │
  │        └────┬─────┴────┬─────┘                     │
  │             ▼          ▼                           │
  │   ┌─ tuple ──────┐  ┌─ tuple ──────┐               │
  │   │ id, app_id,  │  │ id, app_id,  │   ← scalar    │
  │   │ chunk_index, │  │ chunk_index, │     cols      │
  │   │ EMBEDDING →──┼──┼─ TOAST ptr   │     inline;   │
  │   └──────────────┘  └──────────────┘     vector    │
  │                                          out-of-line│
  └────────────────────────────────────────────────────┘
            │ TOAST pointer
            ▼
  ┌─ pg_toast side table ─────────────┐
  │ the ~3 KB vector(768), compressed │
  └────────────────────────────────────┘
```

### Move 2 — walk the layout

**The tuple — what one chunk row is made of.** The schema spells out the columns;
each becomes a field in the tuple, in order.

```sql
-- sql/001_agents_schema.sql:14-25
create table if not exists agents.chunks (
  id text primary key,            -- variable-length text, inline
  document_id text,               -- the soft link (no FK) → see study-data-modeling
  app_id text not null default 'laptop',
  chunk_index int not null,       -- 4 bytes, inline
  content text not null,          -- long markdown → TOAST candidate
  embedding vector(768) not null, -- ≈ 3 KB → forced out-of-line
  embedding_model text not null,
  meta jsonb not null default '{}'-- jsonb → TOAST candidate
);
```

Every tuple also carries a 23-byte header (xmin/xmax transaction ids — that's the
MVCC machinery of file `06`) before the first column. So a chunk row is: header +
small scalars inline + TOAST pointers for the vector, the long content, and a fat
`meta`.

**The page — the 8 KB container.** Postgres reads and writes the heap in fixed 8 KB
blocks, never single rows. Postgres aims for roughly four tuples per page (the
`fillfactor` story). A 3 KB vector inline would mean two tuples per page and
constant page splits, so the planner's TOAST machinery pushes vectors out-of-line by
default. **Consequence:** a sequential scan of `chunks` reads mostly *scalar* columns
fast, but every time it needs an embedding it chases a TOAST pointer to another
page — extra I/O per row. That's one reason you want the index to avoid the scan
entirely (file `04`).

**TOAST — the overflow seam.** "The Oversized-Attribute Storage Technique." Any row
wider than ~2 KB gets its largest compressible columns moved to a hidden
`pg_toast_*` table, leaving an 18-byte pointer inline.

```
  TOAST decision, per chunk insert

   row width after packing scalars?
        │
        ├─ ≤ ~2 KB ──► everything inline, one heap tuple
        │
        └─ > ~2 KB ──► compress + move the vector/content/meta out-of-line
                       inline tuple keeps a pointer
                       ▲ buffr's chunks ALWAYS hit this: the vector alone is ~3 KB
```

For buffr this is not a maybe — a `vector(768)` is ~3 KB, so every chunk row is
TOASTed. That's fine; it's just worth knowing the embedding lives one pointer-hop
away from the rest of the row.

**Dead tuples — why re-indexing bloats.** Here's the part that bites in practice.
`upsert` runs `on conflict (id) do update`. An UPDATE in Postgres is *not* an
in-place overwrite — MVCC writes a brand-new tuple and marks the old one dead
(`xmax` set).

```ts
// src/pg-vector-store.ts:50-54 — every re-index of the same chunk id
on conflict (id) do update set
  embedding = excluded.embedding, ...  // ← writes a NEW tuple version,
                                       //   old version becomes dead weight
```

```
  re-index the same corpus twice — what the page holds

  pass 1:  [ chunk#0 v1 ][ chunk#1 v1 ]              page A
  pass 2:  [ chunk#0 v1 ✝][ chunk#1 v1 ✝][ #0 v2 ][ #1 v2 ]  ← old versions dead,
                                                                still occupying space
           ✝ = dead tuple, reclaimed only when autovacuum runs
```

**Consequence:** re-indexing the same documents repeatedly (easy to do during dev —
just re-run the index CLI) doubles the live+dead tuple count until autovacuum
catches up, and every dead tuple's HNSW index entry has to be re-inserted too
(file `03`). The table and the index both bloat. This is the storage-layer cost of
the convenient `on conflict do update`.

### Move 3 — the principle

Storage layout is a cost model, not trivia. The two facts that pay rent: **(1)** the
unit of I/O is the 8 KB page, so anything that forces extra page reads (TOAST
chasing, low tuples-per-page) costs you; **(2)** updates write new tuples and leave
dead ones, so an "upsert-heavy" workload trades simplicity for bloat you must vacuum
away. Both are invisible in the code and decisive in production.

---

## Primary diagram

The full layout: row → tuple → page → TOAST, with the dead-tuple churn marked.

```
  chunks storage layout — full recap

  ┌─ Storage layer (heap file for agents.chunks) ────────────────────┐
  │                                                                  │
  │  ┌─ 8 KB page ──────────────────────────────────────┐           │
  │  │ pageheader │ lineptrs │                           │           │
  │  │  ┌─ live tuple ─────────────┐  ┌─ dead tuple ✝ ──┐ │           │
  │  │  │ 23B header (xmin/xmax)   │  │ old version,     │ │           │
  │  │  │ id, app_id, chunk_index  │  │ awaiting vacuum  │ │           │
  │  │  │ content → TOAST ptr ─────┼─┐│                  │ │           │
  │  │  │ embedding → TOAST ptr ───┼┐││                  │ │           │
  │  │  │ meta → TOAST ptr ────────┼┘││                  │ │           │
  │  │  └──────────────────────────┘ │└──────────────────┘ │           │
  │  └───────────────────────────────┼─────────────────────┘           │
  │                                  ▼                                 │
  │  ┌─ pg_toast side table ─────────────────────┐                     │
  │  │ vector(768) ≈3KB · long content · big meta │ (compressed)        │
  │  └────────────────────────────────────────────┘                     │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The heap layout dates to early Postgres and is shared by every table you'll ever
make — the vector extension changes nothing here. The reason it matters for a vector
workload specifically: ANN indexes (file `03`) store their *own* copy of the vectors
in the index structure, so a search can often answer from the index without touching
the TOASTed heap copy at all — until it needs the `content` for the citation, which
*does* require the heap fetch (`search` selects `content`, `pg-vector-store.ts:71`).
That heap fetch after the index lookup is the classic "index gets you the row id,
the heap gets you the row" two-step.

Vacuum and bloat connect forward to file `06` (MVCC) and `07` (the vacuum/WAL
relationship). The TOAST threshold and `fillfactor` are tuning knobs that
`study-performance-engineering` owns.

---

## Interview defense

**Q: "How big is one chunk row, and where does the vector live?"**

```
  one chunk row on disk

  inline tuple ──► scalars + 23B header + 3 TOAST pointers   (~small)
       │
       └─ TOAST ──► vector(768) ≈ 3 KB + long content + meta  (out-of-line)
```

Answer: "The scalar columns and the MVCC header sit inline on an 8 KB heap page. The
768-dim vector is ~3 KB — too wide to keep inline if you want sane page packing — so
it's TOASTed: compressed and stored in a side table with a pointer left behind.
Every chunk row hits TOAST because the vector alone exceeds the threshold." Anchor:
*the vector is the heavy column and it lives one pointer-hop out-of-line.*

**Q: "Why does re-indexing the same corpus slow down?"**

Answer: "`upsert` does `on conflict do update`, and an UPDATE in Postgres writes a
new tuple and leaves the old one dead — MVCC, not in-place. Re-run the indexer and
you double live+dead tuples plus their HNSW entries until autovacuum reclaims them.
The table and index bloat." Anchor: *updates leave dead tuples; upsert-heavy means
vacuum-heavy.*

---

## See also

- `03-btree-hash-and-secondary-indexes.md` — the HNSW index keeps its own vector copy.
- `06-locks-mvcc-and-concurrency-control.md` — why an UPDATE writes a new tuple.
- `07-wal-durability-and-recovery.md` — vacuum, checkpoints, and the WAL.
- `study-data-modeling` — the column-type and soft-link *shape* choices.
- `study-performance-engineering` — `fillfactor`, TOAST thresholds, vacuum tuning.
