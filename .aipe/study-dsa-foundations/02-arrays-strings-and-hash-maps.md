# Arrays, Strings & Hash Maps

**Industry name(s):** indexed sequence (array) · embedding vector · hash set /
hash map · cosine similarity — *Industry standard*

The transferable nouns lead: **vector** (a fixed-length array of floats),
**hash set** and **hash map** (O(1)-average membership and lookup), **cosine
similarity** (the distance metric). The repo's local shapes — `new
Set(relevant)`, the `vector(768)` column, `1 - (embedding <=> ...)` — are the
parens.

---

## Zoom out — where these primitives live

This is the file with the densest real repo footprint. Two of the three
primitives — the **embedding vector** and the **hash set/map** — are what
buffr's own TypeScript actually touches every turn.

```
  Zoom out — arrays & hashing across the stack

  ┌─ eval harness (buffr source) ──────────────────────────────┐
  │  ★ hash set: dedup doc ids, O(1) membership ★              │ ← we are here
  │  [...new Set(...)]   new Set(relevant)                      │
  └───────────────────────────┬────────────────────────────────┘
                              │ each hit carries a vector
  ┌─ vector store ────────────▼────────────────────────────────┐
  │  ★ embedding vector: number[768] ★                         │
  │  cosine similarity = 1 - cosine distance                   │
  └───────────────────────────┬────────────────────────────────┘
                              │ stored as
  ┌─ Postgres ────────────────▼────────────────────────────────┐
  │  embedding vector(768)   — a typed fixed-length array       │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: an **embedding vector** is just an array — 768 floats — and the
whole retrieval system is "find the arrays closest to this array." A **hash
set** is just an array with the index *computed from the value* instead of
chosen by you. Both are the most basic structures you have, and both are
load-bearing here. The question this file answers: **what does "closest" mean
for arrays of floats, and why is O(1) membership the thing that keeps the
eval loop linear?**

---

## Structure pass — layers, axis, seams

**Axis: lookup cost — how do you find a thing?** Trace it across the
structures and watch the answer flip; the flip is the whole reason hash maps
exist.

```
  Axis: "how do you find an element?" — across structures

  ┌─ array by index ──────────────┐
  │  arr[i] → O(1), but you must   │   → you know WHERE it is
  │  already know the index i      │
  └───────────────┬───────────────┘
      seam: you have a VALUE, not an index   (axis flips)
      ┌───────────▼───────────────────┐
      │ array by value: scan → O(n)    │   → you must look at every slot
      └───────────────┬────────────────┘
      seam: hash the value → an index   (axis flips back to O(1))
          ┌──────────▼──────────────────┐
          │ hash set: Set.has(v) → O(1)  │   → compute the index FROM v
          └──────────────────────────────┘
```

The load-bearing seam: a **hash set** turns "find by value" (O(n) scan) back
into "find by index" (O(1)) by *computing* the index from the value. That's
the single idea. `new Set(relevant)` in the eval harness exists precisely so
membership checks don't scan.

---

## How it works

### Move 1 — the mental model

You build with both of these daily. An embedding vector is the `.map()`
output you already know — a fixed-length array, just 768 floats instead of
JSX. A hash set is the `key` prop on a list: React uses a `Set`-like index so
it can answer "have I seen this key?" in O(1) instead of re-scanning the list.

```
  Two primitives, one picture

  EMBEDDING VECTOR (array)        HASH SET (computed-index array)
  ┌───┬───┬───┬─── ─┬───┐         value "doc-7"
  │.02│.91│.03│ ... │.11│              │ hash()
  └───┴───┴───┴─── ─┴───┘              ▼
   index 0 1 2  ...  767         ┌───┬───┬───┬───┐
   "closeness" = angle between   │   │ ● │   │ ● │  bucket = hash % size
    two of these arrays          └───┴───┴───┴───┘
                                  has("doc-7") → check ONE bucket → O(1)
```

One sentence each: **a vector is a point in 768-dimensional space, and
similarity is the angle between two points; a hash set finds a value in O(1)
by computing its slot instead of searching for it.**

