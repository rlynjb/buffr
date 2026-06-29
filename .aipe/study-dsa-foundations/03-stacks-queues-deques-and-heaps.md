# Stacks, Queues, Deques & Heaps

**Industry name(s):** LIFO stack · FIFO queue · double-ended queue (deque) ·
binary heap / priority queue — *Industry standard*

The leading nouns: **heap** (a partially-ordered tree giving O(1) min/max),
**priority queue** (the heap-backed API), **stack** and **queue** (ordering
disciplines). buffr exercises **none of these directly** — which makes this
the file where your reincodes `BinaryHeap` and `PriorityQueue` are the
anchor, and the repo is the "where it *would* go."

---

## Zoom out — where ordered structures would live

Honest up front: buffr's own source contains no stack, no queue, no heap. But
the operation these structures are *for* — **keep the k best, cheaply** — is
exactly what buffr does every search. So the zoom-out marks where a heap
*would* sit, against where buffr currently puts that work instead.

```
  Zoom out — top-k: where a heap WOULD live vs where buffr does it

  ┌─ buffr source ─────────────────────────────────────────────┐
  │  search(vector, k)  → asks Postgres for top-k              │ ← we are here
  │  (no heap in buffr — the selection is pushed down)          │
  └───────────────────────────┬────────────────────────────────┘
                              │ delegates top-k to
  ┌─ Postgres + HNSW ─────────▼────────────────────────────────┐
  │  order by distance limit k  → executor keeps k best        │
  │  ★ a size-k heap is the textbook structure for THIS ★      │
  │     (Postgres uses its own top-N machinery)                │
  └───────────────────────────┬────────────────────────────────┘
                              │ aptkit's OTHER store does it in-process:
  ┌─ aptkit in-memory store ──▼────────────────────────────────┐
  │  sort + slice (O(n log n))  ── a size-k heap would be O(n log k)│
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is **"to keep the k smallest distances out of n, what's
the right structure?"** You already built the answer — a `BinaryHeap` /
`PriorityQueue` from scratch, used by your Dijkstra animation. This file
connects that build to the top-k selection buffr currently does *without* it.

---

## Structure pass — layers, axis, seams

**Axis: ordering discipline — who comes out next?** Each structure answers it
differently; the heap's answer (the *extreme* element, in O(1)) is the one
top-k needs.

```
  Axis: "what comes out next?" — across the ordered structures

  STACK (LIFO)   → the last thing you put in     (call stack, undo)
  QUEUE (FIFO)   → the first thing you put in     (BFS frontier)
  DEQUE          → either end, your choice
  HEAP           → the EXTREME (min or max), regardless of insert order
                   ▲
                   └─ this is the one top-k selection reaches for

  seam: heap vs sorted array
    sorted array: ALL elements ordered, O(n log n) to build
    heap:         only the extreme is cheap, O(n) to build, O(log n) per pop
    → if you only need the k extremes, the heap wins (you skip ordering the rest)
```

The load-bearing seam: a **heap** only promises the *extreme* element is
instantly available — it does *not* keep everything sorted. That weaker
promise is exactly why it's cheaper than a full sort, and exactly enough for
top-k. Holding only k elements turns the whole thing into O(n log k).

---

## How it works

### Move 1 — the mental model

You built this. A **binary heap** is the array-backed tree where every parent
beats its children (min-heap: parent ≤ children). The root is the extreme, so
`getMin` is O(1); `insert` and pop restore the property by swapping a node up
or down — your `heapifyUp` / `heapifyDown`.

```
  Min-heap — the shape you built in BinaryHeap.ts

         [2]              array: [2, 5, 3, 8, 6, 7]
        /   \             index:  0  1  2  3  4  5
      [5]   [3]           parent(i) = (i-1)/2
      / \   / \           child(i)  = 2i+1, 2i+2
    [8] [6][7]
                          root = min, always O(1) to read
    insert(1): place at end, heapifyUp ─► swaps toward root until parent ≤ child
    extractMin: pop root, move last to top, heapifyDown ─► O(log n)
