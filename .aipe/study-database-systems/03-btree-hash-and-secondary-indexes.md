# B-tree, Hash, and Secondary Indexes

**Industry name(s):** secondary indexes / ANN index (HNSW) / access methods · **Type:** Industry standard

---

## Zoom out, then zoom in

buffr has three index kinds doing three jobs: a B-tree on every primary key (exact lookup by id), a B-tree on `app_id` (filter), and the one that earns its keep — an **HNSW** graph index on the embedding column (approximate nearest-neighbor). This file is about why each exists and the one that's actually interesting.

```
  Zoom out — where indexes sit

  ┌─ Persistence ───────────────────────────────────────────────┐
  │  search()  →  ORDER BY embedding <=> $1  LIMIT k             │
  │  upsert()  →  INSERT … ON CONFLICT (id)                      │
  └──────────────────────────┬──────────────────────────────────┘
                             │  SQL
  ┌─ Storage engine ─────────▼──────────────────────────────────┐
  │  agents.chunks heap                                          │
  │   ├─ PK btree(id) ............. exact lookup, ON CONFLICT     │
  │   ├─ btree(app_id) ............ filter the search            │
  │   └─ ★ HNSW(embedding vector_cosine_ops) ★ ... ANN search    │ ← we are here
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: an index is a side structure that turns "scan everything" into "jump to it." The B-trees do the boring, essential work. The HNSW index is the one that makes RAG fast — and the one with a tradeoff most people miss: **it returns *approximate* neighbors, not exact ones.**

---

## The structure pass

Three indexes, one axis: *exact or approximate, and what does a lookup cost?*

```
  Axis = "is the answer exact, and what's the lookup cost?"

  ┌─ PK btree(id) ───────────────┐   EXACT   · O(log n) · always correct
  │  WHERE id = '<docId>#<idx>'  │
  └──────────────────────────────┘
  ┌─ btree(app_id) ──────────────┐   EXACT   · O(log n + matches) · filter
  │  WHERE app_id = 'laptop'     │
  └──────────────────────────────┘
  ┌─ HNSW(embedding) ────────────┐   APPROX  · ~O(log n) · CAN MISS top-k
  │  ORDER BY embedding <=> $1   │   ◄── the answer-correctness axis FLIPS here
  └──────────────────────────────┘
```

The seam is the third index. Across it the *correctness guarantee flips*: B-trees give you the exact row, every time. HNSW gives you *probably* the right neighbors — it trades a small recall loss for a massive speed gain over scanning every vector. **That flip is the most important thing to know about vector search**, and buffr accepts it without tuning the dial.

---

## How it works

### Move 1 — the mental model

You know how a B-tree is a sorted, balanced tree you binary-search down? HNSW isn't a tree — it's a **navigable small-world graph**: nodes are vectors, edges connect near-neighbors, and a search greedily hops toward the query through a layered graph, like skip-lists made of proximity.

```
  The pattern — HNSW greedy graph descent

  layer 2 (sparse, long hops):   A ───────────► D
                                 │              │
  layer 1 (medium):              A ──► B ──────► D ──► E
                                 │     │         │
  layer 0 (dense, all nodes):    A─B─C─D─E─F─G─H─I─J…
                                       ▲
                         start high, hop greedily toward the query
                         vector, descend a layer, repeat → land near
                         the true neighbors (approximately)
```

One sentence: **start at the top layer, greedily walk edges toward the query vector, drop down layers, and collect the closest nodes you land near.** It can miss the true #1 if the greedy path routes around it — that's the "approximate" in approximate-NN.

### Move 2 — the load-bearing skeleton

HNSW search has an irreducible kernel. Strip any part and it breaks:

```
  HNSW search kernel (pseudocode)

  input:  query_vector, k
  start at entry_point on the TOP layer
  for each layer from top down to 0:
    while a closer neighbor exists among current node's edges:
      move to the closest neighbor       // greedy hop
  collect the ef closest nodes found at layer 0   // ef = search width
  return the k closest of those
```

**The greedy hop — without it, no navigation.** The whole speed win is *not* visiting every node. Remove greediness (visit all) and you're back to an exact full scan.

**The layers — without them, you start far away.** Upper sparse layers let you cover distance in few hops before refining. One flat layer means many small hops.

**`ef` (search width) — without enough of it, recall tanks.** `ef` is how many candidates you keep while descending layer 0. Bigger `ef` = more thorough = higher recall = slower. **This is `hnsw.ef_search`, and buffr never sets it** — it runs the pgvector default (40). That's the recall/latency dial, untouched.

```
  The recall/latency dial — ef_search

  ef_search = 40  (default, buffr) ─── fast, ~good recall
  ef_search = 100 ───────────────────► slower, higher recall
  ef_search = 10  ◄─────────────────── faster, misses more

  buffr sits at the default and never measures the exact baseline
