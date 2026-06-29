# Embedding Model Choice

### *industry: embedding model selection · type: a one-way architectural decision*

## Zoom out

Same stack as the last file, but now the question isn't "what is a vector" — it's "which model makes the vectors, and what does that choice lock you into forever."

**buffr's retrieval stack, the choice marked**

```
┌──────────────────────────────────────────────────────────────┐
│  RAG pipeline           answer grounded in retrieved chunks    │
├──────────────────────────────────────────────────────────────┤
│  PgVectorStore          vector(768) column, asserts 768        │
├──────────────────────────────────────────────────────────────┤
│  RetrievalPipeline      assertWiring(embedder.dim == store.dim)│
├──────────────────────────────────────────────────────────────┤
│  ★ MODEL CHOICE ★       nomic-embed-text:v1.5 → 768-dim        │  ◄── this file
└──────────────────────────────────────────────────────────────┘
```

You picked an embedding model on your last RAG app too. What you maybe didn't feel was how *expensive it is to change your mind*. This file is about that — the embedding model is a one-way door, and buffr has welded it shut at four separate places on purpose.

## Structure pass

The axis is **commitment**: a model on one side, the entire indexed corpus on the other. The seam is the dimension number — the one value that, once you've embedded a corpus, you cannot change without re-embedding everything.

**The corpus is captive to the model**

```
   nomic-embed-text:v1.5  ──►  768-dim vectors  ──►  every row in agents.chunks
            │                                              │
            │  swap the model                              │  now incompatible
            ▼                                              ▼
   new model → different dim ──────X─────────────► old vectors unsearchable
                                 (the seam)
            you must RE-EMBED the whole corpus to cross it
```

Before the seam: choosing a model is a free, reversible config edit. After the seam — once you've run `npm run index` over your docs — the model is baked into thousands of stored vectors. Consequence: changing the embedding model is not a config change, it's a **migration**. buffr makes that cost loud instead of letting you discover it when search silently returns garbage.

## How it works

### Move 1 — Mental model: a database column type you can't ALTER cheaply

You know the pain of a schema migration that rewrites every row — changing a column's type on a 10M-row table isn't a flag flip, it's an outage you plan. The embedding model is exactly that, except the "column type" is the *meaning of the numbers*, and there's no `ALTER` — you have to recompute every value.

**Model choice as an un-cheap migration**

```
   config edit                       corpus migration
   ───────────                       ────────────────
   model: 'nomic' → 'other'          re-embed EVERY chunk
   (one line)                        re-run index over all docs
   reversible, free                  hours of compute, irreversible
                                     until you do it again
   ▲ feels like this                 ▲ actually costs this
```

Frontend bridge: it's the difference between changing a CSS variable and changing the shape of your API response. One is a tweak; the other forces every consumer to update. The embedding model is the API-shape change — every stored vector is a consumer.

### Move 2 — Walk the mechanism

**Part A — The choice: nomic-embed-text:v1.5, served locally**

buffr runs nomic through Ollama on the same machine as gemma2:9b. That's the load-bearing choice: *local*. No API key, no per-call cost, no data leaving the laptop. The dimension that comes with it is 768.

**Why nomic, why local**

```
   ┌─────────────────────────────────────────────┐
   │  nomic-embed-text:v1.5                        │
   │  • runs in Ollama, same host as gemma2:9b     │
   │  • 768-dim — solid mid-size, local-friendly   │
   │  • no API key, no egress, no per-token bill    │
   │  • good quality for a model this small         │
   └─────────────────────────────────────────────┘
            ▲
        the constraint that drove it: buffr is a LAPTOP agent.
        local-first rules out hosted embedding APIs.
```

```ts
// src/cli/index-cmd.ts:18 and src/session.ts:40 — same model, both paths
const embedder = new OllamaEmbeddingProvider({
  model: 'nomic-embed-text:v1.5',
  host: cfg.ollamaHost,
});
```

The model string appears identically on the index path and the query path. That's not a coincidence you can be sloppy about — if index-time and query-time used different models, the vectors would live in different spaces and every search would be noise. Both sides naming the same model is a correctness invariant, hand-maintained here.