### Move 2 — the parts, one at a time

**The embedding vector — a fixed-length typed array.** The column is `embedding
vector(768)` (`sql/001_agents_schema.sql:22`). In TypeScript it's
`number[]`, and buffr is strict that the length is exactly 768
(`src/pg-vector-store.ts:32-36`):

```ts
private assertDim(v: number[]): void {
  if (v.length !== this.dimension) {                    // ← array length check
    throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
  }
}
```

This is the array's contract made explicit: a 768-slot array, no truncation,
throw on mismatch. The boundary condition the assertion guards: a 512-dim
vector silently compared against 768-dim ones would produce garbage
"distances" with no error — so the length check is correctness, not paranoia.

**Cosine similarity — the angle between two arrays.** The metric is computed
in SQL (`src/pg-vector-store.ts:69-72`):

```ts
// <=> is cosine DISTANCE; cosine similarity score = 1 - distance.
1 - (embedding <=> $1::vector) as score
```

Cosine *distance* is `1 - cos(θ)` where θ is the angle between the two
vectors. So `1 - distance` recovers `cos(θ)` — the similarity. The direction
matters and trips people up:

```
  Cosine: distance vs similarity — opposite directions

  angle θ:     0° (identical)        90° (unrelated)      180° (opposite)
  cos(θ):       1.0                    0.0                  -1.0
  distance:     0.0  ◄── smallest      1.0                  2.0  ◄── largest
  score=1-dist: 1.0  ◄── largest       0.0                 -1.0  ◄── smallest

  you ORDER BY distance ASC (closest first)
  you RANK BY score DESC (most similar first)
  same ordering, opposite numbers
```

Why cosine and not Euclidean distance here: embeddings from
`nomic-embed-text` encode *meaning as direction*, and cosine ignores
magnitude — two documents about the same topic point the same way regardless
of length. (The *why this is the right metric for embeddings* lives in
**`study-ai-engineering`**; this file owns the array math.)

**The hash set — dedup and O(1) membership.** Two uses in the eval harness,
both load-bearing (`src/cli/eval-cmd.ts:26-28`):

```ts
const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];   // dedup
const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;      // membership
const r = scoreRecallAtK(docs, new Set(relevant), K).score;
```

Two distinct jobs of the same structure:

```
  Hash set, two jobs in eval-cmd.ts

  JOB 1 — dedup (line 26)
  hits: [doc-3, doc-3, doc-7]  ──new Set──►  {doc-3, doc-7}  ──[...]──► [doc-3, doc-7]
        (one doc, many chunks)   collapses dupes        spread back to array

  JOB 2 — membership (lines 27-28)
  relevant: ["doc-7","doc-9"]  ──new Set──►  {doc-7, doc-9}
  scoring asks: is "doc-7" relevant?  → set.has("doc-7") → O(1), no scan
```

Dedup matters because retrieval returns *chunks*, and one document can produce
several chunks — without `Set`, a document matched by three chunks would count
three times and inflate precision. Membership matters because scoring asks "is
this retrieved doc in the relevant set?" K times; backing `relevant` with a
`Set` makes each check O(1), so scoring stays O(K) instead of O(K · |relevant|).

**The hash map — keyed lookup, the `meta` reshape.** `search` rebuilds each
hit's `meta` as a keyed object (`src/pg-vector-store.ts:80-84`):

```ts
return rows.map((r) => ({
  id: r.id,
  score: Number(r.score),
  meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
}));
```

A JS object here *is* a hash map — string keys, O(1) average access. The
reshape exists so the SQL row's flat columns become the nested `meta` shape
the in-memory store would have produced, keeping the `VectorStore` contract
drop-in. The collision tradeoff is hidden by the runtime: hash maps degrade to
O(n) if every key collides into one bucket, but JS's string hashing makes that
a non-issue for these small, well-distributed key sets.

### Move 3 — the principle

