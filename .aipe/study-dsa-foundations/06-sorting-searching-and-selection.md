# Sorting, Searching & Selection

**Industry name(s):** comparison sort (merge / quicksort) · binary search ·
top-k selection · quickselect / partial selection — *Industry standard*

The leading nouns: **sorting** (total order, O(n log n)), **binary search**
(O(log n) lookup in *sorted* data), **top-k selection** (the k best without
fully sorting). buffr's whole retrieval reduces to **top-k selection**
(`order by ... limit k`), so this file is where the sorting fundamentals you
visualized meet the one operation buffr actually performs.

---

## Zoom out — where ordering and selection live

buffr's hot path is one selection operation. The zoom-out marks it and the
three ways to do it.

```
  Zoom out — selection across the stack

  ┌─ buffr source ─────────────────────────────────────────────┐
  │  search(vector, k) → "give me the k closest"               │ ← we are here
  │  pg-vector-store.ts:74-77  order by distance limit k        │
  └───────────────────────────┬────────────────────────────────┘
                              │ three ways to satisfy this:
  ┌─ implementations ─────────▼────────────────────────────────┐
  │  (a) sort + slice   O(n log n)   ← aptkit in-memory store   │
  │  (b) size-k heap    O(n log k)   ← textbook, used by no one │
  │  (c) HNSW walk      O(log n)~    ← buffr's actual path      │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is **"to get the k best out of n, must you sort all n —
and if not, what's cheaper?"** You built five sorts with animated bar swaps,
so you own the sorting half cold. This file's job is to show that buffr almost
never needs a *full* sort — it needs *selection*, a strictly easier problem —
and to rank the three ways it gets done.

---

## Structure pass — layers, axis, seams

**Axis: how much order do you actually produce?** Sorting produces total order;
selection produces only "the k best, in no particular order among the rest."
Producing less order is the seam where cost drops.

```
  Axis: "how much of the input do you fully order?" — traced

  ┌─ full sort (your merge/quick sorts) ──┐
  │  ALL n in total order   O(n log n)     │   → most order, most cost
  └───────────────┬───────────────────────┘
      seam: do you need ALL of it ordered? (usually no)
      ┌───────────▼───────────────────────┐
      │ top-k selection: only the k best    │   → partial order, less cost
      │  sort+slice O(n log n) | heap O(n log k) | quickselect O(n) avg
      └───────────────┬────────────────────┘
      seam: do you even need to SEE all n? (with an index, no)
          ┌──────────▼──────────────────────┐
          │ HNSW: examine ~log n nodes        │   → least work, approximate
          └───────────────────────────────────┘
```

The load-bearing seam: **selection is cheaper than sorting because it produces
less order.** And indexing is cheaper than selection because it lets you skip
most of the input entirely. Each step down the stack produces *less* ordering
and pays *less*. That progression is the lesson.

---

## How it works

### Move 1 — the mental model

You animated this. Your merge sort splits-and-merges, your quicksort
partitions around a pivot — both produce a fully ordered array, O(n log n).
Now relax the requirement: you don't need *all* of it sorted, just the smallest
k distances. That's **selection**, and the key realisation is that partitioning
(the quicksort move) already half-solves it.

```
  Sort vs select — produce only the order you need

  FULL SORT (you built this)        TOP-K SELECTION (what buffr needs)
  [3 1 4 1 5 9 2 6] ─sort─►          [3 1 4 1 5 9 2 6], k=3
  [1 1 2 3 4 5 6 9]                  ─partition around pivot─►
   ▲ all n ordered, O(n log n)       [1 1 2 | 3 ... rest unsorted]
                                      ▲ smallest 3 found, rest untouched
                                      quickselect: O(n) average
```

One sentence: **selection finds the k best without ordering the rest, so it
beats a full sort — and an index (HNSW) beats selection by not examining the
rest at all.**

### Move 2 — the three ways buffr's top-k gets done

**The operation, stated.** Every `search` returns the k smallest cosine
distances (`src/pg-vector-store.ts:74-77`):

```ts
order by embedding <=> $1::vector   // ← order by distance
limit $3                            // ← take k → this is top-k selection
```

`order by ... limit k` is the SQL spelling of top-k selection. The three
implementations behind it:

**(a) Sort + slice — what aptkit's in-memory store does.** Sort all n by
distance, take the first k. Uses your merge/quicksort knowledge directly:

```
  sort + slice — O(n log n)

  all n distances ──full sort──► [d1 ≤ d2 ≤ ... ≤ dn] ──slice(0,k)──► first k
                    ▲ orders ALL n, even the n−k discarded (wasteful but simple)
```

Honest read: it's the simplest correct thing, and aptkit picks it because its
in-memory n is small enough that O(n log n) doesn't hurt. Simplicity over
optimality, correctly.

**(b) Size-k heap — the textbook answer nobody here uses.** Covered in depth in
file `03`: keep a max-heap of size k, O(n log k). Better than sort+slice when
k ≪ n because it never orders the discards. Not used in buffr because the layer
that *could* use it (aptkit in-memory) chose simplicity, and the layer that
matters (buffr) uses an index instead.

**(c) Quickselect — partition-based selection, the array answer.** This is the
one your quicksort already contains. Quicksort partitions around a pivot, then
recurses on *both* sides. Quickselect partitions, then recurses on **only the
side containing the k-th element** — throwing half the work away each step:

```
  Quickselect — quicksort that recurses on ONE side (execution trace, find k=3 smallest)

  [3 1 4 1 5 9 2 6]  pivot=4 → partition → [3 1 1 2 | 4 | 5 9 6]
                                            └─ 4 elements ≤ pivot ─┘
   want 3 smallest, left side has 4 ≥ 3 → recurse LEFT only:
  [3 1 1 2]          pivot=2 → [1 1 | 2 | 3]
                               └ 2 elements, need 1 more → take 2, recurse left
   → smallest 3 = {1, 1, 2}, right side NEVER touched
   average O(n): n + n/2 + n/4 + ... = 2n
