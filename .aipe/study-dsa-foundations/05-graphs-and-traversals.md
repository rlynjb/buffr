# Graphs and Traversals

**Industry names:** graph · BFS / DFS · shortest path · greedy best-first search
· approximate nearest neighbor (ANN) · HNSW (Hierarchical Navigable Small World)
· union-find. **Type:** Industry standard.

---

## Zoom out, then zoom in

This is the headline file. The single most consequential algorithm in this repo
is **approximate nearest-neighbor search over a navigable-small-world graph** —
and it ships as one line of DDL (`sql/001:30-31`) plus a C extension. buffr never
writes graph code; it writes `order by embedding <=> $1 limit k`
(`pg-vector-store.ts:74-77`) and Postgres walks the graph. You've built BFS, DFS,
and Dijkstra by hand in reincodes — HNSW is *those instincts* (frontier + visited
+ greedy descent), with one twist: it's deliberately **approximate**.

```
  Zoom out — where the graph lives (one DDL line down)

  ┌─ buffr TS ────────────────────────────────────────────────┐
  │  store.search(vector, k)  →  SQL: order by <=> limit k     │
  └──────────────────────────┬─────────────────────────────────┘
                             │  one DDL line + C extension
  ┌─ pgvector HNSW index ────▼─────────────────────────────────┐
  │  ★ a navigable-small-world GRAPH over the 768-d vectors ★   │ ← we are here
  │  greedy walk: frontier + visited + move to nearest neighbor │
  │  layered (skip-list style) for O(log N) entry               │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: a **graph** is nodes + edges. **Traversal** is visiting nodes by
following edges — BFS (level by level, a queue), DFS (deep first, a stack),
Dijkstra (cheapest first, a priority queue). **HNSW** is a graph where each
vector is a node, edges connect *near* vectors, and "find the nearest" is a
*greedy walk* toward the query — frontier and visited set, just like your BFS,
but it stops at "good enough" instead of "provably best". That word —
*approximate* — is the whole trade.

---

## The structure pass

**Layers** — the graph at three altitudes:

```
  one query, three altitudes of "find nearest"

  ┌─ buffr's view ─────────────────────────────┐
  │ search(vector, k) → k nearest, by score     │  declarative, no graph seen
  └──────────────────────┬───────────────────────┘
       ┌─────────────────▼────────────────────┐
       │ HNSW: greedy walk over a graph         │  frontier + visited + greedy
       └─────────────────┬────────────────────┘
            ┌────────────▼────────────────────┐
            │ the layered graph: nodes=vectors, │  small-world topology,
            │ edges=proximity, layers=skip-list │  built at upsert time
            └───────────────────────────────────┘
```

**Axis — guarantees (exact vs approximate).** Trace "is the answer provably
correct?": your reincodes Dijkstra returns the *provably* shortest path (exact);
HNSW returns *probably* the nearest, fast (approximate). Same greedy-walk
machinery, the guarantee flips. That flip is the seam.

**Seam — the exact/approximate boundary.** This is *the* load-bearing seam in the
whole repo. On one side: exact nearest neighbor = compare the query to all N
vectors (the in-memory store, O(N), file 03). On the other: HNSW skips most of
the graph and accepts a small chance of missing the true nearest — buying
~O(log N). buffr crosses this seam the moment it uses the HNSW index instead of
the in-memory scan. The eval (`eval-cmd.ts`) *measures* the cost of that
approximation as P@k / R@k — recall < 1.0 is partly the graph's approximation
showing up in the numbers.

---

## How it works

### Move 1 — the mental model

You know the BFS shape cold: a **frontier** of nodes to explore, a **visited**
set so you don't loop, dequeue-expand-enqueue until you arrive. HNSW search is
the same skeleton with two changes: (1) it's *greedy* — always step to the
neighbor closest to the query, like best-first search; (2) it's *layered* — a
sparse top layer for big jumps, denser layers below for fine approach, exactly
like a skip list's express lanes.

```
  HNSW greedy walk — frontier + visited + "step toward the query"

  query ✦                  layer 2 (sparse): big jumps
        entry → ●━━━━━━━━━━━━━━━━━━━━● close-ish
                              │ drop down
  layer 1 (denser):    ●──●──●  ●──●
                          ╲   ╲ │ step to nearest neighbor each time
  layer 0 (all nodes): ●─●─●─●─●─◎ ← arrive: local minimum ≈ true nearest

  greedy: at each node, move to the neighbor nearest ✦; stop when no
  neighbor is closer than where you stand  (a local optimum, accepted)
