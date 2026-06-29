# Embeddings

### *industry: text embeddings / dense vector representations · type: the geometric primitive under retrieval*

## Zoom out

This is the bottom of the retrieval stack. Everything above it — chunking, the vector store, RAG itself — is plumbing that moves these vectors around. Get this one wrong and nothing above it can be right.

**buffr's retrieval stack, this concept marked**

```
┌──────────────────────────────────────────────────────────────┐
│  RAG pipeline           answer grounded in retrieved chunks    │
├──────────────────────────────────────────────────────────────┤
│  search_knowledge_base  ranked hits + citations                │
├──────────────────────────────────────────────────────────────┤
│  PgVectorStore          ANN search over agents.chunks          │
├──────────────────────────────────────────────────────────────┤
│  chunker                512-char windows                       │
├──────────────────────────────────────────────────────────────┤
│  ★ EMBEDDINGS ★         text → 768-dim vector (nomic)          │  ◄── this file
└──────────────────────────────────────────────────────────────┘
```

You shipped a pgvector RAG app before, so you already know the shape: text goes in, a vector comes out, you compare vectors with cosine. This file slows down on the *mechanism* — what that vector actually is geometrically, and why cosine similarity is the only comparison that makes sense for it. The shape lands fast; the geometry is what you under-thought last time.

## Structure pass

The axis is **representation**: a string on one side, a fixed-length array of floats on the other. The seam is the embedding model — the one place where human-meaning collapses into geometry.

**The collapse from text to geometry**

```
   "how does the author take their coffee"
                  │
                  ▼  the embedding (768-dim nomic vector)
   ┌────────────────────────────────────────────────┐
   │  [0.013, -0.041, 0.255, … 768 floats … 0.008]   │
   └────────────────────────────────────────────────┘
                  │
                  ▼  a point in 768-dimensional space
        ★ meaning is now DIRECTION, not words ★
```

The string before the seam: discrete tokens, no notion of distance. The array after: a point in a 768-dimensional space where *direction* encodes meaning. Two texts that mean the same thing point the same way, even with zero shared words. That is the whole trick. Consequence: "coffee" and "espresso with oat milk" can sit close together while sharing no characters — which is exactly why dense retrieval finds the coffee doc for a query that never says "coffee.md".

## How it works

### Move 1 — Mental model: meaning is a direction

Forget the 768 numbers for a second. Picture a 2-D map where every sentence is a pin. Sentences about coffee cluster in one corner; sentences about your work stack cluster in another. The embedding model is the cartographer: it places each pin so that *semantic* closeness becomes *spatial* closeness.

**Meaning-as-direction (drawn in 2 of 768 dims)**

```
        ▲ dim_2
        │        ● "how I take my coffee"
        │       ● "espresso, oat milk, no sugar"
        │      ●  "morning pour-over ritual"
        │                              ● "TypeScript + Postgres stack"
        │                             ● "the tools I build with"
        └──────────────────────────────────────► dim_1
         angle between clusters = semantic distance
```

Frontend bridge: you've normalized a color to an `[r,g,b]` vector and computed distance between two colors. An embedding is that, with 768 channels instead of 3, and the channels encode meaning instead of light. Distance between two color vectors tells you how similar the colors look; distance between two embeddings tells you how similar the texts *mean*.

### Move 2 — Walk the mechanism

**Part A — The provider turns text into vectors**

buffr embeds through Ollama, locally, with nomic-embed-text. The provider's contract is dead simple: a batch of strings in, a batch of equal-length float arrays out.

**The embed call**

```
  ["chunk text", "query text", …]
            │
            ▼  POST /api/embed  { model, input: texts }
     ┌──────────────────┐
     │  Ollama + nomic  │
     └──────────────────┘
            │
            ▼
  [[768 floats], [768 floats], …]   one vector per input
```

```ts
// aptkit ollama-embedding-provider.ts:38-58 — the provider
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'nomic-embed-text';
  readonly dimension = 768;                       // fixed by the model
  async embed(texts: string[]): Promise<number[][]> {
    return this.embedTransport({ model: this.model, texts, … });
  }
}
```

`dimension = 768` is not a config knob — it's a fact about nomic. The model emits 768 floats per text, always. That number being a constant is what makes the rest of the system able to assert on it (next file).

**Part B — Cosine similarity compares directions, not magnitudes**

Two vectors are "similar" when they point the same way. Cosine similarity measures the angle between them: 1.0 = identical direction, 0 = orthogonal (unrelated), -1 = opposite. buffr never computes raw distance between points — it cares about direction, because magnitude (how long the vector is) carries no reliable meaning here.

**Cosine: the angle is the signal**

```
        ▲
        │   q (query vector)
        │  ╱
        │ ╱  θ small  ──► cos θ ≈ 1  ──► very similar
        │╱___________ d1 (a coffee chunk)
        │╲
        │ ╲  θ large  ──► cos θ ≈ 0  ──► unrelated
        │  ╲_________ d2 (a stack chunk)
        └────────────────────────────────►
   similarity = cos θ ;  buffr stores it as 1 - cosine_distance
```

```ts
// src/pg-vector-store.ts:67-77 — cosine, in SQL
// <=> is pgvector's cosine DISTANCE operator; similarity = 1 - distance.
`select id, content, …,
        1 - (embedding <=> $1::vector) as score
   from agents.chunks
   where app_id = $2
   order by embedding <=> $1::vector
   limit $3`
```

