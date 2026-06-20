# Arrays, Strings, and Hash Maps

**Indexed sequences / hash tables / sets** — *Industry standard*

## Zoom out, then zoom in

These are the structures the repo actually leans on hardest — and the least
glamorous. The in-memory store *is* a hash map. The eval harness dedups with a
set. The chunker walks a string with two pointers. The cosine math loops over
two arrays in lockstep. Here's where they sit.

```
  Zoom out — the workhorse structures, by layer

  ┌─ buffr CLI layer ────────────────────────────────────┐
  │  eval-cmd.ts: [...new Set(docs)]  ★ SET ★             │ ← dedup
  │              scorePrecisionAtK(.., new Set(relevant)) │   + membership
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ aptkit library layer ────▼──────────────────────────┐
  │  in-memory store: chunks = new Map()  ★ HASH MAP ★    │ ← keyed store
  │  chunker: text.slice(start, start+512) ★ STRING ★     │ ← sliding window
  │  cosine:  for i in a.length { dot += a[i]*b[i] } ★ARR★│ ← parallel arrays
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ pgvector layer ──────────▼──────────────────────────┐
  │  embedding vector(768) — a fixed-length float array   │ ← the vector
  └───────────────────────────────────────────────────────┘
```

Zoom in: an **array** is a contiguous, index-addressable sequence — `O(1)` to
read by position. A **hash map** trades ordering for `O(1)` average lookup by
key. A **set** is a hash map with no values — membership only. A **string** is
an immutable array of characters. The question this file answers: *which of
these does each piece of the retrieval path reach for, and why that one?*

## The structure pass

Trace **one axis — "how is a thing looked up?" — across the structures.**

```
  Axis = "given a thing, how do I find it / its score?"

  ┌─ chunk by id ───────────────────────────┐
  │ Map.get("doc.md#3")  → O(1) hash lookup  │  key → value
  └──────────────────────┬───────────────────┘
                         │  seam: key access vs scan
  ┌─ chunk by similarity ▼──────────────────┐
  │ scan every entry, score each → O(n)      │  NO key for "most similar"
  └──────────────────────┬───────────────────┘
                         │  seam: exact vs approximate
  ┌─ is this doc relevant?▼─────────────────┐
  │ Set.has(docId)  → O(1) membership        │  key → bool
  └──────────────────────────────────────────┘
```

The load-bearing **seam**: a `Map` gives you `O(1)` lookup *by key*, but
"the most similar vector" is not a key — there's no hash for "closest in cosine
space." That's why similarity search has to scan (in-memory) or use a graph
index (HNSW), while id lookup and relevance checks stay `O(1)`. The axis flips
from `O(1)` to `O(n)` exactly at the boundary between "lookup by identity" and
"lookup by proximity." That flip is the reason vector search is a hard problem
and `Map.get` isn't.

## How it works

### Move 1 — the mental model

You know these cold from frontend: a `Map` is the object you reach for when you
need keyed lookup without prototype-pollution worries; a `Set` is what you use
to dedup a list before rendering (`[...new Set(items)]`); an array is every
`.map()` you've ever written; a string is what `key={id}` is built on. The DSA
framing just makes the cost explicit.

```
  The four structures, by access pattern

  array     [a][b][c][d]      index → value      arr[2] = O(1)
              0  1  2  3

  string    "h e l l o"       index → char       s[1]   = O(1), immutable

  hash map  hash("k") ─┐                          map.get("k") = O(1) avg
            ┌──────────┴──────────┐
            │ bucket: k → value   │               (collision → chain)
            └─────────────────────┘

  set       hash("x") → "is x present?"           set.has("x") = O(1) avg
```

The single sentence: **arrays and strings address by position; maps and sets
address by content (hash).** Pick the one whose access pattern matches your
question.

### Move 2 — each structure where the repo uses it

**The hash map as the in-memory store.**
The library's `InMemoryVectorStore` declares `chunks = new Map()` and stores
each chunk under its id (`"<docId>#<index>"`). Bridge from what you know: it's
the exact same move as keying React list items — the id is the stable handle.
`upsert` does `this.chunks.set(chunk.id, chunk)` — `O(1)` amortized per chunk.
Where it breaks: the `Map` gives you `O(1)` retrieval *by id*, but `search()`
still has to iterate `this.chunks.values()` and score every one, because
similarity isn't a key. The `Map` solves identity lookup; it does nothing for
proximity lookup.

