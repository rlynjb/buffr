# RAG query path — embed → ANN cosine → rank → ground

> Updated: 2026-06-24 — `ask-cmd.ts` references retargeted to `src/session.ts` (the `chat` surface); noted that this same path now also surfaces recalled memory rows (see `08-conversation-memory.md`).

**Industry name(s):** RAG retrieval / dense retrieval over a vector index · Language-agnostic pattern.

## Zoom out, then zoom in

This is the read side of RAG — what runs every time the agent decides to search. A natural-language query comes in, gets embedded into the same 768-dim space as the corpus, and the nearest chunks by cosine distance come back ranked. It's the half of RAG that determines answer quality: a great model over bad retrieval still gives bad answers.

```
  Zoom out — where the query path lives

  ┌─ CLI / Agent layer ──────────────────────────────────────┐
  │  session.ts → agent → search_knowledge_base tool          │
  └───────────────────────────┬──────────────────────────────┘
                              │  query string
  ┌─ Library layer ───────────▼──────────────────────────────┐
  │  pipeline.query  →  embedder.embed([query])  →  ★ search ★│ ← we are here
  └───────────────────────────┬──────────────────────────────┘
                              │  768-dim query vector
  ┌─ Storage layer (pgvector) ▼──────────────────────────────┐
  │  order by embedding <=> $1  limit k   (HNSW cosine ANN)   │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the query path is "find the k nearest neighbors of the query vector." The trick is that *nearness in embedding space approximates relevance in meaning* — so a query about "what I drink in the morning" finds a chunk about "coffee black, no sugar" even with zero shared words. The whole thing rests on the `<=>` cosine-distance operator and an HNSW index that makes nearest-neighbor search fast without scanning every row.

## Structure pass

Three layers, axis held constant: **what shape is the data, and how exact is the operation on it?**

```
  Axis traced = "data shape + how exact is the op?"

  ┌─ Pipeline: query string ────────────┐  text — exact, lossless
  └──────────────────┬───────────────────┘
                     │  seam ① — embed: text ═╪═ 768-dim vector
                     │  (meaning compressed into floats; lossy, one-way)
  ┌─ Store: search(vector, k) ──────────┐  vectors — approximate match
  │  cosine distance over HNSW           │  (ANN: fast, not guaranteed exact)
  └──────────────────┬───────────────────┘
                     │  seam ② — rank ═╪═ score = 1 - distance
  ┌─ Result: ranked Hits ───────────────┐  ordered list + citations
  │  top-k by score, meta rebuilt        │  (exact again, small + typed)
  └──────────────────────────────────────┘
```

The two seams are where the answer quality is won or lost. **Seam ①** (embed) is lossy and one-way — once "coffee black no sugar" is a vector, you can't read the meaning back out, you can only measure distance to other vectors. **Seam ②** (rank) is where ANN's approximation lives: HNSW returns *approximately* the k nearest, trading a tiny recall risk for sub-linear speed. The load-bearing point: retrieval quality is set entirely above the model — by the embedding model and the index — so when answers are wrong, you debug retrieval first, the model last.

## How it works

Mental model: you already know `Array.prototype.sort((a,b) => dist(a) - dist(b)).slice(0, k)` — sort by a distance function, take the top k. Dense retrieval is exactly that, where the distance function is cosine distance between embeddings and the "sort" is done by an HNSW index instead of a full scan.

```
  The query path — k-nearest-neighbors by cosine

  query "how does the author take their coffee"
     │
     ▼  embed → q = [0.12, -0.84, ..., 0.07]   (768-dim)
     │
     ▼  for each chunk vector c:  distance = cosine(q, c)
     │     (HNSW skips most chunks — graph walk, not full scan)
     │
   sort ascending by distance, take k:
     ┌──────────────────────────────────────────────┐
     │ coffee.md#0   dist 0.18   score 0.82  ← top   │
     │ work.md#2     dist 0.61   score 0.39          │
     │ stack.md#1    dist 0.74   score 0.26          │
     └──────────────────────────────────────────────┘
     │
     ▼  rebuild meta {docId, chunkIndex, text} → citations
