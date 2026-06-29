# Embeddings — text as points in 768-space

*Industry standard. The substrate under all of buffr's retrieval.*

## Zoom out, then zoom in

Pull up the whole RAG stack and find the one thing every other box depends on: the embedding. It's not a feature you call — it's the *coordinate system* the entire retrieval layer measures distance in. Both halves of buffr (index and query) reduce to "turn text into a 768-dim point, then compare points."

```
  Zoom out — where embeddings live

  ┌─ Agent layer (aptkit) ─────────────────────────────────────┐
  │  RagQueryAgent.answer()  →  search_knowledge_base(query)    │
  └───────────────────────────┬────────────────────────────────┘
                              │  raw query string
  ┌─ Retrieval layer ─────────▼────────────────────────────────┐
  │  pipeline: embed → search → rank                            │
  └──────────────┬───────────────────────────┬─────────────────┘
                 │ embed                      │ search(vector,k)
  ┌─ Provider ───▼────────────────┐  ┌─ Storage ▼──────────────┐
  │ ★ EMBEDDING ★                 │  │ pgvector compares the   │
  │ nomic-embed-text:v1.5 (Ollama)│  │ 768-dim points (cosine) │
  │ text → [768 floats]           │  │ agents.chunks.embedding │
  └───────────────────────────────┘  └─────────────────────────┘
                ▲ we are here
```

Zoom in. You've shipped pgvector RAG before, so you know the shape: text goes in, a list of floats comes out, and "similar text" means "nearby vectors." The thing worth slowing down on is *why* that works — what the 768 numbers actually encode, and what `cosine distance` is really measuring. That's the concept this file builds: an **embedding** is a learned map from text to a fixed-length vector where geometric closeness means semantic closeness. Get that, and every other file in this folder is just plumbing around it.

## Structure pass

Before the mechanics, read the skeleton. Embeddings touch three layers; trace one axis across them and watch where it flips.

**Layers:** provider (produces the vector) → pipeline (carries the vector) → storage (compares vectors).

**Axis traced — "what does this layer treat the 768 numbers AS?"**

```
  one axis: what is a vector, to each layer?

  ┌─ provider ──────────────┐   MEANING — the model packed semantics
  │  nomic-embed-text:v1.5  │   into 768 floats; it knows what they mean
  └────────────┬────────────┘
               │  seam: meaning → opaque array
  ┌─ pipeline ─▼────────────┐   PAYLOAD — just number[]; it never
  │  embed() → number[]     │   interprets, only routes and length-checks
  └────────────┬────────────┘
               │  seam: array → pgvector literal "[0.1,0.2,...]"
  ┌─ storage ──▼────────────┐   GEOMETRY — a point to measure angles
  │  embedding vector(768)  │   against; cosine distance, nothing else
  └─────────────────────────┘
```

**The seam that matters:** provider → pipeline. On the provider's side the numbers *mean* something (a learned semantic encoding); the moment they cross into the pipeline they're an opaque `number[]` whose only enforced property is `length === 768`. Everything downstream — pgvector, the SQL, the index — operates purely on geometry and never re-derives meaning. That's the whole trick: meaning is computed *once*, at the provider, and from then on "is this relevant?" becomes "is this vector close?" Hold that seam; it's why the dimension (768) is load-bearing everywhere downstream (see `02-embedding-model-choice.md`).

## How it works

### Move 1 — the mental model

You've built BST and graph code, so you already own the right intuition: **k-nearest-neighbor**. Picture every chunk of your corpus as a point scattered in space. A query is also a point. Retrieval is "find the k points nearest the query." The only twist versus the k-NN you've coded in 2-D is that the space has 768 dimensions instead of 2, and "nearest" is measured by *angle* (cosine), not straight-line distance. The embedding model is the thing that decides *where* each point lands — it's the coordinate-assigner.