Here's the load-bearing detail Rein should pin: pgvector's `<=>` returns cosine *distance* (0 = identical, 2 = opposite). buffr flips it to a *similarity score* with `1 - (embedding <=> $1::vector)` so a higher number means "more relevant," and orders by raw distance so the nearest chunk comes first. Distance for ordering, similarity for the score you read. Same geometry, two conveniences.

### Move 3 — The principle

**An embedding is a lossy compression of meaning into a fixed direction, and retrieval is angle comparison.** That single sentence explains every design choice downstream: the dimension is fixed (so you can assert on it), the comparison is cosine (so magnitude can't lie to you), and "relevant" means "points the same way" (so word overlap stops mattering). You don't search text in buffr. You search geometry, and the embedding model is the only thing that decides whether the geometry is any good.

## Primary diagram

The full text-to-comparison path, both the index side and the query side meeting at the same geometry.

**Two texts, one space, one angle**

```
  INDEX TIME                         QUERY TIME
  ──────────                         ──────────
  chunk text                         user question
      │  embed (nomic, 768)              │  embed (nomic, 768)
      ▼                                  ▼
  [768 floats] ─────► stored in ◄──── [768 floats]
                    agents.chunks
                  embedding vector(768)
                         │
                         ▼
              1 - (embedding <=> query) = score
                         │
                         ▼
              high score = small angle = same meaning
```

After the box: both sides must use the *same* 768-dim provider, or the angle is meaningless — which is the one-way door the next file is entirely about.

## Elaborate

- **Why 768 specifically.** It's nomic-embed-text's output width — a published property of the model, not a buffr choice. Bigger embedding models emit 1024 or 1536; smaller ones 384. More dimensions can carry more nuance but cost more storage and slower search. 768 is a solid mid-size default for a local model.
- **Magnitude vs. direction.** Some embedding models return un-normalized vectors where length varies. Cosine ignores length by construction, which is why buffr can use `<=>` (cosine) safely without normalizing first. If buffr used L2/Euclidean distance instead, magnitude would suddenly matter and you'd need to normalize.
- **Batch in, batch out.** `embed(texts: string[])` takes an array because embedding is cheaper in batches — one HTTP round-trip for many chunks at index time. The query path passes a one-element array (`embed([query])`) and takes `[0]`.
- **The vector is opaque.** You can't read float 412 and say "this is the coffee dimension." The dimensions are entangled; meaning lives in the *whole* vector's direction, not in any single axis. This is why you can't hand-edit an embedding or debug one by inspection — you can only compare it to others.

## Project exercises

### Visualize buffr's actual embedding space

- **Exercise ID:** [B2A.1] (cite [C2.1], Phase 2A) — Case A: embeddings are implemented (`OllamaEmbeddingProvider`, stored in `agents.chunks`). This is the *next step* — make the geometry visible.
- **What to build:** A script that pulls every chunk's embedding from `agents.chunks`, runs a 2-D projection (PCA or UMAP), and plots the points colored by `document_id`. Confirm coffee/work/stack chunks form visible clusters.
- **Why it earns its place:** You reasoned about meaning-as-direction abstractly. Seeing your own 3 eval docs separate into clusters turns the abstraction into evidence — and surfaces any doc whose chunks scatter (a chunking smell).
- **Files to touch:** a new script under buffr's CLI surface reading from `src/pg-vector-store.ts`'s table; reuse `src/db.ts` for the pool.
- **Done when:** A plot shows work.md / stack.md / coffee.md chunks in separable clusters, and you can name one chunk that sits between clusters and explain why.
- **Estimated effort:** 1–4hr.

### Measure cosine score spread on the eval set

- **Exercise ID:** [B2A.2] (cite [C2.1], Phase 2A) — Case A: scoring exists in `src/cli/eval-cmd.ts`; this adds the score distribution.
- **What to build:** For each of the 3 eval queries, log the cosine score (`1 - distance`) of the top-3 hits. Build intuition for what "relevant" scores look like vs. "noise" scores in buffr's space.
- **Why it earns its place:** Every threshold decision downstream (when is a hit good enough?) needs you to know the score distribution. You can't set a floor you've never measured.
- **Files to touch:** `src/cli/eval-cmd.ts` (it already calls `pipeline.query`; log `h.score`).
- **Done when:** You can state the typical score of a correct top-1 hit vs. an irrelevant filler hit in buffr's corpus.
- **Estimated effort:** 1–2hr.

## Interview defense

**Q: "What is an embedding, concretely?"**

A fixed-length vector — 768 floats for buffr's nomic model — that places a piece of text as a point in space so that semantic similarity becomes geometric closeness. Same meaning, same direction, regardless of shared words.

```
  text ──► [768 floats] ──► a direction in space
  similar meaning = similar direction
```

Anchor: *"Meaning is a direction, not a string."*

**Q: "Why cosine similarity and not Euclidean distance?"**

Because direction carries the meaning and magnitude doesn't. Cosine measures the angle and ignores length, so two vectors that point the same way score as similar even if one is longer. buffr stores it as `1 - (embedding <=> query)`.

```
  small angle ──► cos ≈ 1 ──► relevant
  magnitude ──► ignored
```

Anchor: *"Compare the angle, not the length."*

## See also

- `./02-embedding-model-choice.md` — why nomic, and the 768 one-way door that both sides of this geometry must obey.
- `./04-vector-databases.md` — where these 768-dim vectors live and how pgvector searches them.
- `../01-llm-foundations/` — tokens and the model that produces these vectors.
- `../../study-dsa-foundations/` — vectors, distance metrics, and the search structures (HNSW) that make angle comparison fast.