**Part B — The 768 one-way door: four assert sites**

buffr treats a dimension mismatch as a wiring bug, not a runtime input — so it fails *loudly and early* at four independent layers. This is defense-in-depth: no single line is trusted to be the guard.

**The four locks on the door**

```
  ┌─ 1. PROVIDER ──────────────────────────────────────────┐
  │  OllamaEmbeddingProvider.dimension = 768 (declared)     │
  ├─ 2. WIRING ────────────────────────────────────────────┤
  │  assertWiring: embedder.dimension === store.dimension   │
  │  throws "dimension mismatch … re-index the corpus"      │
  ├─ 3. PER-VECTOR ────────────────────────────────────────┤
  │  PgVectorStore.assertDim(v): v.length !== 768 → throw   │
  ├─ 4. SCHEMA ────────────────────────────────────────────┤
  │  embedding vector(768) — Postgres rejects wrong width   │
  └────────────────────────────────────────────────────────┘
       a wrong-dim vector cannot survive ANY of these
```

```ts
// 2. aptkit pipeline.ts:22-29 — fail at wiring time, before any index runs
function assertWiring(wiring: RetrievalWiring): void {
  if (wiring.embedder.dimension !== wiring.store.dimension) {
    throw new Error(`dimension mismatch: … re-index the corpus with a matching provider`);
  }
}
```

```ts
// 3. src/pg-vector-store.ts:32-36 — fail per vector, on upsert AND search
private assertDim(v: number[]): void {
  if (v.length !== this.dimension) {
    throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
  }
}
```

Why four and not one? Each catches a different mistake at a different time. The wiring check catches a misconfigured pipeline *before it indexes a single doc* — the cheapest possible failure. The per-vector check catches a provider that lies about its own dimension. The schema check catches a raw SQL insert that bypassed the app entirely. The provider's declared `768` is the source of truth the other three compare against. Cheap, early, redundant — exactly how you guard an irreversible operation.

### Move 2.5 — Current vs. future

**The re-embed cost is real, and buffr has no automated path across the door.**

```
  TODAY                              IF YOU CHANGE THE MODEL
  ─────                              ───────────────────────
  one model, 768, asserted           every chunk's vector is now wrong-space
  search just works                  ┌────────────────────────────┐
                                     │ 1. change model string      │
                                     │ 2. assertWiring may throw   │
                                     │    (update store dimension) │
                                     │ 3. re-run npm run index over│
                                     │    EVERY doc (upsert)       │
                                     │ 4. old vectors overwritten  │
                                     └────────────────────────────┘
                                     manual, total, no delta path
```

There is no "migrate embeddings" command. Crossing the door means re-running the index over the full corpus, by hand. For buffr's tiny laptop corpus that's seconds; at scale it's the migration you plan a maintenance window for. The honest takeaway: **pick the embedding model like you're picking a primary key — assume you live with it.**

### Move 3 — The principle

**The embedding model is the most expensive decision in the retrieval stack to reverse, so guard it like an invariant, not a setting.** buffr's four assert sites aren't paranoia — they're the correct response to a one-way door. The cost of a mismatch isn't an error message; it's a corpus full of vectors that *silently* return wrong answers if the guard weren't there. Loud-and-early beats silent-and-wrong every time the failure is irreversible.

## Primary diagram

The choice, the door, and the four locks, end to end.

**One model in, four guards on the way out**

```
  CHOICE                 ENFORCEMENT (defense-in-depth)
  ──────                 ──────────────────────────────
  nomic:v1.5             ① provider declares dimension = 768
  local, 768-dim   ──►   ② assertWiring: embedder.dim == store.dim   (wiring time)
  no egress              ③ assertDim per vector on upsert + search   (call time)
                         ④ SQL column vector(768)                    (storage time)
                                       │
                                       ▼
                         a wrong-dimension vector cannot exist anywhere
                                       │
                                       ▼
                         changing the model = re-embed the whole corpus
                         (manual, irreversible-until-redone)
```

After the box: the four guards make the door *impossible to walk through by accident* — which is the point, because walking through it accidentally means silent wrong answers.

## Elaborate

