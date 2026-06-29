# Embedding-model choice — the one-way door

*Industry standard (with a project-specific decision). Why `nomic-embed-text:v1.5`, and why 768 is load-bearing.*

## Zoom out, then zoom in

Before any code, see the decision as a fork in the architecture. The embedding model isn't a swappable plugin — it's a *commitment*. Pick it and you've chosen the dimension of every vector you'll ever store, the privacy posture of every query, and the cost of ever changing your mind. Here's where that commitment radiates from:

```
  Zoom out — one choice, four enforcement points

  ┌─ Provider choice ───────────────────────────────────────────┐
  │  ★ nomic-embed-text:v1.5 (Ollama, local, 768-dim) ★          │
  │     vs hosted (OpenAI text-embedding-3, Cohere, ...)         │
  └───────────────────────────┬─────────────────────────────────┘
                              │ advertises dimension = 768
        ┌─────────┬───────────┼───────────┬─────────────┐
        ▼         ▼           ▼           ▼             ▼
   (1) provider  (2) pipeline (3) per-    (4) SQL        privacy:
   .dimension    assertWiring  vector     vector(768)    text never
   = 768         on index+query assertDim  column type   leaves laptop
   ───────────── ───────────── ────────── ────────────── ───────────
   "I am 768"    "both agree?"  "this one  "the disk says
                                is 768?"    768 too"
```

Zoom in. You've shipped pgvector RAG, so you've felt this: the dimension is baked into the column type, and once you've indexed a corpus you can't just point at a different model. This file makes that explicit. Two questions: **why did buffr pick a local 768-dim model over a hosted one**, and **why is 768 asserted in four separate places** when one check would "work"? The answer to the second is the answer to "what kind of mistake is a dimension mismatch" — and it's a one-way door, so the answer is *defense in depth*.

## Structure pass

Read the skeleton: the dimension constraint lives at four layers; trace one axis across them.

**Layers:** provider config → pipeline wiring → per-operation vector guard → SQL schema.

**Axis traced — "where is the number 768 enforced, and what does a violation cost there?"**

```
  one axis: where is 768 enforced, and how loud is the failure?

  ┌─ provider ───────────────┐  768 is ADVERTISED (embedder.dimension)
  │  OllamaEmbeddingProvider │  source of truth; nobody hardcodes it
  └────────────┬─────────────┘
               │ seam: config → wiring (both sides read .dimension)
  ┌─ pipeline ─▼─────────────┐  768 is CONTRACTED (assertWiring)
  │  createRetrievalPipeline │  fails at boot if embedder ≠ store
  └────────────┬─────────────┘
               │ seam: wiring → runtime (vectors now flow)
  ┌─ per-vector▼─────────────┐  768 is RE-CHECKED (assertDim) on every
  │  upsert / search guard   │  vector — catches a slipped-through bug
  └────────────┬─────────────┘
               │ seam: app → disk (vector becomes a typed column)
  ┌─ SQL ──────▼─────────────┐  768 is STORED (vector(768) not null)
  │  agents.chunks.embedding │  Postgres itself rejects the wrong width
  └──────────────────────────┘
```

**The seam that matters:** every one of those four boundaries is a place the dimension could go wrong, and each catches a *different class* of bug at a *different time*. The provider catch is a config typo; the pipeline catch is a wiring mismatch at boot; the per-vector catch is a runtime slip; the SQL catch is the last-line database guarantee. No single check covers all four failure modes — that's why all four exist. Hold that: it's not redundancy, it's coverage.

## How it works

### Move 1 — the mental model

You know how a database migration is a one-way door — once data's written in the new shape, rolling back means a data migration, not a `git revert`? The embedding dimension is exactly that. Once a corpus is embedded at 768 and written into `vector(768)` columns, switching to a 1536-dim model isn't a config change — it's re-embedding the entire corpus from the original text. So the right mental model is: **the model choice is a schema decision wearing a config-file costume.**

