# Stacks, Queues, Deques, and Heaps

**Ordering disciplines / priority queues / binary heaps** — *Industry standard*

## Zoom out, then zoom in

This is the file where the gap is the lesson. The repo's top-k selection is
*screaming* for a heap — and it uses `sort().slice()` instead. You've built the
heap. Here's where it would slot in.

```
  Zoom out — ordering disciplines, where they'd live

  ┌─ buffr / aptkit retrieval layer ─────────────────────┐
  │  in-memory store: hits.sort().slice(0,k)             │
  │                   ★ should be a size-k HEAP ★         │ ← we are here
  │                     (your BinaryHeap.ts / PriorityQ)  │
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ pgvector layer ──────────▼──────────────────────────┐
  │  order by <=> limit k  → HNSW keeps a candidate set,  │ ← a heap-like
  │                          effectively a bounded queue   │   frontier
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ runtime layer (async) ───▼──────────────────────────┐
  │  trace sink: pending[] promises → Promise.all (FIFO)  │ ← a plain queue
  │  the JS call stack itself = a STACK (recursion below) │
  └───────────────────────────────────────────────────────┘
```

Zoom in: a **stack** is LIFO (last in, first out) — the call stack, undo. A
**queue** is FIFO (first in, first out) — a task buffer. A **deque** allows both
ends. A **heap** is a partially-ordered tree giving `O(1)` peek at the min/max
and `O(log n)` insert/extract — the engine behind a **priority queue**. The
question this file answers: *where does ordering discipline show up in buffr, and
where should a heap be doing work that a sort is doing instead?*

## The structure pass

Trace **one axis — "what order do elements come out?" — across the disciplines.**

```
  Axis = "given the elements, which one comes out next?"

  ┌─ JS call stack (recursion) ────────────┐
  │ last-pushed frame returns first  (LIFO) │  STACK
  └──────────────────────┬──────────────────┘
                         │  seam: order discipline flips
  ┌─ trace sink pending[] ▼────────────────┐
  │ Promise.all — order-agnostic, all drain │  QUEUE-ish (no priority)
  └──────────────────────┬──────────────────┘
                         │  seam: insertion-order vs value-order
  ┌─ top-k selection ─────▼────────────────┐
  │ HIGHEST score comes out next  (priority)│  HEAP — but repo uses SORT
  └──────────────────────────────────────────┘
```

The load-bearing **seam**: between the trace sink's queue (order comes from
*insertion* — FIFO) and top-k (order comes from *value* — highest score wins).
The moment the question becomes "give me the extreme element repeatedly," you've
left queue territory and entered heap territory. The repo crosses that seam in
`search()` but answers it with a full sort instead of a heap — that's the
finding.

## How it works

### Move 1 — the mental model

You built this. `PriorityQueue.ts` in reincodes, heap-backed, with
`updatePriority` and a value→index lookup, feeding your Dijkstra animation. A
heap is a binary tree flattened into an array where every parent is smaller
(min-heap) or larger (max-heap) than its children — so the extreme is always at
index 0.

```
  The heap kernel — a min-heap as an array-backed tree

  array:  [3, 5, 8, 9, 7]        tree view:        3        ← min at root
  index:   0  1  2  3  4                          ╱ ╲
  parent(i) = (i-1)/2                            5   8
  child(i)  = 2i+1, 2i+2                        ╱ ╲
                                               9   7
  peek min   = arr[0]        O(1)
  insert     = push + heapifyUp(arr.length-1) O(log n)
  extractMin = swap[0,last], pop, heapifyDown(0) O(log n)
```

The single sentence: **a heap keeps just enough order to hand you the extreme in
`O(1)` and re-establish it in `O(log n)` — never the full order a sort pays
for.** That "just enough order" is the entire reason it beats sorting for top-k.

### Move 2 — the disciplines and where they sit

**The stack — recursion's backbone, present implicitly.**
Every recursive call in the system (and there's recursion in the chunker's
caller, the agent loop, JSON serialization) rides the JS call stack — LIFO. The
last frame pushed is the first to return. Bridge: it's the structure your
reincodes `Tree.ts` traversals and call-stack visualizers make visible. Where it
breaks: unbounded recursion overflows the stack — which is why the agent loop in
the library has a hard iteration budget, not open recursion.

```
  Stack — LIFO call frames

  push answer()  ┐
  push tool()    ┤  ← top, runs/returns first
  push search()  ┘
  ───────────────
  search returns → tool returns → answer returns   (LIFO unwind)
```

