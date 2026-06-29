# Arrays, Strings, and Hash Maps

**Industry names:** indexed sequence · dynamic array · hash table / hash map /
hash set · dense vector. **Type:** Language-agnostic.

---

## Zoom out, then zoom in

This is the substrate file. Every other structure in the guide is built out of
these three: the embedding is a `number[]` (array), every chunk id is a string,
and dedup/membership run on `Set`/`Map`. If you only read one repo-grounded
file, this is the one with the most actual buffr code in it.

```
  Zoom out — where these primitives live

  ┌─ buffr TS layer ─────────────────────────────────────────┐
  │  ★ number[768] embedding ★   ★ Set<docId> dedup ★         │ ← we are here
  │  ★ Map<id, chunk> store ★    string ids "<docId>#<index>" │
  └─────────────────────────┬─────────────────────────────────┘
                            │  serialized to
  ┌─ pgvector layer ────────▼─────────────────────────────────┐
  │  vector(768) column   ·  text id   ·  jsonb meta           │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: an **array** is a contiguous, index-addressable sequence — O(1) to
read `a[i]`, O(n) to search for a value. A **hash map** trades order for speed —
O(1) average lookup by key, but no "what's the 3rd element". A **string** is an
array of characters with its own comparison and slicing rules. The repo reaches
for each one exactly where its cost profile fits.

---

## The structure pass

**Layers** — the same datum at three altitudes:

```
  one embedding, three representations

  ┌─ JS heap ──────────────────────────────────┐
  │ number[768]  — indexed, mutable, in RAM     │  meta.vector
  └──────────────────────┬──────────────────────┘
       ┌─────────────────▼─────────────────────┐
       │ text literal  "[0.1,0.2,...]"          │  toVectorLiteral()
       └─────────────────┬─────────────────────┘    pg-vector-store.ts:15
            ┌────────────▼──────────────────────┐
            │ vector(768)  — pgvector's binary   │  embedding column
            └────────────────────────────────────┘
```

**Axis — state ownership.** Trace "who owns this array's memory?": the JS
`number[]` is owned by the V8 heap (GC'd), the text literal is a transient on
the wire, the `vector(768)` is owned by Postgres on disk. The array *identity*
survives all three; the ownership flips.

**Seam — the serialization joint** at `toVectorLiteral` (`pg-vector-store.ts:15`).
A JS array can't cross into SQL as-is; it's flattened to `[0.1,0.2,...]` text
and cast `$1::vector`. That seam is where a dimension bug would hide — and it's
exactly why `assertDim` guards it (`pg-vector-store.ts:32-36`).

---

## How it works

### Move 1 — the mental model

You already know the array shape cold: it's a `.map()` over a list with a `key`
in React — index-addressable, ordered, O(1) random access. The hash map is the
other half of your daily toolkit: `useState` keyed by name, a lookup object
`{[id]: row}`. The new idea here is only *which cost you're buying*: arrays give
you order and index; hash maps give you O(1) membership and throw order away.

```
  array vs hash map — what you trade

  array  [a, b, c, d]      hash map  { x→1, y→2, z→3 }
   │  ordered               │  unordered
   │  a[2] is O(1)          │  has("y") is O(1)
   │  "contains c?" is O(n) │  "what's 2nd?"  — undefined
   └─ index is the key      └─ key is hashed to a bucket
```

### Move 2 — the three primitives in buffr's code

**The embedding is a dense array — `number[768]`.** Every vector in this repo is
a fixed-length JS array. Its length is load-bearing: it's the embedding
dimension, and a mismatch corrupts ranking silently if unchecked. The repo
checks it loudly.

```ts
// pg-vector-store.ts:32-36 — the array's length IS the contract
private assertDim(v: number[]): void {
  if (v.length !== this.dimension) {                 // 768 check
    throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
  }
}
```

The annotation that matters: this isn't bounds-checking, it's *contract*
enforcement. A 768-array and a 512-array are both valid JS arrays; only one is a
valid query vector. The array type can't express "length 768" — so the code
does, at the seam.

**The string id is a composite key — `"<docId>#<index>"`.** Chunk ids are
strings built by concatenation (the `#` separator). That string is then used as
a *hash-map key* in the in-memory store and a *primary key* text column in
Postgres. String-as-key is the cheapest possible index: no schema, deterministic
ids mean an upsert is idempotent.

**The `Set` is the dedup-and-membership primitive — O(1) per op.** This is the
purest hash-table usage in the repo, and it's two distinct jobs in one line:

```ts
// eval-cmd.ts:26-28 — Set doing two jobs
const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];  // job 1: dedup
const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;     // job 2: membership
```

Walk it one operation at a time:

