# Query Planning and Execution

**Industry name(s):** query planner / execution plan / EXPLAIN · **Type:** Industry standard

---

## Zoom out, then zoom in

Every SQL string buffr sends becomes a *plan* before it runs: the planner decides whether to walk an index or scan the heap, in what order, with what limit. buffr has exactly four query shapes, and the interesting one is the similarity search. This file is about what the planner does with them — and the fact the repo never looks.

```
  Zoom out — where planning sits

  ┌─ Persistence ───────────────────────────────────────────────┐
  │  search() · upsert() · indexDocumentRow · persistMessage     │
  └──────────────────────────┬──────────────────────────────────┘
                             │  parameterized SQL ($1,$2,$3)
  ┌─ Storage engine ─────────▼──────────────────────────────────┐
  │  parse → ★ PLAN ★ → execute                                  │ ← we are here
  │           │                                                  │
  │           ├ "use HNSW index?  or seq scan?"                  │
  │           └ "filter first by app_id, then order?"            │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the planner is the part of Postgres that turns *what you asked* into *how it'll run*. You write declarative SQL ("give me the k nearest"); the planner picks the physical strategy. buffr trusts it blind — no `EXPLAIN`, no `ANALYZE` cron, no statistics tuning. For four simple query shapes on a single-device DB, that's a defensible bet. Knowing what the planner *would* show is still the skill.

---

## The structure pass

Four query shapes. One axis: *index walk or full scan?*

```
  Axis = "does this query touch an index or scan the heap?"

  ┌─ search() SELECT ────────────┐  → HNSW index walk + LIMIT  (the hot path)
  │  ORDER BY <=> $1 LIMIT k     │
  └──────────────────────────────┘
  ┌─ upsert() INSERT…ON CONFLICT ┐  → PK btree probe per row   (dedup)
  └──────────────────────────────┘
  ┌─ loadProfile SELECT…LIMIT 1  ┐  → seq scan + sort, tiny table  ◄ scan, fine
  └──────────────────────────────┘
  ┌─ persistMessage INSERT       ┐  → heap append + index maintenance
  └──────────────────────────────┘
```

The seam is the gap between the hot path and everything else. `search()` *must* hit the HNSW index or latency falls off a cliff — that's the one query where the plan matters. The rest run on tables small enough that a sequential scan is free. **The lesson: planning matters exactly where data is big and queries are frequent, which here is one query.**

---

## How it works

### Move 1 — the mental model

You know how a query builder turns `.where().orderBy().limit()` into SQL? The planner does the next step down: it turns that SQL into a *physical plan* — a tree of operators (Scan → Sort → Limit) it'll actually execute. You can read that tree with `EXPLAIN`.

```
  The pattern — a plan is a tree of physical operators

         ┌─ Limit (k) ─┐          ← stop after k rows
         │             │
         ┌─ Index Scan ┐          ← walk HNSW, already in distance order
         │  using      │
         │  chunks_     │
         │  embedding_  │
         │  hnsw        │
         └──────────────┘
              ▲
       rows flow UP the tree, one operator feeds the next
```

One sentence: **the planner picks operators and their order; EXPLAIN prints that tree; EXPLAIN ANALYZE runs it and prints real timings.**

### Move 2 — the walkthrough

**The search plan — index scan, not sort-then-limit.** The naive read of `ORDER BY embedding <=> $1 LIMIT k` is "compute distance to every row, sort, take k" — O(n log n) over every vector. The HNSW index changes the plan: the index *already* yields rows in approximate-distance order, so the planner does an `Index Scan` that stops after `k`. No full sort. Bridge: it's the difference between `arr.sort().slice(0,k)` and a generator that yields nearest-first and you `break` after k.

```
  search() — the plan the HNSW index enables

  WITHOUT index (the trap):                 WITH HNSW index:
  ┌─ Limit k ─┐                             ┌─ Limit k ─┐
  │ Sort by   │   ← sorts ALL n rows        │ Index Scan│  ← yields nearest-first,
  │ distance  │                             │ on HNSW   │     stops at k
  │ Seq Scan  │   ← reads every vector      └───────────┘
  └───────────┘
   O(n log n)                                ~O(log n) + k