```
  Map keyed by composite id — the in-memory store

  chunks: Map<string, Chunk>
  ┌────────────────┬──────────────────────────────┐
  │ "work.md#0"    │ { vector:[...768], meta:{...} }│
  │ "work.md#1"    │ { vector:[...768], meta:{...} }│  set/get = O(1)
  │ "stack.md#0"   │ { vector:[...768], meta:{...} }│  values() = O(n)
  └────────────────┴──────────────────────────────┘
                                  │
                          search() must scan ALL values — no key for "closest"
```

**The set for dedup and membership.**
The eval CLI retrieves k hits, each carrying a `docId` in its meta, then
collapses them: `[...new Set(hits.map(h => String(h.meta.docId)))]`. Bridge:
identical to deduping a tag list before rendering chips. Then the scorer takes
`relevant` as a `Set` and asks `relevantIds.has(id)` for each retrieved id —
`O(1)` membership. Where it breaks: if you used an array for `relevant` and did
`.includes()`, every check becomes `O(m)` and the scorer goes `O(k·m)`. The
`Set` is what keeps it `O(k)`.

```
  Set: dedup then membership — the eval path

  hits: [work.md#0, work.md#1, stack.md#0]
         │ .map(docId) → [work.md, work.md, stack.md]
         ▼ new Set(...)
  docs: {work.md, stack.md}              ← dedup: 3 → 2, distinct only
         │
         ▼ relevantIds.has(docId)        ← O(1) per check
  matched / total = precision@1
```

**The string as a sliding window — the chunker.**
`chunkText` walks the document string in fixed steps. Bridge from what you know:
it's a two-pointer / sliding-window scan — the same pattern as a "max substring
of length L" problem, except instead of computing a value per window it *emits*
each window. Step size is `512 - 64 = 448`; window size is `512`; the 64-char
overlap is the difference. Where it breaks: drop the overlap and a fact that
straddles a 512-char boundary gets split across two chunks and is retrievable
from neither cleanly — the overlap is the load-bearing part.

```
  Sliding window over a string — chunkText, step=448, window=512

  text:  ┌──────────── 512 ────────────┐
         │ chunk 0                      │
                              ┌──────────── 512 ────────────┐
                              │ chunk 1                      │
                              └─64─┘  ← overlap re-includes the boundary
         start: 0      448      896 ...   step = size - overlap
```

**Parallel arrays in the cosine loop.**
Cosine similarity walks two 768-element float arrays in lockstep, one index at a
time, accumulating three running sums: the dot product and each vector's squared
magnitude. Bridge: it's a single-pass reduce over two arrays at once — like
zipping two lists and folding. Where it breaks: the two arrays *must* be the
same length (same dimension) or `a[i]*b[i]` reads past the end of one. That's
why `assertDim` exists and throws — a length mismatch silently corrupts the
score otherwise.

```
  Parallel-array single pass — cosine similarity (d=768)

  i:    0      1      2    ...   767
  a:  [a0]   [a1]   [a2]   ...  [a767]
  b:  [b0]   [b1]   [b2]   ...  [b767]
       │      │      │
       ▼ accumulate three sums in ONE pass:
  dot  += a[i]*b[i]      ← numerator
  magA += a[i]*a[i]      ← |a|²
  magB += b[i]*b[i]      ← |b|²
  result = dot / (√magA · √magB)        ← one divide at the end
```

### Move 3 — the principle

**Match the structure to the question's access pattern.** "Look up by id" wants
a map. "Is this present" wants a set. "Walk in order" wants an array or string.
"Find the closest in a metric space" wants *none of these* — it wants a spatial
index (a graph or tree), which is exactly why HNSW exists and why the in-memory
store has to fall back to a full scan.

## Primary diagram

The four structures, each at the point in the retrieval path where it's reached
for.

```
  The workhorse structures across one query — recap

  query "what work?" ──embed──► [768-float ARRAY]
                                      │
  ┌─ in-memory path ─────────────────▼──────────────────────┐
  │ Map<id,Chunk>.values()  → scan n  → cosine over PARALLEL │
  │   (STRING chunks were)              ARRAYS (dot/norm)     │
  │   sliced in by chunkText                                 │
  └──────────────────────────────────┬───────────────────────┘
                                      ▼  ranked hits
  ┌─ eval path ──────────────────────▼──────────────────────┐
  │ [...new Set(docIds)]  → SET dedup → relevant.has(id)     │
  │                                     O(1) membership       │
  └──────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The `Set` dedup runs every time you score retrieval quality
(`npm run eval`). The composite-id string `"<docId>#<index>"` is how every chunk
is addressed in both stores — it's the deterministic id buffr's constraints
require. The sliding-window chunker runs on every `npm run index`.

```
  src/cli/eval-cmd.ts  (lines 26–28) — Set dedup + membership

  const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];
       │              │                    │
       │              │                    └─ pull docId out of each hit's meta
       │              └─ new Set(...) collapses duplicates: two chunks from
       │                 the same doc count as one document hit
       └─ spread back to an array so the scorer can slice(0,k)

  const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;
                                     │
                                     └─ relevant is wrapped in a Set so the
                                        scorer's .has() checks are O(1), not
                                        O(m) array scans (file 06 for the math)