```

**Build-time params — `m` and `ef_construction` — shape the graph.** `m` = edges per node (graph density), `ef_construction` = how hard the build searches for good edges. Both are set at `CREATE INDEX` time. buffr's index (`sql/001_agents_schema.sql:28-29`) sets *neither* — pgvector defaults (`m=16`, `ef_construction=64`). Optional hardening, never applied.

**The opclass must match the operator — the load-bearing alignment.** The index is built `using hnsw (embedding vector_cosine_ops)`. The `vector_cosine_ops` opclass tells the index "distances here mean cosine." The query orders by `<=>` — the cosine-distance operator. **They are a matched pair.** Order by `<->` (L2) and the planner sees no cosine index for that operator → full sequential scan over every vector. Here's where it breaks silently: the query still *works*, just slowly, with no error.

```
  Operator ↔ opclass alignment (the silent-failure trap)

  index:  hnsw (embedding vector_cosine_ops)   ← cosine
  query:  ORDER BY embedding <=> $1            ← <=> = cosine   ✓ MATCH → index walk

  if query used <->  (L2)                      ← mismatch       ✗ → seq scan, no error
  if query used <#>  (inner product)           ← mismatch       ✗ → seq scan, no error
```

### Move 2 (the B-trees) — the boring, essential ones

**PK btree on `id` powers ON CONFLICT.** `upsert()`'s `ON CONFLICT (id) DO UPDATE` needs to find an existing row by `id` instantly — that's the primary-key B-tree doing an exact O(log n) lookup. Without it, every upsert would scan the heap to check for a duplicate.

**`btree(app_id)` filters the search.** `search()` has `WHERE app_id = $2`. With one app_id (`'laptop'`) on a laptop, this index earns little today — but it's the seam that makes multi-tenant search possible without rescanning. Honest read: **on a single-app database it's nearly dead weight; it's a forward bet on multi-app.**

### Move 3 — the principle

Indexes turn scans into jumps, but the *kind* of index decides what you're promised. B-trees promise the exact row. ANN indexes like HNSW promise *probably the nearest* rows — fast, with a recall knob (`ef_search`) you tune against your latency budget. The trap unique to vector search: the index opclass and the query operator must agree, or you silently fall back to scanning everything.

---

## Primary diagram

Every index on `chunks`, what query reaches it, exact vs approximate.

```
  agents.chunks — three indexes, three jobs

                    ┌─ agents.chunks heap ─┐
                    │ (8KB pages of tuples)│
                    └──────────┬───────────┘
        ┌──────────────────────┼──────────────────────────┐
        ▼                      ▼                           ▼
  ┌─ PK btree(id) ─┐   ┌─ btree(app_id) ─┐   ┌─ HNSW(embedding,vector_cosine_ops)─┐
  │ EXACT          │   │ EXACT filter    │   │ APPROXIMATE NN                      │
  │ O(log n)       │   │ O(log n+match)  │   │ greedy graph walk, ef_search=40     │
  │                │   │                 │   │ ★ <=> operator MUST match opclass ★ │
  └───────┬────────┘   └────────┬────────┘   └──────────────┬──────────────────────┘
          │                     │                           │
   ON CONFLICT (id)      WHERE app_id=$2        ORDER BY embedding <=> $1 LIMIT k
   (upsert dedup)        (search filter)        (the RAG retrieval hot path)
```

---

## Implementation in codebase

**Use cases.** The HNSW index is hit on every `chat` turn and every `eval` query — it's the retrieval hot path, and it now also serves episodic-memory recall (memory chunks live in the same `chunks` table and are queried by the same `search_knowledge_base` tool). The PK btree is hit on every chunk upsert (dedup — including memory writes via `memory.remember`, `src/session.ts:67`) and every document upsert. The `app_id` btree is hit on every search filter.

```
  sql/001_agents_schema.sql  (lines 28–30)  — the indexes declared

  create index if not exists chunks_embedding_hnsw
    on agents.chunks using hnsw (embedding vector_cosine_ops);
                                  └─ opclass: cosine. MUST pair with <=>.
                                     No (m=…, ef_construction=…) → defaults.
  create index if not exists chunks_app_id on agents.chunks (app_id);
                                  └─ btree filter. Near-idle with one app_id;
                                     a forward bet on multi-tenant search.
