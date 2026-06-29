# Graphs & Traversals

**Industry name(s):** graph · BFS / DFS · greedy best-first search ·
approximate nearest-neighbour (ANN) over a navigable small-world graph (HNSW) —
*Industry standard*

The leading nouns: **graph** (nodes + edges), **traversal frontier + visited
set** (the BFS/DFS kernel you built), **greedy best-first search** (expand the
most promising node), **approximate nearest-neighbour** (the HNSW index). This
is the headline file — the repo's most important algorithm is a graph walk, and
it maps almost one-to-one onto your reincodes graph builds.

---

## Zoom out — where the graph lives

This is the deepest, most important algorithm in the whole system, and it's
one DDL line. The zoom-out marks it.

```
  Zoom out — the HNSW graph under retrieval

  ┌─ buffr source ─────────────────────────────────────────────┐
  │  search(vector, k)  → one SQL query                        │ ← we are here
  └───────────────────────────┬────────────────────────────────┘
                              │ order by embedding <=> $1 limit k
  ┌─ Postgres + pgvector ─────▼────────────────────────────────┐
  │  ★ HNSW: a navigable small-world GRAPH ★                   │  sql/001:28-29
  │  nodes = embedding vectors, edges = "near" links            │  the headline
  │  query = greedy walk toward the query vector                │  algorithm
  └───────────────────────────┬────────────────────────────────┘
                              │ this same graph also serves:
  ┌─ memory recall ───────────▼────────────────────────────────┐
  │  createConversationMemory → SAME graph, SAME walk           │  session.ts:53
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is **"how do you find the nearest vectors among
millions without comparing against all of them?"** You already built the
honest-but-slow answer — BFS/DFS over an explicit graph, Dijkstra's greedy
frontier with a priority queue. HNSW is *that same machinery* — frontier,
visited set, greedy expansion — with one twist: it stops early and accepts an
*approximate* answer to be fast. This file is where your graph portfolio pays
off most directly.

---

## Structure pass — layers, axis, seams

**Axis: correctness vs cost — does the walk find the *true* answer?** Trace it
from your exact graph builds to HNSW; the seam is *approximation*, and it's
the single most important flip in this whole guide.

```
  Axis: "does the traversal find the TRUE nearest node?" — traced

  ┌─ your BFS/DFS (Graph.ts) ──────────────┐
  │  visits reachable nodes → EXACT answer  │   → correct, but O(V+E)
  └───────────────┬────────────────────────┘
      seam: exhaustive vs greedy?
      ┌───────────▼────────────────────────┐
      │ Dijkstra (Graph2.ts + PriorityQueue)│   → EXACT shortest path
      │  greedy frontier, but still complete │     still examines what it must
      └───────────────┬────────────────────┘
      seam: stop early & accept "good enough"?   (★ THE flip ★)
          ┌──────────▼──────────────────────┐
          │ HNSW: greedy walk, EARLY STOP    │   → APPROXIMATE nearest
          │  may miss the true nearest        │     O(log n), examines few nodes
          └───────────────────────────────────┘
```

The load-bearing seam: HNSW gives up *exactness* to gain *speed*. Your
Dijkstra always finds the true shortest path; HNSW's greedy walk can converge
to a *local* best and miss the global nearest neighbour. That trade —
correctness for O(log n) — is why it scales to millions of vectors, and it's
the thing to be able to defend.

---

## How it works

### Move 1 — the mental model

You built the frontier. Your `Graph.ts` `bfs_traversal` is the kernel: a
frontier of nodes to explore, a visited set so you don't loop, dequeue → expand
neighbours → enqueue. HNSW is that exact loop with one change: instead of
expanding *all* neighbours (BFS) or the lowest-cost one (Dijkstra), it expands
the neighbour *closest to the query vector* — **greedy best-first** — and stops
when no neighbour is closer.

```
  HNSW greedy walk — your BFS frontier, aimed at a target

       query vector ✦ (we want the nearest stored node to this)

   entry → ● ──► ● ──► ● ──► ◉ (local best — no neighbour closer)
   point    \     \     \
             ●     ●     ●   ← neighbours checked, not better, skipped
                                 (visited set prevents revisits)

   frontier: nodes to expand | visited: nodes already seen
   each step: from current node, hop to the neighbour CLOSEST to ✦
   stop: when no neighbour is closer than where you are