**Hashing buys O(1) by spending memory and giving up order.** A `Set`/`Map`
trades a backing array of buckets (memory) and any notion of sorted order
(you can't ask a `Set` for "the smallest") in exchange for constant-time
membership. When you need *both* fast membership *and* order — which top-k
selection does — that's exactly when you reach past a hash set for a heap
(file `03`). Knowing which guarantee you're buying is the skill.

---

## Primary diagram

Arrays and hashing in buffr, one recap frame.

```
  Arrays & hashing — buffr-laptop recap

  VECTOR (array)          pg-vector-store.ts:22,32
  number[768] ── assertDim ──► throw on length mismatch

  COSINE (array math)     pg-vector-store.ts:69-72
  score = 1 - (a <=> b)  ── order by distance ASC = rank by score DESC

  HASH SET (computed index)   eval-cmd.ts:26-28
  ├─ dedup:      [...new Set(chunkDocIds)]  → one row per doc
  └─ membership: new Set(relevant).has(id)  → O(1) scoring

  HASH MAP (keyed lookup)     pg-vector-store.ts:80-84
  meta {...} ── O(1) avg ── rebuild in-memory shape for the tool
```

---

## Elaborate

The hash table is one of the oldest and highest-leverage data structures —
the trade is always the same: precompute a slot from the value so you never
search. Everything from a language's object access to a database's hash index
to a bloom filter is this idea with a different collision strategy. The vector
here is the other ancient primitive, the contiguous array, doing double duty
as a geometric point.

Worth knowing for completeness, and **not yet exercised** anywhere in buffr or
your portfolio: **string algorithms** proper — the documents are chunked and
embedded, never pattern-matched. No KMP, no suffix structures, no tries (file
`04`). If buffr ever added literal-substring or prefix search over document
text, that's where string DSA would enter. Today it's purely vector math, so
strings here are just opaque content, not a structure you operate on.

---

## Interview defense

**Q: Why `new Set(relevant)` instead of `relevant.includes(id)`?**

```
  array.includes(id)        →  O(n) scan per check  →  O(K·n) total
  new Set(relevant).has(id) →  O(1) per check       →  O(K) total
       └─ build cost O(n) once, then constant lookups
```

Answer: `includes` scans the array every check, making scoring O(K·|relevant|);
a `Set` pays one O(n) build, then every membership is O(1), so scoring is O(K).
The part people forget: you only win if you check membership *more than once* —
for a single check, building the Set isn't worth it. Here it's checked K times
per query across all queries, so it pays.

Anchor: *"A Set turns repeated membership from a scan into a hash lookup —
worth it the moment you check more than once."*

**Q: Why dedup hits with a Set before scoring?**

```
  retrieval returns CHUNKS, scoring counts DOCS
  hits: doc-3#0, doc-3#1, doc-7#2  ──Set──► doc-3, doc-7
        one doc, three chunks         counts once, not three times
```

Answer: one document is split into many chunks, so retrieval can return
several chunks of the same doc; without dedup, precision@k counts that doc
multiple times and inflates the score. The Set collapses chunks back to
distinct docs before scoring.

Anchor: *"Chunks are the retrieval unit; documents are the scoring unit — the
Set bridges them."*

**Q: Why cosine, and why `1 - distance`?**

```
  embeddings encode meaning as DIRECTION (not magnitude)
  cosine ignores length → same topic, same direction, high similarity
  pgvector gives DISTANCE (small = close); score = 1 - distance (large = similar)
```

Anchor: *"Cosine measures angle, not length — right for embeddings; the
`1 - distance` just flips it from distance-space to similarity-space."*

---

## See also

- `03-stacks-queues-deques-and-heaps.md` — when O(1) membership isn't enough
  and you need O(1) *ordered* access (top-k).
- `05-graphs-and-traversals.md` — the vectors here become nodes in the HNSW
  graph.
- `06-sorting-searching-and-selection.md` — how the cosine distances get
  ranked into top-k.
- **`study-ai-engineering`** — why cosine is the right metric for embeddings,
  and the RAG pipeline these vectors feed.