```

Why O(n) average vs the heap's O(n log k): quickselect discards a *constant
fraction* each step instead of doing a log-k operation per element. (Worst case
O(n²) on bad pivots — the same caveat as quicksort, fixed by random pivots.)

**Binary search — present, but not in buffr's vector path.** Binary search
needs *sorted* data and gives O(log n) lookup. buffr's vector distances aren't
pre-sorted (the whole point is to find the smallest at query time), so binary
search doesn't apply to retrieval. Where it *does* live: inside Postgres's
B-tree index walk (file `04`) — each node-level decision is a binary-search-like
narrowing. And it's the algorithm behind `on conflict (id)`
(`src/pg-vector-store.ts:50`) finding the existing row via the primary-key
B-tree. So binary search is here, just not in the part you'd first look.

**Why buffr's actual answer is none of (a)/(b)/(c).** The honest punchline:
buffr's path is the HNSW walk (file `05`), O(log n) approximate, which beats
all three exact selections by *not examining all n*. Sort+slice, heap, and
quickselect all require touching every element at least once (O(n) floor); the
index doesn't. That's why "use an index" is the senior answer to "find the k
nearest among millions," and the three exact methods are what you'd reach for
only *without* a pre-built index.

### Move 3 — the principle

**Produce exactly the order the problem needs, and no more.** Full sort →
selection → indexed approximate search is a ladder of producing progressively
*less* total order for progressively *less* cost. The mistake is sorting when
you need top-k, or selecting when you have an index. The skill is reading the
requirement precisely — "k best" is not "all sorted," and "k best among
millions" is not "k best among a handful" — and picking the cheapest method
that meets exactly that requirement.

---

## Primary diagram

The selection ladder, with buffr's choice marked.

```
  Top-k selection ladder — buffr-laptop recap

  PROBLEM: k smallest cosine distances out of n   (pg-vector-store.ts:74-77)

  full sort      O(n log n)  │ your merge/quicksort — orders everything
       ↓ relax: need only k
  sort + slice   O(n log n)  │ aptkit in-memory store (simple, n small)
  size-k heap    O(n log k)  │ textbook, file 03 (k ≪ n win)
  quickselect    O(n) avg    │ quicksort-with-one-recursion (your sort, halved)
       ↓ relax: don't examine all n
  ★ HNSW walk    O(log n)~   │ buffr's ACTUAL path — approximate, file 05 ★

  binary search  O(log n)    │ NOT in vector path — lives in B-tree index (file 04)
```

---

## Elaborate

The chain sort → selection → indexed search is one of the cleanest "weaken the
requirement, drop the cost" stories in all of DSA. Quickselect (Hoare, 1961 —
same author as quicksort) is the canonical partial-selection algorithm and the
direct answer to "k-th smallest" interview questions; the size-k heap is its
streaming cousin (works when you can't hold all n). Both are exact; HNSW is the
approximate index that makes the exact methods unnecessary at scale.

Where this connects: file `03` owns the heap mechanics, file `05` owns the
HNSW walk, file `01` owns the cost models that let you rank all of these on one
ruler. The through-line of the whole guide lands here: *the less of the input
you must fully order, the cheaper the answer* — and buffr, by using an index,
orders almost none of it.

---

## Interview defense

**Q: Find the k nearest vectors among a million. Walk your options.**

```
  sort + slice  O(n log n)  │ orders all 1M, slices k — wasteful
  size-k heap   O(n log k)  │ better, but still touches all 1M
  quickselect   O(n) avg    │ partition, recurse one side — but still O(n) floor
  HNSW index    O(log n)~   │ examines ~log(1M) ≈ 20 nodes — the answer at scale
```

Answer: the exact methods all have an O(n) floor — you must look at every
vector at least once. At a million vectors per query that's too slow, so you
pre-build an HNSW index and accept approximate results: O(log n), ~20 node
visits instead of a million distance computations. That's buffr's path.

Anchor: *"Exact selection has an O(n) floor; the only way under it is to index
ahead of time and approximate — which is exactly what `order by <=> limit k`
over HNSW does."*

**Q: Difference between quicksort and quickselect?**

```
  quicksort:    partition → recurse on BOTH sides   → O(n log n), full order
  quickselect:  partition → recurse on ONE side     → O(n) avg, k-th element
                          (the side holding the k-th)
```

Answer: same partition step; quicksort recurses on both halves to fully sort,
quickselect recurses on only the half containing the target, discarding the
other — turning O(n log n) into O(n) average. The part people miss: worst case
is O(n²) on adversarial pivots, fixed with randomized pivot selection, same as
quicksort.

Anchor: *"Quickselect is quicksort that only chases the side it needs — that
single dropped recursion is the whole speedup."*

---

## See also

- `01-complexity-and-cost-models.md` — the ruler that ranks these costs.
- `03-stacks-queues-deques-and-heaps.md` — the size-k heap, the streaming
  selection method.
- `04-trees-tries-and-balanced-indexes.md` — where binary search actually
  lives in buffr (the B-tree index walk).
- `05-graphs-and-traversals.md` — the HNSW walk that makes exact selection
  unnecessary at scale.
