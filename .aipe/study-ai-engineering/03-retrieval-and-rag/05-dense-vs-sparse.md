# Dense vs sparse retrieval — buffr is dense-only

*Industry standard (NOT yet exercised). The exact-match blind spot of embedding search.*

## Zoom out, then zoom in

Pull up buffr's retrieval and notice what's *not* there. Every match is by embedding similarity — semantic, fuzzy, meaning-based. There is no second path that matches *exact words*. That second path is sparse retrieval (BM25), and buffr doesn't have it.

```
  Zoom out — buffr's retrieval has one lane, not two

  ┌─ Retrieval layer ──────────────────────────────────────────┐
  │  ┌─ DENSE (buffr HAS this) ─────────────────────────────┐   │
  │  │ ★ embed query → cosine ANN over agents.chunks ★      │   │ ← here
  │  └──────────────────────────────────────────────────────┘   │
  │  ┌─ SPARSE (buffr does NOT have this) ───────────────────┐   │
  │  │   BM25 / tsvector keyword match — MISSING             │   │
  │  └──────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────┘
  ┌─ Storage ───────────────────────────────────────────────────┐
  │  agents.chunks.embedding (768)  ·  content text (NOT indexed │
  │                                     for full-text search)    │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. You've shipped dense RAG, so dense is the familiar lane. The concept here is its *complement*: **sparse retrieval** matches on literal term overlap (like a search engine), and it's strong exactly where dense is weak — exact identifiers, rare terms, codes, names the embedding model barely saw. buffr is dense-only, so it inherits dense's blind spot. This file builds what sparse is, why the gap bites, and the Case-B move to add a Postgres `tsvector` lane.

## Structure pass

Read the skeleton: two retrieval families, traced on one axis.

**Layers:** query → matcher → ranked results — but there are two *kinds* of matcher, and buffr only has one.

**Axis traced — "what does a match mean?"**

```
  one axis: what counts as relevant?

  ┌─ DENSE (buffr has) ─────┐   MEANING — "renew passport" matches
  │  cosine over embeddings  │   "travel document expiry" (no shared word)
  └────────────┬────────────┘
               │ seam: the two families disagree on rare/exact terms
  ┌─ SPARSE (buffr lacks) ──┐   WORDS — "E4017" matches a chunk containing
  │  BM25 / tsvector         │   literally "E4017"; rare exact terms shine
  └─────────────────────────┘
```

**The seam that matters:** the boundary between *meaning-match* and *word-match*. Dense wins on paraphrase and synonyms; sparse wins on exact tokens the embedder smears together. buffr lives entirely on the dense side, so any query that hinges on an exact rare string — an error code, a product SKU, an unusual surname — is at the mercy of a model that probably never learned a sharp vector for it. Hold that: the gap isn't "dense is bad," it's "dense alone is half the toolkit."

## How it works

### Move 1 — the mental model

You know the difference between a fuzzy autocomplete that guesses what you *meant* and `Ctrl-F` that finds the *exact string*? Dense is the fuzzy guess; sparse is `Ctrl-F` with relevance ranking. Sparse retrieval (BM25 is the classic algorithm) scores a chunk by how many query terms it contains, weighted so rare terms count more and long documents don't win just by being long.

```
  the sparse kernel — score by weighted term overlap

  query: "passport E4017 renewal"
            │ split into terms
            ▼
  for each chunk: score = Σ over query terms of
                          (term frequency in chunk)
                        × (how RARE the term is overall)   ← IDF
                        ÷ (length normalization)
  → "E4017" is rare ⇒ a chunk containing it scores HIGH
    (dense would smear "E4017" ≈ "E4018" ≈ "E4019")
