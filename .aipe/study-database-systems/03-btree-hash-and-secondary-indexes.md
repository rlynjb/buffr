# B-tree, HNSW, and secondary indexes

**Subtitle:** B-tree index / HNSW approximate-nearest-neighbor index / opclass selection — *Industry standard*

---

## Zoom out, then zoom in

An index is a second data structure that lets the engine find rows without
reading every page. This repo has exactly two: a B-tree on `chunks.app_id`, and
an HNSW graph on `chunks.embedding`. They answer two completely different
questions — equality vs nearness — and the HNSW one is the engine that makes
sub-second retrieval possible.

```
  Zoom out — indexes sit between the planner and the heap

  ┌─ SQL / planner ─────────────────────────────────────┐
  │  search(): WHERE app_id = $2  ORDER BY <=> $1 LIMIT k│
  └──────────┬───────────────────────────┬───────────────┘
             │ equality filter           │ nearness order
  ┌─ ★ Indexes ★ ──────────────────────────────────────┐ ← THIS FILE
  │  btree(app_id)              HNSW(embedding, cosine) │
  └──────────┬───────────────────────────┬──────────────┘
             ▼                            ▼
  ┌─ Heap (agents.chunks pages) ───────────────────────┐
  └────────────────────────────────────────────────────┘
```

Zoom in: the B-tree is the index you already know — sorted, balanced,
O(log n) equality and range lookups. HNSW is the one worth your attention: a
*navigable small-world graph* that finds approximate nearest neighbors in
high-dimensional space without comparing every vector. The question: how does
each find rows, what does each cost to maintain, and why is HNSW *approximate*
on purpose?

---

## The structure pass

**Layers.** Two index kinds, one axis to separate them:

```
  ┌─ B-tree: chunks_app_id ──────────┐  answers "=" and "<,>"  (exact)
  └──────────────────────────────────┘
  ┌─ HNSW: chunks_embedding_hnsw ────┐  answers "nearest by cosine" (approx)
  └──────────────────────────────────┘
```

**Axis — trace `guarantees` (exact vs approximate) across the two indexes.**
*What does this index promise about its answer?*

- B-tree promises **exactly the matching rows** — `app_id = 'laptop'` returns
  every laptop chunk, no more, no fewer.
- HNSW promises **approximately the k nearest** — it walks a graph and may miss
  a true neighbor. You trade exactness for sub-linear time. This is the seam.

**Seam — exact ↔ approximate, and it's invisible.** The B-tree side is exact and
boring. The HNSW side is approximate and the recall depends on a runtime
parameter (`ef_search`) the repo never sets. Cross this seam and "correct" stops
meaning "complete." A reader who doesn't know which index answered can't reason
about whether a missing chunk is a bug or just ANN recall.

---

## How it works

### Move 1 — the mental model

You've built a BST and a binary heap from scratch — you know how a tree turns
O(n) search into O(log n) by halving the search space at each node. HNSW is the
same trick lifted into vector space, but with a twist: instead of one tree it's
a *layered graph* of shortcuts, and instead of "less / greater" the navigation
rule is "which neighbor is closer to my target vector." You greedily hop toward
the query, dropping down layers as you home in.

```
  HNSW — a navigable small-world graph (the shape)

  layer 2:   ●─────────────────────●        few nodes, long hops
                │                  │
  layer 1:   ●──●────────●─────────●──●      more nodes, medium hops
             │  │        │         │  │
  layer 0:   ●─●─●─●─●─●─●─●─●─●─●─●─●─●      every node, short hops
                         ▲
                    query enters at top,
                    greedily hops toward
                    nearest, descends layers
```

Compare the alternative — exact nearest-neighbor — which is just a linear scan:
compare the query to *every* vector, keep the top k. Correct, but O(n) and
paying the TOAST deref from `02` on every row.

```
  exact NN:   for each chunk: cosine(query, chunk) → keep top-k   O(n)
  HNSW:       greedy graph walk from top layer down               sub-linear
```

### Move 2 — walk the two indexes in this repo

**The B-tree on `app_id`.** Declared at `001_agents_schema.sql:30`:

```sql
create index if not exists chunks_app_id on agents.chunks (app_id);
```

