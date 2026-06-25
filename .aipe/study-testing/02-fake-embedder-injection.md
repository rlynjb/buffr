# Fake Embedder Injection

**Industry names:** test double at the provider seam · dependency injection of
a deterministic stub · "fake the non-deterministic core." **Type:** Industry
standard (the seam — aptkit's `EmbeddingProvider` interface — is project-specific).

---

## Zoom out, then zoom in

The real indexing path calls Ollama over the network to turn text into a
768-float embedding. That's slow, requires a model running, and returns floats
you can't predict — three things that make an `equals` assertion impossible. So
the test swaps the real embedder for a fake one that returns a constant vector,
and now the indexing path is deterministic and assertable.

```
  Zoom out — where the fake plugs in

  ┌─ Test ──────────────────────────────────────────────────┐
  │  indexDocumentRow(pool, 'test', pipeline, doc)           │
  └────────────────────────────┬────────────────────────────┘
                               │ pipeline = createRetrievalPipeline({...})
  ┌─ Pipeline (aptkit) ────────▼────────────────────────────┐
  │  index(doc): chunk → embed(texts) → store.upsert(...)    │
  │                         │                                │
  │              ★ fakeEmbedder ★  ◄── injected here          │ ← we are here
  └─────────────────────────┼───────────────────────────────┘
              real path would cross to ▼
  ┌─ Provider (network) ────────────────────────────────────┐
  │  OllamaEmbeddingProvider → nomic-embed-text (NOT called) │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **constructor injection of a stub that satisfies a
provider interface.** `createRetrievalPipeline` takes `{ embedder, store }`. In
production `embedder` is `OllamaEmbeddingProvider`; in the test it's a 4-line
object literal that returns the same vector for any input. The pipeline can't
tell the difference — it only knows the `EmbeddingProvider` contract.

---

## Structure pass

Two layers, one axis: **determinism — at which boundary does randomness enter?**

```
  Axis: "is the output predictable?" — traced across the embed seam

  ┌─ indexing logic ────────────┐
  │  chunk text, build rows      │   → DETERMINISTIC (pure transforms)
  └──────────────┬───────────────┘
       seam: EmbeddingProvider.embed()  ← determinism flips here
  ┌──────────────▼───────────────┐
  │  real: Ollama nomic-embed     │   → NON-DETERMINISTIC
  │  fake: () => constant vector  │   → DETERMINISTIC (the swap)
  └───────────────────────────────┘
```

The `embed()` call is the seam where the system stops being predictable. The
whole technique is: **stand at that seam and substitute the deterministic side
in.** Everything downstream of the swap (chunking, upsert, row counts) was
already deterministic; the fake just makes the one non-deterministic input
deterministic too, so the end-to-end indexing path can be asserted with `equals`.

---

## How it works

### Move 1 — the mental model

You know how you'd test a component that calls `fetch()` by handing it a fake
`fetch` that returns a fixed response, instead of hitting the real network? Same
move. The pipeline calls `embedder.embed(texts)` the way a component calls
`fetch()`; you hand it a fake `embed` that returns a fixed vector.

```
  The substitution — same shape, two implementations

  createRetrievalPipeline({ embedder: ???, store })
                                    │
            ┌───────────────────────┴───────────────────────┐
   production │                                    test │
   OllamaEmbeddingProvider               fakeEmbedder = {
   .embed(t) → network → real floats       embed: t => t.map(() =>
                                              constant 768-dim vector) }
            │                                    │
            └──── both satisfy EmbeddingProvider ─┘
                  pipeline can't tell them apart
```

### Move 2 — the walkthrough

**The fake satisfies the real interface — no more, no less.** aptkit's
`EmbeddingProvider` needs three things: an `id`, a `dimension`, and an async
`embed(texts)`. The fake provides exactly those. Type it as
`EmbeddingProvider` and TypeScript enforces the contract — if aptkit's
interface grows a method, the fake stops compiling, which is a *feature*: the
stub can't silently drift from the real contract.

```
  The fake's shape mirrors the interface exactly

  EmbeddingProvider {            fakeEmbedder {
    id: string          ────►      id: 'fake'
    dimension: number   ────►      dimension: 768
    embed(texts): num[][] ──►      embed: t => t.map(() => vec)
  }
```

**The returned vector is constant — and that's the whole point.** The fake
returns `new Array(768).fill(0)` with a `1` at index 1, the same vector for
every text. Because it's constant, the chunk that gets indexed has a *known*
embedding, so the assertions downstream ("a documents row exists," "a chunk row
exists") don't depend on what nomic-embed *would* have produced. The dimension
is 768 — matching the store — so it flows through `PgVectorStore.assertDim`
without tripping the dimension guard.

```
  Why constant beats random for this test

  random embedder        constant embedder
  ───────────────        ─────────────────
  different vec/run      same vec every run
  can't predict order    order is decided
  → can only assert      → can assert exact
    "something happened"   rows by id
```

**It's injected at construction, not patched globally.** The fake goes in
through `createRetrievalPipeline({ embedder: fakeEmbedder, store })`. There's no
`jest.mock`, no module-level monkey-patch, no global stub to clean up. The test
owns the pipeline it built; nothing leaks to other tests. This is only possible
because the production code *also* takes the embedder as a constructor argument
(`session.ts:40-42`, `index-cmd.ts:18-20`) — the seam exists in the real code,
the test just passes a different value through it.

**The skeleton — what breaks without each part:**

- **Interface conformance** (`id`, `dimension`, `embed`). Drop any field and the
  pipeline throws or won't type-check. The fake must be a *complete* stand-in.
- **Constant return value.** Make it random and you lose the `equals` assertion
  — you're back to probabilistic "something happened." **Load-bearing.**
- **`dimension: 768` matching the store.** Mismatch and `assertDim` throws
  before any indexing happens. The fake has to respect the same 768 invariant.
- **Constructor injection.** Without the seam in production code, you'd be
  monkey-patching — fragile and leaky. The DI is what makes the swap clean.

### Move 3 — the principle

Put the deterministic harness exactly at the boundary where determinism flips,
and no deeper. The fake embedder replaces *only* the non-deterministic,
network-bound piece — chunking, upsert, and ranking stay real, so the test still
exercises the actual SQL. This is the defining move of testing an AI feature:
you don't mock the whole pipeline, you substitute the one probabilistic node and
let everything deterministic run for real. The model's *quality* (is this
embedding good?) is a separate question that belongs to evals, not here.

---

## Primary diagram

The full picture — the fake plugged into the real pipeline, real store behind it.

```
  Fake embedder injection — deterministic harness, real SQL behind it

  ┌─ Test (runtime.test.ts) ───────────────────────────────────┐
  │  fakeEmbedder = { id, dimension: 768, embed: t => [vec] }   │
  │  store        = new PgVectorStore({ pool, appId: 'test' })  │
  │  pipeline     = createRetrievalPipeline({ embedder, store }) │
  │  indexDocumentRow(pool, 'test', pipeline, { id:'notes/a' }) │
  └──────────────────────────┬─────────────────────────────────┘
                             │
  ┌─ aptkit pipeline ────────▼─────────────────────────────────┐
  │  index(doc): split → embed(texts) ──► [constant 768-vec]    │  ← FAKE
  │                              │                              │  (no network)
  │                              ▼                              │
  │                       store.upsert(chunks) ────────────────►│
  └──────────────────────────┬─────────────────────────────────┘
                             │ real SQL
  ┌─ Storage (real Postgres) ▼─────────────────────────────────┐
  │  insert into agents.documents ...  +  agents.chunks ...     │
  │  ◄── assert: docs.rowCount === 1, chunks.rowCount >= 1       │
  └──────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Reached for once, in `runtime.test.ts`, to test
`indexDocumentRow` without Ollama. It's the only test double in the repo. The
production embedder it stands in for is constructed at `index-cmd.ts:18`,
`eval-cmd.ts:14`, and `session.ts:40`.

The fake, in full:

```
  test/runtime.test.ts  (lines 14-17)

  const fakeEmbedder: EmbeddingProvider = {     ← typed as the real interface;
                                                  TS enforces conformance
    id: 'fake', dimension: 768,                 ← 768 matches the store's
                                                  assertDim invariant
    async embed(texts) {                        ← same async signature as Ollama's
      return texts.map(() => {                  ← one vector per input text
        const v = new Array(768).fill(0);       ← 768 zeros...
        v[1] = 1;                               ← ...with a 1 at index 1:
        return v;                               ← CONSTANT — the load-bearing bit
      });
    },
  };
```

And the injection site:

```
  test/runtime.test.ts  (lines 32-34)

  const store = new PgVectorStore({ pool, appId: 'test' });
  const pipeline = createRetrievalPipeline({ embedder: fakeEmbedder, store });
                                              │           │
                                              │           └─ real store, real SQL
                                              └─ fake provider, no network
  await indexDocumentRow(pool, 'test', pipeline, { id: 'notes/a', ... });
```

The assertions that the constant vector makes possible:

```
  test/runtime.test.ts  (lines 36-39)

  const docs = await pool.query("select id from agents.documents where id = 'notes/a'");
  assert.equal(docs.rowCount, 1);              ← exact: the documents row landed
  const chunks = await pool.query("select id from agents.chunks where document_id = 'notes/a'");
  assert.ok(chunks.rowCount! >= 1);            ← at least one chunk was embedded + stored
```

Neither assertion is possible if `embed` returns unpredictable floats — not
because the floats would change the *count*, but because the test's whole point
is to prove the deterministic plumbing works without a model in the loop.

---

## Elaborate

This is the classic "humble object" / "test double at the boundary" pattern
applied to AI code. The non-deterministic node (the model call) is pushed behind
an interface so a deterministic stub can replace it. It's the same instinct as
faking `fetch`, faking `Date.now`, faking a random seed — isolate the source of
unpredictability behind a seam, then control it in the test.

Where it goes next in this repo: the *chat session* path (`session.ts`) has the
same shape but isn't covered. `GemmaModelProvider` is injected the same way
(`session.ts:46`, wrapped in `ContextWindowGuardedProvider`), so a fake
`ModelProvider` returning a scripted tool-call + answer would let you assert the
deterministic wrapper of `createChatSession`'s per-turn `ask()` — profile
injection, the user-turn-before-agent ordering (`session.ts:61`), tool dispatch
landing a `tool` row, and the swallowed memory-failure branch (`session.ts:66-69`)
— without live Gemma. The technique is proven; it just hasn't been extended past
the embedder yet. → see `audit.md` lens 6.

The handoff to evals: this fake answers "does indexing work?" It does **not**
answer "is the embedding good?" That's `scorePrecisionAtK` over
`eval/queries.json`, reported by `eval-cmd.ts`, owned by `study-ai-engineering`.
Same seam, two questions — deterministic on this side, probabilistic on that.

---

## Interview defense

**Q: Why fake the embedder instead of running real Ollama in the test?**

Three reasons: speed (no model load per test), no external dependency in the
test environment, and — the real one — *determinism*. Real embeddings are floats
I can't predict, so I can only assert "something happened." A constant fake
vector lets me assert exact rows by id. I'm testing the indexing plumbing, not
the embedding quality.

```
  real Ollama                fake embedder
  ───────────                ─────────────
  slow, needs model          instant
  floats unpredictable       constant vector
  assert "something ran"     assert exact rowCount + id
```

**Anchor:** "Fake the one non-deterministic node, run everything else for real."

**Q: How do you make sure the fake doesn't drift from the real provider?**

I type it as the real `EmbeddingProvider` interface. If aptkit changes the
contract, the fake stops compiling. The compiler keeps the stub honest.

**Anchor:** "Type the double as the real interface — TS enforces the contract."

---

## Validate

1. **Reconstruct:** Write the minimal object that satisfies aptkit's
   `EmbeddingProvider` and returns a constant 768-dim vector.
2. **Explain:** Why does `dimension: 768` in the fake (`runtime.test.ts:15`)
   matter? (Mismatch trips `assertDim` at `pg-vector-store.ts:33` before
   indexing.)
3. **Apply:** Extend the pattern to test `session.ts`'s `ask()` profile
   injection without live Gemma — what do you fake? (A `ModelProvider` returning
   a scripted response; inject at the `RagQueryAgent` constructor in
   `createChatSession`.)
4. **Defend:** Someone says "just run real Ollama, it's more realistic." Argue
   the cost. (Non-deterministic floats → no `equals` assertion; you'd be back to
   "something happened.")

---

## See also

- `audit.md` — lens 2 (the only test double, used at a real seam), lens 6 (the
  AI-feature seam and the untested agent boundary).
- `01-env-gated-integration-tests.md` — the *other* dependency-isolation move:
  skip vs substitute.
- `03-contract-parity-vector-store.md` — the `store` the fake pipeline writes to.
- `.aipe/study-ai-engineering/` — the eval half of this seam (precision@k).
- `.aipe/study-debugging-observability/` — the trace the agent path emits.
- `05-full-signal-trace-capture.md` — what the trace sink now persists once the
  agent runs.

---

Updated: 2026-06-24 — repointed the embedder-injection seam refs from the
deleted `ask-cmd.ts` to `session.ts:40-46` / `eval-cmd.ts:14` / `index-cmd.ts`;
the "where it goes next" target is now `createChatSession`'s per-turn `ask()`
(fake `ModelProvider` to assert user-turn ordering + swallowed memory-failure
branch).