```

This is also where the operator/opclass alignment from `03` shows up: if the operator doesn't match the opclass, the planner *can't* choose the Index Scan and falls back to the left-hand plan — silently.

**The `WHERE app_id = $2` interacts with the order.** With an HNSW `ORDER BY` plus a `WHERE` filter, the planner can do a *filtered* index scan: walk the HNSW graph, discard rows failing `app_id`, keep going until k survive. On a single-app DB every row passes the filter, so it's free. On a multi-app DB with a selective filter, this is where you'd want to watch the plan — a very selective filter can make HNSW over-walk to find k survivors.

**The upsert plan — a PK probe per row, inside one transaction.** Each `INSERT … ON CONFLICT (id)` does a PK-btree lookup to detect a conflict, then either inserts or updates. There's no scan. The batch runs inside `BEGIN…COMMIT` (`src/pg-vector-store.ts:42-58`), so the planner sees N independent statements, not one set-based statement.

**The hidden N+1 in indexing — named honestly.** `upsert()` loops `await client.query(...)` once per chunk (`src/pg-vector-store.ts:43-57`). A 40-chunk document is 40 separate round trips on one connection inside one transaction. Bridge: it's the classic `for (item of items) await save(item)` N+1, just inside a transaction so it's atomic. On localhost the round-trip cost is tiny, so it's fine today — but it's the textbook spot a single multi-row `INSERT … VALUES (…),(…),…` or `UNNEST` would collapse N round trips into one.

```
  upsert() — N+1 round trips, atomic but serial

  BEGIN
   ├─ INSERT chunk[0]  ── round trip 1
   ├─ INSERT chunk[1]  ── round trip 2
   ├─ …
   └─ INSERT chunk[39] ── round trip 40
  COMMIT
       │
       └─ all 40 on ONE connection, ONE transaction. Correct and atomic;
          just 40 hops where one batched INSERT would do. Fine on localhost,
          a real cost over a network.
```

**The tiny-table reads just scan.** `loadProfile` (`order by updated_at desc limit 1`) and `startConversation` (a single `INSERT … RETURNING`) run against tiny tables. The planner picks a seq scan + sort for profiles because building/maintaining an index on a handful of rows costs more than scanning them. That's the planner being right, not lazy.

### Move 3 — the principle

A query is declarative; the plan is physical; the planner bridges them using table statistics. You only need to *read* the plan where data is large and the query is hot — for buffr that's the single `search()` call, and even there the plan is fixed by the HNSW index + operator pairing. Everything else is small enough that "just scan it" is the correct plan. The discipline you're missing: one `EXPLAIN ANALYZE` on `search()` against a realistic chunk count would confirm the index is actually used and reveal the real recall/latency you're paying.

---

## Primary diagram

The four query shapes and the plan each gets.

```
  buffr query shapes → execution plans

  ┌─ search() ──────────────────────────────────────────────────┐
  │  SELECT … 1-(embedding<=>$1) … ORDER BY embedding<=>$1       │
  │  WHERE app_id=$2 LIMIT k                                     │
  │     → Limit(k) ◄ Index Scan(chunks_embedding_hnsw)          │
  │       filtered by app_id   ★ THE ONE PLAN THAT MATTERS ★     │
  └──────────────────────────────────────────────────────────────┘
  ┌─ upsert() ──────────────────────────────────────────────────┐
  │  N × INSERT…ON CONFLICT(id) inside BEGIN…COMMIT              │
  │     → per row: PK-btree probe → insert|update  (N+1 hops)    │
  └──────────────────────────────────────────────────────────────┘
  ┌─ loadProfile ──────────────┐  ┌─ startConversation/Message ─┐
  │ SELECT…ORDER BY…LIMIT 1    │  │ INSERT … RETURNING|VALUES    │
  │  → Seq Scan + Sort (tiny)  │  │  → heap append + idx upkeep  │
  └────────────────────────────┘  └──────────────────────────────┘

  EXPLAIN / EXPLAIN ANALYZE: not yet exercised anywhere in the repo