```
  the embedding kernel — text becomes a point, queries find neighbors

   "renew passport"        ●  query point (768-dim)
                            ╲   small angle = similar
                             ╲
   corpus points:    ● ●   ●  ◀── nearest neighbors (top-k)
   (each a chunk)   ●     ●
                  ●    ●          ● ◀ large angle = unrelated
                                     ("how to bake bread")

   embedding model = assigns each text its coordinates
   cosine          = the angle between two coordinate vectors
   retrieval       = k smallest angles to the query point
```

Strip it to the kernel: a function `text → point`, plus a distance that's *angle-based*, plus "return the k closest." Lose the model and you can't place points. Lose cosine and "close" is undefined. Lose top-k and you have a coordinate system but no retrieval.

### Move 2 — the step-by-step walkthrough

**Step 1 — the provider turns text into 768 floats.** This is the one box that understands language. buffr uses Ollama's `nomic-embed-text:v1.5`, a local embedding model that maps any string to a 768-dimensional vector. You ask for it by handing the embedder a list of strings; you get back a list of equal-length arrays.

```ts
// src/cli/index-cmd.ts:18-20  — the embedder is constructed here
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });
```

Notice `embedder.dimension` — the provider *advertises* its output length (768). buffr never hardcodes 768 at this call site; it reads it off the provider and hands it to the store. That's the source of the dimension that gets asserted four times downstream. The model is the authority on its own output size.

```
  Layers-and-hops — one embed call

  ┌─ buffr ───────┐  hop 1: embed(["renew passport"])   ┌─ Ollama ────────┐
  │ embedder.embed│ ──────────────────────────────────► │ nomic-embed     │
  └──────▲────────┘  hop 2: [[0.013, -0.04, ... ×768]] ◄ │ text:v1.5       │
         │                                               └─────────────────┘
         └── returns number[][], one 768-vector per input string
```

**Step 2 — the same model embeds documents AND queries.** This is the rule people forget: the query and the corpus must be embedded by the *same* model, or their coordinate systems don't line up and "nearest" is garbage. buffr enforces this structurally — there's exactly one `embedder` in the pipeline, used by both the index path and the query path.

```ts
// aptkit packages/retrieval/src/pipeline.ts:40 (index)  and :56 (query)
const vectors = await wiring.embedder.embed(texts);   // index: many chunk vectors
const [vector] = await wiring.embedder.embed([query]); // query: one query vector
```

Same `wiring.embedder` both times. If you embedded the corpus with `nomic` and queries with OpenAI's model, both would be vectors, both might even be the right *length* by coincidence — but they'd live in unrelated spaces and cosine would return noise. One model, two call sites: that's the invariant.

```
  Pattern — symmetric embedding (the load-bearing invariant)

  INDEX TIME                          QUERY TIME
  chunk text ─┐                       query text ─┐
              ▼                                    ▼
        [same embedder]  ◀────────────────► [same embedder]
              │                                    │
         768-vector                           768-vector
              │   ── must share a space ──         │
              └──────────► cosine compares ◄───────┘
```

**Step 3 — cosine similarity is `1 - distance`, and it's just normalized dot product.** Here's the math you can fully derive. Cosine similarity between two vectors is `dot(a,b) / (|a|·|b|)` — the cosine of the angle between them. It runs from `1` (identical direction) through `0` (orthogonal) to `-1` (opposite). pgvector's `<=>` operator gives cosine *distance*, which is `1 - cosine_similarity`. So buffr inverts it back:

```ts
// src/pg-vector-store.ts:69-77
// <=> is cosine DISTANCE; cosine similarity score = 1 - distance.
const { rows } = await this.pool.query(
  `select id, content, chunk_index, document_id, meta,
          1 - (embedding <=> $1::vector) as score      -- back to similarity in [-1,1]
   from agents.chunks
   where app_id = $2
   order by embedding <=> $1::vector                   -- ascending distance = nearest first
   limit $3`,
  [toVectorLiteral(vector), this.appId, k],
);
```