```
  Set as dedup, then Set as membership

  hits = [ {docId: A}, {docId: A}, {docId: B} ]   ── k=3 hits, A repeats
     │  .map(h => h.meta.docId)
     ▼
  ["A", "A", "B"]
     │  new Set(...)        ── hash each, collisions collapse
     ▼
  Set {"A", "B"}           ── duplicate A gone, O(1) per insert
     │  [...spread]
     ▼
  ["A", "B"]               ── back to an ordered array for scoring

  then:  new Set(relevant)              ── relevant ids → hash set
         scorePrecisionAtK checks       ── "is each retrieved doc in relevant?"
         relevantSet.has(doc)  O(1)         O(1) membership, not O(n) scan
```

The boundary condition: **`Set` preserves insertion order in JS but you must not
rely on it as an ordering structure.** Here it's used only for set semantics
(unique + membership); the ranking order came from the *array* the hits arrived
in, not the Set. Confusing the two is the classic bug — using a hash set and
then expecting it to be sorted.

**The in-memory store's `Map` — id → chunk, O(1) upsert and overwrite.** The
baseline store *is* a hash map (`in-memory-vector-store.ts:12`): `chunks =
new Map<string, VectorChunk>()`. `upsert` is `this.chunks.set(chunk.id, chunk)`
— O(1), and the deterministic id means re-indexing the same chunk overwrites
rather than duplicates. That's hashing buying idempotency.

### Move 2.5 — current vs future (collision handling)

Right now buffr never *sees* a hash collision — JS's `Set`/`Map` handle bucket
collisions internally, and Postgres handles its own index hashing. The collision
tradeoff you'd hit if you built the hash table yourself (chaining vs open
addressing, load factor, resize threshold) is **not yet exercised** — it's
hidden inside the runtime. It becomes relevant the day you implement a custom
cache or your own dedup structure rather than reaching for `Set`.

### Move 3 — the principle

Reach for the structure whose cost profile matches the operation: array when you
need order and index, hash map when you need O(1) membership and don't care
about order. The repo's `Set` dedup is the clean case — it needs uniqueness and
fast membership, both of which the array can't give cheaply, so it converts to a
Set and back.

---

## Primary diagram

The three primitives across the retrieval-and-eval path.

```
  arrays / strings / hash-maps in one frame

  ┌─ buffr TS ──────────────────────────────────────────────┐
  │ query → embed → number[768]   (ARRAY: dense vector)      │
  │                     │  assertDim length==768             │
  │                     ▼                                     │
  │ search returns hits[] (ARRAY: ordered by score)          │
  │                     │  .map(docId)                        │
  │                     ▼                                     │
  │ new Set(docIds)     (HASH SET: dedup, O(1))              │
  │ new Set(relevant)   (HASH SET: membership, O(1))         │
  └─────────────────────┬────────────────────────────────────┘
                        │  ids are STRINGS "<docId>#<index>"
  ┌─ pgvector ──────────▼────────────────────────────────────┐
  │ id text PK  ·  embedding vector(768)  ·  meta jsonb       │
  └───────────────────────────────────────────────────────────┘
```

---

## Elaborate

The hash table is arguably the most important data structure in practice — it's
the one that turns "search a list" (O(n)) into "look it up" (O(1)), and it's
under the hood of nearly every fast lookup you've ever written (object property
access, `Map`, DB hash indexes, dedup). The cost you pay is order and worst-case
guarantees: a pathological set of keys all hashing to one bucket degrades to
O(n), which is why production hash tables randomize their hash seed. The array's
deeper story is the *dynamic array* — amortized O(1) append via doubling (file
01) — which is what a JS `[]` actually is. For this repo the vector-as-array is
the bridge to file 06: ranking is just sorting an array of (id, score) pairs.

---

## Interview defense

**Q: Why a `Set` for the dedup in `eval-cmd.ts`, not an array `.filter` /
`.includes`?**

```
  array dedup:  result.includes(x)  → O(n) per check → O(n²) total
  set dedup:    seen.has(x)          → O(1) per check → O(n) total
```

`includes` scans the array each time — O(n²) for n items. `new Set` hashes each
id once and collisions collapse — O(n). For `k=3` it's irrelevant, but it's the
right reflex and it reads cleaner. The Set is doing the same job as a `seen`
guard, just declaratively.

**Q: What does the `768` in `number[768]` actually buy, and what breaks without
the check?**

```
  query vec [768]  vs  stored vec [768]   → distance is meaningful
  query vec [512]  vs  stored vec [768]   → distance is garbage / throws
```

The length is the contract — a distance between vectors of different dimensions
is meaningless, so `assertDim` (`pg-vector-store.ts:32`) throws rather than let
ranking silently corrupt. The array type can't encode the length, so the guard
does. Naming "the length is the contract, not the type" is the signal.

**Anchor:** "Array for order and index; hash set for O(1) uniqueness and
membership — and never confuse the Set's insertion order for a ranking."

---

## See also

- `01-complexity-and-cost-models.md` — the O(1) vs O(n) costs named here
- `06-sorting-searching-and-selection.md` — ranking the hits array
- `04-trees-tries-and-balanced-indexes.md` — the *ordered* alternative to a hash
  map (when you need range queries, not just membership)
- Cross-link: `.aipe/study-database-systems/` — the hash index vs B-tree index
  under the `chunks` table
