# DSA Foundations — Practice Map

**Industry name:** a ranked learning plan. **Type:** Project-specific.

---

## Zoom out, then zoom in

This is the audit file: it ranks every concept by how much it *matters* against
two facts — what this repo exercises, and what your reincodes portfolio already
covers. The verdict drives the order: drill what's absent from *both* first
(highest leverage), reinforce what the repo exercises but you've only seen
shallowly second, and skip re-grinding what you've already built from scratch.

```
  Zoom out — the two filters that rank every drill

  ┌─ filter 1: does buffr exercise it? ───────────────────────┐
  │  exercised  → you've seen it applied, in real code         │
  │  not yet    → foundation only, no repo anchor              │
  └──────────────────────────┬─────────────────────────────────┘
                             │  crossed with
  ┌─ filter 2: have YOU built it (reincodes)? ─────────────────┐
  │  built      → from scratch, IK curriculum                  │
  │  gap        → never implemented                            │
  └─────────────────────────────────────────────────────────────┘

  highest leverage = (not yet exercised) ∧ (never built)
```

Zoom in: the plan isn't "study all of DSA." It's "spend your reps where the
return is highest" — which, given your strong graph/heap/BST/sorting base, means
**tries, union-find, and real DP**, not another pass at BFS.

---

## The structure pass

**Axis — leverage (return per hour of drilling).** Trace it across the topics and
they sort into three clean bands: things you've built (low return on re-grinding),
things the repo exercises that you should be able to *defend* (medium), and the
true gaps (high). The whole map is that one axis applied.

**Seam — the "built vs gap" boundary.** The load-bearing seam: your reincodes
work. It splits the topic list into "reinforce/defend" (built) and "drill from
zero" (gap). Crossing it is the difference between a confidence pass and new
learning.

---

## How it works

### The ranked plan

```
  the practice map — ranked by leverage (high → low)

  ┌─ BAND A: DRILL FROM ZERO (not built, not exercised) ★★★ ─────┐
  │  1. dynamic programming    (file 07)  biggest interview gap    │
  │  2. union-find             (file 05)  near-O(1) components     │
  │  3. trie / prefix tree     (file 04)  memory-ids are prefixes  │
  │  4. backtracking explicit  (file 07)  DFS + make/undo          │
  │  5. binary search (impl)   (file 06)  the off-by-one reps      │
  └───────────────────────────────────────────────────────────────┘
  ┌─ BAND B: DEFEND WHAT THE REPO EXERCISES ★★ ──────────────────┐
  │  6. ANN / HNSW as a graph  (file 05)  the headline — defend it │
  │  7. top-k: sort+slice vs   (file 06)  the repo's two paths     │
  │     heap vs ANN            (file 03)                            │
  │  8. cosine + vectors       (file 02)  the retrieval substrate  │
  │  9. B-tree vs HNSW index   (file 04)  why two indexes          │
  └───────────────────────────────────────────────────────────────┘
  ┌─ BAND C: REINFORCE (built; light touch) ★ ───────────────────┐
  │  10. BFS / DFS             (Graph.ts)   keep warm              │
  │  11. heaps / priority queue (BinaryHeap) wire to top-k         │
  │  12. BST traversals        (BST.ts)     keep warm              │
  │  13. sorting (5)           (Sorting/)   keep warm              │
  └───────────────────────────────────────────────────────────────┘
```

### Band A — drill from zero (the real gaps)

These are absent from buffr **and** from your reincodes portfolio. Highest
return per rep.

**1. Dynamic programming (file 07).** The biggest gap and the highest interview
ceiling. You have recursion (`Tree.ts`) and hash maps (file 02) — DP is exactly
those two composed. Drill the canonical set: fib-memo, coin change, edit
distance, longest-increasing-subsequence, 0/1 knapsack. The knapsack one connects
to buffr's `maxTokens: 8192` budget (`session.ts:46`) — token-budget chunking is
knapsack-shaped. Build a visualizer of the DP table filling, the way you
visualized the sorts; that's how it becomes real for you.

**2. Union-find / disjoint-set (file 05).** Near-O(1) "are these in the same
component?" with union-by-rank + path compression. Your `Graph.ts`
`numberOfConnectedComponents` solves the same problem the O(V+E) traversal way —
union-find is the upgrade. Small to implement, high recognition value.

**3. Trie / prefix tree (file 04).** The one gap with a real repo hook: buffr's
memory ids are `"memory:<conv>:<n>"` (`session.ts:53`) — a prefix-structured key
space. Build a trie, then notice Postgres' `LIKE 'memory:c1:%'` is the same
prefix scan over a B-tree.

**4. Explicit backtracking (file 07).** You have the cousin in `PG.ts`
(state-space search). Make the make/undo explicit: N-queens, subsets,
permutations, sudoku. The `undo()` is the rep that matters.

**5. Binary search, hand-implemented (file 06).** You've used it inside
`BinarySearchTree.ts` navigation but not written the bare algorithm with its
off-by-one boundary reps. Drill the variants: exact, lower-bound, upper-bound,
rotated array. Cheap, high-frequency in interviews.

### Band B — defend what the repo exercises

You can't *build* these as fresh drills (they're delegated to Postgres/aptkit),
but you must be able to *defend* them cold — they're your repo's story.