```
  the one-way door — embedding a corpus is irreversible-in-place

   model A (768) ──embed──► corpus@768 ──stored──► vector(768) column
                                                        │
   want model B (1536)?                                 │ can't just swap
                                                        ▼
   must RE-EMBED every chunk from original text ──► vector(1536) column
   (the documents.content rows are the only escape hatch)
```

The kernel: the dimension propagates from one source (the provider) and is asserted at every layer it crosses, because the cost of getting it wrong is "re-index everything," not "fix one line."

### Move 2 — the step-by-step walkthrough

**Step 1 — the choice: local over hosted.** buffr is local-first by design. `nomic-embed-text:v1.5` runs inside Ollama on the laptop; no text ever leaves the machine to be embedded. The alternative — OpenAI's `text-embedding-3` or Cohere — is higher quality but ships every chunk and every query to a third party. For a *personal* knowledge base, that's the wrong trade. The model is named in exactly one place and read everywhere else:

```ts
// src/cli/index-cmd.ts:18  and  src/session.ts (same construction)
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
```

That `OllamaEmbeddingProvider` advertises `.dimension = 768`. Nothing downstream hardcodes 768; they all read it off this object. The choice is "local model, its dimension is whatever it is, and we propagate that." Privacy is the *why*; 768 is the *consequence you must now respect everywhere*.

```
  Comparison — local vs hosted embedding

  LOCAL (buffr's choice)            HOSTED (rejected)
  ┌──────────────────────┐         ┌──────────────────────┐
  │ text ─► Ollama (lap)  │         │ text ─► HTTPS ─► API  │
  │ never leaves machine  │         │ leaves machine ✗      │
  │ 768-dim, free, slower │         │ 1536-dim, $, faster   │
  │ private ✓             │         │ better recall, opaque │
  └──────────────────────┘         └──────────────────────┘
  personal KB → privacy wins; quality gap acceptable at this scale
```

**Step 2 — check #1: the provider is the single source of 768.** The store is constructed by *reading* the provider's dimension, never by typing a literal:

```ts
// src/cli/index-cmd.ts:19
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
```

If you swap to a 1024-dim model, this line picks up 1024 automatically — the store now expects 1024. The provider stays the authority. (The store *defaults* to 768 at `src/pg-vector-store.ts:29` for when nobody passes one, but the wired path always passes `embedder.dimension`.)

**Step 3 — check #2: the pipeline refuses to boot on a mismatch.** When `createRetrievalPipeline` wires the embedder to the store, it asserts they agree — and it asserts again inside *both* the index and query functions, so neither path can run with a mismatched pair:

```ts
// aptkit packages/retrieval/src/pipeline.ts:22-29
function assertWiring(wiring: RetrievalWiring): void {
  if (wiring.embedder.dimension !== wiring.store.dimension) {
    throw new Error(
      `dimension mismatch: embedder "${wiring.embedder.id}" is ${wiring.embedder.dimension}-dim ` +
        `but store is ${wiring.store.dimension}-dim — re-index the corpus with a matching provider`,
    );
  }
}
```

The error message *tells you the fix* ("re-index the corpus"). That's the one-way door speaking: it knows a mismatch means re-embedding, so it says so. This fires at construction (`:73`) and at the top of `indexDocument` (`:36`) and `queryKnowledgeBase` (`:55`).

```
  Layers-and-hops — where each check fires, and when

  boot time                          runtime (per call)
  ┌─ provider ─┐ hop: .dimension     ┌─ per-vector ─┐ hop: assertDim
  │ = 768      │ ──────────┐         │ on each vec  │ ─► throws if ≠768
  └────────────┘           ▼         └──────┬───────┘
  ┌─ pipeline ─┐ assertWiring               │ hop: $1::vector
  │ embedder vs│ ─► throws if ≠     ┌─ SQL ──▼─────┐
  │ store dim  │                    │ vector(768)  │ ─► Postgres rejects
  └────────────┘                    │ not null     │    wrong width
                                    └──────────────┘
```