This serves the `where app_id = $2` filter in `search()` (`pg-vector-store.ts:74`).
It's a standard Postgres B-tree: sorted keys, balanced, O(log n) to find all
rows for `app_id='laptop'`. **What breaks without it:** the equality filter
falls back to scanning every chunk to check `app_id`. In a single-app deploy
where nearly every row is `'laptop'` anyway, this index earns little today — but
it's the right call for the moment a second `app_id` shows up. Honest note: with
one dominant value, the planner may *ignore* this index and scan anyway, because
scanning is cheaper than index+heap when the filter isn't selective.

**The HNSW index on `embedding`.** The load-bearing one. Declared at
`001_agents_schema.sql:28-29`:

```sql
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);
```

Three parts, and each carries weight:

- `using hnsw` — the access method. Builds the layered graph above. The
  alternative pgvector method is `ivflat` (cluster-based); HNSW gives better
  recall-vs-speed for this size of corpus and needs no training step.
- `(embedding ...)` — the indexed column, the 768-dim vector.
- `vector_cosine_ops` — **the operator class. This is the part that must align
  with the query operator.** The opclass tells the index *which distance metric
  its graph is organized around*. `vector_cosine_ops` ⇒ cosine. The query in
  `search()` orders by `<=>`, the cosine-distance operator. They match, so the
  planner uses the index. → walked in full in `04`.

```
  HNSW build — the alignment that makes it usable

  index built with:  vector_cosine_ops  (graph organized by COSINE)
                              ║  must equal
  query orders by:   embedding <=> $1    (<=> is COSINE distance)
                              ║
                       MATCH → planner uses HNSW
                    MISMATCH → silent sequential scan (no error)
```

**The write cost nobody sees.** Every `upsert()` (`pg-vector-store.ts:47`) that
inserts a chunk also inserts that vector into the HNSW graph — finding its
neighbors, wiring edges across layers. That's not free: HNSW inserts are more
expensive than B-tree inserts because each one runs a partial graph search to
place the node. **What breaks if you ignore this:** bulk-indexing a large corpus
pays graph-construction cost per chunk; for buffr's single-device scale it's
invisible, but it's the reason large pgvector loads sometimes build the index
*after* the bulk insert, not during.

**The default parameters, untouched.** The index is created with no `m` or
`ef_construction` (build-time graph density) and the query sets no `ef_search`
(search-time candidate-list size). All defaults. `ef_search` is the recall dial:
higher = more graph explored = better recall, slower. Since the repo never sets
it, recall is whatever pgvector's default gives. → `not yet exercised`, below.

### Move 2.5 — current state vs future state (HNSW tuning)

The index *exists and is aligned*; what's *not* exercised is tuning it.

```
  Phase A — now                    Phase B — when corpus / recall matters
  ─────────────────────────────    ────────────────────────────────────
  hnsw, default m/ef_construction  m, ef_construction tuned at build
  no ef_search per query           SET hnsw.ef_search before search()
  recall = pgvector default        recall measured via eval/queries.json
  fine for single-device corpus    needed when recall@k regresses

  what doesn't change: the opclass alignment, the <=> operator,
  the search() SQL shape. Tuning is dials, not surgery.
```

The repo already has the measurement hook for Phase B: `eval/queries.json` plus
the precision@k eval CLI (`src/cli/eval-cmd.ts`). That's where you'd *see* a
recall regression before tuning `ef_search` to fix it.

### Move 3 — the principle

An index is a bet: you pay write cost and storage to buy read speed, and the
bet only pays off if the query asks the question the index was built to answer.
For B-tree that question is equality/range; for HNSW it's nearest-by-a-specific-
metric — and "specific metric" is load-bearing. The opclass is the contract
between how the index is *built* and how the query is *written*. Get them
aligned and you get a sub-linear graph walk; get them crossed and you get a
silent seq scan with the same answer and a latency cliff.

---

## Primary diagram

Both indexes, both query clauses, the alignment seam.

```
  agents.chunks — two indexes, two questions

  search() SQL (pg-vector-store.ts:70):
    WHERE app_id = $2        ORDER BY embedding <=> $1::vector   LIMIT k
         │                        │
         ▼ equality               ▼ nearest-by-cosine
  ┌─ B-tree ───────────┐   ┌─ HNSW ─────────────────────────────┐
  │ chunks_app_id      │   │ chunks_embedding_hnsw              │
  │ sorted keys        │   │ using hnsw (embedding              │
  │ O(log n) exact     │   │   vector_cosine_ops) ◄── must align │
  │ schema:30          │   │ approximate, sub-linear             │
  └─────────┬──────────┘   │ schema:28-29                        │
            │              └───────────────┬─────────────────────┘
            ▼                              ▼
  ┌─ Heap: agents.chunks pages (with TOASTed vectors) ──────────┐
  └──────────────────────────────────────────────────────────────┘
```