```

The kernel: term-frequency × inverse-document-frequency, length-normalized. The load-bearing piece is IDF — it's *why* sparse beats dense on rare exact terms: a term almost no document contains is a strong signal when it matches.

### Move 2 — the step-by-step walkthrough

**Step 1 — what buffr does today: dense only.** The query path embeds and runs cosine ANN. There is no keyword branch:

```ts
// aptkit packages/retrieval/src/pipeline.ts:55-58 (queryKnowledgeBase)
const [vector] = await wiring.embedder.embed([query]);
if (!vector) return [];
return wiring.store.search(vector, topK);     // ONLY a vector search — no BM25 lane
```

```ts
// src/pg-vector-store.ts:70-78 — the one and only matcher
order by embedding <=> $1::vector    -- cosine distance; meaning-match only
```

There's no `to_tsvector`/`to_tsquery`, no `ts_rank`, no full-text index on `content`. The `content` column is stored but never matched against by words. That's the whole gap in one observation: the text is *there*, just not *searchable by term*.

**Step 2 — where it bites, concretely.** Take a query like *"what's error E4017?"* over a corpus where exactly one chunk mentions `E4017`. Dense retrieval embeds `E4017` into a vector the model never learned sharply (rare token → mushy embedding), so the right chunk may not land in the top-k. A sparse matcher would rank that chunk first *because* `E4017` is rare and matches exactly.

```
  Comparison — same query, two families

  query: "error E4017"
  ┌─ DENSE (buffr) ──────────┐    ┌─ SPARSE (missing) ────────┐
  │ E4017 → mushy vector      │    │ E4017 → exact term match   │
  │ may miss the right chunk  │    │ rare term (high IDF) → top1│
  │ great for paraphrase      │    │ great for codes/ids/names  │
  └───────────────────────────┘    └────────────────────────────┘
  buffr only has the left box → rare exact terms are a blind spot
```

**Step 3 — the Case-B lane: a Postgres tsvector path.** The fix lives entirely in buffr's storage (Postgres already has full-text search built in). Add a `tsvector` column and a GIN index, then a second search method that ranks by `ts_rank` — a sibling to `search`, not a replacement:

```
  Layers-and-hops — adding the sparse lane (Case B)

  ┌─ query ──────┐ hop A: embed → cosine (existing)  ┌─ agents.chunks ──┐
  │ "error E4017"│ ─────────────────────────────────►│ embedding(768)    │
  └──────┬───────┘ hop B: to_tsquery → ts_rank (NEW)  │ content_tsv  ◄NEW │
         │        ─────────────────────────────────► │ (GIN index)       │
         ▼                                            └──────────────────┘
   two ranked lists → (combine later: see 06-hybrid-retrieval-rrf.md)
```

This file stops at "add the sparse lane." *Combining* the two ranked lists is reciprocal-rank fusion — that's `06-hybrid-retrieval-rrf.md`, the natural next file.

### Move 3 — the principle

Dense and sparse fail in opposite directions, which is exactly why mature retrieval runs both. Dense embeds *meaning* and goes blind on rare exact tokens; sparse matches *words* and goes blind on paraphrase. Choosing only one means accepting its specific blind spot forever. buffr chose dense — correct for a meaning-heavy personal corpus — but "dense-only" is a position to *hold consciously*, not a default to forget. The general lesson: when two methods have complementary failure modes, the question isn't "which one," it's "can I afford both."

## Primary diagram

The gap, one frame:

```
  buffr retrieval — dense lane present, sparse lane absent

  query
    │
    ├─► DENSE  (HAS)  embed → cosine ANN over embedding(768)
    │                 strong: paraphrase, synonyms, meaning
    │                 weak:   rare exact terms (E4017, SKUs, names)
    │
    └─► SPARSE (MISSING)  BM25 / tsvector over content
                      strong: exact rare terms (high IDF)
                      weak:   paraphrase
  ───────────────────────────────────────────────────────────
  today: only the dense lane runs → exact-rare-term blind spot
  Case B: add tsvector + GIN + ts_rank lane (then fuse via RRF, see 06)