```

---

## Implementation in codebase

**Use cases.** Planning is invisible in the code — there's no `EXPLAIN` call — but every query's *shape* determines its plan. The hot path is `search()`; the N+1 is `upsert()`; the tiny scans are profile/conversation reads.

```
  src/pg-vector-store.ts  (lines 70–76)  — the one plan that matters

  select id, content, chunk_index, document_id, meta,
         1 - (embedding <=> $1::vector) as score
  from agents.chunks
  where app_id = $2                    ← filtered index scan
  order by embedding <=> $1::vector    ← drives the HNSW Index Scan
  limit $3                             ← Limit operator: stop at k
       │
       └─ ORDER BY + LIMIT + matching operator = the planner's cue to use
          the HNSW index instead of sort-the-world. Drop the LIMIT and the
          plan degrades toward scanning more of the graph.
```

```
  src/pg-vector-store.ts  (lines 43–57)  — the N+1 indexing loop

  for (const c of chunks) {
    …
    await client.query(`insert into agents.chunks … on conflict (id) …`, [...]);
  }                                    ← one round trip per chunk
       │
       └─ N statements, N PK-btree probes, N round trips — all atomic inside
          the surrounding BEGIN/COMMIT. The optimization (batch into one
          multi-row INSERT) is "not yet exercised" and unnecessary at
          localhost latency.
```

```
  src/profile.ts  (lines 5–7)  — a deliberate seq scan

  select content from agents.profiles
  where app_id = $1 order by updated_at desc limit 1
       │
       └─ no index on (app_id, updated_at). On a handful of profile rows the
          planner seq-scans + sorts, which is cheaper than maintaining an
          index. Correct by smallness, not by tuning.
```

---

## Elaborate

The planner is cost-based: it estimates how many rows each operator emits (from `pg_statistic`, refreshed by `ANALYZE`/autovacuum) and picks the cheapest plan tree. For a vector `ORDER BY … LIMIT`, the planner's cost model knows the HNSW index can produce ordered rows cheaply, so it prefers the Index Scan. The failure mode is stale statistics on a large, churning table — but buffr's tables are small and write-light, so autovacuum keeps stats fresh without intervention.

The one habit worth building: run `EXPLAIN ANALYZE` on `search()` once with a realistic number of chunks loaded. It confirms the Index Scan is chosen (not a seq scan from an operator slip), and the `ANALYZE` timing shows the real per-query latency you'd otherwise only guess at. That's the missing measurement, and it's one psql command. Cross-link `study-performance-engineering` for turning that into a latency budget; cross-link `03` for why the operator must match the opclass for the good plan to be available.

---

## Interview defense

**Q: How does Postgres execute your similarity search — does it sort every row?**

No. `ORDER BY embedding <=> $1 LIMIT k` plus the HNSW index lets the planner pick an Index Scan that yields rows in approximate-distance order and stops at k — no full sort. Without a matching index it degrades to Seq Scan + Sort over every vector.

```
  Index Scan(HNSW) → Limit(k)     vs     Seq Scan → Sort → Limit(k)
   ~O(log n)+k                            O(n log n)
```

Anchor: *"ORDER BY + LIMIT + matching operator = the planner uses the index instead of sorting the world."*

**Q: Is there an N+1 anywhere?**

Yes — indexing. `upsert()` loops one `INSERT` per chunk, so a 40-chunk doc is 40 round trips. They're atomic inside one transaction, so it's correct; it's just serial. On localhost it's negligible; over a network you'd batch into one multi-row INSERT.

Anchor: *"N+1 inside a transaction — atomic but serial; fine on localhost, batch it over a wire."*

---

## Validate

1. **Reconstruct:** Draw the plan tree for `search()` with and without the HNSW index. Which operator disappears when the index is usable?
2. **Explain:** Why does `loadProfile` (`src/profile.ts:5-7`) get a seq scan, and why is that the *right* plan?
3. **Apply:** You want to confirm the HNSW index is actually used. Write the one psql command and say what output proves it.
4. **Defend:** Indexing a large corpus feels slow. Point to the exact lines (`src/pg-vector-store.ts:43-57`) and name the optimization — and say why it wasn't needed yet.

---

## See also

- `03-btree-hash-and-secondary-indexes.md` — why the operator must match the opclass for the good plan
- `05-transactions-isolation-and-anomalies.md` — the BEGIN/COMMIT around the N+1 loop
- `09-database-systems-red-flags-audit.md` — no-EXPLAIN-discipline ranked
- `study-performance-engineering` — turning EXPLAIN ANALYZE into a latency budget
