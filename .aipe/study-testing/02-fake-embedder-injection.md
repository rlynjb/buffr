# Fake-Embedder Injection

**Industry names:** test double / stub injection · deterministic seam · "fake the
model, test the plumbing." **Type:** Industry standard (the *pattern*); the
768-dim fake is Project-specific.

## Zoom out, then zoom in

`runtime.test.ts` indexes a document and asserts the chunks land in pgvector —
*without a running Ollama*. It can't call the real embedding model (slow,
non-deterministic, needs a server), so it injects a fake one: an
`EmbeddingProvider` whose `embed()` returns a fixed 768-vector every time. The
probabilistic dependency is swapped for a deterministic stub, and the
deterministic plumbing around it is what gets tested.

```
  Zoom out — where the fake plugs in

  ┌─ Test (deterministic harness) ───────────────────────────────┐
  │  fakeEmbedder ──┐                                             │ ← ★ HERE
  └─────────────────┼────────────────────────────────────────────┘
                    │ injected into
  ┌─ Pipeline layer ▼────────────────────────────────────────────┐
  │  createRetrievalPipeline({ embedder, store })                 │
  │  pipeline.index(doc)  →  chunk → embed → upsert               │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ store.upsert
  ┌─ Storage layer ───────────────▼──────────────────────────────┐
  │  PgVectorStore → agents.chunks (real Postgres)                │
  └──────────────────────────────────────────────────────────────┘

  the fake replaces the ONE non-deterministic box; everything below is real
```

Zoom in: the seam is `createRetrievalPipeline`'s `embedder` parameter. In
production it's `OllamaEmbeddingProvider`; in the test it's a hand-written object
satisfying the same `EmbeddingProvider` interface. **This is the single most
important testing move in an AI codebase** — it's how you put a deterministic
assertion (`assert.equal`) around a feature whose real core can't be asserted.

## The structure pass

**Layers.** Test → pipeline → store → Postgres. The fake lives at the top, the
real DB at the bottom.

**Axis — trace "is this box deterministic?" down the stack:**

```
  "deterministic?" — traced through the indexing chain

  ┌────────────────────────────────────────┐
  │ real OllamaEmbeddingProvider            │  → NO  (model, network)
  └────────────────────────────────────────┘
              swap at the seam ↓
  ┌────────────────────────────────────────┐
  │ fakeEmbedder (v[1]=1, always)           │  → YES (pure function)
  └────────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ pipeline.index / store.upsert        │  → YES (already deterministic)
      └─────────────────────────────────────┘

  one swap at the top makes the whole chain assertable
```

**Seam.** `embedder` is the load-bearing seam: the *determinism* axis flips
across it. Above the injection point, output is unpredictable; below it,
everything is a pure transform of a fixed vector. Inject at exactly that flip and
the test becomes deterministic.

## How it works

#### Move 1 — the mental model

You've done this with `fetch`. To test a component that fetches, you don't hit
the network — you inject a fake `fetch` that resolves a canned JSON, then assert
the component renders it. The fake embedder is identical: inject a fake
`embed()` that resolves a canned vector, then assert the chunks landed in
Postgres. Same shape, different dependency.

```
  Dependency injection at the determinism seam

  interface EmbeddingProvider { id; dimension; embed(texts) }
                  ▲                          ▲
       production │                          │ test
  ┌───────────────┴──────────┐   ┌───────────┴──────────────────┐
  │ OllamaEmbeddingProvider  │   │ fakeEmbedder                 │
  │ → calls model, varies    │   │ → returns [0..,1@idx1,..0]   │
  └──────────────────────────┘   │   always, no network         │
                                 └──────────────────────────────┘
        both satisfy the SAME interface → pipeline can't tell them apart
```

The kernel: **a shared interface + a constructor that takes it as a parameter.**
Drop the interface and the fake doesn't typecheck against the pipeline. Drop the
constructor parameter (hard-code the real embedder inside) and there's no seam
to inject through — which is exactly `session.ts`'s problem (see audit lens 3).

#### Move 2 — the walkthrough

**The fake itself.** `runtime.test.ts:14-17`, annotated:

```ts
const fakeEmbedder: EmbeddingProvider = {
  id: 'fake', dimension: 768,             // matches the store's 768-dim contract
  async embed(texts) {                    // same signature as the real provider
    return texts.map(() => {              // one vector per input text
      const v = new Array(768).fill(0);
      v[1] = 1;                           // a fixed unit vector — deterministic
      return v;
    });
  },
};
```

Three things make this a valid double, not a cheat:
- **`dimension: 768`** — it honors the must-not-change 768-dim contract
  (context.md). A fake returning 3-dim vectors would trip `PgVectorStore`'s
  `assertDim` and the test would fail on the fake, not the code.
- **same `embed(texts)` signature** — it's an `EmbeddingProvider`, so the
  pipeline calls it exactly as it'd call Ollama.