Why angle and not Euclidean distance? Because embedding magnitude often tracks text length, not meaning — a long passage and a short one about the same topic should still match. Normalizing to the unit sphere (which cosine does) throws away length and keeps direction, and *direction* is where the model encodes topic. You've computed dot products before; cosine is that, divided by the two lengths. Nothing exotic.

```
  Comparison — why cosine, not Euclidean

  Euclidean: |a - b|             cosine: angle(a, b)
  ┌──────────────────┐           ┌──────────────────┐
  │ short ●          │           │      ●╲ short     │
  │       │ far      │           │       ╲ ╲ same    │
  │       │          │           │        ╲ ╲ angle  │
  │ long  ●          │           │         ╲●  long  │
  └──────────────────┘           └──────────────────┘
  length pulls them apart        same topic → same direction
  (wrong for retrieval)          (right for retrieval)
```

**Step 4 — every vector is length-checked before it touches geometry.** A 768-dim corpus can only be searched by a 768-dim query. buffr guards this on every single vector, in and out, before the SQL runs:

```ts
// src/pg-vector-store.ts:32-36
private assertDim(v: number[]): void {
  if (v.length !== this.dimension) {
    throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
  }
}
```

`upsert` calls it per chunk (`:39`), `search` calls it on the query vector (`:68`). The boundary condition this catches: a provider swap that changes output length. Without the check, a wrong-dimension vector either errors deep in pgvector with a cryptic message or — worse — silently mismatches. With it, you fail fast at the buffr boundary with a readable error. This is one of the four dimension checks `02` walks in full.

### Move 3 — the principle

An embedding turns "do these two pieces of text mean the same thing?" — an unanswerable NLP question — into "is the angle between these two vectors small?" — a cheap arithmetic one. The model does the hard part once, at index time, and bakes the answer into geometry. Everything else in retrieval is k-NN over points. The deep idea: **you move the intelligence to the coordinate-assignment step, so search itself can stay dumb and fast.**

## Primary diagram

The full embedding story, both paths, one frame:

```
  buffr embeddings — meaning computed once, geometry forever after

  ┌─ Provider (Ollama) ──────────────────────────────────────────┐
  │  nomic-embed-text:v1.5    text ──► [768 floats]               │
  │  ▲ knows MEANING; output advertised as embedder.dimension=768 │
  └──┼──────────────────────────────────────┼───────────────────┘
     │ index: chunk texts                    │ query: one string
     ▼                                       ▼
  [v0][v1][v2]...  (one 768-vec/chunk)   [qv]  (one 768-vec)
     │  assertDim each (768)                 │  assertDim (768)
     ▼                                       ▼
  ┌─ Storage (pgvector) ─────────────────────────────────────────┐
  │  agents.chunks.embedding vector(768)                          │
  │  score = 1 - (embedding <=> qv)   ← cosine sim = norm dot prod │
  │  order by embedding <=> qv  limit k  ← k smallest angles       │
  └──────────────────────────────────────────────────────────────┘
                      │
                      ▼  top-k nearest chunks → ground the answer
```

## Elaborate

Embeddings come from the same lineage as word2vec (2013): train a model so that text used in similar contexts lands in similar places, and arithmetic on the vectors starts encoding meaning. Modern sentence/document embedders like `nomic-embed-text` extend that from single words to whole passages, and they're trained specifically so that a *question* and the *passage that answers it* land near each other — which is exactly the property RAG needs.

The dimension count (768 here) is a fixed property of the trained model, not a tunable. It's a budget: more dimensions can encode finer distinctions but cost more storage and slower comparison. 768 is a common sweet spot. The thing that makes it consequential for buffr is that it's a *one-way door* — once you've embedded a corpus at 768, switching to a model with a different dimension means re-embedding everything. That's `02`'s whole subject.

