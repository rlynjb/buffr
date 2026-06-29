# Query planning and execution

**Industry name:** the query planner / optimizer · scan and join selection ·
EXPLAIN — *Industry standard*

---

## Zoom out — where this concept lives

The planner sits between your SQL and the access methods. You hand it a declarative
query ("give me the nearest 5 chunks"); it decides the *physical* plan — which scan,
which index, in what order. It's the band that turns the operator/opclass alignment
of file `03` into an actual decision: index scan, or sequential scan.

```
  where the planner sits

  ┌─ Connection layer ───────────────────────────────────┐
  │  SQL text arrives over the wire                       │
  └───────────────────────────┬───────────────────────────┘
                              │
  ┌─ Query execution layer ───▼───────────────────────────┐
  │  parse → ★ PLAN (cost-based choice) ★ → execute        │
  │  "seq scan or index scan? which join? sort or not?"   │
  └───────────────────────────┬───────────────────────────┘
                              │ chosen plan
  ┌─ Access methods ──────────▼───────────────────────────┐
  │  HNSW / B-tree / heap scan                            │
  └───────────────────────────────────────────────────────┘
```

---

## Zoom in — narrow to the concept

The question: *for buffr's one hot query — the vector search — does the planner pick
the fast index path or the slow scan, and how would you ever know?* The planner is
cost-based: it estimates the cost of each candidate plan and picks the cheapest. For
the vector search there are exactly two candidates — walk the HNSW graph, or scan
every row and compute distance. Which it picks depends entirely on the alignment from
file `03`. Name the planner's decision, then walk the one query that matters and the
`EXPLAIN` tool that makes the invisible decision visible.

---

## The structure pass

### Layers

```
  declarative SQL        →  WHAT you want (order by distance, limit k)
    logical plan         →  WHICH operations (scan, sort, limit)
      physical plan      →  HOW (index scan vs seq scan vs sort-then-limit)
        execution        →  rows pulled through the operator tree
```

### Axis: trace *"who decides the physical plan?"* down the layers

```
  "who decides how this runs?"  — traced down

  ┌────────────────────────────────────────────┐
  │ your SQL: order by embedding <=> q limit 5  │  → YOU declare intent only
  └───────────────────────┬─────────────────────┘
      ┌───────────────────▼───────────────────┐
      │ planner: estimate cost of each plan    │  → THE PLANNER decides, not you
      └───────────────────┬───────────────────┘
          ┌───────────────▼───────────────────┐
          │ executor: pull rows through the    │  → the chosen plan just runs
          │ operator tree                      │
          └────────────────────────────────────┘

  the answer flips at the planner: you write declarative SQL, but the ENGINE
  picks the physical plan. you only INFLUENCE it (via indexes + alignment).
```

That flip is the lesson: you don't *tell* Postgres to use the index, you *enable* it
to and hope the cost model agrees. `EXPLAIN` is how you check it did.

### Seams

```
  seam 1  intent ↔ plan       you write WHAT; the planner picks HOW. The contract is
                             "I gave you an aligned index; please use it." EXPLAIN
                             verifies the planner honoured it.
  seam 2  plan ↔ statistics   the planner's cost estimates come from table stats
                             (collected by ANALYZE). Stale or absent stats → bad plan.
```

Hand off: you declare intent, the cost-based planner picks the physical plan, and
EXPLAIN is the only window into which plan it chose.

---

## How it works

### Move 1 — the mental model

You know how React doesn't re-render the whole tree when state changes — it diffs and
decides the minimal DOM ops, and you trust it without seeing the work? The Postgres
planner is the same kind of black box: you write declarative SQL, it computes the
cheapest physical plan and runs it. And just like you reach for React DevTools to see
what actually re-rendered, you reach for `EXPLAIN` to see what plan actually ran. The
plan is a tree of operators; rows flow up from the leaves.

```
  the plan tree for buffr's search query

         ┌─ Limit (5) ─┐                  ← top: stop after 5 rows
         │             │
       ┌─ Index Scan using chunks_embedding_hnsw ─┐
       │  order by embedding <=> $1               │   ← THE good plan:
       │  (HNSW returns rows already in order)    │      walk the graph
       └──────────────┬──────────────────────────┘
                      │ ctids
       ┌─ Heap fetch (content, meta, …) ─┐         ← then pull the columns
       └─────────────────────────────────┘            the index doesn't hold

  vs. the BAD plan (if misaligned):
         ┌─ Limit (5) ─┐
         └─ Sort (by <=> ) ─┐                       ← sort ALL rows by distance
            └─ Seq Scan on chunks ─┐                ← read EVERY row first
               (compute <=> per row)│
               └────────────────────┘
```

