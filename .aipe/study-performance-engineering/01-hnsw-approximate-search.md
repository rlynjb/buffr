# Approximate Nearest-Neighbour Search — the HNSW index

**Industry name(s):** approximate nearest-neighbour search (ANN); Hierarchical Navigable Small World graph (HNSW). **Type:** Industry standard.

This is the single most consequential performance mechanism in buffr's retrieval path — and the one place where the repo leaves a known dial untouched.

## Zoom out, then zoom in

Here's the whole thing. When you ask buffr a question, the query has to find the handful of most-relevant chunks out of every chunk you've ever indexed. The naive way compares your query against *every* row — linear in corpus size. The way buffr actually does it is sub-linear, and that's the win.

```
  Zoom out — where ANN search lives

  ┌─ Session layer ─────────────────────────────────────────────┐
  │  src/session.ts  agent.answer(question)                      │
  └───────────────────────────┬──────────────────────────────────┘
                  embed query  │  (Ollama → 768-dim vector)
  ┌─ Storage layer ───────────▼──────────────────────────────────┐
  │  PgVectorStore.search()   src/pg-vector-store.ts:67           │
  │     ★ HNSW approximate search via `<=>` + LIMIT k ★           │ ← we are here
  │     order by embedding <=> $query  limit k                    │
  └───────────────────────────┬──────────────────────────────────┘
                              │  graph traversal, not table scan
  ┌─ pgvector / Postgres ─────▼──────────────────────────────────┐
  │  agents.chunks  USING hnsw (embedding vector_cosine_ops)      │
  │  sql/001_agents_schema.sql:28-29                              │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **approximate nearest-neighbour search** — trading exact correctness for speed. You don't get *the* k closest vectors guaranteed; you get k vectors that are *almost certainly* the closest, in a fraction of the time. The "almost" is the whole bargain, and it's tunable. buffr takes the default bargain.

## The structure pass

Trace one axis — **cost** (compute per query) — across the layers, and watch where it flips.

```
  axis = "compute per query"  — traced down the stack

  ┌─ query string ──────────────────┐   → O(1) to hand off
  └─────────────────┬────────────────┘
  ┌─ embed ────────▼────────────────┐   → one model forward pass (Ollama)
  └─────────────────┬────────────────┘
  ┌─ HNSW search ──▼────────────────┐   ═══ THE FLIP ═══
  │  exact: O(N) full scan          │   default would be linear
  │  HNSW:  ~O(log N) graph walk    │   ← seam: linear → sub-linear
  └─────────────────┬────────────────┘
  ┌─ return k rows ▼────────────────┐   → O(k), k≈3-4
  └──────────────────────────────────┘
```

**Layers:** query → embed → search → return. **Seam:** the HNSW index is the load-bearing boundary — on one side a query against `agents.chunks` would be a sequential scan computing cosine distance for every row; on the other side it's a navigable-graph walk that visits a tiny fraction of nodes. The cost axis flips from `O(N)` to roughly `O(log N)` exactly there. That flip *is* the pattern.

## How it works

### Move 1 — the mental model

You know how a binary search tree turns an `O(N)` scan into an `O(log N)` descent by giving you a structure that lets you skip most of the data? HNSW is that idea for high-dimensional vectors — except the structure is a multi-layer graph instead of a tree, and the descent is "greedily hop to the neighbour closest to my query" instead of "go left or right."

```
  HNSW — the navigable-graph kernel

  layer 2 (sparse, long hops)    ●─────────────●
                                  │             │
  layer 1 (denser)          ●────●────●────●────●
                                  │    │    │
  layer 0 (every node)   ●─●─●─●─●─●─●─●─●─●─●─●─●
                              ▲                ▲
                          enter here      query lands near here
                          (top), greedily   → return k nearest
                          descend toward
                          the query vector
