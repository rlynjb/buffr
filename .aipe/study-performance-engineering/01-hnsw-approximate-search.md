# HNSW Approximate Search

**Industry names:** approximate nearest-neighbor (ANN) search · HNSW (Hierarchical
Navigable Small World) index · vector similarity search. **Type:** Industry standard.

---

## Zoom out, then zoom in

Every chat turn, buffr has to answer one question: *of the thousands of chunk embeddings
in the database, which `k` are closest to this query's embedding?* The naive answer is
"compare against all of them." HNSW is the thing that lets you skip almost all of them and
still get the right answer. It's the main performance win in the entire system — and it's
exactly one SQL clause.

```
  Zoom out — where HNSW sits in a chat turn

  ┌─ Session layer (src/session.ts) ───────────────────────────┐
  │  ask()  →  agent.answer()  →  search_knowledge_base tool    │
  └─────────────────────────────────┬──────────────────────────┘
                                     │  embed query (768-dim vector)
  ┌─ Storage layer (PgVectorStore) ─▼──────────────────────────┐
  │  search(vector, k)                                          │
  │    ┌──────────────────────────────────────────────────┐    │
  │    │ ★ ORDER BY embedding <=> $1 LIMIT k ★             │ ←  we are here
  │    │   HNSW index does the work, not a full scan       │    │
  │    └──────────────────────────────────────────────────┘    │
  └─────────────────────────────────┬──────────────────────────┘
                                     │  pgvector + HNSW (sql/001:28-29)
  ┌─ Postgres ─────────────────────▼───────────────────────────┐
  │  agents.chunks  ·  embedding vector(768)  ·  cosine index   │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **approximate** nearest-neighbor. You trade a tiny, tunable amount
of recall (you might miss a true top-k result occasionally) for a massive drop in work —
from comparing against every row (linear) to walking a graph (roughly logarithmic). The
question this file answers: how does one `ORDER BY ... <=> ... LIMIT k` become sub-linear,
and what knobs is buffr leaving at their defaults?

---

## Structure pass

**Layers.** Three: the SQL query buffr writes (`pg-vector-store.ts:70-77`), the pgvector
operator `<=>` that computes cosine distance, and the HNSW index underneath that decides
*which rows to even compute distance for*.

**Axis — cost (work per query).** Hold "how many distance computations happen?" constant
and trace it down:

```
  One question — "how many distance comparisons per query?" — down the layers

  ┌──────────────────────────────────────────────┐
  │ SQL: ORDER BY embedding <=> $1 LIMIT k        │  → looks like "compare all, sort, take k"
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ pgvector <=> operator                     │  → one cosine distance per row IT VISITS
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ HNSW index                            │  → visits ~log(N) rows, not all N
          └──────────────────────────────────────┘

  the SQL reads like a linear scan; the index makes it sub-linear. that gap IS the win.
```

**Seam — the index decision.** The load-bearing seam is between "the query as written" and
"the rows actually visited." A plain B-tree can't help an `ORDER BY distance` query; the
HNSW index is what flips this from O(N) to ~O(log N). That seam is created at
`sql/001_agents_schema.sql:28-29` — and it's where the untuned knobs live.

---

## How it works

### Move 1 — the mental model

You know how a binary search tree lets you find a value without scanning every node —
you follow pointers, halving the search space each hop? HNSW is that idea generalized to
high-dimensional space: a layered graph where each node (a chunk embedding) links to its
nearest neighbors, and you *navigate* toward the query by greedily hopping to whichever
neighbor is closer. The strategy in one sentence: **don't compare against everything;
walk a graph of "who's near whom" and follow the gradient toward the query.**

```
  HNSW — the navigable graph (simplified, 2 layers)

  query ●                          layer 1 (sparse, long hops)
         ╲                          ┌───┐        ┌───┐
          ╲ enter here ───────────► │ A │───────►│ B │   greedy: hop to closer neighbor
           ╲                        └─┬─┘        └─┬─┘
            ╲                         │ drop down  │
             ▼                      ┌─▼─┐  ┌───┐ ┌─▼─┐    layer 0 (dense, short hops)
          ┌───┐  ┌───┐  ┌───┐       │ A │─►│ c │►│ B │─►..  refine until no neighbor
          │ . │  │ . │  │ . │       └───┘  └───┘ └───┘      is closer → those are top-k
          └───┘  └───┘  └───┘
        NOT VISITED (the win: most rows are never touched)
