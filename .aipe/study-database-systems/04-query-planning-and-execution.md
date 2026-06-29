# Query planning and execution

**Subtitle:** cost-based planner / index scan vs sequential scan / EXPLAIN — *Industry standard*

---

## Zoom out, then zoom in

You hand Postgres a declarative SQL string; the planner turns it into a concrete
plan — which index, which scan, in what order — and the executor runs it. The
single decision that matters most in this repo happens here: *does the
similarity query use the HNSW index, or does it silently fall back to a
sequential scan?*

```
  Zoom out — planning sits between SQL and the access methods

  ┌─ Service ───────────────────────────────────────────┐
  │  search() issues: ORDER BY embedding <=> $1 LIMIT k  │
  └──────────────────────────┬───────────────────────────┘
  ┌─ ★ Planner + executor ★ ─▼───────────────────────────┐ ← THIS FILE
  │  parse → plan (cost-based) → execute                 │
  │  CHOICE: HNSW index scan  ──or──  sequential scan    │
  └──────────────────────────┬───────────────────────────┘
  ┌─ Access methods / heap ──▼───────────────────────────┐
  │  HNSW · btree · heap pages                            │
  └──────────────────────────────────────────────────────┘
```

Zoom in: the planner is cost-based — it estimates the cost of each candidate
plan and picks the cheapest. For most queries that's invisible plumbing. For the
vector query it's the whole ballgame, because the difference between the two
plans it might pick is sub-linear vs O(n), and **the planner picks the seq scan
silently when the operator and opclass don't align.**

---

## The structure pass

**Layers.** Query execution is three nested stages:

```
  ┌─ Parse ──────────────────┐  SQL text → parse tree
  └────────────┬──────────────┘
  ┌─ Plan ─────▼──────────────┐  parse tree → cheapest plan tree
  │   index-or-scan decision   │  ← the load-bearing layer
  └────────────┬──────────────┘
  ┌─ Execute ──▼──────────────┐  plan tree → rows (pull from nodes)
  └───────────────────────────┘
```

