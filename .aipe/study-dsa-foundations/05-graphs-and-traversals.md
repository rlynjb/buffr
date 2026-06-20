# Graphs and Traversals

**ANN / HNSW / navigable small-world graph / greedy graph search** — *Industry standard*

## Zoom out, then zoom in

This is the file. The single most important algorithm in the entire system is a
graph traversal — and it's invisible, hiding behind one line of SQL and a C
extension. You've built BFS, DFS, and Dijkstra over adjacency lists from scratch.
HNSW is the same *family* — frontier, visited set, greedy expansion — pointed at
a different problem.

```
  Zoom out — the graph search hiding under the query, by layer

  ┌─ buffr source layer ─────────────────────────────────┐
  │  store.search(vector, k)  → builds a SQL string       │ ← you see this
  └───────────────────────────┬──────────────────────────┘
                              │  order by embedding <=> $1 limit k
  ┌─ pgvector C extension layer▼─────────────────────────┐
  │  ★ HNSW GRAPH WALK ★  greedy descent through layers,  │ ← we are here
  │    expand neighbors, keep a candidate frontier         │   (invisible!)
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ your reincodes (anchor) ─▼──────────────────────────┐
  │  Graph.ts bfs_traversal / dfs_traversal               │ ← same family
  │  Graph2.ts + PriorityQueue.ts → Dijkstra              │ ← same frontier
  └───────────────────────────────────────────────────────┘
```

Zoom in: a **graph** is nodes connected by edges; a **traversal** visits nodes by
following edges from a start point, tracking what it's seen. **HNSW**
(Hierarchical Navigable Small World) is a graph where each node is a chunk's
768-dim vector and edges connect *near* vectors — so "walk toward the query" lands
you on the nearest neighbors. The question this file answers: *how does
`order by embedding <=> query limit k` become a graph search, and how is that the
same skill as your reincodes graph work?*

## The structure pass

Trace **one axis — "how does the search frontier move toward the target?" —
across the traversal types you know and this one.**

```
  Axis = "how does the frontier expand, and toward what?"

  ┌─ BFS (your Graph.ts) ──────────────────┐
  │ expand ALL neighbors, level by level    │  unweighted, finds shortest hops
  └──────────────────────┬──────────────────┘
                         │  seam: blind vs guided
  ┌─ Dijkstra (your PQ) ──▼────────────────┐
  │ expand the CLOSEST frontier node next   │  weighted, priority-driven
  └──────────────────────┬──────────────────┘
                         │  seam: exact vs approximate
  ┌─ HNSW greedy walk ────▼────────────────┐
  │ jump to the neighbor CLOSEST to query;  │  approximate NN, no backtrack
  │   stop when no neighbor is closer        │  trades exactness for speed
  └──────────────────────────────────────────┘
```

The load-bearing **seam**: between Dijkstra (which provably finds the *exact*
shortest path by exploring exhaustively via a priority queue) and HNSW (which
*greedily* walks to a local-best and accepts "good enough"). The axis — how the
frontier moves — flips from "exhaustive, exact" to "greedy, approximate" at that
boundary. That single trade (exact → approximate) is what buys HNSW its
sublinear speed, and it's the whole reason ANN is a different discipline from the
shortest-path algorithms you've built.

## How it works

### Move 1 — the mental model