```

```
  src/pg-vector-store.ts  (lines 73–75)  — the query that MUST match

  from agents.chunks
  where app_id = $2                       ← uses btree(app_id)
  order by embedding <=> $1::vector       ← uses HNSW … IF operator matches opclass
  limit $3
       │
       └─ <=> is cosine distance — it pairs with vector_cosine_ops on line 29.
          Change this to <-> and the index is bypassed: same result, full scan,
          no error. This single operator is the alignment the index lives or
          dies on.
```

```
  src/pg-vector-store.ts  (lines 48–54)  — ON CONFLICT rides the PK btree

  insert into agents.chunks (id, …) values ($1, …)
  on conflict (id) do update set …       ← PK btree(id) finds the dup in O(log n)
       │
       └─ re-indexing a document re-upserts every chunk by its stable id
          ("<docId>#<index>"). Without the PK btree, each upsert would
          heap-scan to detect the conflict.
```

The `vector_cosine_ops` ↔ `<=>` pairing is also annotated in the code itself — `src/pg-vector-store.ts:69` carries the comment `// <=> is cosine DISTANCE; cosine similarity score = 1 - distance.`

---

## Elaborate

HNSW (Hierarchical Navigable Small World, Malkov & Yashunin 2016) won over the older IVFFlat approach for most workloads because it has no "training" step and degrades gracefully — you can insert into it incrementally, which matches buffr's "index a doc, search immediately" loop. IVFFlat partitions vectors into lists and needs a representative sample to build the lists; HNSW just adds nodes to the graph. pgvector ships both; buffr chose HNSW (the better default for read-heavy, incremental-write RAG).

The exact-vs-approximate tradeoff is the whole game in vector search. For RAG specifically, approximate is usually fine: you're feeding the top-k to an LLM that tolerates a slightly-off retrieval. But you only *know* it's fine if you measure recall against an exact baseline — which is exactly the gap `eval-cmd.ts` has (it scores P@1/R@3 on the approximate results, never comparing to an exact scan). Cross-link `study-performance-engineering` for the latency side of the `ef_search` dial; cross-link `study-ai-engineering` for what retrieval recall does to answer quality.

This is the same pgvector + HNSW pattern you shipped in AdvntrCue — buffr is the local-first restatement of it.

---

## Interview defense

**Q: What kind of index backs the vector search, and what does it actually guarantee?**

HNSW — a navigable small-world graph, not a tree. It does approximate nearest-neighbor: a greedy graph walk that can miss the true top-k. It trades exact correctness for ~log-time search. The recall knob is `ef_search` (search width); buffr runs the pgvector default and never tunes it.

```
  greedy graph walk → "probably the nearest" → not guaranteed exact
       │
  ef_search = recall dial (default 40, untuned)
```

Anchor: *"It's approximate by design — fast neighbors, not certain ones. The recall knob is ef_search."*

**Q: What's the one line that would silently break vector search?**

Changing the distance operator without rebuilding the index. The index is `vector_cosine_ops` and the query uses `<=>` (cosine). Switch the query to `<->` (L2) and the planner can't use the index — it full-scans every vector. No error, just slow.

```
  index opclass  ─── must equal ───  query operator
  vector_cosine_ops                  <=>
       mismatch → silent seq scan
```

Anchor: *"Operator and opclass are a matched pair; mismatch them and you scan everything with no error."*

---

## Validate

1. **Reconstruct:** Draw the HNSW layered graph and trace a greedy descent. Where does it risk missing the true nearest neighbor?
2. **Explain:** Why does `chunks_embedding_hnsw` (`sql/001_agents_schema.sql:28-29`) only help when the query uses `<=>`?
3. **Apply:** Retrieval feels like it's missing relevant chunks. Which single index parameter would you raise first, and which file declares the index? (Hint: `ef_search`; index at `sql/001_agents_schema.sql:28`.)
4. **Defend:** Someone wants exact nearest-neighbor "to be safe." For a RAG agent feeding an LLM, argue for keeping HNSW approximate.

---

## See also

- `02-records-pages-and-storage-layout.md` — the HNSW index's own copy of the vectors
- `04-query-planning-and-execution.md` — how the planner chooses the index walk
- `09-database-systems-red-flags-audit.md` — untuned ef_search ranked as a risk
- `study-performance-engineering` — the latency side of the ef_search dial
- `study-ai-engineering` — retrieval recall's effect on answer quality

---

Updated: 2026-06-24 — `every ask` → `every chat turn`; noted the HNSW + PK btrees now also serve episodic-memory chunks written via `memory.remember` (`src/session.ts:67`), which share the same `chunks` table.
