# Sorting, Searching, and Selection

**comparison sort / top-k selection / binary search / partitioning** — *Industry standard*

## Zoom out, then zoom in

The repo sorts in exactly one place — the in-memory top-k — and it's the one
place where sorting is the *wrong* tool for the job it's doing. You built all
five comparison sorts plus heapsort; this file is about when *not* to sort.

```
  Zoom out — where ordering happens, by layer

  ┌─ buffr / aptkit retrieval layer ─────────────────────┐
  │  in-memory store: hits.sort().slice(0,k)  ★          │ ← the only sort;
  │                   a SELECTION problem solved by SORT  │   over-solves it
  │  eval: scorePrecisionAtK — slice(0,k) + Set count     │ ← selection + count
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ pgvector layer ──────────▼──────────────────────────┐
  │  order by <=> limit k → HNSW selection, not a sort    │ ← top-k via graph
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ your reincodes (anchor) ─▼──────────────────────────┐
  │  utils/notes/Sorting/ → selection/bubble/insertion/   │ ← you built these
  │  merge/quick/heap, all with visualizers                │   from scratch
  └───────────────────────────────────────────────────────┘
```

Zoom in: **sorting** produces a total order — `O(n log n)` for comparison sorts.
**Searching** finds one element — `O(log n)` binary search in a sorted array.
**Selection** finds the top k (or the kth) *without* full ordering — `O(n log k)`
with a heap, `O(n)` average with quickselect. The question this file answers:
*the repo's top-k is a selection problem; why does it sort, and what would you
use instead?*

## The structure pass

Trace **one axis — "how much order does the answer actually require?" — across
the three operations.**

```
  Axis = "how much ordering does the question NEED?"

  ┌─ "is X present in sorted data?" ───────┐
  │ binary search → O(log n), needs sorted  │  needs: position only
  └──────────────────────┬──────────────────┘
                         │  seam: one element vs k elements
  ┌─ "give me the top k" ─▼────────────────┐
  │ SELECTION → O(n log k) heap / O(n) qsel │  needs: k best, unordered-among-k
  └──────────────────────┬──────────────────┘
                         │  seam: k best vs ALL ordered
  ┌─ "give me everything in order" ─▼──────┐
  │ SORT → O(n log n)                       │  needs: total order (overkill here)
  └──────────────────────────────────────────┘
```