```

One sentence: **a heap keeps the extreme element at the root in O(1) by
maintaining only a partial order — each parent beats its children, nothing
more.** A **priority queue** is this heap wearing an `enqueue`/`dequeue` API,
exactly your `PriorityQueue.ts` with its value→index lookup for
`updatePriority` (the part Dijkstra needs to decrease-key).

### Move 2 — the size-k heap, and where buffr skips it

**The top-k problem stated precisely.** Search must return the k chunks with
the smallest cosine distance out of n total. buffr asks Postgres
(`src/pg-vector-store.ts:74-77`):

```ts
order by embedding <=> $1::vector   // ← sort by distance ascending
limit $3                            // ← keep only k ($3 = k)
```

`order by ... limit k` is a top-k selection. buffr does **not** implement the
selection — it delegates to the query executor, which uses its own top-N
logic. aptkit's *in-memory* store (the other `VectorStore` impl) does it
in-process with **sort + slice**: sort all n, take the first k.

**Why a size-k heap beats sort+slice — the structure you'd reach for.** Here's
the structure buffr's library layer *doesn't* use but is the canonical answer,
walked as an execution trace. Keep a **max-heap of size k**; the root is the
*worst* of your current best-k, so any new element only needs to beat the
root:

```
  Size-k max-heap for top-k smallest — execution trace (k=2)

  goal: keep the 2 SMALLEST distances out of the stream
  use a MAX-heap of size 2 (root = largest of the kept ones)

  stream: 0.9   0.4        0.7              0.2          0.6
  ─────────────────────────────────────────────────────────────
  see 0.9 → heap [0.9]                       (not full, push)
  see 0.4 → heap [0.9, 0.4]                   (full; root=0.9)
  see 0.7 → 0.7 < root 0.9 → pop 0.9, push    heap [0.7, 0.4]
  see 0.2 → 0.2 < root 0.7 → pop 0.7, push    heap [0.4, 0.2]
  see 0.6 → 0.6 > root 0.4 → SKIP             heap [0.4, 0.2]
  ─────────────────────────────────────────────────────────────
  result: {0.2, 0.4}  ← the 2 smallest, in one O(n log k) pass
```

The cost contrast is the whole point:

```
  Top-k of n: three strategies, three costs

  sort + slice  │ O(n log n) │ sorts ALL n, even the n−k you throw away
                │            │  ← aptkit in-memory store does this
  size-k heap   │ O(n log k) │ each element: one O(log k) heap op, k ≪ n
                │            │  ← the structure NOT used here, the textbook answer
  HNSW (ANN)    │ O(log n)   │ doesn't even look at all n — approximate
                │            │  ← buffr's actual path, file 05
