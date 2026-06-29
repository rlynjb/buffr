# Stacks, Queues, Deques, and Heaps

**Industry names:** LIFO stack · FIFO queue · double-ended queue · binary heap ·
priority queue · partial sort. **Type:** Language-agnostic.

---

## Zoom out, then zoom in

Here's the honest verdict up front: buffr **does not** instantiate a stack,
queue, deque, or heap anywhere in its own source. What this file teaches is the
structure the repo *should reach for but doesn't* — the **size-k heap** for
top-k selection — and connects it to the `BinaryHeap.ts` and `PriorityQueue.ts`
you already built from scratch in reincodes. This is a "you've built the harder
version; here's where it slots into retrieval" file.

```
  Zoom out — where a heap WOULD live (but doesn't, yet)

  ┌─ buffr TS / aptkit retrieval ─────────────────────────────┐
  │  in-memory store: score all N → sort+slice → top k         │
  │                              ▲                              │
  │              ★ a size-k heap belongs HERE ★                │ ← we are here
  │              (keep only the best k, skip the full sort)     │
  └──────────────────────────┬─────────────────────────────────┘
                             │  pgvector replaces both with
  ┌─ pgvector layer ─────────▼─────────────────────────────────┐
  │  HNSW: order by <=> limit k   (heap-like select, in C)      │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: a **heap** is a tree that keeps the min (or max) at the root in O(log
n) per insert/extract — it gives you "the best so far" cheaply without keeping
everything sorted. A **priority queue** is the heap with an API
(`enqueue`/`dequeue`). The top-k problem — "give me the 3 highest-scoring chunks
out of N" — is *exactly* what a size-k heap is for, and it's the bridge between
your Dijkstra build and this repo's retrieval.

---

## The structure pass

**Layers** — ordering disciplines, top to bottom by how much order they keep:

```
  ordering disciplines — how much order each keeps

  ┌─ fully sorted array ──────────────────┐  all N in order   O(n log n)
  └───────────────────┬────────────────────┘
       ┌──────────────▼───────────────────┐
       │ size-k heap (partial sort)        │  best k in order  O(n log k)
       └──────────────┬────────────────────┘
            ┌──────────▼──────────────────┐
            │ queue / stack                │  one end ordered  O(1) per op
            └───────────────────────────────┘
```

**Axis — control (who comes out next?).** Trace it: a **stack** returns the
*most recent* (LIFO), a **queue** the *oldest* (FIFO), a **heap** the
*best-priority* regardless of arrival. Same "give me the next one" call, three
different answers — that's the axis that distinguishes them.

**Seam — the partial-sort boundary.** Between "sort everything then take k"
(O(n log n)) and "maintain a heap of just the k best" (O(n log k)) is the seam
where top-k selection lives. When `k ≪ n` the heap wins big. buffr's in-memory
store sits on the *wrong* side of this seam (it sorts everything); pgvector's
HNSW sits on a smarter version (it doesn't even visit all n).

---

## How it works

### Move 1 — the mental model

You built this exact machine. `PriorityQueue.ts` backed by `BinaryHeap.ts`,
with `updatePriority` and a value→index lookup, driving your Dijkstra animation
— that *is* the structure this file is about. A heap is a partially-ordered tree:
not fully sorted, just enough order that the root is always the extreme.

```
  min-heap shape — root is the smallest, that's the only promise

           [2]            ← root: the min, O(1) to peek
          /   \
        [5]   [8]         ← children ≥ parent (heap property)
        / \   /
     [9][7][10]

  insert  → place at end, heapifyUp  (bubble until parent ≤ you)   O(log n)
  extract → take root, move last to root, heapifyDown             O(log n)
```

For top-k you invert the instinct: use a **min-heap of size k** to track the *k
largest*. The root is the smallest of your current best-k — the bouncer at the
door. A new score beats the root → evict root, insert newcomer. Never beats it →
discard. That's the whole trick.

### Move 2 — the size-k heap for top-k (the structure buffr doesn't use)

**Step 1 — why top-k is a heap problem.** Retrieval asks for the `k=3` best
chunks out of `N`. The naive answer (what the in-memory store does) is sort all
N by score, take 3 — O(N log N). But you're throwing away the sort of N−3
elements you didn't need. A size-k min-heap gets the same answer in O(N log k).

```
  size-k min-heap selecting top-3 from a stream of scores

  k=3, scores arriving: 0.9, 0.4, 0.7, 0.8, 0.2, 0.95

  heap (min at root, holds best-3 so far):
   after 0.9,0.4,0.7 →  [0.4]            ← full, root=0.4 is the weakest kept
                        /    \
                     [0.9]  [0.7]
   0.8 > root(0.4)   →  evict 0.4, insert 0.8 → root becomes 0.7
   0.2 < root(0.7)   →  discard 0.2, heap untouched         ← the cheap path
   0.95 > root(0.7)  →  evict 0.7, insert 0.95 → root 0.8
   final heap = {0.8, 0.9, 0.95}  ── the top 3, never sorted all N
```

**Step 2 — name each part by what breaks without it.** This is the
load-bearing skeleton — the thing to reconstruct from memory:

```
  size-k heap top-k — the kernel

  ┌ a min-heap capped at size k        ── drop the cap → it's just a full sort
  ┌ peek root = weakest of the kept k  ── lose this → can't decide who to evict
  ┌ compare-then-evict on overflow     ── drop the compare → keep wrong k
  └ discard when score ≤ root          ── lose this → O(n log n), no savings