The load-bearing **seam**: between *selection* ("top k") and *sorting* ("all
ordered"). The repo's `search()` lives on the selection side of that seam — it
needs k chunks — but reaches across it to a full sort. The axis (how much order
is needed) says selection suffices; the code pays for total order anyway. That
mismatch is the finding, and it's the same `sort().slice()` from `03`, viewed
through the selection lens.

## How it works

### Move 1 — the mental model

You've animated all of these — bars swapping for bubble/insertion/selection,
merge splitting and combining, quick partitioning around a pivot, heapsort
draining a heap. The new idea here is small but sharp: **selection is sorting's
cheaper cousin when you only want the extremes.**

```
  Three operations, three amounts of order

  SORT      [3,1,4,1,5,9,2,6] → [1,1,2,3,4,5,6,9]   O(n log n), full order
  SELECT k  [3,1,4,1,5,9,2,6] → top 3: {9,6,5}      O(n log k), k best only
            (unordered among themselves — that's fine)
  SEARCH    sorted, find 4 → index 4                 O(log n), one element
```

The single sentence: **only sort when you need the whole order; for top-k, select
— you're throwing away `n-k` elements, so don't pay to order them.**

### Move 2 — each operation against the repo

**Sorting — the in-memory top-k, the over-solve.**
The library's `InMemoryVectorStore.search` scores every chunk, then
`hits.sort((a,b) => b.score - a.score)` — a full descending comparison sort —
then `slice(0, k)`. Bridge: it's your `mergeSort`/`quickSort` producing a total
order. Where it breaks (as a *choice*, not a bug): it orders all n to keep k. The
`n-k` chunks past position k get fully sorted relative to each other and then
discarded — pure wasted comparisons.

```
  Execution trace — sort+slice, n=6, k=2

  scores:      [0.9, 0.3, 0.7, 0.95, 0.6, 0.8]
  sort desc:   [0.95, 0.9, 0.8, 0.7, 0.6, 0.3]   ← O(n log n): ordered ALL 6
  slice(0,2):  [0.95, 0.9]                         ← kept 2, DISCARDED 4
                                                     ▲
                          the ordering of {0.8,0.7,0.6,0.3} was computed
                          and immediately thrown away — that's the waste
```

**Selection — what it should be.**
Two ways to select top-k without full sorting. A **bounded min-heap** of size k
(`03`): scan n, keep the k best — `O(n log k)`. Or **quickselect**: partition
around a pivot (your `quickSort`'s partition step) and recurse only into the side
holding position k — `O(n)` average. Bridge: quickselect is your quicksort that
*stops* once the pivot lands at index k instead of recursing both sides. Where it
breaks: quickselect's worst case is `O(n²)` on a bad pivot (same as quicksort) —
the heap's `O(n log k)` is worst-case-safe, which is why it's the steadier choice.

```
  Quickselect — quicksort that recurses ONE side (top-k by partition)

  find top 2 (≈ kth largest at index 1):
  [0.9, 0.3, 0.7, 0.95, 0.6, 0.8]  pivot=0.7
  partition: [0.9, 0.95, 0.8 | 0.7 | 0.3, 0.6]   pivot at index 3
                                   ▲
  want index<2 → recurse LEFT only: [0.9,0.95,0.8]   ← skip the right half
  ──────────────────────────────────────────────────────
  O(n) average — never orders the discarded half (vs sort's O(n log n))
```

**Searching — binary search, conspicuously absent.**
Binary search needs sorted data and finds one element in `O(log n)`. Bridge: it's
the array analog of your `BinarySearchTree.ts` — halve the space each step. Where
it's relevant here: it *isn't*. buffr has no sorted-array lookup anywhere. The
only "search" is vector search (`05`), which is approximate graph search, not
binary search. Worth naming as a gap: a clean binary search doesn't appear in
buffr's source.

```
  Binary search — halve the space (NOT used in buffr — the gap)

  sorted: [1, 3, 4, 6, 8, 10, 13]   find 8
  lo=0 hi=6 mid=3 (6) → 8>6, go right
  lo=4 hi=6 mid=5 (10)→ 8<10, go left
  lo=4 hi=4 mid=4 (8) → found      O(log n), 3 probes for 7 elements
```

**Selection in the eval scorer — `slice(0,k)` then count.**
`scorePrecisionAtK` takes the top-k retrieved ids (`retrievedIds.slice(0, k)`),
counts distinct ones present in the `relevant` Set, and divides. Bridge: it's
selection (`slice` the window) + membership counting (`02`'s Set). Where it
breaks: the denominator is `min(k, retrievedIds.length)` — so a short result list
isn't penalized for being short. That's a deliberate scoring choice, not an
accident.

```
  precision@k — select the window, count distinct relevant

  retrieved: [work.md, work.md, stack.md]   k=1
  slice(0,1):[work.md]                        ← select top-1
  has(work.md)? yes → matched=1
  total = min(1, 3) = 1
  precision@1 = 1/1 = 1.0
```

### Move 3 — the principle

**Don't pay for more order than the answer needs.** Sorting gives total order at
`O(n log n)`; selection gives the top k at `O(n log k)` or `O(n)`; search gives
one element at `O(log n)`. The repo's in-memory top-k buys total order and throws
most of it away — correct, simple, and at this corpus size, fine. The skill is
*seeing* that it's a selection problem wearing a sort's clothes.

## Primary diagram

The order-cost ladder, with each rung mapped to where it lives (or should) in the
repo.

```
  The order-cost ladder — recap

  OPERATION    COST         WHERE IN REPO
  ────────────────────────────────────────────────────────────────
  full sort    O(n log n)   in-mem store hits.sort()  ← over-solves top-k
  selection    O(n log k)   SHOULD be here (your BinaryHeap.ts)
               O(n) avg     quickselect (your quicksort partition, stopped)
  HNSW select  ~O(log n)    pgvector order by <=> limit k  ← shipped path
  binary search O(log n)    — nowhere in buffr — (gap)
  membership   O(1)         eval Set.has (file 02)
```

## Implementation in codebase

**Use cases.** The full sort runs in the library's in-memory store on every
query when that store is wired (tests, zero-cloud demos). The selection-by-slice
runs in the eval scorer on every `npm run eval`. The HNSW selection runs in
`PgVectorStore` on every shipped query.

```
  @aptkit/retrieval in-memory-vector-store.js (search) — selection via sort

  hits.sort((a, b) => b.score - a.score);   ← O(n log n) FULL comparison sort
  return hits.slice(0, Math.max(0, k));      ← keep k, discard n-k
       │
       └─ the sort orders all n; slice keeps k. This is a selection problem
          (top k) solved by sorting. A size-k min-heap (your BinaryHeap.ts)
          is O(n log k); quickselect (your quicksort's partition) is O(n).
          At buffr's corpus size the sort is the right simple call — the
          point is recognizing it's selection, not sorting.
```

```
  @aptkit/evals/precision-at-k.js (scorePrecisionAtK) — selection + count

  const total = Math.min(k, retrievedIds.length);   ← denominator: don't
                                                        penalize short lists
  const matched = countDistinctHits(retrievedIds, relevantIds, k);
       │
       └─ countDistinctHits does retrievedIds.slice(0,k) then a Set to count
          DISTINCT relevant ids — selection (slice the window) + membership.
          Surfaced in buffr at src/cli/eval-cmd.ts:27.
```

## Elaborate

Quickselect is Hoare's 1961 sibling to quicksort — same partition, one-sided
recursion, `O(n)` average. The heap-based top-k is the worst-case-safe
alternative and the one most production systems use (it streams: you can select
top-k from a feed you can't hold in memory). Binary search dates to the 1940s and
is famously hard to write bug-free (the `mid = (lo+hi)/2` overflow, the off-by-one
on bounds) — Bentley found most published versions were wrong for decades.

The portfolio connection: you've built all five comparison sorts plus heapsort
*with visualizers* — which means you already own the partition step quickselect
needs and the heap top-k needs. The gap is **quickselect itself** (you built
quicksort but not its one-sided selection variant) and **binary search in anger**
(absent from buffr; verify it's solid in your reincodes set). DP-style selection
is `not yet exercised` and lives in `07`.

## Interview defense

**Q: The in-memory store sorts n chunks to return top k. What is this *actually*,
and how would you do it?**

```
  selection problem in a sort's clothing

  need: top k        have: full O(n log n) sort + slice
  better:
    size-k min-heap → O(n log k)   (worst-case safe)
    quickselect     → O(n) avg     (partition, recurse one side)
```

Answer: "It's a *selection* problem — top k — solved by a full sort, which
over-pays: it orders all n and discards n−k. I'd use a size-k min-heap for
`O(n log k)`, worst-case safe — that's my `BinaryHeap`. Or quickselect for `O(n)`
average, which is my quicksort's partition recursing only the side with index k.
At three docs the sort is the right simple choice; the instinct is recognizing
selection." Anchor: the library's `hits.sort().slice()`.

**Q: Why is `total = min(k, retrievedIds.length)` in precision@k?**

Answer: "So a short result list isn't penalized. If only 2 chunks come back for
k=3, dividing by 3 would unfairly cap precision at 0.67 even if both are relevant.
Dividing by the actual retrieved count (2) measures the precision of what was
actually returned." Anchor: `@aptkit/evals/precision-at-k.js`.

## Validate

1. **Reconstruct.** Write quickselect's one-sided recursion from memory, starting
   from your quicksort's partition. What's its average and worst case?
   (`O(n)` / `O(n²)`.)
2. **Explain.** Why is the in-memory `hits.sort().slice(0,k)` a selection problem,
   not a sorting one? (Library in-memory store `search`.)
3. **Apply.** Rewrite that top-k with a size-k min-heap. New complexity, and which
   reincodes file backs it? (`O(n log k)`; `BinaryHeap.ts`.)
4. **Defend.** Argue when the full sort is genuinely the right call over a heap or
   quickselect. (Tiny n, or when you need the full order anyway — neither true at
   scale here.)

## See also

- `03-stacks-queues-deques-and-heaps.md` — the heap that does `O(n log k)` top-k.
- `05-graphs-and-traversals.md` — HNSW, the `O(log n)` selection that ships.
- `01-complexity-and-cost-models.md` — the `O(n log n)` vs `O(n log k)` math.
- `02-arrays-strings-and-hash-maps.md` — the Set behind precision@k counting.