```

You enter at a sparse top layer, take long hops to get into the right neighborhood fast,
then drop into denser layers for fine-grained refinement. The rows you never visit are the
rows you never pay for — that's the sub-linear behavior.

### Move 2 — the walkthrough

**The query buffr actually writes.** Here is the entire search, `pg-vector-store.ts:67-85`:

```ts
async search(vector: number[], k: number): Promise<Hit[]> {
  this.assertDim(vector);                              // ← guard: 768-dim or throw
  const { rows } = await this.pool.query(
    `select id, content, chunk_index, document_id, meta,
            1 - (embedding <=> $1::vector) as score    // ← cosine SIMILARITY = 1 - distance
     from agents.chunks
     where app_id = $2                                 // ← partition filter (multi-tenant)
     order by embedding <=> $1::vector                 // ← THE ANN clause: order by distance
     limit $3`,                                        // ← stop at k — this is what makes
    [toVectorLiteral(vector), this.appId, k],          //   the index worth using
  );
  ...
}
```

The load-bearing line is the `order by embedding <=> $1::vector ... limit $3` pair. `<=>`
is pgvector's cosine-distance operator. `ORDER BY <distance> LIMIT k` is the exact query
shape pgvector's HNSW index is built to accelerate — without the `LIMIT`, Postgres would
have to order *all* rows and the index buys you nothing. The `LIMIT k` is what lets the
index stop after collecting k good candidates.

**The index that makes it sub-linear.** The query above is only fast because of this, at
`sql/001_agents_schema.sql:28-29`:

```sql
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);
```

`using hnsw` builds the navigable graph. `vector_cosine_ops` tells it to build that graph
under cosine distance — which has to match the `<=>` operator the query uses, or the index
won't be used at all. That match is the seam: query operator and index opclass must agree.

**The load-bearing skeleton — what breaks if you remove each part:**

```
  HNSW search kernel — name each part by what breaks without it

  1. the distance operator (<=>)      remove → no notion of "near"; can't rank at all
  2. ORDER BY distance                remove → rows come back unordered; not nearest-first
  3. LIMIT k                          remove → must rank ALL rows; index gives no speedup
  4. matching opclass (cosine)        mismatch → planner ignores the index, full scan
  5. the HNSW index itself            remove → correct results, but O(N) linear scan
```

Strip the index (part 5) and the query still returns *correct* answers — just slowly, by
brute force. Strip the `LIMIT` (part 3) and even with the index you're back to ranking
everything. That's the recognition test: the index and the `LIMIT k` are a pair.

**Where it's untuned — the honest part.** HNSW has three knobs, and buffr sets none of them:

```
  knob              where it lives        what it controls          buffr's value
  ────────────────  ────────────────────  ────────────────────────  ──────────────
  m                 CREATE INDEX WITH(...) graph connectivity        DEFAULT (16)
  ef_construction   CREATE INDEX WITH(...) build-time accuracy       DEFAULT (64)
  ef_search         SET hnsw.ef_search    query-time recall↔latency  DEFAULT (40)
```

The `CREATE INDEX` at `sql/001:28-29` has no `WITH (m = ..., ef_construction = ...)`
clause, and there is no `SET hnsw.ef_search` anywhere in the query path
(`pg-vector-store.ts:70-77` sets nothing). So the recall-vs-latency tradeoff is running on
pgvector's defaults, unmanaged. **Does it matter at laptop scale? No — not yet.** The
defaults are tuned for exactly this regime: a modest corpus where even a near-linear scan
would be fast. It becomes a real lever past roughly 10^5 chunks, where `ef_search` is the
dial you'd turn to trade a few ms of latency for a few points of recall.

### Move 2.5 — current state vs future state

```
  Phase A — now (small corpus)          Phase B — large corpus (not yet reached)
  ──────────────────────────────        ─────────────────────────────────────────
  index untuned, defaults fine          ef_search becomes the recall/latency dial
  recall ~perfect (few rows total)      raise ef_search → better recall, slower query
  latency dominated by gemma2, not      lower ef_search → faster, may miss true top-k
  the search                            m / ef_construction set at build for the corpus
  → nothing to change                   → tune, then re-run eval-cmd.ts to verify recall
