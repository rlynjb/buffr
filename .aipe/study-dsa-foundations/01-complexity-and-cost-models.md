# Complexity and Cost Models

**Big-O / asymptotic analysis / amortized analysis** — *Industry standard*

## Zoom out, then zoom in

Before any structure, you need the ruler you measure them with. Every choice in
this repo — `sort().slice()` vs a heap, a `Map` vs an array scan, HNSW vs brute
force — is a bet on a cost model. Here's where that ruler sits.

```
  Zoom out — the cost model is the lens over every layer

  ┌─ Application layer (buffr) ──────────────────────────┐
  │  pipeline.query(q, k)   ← you pick k; cost rides on  │
  │                            what the store does below │
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ Algorithm layer (aptkit) ▼──────────────────────────┐
  │  ★ COST MODEL ★  in-mem: O(n·d) scan + O(n log n) sort│ ← we are here
  │                  the number you optimize against      │
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ Storage layer (pgvector) ▼──────────────────────────┐
  │  HNSW: ~O(log n · d) greedy walk — a different curve  │
  └───────────────────────────────────────────────────────┘
```

Zoom in: complexity analysis is the practice of describing how an algorithm's
work grows as its input grows, dropping constants and lower-order terms so you
can compare two approaches without running them. The question it answers: *when
the corpus goes from 100 chunks to 100,000, what happens to a query?* For this
repo that question has two different answers depending on which store is wired
in — and that contrast is the whole lesson.

## The structure pass

Trace **one axis — cost per query as the corpus grows — down the layers.**

```
  Axis = "what does one query cost as n (chunk count) grows?"

  ┌─ buffr CLI ─────────────────────────┐
  │ pipeline.query(q, k)                 │  → O(1) in your code; you
  └──────────────────┬───────────────────┘    just pass k through
                     │  seam: contract flips here
  ┌─ in-memory store ▼──────────────────┐
  │ score all n, sort all n, slice k     │  → O(n·d + n log n)
  └──────────────────┬───────────────────┘    LINEAR+ in n
                     │  seam: same VectorStore contract,
                     │        radically different cost
  ┌─ pgvector + HNSW ▼──────────────────┐
  │ greedy graph walk, limit k           │  → ~O(log n · d)
  └──────────────────────────────────────┘    SUBLINEAR in n
```

The load-bearing **seam** is the `VectorStore` interface. Both stores satisfy
the *same* contract — `search(vector, k) → Hit[]` — but their cost curves are
different shapes. The axis (cost vs n) flips hard across that boundary: above
it, identical; below it, linear vs logarithmic. That's why this seam is worth
studying before any mechanism — the contract hides a 1000x difference at scale.

## How it works

### Move 1 — the mental model

You already do this every day in the frontend: when you `.map()` over a list to
render rows, you know that doubling the rows doubles the render work — that's
`O(n)`, and you feel it when a list hits 10,000 items and the page janks.
Complexity analysis is just that instinct made precise and applied to every
operation, not only renders.

```
  The shape of the common curves

  cost
   ▲
   │                                   O(n²)  ← nested loops
   │                              ╱
   │                         ╱
   │                    ╱  O(n log n) ← sort
   │              ╱──────────────── O(n)      ← scan / .map()
   │         ╱
   │    ╱────────────────────────── O(log n)  ← HNSW, binary search
   │ ╱──────────────────────────────O(1)      ← Map.get, Set.has
   └─────────────────────────────────────────► n (input size)
```

The single sentence: **complexity describes the curve, not the point.** Two
algorithms can both take 2ms at n=100; the one that's `O(n²)` is a time bomb at
n=10,000 and the `O(log n)` one isn't. You pick the curve, not the benchmark.

### Move 2 — the cost models that matter here

**Time complexity — counting operations as a function of input.**
Bridge from what you know: it's the same accounting you do when you decide
whether to memoize a `useMemo` — "how many times does this run, and how big is
each run." For the in-memory store, one query is: a loop over `n` chunks, each
doing `d` multiply-adds for cosine (where `d = 768`), then a sort of `n`
scores. That's `O(n·d)` to score plus `O(n log n)` to sort. The `d` is a
constant here (768 always), so it collapses to `O(n log n)` dominated by the
sort. Where it breaks: people drop the `d` too early and forget that 768-dim
math is the actual per-chunk cost — at small n, the cosine loop dominates, not
the sort.