**Step 4 — check #3: every vector is re-checked at the operation.** Even past the wiring check, each individual vector is length-checked before it hits SQL. `upsert` checks every chunk vector; `search` checks the query vector:

```ts
// src/pg-vector-store.ts:32-36
private assertDim(v: number[]): void {
  if (v.length !== this.dimension) {
    throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
  }
}
```

Why bother, if the wiring already matched? Because the wiring check trusts that the embedder *always* returns its advertised length — a buggy or partial embedding (a truncated response, a model that returns variable-length output) could violate that at runtime. This catch is per-data, not per-config.

**Step 5 — check #4: the database column is the last guarantee.** The schema itself pins the width:

```sql
-- sql/001_agents_schema.sql:22
embedding vector(768) not null,
```

Even if every JS check were bypassed, Postgres rejects an insert of the wrong vector length. This is the durable, language-independent backstop — the one check that survives a rewrite of all the TypeScript above it.

#### Move 2.5 — current state vs the swap you might want

buffr runs 768 today. Suppose you decide hosted quality is worth it and want `text-embedding-3-small` (1536-dim). Here's what changes versus what doesn't:

```
  Comparison — switching embedding models

  STAYS THE SAME                      MUST CHANGE
  ┌────────────────────────┐         ┌────────────────────────┐
  │ documents.content rows  │         │ provider construction   │
  │ (source of truth — the  │         │ (model + host)          │
  │  re-embed input)        │         │ vector(768) → (1536)    │
  │ chunker (512/64 chars)  │         │ HNSW index (rebuilt)    │
  │ pipeline contract       │         │ EVERY chunk re-embedded │
  │ search SQL shape        │         │ from documents.content  │
  └────────────────────────┘         └────────────────────────┘
  the escape hatch: documents.content lets you re-embed without re-reading files
```

The takeaway is the reassuring part: because `agents.documents.content` stores the original text (written by `indexDocumentRow`, `src/runtime.ts:11-16`), a model swap is a *re-embed*, not a *re-ingest*. You don't need the original files — the database holds the source. That's why writing the documents row first matters (`10-incremental-indexing.md`).

### Move 3 — the principle

Some configuration is really schema. When a "setting" determines the shape of stored data, treat changing it as a migration, not a toggle — and put the guard at every layer the constraint crosses, because each layer catches a different bug at a different time. The four 768-checks aren't paranoia; they're the recognition that a dimension mismatch can originate as a config typo, a wiring error, a runtime glitch, or a raw SQL insert, and no single check sees all four.

## Primary diagram

The whole decision and its enforcement, one frame:

```
  embedding-model choice — one commitment, four guards, one escape hatch

  CHOICE: nomic-embed-text:v1.5 (local, private, 768-dim)
          rejected: hosted (better recall, but text leaves the laptop)
                        │ advertises .dimension = 768 (source of truth)
                        ▼
   ┌──── guard 1 ───┐ store built from embedder.dimension (no literal)
   ┌──── guard 2 ───┐ assertWiring: embedder == store, at boot + both paths
   ┌──── guard 3 ───┐ assertDim: every vector, upsert + search
   ┌──── guard 4 ───┐ SQL vector(768) not null: Postgres rejects wrong width

  SWITCHING MODELS = re-embed entire corpus
       │ from agents.documents.content (stored, so no file re-read)
       ▼
  vector(768) → vector(N)  + rebuild HNSW + re-run pipeline.index()
```

## Elaborate

The "one-way door" framing comes from how irreversible decisions differ from reversible ones: reversible choices you make fast and cheap; one-way doors you slow down for. Embedding dimension is a one-way door because the cost of reversal scales with corpus size, not with code size. At buffr's scale (a handful of markdown files) re-embedding is minutes; at a million documents it's a budgeted batch job. Building the four-layer guard now means the failure is loud and early at every scale.

