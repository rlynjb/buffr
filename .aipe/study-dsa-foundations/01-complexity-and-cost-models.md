# Complexity & Cost Models

**Industry name(s):** asymptotic analysis · Big-O / time & space complexity ·
amortized analysis — *Industry standard*

The leading terms below are the transferable ones: **time complexity**,
**space complexity**, **amortized cost**, **input size (n)**. The repo's local
shapes (the eval loop, the top-k query, the upsert batch) are the parens.

---

## Zoom out — where cost models live

Complexity isn't a layer in the system; it's the **ruler** you hold against
every other layer. Every concept file after this one makes a cost claim, and
this is where you calibrate the ruler.

```
  Zoom out — the cost ruler measures every layer

  ┌─ buffr source ─────────────────────────────────────────────┐
  │  eval loop over Q queries   → ★ measured: O(Q · ...) ★      │ ← we are here
  │  Set dedup, Set membership  → O(1) avg per op               │
  └───────────────────────────┬────────────────────────────────┘
                              │ each query calls retrieval
  ┌─ retrieval ───────────────▼────────────────────────────────┐
  │  embed query  → O(d) vector   |  search → O(?) depends on   │
  │                                  store implementation        │
  └───────────────────────────┬────────────────────────────────┘
                              │ store = Postgres + HNSW
  ┌─ pgvector ────────────────▼────────────────────────────────┐
  │  exact scan: O(n·d)   vs   HNSW: ~O(log n · d)              │
  │  the cost model is the WHOLE reason HNSW exists             │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question this file answers is **"when I say one option is faster
than another, faster in what units, and at what input size does the
difference start to bite?"** You can't argue sort+slice vs heap vs ANN
(files `03`, `05`, `06`) until the ruler is shared.

---

## Structure pass — layers, axis, seams

**Axis: cost.** Hold one question constant down the stack: *what grows when
the corpus grows?* The answer flips at each layer, and those flips are the
seams worth studying.

```
  One axis — "what does cost scale with?" — traced down

  ┌─ eval harness ────────────────┐
  │  cost ∝ Q (number of queries) │   → linear in your eval set
  └───────────────┬───────────────┘
      seam: each query → one search   (cost per query is the unknown)
      ┌───────────▼───────────────────┐
      │ exact search: cost ∝ n · d     │   → linear in CORPUS size
      └───────────────┬────────────────┘
      seam: swap exact → HNSW   (THIS is the load-bearing flip)
          ┌──────────▼──────────────────┐
          │ HNSW: cost ∝ log n · d       │   → sublinear in corpus
          └──────────────────────────────┘

  the seam that matters: exact O(n) → approximate O(log n).
  everything else in this repo is incidental cost.
```

The seam where the cost axis flips hardest is the `VectorStore` swap:
aptkit's in-memory store is O(n·d) exact; buffr's `PgVectorStore` over HNSW
is roughly O(log n · d) approximate. That single boundary is why this whole
repo exists. Mechanics hang off it.

---

## How it works

### Move 1 — the mental model

You already have the right instinct from your sorting visualizers: bubble
sort *looks* slow because the bars swap O(n²) times, and the picture makes
the cost real. Big-O is that picture generalised — **strip the constants and
the lower-order terms, keep the term that dominates as n grows.**

```
  Big-O — keep only the dominant term as n → ∞

  actual cost:   3n² + 50n + 200
                  │     │     │
                  │     │     └─ constant   → drop (irrelevant at scale)
                  │     └─ lower order       → drop (n² swamps it)
                  └─ dominant term           → KEEP

  Big-O = O(n²)        the only term that matters when n is large
```

One sentence: **complexity is the growth rate of cost as input size grows,
with constants and small terms discarded.** The discarding is the point — at
n = 10 the constants matter; at n = 1,000,000 (a real corpus) only the
dominant term does.

### Move 2 — the cost models that show up in this repo

**Time complexity — count the operations, as a function of n.** The eval
loop (`src/cli/eval-cmd.ts:24-32`) runs once per query. Inside, for each
query it does one retrieval, one dedup, two scoring passes. Annotated:

```ts
for (const { query, relevant } of queries) {        // ← runs Q times
  const hits = await pipeline.query(query, K);       // ← search: O(search) each
  const docs = [...new Set(hits.map(...))];          // ← dedup: O(K)
  const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;  // O(K)
  const r = scoreRecallAtK(docs, new Set(relevant), K).score;     // O(K)
}
```

Total time is `O(Q · (search + K))`. `K` is fixed at 3, so the `Set` work is
constant per query — the loop is **linear in Q**, and the real cost is hidden
inside `search`. That's the honest read: buffr's eval harness is cheap; the
expensive term is delegated to the store.

**Space complexity — count what you hold in memory at once.** `[...new
Set(hits.map(...))]` (`:26`) materialises a fresh array of deduped doc ids —
O(K) extra space. Trivial here. The space cost that *would* matter is the one
buffr deliberately doesn't pay: aptkit's in-memory store holds all n vectors
in RAM, O(n·d). buffr pushes that into Postgres, so buffr's *process* stays
O(1) in corpus size. That's a space-cost decision baked into the architecture.

**Amortized analysis — average cost over a sequence, not worst case per op.**
This is the one your `BinaryHeap` already taught you, even if the comment
didn't name it. `upsert` (`src/pg-vector-store.ts:38-65`) inserts chunks one
at a time inside a transaction. Each insert into the HNSW index is *usually*
cheap, but occasionally the index does more work to keep the graph navigable.
Amortized cost spreads those rare expensive inserts across the cheap ones:

```
  Amortized — rare expensive ops spread over many cheap ones

  inserts:  c  c  c  c  EXPENSIVE  c  c  c  c  c  EXPENSIVE  c ...
            └──── cheap O(log n) ────┘          └─ cheap ─┘
                          ▲                          ▲
                  occasional restructure      occasional restructure

  per-op worst case:  high
  amortized (averaged): O(log n)   ← the number you actually budget with
