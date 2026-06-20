# DSA Foundations — buffr-laptop

> The reusable data-structures-and-algorithms vocabulary behind this repo —
> what it actually exercises, and the foundations it deliberately doesn't.

## The verdict first

This repo does almost no classic DSA in its own source. That's not a knock —
it's the shape of the system. `buffr-laptop` is a thin persistence + CLI shell
around `@rlynjb/aptkit-core`. The interesting algorithms live one layer down,
inside the library and inside Postgres + pgvector. The single most important
DSA idea in the whole system — approximate nearest neighbor over a navigable
small-world **graph** (HNSW) — is a one-line index declaration in
`sql/001_agents_schema.sql:28-29` and a C extension you never see.

So the honest framing for you, given your reincodes portfolio (graphs, heaps,
BSTs, Dijkstra, five sorts, all from scratch): **you have already built harder
DSA than anything in this repo's TypeScript.** What this guide does is connect
the vocabulary you own to where it shows up here, and flag the foundations this
repo lets you skip so you can decide what to practice on purpose.

```
  Where the DSA actually lives in this system

  ┌─ buffr-laptop (this repo) ──────────────────────────────┐
  │  src/pg-vector-store.ts   → builds a SQL string,        │ ← almost
  │  src/cli/*.ts             → wires + dedups with a Set   │   no DSA
  │  src/runtime.ts           → one INSERT + pipeline.index │   here
  └───────────────────────────┬─────────────────────────────┘
                              │ imports
  ┌─ @rlynjb/aptkit-core (library) ─────────────────────────┐
  │  chunker     → sliding-window slice over a string       │ ← real but
  │  in-mem store→ Map + cosine loop + sort().slice(0,k)    │   simple DSA
  │  evals       → Set membership for precision@k / recall  │
  └───────────────────────────┬─────────────────────────────┘
                              │ delegates ranking to
  ┌─ Postgres + pgvector (C extension) ─────────────────────┐
  │  HNSW index  → navigable small-world GRAPH, greedy walk │ ← the
  │  <=> operator→ cosine distance in SIMD C                │   real DSA
  └──────────────────────────────────────────────────────────┘
```

## The ranked findings

1. **The headline algorithm is a graph search you can't see.**
   The HNSW index (`sql/001_agents_schema.sql:28-29`) turns every `search()`
   call into a greedy walk over a layered proximity graph. That's the same
   *family* as your reincodes BFS/DFS over an adjacency list — frontier,
   visited set, expand-neighbors — but tuned for approximate nearest neighbor
   in 768-dimensional space. See `05-graphs-and-traversals.md`. This is the
   most load-bearing DSA fact in the repo and it's invisible in the TypeScript.

2. **Top-k selection happens twice, two different ways.**
   The library's in-memory store does the naive thing — score everything,
   `hits.sort((a,b)=>b.score-a.score).slice(0,k)` — which is the `O(n log n)`
   sort-then-slice you'd reach for first. The Postgres path does it with
   `order by ... limit k` (`src/pg-vector-store.ts:74-76`), which the HNSW
   index turns into something far cheaper than a full sort. Neither uses a
   heap — and a heap is exactly what your `BinaryHeap.ts` / `PriorityQueue.ts`
   would give you for true `O(n log k)` partial selection. See
   `03-stacks-queues-deques-and-heaps.md` and `06-sorting-searching-and-selection.md`.

3. **Cosine similarity is the one piece of math written by hand.**
   The in-memory store computes dot product and two norms in a single pass
   (one multiply-accumulate loop), then divides. The pgvector path offloads
   the same math to the `<=>` operator and reads `1 - distance` as the score
   (`src/pg-vector-store.ts:69-72`). Same formula, two execution models. See
   `02-arrays-strings-and-hash-maps.md`.

4. **Maps and Sets do the unglamorous structural work.**
   The in-memory store *is* a `Map<string, Chunk>` keyed by `"<docId>#<index>"`.
   The eval harness dedups retrieved docs with `[...new Set(hits.map(...))]`
   (`src/cli/eval-cmd.ts:26`) and scores with `Set` membership
   (`relevant` is a `Set`, lookups are `O(1)`). This is the most-used data
   structure in the system and the least dramatic. See `02-arrays-strings-and-hash-maps.md`.

5. **Chunking is a sliding window over a string.**
   `chunkText` walks a string in fixed `512 - 64 = 448` character steps,
   slicing a 512-char window each step with 64 chars of overlap. That's a
   two-pointer / sliding-window pattern — classic array-and-string DSA, living
   in the library. See `02-arrays-strings-and-hash-maps.md`.

## What this repo does NOT exercise (`not yet exercised`)

Be deliberate about these — none of them appear in buffr's source, and several
don't appear in your reincodes portfolio either:

- **Heaps for top-k.** You *built* `BinaryHeap.ts` and `PriorityQueue.ts`, but
  this repo reaches for `sort().slice()` instead. Closing that gap is a
  five-line change with a real complexity story. (`03`)
- **Trees and balanced indexes in your code.** The B-tree behind every
  Postgres primary key, and the HNSW graph, are both "balanced index"
  structures — but you never write one here. Your `BinarySearchTree.ts` is the
  unbalanced cousin. (`04`)
- **Tries / prefix structures.** Nothing in the retrieval path is prefix-based.
  Tries are absent from buffr *and* from your portfolio — a real gap. (`04`)
- **Union-find / connected components on real graphs.** Your reincodes
  `numberOfConnectedComponents` touches this; buffr never does. (`05`)
- **Dynamic programming.** Zero DP in this repo. Edit distance, sequence
  alignment, the classic memoization/tabulation problems — absent here and thin
  in your portfolio. (`07`)
- **Binary search.** No sorted-array search anywhere in buffr's source; the
  only "search" is vector search. (`06`)
- **Backtracking.** No constraint-search here. Your reincodes river-crossing
  `PG.ts` exercises state-space BFS, not backtracking proper. (`07`)
- **Amortized analysis in anger.** The `Map` resize, the dynamic array growth —
  present but never reasoned about explicitly in this repo. (`01`)

## Reading order

```
  01  complexity-and-cost-models          ← the lens for everything below
  02  arrays-strings-and-hash-maps         ← Map, Set, cosine loop, chunker
  03  stacks-queues-deques-and-heaps       ← top-k, the heap you didn't use
  04  trees-tries-and-balanced-indexes     ← B-tree PK, HNSW-as-index, gaps
  05  graphs-and-traversals                ← HNSW as a small-world graph ★
  06  sorting-searching-and-selection      ← sort+slice vs partial selection
  07  recursion-backtracking-and-dp        ← mostly gaps, honestly flagged
  08  dsa-foundations-practice-map         ← ranked: exercised first, gaps next
```

Start at `05` if you only read one file — the ANN graph is the whole point.

## Cross-links to neighboring guides

- **`study-database-systems`** owns the storage engine: how the B-tree and HNSW
  indexes are laid out on disk, how `order by ... limit` is planned, MVCC. This
  guide owns the *algorithmic shape* of those structures; that guide owns their
  *storage mechanics*.
- **`study-ai-engineering`** owns embeddings, RAG, retrieval quality, eval
  methodology. This guide owns the *data structures* underneath retrieval
  (the graph, the top-k, the cosine math); that guide owns *why* you retrieve
  and *whether the answer is good*.
- **`study-runtime-systems`** owns the event loop and async execution model
  that the `for await` / `Promise.all` patterns sit on.