```

## Elaborate

BM25 ("Best Matching 25") is the workhorse of classical IR — it's what Elasticsearch and Lucene rank with by default, a refinement of TF-IDF that adds term-frequency saturation and document-length normalization. "Sparse" refers to the representation: a document becomes a sparse vector over the whole vocabulary (mostly zeros, nonzero only for terms it contains), versus a "dense" embedding where all 768 dimensions are nonzero. Postgres ships sparse retrieval natively via `tsvector`/`tsquery` and `ts_rank`, so buffr needs *no new dependency* to add the lane — just a column, a GIN index, and a query.

The reason this matters more than it looks: real user queries are bimodal. Some are conceptual ("how do I think about X") where dense shines; others are lookup ("find the doc that says E4017") where sparse shines. A dense-only system quietly fails the second kind, and you won't notice without an eval that includes exact-term queries — which connects to the eval gap in `../05-evals-and-observability/`.

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so Build-item IDs are not cited. Exercises are derived directly from the codebase and the spec's concept set.

### Add a Postgres tsvector sparse lane

- **Exercise ID:** SPR-1 (Case B — buffr is dense-only; add sparse).
- **What to build:** add a `content_tsv tsvector` column (generated from `content`) and a GIN index to `agents.chunks`, then a `searchSparse(query, k)` method on `PgVectorStore` that ranks by `ts_rank(content_tsv, plainto_tsquery($1))`. Keep it a *sibling* to the existing dense `search`.
- **Why it earns its place:** it closes the exact-rare-term blind spot using Postgres's built-in FTS — no new dependency — and sets up hybrid fusion (`06`).
- **Files to touch:** `sql/001_agents_schema.sql:14-30` (add column + GIN index), `src/pg-vector-store.ts` (new `searchSparse` beside `search` at `:67-85`).
- **Done when:** a query for a rare exact term (e.g. an error code) returns the containing chunk via the sparse lane, proven by a test, while the dense lane misses it.
- **Estimated effort:** half a day.

### Build a dense-vs-sparse eval set

- **Exercise ID:** SPR-2 (Case B — measure the gap before fusing).
- **What to build:** a small labelled eval with two query buckets — paraphrase queries and exact-rare-term queries — and run precision@k for the dense lane vs the new sparse lane, demonstrating each wins its own bucket.
- **Why it earns its place:** it makes "dense and sparse fail in opposite directions" a measured fact, and justifies hybrid (`06`) with numbers.
- **Files to touch:** the eval path (`src/cli/eval-cmd.ts`), running both `search` and `searchSparse` from `src/pg-vector-store.ts`.
- **Done when:** the report shows dense winning paraphrase queries and sparse winning exact-term queries.
- **Estimated effort:** half a day. Cross-link `../05-evals-and-observability/`.

## Interview defense

**Q: Is buffr dense or sparse retrieval, and what does that cost you?**
Answer: dense-only — every match is cosine similarity over `nomic` embeddings; there's no BM25 or `tsvector` lane. The cost is the exact-rare-term blind spot: an error code or unusual name embeds to a mushy vector the model never learned sharply, so the right chunk can fall out of the top-k. Sparse retrieval would rank that chunk first because the term is rare (high IDF) and matches exactly. Dense and sparse fail in opposite directions, so dense-only accepts dense's specific failure forever.

```
  dense: meaning-match  → great paraphrase, blind on "E4017"
  sparse: word-match    → great "E4017", blind on paraphrase
  buffr has only the first lane
```

**Q: How would you add sparse without a new dependency?**
Answer: Postgres already does it. Add a `content_tsv tsvector` column with a GIN index on `agents.chunks`, and a `searchSparse` method ranking by `ts_rank(content_tsv, plainto_tsquery(query))` — a sibling to the existing cosine `search`. Then fuse the two ranked lists with reciprocal-rank fusion. The anchor: **the load-bearing IR fact people forget is IDF — sparse beats dense on rare exact terms precisely because a term almost no document contains is a strong match signal.**

```
  add column content_tsv + GIN index → searchSparse via ts_rank
  (no new dependency; Postgres FTS is built in) → fuse with RRF (06)
```

## See also

- `01-embeddings.md` — why rare exact tokens embed to weak vectors (the root of the blind spot).
- `06-hybrid-retrieval-rrf.md` — combining the dense and sparse lanes (the natural next step).
- `04-vector-databases.md` — the `agents.chunks` table where a `tsvector` column would live.
- `../05-evals-and-observability/` — the eval that surfaces the exact-term failure.