What embeddings *don't* do: they're weak at exact-string matching. "Error code E4017" and "error code E4018" are nearly identical vectors, and a rare identifier that the model barely saw in training gets a mushy, uninformative embedding. That's the gap sparse retrieval (BM25) fills — see `05-dense-vs-sparse.md`. buffr is dense-only today, so it inherits this blind spot.

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so Build-item IDs are not cited. Exercises are derived directly from the codebase and the spec's concept set.

### Inspect a real embedding

- **Exercise ID:** EMB-1 (Case A — embeddings implemented; inspect what ships).
- **What to build:** a tiny script that embeds two related strings and one unrelated one, prints all three 768-vectors' first few dims, and computes pairwise cosine similarity by hand (dot / norms) — proving `1 - distance` matches what pgvector returns.
- **Why it earns its place:** you can't defend "cosine is normalized dot product" until you've watched the same number fall out of your own arithmetic and out of `<=>`.
- **Files to touch:** new `scripts/embed-inspect.ts` using `OllamaEmbeddingProvider` (import as in `src/cli/index-cmd.ts:4`); compare against `1 - (embedding <=> $1::vector)` from `src/pg-vector-store.ts:72`.
- **Done when:** your hand-computed cosine matches pgvector's `score` to floating-point tolerance for the same two texts.
- **Estimated effort:** 1–4hr.

### Add a magnitude/NaN sanity check to the embed boundary

- **Exercise ID:** EMB-2 (Case A — hardening the embed seam).
- **What to build:** extend the per-vector guard so it also rejects vectors containing `NaN`/`Infinity` or an all-zero vector (which collapses cosine to undefined), not just wrong length.
- **Why it earns its place:** a degenerate embedding silently poisons retrieval; catching it at the boundary is the same defense-in-depth instinct as the dimension check.
- **Files to touch:** `src/pg-vector-store.ts:32-36` (`assertDim` → a broader `assertVector`), called from `upsert` (`:39`) and `search` (`:68`).
- **Done when:** an all-zero or `NaN`-containing vector throws a readable buffr-side error before any SQL runs, covered by a unit test.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: What is an embedding, and what does cosine distance actually measure?**
Answer: an embedding is a learned function mapping text to a fixed-length vector — 768 floats here, from `nomic-embed-text:v1.5` — where semantic similarity becomes geometric proximity. Cosine similarity is the normalized dot product, `dot(a,b)/(|a||b|)`, i.e. the cosine of the angle between the two vectors; it ignores magnitude and keeps direction, which is where topic lives. pgvector gives cosine *distance* via `<=>`, so buffr computes `1 - (embedding <=> v)` to get similarity back.

```
  cosine = normalized dot product = angle
  sim =  dot(a,b) / (|a|·|b|)   ∈ [-1, 1]
  pgvector <=> = 1 - sim  (distance)  →  buffr: score = 1 - <=>
```

**Q: Why must the corpus and the query use the same embedding model?**
Answer: two models produce coordinates in unrelated spaces, so cosine between a `nomic` doc-vector and an OpenAI query-vector is meaningless even when the lengths happen to match. buffr enforces it structurally — one `embedder` instance feeds both `indexDocument` and `queryKnowledgeBase` in the pipeline — and length-checks every vector with `assertDim`. The anchor: **the load-bearing invariant people forget is that index-time and query-time embeddings must come from the same model, in the same space.**

```
  index ─[same embedder]─► space S ◄─[same embedder]─ query
  different model = different space = cosine returns noise
```

## See also

- `02-embedding-model-choice.md` — why `nomic-embed-text:v1.5`, and why 768 is a one-way door asserted four times.
- `04-vector-databases.md` — where the 768-vectors live and how `<=>` hits the HNSW index.
- `05-dense-vs-sparse.md` — the exact-match blind spot embeddings have.
- `.aipe/study-dsa-foundations/` — k-NN, dot products, cosine similarity from first principles.
- `.aipe/study-database-systems/` — cosine distance and HNSW at the storage-engine layer.