The difference between those two trees is the entire performance story of the
product.

### Move 2 — walk the execution

**The only hot query — vector search.** This is the query the RAG loop runs on every
turn, so it's the one whose plan matters.

```ts
// src/pg-vector-store.ts:70-77
select id, content, chunk_index, document_id, meta,
       1 - (embedding <=> $1::vector) as score   -- score = similarity = 1 - distance
from agents.chunks
where app_id = $2                                -- low-selectivity filter
order by embedding <=> $1::vector                -- the orderable the HNSW serves
limit $3                                          -- top-k
```

Walk what the planner does with it, one decision at a time:

**Decision 1 — can the `order by` use an index?** Yes, *if* an HNSW index exists on
`embedding` with an opclass matching `<=>`. It does (`vector_cosine_ops`, file `03`).
So the planner's cheapest plan is an *index scan that returns rows already ordered by
distance* — no separate sort needed. The HNSW walk produces near-neighbours in
roughly increasing distance, and `limit 5` stops the walk early. **Consequence:** the
query touches a handful of graph nodes, not the whole table.

**Decision 2 — what about `where app_id = $2`?** The planner *could* use
`chunks_app_id`, but on a single-device corpus every row matches, so filtering buys
nothing (file `03`). The planner applies `app_id` as a cheap filter on the rows the
HNSW scan already returned, rather than as a separate index scan. **Consequence:**
the `app_id` filter is essentially free here and doesn't change the plan shape.

**Decision 3 — `limit 5` and the `1 - distance` score.** The `limit` is what makes
the HNSW scan stop early — without it, an HNSW "order by" would have to materialise a
lot more of the graph walk. The `1 - (embedding <=> $1)` is computed *after* ordering,
per returned row — it's just arithmetic on the 5 survivors, not part of the index
decision. Note the query orders by raw `<=>` (distance, ascending = nearest first)
but *reports* `1 - distance` (similarity, higher = better). Same ranking, two
conventions; the index only cares about the `order by`.

**The seq-scan fallback — what misalignment costs.** If the index opclass didn't
match `<=>` (file `03`), Decision 1 flips to "no usable index," and the planner falls
to: seq scan every chunk → compute `<=>` for each → sort all by distance → take 5.

```
  the two plans, side by side — same SQL, different alignment

  ALIGNED (buffr today):              MISALIGNED (the trap):
  ┌─────────────────────┐             ┌─────────────────────┐
  │ Limit 5             │             │ Limit 5             │
  │  └ Index Scan HNSW  │             │  └ Sort (by <=>)    │
  │     reads ~ef nodes │             │     └ Seq Scan      │
  └─────────────────────┘             │        reads N rows │
   cost ~ O(log N)                    └─────────────────────┘
                                       cost ~ O(N log N)
```

Both return the *same correct rows*. The planner picks based on cost — and the cost
flips entirely on whether the index is usable.

**EXPLAIN — the tool buffr doesn't use.** Here's the honest gap. Nothing in the repo
runs `EXPLAIN` or `EXPLAIN ANALYZE`. So *which plan actually runs is unverified.*
The alignment is correct by inspection (file `03`), but "correct by reading the code"
is weaker than "proven by the planner output." The one-line discipline:

```
  prove the index is used — run once against a populated table

  EXPLAIN ANALYZE
  select id, content from agents.chunks
  where app_id = 'laptop'
  order by embedding <=> '[...]'::vector
  limit 5;

  look for:  "Index Scan using chunks_embedding_hnsw"   ← GOOD
  fear:      "Seq Scan on chunks" + "Sort"              ← misaligned, or stats stale,
                                                           or table too small to bother
```

One subtlety worth naming: on a *tiny* table the planner may legitimately pick a seq
scan because scanning 20 rows is cheaper than walking a graph. So you verify on a
*populated* table — a seq scan on 12 rows is fine; a seq scan on 50k rows is the bug.

