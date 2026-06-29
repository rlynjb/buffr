# Sorting, Searching, and Selection

**Industry names:** comparison sort · binary search · top-k selection · partial
sort · quickselect · partitioning. **Type:** Language-agnostic.

---

## Zoom out, then zoom in

This file is the kernel of the whole guide, because retrieval *is* a selection
problem: out of N chunks, return the k with the highest similarity. The repo
solves it two ways behind one contract — `sort+slice` (exact, in-memory) and
`order by <=> limit k` (approximate, over the HNSW graph). You've implemented
five sorts with visualizers in reincodes; this is where that lands in production
code.

```
  Zoom out — where selection lives

  ┌─ buffr TS / aptkit retrieval ─────────────────────────────┐
  │  search(vector, k) → the k highest-scoring chunks          │ ← we are here
  │   ┌ in-memory: score all → SORT → SLICE k  (exact)         │
  │   └ pgvector:  order by <=> LIMIT k         (approx, graph) │
  └──────────────────────────┬─────────────────────────────────┘
                             │  k feeds
  ┌─ eval ───────────────────▼─────────────────────────────────┐
  │  P@k / R@k over the selected k  (eval-cmd.ts)               │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: **sorting** puts all n in order — O(n log n) for comparison sorts.
**Searching** finds one element — O(log n) with binary search on sorted data.
**Selection** asks for the top/bottom k *without fully sorting* — the problem
retrieval actually has. The repo's in-memory path over-solves it (full sort);
the pgvector path under-visits (graph walk). Both return the same shape.

---

## The structure pass

**Layers** — three ways to get "the top k", by how much work they do:

```
  top-k — three strategies, descending work

  ┌─ full sort + slice ───────────────────┐  O(n log n)  sorts all, keeps k
  │  in-memory-vector-store.ts:31-32        │  ← buffr's exact path
  └──────────────────────┬──────────────────┘
       ┌─────────────────▼────────────────┐  O(n log k)  size-k heap (file 03)
       │  partial sort (heap / quickselect) │  ← buffr uses neither
       └─────────────────┬────────────────┘  O(n) avg (quickselect)
            ┌────────────▼───────────────┐   ~O(log n) ← buffr's prod path
            │ ANN graph walk (visits few) │   doesn't even score all n
            └─────────────────────────────┘   pg-vector-store.ts:74
```

**Axis — cost (how many elements does it touch?).** Trace it: full sort touches
all n and orders all n; quickselect/heap touch all n but order only k; the ANN
walk doesn't even touch all n. The cost drops as you do less unnecessary
ordering.

**Seam — the "do I need all n sorted?" boundary.** Selection is the realization
that you almost never do. The in-memory store sits on the expensive side (sorts
all n it discards); pgvector sits past the cheap side (skips n entirely). The
seam is the insight that turns a sort into a select.

---

## How it works

### Move 1 — the mental model

You animated all five sorts — you know the bars. The mental model here is one
step past sorting: **you rarely need the whole array ordered.** Retrieval wants
the top 3; sorting all N to take 3 is doing 99% wasted work at scale. Selection
is "stop sorting once you have the k you need."

```
  sort vs select — the wasted work

  full sort:    [unsorted N] ──► [fully sorted N] ──► take first k
                              all N ordered          (N-k of it discarded)

  selection:    [unsorted N] ──► [k best, rest unordered] ──► done
                              only k ordered          (no wasted ordering)

  k=3, N=10000 → full sort orders 9997 elements nobody reads
```

### Move 2 — the three operations in the repo

**Sorting — the exact in-memory path uses a full comparison sort.** This is the
literal "score everything, sort, take k" you'd animate:

```ts
// in-memory-vector-store.ts:27-32 — sort+slice top-k
const hits: VectorHit[] = [];
for (const chunk of this.chunks.values()) {                  // O(N): score all
  hits.push({ id: chunk.id, score: cosineSimilarity(...), meta: chunk.meta });
}
hits.sort((a, b) => b.score - a.score);                      // O(N log N): full sort
return hits.slice(0, Math.max(0, k));                        // O(k): slice the top
```

Annotation: `.sort()` is V8's comparison sort (Timsort — a merge/insertion
hybrid, two of your five). It orders all N by descending score; line 32 then
keeps k. Correct, dead simple, and the *right* call for a small corpus — the
full sort's O(N log N) is nothing when N is small. The `b.score - a.score`
comparator is descending (highest first), the one detail that flips it from
nearest-last to nearest-first.

**Selection — the operation the repo *doesn't* hand-roll but its prod path
embodies.** Quickselect (the selection algorithm) is partitioning — Lomuto/Hoare
partition from quicksort, but recursing into only the side that holds the k-th
element — O(n) average. buffr never writes quickselect; `order by <=> limit k`
hands selection to Postgres, which over the HNSW index does something *better
than* quickselect: it doesn't even score all n (file 05). So the selection
"algorithm" in production is the graph walk.

```
  selection strategies and which the repo uses

  quickselect  partition, recurse one side   O(n) avg   ── repo: not built
  size-k heap  keep k best in a heap          O(n log k) ── repo: not built (file 03)
  full sort    sort all, slice k              O(n log n) ── repo: in-memory ✓
  ANN walk     skip most of n                 ~O(log n)  ── repo: pgvector ✓ ★