You've done this. `Graph.ts` with `bfs_traversal` and `dfs_traversal` over an
adjacency list; `Graph2.ts` with weighted edges feeding Dijkstra through your
`PriorityQueue.ts`. Every one of those has the same three parts: a *frontier*
(where to look next), a *visited set* (don't loop), and an *expansion* step
(follow this node's edges). HNSW has all three — it just expands toward "closest
to the query vector" instead of "shortest path to a target node."

```
  The greedy graph walk — HNSW's kernel (one layer)

  query ★ (a point in 768-dim space)

  start ●─────● ───● ◄── current node
        │     │    │
        ●     ●────●      at each step:
              │             1. look at current's neighbors
        ●─────●             2. jump to the neighbor CLOSEST to ★
                            3. repeat until no neighbor is closer
  ──────────────────────────────────────────────────
  greedy descent: always step toward the query, never backtrack
  termination: current is closer than all its neighbors (local best)
```

The single sentence: **HNSW is greedy best-first search over a graph whose edges
connect near vectors — so "follow the edge toward the query" converges on the
nearest neighbors.** It's Dijkstra's priority-driven frontier, minus the
guarantee of exactness, plus a layered structure for long jumps.

### Move 2 — the walk, one moving part at a time

**The graph: nodes are vectors, edges connect near neighbors.**
Each chunk's 768-float embedding is a node. HNSW connects each node to a handful
of its nearest neighbors in cosine space. Bridge: it's your adjacency list, but
the "neighbors" are decided by distance, not by a puzzle's rules. Where it
breaks: if the graph isn't *navigable* (well-connected with both short and long
edges), greedy descent gets stuck in a bad local region and misses the true
nearest neighbor — which is why the construction algorithm carefully picks edges.

```
  Adjacency-by-proximity — the HNSW base layer

  node "work.md#0" ──► [work.md#1, stack.md#0]   ← edges to NEAR vectors
  node "stack.md#0"──► [work.md#0, coffee.md#0]
  node "coffee.md#0"─► [stack.md#0, work.md#1]
       │
       └─ same shape as Graph.ts adjacency list, but edges = "is near in
          768-dim cosine space", not "is connected by a rule"
```

**The layers: long jumps up top, fine steps at the bottom.**
HNSW stacks the graph into layers (the "hierarchical" in the name). The top layer
is sparse — few nodes, long edges — so you cover huge distance in a few hops. Each
layer down is denser. You descend coarse → fine. Bridge: it's the "skip list"
idea (express lanes) applied to a graph, and it's *why* the walk is `O(log n)`
instead of `O(n)`. Where it breaks: without the upper layers, you'd greedy-walk
the single dense base layer and take `O(n)` hops across it — the hierarchy is the
speed.

```
  Layered descent — coarse to fine (the "H" in HNSW)

  query ★
  layer 2  ●──────────────────●        ← enter here, 1-2 long hops
           │                  │           toward ★'s neighborhood
  layer 1  ●────●───────●─────●        ← refine, medium hops
                │       │
  layer 0  ●─●─●─●─●─●─●─●─●─●          ← final greedy walk to nearest k
                    ▲
              drop a layer when no neighbor here is closer to ★
```

**The frontier: a bounded candidate set (a priority queue in disguise).**
At the bottom, HNSW doesn't keep just the single best — it keeps a small set of
the `ef` best candidates seen, expanding their neighbors, so it can return the top
`k` and resist getting trapped. Bridge: that candidate set is a *bounded priority
queue* — your `PriorityQueue.ts` with a size cap, exactly the heap from `03`.
Where it breaks: shrink `ef` to 1 and it's pure greedy with no safety net —
faster but it misses neighbors; grow `ef` and recall climbs toward exact at the
cost of speed. That knob *is* the approximate-vs-exact dial.

```
  The candidate frontier — bounded priority queue (recall knob)

  ef = candidate set size
  frontier (min-heap by distance to ★): [c1, c2, c3]   ← keep ef best
    expand c1's neighbors → maybe replace the worst in the set
    expand c2's neighbors → ...
  stop when no unexpanded candidate is closer than the worst kept
       │
       └─ this is your PriorityQueue.ts, bounded. ef↑ → recall↑, speed↓
```

#### Move 2 variant — the traversal skeleton, named by what breaks

1. **Isolate the kernel.** Frontier (priority queue of candidates) + visited set
   + greedy expansion (jump toward query) + termination (no closer neighbor).
   That's BFS/Dijkstra's skeleton with a "toward the query" expansion rule —
   you've built every piece.
2. **Name each part by what breaks without it.**
   - Drop the **visited set** and the walk revisits nodes, loops, and never
     terminates — the exact bug your `Graph.ts` `captured` set prevents in BFS.
   - Drop the **layers** and it's `O(n)` across the base layer — correctness
     holds, speed collapses.
   - Drop the **bounded candidate set (`ef`)** and recall tanks — you get a local
     best, not the true k-nearest.
   - Drop the **termination condition** and greedy descent never stops.
3. **Skeleton vs hardening.** Frontier + visited + expansion + termination is the
   skeleton (it's just graph search). The hierarchy and the `ef` knob are
   hardening that turn `O(n)` exact search into `~O(log n)` approximate search.

### Move 2.5 — exact vs approximate (the trade this whole file turns on)

The in-memory store does the *exact* thing: score every node, sort, take k —
guaranteed correct, `O(n)`. HNSW does the *approximate* thing: greedy-walk a
graph, `~O(log n)`, occasionally misses a true neighbor. Same question, two
answers.

```
  Phase A (in-memory): EXACT     vs    Phase B (HNSW): APPROXIMATE

  score ALL n nodes                    walk a graph, expand a few
  sort, take top k                     keep ef candidates, take k
  O(n·d) — always correct              ~O(log n · d) — ~99% recall
  fine for 3 docs                      necessary for millions
       │                                    │
       └─ buffr's in-memory store           └─ buffr's PgVectorStore (shipped)
```

What *doesn't* change crossing from A to B: the `VectorStore.search(vec, k)`
contract, the caller, the meta shape. That's the payoff of the seam — you swap an
exact `O(n)` scan for an approximate `O(log n)` graph walk and nothing above the
interface notices.

### Move 3 — the principle

**Approximate nearest neighbor is graph search with the exactness guarantee
traded for speed.** The frontier, visited set, and greedy expansion are the same
primitives behind your BFS and Dijkstra — what changes is that HNSW *accepts a
local best* instead of proving the global one. Recognizing that ANN is "your
graph traversal, made approximate and hierarchical" is the insight that turns a
black-box index into something you can reason about.

## Primary diagram

The whole HNSW search, from SQL to graph walk to result, in one frame.

```
  order by embedding <=> query limit k — the full graph walk — recap

  ┌─ Service layer (buffr) ──────────────────────────────────┐
  │ store.search(vec, k) → "order by <=> $1 limit k"          │
  └────────────────────────────┬─────────────────────────────┘
                               │ delegated to the index
  ┌─ pgvector C extension ─────▼─────────────────────────────┐
  │  ENTER top layer ──long hops──► coarse neighborhood       │
  │       │ descend                                            │
  │  refine middle layers ──medium hops──► closer region       │
  │       │ descend                                            │
  │  base layer: greedy walk + ef-bounded candidate frontier   │
  │       │ (your PriorityQueue.ts, capped)                    │
  │       ▼ termination: no neighbor closer to query           │
  │  return k nearest  ── score = 1 - cosine_distance ──►       │
  └──────────────────────────────────────────────────────────┘
       primitives: frontier · visited set · greedy expansion · terminate
                   (the same skeleton as Graph.ts BFS / Dijkstra)
```

## Implementation in codebase

**Use cases.** This graph walk fires on *every* `npm run ask` (the
`search_knowledge_base` tool calls `pipeline.query` → `store.search`) and every
`npm run eval` query. It is the hot path of the entire RAG system — and it's one
SQL line in buffr's source, with the graph algorithm itself inside pgvector.

```
  src/pg-vector-store.ts  (lines 67–78) — the graph walk, as SQL

  async search(vector: number[], k: number): Promise<Hit[]> {
    this.assertDim(vector);
    const { rows } = await this.pool.query(
      `select id, content, ...,
              1 - (embedding <=> $1::vector) as score   ← cosine SIM from DIST
       from agents.chunks
       where app_id = $2
       order by embedding <=> $1::vector                ← ★ HNSW graph walk ★
       limit $3`,                                       ← stop after k nearest
      [toVectorLiteral(vector), this.appId, k],
    );
       │
       └─ "order by <=> ... limit k" is NOT a sort here — the planner uses
          the HNSW index, so this becomes a greedy descent through the
          layered proximity graph. Drop the index (file 04 line 28) and
          this same SQL degrades to an O(n) sequential scan + full sort.
```

The index declaration that *is* the graph (one line builds the whole structure):

```
  sql/001_agents_schema.sql  (lines 28–29) — the graph, declared

  create index if not exists chunks_embedding_hnsw
    on agents.chunks using hnsw (embedding vector_cosine_ops);
       │                    │                    │
       │                    │                    └─ edges measured by cosine
       │                    │                       distance (matches the <=>)
       │                    └─ the navigable-small-world graph index type
       └─ this single DDL line builds and maintains the layered graph as
          chunks are inserted — every upsert adds a node and wires its edges
```

## Elaborate

HNSW is Malkov & Yashunin, 2016 — combining navigable small-world graphs (which
have the "six degrees of separation" property: short paths between any two nodes)
with a skip-list-style hierarchy. The "small world" idea is why greedy walking
works: a well-built graph has both local edges (precision) and a few long-range
edges (reach), so you're never more than `O(log n)` hops from anywhere. pgvector
0.5+ ships HNSW alongside IVFFlat (a clustering-based ANN — different algorithm,
same goal).

The connection to your portfolio is direct and strong: your `Graph.ts`
adjacency list, your BFS `captured` set, your Dijkstra-via-`PriorityQueue`
frontier — HNSW *is* those primitives, recombined. The honest gap: you've built
*exact* graph algorithms (BFS finds shortest hops, Dijkstra proves shortest
weighted path); you haven't built an *approximate* one where you deliberately
trade correctness for speed. That trade is the new idea here.

`not yet exercised` in buffr's own graph work:
- **Connected components / union-find** — your reincodes
  `numberOfConnectedComponents` touches this; buffr never does.
- **Topological sort / cycle detection** — no DAG processing anywhere.
- **Building the HNSW graph yourself** — you consume it via pgvector; constructing
  a navigable small-world graph from scratch would be the deepest possible drill
  here, and it's the one that would prove you *own* this concept rather than rent
  it from the extension.

## Interview defense

**Q: Walk me through what `order by embedding <=> query limit 4` actually does.**

```
  not a sort — a layered greedy graph walk

  enter top layer → long hops toward query
       ↓ descend
  base layer → greedy expand, ef-bounded frontier (priority queue)
       ↓ terminate when no neighbor is closer
  return 4 nearest, score = 1 - distance
```

Answer: "It looks like a sort but it's a graph traversal. pgvector uses the HNSW
index — a layered navigable-small-world graph where nodes are embeddings and edges
connect near vectors. The walk enters a sparse top layer, takes long hops toward
the query, descends through denser layers refining, and at the base does a greedy
best-first walk with a bounded candidate frontier — that frontier is a priority
queue, the same one I built for Dijkstra. It returns the k nearest in `~O(log n)`
instead of scoring all n. It's approximate — it trades exactness for speed."
Anchor: `src/pg-vector-store.ts:74` + `sql/001_agents_schema.sql:28`.

**Q: How is this different from the Dijkstra you built?**

```
  Dijkstra (exact) vs HNSW (approximate)

  Dijkstra: priority queue, exhaustive, PROVES shortest path
  HNSW:     priority queue, greedy, accepts LOCAL best — no proof
            └─ the dropped guarantee is what buys O(log n)
```

Answer: "Same frontier — a priority queue — but Dijkstra explores exhaustively
and guarantees the exact shortest path; HNSW greedily walks toward the query and
accepts a local best, no guarantee. Dijkstra answers 'shortest weighted path';
HNSW answers 'approximately nearest in metric space.' The dropped exactness
guarantee is exactly what buys the sublinear speed." Anchor: your
`Graph2.ts`/`PriorityQueue.ts` Dijkstra vs `sql/001_agents_schema.sql:28`.

**Q: What breaks if the HNSW index is dropped?**

Answer: "Correctness holds, speed dies. `order by <=> limit k` falls back to a
sequential scan — score every one of n chunks, full sort, take k. `O(n·d)`
instead of `~O(log n·d)`. At three docs you'd never notice; at a million the
query goes from milliseconds to seconds." Anchor: `sql/001_agents_schema.sql:28`.

## Validate

1. **Reconstruct.** Draw HNSW's three-part traversal kernel (frontier, visited,
   greedy expansion + termination) and map each part to its equivalent in your
   `Graph.ts` BFS.
2. **Explain.** Why is `order by embedding <=> $1 limit k` a graph walk and not a
   sort? (The HNSW index — `src/pg-vector-store.ts:74`, `sql/...:28`.)
3. **Apply.** The `ef` candidate-set size is turned down to 1. What happens to
   recall and speed, and which of your data structures is `ef` bounding?
   (Recall drops, speed rises; it bounds the priority-queue frontier.)
4. **Defend.** Argue when the exact in-memory `O(n)` scan is the *right* choice
   over HNSW. (Tiny corpus, or when 100% recall is required and n is small —
   buffr's eval/test path.)

## See also

- `03-stacks-queues-deques-and-heaps.md` — the priority-queue frontier HNSW bounds.
- `04-trees-tries-and-balanced-indexes.md` — HNSW's layered (tree-like) descent.
- `06-sorting-searching-and-selection.md` — the exact sort-then-slice HNSW replaces.
- `01-complexity-and-cost-models.md` — the `O(n)` → `O(log n)` curve this buys.
- `study-ai-engineering` → why embeddings put semantically-similar text near each
  other in vector space (what makes proximity meaningful).
- `study-database-systems` → how Postgres's planner chooses the HNSW index and the
  on-disk graph layout.
