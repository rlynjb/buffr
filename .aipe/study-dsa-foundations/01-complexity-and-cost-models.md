# Complexity and Cost Models

**Industry names:** asymptotic analysis · Big-O / Big-Θ · amortized analysis ·
the cost model. **Type:** Language-agnostic.

---

## Zoom out, then zoom in

Every other file in this guide is going to make a cost claim — "sort+slice is
O(n log n)", "the HNSW walk is roughly O(log n)", "Set lookup is O(1)". This
file is the lens those claims are read through. It sits *underneath* every data
structure, not beside them.

```
  Zoom out — where the cost lens lives

  ┌─ The structures (files 02–07) ───────────────────────────┐
  │  vectors   heaps   graphs   sorts   trees   DP            │
  └──────────────────────────┬────────────────────────────────┘
                             │  each one makes a cost claim
  ┌─ ★ THIS FILE: the cost model ★ ──▼────────────────────────┐
  │  how do we count work as input n grows?                    │ ← we are here
  │  time · space · amortized · which n actually matters       │
  └──────────────────────────┬────────────────────────────────┘
                             │  grounds
  ┌─ The repo's real numbers ─▼───────────────────────────────┐
  │  768-dim vectors · k=3 · corpus size N · HNSW over N rows  │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: complexity analysis answers one question — **as the input grows, how
fast does the work grow?** Not "how many milliseconds" (that's a benchmark);
"how does the millisecond count *scale* when the corpus goes from 100 chunks to
100,000". You already lived this: your sorting visualizers make the *shape* of
O(n²) vs O(n log n) literal — bubble sort's bars crawl while merge sort's
collapse fast. That visual is the cost model.

---

## The structure pass

**Layers** — three altitudes the cost lens reads across in this repo:

```
  one question held constant: "what grows with n?"

  ┌─ buffr TS layer ───────────────────────┐
  │  dedup k hits, score k hits             │  → grows with k (=3, tiny)
  └────────────────────┬────────────────────┘
       ┌───────────────▼──────────────────┐
       │ pgvector layer: HNSW search       │  → grows with N (corpus), but
       └───────────────┬───────────────────┘    sub-linearly (~log N)
            ┌──────────▼───────────────────┐
            │ exact baseline: in-memory     │  → grows linearly with N
            │ store sort+slice              │    (scan every chunk)
            └───────────────────────────────┘
```

**Axis — cost.** Trace "what's the dominant `n`?" down the stack and the answer
*flips*: at the top it's `k` (the number of hits, fixed at 3), at the bottom
it's `N` (the corpus size, unbounded). That flip is the whole reason HNSW
exists — see the seam.

**Seam — the index boundary.** Between "scan every chunk" (in-memory store,
O(N) per query) and "walk a graph index" (pgvector HNSW, ~O(log N) per query)
the cost contract flips from linear to logarithmic. The same `search(vector,
k)` signature, two cost models. That seam is where this repo's scalability
lives.

---

## How it works

### Move 1 — the mental model

Big-O is a **growth rate with the constants thrown away**. You don't care that
sort+slice does `3N` comparisons and the heap does `N + k log k`; you care that
one is "linear-ish" and the other is "linear plus a tiny term". The mental
model is a ladder — each rung grows faster than the one below as `n` climbs.

```
  the growth ladder — work vs input size n

  O(1)        ────────────────────  flat        Set.has(id)
  O(log n)    ──┐                    bends early  HNSW walk (approx)
  O(n)         ─┴──┐                 straight     scan every chunk
  O(n log n)      ─┴───┐             gentle curve sort+slice top-k
  O(n²)               ─┴────────┐    steep        bubble sort (reincodes)
  O(2ⁿ)                        ─┴──  cliff        naive recursion (file 07)

  read it as: at n=10 they're close; at n=10,000 they're worlds apart
```

The skill is reading *which rung* a piece of code sits on by looking at its
loops and recursion, not by timing it.

### Move 2 — the three things you actually count

**Time complexity — count the dominant operation as n grows.** Walk the loop
nesting: one loop over n is O(n); a loop inside a loop is O(n²); halving the
search space each step is O(log n). In `eval-cmd.ts:26` the dedup
`[...new Set(hits.map(...))]` is O(k) — it touches each of the `k` hits once.
Trivial, because `k=3`. But the *same* operation over the whole corpus would be
O(N), and that's the line you'd watch.

```
  reading loop nesting → cost  (the buffr eval loop)

  for each query in queries:            ── outer: Q queries
      pipeline.query(query, K)          ── one ANN search: ~O(log N)
      [...new Set(hits.map docId)]      ── O(k), k=3
      scorePrecisionAtK(...)            ── O(k)
  ────────────────────────────────────
  total ≈ Q · (log N + k)    ── Q and k tiny; the log N term is the cost story