- **Quality vs. locality tradeoff.** A hosted model (OpenAI text-embedding-3, 1536-dim) would likely retrieve better than local nomic. buffr chooses local anyway — privacy and zero-cost-per-query outrank a marginal quality bump for a personal laptop agent. That's an opinion the architecture commits to, not an oversight.
- **`:v1.5` is part of the contract.** Model *versions* can shift the vector space too. Pinning `nomic-embed-text:v1.5` (not bare `nomic-embed-text`) means an Ollama update to a v2 won't silently re-point your space. The version pin is part of the one-way-door discipline.
- **Why not store the model name per chunk?** buffr does — `embedding_model text` on `agents.chunks` (default `'nomic-embed-text:v1.5'`). It's a record of *which* model produced each vector, so a future migration can find the stragglers. It's a paper trail, not an enforcement — nothing reads it to gate search yet.
- **The mismatch failure is the scary one because it's quiet without guards.** Without the asserts, a 768-query against 384-vectors wouldn't crash in some databases — it'd return *some* ordering, just a meaningless one. Silent wrong answers are worse than crashes. The four guards convert a quiet failure into a loud one.

## Project exercises

### Add an embedding-model-mismatch guard at search read-time

- **Exercise ID:** [B2A.3] (cite [C2.1], Phase 2A) — Case A: the four dimension guards exist; this adds the *model-name* guard the `embedding_model` column already enables.
- **What to build:** On search, compare the live embedder's model string against the `embedding_model` recorded on the rows being searched; warn (or refuse) if they differ. Use the existing `embedding_model` column — today it's written but never read.
- **Why it earns its place:** Two *different 768-dim* models would pass all four dimension guards and still return garbage — same width, different space. The model-name check closes the one gap dimension-checking can't.
- **Files to touch:** `src/pg-vector-store.ts` (the `search` method, against `embedding_model`).
- **Done when:** Searching a corpus indexed with model A using a pipeline wired to model B produces a loud warning or error instead of silent results.
- **Estimated effort:** 2–4hr.

### Write the re-embed migration runbook (and run it)

- **Exercise ID:** [B2A.4] (cite [C2.1], Phase 2A) — Case A: indexing exists; this exercises the *cross-the-door* path that has no command today.
- **What to build:** A documented, repeatable procedure to switch buffr's embedding model: change the string, update the store/schema dimension if needed, re-index the full corpus, verify the eval set still scores. Do it for real with a second local model.
- **Why it earns its place:** The one-way door is asserted but never *traversed* in buffr. Doing the migration once turns "it's expensive" from a claim into measured wall-clock cost — the only honest input to a real model-swap decision.
- **Files to touch:** `src/cli/index-cmd.ts`, `sql/001_agents_schema.sql` (dimension), `src/pg-vector-store.ts` (default dimension), `eval/queries.json` to re-verify.
- **Done when:** buffr runs end-to-end on a different embedding model with the eval set passing, and you can state the wall-clock cost of re-embedding the corpus.
- **Estimated effort:** 1 day.

## Interview defense

**Q: "Why is the embedding model a one-way door?"**

Because the model bakes its dimension and its vector space into every stored vector. Changing it doesn't reinterpret old vectors — it makes them incompatible. You must re-embed the entire corpus. So it's a migration, not a config change.

```
  swap model ──► old vectors wrong-space ──► re-embed everything
```

Anchor: *"Pick the embedding model like a primary key."*

**Q: "How does buffr stop a dimension mismatch?"**

Four guards: the provider declares 768, `assertWiring` checks embedder-dim equals store-dim at wiring time, `assertDim` checks every vector on upsert and search, and the SQL column is `vector(768)`. Defense-in-depth — no single line is trusted.

```
  provider → wiring → per-vector → schema
  a wrong-dim vector survives none of them
```

Anchor: *"Guard the irreversible thing four times, loudly."*

## See also

- `./01-embeddings.md` — what the 768 numbers are and why dimension is fixed per model.
- `./09-stale-embeddings.md` — the *other* freshness problem: vectors that are right-model but out-of-date.
- `./04-vector-databases.md` — the `vector(768)` schema lock, the fourth guard.
- `../05-evals-and-observability/` — the eval set you re-verify after a model swap.
