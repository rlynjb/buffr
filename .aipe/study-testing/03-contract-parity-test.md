# Contract-parity test

**Industry name:** contract test / interface-conformance test · drop-in parity against a shared port. *Industry-standard pattern, here on aptkit's `VectorStore` interface.*

**Determinism seam:** testing (deterministic). The test plants a known vector and asserts the *exact* row ranks on top — `assert.equal(hits[0].id, 'planted#0')`. No "good enough"; this is `==`.

---

## Zoom out, then zoom in

aptkit defines a `VectorStore` interface and ships an in-memory implementation. buffr writes a second implementation — `PgVectorStore` — backed by Postgres + pgvector, and swaps it in wherever aptkit expects a store. For that swap to be safe, the Postgres store must behave *the same* as the in-memory one: same upsert semantics, same ranking, same dimension enforcement. The contract-parity test (the `PgVectorStore ↔ the in-memory store` suite) is what pins that "same."

```
  Zoom out — two adapters behind one port

  ┌─ aptkit (the port) ─────────────────────────────────────┐
  │  interface VectorStore { upsert(chunks); search(v, k) }  │ ← the contract
  └───────────────┬─────────────────────────┬────────────────┘
        implements │             implements  │
  ┌────────────────▼──────┐      ┌───────────▼────────────────┐
  │ in-memory store        │      │ ★ PgVectorStore ★          │ ← buffr's adapter
  │ (aptkit, tested there) │      │ (pgvector, tested HERE)    │
  └────────────────────────┘      └─────────────────────────────┘

  the test asserts PgVectorStore honors the SAME contract,
  so it's a drop-in for the in-memory one
```

Zoom in: the pattern is a **contract test** — a test written against an *interface*, asserting an *implementation* satisfies the interface's behavioral promises, not just its type signature. The type checker proves `PgVectorStore implements VectorStore` (`pg-vector-store.ts:19`). The contract test proves the runtime *behavior* matches: plant a vector, search for it, get it back ranked first.

---

## The structure pass

**Layers:** (1) the `VectorStore` interface (aptkit), (2) the `PgVectorStore` adapter (buffr), (3) Postgres + the HNSW cosine index underneath.

**Axis traced — *what guarantees does each side promise?*** The interface promises "upsert chunks, search returns nearest-by-similarity, dimension mismatch is an error." The adapter must deliver all three against pgvector. The index promises *approximate* nearest-neighbor — which is why the parity test asserts ranking *order* (`>=`), not exact distances.

**The seam:** the `VectorStore` interface is the contract boundary. A deliberate decision sits right on it: the `chunks → documents` foreign key was **dropped** so `PgVectorStore.upsert` can write chunks with no documents row — exactly as the in-memory store does (it has no notion of documents). The FK drop is *parity-over-integrity*: buffr accepts losing referential integrity to keep the drop-in promise. The test proves the parity half; the dropped FK is what makes it possible.

---

## How it works

### Move 1 — the mental model

You know how a `Map` and a `localStorage`-backed store can both implement a `get/set` interface, and code that depends on the interface works with either? A contract test is the test you'd write to prove the `localStorage` version actually behaves like the `Map` version — same keys in, same values out. Here the interface is `VectorStore`, the reference is aptkit's in-memory store, and the implementation under test is `PgVectorStore`.

```
  The contract-parity kernel

   plant a known vector ──► upsert ──► search for it ──► assert it ranks #1
        vec(5)                                              hits[0].id === 'planted#0'

   if PgVectorStore is a true drop-in, this holds —
   the same script would pass against the in-memory store
```

### Move 2 — the walkthrough

**Plant a vector whose nearest neighbor is known.** The test builds one-hot vectors — all zeros with a single `1` — so similarity is trivially predictable: a vector is closest to itself and far from a vector with the `1` in a different slot.

```ts
// test/pg-vector-store.test.ts:24-28
function vec(seed: number): number[] {
  const v = new Array(768).fill(0);
  v[seed] = 1;
  return v;
}
```

`vec(5)` and `vec(200)` are orthogonal — cosine similarity 0 between them, 1 with themselves. That's a deliberately rigged input: it removes any ambiguity about which result *should* rank first, so the assertion is about the store's *ranking machinery*, not about fuzzy embedding closeness.

**Upsert two chunks, then search with the planted vector.** One chunk gets `vec(5)`, the other `vec(200)`; the search query is `vec(5)`.

```ts
// test/pg-vector-store.test.ts:30-40
const store = new PgVectorStore({ pool, appId: 'test' });
await store.upsert([
  { id: 'planted#0', vector: vec(5),   meta: { docId: 'planted', chunkIndex: 0, text: 'the planted passage' } },
  { id: 'other#0',   vector: vec(200), meta: { docId: 'other',   chunkIndex: 0, text: 'unrelated passage' } },
]);
const hits = await store.search(vec(5), 2);
assert.equal(hits[0]?.id, 'planted#0');                  // the planted chunk ranks FIRST
assert.equal(hits[0]?.meta.text, 'the planted passage'); // and its meta round-trips
assert.ok(hits[0]!.score >= hits[1]!.score);             // ordering holds (>= not ==: HNSW is approximate)
```

Three assertions, three contract promises:
- **`hits[0].id === 'planted#0'`** — search returns nearest-first. This is the core ranking promise.
- **`hits[0].meta.text === 'the planted passage'`** — the meta shape survives the round-trip. `PgVectorStore.search` rebuilds the in-memory meta shape from columns (`pg-vector-store.ts:79-84`: `{ docId, chunkIndex, text }`) so the `search_knowledge_base` tool's citations work. The test pins that reconstruction.
- **`hits[0].score >= hits[1].score`** — *order*, asserted as `>=` not `==`. The HNSW index is approximate; pinning exact distances would be the flaky assertion. Asserting order is the right strength: strong enough to catch a broken ranking, loose enough to tolerate approximate-NN.