```

**Searching — binary search, the BST idea without the tree.** This is `not yet
exercised` in buffr and, honestly, you haven't shipped an explicit binary-search
implementation either — though it's the engine inside your `BinarySearchTree.ts`
navigation. Binary search needs *sorted* data and halves the space each step:

```
  binary search — O(log n) on SORTED data

  find 7 in [1,3,5,7,9,11]:
   lo=0 hi=5 mid=2 (val 5) → 7>5 → search right half
   lo=3 hi=5 mid=4 (val 9) → 7<9 → search left half
   lo=3 hi=3 mid=3 (val 7) → found, 3 probes not 6

  precondition: data MUST be sorted — else the halving logic is wrong
```

Where it'd matter in this repo: it doesn't, directly — vector nearest-neighbor
isn't a 1-D sorted search (that's the whole reason HNSW exists, file 05). Binary
search shows up only inside structures buffr delegates (the B-tree index, file
04, *is* binary search on disk). So: foundational, exercised *under* the repo via
the B-tree, never written *in* it.

**The boundary condition that bites:** binary search silently returns wrong
answers on unsorted data — it doesn't error, it just halves into the wrong half.
The sortedness precondition is invisible and load-bearing. Same energy as file
04's degenerate BST: the structure assumes an invariant the type can't enforce.

### Move 3 — the principle

Most "give me the top k" problems are *selection*, not sorting — and you almost
never need all n ordered. The repo's two paths bracket the lesson: the in-memory
store over-solves with a full sort (fine when n is small), pgvector under-solves
with a graph walk (necessary when n is large). The size-k heap and quickselect
are the middle rungs neither uses but you should know exist.

---

## Primary diagram

Selection across the repo, with the work each strategy does.

```
  top-k selection — the repo's two paths + the rungs between

  query → score chunks → SELECT top k → return

  ┌─ in-memory (exact, small N) ──────────────────────────┐
  │ score all N → sort N (O(N log N)) → slice k            │  ← built
  │ in-memory-vector-store.ts:27-32                        │
  └────────────────────────────────────────────────────────┘
  ┌─ rungs the repo skips ────────────────────────────────┐
  │ quickselect O(N) · size-k heap O(N log k) (file 03)    │  ← know these
  └────────────────────────────────────────────────────────┘
  ┌─ pgvector (approx, large N) ──────────────────────────┐
  │ order by <=> limit k → HNSW walk (~O(log N))           │  ← prod path
  │ pg-vector-store.ts:74-77                               │
  └────────────────────────────────────────────────────────┘

  binary search: not in buffr's code; lives inside the B-tree index (file 04)
```

---

## Elaborate

The sort→select progression is one of the highest-leverage ideas in applied DSA:
the moment you realize "top k" doesn't need a full sort, a whole class of
problems (leaderboards, k-nearest, k-largest, median) gets cheaper. Quickselect
(Hoare, 1961 — the same Hoare as quicksort) is the canonical exact-selection
algorithm: O(n) average by partitioning and recursing one side. The size-k heap
(file 03) is the streaming version. ANN (file 05) is the "I don't even need to
look at all n" version for high-dimensional data. Binary search is the searching
primitive underneath sorted structures — invisible in buffr's source but running
in every B-tree probe. Your five-sort portfolio is the foundation all of this
sits on; the production lesson is that you rarely run a full sort when selection
will do.

---

## Interview defense

**Q: The in-memory store sorts all N to return k=3. What's wrong with that at
scale, and what are the fixes in order?**

```
  problem:  O(N log N) — orders N-3 elements nobody reads
  fix 1:    size-k min-heap  → O(N log k)   (still scores all N)
  fix 2:    quickselect      → O(N) avg     (still scores all N)
  fix 3:    ANN graph index  → ~O(log N)    (doesn't score all N) ★ buffr's prod
```

Sorting all N wastes the ordering of the N−k you discard. The progression: a
size-k heap (O(N log k)), then quickselect (O(N)), then — the real answer for
this repo — don't score all N at all, use the HNSW index (`pg-vector-store.ts:74`).
The first two still touch every chunk; only ANN escapes that. Naming the full
ladder shows you see selection as distinct from sorting.

**Q: Why isn't nearest-neighbor just a binary search on the scores?**

```
  binary search needs a 1-D total order on the data
  768-d vectors have NO single sort order → can't binary-search "nearest"
  you'd have to score all N first (O(N)) to even get scores to search →
  defeats the purpose → that's exactly why HNSW (a graph, not a sort) exists
```

Binary search needs sorted data on one dimension. Vectors are 768-dimensional
with no natural order, and you'd have to compute all N scores to sort them
anyway. So nearest-neighbor isn't a search-on-sorted problem; it's a graph
problem (file 05). Naming why the obvious O(log n) tool *doesn't* apply is the
signal.

**Anchor:** "Top-k is selection, not sorting — and the ladder is heap →
quickselect → ANN, each touching less of n than the last. The repo's in-memory
path is the naive top of that ladder; pgvector is the bottom."

---

## See also

- `03-stacks-queues-deques-and-heaps.md` — the size-k heap, the rung between full
  sort and ANN
- `05-graphs-and-traversals.md` — why selection over vectors is a graph walk
- `04-trees-tries-and-balanced-indexes.md` — binary search as the B-tree's engine
- `01-complexity-and-cost-models.md` — the O(n log n) vs O(n) vs O(log n) math