```

When k ≪ n — and it is, k=3 against a whole corpus — `O(n log k)` is a real win
over `O(n log n)`: you never pay to order the elements you'll discard.

**Why buffr correctly skips the heap anyway.** This is the honest read. buffr
doesn't hand-roll a size-k heap because it has something better: the HNSW
index never examines all n vectors at all (file `05`), so it's O(log n), below
even the heap's O(n log k). The heap is the right answer *when you must scan
all n in memory* — which is aptkit's in-memory store's situation, and even
*it* chose the simpler sort+slice because n is small there. So the size-k heap
is the structure that's correct-in-theory-here yet reached for by nobody — a
clean example of "the textbook answer isn't always the shipped answer, and you
should be able to say why."

**Stacks and queues — not yet exercised here, but you know where they go.**
buffr's source has no explicit stack or queue. The queue you'd recognise is
the **BFS frontier** inside the HNSW graph walk (file `05`) — same FIFO
frontier + visited set as your `Graph.ts` `bfs_traversal`, just running inside
the C extension. The stack you'd recognise is the **call stack** of any
recursion (file `07`). Both are present *conceptually* one layer down; neither
is buffr TypeScript.

### Move 3 — the principle

**Match the structure to the weakest guarantee you actually need.** Top-k
doesn't need everything sorted — it needs the k best — so a heap (partial
order) beats a sort (total order), and an index that skips most elements (ANN)
beats both. The discipline is to name the minimum guarantee the problem
requires, then pick the cheapest structure that provides exactly that. Reaching
for a full sort when you need top-k is paying for order you throw away.

---

## Primary diagram

The heap, the operation it serves, and where buffr puts that work instead.

```
  Top-k selection — the heap and buffr's alternatives (recap)

  THE OPERATION: keep k smallest distances out of n

  ┌─ size-k max-heap (the textbook structure) ─┐  reincodes: BinaryHeap.ts
  │  root = worst-of-best;  beat it or skip     │  PriorityQueue.ts
  │  O(n log k) — never orders the discarded     │  (your Dijkstra uses it)
  └─────────────────────────────────────────────┘
            buffr uses neither directly — instead:
  ┌─ aptkit in-memory store ─┐   ┌─ buffr → Postgres/HNSW ──────┐
  │ sort + slice  O(n log n) │   │ order by..limit k            │
  │ (simplest; n small)      │   │ HNSW walk ~O(log n) approx   │
  └──────────────────────────┘   │ pg-vector-store.ts:74-77     │
                                  └──────────────────────────────┘
```

---

## Elaborate

The binary heap (Williams, 1964, for heapsort) is the canonical "I only need
the extreme, repeatedly" structure — which is why it backs priority queues,
Dijkstra, event simulators, and top-k selection alike. Your reincodes
`PriorityQueue` with `updatePriority` is the decrease-key variant Dijkstra
needs; the size-k top-k heap is the *bounded* variant, where you cap the size
and evict the root.

Where this connects: file `06` (sorting/searching/selection) treats top-k as
*partial selection* and shows quickselect — the O(n) average alternative to a
heap when you have all n in an array at once. File `05` shows why buffr beats
both by not scanning all n. The thread through all three: **the less of the
input you must fully order, the cheaper the answer.**

---

## Interview defense

**Q: buffr's library store does `sort + slice` for top-k. When would you use
a heap instead, and when neither?**

```
  sort+slice  O(n log n)  │ fine when n is small (aptkit in-memory)
  size-k heap O(n log k)  │ wins when k ≪ n and you must scan all n
  ANN/HNSW    O(log n)    │ wins when you can pre-index and tolerate approx
                          │   ← buffr's actual choice
```

Answer: a size-k heap wins when k ≪ n because it never orders the n−k you
discard; but if you can build an index ahead of time and accept *approximate*
results, ANN beats the heap by not scanning all n at all — which is why buffr
uses HNSW, not a heap. The heap is the right in-memory exact answer; it's not
buffr's situation.

Anchor: *"Heap for exact top-k when you must scan everything; ANN when you can
index and approximate — buffr's in the second case."*

**Q: What breaks if you drop the size cap and let the heap grow?**

```
  unbounded heap → holds all n → O(n) space, O(n log n) work
  capped at k    → holds k     → O(k) space, O(n log k) work
                   ▲ the cap IS the optimization
```

Answer: the size cap is the whole point — capping at k is what turns
`log n` per op into `log k` and the space from O(n) to O(k). Drop the cap and
you've reinvented a slow heapsort. The load-bearing part people forget: it's a
*max*-heap when you want the k *smallest* (root = the worst keeper, the
eviction candidate).

Anchor: *"For k smallest, use a max-heap of size k — the root is who gets
evicted."*

---

## See also

- `02-arrays-strings-and-hash-maps.md` — the heap is an array under the hood;
  the Set is its O(1)-membership cousin.
- `05-graphs-and-traversals.md` — the BFS frontier (a queue) inside the HNSW
  walk; why ANN beats the heap.
- `06-sorting-searching-and-selection.md` — quickselect, the array-based
  partial-selection alternative to a heap.
- `07-recursion-backtracking-and-dynamic-programming.md` — the call stack as
  the implicit stack.