**6. ANN / HNSW as a graph (file 05).** The headline. Be able to say "it's BFS's
frontier-and-visited skeleton, turned greedy, stopping at a local minimum for
~O(log N) — approximate, and the eval's recall is the price." That sentence is
the interview money shot for this repo.

**7. Top-k: sort+slice vs heap vs ANN (files 03, 06).** Walk the ladder:
in-memory full sort (`in-memory-vector-store.ts:31`), size-k heap (your
`BinaryHeap.ts`), ANN (`pg-vector-store.ts:74`). Naming all three rungs is the
selection-vs-sorting signal.

**8. Cosine similarity + vectors (file 02).** `1 - (embedding <=> $1)` —
distance vs similarity, the 768-dim contract, why `assertDim` throws. The
substrate everything rides on.

**9. B-tree vs HNSW — two indexes, two query shapes (file 04).** Why `where
app_id` rides a B-tree and `order by <=>` rides HNSW, and why no single index does
both.

### Band C — reinforce (already built)

`Graph.ts` (BFS/DFS), `BinaryHeap.ts`/`PriorityQueue.ts`, `BinarySearchTree.ts`,
the five sorts. You built these from scratch via IK. Don't re-grind — keep them
warm with occasional reps and, more usefully, *wire them to the repo*: the heap
to top-k (file 03), BFS's skeleton to the HNSW walk (file 05). The value now is
connecting what you built to what the repo runs, not rebuilding.

### Move 3 — the principle

Drill against the gap, not the strength. Your base (graphs, heaps, BSTs, sorting)
is strong and the repo leans on it — so the leverage is in the three absences
(DP, union-find, trie) plus the ability to *defend* the repo's delegated
algorithms (HNSW, top-k) in the same vocabulary you built the foundations with.

---

## Primary diagram

The whole map in one frame — the two filters and the three bands.

```
  practice map — built × exercised, ranked by leverage

                    │ exercised in buffr        │ not exercised
  ──────────────────┼───────────────────────────┼──────────────────────
  built (reincodes) │ BAND C: reinforce/wire    │ Band C-ish: keep warm
                    │  BFS/DFS, heaps→top-k,     │  (heaps, BST exist;
                    │  sorts, BST                │   no repo anchor)
  ──────────────────┼───────────────────────────┼──────────────────────
  gap (never built) │ BAND B: DEFEND            │ BAND A: DRILL ★★★
                    │  HNSW, cosine, B-tree,     │  DP, union-find, trie,
                    │  top-k ladder              │  backtracking, binary search
  ──────────────────┴───────────────────────────┴──────────────────────

  spend reps bottom-right (drill), be fluent bottom-left (defend),
  keep top warm (reinforce)
```

---

## Elaborate

The discipline here is the same one your IK curriculum already taught you:
methodical, foundation-first, build-to-understand. The shift for the AI-
engineering pivot is *what* to drill — the retrieval stack (HNSW, top-k, cosine)
is a graph-and-selection story you can tell in DSA vocabulary you already own,
which is a strong interview position. The genuine new learning is the Band A set,
and the reason it's worth deliberate practice is leverage: DP and union-find and
tries show up across hundreds of problems, and you've built none of them. Pair
each with a visualizer the way you did the sorts — that's how the fundamental
becomes real for you (me.md's hands-on loop), and it doubles as portfolio.

---

## Interview defense

**Q: This repo barely writes DSA — its retrieval is one SQL line. So what DSA do
you actually know?**

```
  delegated ≠ unknown. I can decompose the one SQL line into:
   - HNSW = navigable-small-world GRAPH, greedy walk (BFS skeleton, approx)
   - order by <=> limit k = TOP-K SELECTION (sort+slice / heap / ANN ladder)
   - 1 - distance = COSINE on 768-d VECTORS
   - where app_id = B-TREE index
  and I built the harder versions by hand — Dijkstra, BinaryHeap, BST, 5 sorts.
```

The repo *delegates* the algorithm to Postgres, but I can take that one SQL line
apart into the graph walk, the selection, the vector math, and the index — and I
implemented the foundations those rest on from scratch. Delegation is an
architecture choice, not a knowledge gap. Naming the decomposition *and* the
hand-built foundations is the answer.

**Q: What would you drill next and why?**

```
  highest leverage = absent from both repo AND portfolio:
   DP (biggest ceiling) · union-find · trie · explicit backtracking
  lowest = re-grinding BFS/heaps I already built from scratch
```

DP first — biggest interview ceiling and I have the parts (recursion + hash map)
without having composed them. Then union-find and tries — small to build, high
recognition. I wouldn't re-grind BFS or heaps; I built those from scratch, so the
return is in defending how they map to the repo, not rebuilding them.

**Anchor:** "Drill the gap, defend the delegated. The repo's retrieval is a
graph-and-selection story I can tell in the same DSA vocabulary I built the
foundations with — and the new reps are DP, union-find, and tries."

---

## See also

- `00-overview.md` — the repo-grounded findings this plan ranks
- `05-graphs-and-traversals.md` — the headline to defend (Band B) + union-find
  (Band A)
- `07-recursion-backtracking-and-dynamic-programming.md` — the top Band A drills
- `03-stacks-queues-deques-and-heaps.md` — wiring your heap to top-k (Band B/C)