- **fixed output** — every call returns the same vector, so the test is
  reproducible.

**The injection point.** `runtime.test.ts:32-34`:

```ts
const store = new PgVectorStore({ pool, appId: 'test' });          // real store
const pipeline = createRetrievalPipeline({ embedder: fakeEmbedder, // ← fake here
                                           store });               // real here
await indexDocumentRow(pool, 'test', pipeline, { id: 'notes/a', text: '...', ... });
```

The fake goes in *one slot*. The store, pool, and Postgres are all real. So the
test exercises the genuine `indexDocumentRow` → `pipeline.index` →
`store.upsert` → SQL path — only the embedding is faked.

**The assertion that the plumbing worked.** `runtime.test.ts:36-39`:

```ts
const docs = await pool.query("select id from agents.documents where id='notes/a'");
assert.equal(docs.rowCount, 1);                          // documents row written
const chunks = await pool.query("...where document_id='notes/a'");
assert.ok(chunks.rowCount! >= 1);                        // chunks indexed + linked
```

It asserts the *side effects in real Postgres* — a documents row and at least one
chunk soft-linked to it. The embedding values are irrelevant to this assertion;
what matters is that the indexing pipeline ran end to end.

```
  Layers-and-hops — fake in, real rows out

  ┌─ Test ─────────────┐  inject fake   ┌─ Pipeline ──────────────────┐
  │ fakeEmbedder       │ ─────────────► │ index: chunk→embed→upsert    │
  └────────────────────┘                └──────────────┬───────────────┘
            ▲                              upsert chunks│
            │ assert rowCount                           ▼
  ┌─ Postgres ─────────┐                        ┌─ agents.chunks ──────┐
  │ documents + chunks │ ◄──────────────────────│ real rows written    │
  └────────────────────┘   query back           └──────────────────────┘
```

#### Move 3 — the principle

To test an AI feature, find the one box that's non-deterministic, confirm it sits
behind an interface, and inject a deterministic double for it — then assert the
deterministic machinery around it with normal `==`. **The model output you can't
assert; the plumbing that carries it you can — so fake the first to test the
second.** The day `session.ts` accepts an injected agent the same way the
pipeline accepts an injected embedder, its orchestration becomes testable by this
exact move.

## Primary diagram

```
  Fake-embedder injection — full picture

  ┌─ Test harness (deterministic) ───────────────────────────────┐
  │  fakeEmbedder { dimension: 768, embed → fixed v[1]=1 }        │
  │        │ injected at createRetrievalPipeline({ embedder })    │
  └────────┼──────────────────────────────────────────────────────┘
           ▼
  ┌─ Real pipeline ──────────────────────────────────────────────┐
  │  indexDocumentRow → pipeline.index → store.upsert            │
  └────────────────────────────────┬─────────────────────────────┘
                                   ▼
  ┌─ Real Postgres ──────────────────────────────────────────────┐
  │  agents.documents (1 row)  +  agents.chunks (≥1, linked)     │
  │        ▲ assert.equal / assert.ok                            │
  └────────┼─────────────────────────────────────────────────────┘
           └── the ONLY faked box was the embedder; the rest is real
```

## Elaborate

This is the test-double family (Meszaros' xUnit Test Patterns: dummy / stub /
fake / mock / spy). The fake embedder is a *stub* — it returns canned data and
records nothing. The reason it's the keystone move for AI work: an LLM or
embedding model is the textbook non-deterministic dependency, and the entire
discipline of testing AI features reduces to "isolate it behind a seam, stub it,
test everything else deterministically." Where the stub *stops* being enough is
the model's own output quality — you can't stub your way to "is this answer
good?" That's the handoff to `study-ai-engineering`'s evals.

## Interview defense

**Q: If you fake the embedder, are you testing anything real?** Yes — the
plumbing, which is the part that breaks in a refactor. The embedding *values*
don't matter to `indexDocumentRow`; what matters is that it writes a documents
row and soft-links chunks. Faking the model isolates the non-deterministic box so
those side effects become assertable with `==`. The fake honors the 768-dim
contract so it doesn't accidentally pass by violating it.

```
  the load-bearing part people forget:
  the fake must honor the real contract (dimension: 768) —
  a fake that returns 3-dim vectors tests a different system
```

**Anchor:** "Fake the one box you can't assert; test everything around it with
`==`. The fake earns trust by satisfying the same interface and the same
invariant."

## See also

- `audit.md` lens 6 — the AI-eval seam; this is the one place buffr exercises it.
- `audit.md` lens 3 — why `session.ts` can't use this pattern yet (no injection
  seam).
- `03-contract-parity-testing.md` — the *store* side of the same interface game.
- `study-ai-engineering` — where the un-fakeable half (answer quality) gets
  evaluated.
