# Embedding model choice — nomic 768-dim as a one-way door

> Updated: 2026-06-24 — `ask` entrypoint renamed to `chat`/`session.ts`; the same 768-dim embedder now also feeds conversation memory (`08-conversation-memory.md`), so memory rows share the one-way-door space too.

**Industry name(s):** Embedding model / dimensionality selection · Industry standard (the "one-way door" framing).

## Zoom out, then zoom in

Before you index a single document, you've already made the most expensive-to-reverse decision in the whole RAG system: which embedding model, at what dimension. buffr picked `nomic-embed-text` at **768 dimensions**. That number is wired into four places, and a mismatch throws rather than silently corrupting retrieval. It's not a runtime parameter — it's a structural commitment.

```
  Zoom out — where the dimension is committed

  ┌─ Provider layer ─────────────────────────────────────────┐
  │  OllamaEmbeddingProvider.dimension = 768  ★ SOURCE ★      │ ← we are here
  └───────────────────────────┬──────────────────────────────┘
                              │  asserted equal at each layer
  ┌─ Pipeline ────────────────▼──────────────────────────────┐
  │  createRetrievalPipeline → assertWiring(embedder == store)│
  └───────────────────────────┬──────────────────────────────┘
  ┌─ Store ───────────────────▼──────────────────────────────┐
  │  PgVectorStore.dimension = 768, assertDim per vector      │
  └───────────────────────────┬──────────────────────────────┘
  ┌─ Storage ─────────────────▼──────────────────────────────┐
  │  agents.chunks.embedding  vector(768)  (the SQL column)   │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: an embedding model maps text to a fixed-length vector, and that length — the dimension — is fixed by the model. nomic gives 768. Every vector in the corpus is 768-dim; every query must be 768-dim to be comparable. Switch models and the new dimension is incompatible with the old corpus — you must re-embed *everything*. That's the one-way door: cheap to walk through, expensive to walk back.

## Structure pass

Four layers, one axis: **where does the number 768 come from, and what happens on mismatch?**

```
  Axis traced = "source of the 768, behavior on mismatch"

  ┌─ provider ──────────────────────────┐  768 = MODEL FACT (nomic)
  │  dimension = 768 (hardcoded by model)│  → the single source
  └──────────────────┬───────────────────┘
                     │  seam ① — read FROM provider, not re-declared
  ┌─ pipeline wiring ───────────────────┐  768 = ASSERTED EQUAL
  │  assertWiring: embedder.dim==store.dim│  → throws at wiring time
  └──────────────────┬───────────────────┘
                     │  seam ② — runtime guard per vector
  ┌─ store ─────────────────────────────┐  768 = ASSERTED PER WRITE/READ
  │  assertDim(v): throw on length != 768│  → throws, never truncates
  └──────────────────┬───────────────────┘
                     │  seam ③ — the durable, hardest-to-change line
  ┌─ SQL column ────────────────────────┐  768 = SCHEMA CONSTRAINT
  │  embedding vector(768)               │  → migration to change
  └──────────────────────────────────────┘
```

The discipline here is exemplary: the number has *one* source (the provider, which reads it from the model) and three independent guards that all assert against it. **Seam ②** is the most important — `assertDim` throws on a length mismatch rather than truncating or padding, so you can never silently index unsearchable vectors. The load-bearing principle: a dimension mismatch is a *wiring bug, not a runtime input* — fail loud at wiring time, never degrade at query time.

## How it works

Mental model: you know how a database column has a fixed type — `varchar(255)`, and inserting a 300-char string errors rather than truncating if you've set it up right? The embedding dimension is that, for vectors. `vector(768)` is a typed column; a 1024-dim vector doesn't fit and the system refuses it.

```
  The one-way door — why a model swap forces a full re-index

  corpus embedded with nomic (768-dim):
    [v0_768] [v1_768] [v2_768] ...  ← all 768

  swap to text-embedding-3-large (3072-dim):
    query → [q_3072]
              │
              ▼  cosine(q_3072, v_768) → ✗ undefined
                 different spaces, can't compare ANY pair
              │
              ▼  ONLY fix: re-embed the WHOLE corpus at 3072
                 + migrate the column vector(768) → vector(3072)