```

One sentence: **HNSW is a greedy graph walk — start somewhere, repeatedly hop
to whichever neighbour is closest to the query, stop when you can't get
closer — over a graph deliberately wired so near-things are linked.** The
"navigable small-world" part is the wiring trick that makes the greedy walk
land near the true answer.

### Move 2 — the kernel, then the wiring (load-bearing skeleton)

This concept has a clear kernel — the greedy frontier walk — so here it is
isolated, with each part named by what breaks without it.

**Isolate the kernel — the greedy frontier walk.** In pseudocode, the thing
you should be able to rebuild from memory:

```
  GREEDY-NEAREST(graph, query, entry):
    current  = entry                         // start node
    visited  = new Set([entry])              // ← don't revisit (your visited set)
    loop:
      neighbours = graph.neighbours(current) // adjacency list (your Graph.ts shape)
      best = the neighbour closest to query  // greedy: minimise distance(n, query)
             that is NOT in visited
      if distance(best, query) >= distance(current, query):
        return current                       // ← termination: no neighbour closer
      add best to visited
      current = best                          // hop forward
```

**Name each part by what breaks when removed:**

- **Drop the `visited` set** → the walk can hop back to a node it just left and
  loop forever on a cyclic graph. This is the *exact* lesson your `Graph.ts`
  BFS taught: visited set = termination on cycles. HNSW graphs are dense with
  cycles, so it's non-negotiable.
- **Drop the greedy "closest neighbour" choice** → it becomes plain BFS,
  exploring everything, O(V+E) — you've lost the whole speedup.
- **Drop the termination check (`no neighbour closer`)** → it never stops, or
  stops arbitrarily; the "local best" stopping condition is what bounds the
  work to O(log n).

```
  Termination — the part people forget (your BFS taught it)

  BFS terminates when:  frontier is EMPTY
  HNSW terminates when: no neighbour is CLOSER than current
                        (a local minimum of distance-to-query)
       ▲
       └─ this is ALSO why it's approximate: a LOCAL min ≠ the GLOBAL nearest
```

**The approximation, made concrete.** Because the walk stops at a *local*
distance minimum, it can return a node that's near but not *the* nearest:

```
  Why approximate — greedy lands in a local minimum

   query ✦
          \
   start ● → ● → ◉   ← greedy stops here (no closer neighbour from ◉)
                       but the TRUE nearest is over here: ★
                       ★ wasn't linked from the path the walk took
   exact search (compare all n) would find ★; HNSW might miss it
```

The fix the real index uses — **hierarchy (the H in HNSW)** — is the optional
hardening on top of the kernel: multiple layers, a sparse top layer for big
jumps across the space, denser lower layers for fine-grained local search. The
hierarchy makes "land in the right region" far more likely, pushing recall
toward ~99% in practice. But the *kernel* is still the greedy frontier walk
above; the layers just feed it a better entry point.

**Separate skeleton from hardening:**

```
  Kernel (the pattern)          Hardening (makes it good in practice)
  ────────────────────          ─────────────────────────────────────
  greedy frontier walk          multi-layer hierarchy (the "H")
  visited set                   ef_search (how many candidates to keep)
  local-min termination         M (links per node, graph density)
```

**Where buffr touches this — the one SQL line.** buffr doesn't write the walk;
it triggers it (`src/pg-vector-store.ts:74-77`):

```ts
order by embedding <=> $1::vector   // ← THIS triggers the HNSW greedy walk
limit $3                            // ← k results from the walk
```

When this `order by` runs against the `chunks_embedding_hnsw` index
(`sql/001:28-29`), Postgres's planner uses the index — meaning it runs the
greedy graph walk above instead of computing cosine distance against every
row. That substitution, planner-chosen, is the entire performance story. (The
*planner decision* and tuning knobs like `ef_search` belong to
**`study-database-systems`**; this file owns the traversal algorithm.)

**The same graph serves memory — no second structure.** `session.ts:53` wires
`createConversationMemory({ embedder, store })` into the *same* `PgVectorStore`.
Past conversation exchanges get embedded and inserted as nodes in the *same*
HNSW graph, recalled by the *same* greedy walk:

```
  One graph, two features (session.ts:53, context.md memory model)

  ┌─ documents (indexed corpus) ──┐
  │  chunks tagged kind=document   │──┐
  └────────────────────────────────┘  │   both live as nodes in the
  ┌─ memory (past exchanges) ─────┐    ├─► SAME HNSW graph
  │  chunks tagged kind=memory     │──┘   recalled by SAME greedy walk
  └────────────────────────────────┘      via search_knowledge_base tool