```

That "stop when no neighbor is closer" is the approximation: it's a *local*
minimum of distance, which is *usually* the global nearest but not guaranteed.
Your Dijkstra would never stop there — it'd keep a priority queue and prove
optimality. HNSW trades that proof for speed.

### Move 2 — the navigable-small-world graph, walked

**Step 1 — the graph is built at upsert, not at query.** Every `upsert`
(`pg-vector-store.ts:38-65`) inserts a `vector(768)` and pgvector wires it into
the HNSW graph: it greedily finds the new node's nearest existing neighbors and
adds edges to them. So indexing cost is paid on write; query cost is cheap. This
is the amortization from file 01 — expensive build, cheap reads.

```
  upsert builds the graph (write-time cost)

  new chunk vector  ──insert──►  pgvector finds M nearest existing nodes
  pg-vector-store.ts:47-56                    │  adds bidirectional edges
                                              ▼
                                    graph stays "navigable":
                                    any node reachable from any other
                                    in ~log(N) hops  (small-world property)
```

**Step 2 — "small world" is why ~O(log N) works.** A small-world graph has the
six-degrees-of-separation property: mostly local edges plus a few long-range
ones, so any node reaches any other in a logarithmic number of hops. The layers
add the express lanes — the top layer has few nodes and long edges (cross the
space in a few jumps), each lower layer is denser for the fine approach. That
layered structure is *literally a skip list over a graph* — the self-similarity
file 03's heap and a skip list share.

**Step 3 — the query is a greedy descent, and it's one SQL operator.** Here's the
entire buffr-side surface of this graph algorithm:

```ts
// pg-vector-store.ts:70-78 — the whole graph walk is "<=>" + "order by ... limit"
const { rows } = await this.pool.query(
  `select id, content, ...,
          1 - (embedding <=> $1::vector) as score   -- <=> = cosine DISTANCE
   from agents.chunks
   where app_id = $2
   order by embedding <=> $1::vector                -- THIS triggers the HNSW walk
   limit $3`,                                        -- k results off the graph
  [toVectorLiteral(vector), this.appId, k],
);
```

The annotation: `order by embedding <=> $query limit k` is the *only* thing buffr
writes, and it's the trigger for the entire greedy graph traversal. The planner
sees "order by a distance operator with a matching HNSW index + a small limit"
and walks the graph instead of scanning + sorting all rows. Drop the `limit`, or
order by something the index doesn't cover, and the planner falls back to the
O(N) scan — the graph index goes unused. That's the boundary condition: **the
index only fires for the top-k, distance-ordered shape.**

**Step 4 — name the kernel by what breaks (the load-bearing skeleton).** This is
the BFS-shaped skeleton to reconstruct from memory:

```
  HNSW greedy search — the kernel

  ┌ entry point at the top layer    ── lose it → no start, can't walk
  ┌ frontier (candidates to expand)  ── lose it → can't track where to go next
  ┌ visited set                      ── lose it → revisit nodes, may loop  ★
  ┌ greedy step to nearest neighbor   ── lose it → it's a random walk, not search
  └ stop at local minimum            ── lose it → never terminates / scans all
```

The visited set (★) is the part people forget — same as in your BFS. Without it
the walk revisits nodes and can cycle. The *difference* from BFS is the
termination: BFS stops when the frontier empties (exhaustive); HNSW stops at a
local minimum (approximate). Naming "HNSW terminates on a local optimum, not an
empty frontier" is the senior signal — it's the one line that captures the
exact/approximate trade.

### Move 2.5 — current vs future state

```
  Phase A (now)                      Phase B (if corpus grows huge)
  ──────────────────────────────     ──────────────────────────────
  HNSW with default params           tune m / ef_construction / ef_search
  recall "good enough", small N      higher ef → better recall, slower
  sql/001:30-31 (no tuning)          the recall↔latency knob
```

The HNSW index ships with default parameters — no `WITH (m=..., ef_...)` tuning
in `sql/001:30`. That's the right call now (small corpus, recall is fine, the
eval shows it). The *knob* you'd reach for at scale is `ef_search`: higher means
the greedy walk keeps a bigger frontier, explores more, recalls more true
neighbors — at the cost of latency. That recall↔latency dial is **not yet
exercised** but it's the natural next move, and the eval harness already exists to
measure it.

### Move 3 — the principle

When exact nearest-neighbor is too expensive (comparing a query to all N
high-dimensional points), build a navigable graph and *greedily walk* it toward
the query, accepting a small approximation for a logarithmic speedup. It's BFS's
frontier-and-visited skeleton with a greedy step and a local-minimum stop — the
same instincts you built Dijkstra with, traded from exact to approximate.

---

## Primary diagram

The full graph picture — build, walk, and the exact/approximate seam.

```
  HNSW end to end, with the seam marked

  WRITE PATH (build the graph):
   upsert(chunk) ─► find M nearest nodes ─► add edges ─► small-world graph
   pg-vector-store.ts:38                                  (amortized cost)

  READ PATH (walk the graph):
   order by <=> limit k  ─► enter top layer ─► greedy descent through layers
   pg-vector-store.ts:74     │  frontier + visited (BFS-shaped)
                             ▼
                          local minimum ≈ k nearest  ◄── APPROXIMATE
   ═══════════════════════════ the exact/approximate SEAM ════════════════
   exact alternative: in-memory scan ALL N, sort, slice  ◄── EXACT, O(N)
   in-memory-vector-store.ts:28-32

  MEASURED BY: eval-cmd.ts P@k / R@k  ── recall<1.0 = approximation showing up