```

The dynamic-array `push` you use every day (`[...arr, x]` grows the backing
buffer occasionally) is the canonical example: O(1) amortized, O(n) on the
rare resize. Same shape.

**Choosing the right cost model — input size is a choice.** The trap is
measuring against the wrong n. The eval loop is O(Q) where Q is your *labeled
query set* (`eval/queries.json`) — small, fixed. The search inside is O(f(n))
where n is the *corpus size* — large, growing. Two different n's in one loop.
Naming which n you mean is half of getting the analysis right.

### Move 3 — the principle

**Complexity is a claim about scale, not speed.** It says nothing about
whether something is fast at n = 10; it predicts what happens at n =
10,000,000. Every "X is faster than Y" in the next seven files is really
"X has a better dominant term," and the only honest way to compare is to fix
the same n for both. That discipline — same ruler, same input size — is the
thing this file installs.

---

## Primary diagram

The cost models, one frame, mapped to where each shows up in buffr.

```
  Cost models in buffr-laptop — one recap

  TIME        ┌─ eval loop O(Q·(search+K)) ──┐  cli/eval-cmd.ts:24
              │  search = the unknown term   │
              └──────────────┬───────────────┘
  AMORTIZED   ┌──────────────▼───────────────┐  pg-vector-store.ts:38
              │  HNSW insert ~O(log n) avg,   │
              │  occasional restructure       │
              └──────────────┬───────────────┘
  SPACE       ┌──────────────▼───────────────┐  architecture decision
              │  buffr process O(1) in corpus │
              │  (Postgres holds the n·d data)│
              └──────────────┬───────────────┘
  THE FLIP    ┌──────────────▼───────────────┐  sql/001:28
              │  exact O(n·d) → HNSW O(log n·d)│
              │  the cost model that justifies │
              │  the whole repo                │
              └───────────────────────────────┘
```

---

## Elaborate

Big-O came out of a need to compare algorithms independent of the machine
they run on — a 1970s constant-factor difference between two computers could
swamp a real algorithmic improvement, so the field agreed to throw constants
away and compare growth rates only. That same discipline is why "the HNSW
index is faster" is a meaningful, machine-independent claim: it's O(log n)
vs O(n), and that holds whether you run it on a laptop or a data-center node.

Where this connects next: `06` (sorting/searching/selection) is the file
where these cost models get teeth — sort+slice is O(n log n), a size-k heap
is O(n log k), ANN is O(log n) approximate, and only the shared ruler lets
you rank them. For the *storage-engine* cost of the HNSW build (page reads,
`ef_construction`), see **`study-database-systems`**.

---

## Interview defense

**Q: The eval loop calls `pipeline.query` Q times. What's the complexity?**

```
  O(Q · search_cost) + O(Q · K) for scoring

  ┌─ Q queries ─┐   each: ┌─ search: O(f(n)) ─┐ + ┌─ Set work: O(K) ─┐
  └─────────────┘         └───────────────────┘   └──────────────────┘
                  n = corpus size, K = 3 (fixed)
```

Answer: linear in Q, with the real cost in `search`, which is O(n·d) exact or
~O(log n·d) over the HNSW index. The two n's — query-set size and corpus size
— are different; name both.

Anchor: *"The loop is O(Q); the corpus term is delegated to the store, so the
honest complexity statement names which n you mean."*

**Q: Why is amortized analysis the right model for HNSW inserts, not
worst-case?**

```
  per-op worst case overcounts:  rare restructure ≠ every insert
  amortized spreads it:          total work / number of ops
```

Answer: most inserts are O(log n); the occasional graph restructure is rare,
so averaging over the insert sequence gives O(log n) amortized — the number
you actually capacity-plan with. Same as dynamic-array `push`: O(1) amortized
despite O(n) resizes. The part people forget: amortized is a *worst-case
average over a sequence*, not an expected value over random input — it holds
even adversarially.

Anchor: *"Amortized is sequence-averaged worst case — that's why it's a
budget, not an optimism."*

---

## See also

- `06-sorting-searching-and-selection.md` — where these cost models decide
  sort+slice vs heap vs ANN.
- `05-graphs-and-traversals.md` — the O(log n) HNSW walk this file keeps
  pointing at.
- **`study-database-systems`** — the storage-engine cost of building and
  querying the HNSW index.