```
  Execution trace — in-memory query, n=4 chunks, d=768

  step          work done                         running cost
  ──────────────────────────────────────────────────────────────
  score c0      768 mul-add + 1 sqrt-divide        ~768 ops
  score c1      768 mul-add                         ~1536 ops
  score c2      768 mul-add                         ~2304 ops
  score c3      768 mul-add                         ~3072 ops   ← O(n·d)
  sort [4]      compare-swap ~ n log n              + ~8 ops    ← O(n log n)
  slice(0,k)    copy first k                        + k ops     ← O(k)
  ─────────────────────────────────────────────────────────────
  total dominated by n·d at small n, n log n at large n
```

**Space complexity — memory as a function of input.**
Same idea, different resource. The in-memory store holds every chunk's full
768-float vector in a `Map` — that's `O(n·d)` memory, resident in the Node
heap, for as long as the process lives. The pgvector store holds *zero* vectors
in your process; they live on disk in Postgres and stream in per query. Where
it breaks: the in-memory store is fine for the eval corpus (three tiny docs)
and would OOM your laptop on a real corpus — the space curve is why
`PgVectorStore` exists at all.

**Amortized analysis — the occasional expensive step, averaged.**
This is the one this repo uses without ever naming. Every time the in-memory
`Map` grows past its capacity, it rehashes — an `O(n)` operation. But it only
happens on log-many inserts, so averaged over all inserts, each `Map.set` is
`O(1)` *amortized*. Same story for the dynamic array (`hits.push`) in the
search loop. Bridge from what you know: it's the same reason `Array.push` is
"basically free" even though it occasionally reallocates the backing buffer.
Where it breaks: amortized `O(1)` is an *average*; a single insert that
triggers a resize is genuinely `O(n)`, which matters if you have a latency
budget on a single call (you don't here, but you would in your `contrl`
frame-rate hot path).

### Move 3 — the principle

**The cost model is a choice, not a fact.** "Fast" is meaningless without
naming the resource (time? space?), the input dimension (n chunks? d
dimensions?), and the regime (small corpus? large?). The reason buffr ships two
stores behind one interface is that the *right* cost model changes with the
corpus size — and the interface lets you swap the curve without touching the
caller.

## Primary diagram

The full picture: one `VectorStore` contract, two cost curves underneath it.

```
  One contract, two cost curves — the whole tradeoff in one frame

  ┌─ caller: pipeline.query(q, k) ──────────────────┐
  │  O(1) — just embeds the query, passes k down     │
  └───────────────────────┬──────────────────────────┘
                          │  VectorStore.search(vec, k)   ← the seam
          ┌───────────────┴───────────────┐
          ▼                               ▼
  ┌─ InMemoryVectorStore ─┐      ┌─ PgVectorStore + HNSW ─┐
  │ TIME:  O(n·d + n log n)│      │ TIME:  ~O(log n · d)    │
  │ SPACE: O(n·d) in heap  │      │ SPACE: O(1) in process  │
  │ regime: tiny corpus    │      │ regime: real corpus     │
  └────────────────────────┘      └─────────────────────────┘
        linear+, in-process            sublinear, on-disk
```

## Implementation in codebase

**Use cases.** You reach for the cost model whenever you decide *which store to
wire*. The eval CLI (`src/cli/eval-cmd.ts`) and ask CLI (`src/cli/ask-cmd.ts`)
both wire `PgVectorStore` — the sublinear, on-disk curve — because the whole
point of buffr is graduating off the in-memory store. The library's
`InMemoryVectorStore` is the "zero-cloud, tiny-corpus" curve you'd use in a unit
test.

```
  src/pg-vector-store.ts  (lines 67–78) — the O(log n) path

  async search(vector: number[], k: number): Promise<Hit[]> {
    this.assertDim(vector);                    ← O(d) dimension check, d=768
    const { rows } = await this.pool.query(
      `select id, content, ...,
              1 - (embedding <=> $1::vector) as score
       from agents.chunks
       where app_id = $2
       order by embedding <=> $1::vector       ← HNSW makes this ~O(log n),
       limit $3`,                              ←   NOT a full O(n log n) sort
      [toVectorLiteral(vector), this.appId, k],
    );
       │
       └─ the cost lives in `order by <=> ... limit` — Postgres uses the
          HNSW index to avoid scoring every row. Drop the index and this
          same SQL becomes an O(n·d) sequential scan + sort. The cost
          model is set by the index, not by this query text (load-bearing).
  }
```