---

## Elaborate

HNSW (Hierarchical Navigable Small World, Malkov & Yashunin 2016) is the
default high-recall ANN index in pgvector because it needs no training phase
(unlike IVFFlat, which clusters first) and degrades gracefully — more search
effort buys more recall on the same graph. The opclass concept it rides on is
pure Postgres: an *operator class* binds a data type to a set of operators and
support functions an index can use. `vector_cosine_ops`, `vector_l2_ops`, and
`vector_ip_ops` are three opclasses pgvector ships, one per distance metric, and
choosing one at `create index` time locks the index to that metric. This is the
same machinery that lets you build a `text_pattern_ops` B-tree for `LIKE`
queries — opclasses are how Postgres makes indexes pluggable.

---

## Project exercises

This is a curriculum topic; here are build items anchored to this repo's files.

### EX-IDX-1 — Prove the opclass alignment with EXPLAIN

- **What to build:** an `EXPLAIN ANALYZE` harness around the `search()` query
  that prints the chosen plan node.
- **Why it earns its place:** the "HNSW is used" claim is currently *reasoned*
  from the opclass, never *measured*. This closes the EXPLAIN-discipline gap.
- **Files to touch:** a new `src/cli/explain-cmd.ts` issuing
  `explain (analyze, buffers) select ... order by embedding <=> ...`.
- **Done when:** the output shows an `Index Scan using chunks_embedding_hnsw`,
  and swapping `<=>` for `<->` flips it to `Seq Scan` — proving the seam.
- **Estimated effort:** 1-2 hours.

### EX-IDX-2 — Measure recall vs `ef_search`

- **What to build:** sweep `set hnsw.ef_search` over a few values and rerun the
  precision@k eval.
- **Why it earns its place:** turns the untuned recall dial into a measured
  curve, using the eval set the repo already has.
- **Files to touch:** `src/cli/eval-cmd.ts` (wrap the query in a `set
  hnsw.ef_search = N` per run), `eval/queries.json` (labeled set).
- **Done when:** you have a recall@k-vs-`ef_search` table and can name the knee.
- **Estimated effort:** 2-3 hours.

---

## Interview defense

**Q: Your HNSW index is built with `vector_cosine_ops`. Why does that matter to
the query?**

> Because the opclass is the contract between how the index is organized and how
> the query measures distance. The graph is built around cosine; the query at
> `pg-vector-store.ts:75` orders by `<=>`, which is cosine distance. They match,
> so the planner uses the index. If I changed the query to `<->` (L2) without
> rebuilding the index with `vector_l2_ops`, Postgres wouldn't error — it would
> silently fall back to a sequential scan. Same answer, a latency cliff that
> grows with the corpus.

```
  build:  vector_cosine_ops  ══ must equal ══  query: <=>
  match → HNSW used  ·  mismatch → silent seq scan
```

> Anchor: the opclass and the operator have to name the *same* distance metric.

**Q: HNSW is approximate. When is that a problem?**

> When recall matters more than latency. HNSW walks a graph and can miss a true
> nearest neighbor an exact scan would find — the recall depends on `ef_search`,
> which this repo leaves at default. For buffr's retrieval, "approximately the 4
> nearest" is the right call: sub-second beats perfect. The way you'd catch a
> recall problem is the precision@k eval over `eval/queries.json`, then raise
> `ef_search` if it regresses.

```
  exact: every vector compared → true top-k, O(n)
  HNSW:  graph walk, ef_search candidates → ~top-k, sub-linear
```

> Anchor: HNSW trades a small recall miss for sub-linear time; `ef_search` is
> the dial and the eval set is how you watch it.

---

## See also

- `04-query-planning-and-execution.md` — the planner's index-or-scan decision
  and EXPLAIN.
- `02-records-pages-and-storage-layout.md` — why scanning TOASTed vectors is the
  costly alternative the index avoids.
- `study-performance-engineering` — recall/latency tradeoff as a measured budget.