```

The eval harness (`eval-cmd.ts`) is already the instrument that would verify a tuning
change: change `ef_search`, re-run, watch mean R@3. The dial and the gauge both exist; the
corpus just isn't big enough yet to need them.

### Move 3 — the principle

Approximate-nearest-neighbor is a recall-for-speed trade you get to *tune*, not a binary.
The discipline isn't "use HNSW" — it's "know which knob trades which axis, and measure the
result before and after." buffr has the index and the eval gauge; what it hasn't done yet
is connect them, because at this scale it doesn't have to.

---

## Primary diagram

```
  HNSW approximate search — full path, one chat turn

  ┌─ Service: PgVectorStore.search() ───────────────────────────────────┐
  │  assertDim(768) → build query → pool.query(...)                      │
  └───────────────────────────────────┬─────────────────────────────────┘
                                       │ SQL over warm pool
  ┌─ Postgres + pgvector ─────────────▼─────────────────────────────────┐
  │  ORDER BY embedding <=> $query  LIMIT k                              │
  │     │                                                                │
  │     ▼  uses ↓                                                        │
  │  ┌─ HNSW index (chunks_embedding_hnsw, vector_cosine_ops) ────────┐  │
  │  │  enter top layer → greedy hops → drop layers → refine          │  │
  │  │  visits ~log(N) rows  ·  knobs m / ef_construction / ef_search │  │
  │  │  ★ all three at DEFAULT — untuned (sql/001:28-29) ★            │  │
  │  └────────────────────────────────────────────────────────────────┘  │
  │     │                                                                │
  │     ▼ top-k rows                                                     │
  │  score = 1 - distance  →  rebuild meta {docId, chunkIndex, text}     │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

HNSW comes from the 2016 Malkov & Yashunin paper; it won as the default ANN index because
it's incremental (you can insert without rebuilding) and gives excellent recall/latency
without the training step that IVF or product-quantization indexes need. pgvector added
HNSW in 0.5.0, which is why it's available here.

The thing worth internalizing: buffr's `<=>` + `LIMIT k` is the *same retrieval shape* as
AdvntrCue's pgvector RAG in Rein's portfolio. Swap the vector store (pgvector → Pinecone →
Qdrant) and this exact pattern survives — embedding + ANN + top-k retrieval. The vendor is
incidental; the pattern transfers. That's why it earns the lead pattern file.

---

## Interview defense

**Q: Your vector search is `ORDER BY ... LIMIT k`. Isn't that a full sort of every row?**

It reads like one, but no — there's an HNSW index on the embedding column
(`chunks_embedding_hnsw`, cosine opclass). The planner uses it to walk a navigable graph
and collect the k nearest candidates without ranking the whole table. The `LIMIT k` is
load-bearing: drop it and the index gives no speedup, because now I genuinely do have to
order everything.

```
  with LIMIT k:    index walks ~log(N) rows → k results        sub-linear
  without LIMIT:   must rank all N rows                         linear, index useless
```

The part people forget: **the index opclass and the query operator must match.** My index
is `vector_cosine_ops` and my query uses `<=>` (cosine distance). If I'd built the index
for L2 distance, the planner would silently ignore it and fall back to a full scan — same
correct answers, no speedup, and nothing in the query would look wrong.

**Anchor:** `pg-vector-store.ts:70-77` (the query) + `sql/001:28-29` (the index). And I'll
say the honest part — the index is untuned (no `m`/`ef_construction`/`ef_search`), which is
correct for my corpus size and would be the first dial I'd turn past ~10^5 chunks.

---

## See also

- `02-embedding-roundtrip.md` — where the query vector comes from before search runs.
- `06-no-caching.md` — the query embed that feeds this search is recomputed every time.
- `audit.md` §5 (io-network-and-database) and §8 (red flag #2, untuned index).
- `study-database-systems` — HNSW index internals, storage layout, planner behavior.