```

Drop the size cap and you've reinvented heapsort (sort everything). Drop the
"discard when ≤ root" shortcut and every element pays a log-k insert even when
it can't make the cut — you lose the whole point. The compare-against-root *is*
the optimization.

**Step 3 — where it maps to your code.** You have all the parts. Your
`BinaryHeap.ts` `getMin`/`insert`/`heapifyDown` is the engine; `PriorityQueue.ts`
`dequeue` is the extract. The only new wiring is the size cap and the
compare-against-root guard. The aptkit in-memory store *doesn't* do this — it
takes the simpler full-sort road:

```ts
// in-memory-vector-store.ts:27-32 — full sort, NOT a size-k heap
const hits: VectorHit[] = [];
for (const chunk of this.chunks.values()) {           // O(N): touch every chunk
  hits.push({ id: chunk.id, score: cosineSimilarity(vector, chunk.vector), meta: chunk.meta });
}
hits.sort((a, b) => b.score - a.score);                // O(N log N): sort ALL
return hits.slice(0, Math.max(0, k));                  // take k — discards N-k sorted
```

The annotation: line 31 sorts all N even though only `k` survive line 32. For a
demo corpus that's fine (correct, dead simple, k tiny). At scale it's the
textbook spot to swap in a size-k heap — and the even-better answer is what
pgvector already does (file 05): don't visit all N at all.

### Move 2.5 — current vs future state

```
  Phase A (now): in-memory baseline    Phase B (prod): pgvector
  ──────────────────────────────       ────────────────────────
  sort+slice, O(N log N)               HNSW graph walk, ~O(log N)
  visits every chunk                   visits a fraction
  no heap, no k-cap                    Postgres' own top-k select (C)
  in-memory-vector-store.ts:27-32      pg-vector-store.ts:74-77
```

The size-k heap is the *middle* rung neither side actually uses: the in-memory
store is below it (full sort), pgvector is above it (skips chunks entirely). The
heap is what you'd reach for if you had all N scores in memory and `k ≪ N` — a
re-ranking pass over candidates, for instance. **Not yet exercised** in buffr,
but you've built every part.

### Move 3 — the principle

When you need the best k of n and `k ≪ n`, don't sort all n — maintain a size-k
heap and let most elements lose to the root cheaply. The repo skips this rung
twice (too-simple below it, smarter above it), but it's the canonical
partial-sort tool and you already own the implementation.

---

## Primary diagram

Stacks/queues/heaps placed against the top-k problem.

```
  the ordering toolbox vs the top-k job

  STACK (LIFO)   ──  call stacks, DFS, undo        ── not in buffr
  QUEUE (FIFO)   ──  BFS frontier, task queues     ── not in buffr
  DEQUE          ──  sliding windows               ── not in buffr
  ─────────────────────────────────────────────────────────────
  HEAP / PQ      ──  TOP-K SELECTION  ★             ── the relevant one
   │  reincodes: BinaryHeap.ts + PriorityQueue.ts (you built this)
   │  buffr in-memory: full sort instead (in-memory-vector-store.ts:31)
   └  buffr prod: HNSW does better than a heap (pg-vector-store.ts:74)
```

---

## Elaborate

The heap was invented for heapsort (Williams, 1964) and immediately turned out
to be the right structure for any "best-so-far" problem: priority queues,
Dijkstra, Huffman coding, event simulation, and top-k. The size-k heap variant
is the everyday production tool — "top N trending", "k nearest", "highest k
scores" all use it. Its relationship to sorting is the key insight you already
have from heapsort: a heap *is* a sort you can stop early. Stacks and queues are
the simpler cousins — one-ended discipline, O(1) ops, the backbone of traversal
(file 05's BFS frontier is literally a queue). None are exercised in buffr's
flat source, which is exactly why this file leans on your reincodes builds for
the anchor.

---

## Interview defense

**Q: How would you change the in-memory store's top-k to scale, and what's the
complexity win?**

```
  now:  score N → sort N → take k     O(N log N), sorts N-k it discards
  heap: score N → push to size-k      O(N log k), most pushes lose to root
        min-heap, evict-on-overflow
  win:  log N → log k   (k=3, so log k ≈ const → effectively O(N))
```

Swap the full sort for a size-k min-heap: hold the k best, compare each new score
against the root, evict-or-discard. O(N log k) beats O(N log N) when k ≪ N. The
better answer for *this* repo is that pgvector already sidesteps it — HNSW
doesn't score all N, so you never need the heap in production. Naming both —
"heap if you must score all N, ANN if you can avoid it" — is the senior move.

**Q: Min-heap or max-heap for the k *largest*, and why does that trip people
up?**

```
  k LARGEST  →  MIN-heap of size k   (root = weakest kept = eviction candidate)
  k SMALLEST →  MAX-heap of size k   (root = largest kept = eviction candidate)
```

Counterintuitive: you use a *min*-heap to track the *largest* k, because you need
O(1) access to the weakest survivor — the one a newcomer must beat. That
inversion is the part people forget, and naming it signals you've built it, not
just read about it.

**Anchor:** "Top-k is a size-k heap — min-heap for the k largest, evict the root
when something beats it. I built the engine in PriorityQueue.ts."

---

## See also

- `06-sorting-searching-and-selection.md` — sort+slice (the road buffr takes)
  vs heap-select (the road it could)
- `05-graphs-and-traversals.md` — HNSW, the structure that beats the heap by not
  scoring all N; its frontier is a priority queue
- `01-complexity-and-cost-models.md` — the O(n log k) vs O(n log n) math