```

### Step 1 — embed the query into the corpus space

`pipeline.query(query, k)` first calls `embedder.embed([query])` — the *same* nomic-embed-text provider that indexed the corpus. This is non-negotiable: query and corpus must share an embedding space or distances are meaningless. The pipeline's `assertWiring` guarantees the dimensions match. Boundary condition: if the query embedding comes back empty, the pipeline returns `[]` rather than searching with a bad vector.

### Step 2 — find the nearest chunks with the cosine operator

`PgVectorStore.search` runs the ANN query. The `<=>` operator is pgvector's **cosine distance** (0 = identical direction, 2 = opposite). The query orders by it ascending and limits to k — nearest first. The HNSW index (`vector_cosine_ops`) makes this a graph walk over a small fraction of chunks instead of computing distance to every row.

```
  Layers-and-hops — one search() call

  ┌─ buffr: PgVectorStore ─┐ hop 1: SQL with $1::vector  ┌─ pgvector ─┐
  │  search(vector, k)     │ ──────────────────────────► │  HNSW walk │
  │                        │ hop 4: rows {id,score,meta} │  cosine    │
  │                        │ ◄────────────────────────── │  <=> limit │
  └────────────────────────┘                             └─────┬──────┘
                                                    hop 2 graph │ descend
                                                    hop 3 collect│ top-k
```

### Step 3 — turn distance into a score

The SQL computes `1 - (embedding <=> $1::vector) as score`. Distance is "lower is closer"; the agent and the eval want "higher is better," so score flips it: cosine *similarity* = 1 − cosine *distance*. A score near 1 means tightly relevant, near 0 means barely related. Boundary condition: scope is `where app_id = $2` — multi-tenant isolation, so a `laptop` query never sees another app's chunks.

### Step 4 — rebuild the meta so citations survive

The store maps each row back into the in-memory `Hit` shape the search tool expects: `meta: { docId, chunkIndex, text }`. This is load-bearing for grounding — the search tool builds citations like `[coffee.md] I take my coffee black...` from this meta, and the agent cites those sources. Without the rebuild, the model would retrieve chunks it can't attribute.

### Move 3 — the principle

Dense retrieval is "sort by semantic distance, take the top k," made fast by an ANN index. The principle that generalizes: retrieval quality is upstream of model quality. The embedding model decides what "close" means; the index decides how fast and how exactly you find it. Everything the LLM does is downstream of those two choices, which is why "bad answer" almost always means "debug retrieval first."

## Primary diagram

The full query path, every layer labeled.

```
  buffr query path — full recap

  ┌─ Agent/Session: session.ts ───────────────────────────────┐
  │  search_knowledge_base({query, top_k})  →  pipeline.query  │
  └───────────────────────────┬────────────────────────────────┘
                              │  embedder.embed([query]) → q(768)
  ┌─ Store: PgVectorStore.search(q, k) ───────────────────────┐
  │  select id, content, meta,                                 │
  │    1 - (embedding <=> $1::vector) as score                 │
  │  from agents.chunks where app_id = $2                      │
  │  order by embedding <=> $1::vector limit $3                │
  └───────────────────────────┬────────────────────────────────┘
                              │  rows
  ┌─ Result mapping ──────────▼────────────────────────────────┐
  │  Hit{ id, score, meta:{docId, chunkIndex, text} }          │
  │  → search tool → citation "[docId] snippet..."             │
  └────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Runs inside `chat` every time the agent calls the search tool, inside `eval` once per labeled query to score retrieval, and inside memory `recall` (`08-conversation-memory.md`). All go through the same `pipeline.query` → `PgVectorStore.search` path — the eval measures the exact retrieval the agent uses, and memory rows ride the same ranked results.

**Code side by side.**

```
  src/pg-vector-store.ts  (lines 67–85, search)

  this.assertDim(vector);                              ← query must be 768-dim too
  const { rows } = await this.pool.query(
    `select id, content, chunk_index, document_id, meta,
            1 - (embedding <=> $1::vector) as score    ← distance → similarity
     from agents.chunks
     where app_id = $2                                 ← tenant isolation
     order by embedding <=> $1::vector                 ← HNSW cosine ANN, nearest first
     limit $3`,
    [toVectorLiteral(vector), this.appId, k]);
  return rows.map((r) => ({
    id: r.id, score: Number(r.score),
    meta: { ...(r.meta ?? {}), docId: r.document_id,
            chunkIndex: r.chunk_index, text: r.content }}); ← rebuild meta for citations
       │
       └─ order-by uses <=> directly (distance), score column uses 1-<=>
          (similarity) — same operator, two framings: ranking vs reporting
```

```
  src/session.ts  (line 43)

  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
       │
       └─ minTopK:4 forces at least 4 chunks back even if the model asks for
          fewer — a weak model that requests top_k:1 still gets enough context
          to ground an answer (a guardrail against under-retrieval)
```