```

### Step 1 — the model fixes the dimension

`OllamaEmbeddingProvider.dimension = 768` — hardcoded, because nomic-embed-text *is* 768-dim. This is the single source of truth. Critically, `index-cmd.ts` reads `embedder.dimension` to construct the store (`dimension: embedder.dimension`) rather than re-typing `768` — so the provider is the one place the number lives. Boundary condition: change the embedding model to one with a different dimension and this constant changes, cascading a re-index requirement.

### Step 2 — the pipeline asserts embedder and store agree

`createRetrievalPipeline` calls `assertWiring`, which throws if `embedder.dimension !== store.dimension`. This catches the misconfiguration *at construction*, before any document is indexed — so you can never wire a 768-dim embedder to a 1024-dim store and discover it only when queries return garbage. Boundary condition: this fires once, at wiring, not per-operation — it's the cheap structural check.

### Step 3 — the store asserts every vector

`assertDim(v)` throws `dimension mismatch: got ${v.length}, store is ${this.dimension}` on every upsert (all chunks, before `begin`) and every search. This is the per-operation guard. The message is specific — it tells you the actual length and the expected one. Boundary condition: it throws rather than slicing or zero-padding, which is the whole point — a truncated vector would *index successfully* and then retrieve wrong, the worst kind of silent failure.

### Step 4 — the SQL column is the durable constraint

`embedding vector(768) not null` in `sql/001_agents_schema.sql` is the hardest layer to change. The other three are code (edit and restart); this one needs a migration *and* a re-embed of every row. It's the physical manifestation of the one-way door.

### Move 3 — the principle

The embedding dimension is a structural commitment, not a config value, and the right engineering response is defense in depth that fails loud. The principle generalizes to any "one-way door" decision: make the irreversible choice explicit, source it from one place, guard it at every layer, and make violations throw — because the failure mode of a silent dimension mismatch (successful index, wrong retrieval) is far worse than a loud crash at wiring time.

## Primary diagram

The four guards around the single source, full recap.

```
  buffr embedding-dimension commitment — full recap

         ┌─ MODEL FACT ─────────────────────────┐
         │  nomic-embed-text → 768               │
         └──────────────────┬───────────────────┘
                            │ provider reads it
         ┌─ OllamaEmbeddingProvider.dimension=768 (SOURCE) ─┐
         └──────────────────┬───────────────────────────────┘
              index/ask/eval read embedder.dimension
                            │
         ┌─ guard 1: assertWiring (pipeline construction) ──┐
         │   embedder.dim === store.dim  else throw         │
         ├─ guard 2: assertDim (every upsert, before begin) ┤
         │   vector.length === 768  else throw, no truncate │
         ├─ guard 3: assertDim (every search) ──────────────┤
         │   query.length === 768  else throw               │
         ├─ guard 4: vector(768) NOT NULL (SQL, durable) ───┤
         │   migration required to change                   │
         └──────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The dimension is committed at every entrypoint that touches vectors — `index`, `chat` (`session.ts`), `eval`, and now conversation memory all construct the provider and store the same way, so they share the exact 768-dim space. This is why the eval measures the agent's real retrieval: same provider, same dimension, same store — and why remembered exchanges land in that same space, recallable through the same search tool.

**Code side by side.**

```
  src/cli/index-cmd.ts  (lines 18–19)

  const embedder = new OllamaEmbeddingProvider({
    model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
  const store = new PgVectorStore({
    pool, appId: cfg.appId, dimension: embedder.dimension });  ← read FROM embedder
       │
       └─ the store's dimension is NOT typed as 768 here — it's pulled from the
          embedder. Swap the embedder and the store follows automatically. One
          source, no drift
```

```
  src/pg-vector-store.ts  (lines 29–36)

  this.dimension = opts.dimension ?? 768;          ← default, overridable
  private assertDim(v: number[]): void {
    if (v.length !== this.dimension) {
      throw new Error(
        `dimension mismatch: got ${v.length}, store is ${this.dimension}`); ← loud
    }
  }
       │
       └─ throws. Does not slice to fit, does not pad with zeros. A wrong-dim
          vector NEVER reaches the database — the silent-corruption path is closed
```

```
  sql/001_agents_schema.sql  (line 22)

  embedding vector(768) not null,
       │
       └─ the durable guard. Changing this is a migration + full re-embed —
          the literal one-way door. The code guards above all defend THIS
```

## Elaborate