```

---

## Elaborate

HNSW (Malkov & Yashunin, 2016) is the dominant ANN index in production vector
search — it's what's under pgvector, Qdrant, Weaviate, FAISS' HNSW mode, and
most "vector database" products. It descends from two older ideas you can see in
it: navigable small-world graphs (Kleinberg's small-world model) and the skip
list (Pugh, 1990) — the layering is literally the skip list's probabilistic
express lanes applied to a graph. The reason it beat tree-based ANN (KD-trees,
ball trees) is the curse of dimensionality: space-partitioning trees degrade to
linear scans past ~20 dimensions, and embeddings live in hundreds. A graph of
"who's near whom" sidesteps that. **Union-find** — the other classic graph
structure — is `not yet exercised` here and absent from your reincodes too; it's
the structure for "are these two nodes in the same connected component?" answered
near-O(1) with path compression, and it's a real drill gap (file 08). Your
`Graph.ts` `numberOfConnectedComponents` solves that problem the O(V+E) way; the
union-find way is the upgrade you haven't built.

---

## Interview defense

**Q: Walk me through how `order by embedding <=> $q limit k` finds the nearest
chunks. What's the data structure and the algorithm?**

```
  structure: HNSW = a layered navigable-small-world GRAPH
             nodes = the 768-d vectors, edges = proximity
  algorithm: greedy best-first walk
             enter top (sparse) layer → step to neighbor nearest the query
             → drop a layer → repeat → stop at a local minimum
  skeleton:  frontier + visited set + greedy step + local-min stop
```

It's a graph traversal — the same frontier-and-visited skeleton as BFS, but it
steps *greedily* toward the query and stops at a local minimum instead of
exhausting the frontier. That local-minimum stop is the approximation: ~O(log N)
instead of O(N), at the cost of *occasionally* missing the true nearest. The
visited set is the part people drop — without it the walk can cycle.

**Q: It's "approximate" — where does the error go, and how do you know it's
acceptable here?**

```
  error source: greedy walk stops at a LOCAL minimum, not guaranteed global
  shows up as:  R@k < 1.0 — a true-relevant chunk the walk didn't reach
  measured by:  eval-cmd.ts:28  scoreRecallAtK over labeled queries
  knob:         ef_search ↑ → bigger frontier → better recall, slower
```

The approximation means the greedy walk can settle on a local optimum and miss
the global nearest. That error surfaces directly in the recall number the eval
prints (`eval-cmd.ts:33`) — recall below 1.0 is partly the graph approximating.
You know it's acceptable because the eval *measures* it on labeled queries; if
recall dropped you'd turn the `ef_search` knob to widen the frontier. Naming that
the eval is the feedback loop on an approximate algorithm is the strongest
signal.

**Q: Why a graph and not a tree (KD-tree) for nearest-neighbor?**

```
  KD-tree: partitions space by axis → degrades to O(N) past ~20 dimensions
  HNSW:    graph of proximity edges → stays ~O(log N) at 768 dimensions
  reason:  the curse of dimensionality kills space-partitioning trees
```

Tree-based ANN partitions space dimension by dimension and collapses to a linear
scan in high dimensions — and embeddings are 768-dimensional. A proximity graph
doesn't partition space, so it survives. That's why every modern vector index is
graph-based.

**Anchor:** "HNSW is BFS's frontier-and-visited skeleton turned greedy and
approximate — it stops at a local minimum for ~O(log N), and the eval's recall
number is the price of that approximation."

---

## See also

- `03-stacks-queues-deques-and-heaps.md` — the priority-queue frontier; the
  heap-vs-ANN top-k discussion
- `06-sorting-searching-and-selection.md` — exact (sort+slice) vs approximate
  (graph walk) selection
- `01-complexity-and-cost-models.md` — O(N) scan vs ~O(log N) walk
- `04-trees-tries-and-balanced-indexes.md` — why a tree index can't do this
- Cross-link: `.aipe/study-ai-engineering/` — embeddings, why cosine distance is
  the metric, what P@k / R@k mean for retrieval quality
- Cross-link: `.aipe/study-database-systems/` — the HNSW index as a storage
  structure and how the planner chooses it