**The queue — the trace sink's pending writes.**
`SupabaseTraceSink` collects DB-write promises into a `pending[]` array as
events arrive, then drains them all with `Promise.all` in `flush()`. Bridge:
it's a buffer — events go in as the agent runs, writes come out together at the
end. It's FIFO-ish but order-agnostic (all writes resolve, order doesn't
matter). Where it breaks: if you awaited each write inline instead of queuing,
you'd serialize the agent on the database — the queue decouples "produce the
event" from "persist it."

```
  Queue — buffer events, drain at flush

  emit(step)      → pending.push(write1)  ┐
  emit(tool_call) → pending.push(write2)  ┤  buffer fills during run
  emit(step)      → pending.push(write3)  ┘
  flush() → Promise.all([w1,w2,w3])          drain together at the end
```

**The heap — the structure top-k *wants* and doesn't get.**
Here's the gap. `search()` needs the k highest-scoring chunks out of n. The
discipline that fits is a **bounded min-heap of size k**: scan all n, and for
each score, if the heap has fewer than k push it, else if the new score beats the
heap's minimum, replace the min. At the end the heap holds the top k. Bridge: it's
exactly your `PriorityQueue.ts` with a size cap. Where it breaks (and why it
matters): the repo skips the heap and sorts all n instead — correct, but it pays
`O(n log n)` to produce a total order when `O(n log k)` would do.

```
  Bounded min-heap for top-k — the discipline the repo skips

  k = 3, min-heap holds the 3 best SO FAR (min = weakest survivor)

  score 0.9 → heap [0.9]
  score 0.7 → heap [0.7, 0.9]
  score 0.8 → heap [0.7, 0.8, 0.9]   ← full, min = 0.7
  score 0.6 → 0.6 < min(0.7)? yes → DISCARD, no insert  O(1) reject
  score 0.95→ 0.95 > min(0.7)? yes → extractMin, insert  O(log k)
              heap [0.8, 0.95, 0.9]
  ──────────────────────────────────────────────────────────
  total: O(n log k)   vs   sort+slice's O(n log n)
```

#### Move 2 variant — the heap skeleton, named by what breaks

1. **Isolate the kernel.** Array-backed tree + `heapifyUp` (after insert) +
   `heapifyDown` (after extract) + the parent/child index math
   (`(i-1)/2`, `2i+1`). That's the whole thing — it's your `BinaryHeap.ts`.