**No joins, no N+1 — by construction.** Worth stating plainly: buffr's queries are
all single-table. `search` hits only `chunks`; `persistMessage` hits only `messages`;
`indexDocumentRow` hits `documents` then (separately) `chunks`. There are no SQL
joins anywhere, so there's no join-order planning to reason about. The N+1 risk lives
one layer up in *application* code, not SQL: `upsert` loops `insert` per chunk
(`pg-vector-store.ts:43`) and the trace sink fires one `insert` per event
(`supabase-trace-sink.ts`). Those are row-at-a-time round trips, not joins — a
batching opportunity that `study-performance-engineering` owns, not a planner
problem.

### Move 3 — the principle

The planner is declarative-to-physical translation you don't control directly — you
*influence* it by providing aligned indexes and current statistics, then *verify*
with `EXPLAIN`. The trap that catches everyone: assuming an index is used because it
exists. An index exists, is aligned, and is *still* skipped if the stats are stale or
the table is small. The discipline is not "create the index" — it's "prove the plan."

---

## Primary diagram

The full execution picture: declarative SQL down to the chosen plan, both branches.

```
  query execution — full recap

  ┌─ SQL ─────────────────────────────────────────────────────────────┐
  │  order by embedding <=> $1  limit 5    (declarative intent)        │
  └───────────────────────────┬───────────────────────────────────────┘
                              │
  ┌─ Planner (cost-based) ────▼───────────────────────────────────────┐
  │  is there an aligned index?                                       │
  │     YES (vector_cosine_ops ⟷ <=>)        NO (misaligned/no index) │
  │        │                                    │                     │
  │        ▼                                    ▼                     │
  │  ┌─ Index Scan HNSW ─┐              ┌─ Seq Scan + Sort ─┐          │
  │  │ walk graph, ~log N│              │ read N, sort all  │          │
  │  └────────┬──────────┘              └────────┬──────────┘          │
  └───────────┼──────────────────────────────────┼────────────────────┘
              ▼ ctids                             ▼ rows
  ┌─ Heap fetch (content, meta) ───────────────────────────────────────┐
  │  EXPLAIN ANALYZE is the only window into which branch ran           │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The cost-based planner is Postgres's defining feature — it's why you write SQL
instead of hand-coding access paths. Its estimates come from statistics gathered by
`ANALYZE` (run automatically by autovacuum): row counts, value distributions,
correlation. For vector indexes the cost model is newer and less battle-tested than
for B-trees, which is another reason to verify with `EXPLAIN` rather than trust the
estimate. After a bulk index of a fresh corpus, stats may lag reality until autovacuum
runs `ANALYZE` — a manual `ANALYZE agents.chunks` right after bulk loading is the
cheap insurance.

The N+1 observation connects to `study-performance-engineering` (batch the per-chunk
and per-event inserts) and the planner's no-joins simplicity connects to
`study-data-modeling` (the schema is denormalised enough that reads don't need
joins — the citation `meta` is reconstructed in application code at
`pg-vector-store.ts:80-84`, not via a SQL join to `documents`).

---

## Interview defense

**Q: "How do you know the vector search uses the index and not a seq scan?"**

```
  EXPLAIN is the only proof

  run:  EXPLAIN ANALYZE select ... order by embedding <=> q limit 5;
  good: "Index Scan using chunks_embedding_hnsw"
  bad:  "Seq Scan on chunks" + "Sort"  → misaligned, stale stats, or tiny table
```

Answer: "You don't know from the code — you prove it with `EXPLAIN ANALYZE` against a
populated table. If the plan says `Index Scan using chunks_embedding_hnsw`, the HNSW
index is serving the `order by`. If it says `Seq Scan` plus `Sort`, the index is
being skipped — usually an operator/opclass mismatch, sometimes stale stats, sometimes
the table's just too small to bother. buffr doesn't run EXPLAIN anywhere today, so
strictly the plan is unverified — correct by inspection, not by proof." Anchor: *an
index you can't prove the planner uses is an index you don't have.*

**Q: "Are there N+1 problems?"**

Answer: "Not in SQL — every query is single-table, no joins. But there's row-at-a-time
behavior in application code: `upsert` inserts one chunk per round trip and the trace
sink inserts one row per event. Those are batching opportunities, not planner
problems." Anchor: *the N+1 risk is in the app loop, not the query plan.*

---

## See also

- `03-btree-hash-and-secondary-indexes.md` — the alignment that decides which plan
  the planner picks.
- `02-records-pages-and-storage-layout.md` — the heap fetch after the index scan.
- `study-performance-engineering` — batching the per-row inserts; ANALYZE timing;
  HNSW `ef_search` and the recall/latency curve.
- `study-data-modeling` — why there are no joins (denormalised reads).