```

The data-structure lesson: episodic memory needed *no new structure* — it's
retrieval-based recall reusing the graph that already exists. That's the
elegant part of buffr's design, and it's a pure DSA observation.

### Move 3 — the principle

**A graph index trades exactness for sublinearity, and the trade is the whole
point.** Your Dijkstra is correct and complete because the problem demanded the
*true* shortest path. Nearest-neighbour search at scale demands *speed more
than exactness* — a 99%-correct answer in O(log n) beats a 100%-correct answer
in O(n) when n is millions and the consumer is an LLM that's robust to a
slightly-imperfect retrieval. Recognising when "approximately right, fast"
beats "exactly right, slow" is the senior judgment HNSW encodes.

---

## Primary diagram

The full HNSW story, one frame, anchored to your builds and buffr's line.

```
  HNSW greedy nearest-neighbour walk — recap

  YOUR PORTFOLIO              →  THIS REPO
  Graph.ts bfs_traversal         the greedy frontier walk inside HNSW
  + visited set                  + visited set (same role: cycle termination)
  Graph2.ts + PriorityQueue      greedy best-first (Dijkstra without exactness)
       │                              │
       ▼                              ▼
  ┌─ HNSW graph (sql/001:28-29) ──────────────────────────────┐
  │  layer 2 (sparse) ●────────────●         big jumps         │
  │  layer 1          ●──●────●──●──●         medium hops       │
  │  layer 0 (dense)  ●●●●●●●●●●●●●●●●●●●●●    fine local search │
  │  query ✦ → enter top → descend, greedy-walk each layer      │
  │  stop at local min → return k nearest (limit k)             │
  └────────────────────────────────────────────────────────────┘
       triggered by: pg-vector-store.ts:74-77  order by <=> limit k
       reused by:    session.ts:53  conversation memory
       trade:        EXACT O(n) → APPROXIMATE O(log n)
```

---

## Elaborate

HNSW (Malkov & Yashunin, 2016) combines two older ideas: navigable
small-world graphs (greedy routing works because of long-range "shortcut"
links, the same property behind "six degrees of separation") and skip-list-style
hierarchy (sparse upper layers for coarse jumps). The result is the dominant
vector-search index — it's what pgvector, FAISS, Weaviate, and Qdrant all ship.
The pattern survives the vendor swap (`me.md`: vector stores rotate, the
*embedding + ANN + retrieval* shape stays), which is exactly why learning the
graph walk, not the pgvector syntax, is the transferable skill.

Where this connects: file `03` (heaps) is the structure HNSW's candidate
frontier is actually built from — a priority queue ordered by distance-to-query,
your `PriorityQueue.ts` exactly. File `06` frames the whole thing as *selection*
(top-k) and contrasts the exact alternatives. For the index *build* cost and
the planner decision, **`study-database-systems`**.

---

## Interview defense

**Q: Walk me through how HNSW finds nearest neighbours.**

```
  greedy frontier walk over a navigable graph:
  enter (top layer) → hop to closest neighbour to query → repeat
  → descend layers (coarse → fine) → stop at local min → return k

  kernel = frontier + visited set + greedy choice + local-min termination
```

Answer: it's a greedy best-first graph walk — start at an entry node, hop to
whichever neighbour is closest to the query vector, repeat until no neighbour
is closer, using a visited set to avoid cycles. The hierarchy lets it make big
jumps high up then refine low down. The load-bearing parts people forget: the
visited set (termination on a cyclic graph) and that it stops at a *local*
minimum (which is *why* it's approximate).

Anchor: *"It's my BFS frontier plus a visited set, but greedy toward the query
and willing to stop early — that early stop is the speed and the
approximation."*

**Q: Why is HNSW approximate, and when is that acceptable?**

```
  greedy stops at a LOCAL distance minimum ≠ GLOBAL nearest
  → can miss the true nearest neighbour
  acceptable when: n huge, O(n) exact too slow, consumer tolerant (an LLM)
  unacceptable when: you need provably-exact NN (then: exact scan or accept O(n))
```

Answer: the greedy walk can converge to a local minimum and miss the true
nearest, so recall is ~99%, not 100%. That's fine for RAG — the LLM is robust
to one slightly-off chunk and you'd never pay O(n) per query at scale. It's not
fine if you need exactness guarantees; then you scan exactly and eat O(n).

Anchor: *"Approximate because greedy lands in a local min — and for RAG, 99%
recall at O(log n) beats 100% at O(n) every time."*

**Q: buffr's memory feature — what data structure backs it?**

```
  no new structure — the SAME HNSW graph
  past exchanges → embedded → inserted as nodes → recalled by same walk
  session.ts:53  createConversationMemory({ embedder, store })
```

Answer: none new — conversation memory reuses the existing vector store, so
past exchanges become nodes in the same HNSW graph and resurface through the
same nearest-neighbour walk. One graph, two product features.

Anchor: *"Episodic memory is just more vectors in the same graph — recall is
the same greedy walk."*

---

## See also

- `03-stacks-queues-deques-and-heaps.md` — the priority queue that orders
  HNSW's candidate frontier; the size-k heap top-k alternative.
- `04-trees-tries-and-balanced-indexes.md` — why this is a graph and not a
  tree (high-dimensional space breaks tree splits).
- `06-sorting-searching-and-selection.md` — the same problem framed as
  selection; exact alternatives to the approximate walk.
- **`study-database-systems`** — index build, the planner's index decision,
  `ef_search` tuning.
- **`study-ai-engineering`** — the RAG pipeline this graph walk serves.