```

**Space complexity — count the memory that grows with n.** The in-memory store
holds every chunk in a `Map` (`in-memory-vector-store.ts:12`) — O(N) space,
fine for a demo, a wall at scale. pgvector keeps the vectors on disk and the
HNSW graph as an on-disk index, so buffr's *process* memory stays flat as the
corpus grows. That's a space-complexity decision disguised as a deployment
choice.

**Amortized analysis — average cost per op across a sequence, when one op is
occasionally expensive.** You met this building `BinaryHeap.ts`: most `insert`s
are cheap, but `heapifyUp` occasionally bubbles to the root — O(log n) worst
case, O(1) typical, and *amortized* it stays O(log n) because the expensive
case is rare. A dynamic array (JS array growth) is the canonical example: most
pushes are O(1), the occasional resize copies everything (O(n)), but spread
across all pushes it amortizes to O(1). buffr doesn't implement either, but the
HNSW *insert* (every `upsert` at `pg-vector-store.ts:38`) has exactly this
amortized character inside Postgres.

**The boundary condition everyone forgets:** Big-O hides the constant, and the
constant sometimes wins. For `k=3` and a 100-chunk demo corpus, the O(N)
in-memory scan *beats* HNSW — the graph walk's overhead isn't worth it until N
is large. Naming "the asymptotic loser wins at small n" is the senior move.

### Move 3 — the principle

Pick the cost model that matches the input that actually grows. In this repo
the growing input is `N` (corpus size), not `k` (fixed at 3) — so every cost
question collapses to "how does this scale in N?", and the answer is the whole
reason the HNSW graph exists instead of a flat scan.

---

## Primary diagram

The full picture — the cost lens applied across buffr's retrieval path.

```
  cost model across the retrieval path

  ┌─ buffr TS ─────────────────────────────────────────────┐
  │ embed query        O(d)   d=768, one pass               │
  │ dedup k hits       O(k)   k=3   eval-cmd.ts:26          │
  │ score k hits       O(k)   k=3                           │
  └───────────────────────┬─────────────────────────────────┘
                          │  the search call
  ┌─ pgvector (chosen) ───▼─────────────────────────────────┐
  │ HNSW graph walk    ~O(log N · d)   approx, sql/001:30    │ ← scales
  └─────────────────────────────────────────────────────────┘
  ┌─ in-memory (baseline, not in prod) ─────────────────────┐
  │ scan + sort        O(N·d + N log N) in-memory:28-31      │ ← doesn't
  └─────────────────────────────────────────────────────────┘

  the d (=768) factor rides every distance computation — never free
```

---

## Elaborate

Big-O came from Bachmann and Landau (number theory, 1890s), pulled into
algorithm analysis by Knuth. The reason it dominates interviews is that it's the
one cost claim that survives hardware changes — a faster CPU shifts the
constant, not the exponent. The thing it *hides* is exactly what bites in
production: cache behavior, the `d=768` constant on every distance op, and
disk-vs-memory. For this repo, the honest full cost of a query is
`O(log N)` graph hops, each costing `O(d)` to compute a distance, each hop
possibly a disk page read — three different cost models stacked. The
database-systems guide owns that disk-page layer.

---

## Interview defense

**Q: What's the time complexity of the retrieval in this repo, and what's the
dominant term?**

```
  per query:  embed O(d) → ANN walk ~O(log N · d) → dedup/score O(k)
              d=768 (const-ish), k=3 (const), N = corpus (the variable)
  verdict:    O(log N) in the corpus — the d factor is the hidden constant
```

It's logarithmic in the corpus because the HNSW graph lets the search skip most
chunks. The hidden cost is the `d=768` factor on every distance computation —
that's a constant in N but it's not small, and it's why embedding dimension is a
real performance lever, not a detail.

**Q: When would the O(N) in-memory scan beat the O(log N) graph index?**

```
  small N:  flat scan = N·d distance ops, no graph overhead   → wins
  large N:  graph walk = log N · d ops, skips the rest          → wins
  crossover ≈ when log N's constant overhead < N's scan cost
```

At a 100-chunk demo corpus the in-memory scan wins — the graph index's
bookkeeping isn't worth it until N is in the thousands. Asymptotics describe the
limit, not every n. Naming the crossover is the signal you understand the model
rather than reciting it.

**Anchor:** "The variable is N, everything else is a constant — so every cost
question here is really *how does it scale in corpus size*."

---

## See also

- `06-sorting-searching-and-selection.md` — where O(n log n) sort+slice vs the
  O(log n) HNSW walk gets walked in full
- `02-arrays-strings-and-hash-maps.md` — the O(1) Set/Map operations
- Cross-link: `.aipe/study-database-systems/` — the disk-page cost layer under
  every distance op