The "one-way door" framing comes from the cost asymmetry: embedding a corpus is cheap (a million tokens through a hosted model is pennies; locally through Ollama it's just laptop time), but you have to redo *all* of it to switch models, plus migrate the column, plus re-deploy. So the decision is reversible in principle but expensive enough in practice that you treat it as a commitment.

nomic-embed-text at 768 is a sensible default for buffr's shape — a local, privacy-critical, English personal corpus. It runs on CPU via Ollama, needs no API key, and 768 dims is a good size/quality balance. The spec's decision tree lands exactly here: "privacy-critical, on-device → local sentence-transformer-class model." buffr's defense-in-depth around the dimension is better than most production RAG systems, which often discover a dimension mismatch only when retrieval mysteriously degrades.

What to read next: `01-rag-index-path.md` and `02-rag-query-path.md` — both paths are downstream of this commitment, and both inherit its guards.

## Project exercises

> No `aieng-curriculum.md` present; exercises name the buildable target directly.

### Add an embedding_model + dimension audit to chunks

- **What to build:** A startup check that scans `chunks` for any row whose `embedding_model` differs from the current provider, warning that those rows were embedded by a different model and may need re-indexing.
- **Why it earns its place:** Demonstrates you understand that the one-way door has a *detection* story, not just a guard — "I detect corpus rows embedded by a stale model" is concrete.
- **Files to touch:** `src/pg-vector-store.ts` (a `auditEmbeddingModels` query), a CLI surface or a check in `index-cmd.ts`.
- **Done when:** a test with two `embedding_model` values in `chunks` reports the mismatch.
- **Estimated effort:** 1–4hr.

### Prove the model swap is a full re-index

- **What to build:** A migration + script that re-embeds the entire corpus at a new dimension (e.g. a different nomic variant), changing the SQL column and re-running the index path.
- **Why it earns its place:** Walking the one-way door end to end — column migration, full re-embed, guard updates — is the exact thing the framing warns about, made real.
- **Files to touch:** `sql/00X_reembed.sql`, `src/migrate.ts`, `src/cli/index-cmd.ts`.
- **Done when:** the corpus is searchable at the new dimension and the old column type is gone.
- **Estimated effort:** 1–2 days.

## Interview defense

**Q: Why is the embedding dimension a "one-way door"?**

```
  cosine(q_3072, v_768) = undefined → swap model = re-embed EVERYTHING + migrate column
```

"Because query and corpus vectors must share a space to be comparable. Switching embedding models changes the dimension, which invalidates the entire indexed corpus — you re-embed every document and migrate the `vector(768)` column. Cheap to do, expensive to undo, so I treat it as a commitment and source the number from one place." Anchor: a dimension mismatch is a wiring bug, not a runtime input.

**Q: How do you stop a dimension mismatch from corrupting retrieval silently?**

"Defense in depth that throws: the provider is the single source of 768, the pipeline asserts embedder==store at wiring time, the store asserts every vector's length before any write or read, and the SQL column types it durably. Crucially `assertDim` throws — it never truncates or pads, because a silently-truncated vector would index fine and then retrieve wrong." Anchor: fail loud at wiring time, never degrade at query time.

## Validate

- **Reconstruct:** Name the four places `768` is committed and which one needs a migration to change. (`pg-vector-store.ts:29`, `index-cmd.ts:19`, `pipeline.js` assertWiring, `sql/001:22`)
- **Explain:** Why does `index-cmd.ts` pass `dimension: embedder.dimension` instead of `dimension: 768`? (`src/cli/index-cmd.ts:19`)
- **Apply:** Someone changes the model to `mxbai-embed-large` (1024-dim) but not the SQL column. Where does it break, and is the break loud or silent? (`pg-vector-store.ts:32` vs `sql/001:22`)
- **Defend:** buffr chose nomic 768 for a local personal RAG agent. Defend it against `text-embedding-3-large`, naming the tradeoff. (`src/cli/index-cmd.ts:18`)

## See also

- `01-rag-index-path.md` — writes vectors at this dimension.
- `02-rag-query-path.md` — queries must match this dimension.
- `06-evals-precision-and-recall.md` — measures whether 768/nomic is good enough.
- `.aipe/study-database-systems/03-btree-hash-and-secondary-indexes.md` — how `vector(768)` is indexed by HNSW.
- `.aipe/study-testing/02-fake-embedder-injection.md` — testing the dimension guards with injected vectors.