Contrast with the library's in-memory path — the explicit `O(n log n)`:

```
  @aptkit/retrieval in-memory-vector-store.js (search) — the O(n log n) path

  for (const chunk of this.chunks.values())   ← O(n) scan, every chunk
    hits.push({ ... cosineSimilarity(...) }); ← O(d) per chunk → O(n·d)
  hits.sort((a, b) => b.score - a.score);     ← O(n log n) — sorts ALL n
  return hits.slice(0, Math.max(0, k));       ← O(k) — keeps only k
       │
       └─ it sorts all n just to keep k. That wasted work is exactly what
          a heap (your BinaryHeap.ts) or HNSW removes — see file 06.
```

## Elaborate

Big-O notation comes from Bachmann and Landau (1890s number theory), adopted by
Knuth in the 1970s as the standard for algorithm analysis. The reason it drops
constants is deliberate: constants depend on the machine and the language
(a Node `Array.sort` and a C `qsort` have different constants but the same
`O(n log n)` curve), so dropping them gives you a machine-independent comparison.

The adjacent concept to read next is **selection** (`06`): the reason
`sort().slice()` is wasteful is that it solves a harder problem (total order)
than the one you have (top-k). Complexity analysis is what lets you *see* that
waste — `O(n log n)` to sort vs `O(n log k)` to select is the gap. And it
connects straight to your portfolio: you built `BinaryHeap.ts` precisely so you
could do `O(n log k)` partial selection instead of full sorts in your Dijkstra
animation.

## Interview defense

**Q: The in-memory store sorts all n chunks to return k. What's the
complexity, and what would you change?**

```
  scoring + sorting all n to keep k

  [score n]  O(n·d)      every chunk gets a cosine
  [sort  n]  O(n log n)  ← the waste: total order when you need top-k
  [slice k]  O(k)
  ─────────────────────────────────────────────
  swap sort+slice → a size-k min-heap → O(n log k)
```

Answer: "It's `O(n·d)` to score plus `O(n log n)` to sort, dominated by the
sort at scale. The waste is that a full sort produces a total order when I only
need the top k. A size-k min-heap gets it to `O(n log k)` — for k=4 over a large
n that's effectively `O(n)`. I've built that heap from scratch; it's the same
`BinaryHeap` I used to back Dijkstra's priority queue." Anchor:
`@aptkit/retrieval in-memory-vector-store.js`, the `hits.sort().slice()` line.

**Q: Why does buffr have two vector stores if they satisfy the same interface?**

Answer: "Because the interface hides two different cost curves. The in-memory
store is `O(n·d)` time and `O(n·d)` space resident in the Node heap — fine for
a three-doc test, OOM on a real corpus. `PgVectorStore` is `O(1)` process
memory and `~O(log n)` query time via HNSW. Same contract, different regime.
The interface is what lets the caller not care." Anchor:
`src/pg-vector-store.ts:67` vs the library in-memory store.

## Validate

1. **Reconstruct.** Without looking, write the time complexity of one in-memory
   `search()` call in terms of n and d. (Answer: `O(n·d + n log n)`.)
2. **Explain.** Why does dropping `d` from `O(n·d)` lose information here, even
   though `d` is a constant? (It's the per-chunk cost; at small n it dominates.)
3. **Apply.** The corpus grows from 3 docs to 50,000. Walk what happens to a
   query under each store (`src/pg-vector-store.ts:67` vs the library's
   in-memory `search`). Which one's curve breaks first?
4. **Defend.** Someone says "just always use the in-memory store, it's simpler."
   Argue the cost model that makes that wrong at scale, naming the space curve.

## See also

- `02-arrays-strings-and-hash-maps.md` — the `Map`/`Set` whose amortized `O(1)`
  this file leans on.
- `03-stacks-queues-deques-and-heaps.md` — the heap that fixes the `O(n log n)`
  sort.
- `06-sorting-searching-and-selection.md` — selection vs sorting, the core waste.
- `study-database-systems` → how Postgres plans `order by ... limit` and chooses
  the HNSW index over a sequential scan.
