# DSA Foundations — buffr-laptop

> The reusable data-structures-and-algorithms vocabulary behind this repo —
> grounded in real `file:line` evidence, and honest about the foundations the
> repo does **not** exercise.

---

## The one-line verdict

The headline algorithm in this repo is **approximate nearest-neighbor search
over a navigable-small-world graph** (HNSW), and it lives in a single line of
DDL plus a C extension — `sql/001_agents_schema.sql:30-31`. Everything buffr's
own TypeScript *touches* is one layer up from that: cosine-similarity math,
top-k selection, and `Map`/`Set` dedup. The interesting graph lives in
Postgres; buffr issues `order by <=> limit k` and reads the answer back.

That's the through-line for the whole guide:

```
  which structures explain this repo, and which gaps to drill?

  ┌─ buffr's own TS (flat) ──────────────────────────────────┐
  │  cosine-similarity score   top-k select   Map / Set dedup │  ← exercised,
  │  (1 - distance)            (sort+slice|HNSW) ([...new Set])│    but shallow
  └───────────────────────────┬───────────────────────────────┘
                              │  one DDL line down
  ┌─ Postgres + pgvector (C) ─▼──────────────────────────────┐
  │  HNSW = a navigable-small-world GRAPH                      │  ← the real
  │  greedy frontier walk, layered skip-list-over-a-graph     │    algorithm,
  └───────────────────────────────────────────────────────────┘    not buffr's
```

You've already built the harder versions of most of this by hand in
**reincodes** (via IK): `Graph.ts` with BFS/DFS, `Graph2.ts` for Dijkstra,
`BinaryHeap.ts`, `PriorityQueue.ts`, `BinarySearchTree.ts`, five sorts with
visualizers. This guide's job is to (1) name what *this* repo actually runs, (2)
connect it to those builds where the shape matches, and (3) be blunt about the
foundations neither the repo nor your portfolio has touched yet.

---

## Ranked findings — what to look at first

```
  findings by consequence

  #1  ANN over an HNSW graph        sql/001:30-31      headline algorithm,
      (navigable small world)       pg-vector-store.ts  one DDL line, C ext
                                    :67-78

  #2  cosine similarity + top-k     pg-vector-store.ts  the retrieval kernel;
      (sort+slice vs size-k heap)   :67-85              two implementations
                                    in-memory:25-33     behind one contract

  #3  Map / Set as the dedup        eval-cmd.ts:26-28   hashing in practice;
      and membership primitive      in-memory:12        O(1) lookup, no order

  #4  vectors as the data type      contracts.ts        the substrate every
      (number[768], distance)       pg-vector-store.ts  other finding rides on
                                    :32-36

  #5  memory recall = same search   session.ts:53       no new structure —
      (episodic via vector store)   eval-cmd reuse      reuse is the lesson
```

The single most load-bearing thing to understand: **finding #2 is the kernel,
and the in-memory store and the Postgres store are the *same* top-k selection
done two ways** — `sort+slice` exact (`in-memory-vector-store.ts:31-32`) vs
`order by <=> limit k` approximate over a graph index (`pg-vector-store.ts:74-77`).
That contrast is the spine of files 03 and 05.

---

## Reading order

```
  01  complexity-and-cost-models      ── the cost lens for everything below
  02  arrays-strings-and-hash-maps     ── vectors, Map, Set  (exercised)
  03  stacks-queues-deques-and-heaps   ── the size-k heap for top-k  (partly)
  04  trees-tries-and-balanced-indexes ── BST, B-tree, trie  (mostly gap)
  05  graphs-and-traversals            ── HNSW as a graph  (the headline)
  06  sorting-searching-and-selection  ── sort+slice, binary search, top-k
  07  recursion-backtracking-and-DP    ── the biggest honest gap
  08  dsa-foundations-practice-map     ── ranked drill plan
```

Files 02, 03, 05, 06 carry the most repo-grounded code. Files 04 and 07 are
mostly `not yet exercised` — they teach the foundation and say plainly where it
would show up if the repo grew into it.

---

## `not yet exercised` — the honest gaps

Named once here, expanded in each file. None of these appear in buffr's source,
**and** with one exception (heaps) none appear in your reincodes portfolio
either — which makes them the highest-value drills.

```
  topic                  in buffr?   in reincodes?   guide file
  ─────────────────────  ─────────   ─────────────   ─────────
  size-k heap for top-k  no          yes (BinaryHeap) 03  ← easiest win
  balanced index / BST   no          yes (BST)        04
  B-tree (the pg index)  no          no               04
  trie / prefix tree     no          no               04  ← real gap
  union-find             no          no               05  ← real gap
  explicit BFS/DFS       no          yes (Graph.ts)   05
  binary search          no          no (impl)        06
  dynamic programming    no          partial (memo)   07  ← biggest gap
  backtracking           no          partial (PG.ts)  07
```

The pattern: your reincodes work covers graphs, heaps, BSTs, and sorting from
scratch. The repo doesn't re-exercise those (it delegates to Postgres). The
true *new* drills are **tries, union-find, and real DP** — absent from both.

---

## Cross-links

- **Database Systems** → `.aipe/study-database-systems/` owns the storage-engine
  view of the HNSW index, the B-tree under `chunks_app_id`, and how `order by
  <=> limit k` becomes a query plan. This guide owns the *graph algorithm*;
  database-systems owns the *index as a storage structure*.
- **AI Engineering** → `.aipe/study-ai-engineering/` owns embeddings, RAG, and
  retrieval quality (P@k / R@k). This guide owns the *data structures* under
  retrieval (the vector, the top-k select); ai-engineering owns *why* cosine
  distance is the right metric and what the eval numbers mean.

---

## See also

- `01-complexity-and-cost-models.md`
- `05-graphs-and-traversals.md` — the headline finding
- `08-dsa-foundations-practice-map.md` — what to drill