2. **Name each part by what breaks without it.**
   - Drop `heapifyDown` after extract and the root is wrong — `peek` returns a
     non-extreme element, ranking corrupts silently.
   - Drop the size cap (for top-k) and it's just a full heap-sort — you're back
     to `O(n log n)`, no savings.
   - Drop the value→index lookup (your `updatePriority` feature) and you can't
     decrease-key in `O(log n)` — Dijkstra degrades. (Not needed for top-k, but
     it's why your PQ is more than a plain heap.)
3. **Skeleton vs hardening.** The heapify + index math is the skeleton. The
   `updatePriority` / decrease-key is hardening you added for Dijkstra; top-k
   doesn't need it.

### Move 3 — the principle

**Reach for the discipline whose ordering matches the question.** Insertion
order → queue/stack. "Give me the extreme, repeatedly" → heap. The repo gets the
queue right (trace sink) and the stack for free (recursion), but answers a heap
question with a sort. The lesson isn't that the sort is wrong — it's that
recognizing the heap-shaped question is the signal you built the structure.

## Primary diagram

Every ordering discipline in the system, with the one that's missing marked.

```
  Ordering disciplines across the system — recap

  STACK   call frames (recursion)         LIFO    implicit, free
  QUEUE   trace sink pending[] → flush()  FIFO    present, correct
  HEAP    top-k selection                 priority MISSING — uses sort()
            └─ your BinaryHeap.ts / PriorityQueue.ts would slot here
  DEQUE   (not exercised anywhere)        both     not yet exercised
```

## Implementation in codebase

**Use cases.** The queue discipline is reached for in trace persistence — the
agent emits events synchronously (aptkit's contract is a sync `emit`), but DB
writes are async, so they're buffered and drained. The heap *would* be reached
for in `search()` top-k but isn't.

```
  src/supabase-trace-sink.ts  (lines 23–39) — the queue

  private readonly pending: Promise<void>[] = [];   ← the buffer (queue)

  emit(event: CapabilityEvent): void {              ← sync, per aptkit contract
    if (event.type === 'step' && ...) {
      this.pending.push(persistMessage(...));        ← enqueue a write promise
    } else if (event.type === 'tool_call_end') {
      this.pending.push(persistMessage(...));        ← enqueue, don't await
    }
       │
       └─ emit can't be async (contract), so it queues. Awaiting here would
          block the agent loop on the DB every step (load-bearing decouple)
  }

  async flush(): Promise<void> {
    await Promise.all(this.pending);                 ← drain the whole queue
  }
```

The heap-shaped question, answered by a sort (the library in-memory store):

```
  @aptkit/retrieval in-memory-vector-store.js (search) — heap question, sort answer

  for (const chunk of this.chunks.values())
    hits.push({ ... cosineSimilarity(...) });   ← score all n
  hits.sort((a, b) => b.score - a.score);       ← O(n log n): FULL order
  return hits.slice(0, Math.max(0, k));         ← throw away n-k of it
       │
       └─ this is the seam from the structure pass: "give me the top k by
          score" is a heap question. A size-k min-heap is O(n log k). The
          sort is the right *default* (simple, n is tiny here) but the
          heap is the right *answer at scale* — and you've built it.
```

## Elaborate

The binary heap is Williams' 1964 invention (for heapsort). Its genius is the
implicit tree: no pointers, just index arithmetic on a flat array — which is why
it's cache-friendly and why your `BinaryHeap.ts` is array-backed. The priority
queue is the *interface* (insert / extract-extreme); the heap is the usual
*implementation*. Dijkstra, A*, Huffman coding, event simulation, and top-k all
sit on this one structure — you've used it for the first.

What's `not yet exercised`: a **deque** (double-ended queue) appears nowhere —
no sliding-window-maximum, no work-stealing. A **monotonic stack/queue** (the
"next greater element" trick) is also absent here and in your portfolio — a
worthwhile drill, since it's a common interview shape.

## Interview defense

**Q: The retrieval store sorts all n chunks to return the top k. Critique it.**

```
  sort+slice vs bounded heap for top-k

  sort all n  ─► O(n log n) ─► slice k   (repo's choice)
  size-k heap ─► O(n log k)              (your BinaryHeap.ts)
                     ▲
                     └─ for k=4, n large: effectively O(n)
```

Answer: "It's correct but does extra work — `O(n log n)` to fully order n when I
only need the top k. A bounded min-heap of size k gets it to `O(n log k)`; for
k=4 that's basically linear. I've built that heap from scratch — it's the
`BinaryHeap` backing my `PriorityQueue`, the one I used for Dijkstra. For this
repo's three-doc corpus the sort is the right *simple* call; at corpus scale I'd
swap in the heap." Anchor: the library's `hits.sort().slice()`.

**Q: Why does the trace sink buffer writes instead of awaiting them in `emit`?**

Answer: "Because `emit` is synchronous by contract — aptkit calls it inline in
the agent loop. Awaiting a DB write there would serialize the agent on Postgres
every step. So it queues promises and drains them with `Promise.all` in `flush`
after the run. It's a producer/consumer queue decoupling event production from
persistence." Anchor: `src/supabase-trace-sink.ts:24,37`.

## Validate

1. **Reconstruct.** Write the three heap operations and their costs from memory
   (peek `O(1)`, insert `O(log n)`, extract `O(log n)`), and the parent/child
   index math.
2. **Explain.** Why is the trace sink's `pending[]` a queue and not a heap?
   (Insertion order, no priority — `src/supabase-trace-sink.ts:24`.)
3. **Apply.** Rewrite the in-memory `search` to use a size-k min-heap. What's the
   new complexity, and which of your reincodes files would you copy the heap
   from? (`O(n log k)`; `BinaryHeap.ts`.)
4. **Defend.** Someone says "the sort is fine, don't add a heap." When are they
   right, and when wrong? (Right at tiny n; wrong once n·log n dominates the
   query budget.)

## See also

- `01-complexity-and-cost-models.md` — the `O(n log n)` vs `O(n log k)` math.
- `06-sorting-searching-and-selection.md` — the deeper selection-vs-sorting story.
- `05-graphs-and-traversals.md` — HNSW's candidate set, a bounded priority queue
  in disguise.
- `study-runtime-systems` → the event loop the trace sink's `Promise.all` drains
  on.