```

The composite id that keys the map (built in the library's pipeline, surfaced
back in buffr's store):

```
  src/pg-vector-store.ts  (lines 80–84) — rebuilding meta, keyed by id

  return rows.map((r) => ({
    id: r.id,                         ← the "<docId>#<index>" string key
    score: Number(r.score),
    meta: { ...(r.meta ?? {}), docId: r.document_id,
            chunkIndex: r.chunk_index, text: r.content },
            │
            └─ docId is reconstructed into meta so the eval path's
               h.meta.docId Set-dedup works identically to the in-memory
               store — same shape across both stores (the seam holds)
  }));
```

## Elaborate

Hash tables date to the 1950s (IBM, Luhn); the `O(1)`-average promise rests on a
good hash function spreading keys evenly across buckets — collisions degrade it
toward `O(n)` in the worst case, which is why production hash maps (V8's `Map`,
Postgres's hash indexes) use careful hashing and resizing. The sliding-window /
two-pointer pattern is the bread-and-butter of array-and-string interview
problems; the chunker is the gentlest possible instance of it (fixed step, no
condition).

What's *absent* here and worth flagging: no **trie** (prefix structure) anywhere
— and it's absent from your reincodes portfolio too, so it's a real gap, covered
in `04`. The repo also never needs a **deque** or a true two-pointer convergence
(left and right moving toward each other); the chunker's pointer only marches
forward.

## Interview defense

**Q: The in-memory store is a `Map`, but `search()` still scans all n entries.
Why doesn't the map make search fast?**

```
  Map indexes by id, not by proximity

  Map.get("work.md#3")     → O(1)   ← id IS the hash key
  "find closest to query"  → O(n)   ← "closest" is NOT a key
                                       must score every value()
```

Answer: "A hash map gives `O(1)` lookup by key, but 'most similar vector' isn't
a key — there's no hash function for cosine proximity. So `search` falls back to
scanning `chunks.values()` and scoring each. The map only helps `upsert` and
id-based retrieval. Making *search* fast needs a spatial index — a graph (HNSW)
— not a hash map." Anchor: the library's in-memory `search` iterating
`this.chunks.values()`.

**Q: Why wrap `relevant` in a `Set` in the eval CLI?**

Answer: "Membership. The scorer asks `relevant.has(id)` for each retrieved id.
A `Set` makes that `O(1)`; an array would make it `O(m)` and the whole scorer
`O(k·m)`. For three relevant docs it doesn't matter at runtime — it matters as
the *correct instinct*: membership questions want a set." Anchor:
`src/cli/eval-cmd.ts:27`.

## Validate

1. **Reconstruct.** Write the chunker's step size and window size from memory,
   and say what the 64-char overlap prevents. (Step 448, window 512; prevents a
   boundary-straddling fact being split.)
2. **Explain.** Why is `search()` `O(n)` even though the store is a `Map`?
   (`src/pg-vector-store.ts` / library in-memory store.)
3. **Apply.** You need to know "have I already indexed doc X?" before
   re-indexing. Which structure, and what's the lookup cost?
   (A `Set` of seen ids, or `Map.has` — `O(1)`.)
4. **Defend.** Someone replaces `new Set(relevant)` with the raw array in
   `eval-cmd.ts:27`. What's the complexity change, and when does it bite?

## See also

- `01-complexity-and-cost-models.md` — the amortized `O(1)` these structures
  rely on.
- `03-stacks-queues-deques-and-heaps.md` — the ordering disciplines arrays back.
- `05-graphs-and-traversals.md` — the spatial index that `Map` *can't* be.
- `06-sorting-searching-and-selection.md` — the `Set`-based precision@k math.
- `study-ai-engineering` → why 768-dim float arrays are the embedding, and what
  cosine similarity means semantically.
