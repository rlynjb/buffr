# DSA Foundations — buffr-laptop

The reusable data-structures-and-algorithms vocabulary behind this repo,
plus the foundations the repo does **not** exercise that are worth drilling
next. Curriculum-style: the concept files teach transferable DSA, grounded
in buffr's real files where the repo touches them, honest where it doesn't.

---

## The one-paragraph verdict

The interesting algorithms in this system live **one layer down** from
buffr's own source. buffr is a thin persistence + chat shell over
`@rlynjb/aptkit-core` and Postgres/pgvector. The headline algorithm —
**approximate nearest-neighbour search** (the HNSW index) over a
768-dimensional vector space — is *one DDL line plus a C extension*
(`sql/001_agents_schema.sql:28-29`), not TypeScript you wrote. What buffr's
own flat source actually exercises is small and worth naming precisely:
**cosine similarity + top-k selection** pushed into SQL
(`src/pg-vector-store.ts:67-85`), and **hash-set / hash-map dedup + membership**
in the eval harness (`src/cli/eval-cmd.ts:26-28`). That's the honest footprint.

---

## Where the DSA actually lives — the layer map

```
  buffr-laptop — where the algorithms sit

  ┌─ buffr's own TypeScript (this repo) ───────────────────────┐
  │  pg-vector-store.ts   → builds the SQL: cosine + top-k      │
  │  eval-cmd.ts          → Set/Map dedup, P@k / R@k scoring    │
  │  session.ts           → wires retrieval; no DSA of its own  │
  │  (flat source — almost no hand-written data structures)     │
  └───────────────────────────┬────────────────────────────────┘
                              │ imports @rlynjb/aptkit-core
  ┌─ aptkit library layer ────▼────────────────────────────────┐
  │  in-memory VectorStore → sort + slice top-k (exact)         │
  │  retrieval pipeline, scoring helpers, memory engine         │
  └───────────────────────────┬────────────────────────────────┘
                              │ buffr swaps store → Postgres
  ┌─ Postgres + pgvector (C extension) ───────────────────────┐
  │  ★ HNSW index ★  approximate nearest-neighbour over a      │ ← the headline
  │  navigable-small-world graph. ONE ddl line + C code.       │   algorithm
  └────────────────────────────────────────────────────────────┘
```

The single most important thing to internalise: **the same `VectorStore`
contract has two implementations with different algorithms behind it.**
aptkit's in-memory store does an *exact* top-k by **sort + slice** over every
vector. buffr's `PgVectorStore` delegates the same operation to Postgres,
where the HNSW index turns it into an *approximate* graph walk. The interface
is identical; the algorithm and its cost are not. That swap is the whole
lesson of this repo's DSA story.

---

## Ranked findings — what to look at first

1. **Top-k selection is the load-bearing operation, and it has two algorithms.**
   `order by embedding <=> $1 limit k` (`src/pg-vector-store.ts:74-77`) is
   top-k selection. aptkit's library store does the same with sort + slice.
   A size-k heap (your `BinaryHeap` / `PriorityQueue`) is the third option
   neither uses — and the one that matters when k ≪ n. → `06`, `03`.

2. **ANN over HNSW is the headline, and it's NOT exact.** The HNSW index
   (`sql/001:28-29`) is a navigable-small-world **graph** — greedy
   frontier-walk with a visited set, exactly the BFS/Dijkstra skeleton you
   built, but trading correctness for speed. It can miss the true nearest
   neighbour. → `05`.

3. **Cosine similarity is the distance metric, computed as `1 - distance`.**
   `1 - (embedding <=> $1::vector)` (`src/pg-vector-store.ts:72`) converts
   pgvector's cosine *distance* into a similarity *score*. Sign and direction
   matter: you `order by` distance ascending, you rank by score descending.
   → `02`.

4. **Hash set + hash map carry the eval harness.** `[...new Set(...)]`
   dedups doc ids (`src/cli/eval-cmd.ts:26`); `new Set(relevant)` backs O(1)
   membership for precision/recall (`:27-28`). O(1) average lookup is why the
   scoring loop is linear, not quadratic. → `02`.

5. **The whole memory feature reuses vector search — no new structure.**
   `createConversationMemory` (`src/session.ts:53`) writes episodic memory
   into the *same* chunks table, recalled through the *same* ANN search. One
   data structure, two product features. → `05`, `02`.

---

## Not yet exercised — the highest-value gaps

These are absent from buffr **and** from your reincodes portfolio (per
`me.md`), which makes them the highest-leverage things to drill next. Each
concept file flags them generously where they'd apply.

```
  Gap                     Where it would land            Drill priority
  ──────────────────────  ─────────────────────────────  ──────────────
  Dynamic programming     edit distance, sequence align   ★★★ highest
  Tries                   prefix / autocomplete over docs  ★★
  Union-find              dedup clusters, connected sets   ★★
  Balanced BST internals  what HNSW/B-tree replace         ★
  Size-k heap for top-k   the selection you skipped        ★ (you have the heap)
```

You already own the prerequisites for the last two: a from-scratch
`BinaryHeap` and `PriorityQueue`, and full graph traversals. DP, tries, and
union-find are the genuinely new structures. → `07`, `08`.

---

## Reading order

```
  01  complexity-and-cost-models        ← the measuring stick
  02  arrays-strings-and-hash-maps       ← vectors, cosine, Set/Map (repo core)
  03  stacks-queues-deques-and-heaps     ← the size-k heap you skipped
  04  trees-tries-and-balanced-indexes   ← what HNSW/B-tree replace (gaps)
  05  graphs-and-traversals              ← HNSW as a navigable graph (headline)
  06  sorting-searching-and-selection    ← sort+slice vs heap vs ANN
  07  recursion-backtracking-and-dp      ← the DP gap, honestly
  08  dsa-foundations-practice-map       ← ranked plan: exercised → missing
```

Anchored repo files throughout: `src/pg-vector-store.ts`,
`src/cli/eval-cmd.ts`, `src/session.ts`, `sql/001_agents_schema.sql`.

## Cross-links

- **`study-database-systems`** — owns the *storage-engine* side of HNSW (page
  layout, index build cost, `ef_search`, query planning). This guide owns the
  *algorithm* (the graph walk). It cross-links rather than re-teaches.
- **`study-ai-engineering`** — owns embeddings, RAG, retrieval quality, and
  why cosine is the right metric for normalized embeddings. This guide owns
  the *data structures* under retrieval.