```

The plain-English strategy: enter at the sparse top layer, greedily walk toward your query vector taking big hops, then drop a layer and repeat with smaller hops, until at the bottom layer you're among the true nearest neighbours. You never touch most of the graph. That's the sub-linear cost.

### Move 2 — the step-by-step walkthrough

**The query operator.** This is where the index gets used. In `PgVectorStore.search` (`src/pg-vector-store.ts:67-78`):

```ts
const { rows } = await this.pool.query(
  `select id, content, chunk_index, document_id, meta,
          1 - (embedding <=> $1::vector) as score   // <=> is cosine DISTANCE
   from agents.chunks
   where app_id = $2
   order by embedding <=> $1::vector                // ← THIS line triggers HNSW
   limit $3`,                                        // ← LIMIT k is what makes it ANN
  [toVectorLiteral(vector), this.appId, k],
);
```

The load-bearing parts, named by what breaks without each:

- `order by embedding <=> $1::vector` — drop this and Postgres has no reason to use the HNSW index; it scans. The ordering-by-distance is the literal trigger for the graph walk.
- `limit $3` (the `k`) — drop the LIMIT and you've asked for *all* rows sorted by distance, which forces a full computation. The bounded `k` is what lets HNSW stop early. **This is the part people forget:** without the LIMIT, the index can't help you — ANN is "nearest *k*," and the *k* is load-bearing.
- `where app_id = $2` — a filter applied alongside the vector search. At buffr's scale this is fine, but a selective filter combined with HNSW is the classic pgvector sharp edge: the index returns its best `k` *then* filters, so an aggressive `app_id` filter on a large corpus can return fewer than `k` results. Not a problem at one `app_id` = `'laptop'`, worth knowing.

**The index definition — and the dials that aren't set.** The whole performance character lives in `sql/001_agents_schema.sql:28-29`:

```sql
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);
  -- no  WITH (m = ..., ef_construction = ...)
  -- and no  SET hnsw.ef_search = ...  at query time
```

```
  the three HNSW dials — none set in this repo

  ┌─ build time ──────────────┬─ effect ──────────────────────────┐
  │  m (default 16)           │  graph connectivity; higher = better
  │                           │  recall, bigger index, slower build │
  │  ef_construction (def 64) │  build-time search width; higher =  │
  │                           │  better recall, slower build        │
  ├─ query time ──────────────┼───────────────────────────────────┤
  │  ef_search (default 40)   │  query-time search width; higher =  │
  │                           │  better recall, slower query        │
  └───────────────────────────┴───────────────────────────────────┘
   buffr uses all three defaults → the default speed/recall bargain
```

What breaks if you ignore these: nothing, at small corpus size — the defaults give good recall when there are few chunks. What breaks at scale: as the corpus grows, default `ef_search=40` can start missing true neighbours, and you'd see precision@k drop in the eval harness (`src/cli/eval-cmd.ts`) without knowing why. The fix is `SET hnsw.ef_search` higher and re-measure — but **you can't tune what you don't measure**, and the latency side of that curve isn't measured yet (audit lens 2).

### Move 2.5 — current state vs future state

```
  Phase A (now)                    Phase B (tune when corpus grows)
  ─────────────                    ──────────────────────────────
  HNSW with defaults               HNSW with m / ef_construction set
  ef_search = 40 (implicit)        ef_search raised per recall target
  recall: good at small N          recall: held as N grows
  latency: unmeasured              latency: measured against ef_search
  → the right call now             → gated on: eval precision dropping
                                      OR a measured latency budget