Why 768 specifically? It's `nomic-embed-text`'s native output dimension — not a tunable. Bigger dimensions (1536, 3072) buy finer semantic resolution at the cost of storage and slower comparison; 768 is a strong default for a local model. The *quality* gap versus hosted models is real but small for a personal corpus, and it's swamped by buffr's bigger retrieval-quality levers (chunking, reranking) that it hasn't pulled yet — see `03`, `07`. Privacy, not recall, drove this choice, and at this scale that's correct.

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so Build-item IDs are not cited. Exercises are derived directly from the codebase and the spec's concept set.

### Prove the one-way door fails loudly

- **Exercise ID:** EMC-1 (Case A — guards implemented; prove them).
- **What to build:** a test that constructs a `PgVectorStore` with `dimension: 384`, wires it to the 768-dim `OllamaEmbeddingProvider`, and asserts `createRetrievalPipeline` throws the wiring error before any DB call — then a second test that pushes a hand-built 384-vector at `upsert` and asserts `assertDim` throws.
- **Why it earns its place:** "I tested that the mismatch fails fast" is the difference between claiming defense-in-depth and having it.
- **Files to touch:** new test against `src/pg-vector-store.ts:32-36` and `createRetrievalPipeline` (aptkit, consumed via `src/cli/index-cmd.ts:20`).
- **Done when:** both mismatch paths throw readable errors and no SQL is issued, verified by the test.
- **Estimated effort:** 1–4hr.

### Make the model swap a real, scripted migration

- **Exercise ID:** EMC-2 (Case A — operationalize the escape hatch).
- **What to build:** a `npm run reembed` script that reads every `agents.documents` row, re-runs `pipeline.index()` against a (configurable) embedding model, into a parallel `vector(N)` column or fresh table — proving you can switch models from stored content with zero file access.
- **Why it earns its place:** it turns the "one-way door" from a slogan into a measured, repeatable operation, and exercises that `documents.content` is the true source of truth.
- **Files to touch:** new `src/cli/reembed-cmd.ts`, reading `agents.documents` (schema `sql/001_agents_schema.sql:4-12`), reusing `indexDocumentRow` (`src/runtime.ts:5-18`) and a new `vector(N)` column in `sql/`.
- **Done when:** running it re-embeds the whole corpus from the DB and search works against the new column, with the old one untouched until cutover.
- **Estimated effort:** half a day.

## Interview defense

**Q: Why a local embedding model, and why is the dimension asserted in four places?**
Answer: local (`nomic-embed-text:v1.5` via Ollama) because it's a *personal* knowledge base — no chunk or query should leave the laptop, which rules out hosted APIs despite their better recall. The dimension is asserted four times because a mismatch can originate as four different bugs: a provider config typo, a wiring mismatch at boot, a runtime vector-length slip, and a raw SQL insert. Each guard catches a different class at a different time; no one check covers all four.

```
  768 enforced at four altitudes
  provider .dimension → pipeline assertWiring → per-vector assertDim → SQL vector(768)
  config typo          wiring bug              runtime slip            last-line DB guard
```

**Q: What does it cost to switch embedding models, and why?**
Answer: it's a one-way door — switching dimensions means re-embedding the entire corpus, because the vectors are stored in a fixed-width `vector(768)` column and a 1536-dim query can't search 768-dim data. The mitigation buffr already has: `agents.documents.content` stores the original text, so a swap is a re-embed from the database, not a re-ingest from files. The anchor: **the load-bearing fact people forget is that embedding dimension is schema, not config — change it like a migration.**

```
  switch model → re-embed corpus from documents.content → vector(N) + rebuild HNSW
  (the stored source text is the escape hatch)
```

## See also

- `01-embeddings.md` — what the 768 numbers are and why dimension is fixed by the model.
- `04-vector-databases.md` — the `vector(768)` column, HNSW, and the SQL-layer guard.
- `10-incremental-indexing.md` — why writing `documents.content` first makes re-embedding possible.
- `11-rag.md` — where this pipeline is wired with the dimension assertion.