```
  src/cli/eval-cmd.ts  (lines 25–28)

  const hits = await pipeline.query(query, K);          ← same path the agent uses
  const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];
  const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;
  const r = scoreRecallAtK(docs, new Set(relevant), K).score;
       │
       └─ dedupes to docIds before scoring — two chunks from the same doc count
          as one retrieved document, because relevance is per-doc here
```

## Elaborate

Dense retrieval comes from the observation that learned embeddings put semantically similar text near each other in vector space, so nearest-neighbor search over embeddings approximates relevance ranking. The `<=>` cosine operator and HNSW index are pgvector's implementation; the pattern survives a swap to Qdrant or Pinecone unchanged — only the operator syntax and index type move.

buffr's query path is dense-only. The audit names what that costs: no sparse/BM25 fallback for exact identifiers, no hybrid RRF fusion, no cross-encoder rerank to polish the top-k. At a 3-document personal corpus none of these earns its place yet. The first to matter would be reranking *if* precision@1 sags on a larger corpus — but you'd measure with `eval` before adding it, which is exactly the discipline `06-evals-precision-and-recall.md` covers.

What to read next: `05-embedding-model-choice.md` (why query and corpus must share the 768-dim space), then `03-agent-loop-with-tool-calling.md` (how the agent decides to call this path at all).

## Project exercises

> No `aieng-curriculum.md` present; exercises name the buildable target directly.

### Add a sparse fallback for exact terms

- **What to build:** A Postgres `tsvector` full-text column on `chunks` and a second retrieval path; fuse dense + sparse results with Reciprocal Rank Fusion.
- **Why it earns its place:** "I added hybrid retrieval and measured the recall lift with my own eval harness" is a strong RAG signal — most candidates only ever do dense.
- **Files to touch:** `sql/001_agents_schema.sql` (tsvector column + GIN index), `src/pg-vector-store.ts` (a `searchSparse` + an RRF merge), `src/cli/eval-cmd.ts` (compare dense-only vs hybrid recall).
- **Done when:** `eval` prints recall@3 for dense-only and hybrid side by side, and hybrid is ≥ dense on the labeled set.
- **Estimated effort:** 1–2 days.

### Instrument retrieval latency per query

- **What to build:** Wrap `PgVectorStore.search` to record embed time vs SQL time and emit it to the trace sink.
- **Why it earns its place:** Shows you can find the slow link in a RAG request (the "spans" pillar of LLM observability).
- **Files to touch:** `src/pg-vector-store.ts`, `src/supabase-trace-sink.ts` (handle a timing event).
- **Done when:** a `chat` turn writes per-search embed-ms and query-ms into `agents.messages` or a sibling table.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: How does retrieval actually find relevant chunks with no keyword match?**

```
  query → embed → q(768)
  order by embedding <=> q   (cosine distance, HNSW)
  "morning drink" finds "coffee black" — close in vector space, zero shared words
```

"The query is embedded into the same 768-dim space as the corpus, then I rank chunks by cosine distance using pgvector's `<=>` operator over an HNSW index. Semantic nearness approximates relevance, so paraphrases match without shared vocabulary." Anchor: nearness in embedding space ≈ relevance in meaning.

**Q: The most surprising/load-bearing detail?**

The score is `1 - (embedding <=> $1)` — the same operator is used twice, once as distance to rank and once flipped to similarity to report. "And the meta rebuild is what makes citations work — without mapping `document_id`/`content` back into `meta`, the agent retrieves chunks it can't attribute." Anchor: retrieval quality is upstream of the model; debug it first.

## Validate

- **Reconstruct:** Write the `search` SQL from memory, including the `where app_id` scope and both framings of `<=>`. (`src/pg-vector-store.ts:70`)
- **Explain:** Why must `embedder.embed` be the same provider for query and corpus? What enforces it? (`pipeline.js` `assertWiring`; `src/session.ts:40`)
- **Apply:** A query for an exact error code `"E_DIM_768"` returns nothing useful. Diagnose why dense-only retrieval struggles here and name the fix. (`src/pg-vector-store.ts:67`)
- **Defend:** `minTopK: 4` overrides the model's requested `top_k`. Defend that guardrail and name what it costs. (`src/session.ts:43`)

## See also

- `01-rag-index-path.md` — the write side that produced these chunks.
- `05-embedding-model-choice.md` — the shared 768-dim space both paths depend on.
- `06-evals-precision-and-recall.md` — how this path is scored.
- `.aipe/study-database-systems/03-btree-hash-and-secondary-indexes.md` — the HNSW index mechanics under `<=>`.
- `.aipe/study-dsa-foundations/05-graphs-and-traversals.md` — HNSW is a navigable-graph nearest-neighbor walk.