```

What *doesn't* have to change: the query in `search()` stays identical — tuning is a `SET` and an index rebuild, not a code change. The `PgVectorStore` contract is untouched. That's the payoff of having the dial live in the index, not the application.

### Move 3 — the principle

Approximate nearest-neighbour search is a speed-for-correctness trade, and the trade is *tunable*, not fixed. The generalizable lesson: when a system gives you a knob between "fast" and "correct," shipping the default is the right first move — but only if you've also built the measurement that tells you when the default stops being good enough. buffr has the first half. The HNSW index is the main retrieval win and it's free; the unfinished work is the recall-vs-latency curve that would tell you when to turn the dial.

## Primary diagram

```
  ANN search, full path — one query through the HNSW index

  ┌─ Session ────────────────────────────────────────────────────┐
  │  question ──embed(Ollama)──► 768-dim query vector             │
  └───────────────────────────────┬───────────────────────────────┘
                                  │  toVectorLiteral → '[0.1,0.2,...]'
  ┌─ PgVectorStore.search ───────▼───────────────────────────────┐
  │  order by embedding <=> $q   ← triggers HNSW graph walk       │
  │  where app_id = 'laptop'     ← post-filter                    │
  │  limit k (≈3-4)              ← bounds the search, enables ANN │
  └───────────────────────────────┬───────────────────────────────┘
  ┌─ pgvector ───────────────────▼───────────────────────────────┐
  │  HNSW: enter top layer → greedy descend → bottom-layer k-NN   │
  │  dials: m, ef_construction (build) · ef_search (query) = ALL  │
  │         DEFAULT                                                │
  └───────────────────────────────┬───────────────────────────────┘
                                  │  k rows, score = 1 - distance
  ┌─ back to Session ────────────▼───────────────────────────────┐
  │  hits → search_knowledge_base tool → gemma2:9b (DOMINANT cost)│
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

HNSW comes from Malkov & Yashunin (2016), building on the small-world-graph idea — that you can navigate a huge graph in a few hops if it has a mix of short and long edges. pgvector added HNSW in 0.5.0 as the higher-recall alternative to its earlier IVFFlat index. The reason it dominates ANN in practice: it builds incrementally (no training step, unlike IVFFlat which needs a `CREATE INDEX` over existing data to pick centroids), so it works well when you're inserting chunks over time — exactly buffr's index-as-you-go pattern.

For how the graph traversal actually executes inside Postgres — buffer pages, the index scan node, why `order by ... limit` is a Top-N — see **`study-database-systems`** (query execution + indexes). For why this is the right vector-store choice for a single-Postgres-instance RAG app, see **`study-ai-engineering`** (retrieval). This file owns the *performance* read: the cost flip and the untuned dials.

## Interview defense

**Q: Your vector search is `order by embedding <=> $q limit k`. Walk me through why that's fast.**

> The `<=>` is cosine distance, and the `order by ... limit k` is what lets pgvector use the HNSW index instead of scanning every chunk. HNSW is a multi-layer navigable graph — you enter at a sparse top layer, greedily hop toward the query vector, drop layers as you go, and end up among the true nearest neighbours having touched a tiny fraction of nodes. That turns an `O(N)` distance computation over the whole table into roughly `O(log N)`. The LIMIT is load-bearing — it's "nearest *k*", and without the bound the index can't stop early.

```
  enter top → greedy descend → k-NN at bottom layer
  O(N) scan ───────────────────► ~O(log N) walk
              the LIMIT k is what enables the early stop
```

**Q: What's the weakness in how you set it up?**

> It's untuned — I'm on pgvector's defaults for `m`, `ef_construction`, and `ef_search`. That's the right call at my corpus size because defaults give good recall when N is small, and the cost is already paid. The honest gap is that I haven't measured the recall-vs-latency curve, so I can't yet tell you *when* the default `ef_search=40` starts dropping true neighbours. The fix is `SET hnsw.ef_search` and re-run my precision eval — but I'd want the latency instrumentation closed first so I'm trading against a number, not a guess.

> Anchor: `src/pg-vector-store.ts:70-78` (the query), `sql/001_agents_schema.sql:28-29` (the untuned index).

## See also

- `00-overview.md` — finding #1, where this ranks
- `audit.md` — lens 5 (I/O bottlenecks), lens 8 (red flags #2)
- `02-embedding-roundtrip.md` — the embed step that feeds this search
- `06-no-caching.md` — why an identical query re-runs this whole path
- **`study-database-systems`** — how the HNSW index executes inside Postgres
- **`study-ai-engineering`** — retrieval pipeline + vector store choice