**Axis — trace `cost` (the planner's own currency) down to the decision.** *What
makes one plan cheaper than another?* The planner estimates pages-read and
rows-processed. For `order by <=> limit k`:

- If a usable HNSW index exists (operator aligns with opclass), the index-scan
  plan is cheap — walk the graph, return k.
- If not, the only plan is: scan every row, compute distance, sort, take k. The
  planner *will* choose this, because it's the only correct plan available — not
  because it's good.

**Seam — operator ↔ opclass alignment, and the planner won't warn you.** Above
the seam the SQL looks identical (`order by embedding <something> $1`). Below it,
whether `<something>` matches the index's opclass decides index-scan vs seq-scan.
The guarantee that flips is *which plan you get*, and it flips silently — no
error, no log line, just a different plan node you'd only see in `EXPLAIN`. This
is the most dangerous seam in the repo precisely because it's invisible.

---

## How it works

### Move 1 — the mental model

Think of how a React app re-renders: you describe *what* the UI should be, and
React's reconciler decides *how* to get there — which nodes to touch, in what
order. You don't write the DOM mutations; you write the declaration and trust
the planner. SQL is the same split: you write `order by <=> limit k`, and
Postgres's planner decides whether to walk an index or scan the table. The catch
that has no React equivalent: the planner can pick a catastrophically slow plan
and never tell you, because the slow plan is still *correct*.

```
  Two plans for the SAME query, planner picks one

  ORDER BY embedding <=> $1 LIMIT 4

  plan A (aligned):              plan B (misaligned):
  ┌──────────────────┐           ┌──────────────────┐
  │ Index Scan       │           │ Seq Scan         │
  │  chunks_embedding│           │  agents.chunks   │
  │  _hnsw           │           │ (compute <=> for │
  │  → walk graph,   │           │  EVERY row)      │
  │    return 4      │           └────────┬─────────┘
  └──────────────────┘                    ▼
        sub-linear                 ┌──────────────┐
                                   │ Sort + Limit │  O(n log n)
                                   └──────────────┘
```

### Move 2 — walk the planner's decision on buffr's query

**Start with the exact query.** `pg-vector-store.ts:70-78`:

```sql
select id, content, chunk_index, document_id, meta,
       1 - (embedding <=> $1::vector) as score
from agents.chunks
where app_id = $2
order by embedding <=> $1::vector     -- this clause decides the plan
limit $3
```

**Step 1 — the planner looks for an index matching the ORDER BY operator.** The
clause is `order by embedding <=> $1`. The planner asks: *is there an index on
`embedding` whose opclass supports `<=>`?* The HNSW index
(`001_agents_schema.sql:29`) was built `vector_cosine_ops` — the cosine opclass —
and `<=>` is the cosine-distance operator. **Match.** The planner generates an
index-scan plan that walks the HNSW graph and returns the top-k in graph order.

```
  Step 1 — the lookup that gates everything

  ORDER BY ... <=> ...            index opclass
       │                               │
       └──── do they name the ─────────┘
             same distance metric?
        YES (cosine == cosine) → Index Scan plan available
        NO                     → no usable index → Seq Scan
```

**Step 2 — the `LIMIT` makes the index plan decisively cheaper.** This is the
detail that seals it. Without `limit`, the planner might still scan-and-sort even
*with* an index, because it'd have to return everything anyway. With `limit k`,
the index-scan plan can stop after k graph hops — it never materializes the full
result. So `order by <=> limit k` is the canonical pgvector shape *because* the
`limit` is what lets the index pay off. **What breaks if you drop the limit:**
the index advantage shrinks or vanishes — you've asked for all rows sorted, and
sorting all rows is the seq-scan plan.

**Step 3 — the `where app_id = $2` is a separate, secondary decision.** The
planner can use the B-tree on `app_id` to pre-filter, or apply the filter while
walking. With one dominant `app_id` it'll likely just filter inline. This is a
side concern; the `order by` is what determines index-vs-scan for the expensive
part.

**Step 4 — the misalignment failure, concretely.** Suppose someone "optimizes"
the query to use L2 distance — `order by embedding <-> $1` — without rebuilding
the index with `vector_l2_ops`. Now Step 1 fails: no index opclass supports
`<->` on this column. The planner falls back to the only correct plan: seq scan
every row, compute L2, sort, limit. **No error. No warning.** The query returns
the right rows; it just got O(n) slower, and it degrades as the corpus grows.
The repo dodges this because the operator and opclass were chosen together — but
nothing *enforces* it; it's a convention held in two files that must agree.

```
  Layers-and-hops — the silent fallback

  ┌─ Service ───┐  ORDER BY <-> (L2)   ┌─ Planner ──────────┐
  │ search()    │ ──────────────────► │ no opclass match    │
  │ (edited)    │                      │ for <-> on embedding│
  └─────────────┘                      └─────────┬───────────┘
        no error returned ◄──────────────────────┤ falls back
                                                  ▼
                                       ┌─ Executor ─────────┐
                                       │ Seq Scan all rows  │  O(n)
                                       └────────────────────┘
```

**Step 5 — how you'd actually see the plan.** Nothing in the repo runs
`EXPLAIN`. To verify any of the above you'd prepend `explain (analyze, buffers)`
to the query and read the top node: `Index Scan using chunks_embedding_hnsw`
(aligned) vs `Seq Scan on chunks` (misaligned). That's the EXPLAIN-discipline
gap named in `00` — the index claim in this repo is reasoned, not measured.

### Move 3 — the principle

A cost-based planner gives you the cheapest *correct* plan it can build from the
indexes available — and "available" means an index whose opclass matches the
operator in your query. The planner never warns you that a faster plan *could*
have existed if your index and operator agreed; it just runs the slow correct
one. So the discipline is: pick the operator and the opclass together, and use
`EXPLAIN` to confirm the plan you assumed is the plan you got. The query that
looks identical can be sub-linear or O(n) depending on a match the planner makes
in silence.

---

## Primary diagram

The full decision, from SQL to plan node.

```
  search() query → plan, the full decision

  SQL (pg-vector-store.ts:70):
    WHERE app_id = $2  ORDER BY embedding <=> $1  LIMIT k
                            │
                  ┌─────────▼──────────┐
                  │ PLANNER             │
                  │ index on embedding  │
                  │ with opclass that   │
                  │ supports <=> ?       │
                  └────┬───────────┬─────┘
              YES ─────┘           └───── NO
                  ▼                       ▼
        ┌─ Index Scan ──────┐   ┌─ Seq Scan ─────────┐
        │ chunks_embedding  │   │ compute <=> every  │
        │ _hnsw, walk graph │   │ row → Sort → Limit │
        │ stop after k      │   │ O(n log n), SILENT │
        └───────────────────┘   └────────────────────┘
              sub-linear              latency cliff

   verify with: EXPLAIN (ANALYZE, BUFFERS) → read top node
```

---

## Elaborate

Postgres's planner is one of the oldest cost-based optimizers in open source: it
enumerates candidate plans, estimates each with statistics gathered by `ANALYZE`
(row counts, value distributions in `pg_statistic`), and picks the lowest
estimated cost. For vector queries the estimation is cruder — the planner's cost
model for ANN indexes is approximate — which is one more reason to verify with
`EXPLAIN ANALYZE` rather than trust the estimate. The N+1 query pattern, the
other classic execution pitfall, doesn't appear in this repo: the trajectory
writes in `supabase-trace-sink.ts` are one statement per event (a fan-out, not
an N+1 over a result set), and the hot path is a single `search()` call per
turn, not a loop of per-row lookups. → see `study-performance-engineering` for
where per-turn cost actually accrues.

---

## Project exercises

### EX-QРY-1 — EXPLAIN the hot path and prove the seam

- **What to build:** run `EXPLAIN (ANALYZE, BUFFERS)` on `search()`'s query with
  `<=>`, then again with `<->`, and capture both plans.
- **Why it earns its place:** converts the central claim of this guide (aligned
  → index, misaligned → seq scan) from reasoning into a captured artifact.
- **Files to touch:** new `src/cli/explain-cmd.ts`; optionally a `test/` case
  asserting the plan string contains `chunks_embedding_hnsw`.
- **Done when:** you have both plans saved and the operator swap visibly flips
  Index Scan → Seq Scan.
- **Estimated effort:** 1-2 hours.

---

## Interview defense

**Q: Two engineers write what looks like the same vector query and one is 100x
slower. What happened?**

> One of them changed the distance operator without rebuilding the index. The
> planner needs the `order by` operator to match the index's opclass — `<=>`
> with `vector_cosine_ops`. If the operator is `<->` (L2) but the index is
> cosine, there's no usable index for that clause, so the planner falls back to
> a sequential scan: compute distance for every row, sort, limit. It's still
> correct — same rows — so there's no error. It's just O(n) now, and it gets
> worse as the table grows. The only way to catch it is `EXPLAIN`.

```
  aligned   → Index Scan chunks_embedding_hnsw → sub-linear
  misaligned→ Seq Scan + Sort + Limit          → O(n log n), silent
```

> Anchor: the operator and opclass must name the same metric, or you get a
> silent seq scan.

**Q: Why does the `LIMIT` matter to whether the index gets used?**

> Because `limit k` is what lets the index-scan plan stop early. The HNSW walk
> returns rows in nearest-first order, so with a `limit` the executor pulls k
> and stops — it never touches the rest of the graph. Drop the `limit` and
> you've asked for every row sorted by distance, which is the seq-scan-and-sort
> plan. The pgvector idiom is `order by <=> limit k` precisely because the
> `limit` is half of what makes the index pay off.

```
  ORDER BY <=> LIMIT k → walk graph, stop at k → cheap
  ORDER BY <=> (no lim)→ produce + sort all     → expensive
```

> Anchor: `limit` is what turns the ordered index walk into an early stop.

---

## See also

- `03-btree-hash-and-secondary-indexes.md` — the HNSW index and the opclass it
  must align with.
- `02-records-pages-and-storage-layout.md` — why the seq-scan fallback is doubly
  costly (TOASTed vectors).
- `study-performance-engineering` — measuring the per-turn cost and the recall
  budget.
