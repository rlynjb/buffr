# Fake embedder injection

**Industry name:** test double (a fake / stub) injected through a port · dependency injection of a deterministic substitute. *Industry-standard pattern, here on aptkit's `EmbeddingProvider` interface.*

**Determinism seam:** testing (deterministic). The whole point is to *remove* the non-deterministic, network-bound model call so the test asserts exact values. The probabilistic real embedder lives on the eval side (`study-ai-engineering`).

---

## Zoom out, then zoom in

The retrieval pipeline needs to turn text into a 768-dim vector. In production that's a network call to Ollama running `nomic-embed-text:v1.5`. A test that called the real embedder would be slow, would require Ollama running, and — worse — would be *non-deterministic*: real embeddings shift slightly across model versions, so an exact assertion would be flaky by construction. The fix is to hand the pipeline a **fake embedder** (the test double): same interface, fixed output, no network.

```
  Zoom out — where the fake plugs in

  ┌─ Test ─────────────────────────────────────────────────────┐
  │  const fakeEmbedder: EmbeddingProvider = { embed: () => … }  │ ← ★ THE TEST DOUBLE ★
  └────────────────────────────┬────────────────────────────────┘
                              injected into
  ┌─ aptkit pipeline (the port: EmbeddingProvider) ──▼──────────┐
  │  createRetrievalPipeline({ embedder, store })                │
  │  pipeline.index(doc) → embedder.embed(chunks) → store.upsert │
  └────────────────────────────┬────────────────────────────────┘
                              writes to
  ┌─ Storage ──────────────────▼────────────────────────────────┐
  │  PgVectorStore → agents.chunks  (real Postgres)              │
  └──────────────────────────────────────────────────────────────┘

  the STORE is real (we're testing it); the EMBEDDER is fake
  (we're not testing Ollama)
```

Zoom in: the pattern is **dependency injection of a test double through a port**. The port is aptkit's `EmbeddingProvider` interface. Production passes `OllamaEmbeddingProvider`; the test passes a hand-written object satisfying the same interface. Because the pipeline depends on the *interface*, not the concrete class, the swap needs zero changes to production code.

---

## The structure pass

**Layers:** (1) the test that constructs the fake, (2) the aptkit pipeline that consumes an `EmbeddingProvider`, (3) the real `PgVectorStore` + Postgres underneath.

**Axis traced — *which dependencies are real vs faked?*** At the test layer, both are chosen explicitly. At the pipeline layer, the embedder is fake, the store is real. At the storage layer, fully real. The axis flips at the embedder boundary and *only* there — everything below the embedder is the real system.

**The seam:** the `EmbeddingProvider` interface is the substitution seam. It's load-bearing because it's where the network call would otherwise happen — faking exactly here, and nowhere else, is what keeps the test both deterministic *and* a real integration test of the storage path. Fake too much (also fake the store) and you'd test nothing real; fake too little (use real Ollama) and you'd reintroduce the flake.

---

## How it works

### Move 1 — the mental model

You've done this with `fetch`: in a test you swap the real `fetch` for one that returns a canned response, so the component's logic runs without a network. The fake embedder is the same move on a different port — swap the thing that does I/O for a thing that returns a fixed value, and the rest of the pipeline never knows.

```
  The test-double kernel

   real:   text ──► OllamaEmbeddingProvider.embed ──► [768 floats]   (network, varies)
                         ▲
                         │ same interface
                         ▼
   test:   text ──► fakeEmbedder.embed ───────────► [0,1,0,…,0]      (no I/O, fixed)

   pipeline calls embedder.embed(texts) — it cannot tell which one it holds
```

### Move 2 — the walkthrough

**Define the double to satisfy the exact interface.** The fake is a plain object typed as `EmbeddingProvider` — the same type the real provider implements.

```ts
// test/runtime.test.ts:14-17
const fakeEmbedder: EmbeddingProvider = {
  id: 'fake', dimension: 768,
  async embed(texts) { return texts.map(() => { const v = new Array(768).fill(0); v[1] = 1; return v; }); },
};
```

Three parts, each load-bearing:
- **`dimension: 768`** — must match the store's expected dimension, or `PgVectorStore.assertDim` throws (`pg-vector-store.ts:32-36`). The fake honors the same 768-dim contract the production system enforces everywhere.
- **`embed(texts)` returns one fixed vector per input** — a 768-element array of zeros with a single `1` at index 1. Deterministic: same input, same output, every run. No call to Ollama, no network, no variance.
- **`async`** — the interface is async (real embedding is I/O), so the fake stays async to match the signature, even though it does no awaiting.

**Inject it where production would inject the real one.** The pipeline factory takes the embedder as a parameter:

```ts
// test/runtime.test.ts:33
const pipeline = createRetrievalPipeline({ embedder: fakeEmbedder, store });
```

Compare the production wiring (`session.ts:40-42`): `new OllamaEmbeddingProvider({...})` then the same `createRetrievalPipeline({ embedder, store })`. **The factory call is identical** — only the object handed in differs. That's the proof the seam is clean: the test exercises the real `createRetrievalPipeline` and real `PgVectorStore`, faking only the leaf that does network I/O.

**Now the test can assert exact storage behavior.** With the embedder deterministic, indexing a document and reading back the rows is fully predictable:

```ts
// test/runtime.test.ts:34-39
await indexDocumentRow(pool, 'test', pipeline, { id: 'notes/a', text: 'hello world from notes', sourcePath: 'notes/a.md' });
const docs = await pool.query("select id from agents.documents where id = 'notes/a'");
assert.equal(docs.rowCount, 1);                                       // documents row written
const chunks = await pool.query("select id from agents.chunks where document_id = 'notes/a'");
assert.ok(chunks.rowCount! >= 1);                                     // chunks indexed
```

The assertion is about the *plumbing* — did `indexDocumentRow` write a documents row and at least one chunk — not about embedding quality. Embedding quality is the eval question, and it's measured separately by `eval-cmd.ts`. The fake lets this test own the deterministic half cleanly.

```
  Layers-and-hops — the index path under test

  ┌─ Test ───────────┐ hop1: indexDocumentRow(doc)  ┌─ runtime.ts ─────┐
  │  fakeEmbedder     │ ───────────────────────────► │ insert documents │
  │  injected         │                              │ row              │
  └───────────────────┘                              └────────┬─────────┘
                                            hop2: pipeline.index│
                                                                ▼
                                            ┌─ aptkit pipeline ──────────┐
                                            │ embedder.embed (FAKE: fixed)│
                                            │ → store.upsert (REAL)       │
                                            └────────┬────────────────────┘
                                            hop3: insert│ chunks
                                                        ▼
                                            ┌─ Storage: agents.chunks ───┐
                                            │  real Postgres + pgvector   │
                                            └─────────────────────────────┘
```

### Move 3 — the principle

Fake the boundary that's slow or non-deterministic; keep everything else real. The skill is choosing *which* boundary — fake too high and the test proves nothing about your storage; fake too low and you've reintroduced the network flake. Here the line is exactly the `EmbeddingProvider` port, because that's the one place a network call and a source of variance live. The deterministic substitute buys an exact assertion (`rowCount === 1`) on a path that would otherwise only support a fuzzy "is it roughly right" — and that fuzzy version is the eval seam's job, not this test's.

---

## Primary diagram

```
  Fake embedder injection — full picture

  ┌─ production (session.ts) ──────────┐   ┌─ test (runtime.test.ts) ───────────┐
  │ new OllamaEmbeddingProvider(...)    │   │ fakeEmbedder: EmbeddingProvider     │
  │   → network call, varies            │   │   → fixed [0,1,0,…], no I/O         │
  └──────────────┬──────────────────────┘   └──────────────┬──────────────────────┘
                 │           SAME factory call              │
                 └──────────────┬───────────────────────────┘
                                ▼
                 createRetrievalPipeline({ embedder, store })
                                │
                                ▼
                 PgVectorStore → agents.chunks  (REAL in both)
                                │
                                ▼
            test asserts exact row counts — deterministic because
            the only non-deterministic dependency was swapped out
```

---

## Elaborate

The distinction this pattern leans on: a *fake* (working in-memory implementation of an interface) vs a *mock* (an object that records and asserts on the calls made to it). This is a fake — it returns a usable value and the test never inspects how it was called. Fakes keep the test focused on *outcomes* (what's in the database) rather than *interactions* (was `embed` called with these args), which is more robust to refactoring: rename a method or reorder calls and an outcome test still passes if the result is right.

The same injection seam is exploited differently in `session.ts`: there, *both* embedder and store are constructed inside `createChatSession()`, which is precisely why `session.ts` is hard to test (it doesn't take them as parameters) — see `audit.md` lens 3 and `00-overview.md` gap 1. The lesson cuts both ways: where the port is injected (the pipeline), testing is trivial; where it's hard-wired (the session), testing is blocked.

---

## Interview defense

**Q: Why fake the embedder but use a real database?**
Different problems. The embedder is non-deterministic and network-bound — faking it removes flake and lets me assert exact values. The database *is the thing under test* — its cosine ranking and upsert semantics only have real answers against pgvector. So I fake the source of variance and keep the source of truth real. Faking both would test nothing; faking neither would be a flaky test that needs Ollama running.

```
  what to fake, what to keep real

  non-deterministic + network  →  FAKE  (embedder)
  the behavior under test       →  REAL  (PgVectorStore + Postgres)
```

*Anchor:* "Fake the variance, keep the behavior under test real — the embedder is the variance, the store is the behavior."

**Q: Fake or mock — which is this, and why does it matter?**
A fake. It returns a usable 768-dim vector; the test never asserts on how `embed` was called. That makes the test an *outcome* test — it checks what landed in `agents.chunks`, not the call sequence — so it survives refactoring the pipeline internals. A mock asserting "embed was called once with these texts" would break the moment the pipeline batched differently, even if the stored result was identical.

*Anchor:* "It's a fake, not a mock — I assert on the rows in the table, not on how the embedder was called."

---

## See also

- `01-env-gated-integration-tests.md` — the database is gated and real; the embedder is faked. The two patterns partition the external dependencies.
- `03-contract-parity-test.md` — the same `EmbeddingProvider`-style port substitution, applied to the `VectorStore` interface.
- `audit.md` lens 3 — why `session.ts` hard-wiring the embedder makes it untestable (the inverse of this pattern).
- `study-ai-engineering` — the *real* embedder and embedding quality live on the eval side of the seam.