**The parity-over-integrity proof is implicit in what's NOT there.** Notice the upsert plants chunks with `docId: 'planted'` but **no `documents` row is inserted first**. Against a schema with the FK intact, this would throw a foreign-key violation. It passes because the FK was dropped (`sql/001_agents_schema.sql`: `alter table agents.chunks drop constraint if exists chunks_document_id_fkey`). That's the in-memory store's behavior — it accepts chunks with no document — replicated in Postgres. The test passing *is* the parity proof.

```
  Layers-and-hops — the contract assertion path

  ┌─ Test ────────────┐ hop1: upsert(planted, other)  ┌─ PgVectorStore ──┐
  │  vec(5), vec(200)  │ ────────────────────────────► │ insert chunks    │
  │  NO documents row  │   (FK dropped → no violation) │ (parity)         │
  └───────────────────┘                                └────────┬─────────┘
                            hop2: search(vec(5), 2)              │ <=> cosine
                       ┌────────────────────────────────────────┘  order by
                       ▼
            ┌─ Storage: HNSW cosine index ──────────────┐
            │  returns nearest-first (approximate)       │
            └────────┬───────────────────────────────────┘
                     │ hop3: rebuild meta {docId,chunkIndex,text}
                     ▼
            assert: hits[0].id==='planted#0', meta round-trips, order holds
```

### Move 3 — the principle

A contract test is insurance on a substitution. The value isn't "PgVectorStore works" — it's "PgVectorStore works *the same way* aptkit's store does, so swapping it in won't surprise the caller." The discipline is to test against the *interface's promises*, at the right strength: assert *order* where the backend is approximate, assert *exact* where it's deterministic (the id, the meta). And name the tradeoff the contract bought: parity-over-integrity — buffr dropped the FK to keep the drop-in promise, accepting that a chunk can now point at a nonexistent document. That's a deliberate cost, tested into place, not an accident.

---

## Primary diagram

```
  Contract-parity test — full picture

  ┌─ the contract (VectorStore) ───────────────────────────────────┐
  │  upsert: accept chunks (no documents row required)              │
  │  search: return nearest-first by cosine similarity             │
  │  meta: round-trip {docId, chunkIndex, text}                    │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ PgVectorStore must satisfy all three
  ┌─ the test ───────────────────▼─────────────────────────────────┐
  │  plant vec(5)='planted#0', vec(200)='other#0'  (no documents)   │
  │  search(vec(5), 2)                                              │
  │  ✓ hits[0].id === 'planted#0'        (nearest-first)            │
  │  ✓ hits[0].meta.text round-trips      (citation shape)         │
  │  ✓ hits[0].score >= hits[1].score     (order, HNSW-approximate) │
  │  ✓ no FK violation                    (parity-over-integrity)   │
  └─────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Contract testing comes from the problem of multiple implementations behind one interface — classically, the same test suite is run against *every* implementation to prove they're interchangeable. Here only `PgVectorStore` is tested in buffr (the in-memory store is tested in aptkit, upstream), so it's a one-sided contract test: buffr asserts its adapter matches the contract the in-memory reference defines. If buffr ever grew a second store, the honest move would be to extract these assertions into a shared suite run against both.

The dimension-mismatch test in the same file (`pg-vector-store.test.ts:42-46`) is part of the same contract: the interface promises a 768-dim store, and a wrong-length vector must throw, never truncate (the must-not-change constraint in the project context). That's an error-branch contract assertion — see `audit.md` lens 5, where it's noted as the one error path this repo actually tests.

The parity-over-integrity decision links to data modeling: the dropped FK is a normalization/integrity tradeoff. Cross-link to `study-data-modeling` for the schema-shape view; here it matters only as *the thing that lets the parity test pass*.

---

## Interview defense

**Q: Why assert ranking order with `>=` instead of exact scores?**
Because the HNSW index is approximate-nearest-neighbor by design — it trades exact recall for speed. Pinning exact cosine distances would make the test flaky the moment the index parameters or pgvector version shifted the computed distance in the last decimal. Asserting *order* (`hits[0].score >= hits[1].score`) is the right strength: it catches a genuinely broken ranking but tolerates the approximation the index is supposed to have.

```
  assertion strength vs backend

  exact id / exact meta   →  ==   (deterministic: the planted chunk IS planted#0)
  ranking distances       →  >=   (approximate: HNSW is allowed to be fuzzy)
```

*Anchor:* "Assert order, not distance — HNSW is approximate, so exact-distance is the flaky assertion."

**Q: The test plants chunks with no documents row — isn't that a bug?**
No, it's the contract. aptkit's in-memory store has no concept of a documents row, so `PgVectorStore` had to accept chunks without one to stay a drop-in. buffr dropped the `chunks → documents` FK on purpose — parity-over-integrity. The test passing *is* the proof that the Postgres adapter matches the in-memory one's looser shape. If I'd kept the FK, the test would throw a foreign-key violation and the store would no longer be a drop-in.

*Anchor:* "Dropped FK on purpose — parity-over-integrity — so the Postgres store is a true drop-in for aptkit's in-memory one."

---

## See also

- `02-fake-embedder-injection.md` — the same port-substitution idea applied to the `EmbeddingProvider` interface.
- `04-idempotent-migration-test.md` — the migration that creates (and drops the FK on) the `chunks` table this test relies on.
- `audit.md` lens 5 — the dimension-mismatch error branch, the contract's one tested error path.
- `study-data-modeling` — the dropped-FK decision as a schema/integrity tradeoff.
