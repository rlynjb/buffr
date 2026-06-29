# Contract-Parity Testing

**Industry names:** contract test · interface-conformance test · Liskov-
substitution check · "the new impl must be a drop-in for the old one." **Type:**
Industry standard.

## Zoom out, then zoom in

`PgVectorStore` exists to be a *drop-in replacement* for aptkit's in-memory
`VectorStore`. The whole point is that the rest of the system — the retrieval
pipeline, the `search_knowledge_base` tool — can't tell which one it's talking
to. So the test's job isn't "does pgvector work?" — it's "does pgvector honor the
*same contract* the in-memory store does?" The assertion is about parity with an
interface, not about a database feature.

```
  Zoom out — one interface, two implementations

  ┌─ Consumer layer ─────────────────────────────────────────────┐
  │  RetrievalPipeline · search_knowledge_base tool              │
  │  depends ONLY on the VectorStore interface                   │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ VectorStore { upsert, search, dimension }
              ┌───────────────────┴────────────────────┐
  ┌─ aptkit ──▼──────────────┐         ┌─ buffr ───────▼──────────┐
  │ in-memory VectorStore    │         │ PgVectorStore (★ HERE)   │
  │ (tested in aptkit)       │         │ over real pgvector       │
  └──────────────────────────┘         └──────────────────────────┘

  contract-parity test: prove PgVectorStore behaves like the interface promises
```

Zoom in: the contract has three promises — `upsert` stores chunks, `search`
returns the nearest by cosine similarity ranked best-first, and `dimension`
mismatches throw. The parity test plants two chunks, searches for one, and
asserts *that one ranks first*. If `PgVectorStore` honors the ranking promise,
the consumer can swap it in blind. The question it answers: *can I replace the
in-memory store with Postgres and have everything above keep working?*

## The structure pass

**Layers.** Consumer → `VectorStore` interface → two impls → (for pg) real
Postgres.

**Axis — trace "who guarantees the ranking?" across the boundary:**

```
  "who guarantees nearest-first ranking?" — across the two impls

  ┌─ in-memory store ─┐   interface seam   ┌─ PgVectorStore ──────────┐
  │ JS cosine + sort  │ ═════════╪═══════► │ SQL: order by <=>        │
  │ (aptkit's job)    │  (impl flips)      │ (buffr's job, untested   │
  └───────────────────┘                    │  upstream — tested HERE) │
                                           └──────────────────────────┘
       same PROMISE (nearest-first), different MECHANISM
```

**Seam.** The `VectorStore` interface is the load-bearing seam: the
*implementation* flips across it (JS sort vs SQL `order by embedding <=>`) while
the *contract* stays fixed. That's the definition of a contract test — assert the
promise holds no matter which side of the seam you're on.

## How it works

#### Move 1 — the mental model

You know this from swapping a `useState` for a `useReducer`: the component above
shouldn't care which one backs the state, as long as the read/update contract is
identical. A contract test pins that contract so the swap is safe. Here the
contract is `VectorStore`, the swap is in-memory → pgvector, and the test pins
"search returns the planted chunk on top."

```
  Contract-parity — plant a known winner, assert it wins

  upsert:  planted#0 @ vec(5)     ← unit vector, slot 5 hot
           other#0   @ vec(200)   ← unit vector, slot 200 hot

  search(  vec(5),  k=2 )         ← query identical to planted's vector
           │
           ▼
  cosine:  planted#0  score 1.0   ← exact match, MUST rank first
           other#0    score 0.0   ← orthogonal
           │
           ▼
  assert:  hits[0].id == 'planted#0'   AND   hits[0].score >= hits[1].score
```

The kernel: **a planted input whose correct ranking is known a priori + an
assertion on rank order, not on the raw score.** Drop the "known winner" framing
and you're asserting floating-point scores you'd have to hardcode. Asserting
*order* (`hits[0]` is planted, `score >= `) is robust to the exact cosine value.

#### Move 2 — the walkthrough

**The deterministic vectors.** `pg-vector-store.test.ts:24-28`:

```ts
function vec(seed: number): number[] {
  const v = new Array(768).fill(0);
  v[seed] = 1;            // one-hot: a unit vector pointing along axis `seed`
  return v;
}
```

Two one-hot vectors on different axes are *orthogonal* — cosine similarity 0. A
vector with itself is cosine 1. So `vec(5)` is maximally similar to `vec(5)` and
maximally dissimilar to `vec(200)`. The test rigs the geometry so the right
answer is unambiguous.

**Plant, search, assert rank.** `pg-vector-store.test.ts:30-40`:

```ts
await store.upsert([
  { id: 'planted#0', vector: vec(5),   meta: { docId: 'planted', ..., text: 'the planted passage' } },
  { id: 'other#0',   vector: vec(200), meta: { docId: 'other',   ..., text: 'unrelated passage' } },
]);
const hits = await store.search(vec(5), 2);          // query == planted's vector
assert.equal(hits[0]?.id, 'planted#0');              // ranking contract
assert.equal(hits[0]?.meta.text, 'the planted passage'); // meta-rebuild contract
assert.ok(hits[0]!.score >= hits[1]!.score);         // descending-score contract
```

Three contracts in one test: nearest ranks first, the `meta.text` survives the
round-trip (the SQL rebuilds it from the `content` column at
`pg-vector-store.ts:80-84` so the tool's citations work), and scores are
descending.

**The parity-over-integrity wrinkle.** This is the sharp finding. The chunks are
upserted with **no `documents` row at all** — yet it passes. Why? Because the
`VectorStore` interface "upserts chunks with no notion of a documents row"
(`pg-vector-store.ts` comment, schema comment at `001_agents_schema.sql:16-17`),
so the `chunks → documents` FK was *deliberately dropped*. The test plants
orphan chunks specifically to prove `PgVectorStore` accepts them — because the
in-memory store it mirrors has no documents concept either.

```
  Layers-and-hops — the dropped FK is what makes parity possible

  ┌─ Test ───────────────┐  upsert orphan chunks   ┌─ PgVectorStore ──────┐
  │ no documents row      │ ─────────────────────► │ insert into chunks   │
  └───────────────────────┘                        └──────────┬───────────┘
                                          no FK check          ▼
  ┌─ agents.chunks ──────────────────────────────────────────────────────┐
  │ document_id = 'planted'  (soft link, FK dropped → orphan is legal)   │
  └──────────────────────────────────────────────────────────────────────┘

  a HARD FK here would reject the orphan → break drop-in parity → fail the test
```

**Both directions of the dimension guard.** `pg-vector-store.test.ts:42-46`
asserts a 3-dim vector rejects on *both* `upsert` and `search` with `/dimension/`.
That's the third contract promise (`dimension` mismatch throws) tested
symmetrically — defending the must-not-change "never silently truncate" rule.

#### Move 3 — the principle

A contract test asserts the *promise*, not the *implementation*. It plants an
input whose correct behavior is knowable without running the code, then checks
the new implementation produces it — so any impl honoring the contract passes and
any that drifts fails. **buffr chose parity over referential integrity on
purpose** (dropped the FK), and the test encodes that choice: orphan chunks must
be legal, because the interface buffr is mirroring has no documents.

## Primary diagram

```
  Contract-parity testing — full picture

  ┌─ VectorStore interface (the contract) ───────────────────────┐
  │  upsert(chunks) · search(vec,k)→ranked · dimension throws     │
  └──────────────────┬──────────────────────────┬────────────────┘
        aptkit impl  │                           │  buffr impl (tested here)
  ┌─ in-memory ──────▼───────┐      ┌─ PgVectorStore ─────────────▼─────────┐
  │ JS cosine + sort         │      │ SQL: 1-(embedding<=>q), order by <=>  │
  └──────────────────────────┘      │ meta rebuilt from content column       │
                                    │ NO documents FK → orphan chunks OK     │
                                    └────────────────────────────────────────┘
   test: plant vec(5)+vec(200), search vec(5) →
         assert planted#0 first · text round-trips · score descending ·
         3-dim throws both ways
```

## Elaborate

Contract tests come from the need to swap implementations safely — the Liskov
Substitution Principle made executable. The classic use is a `Repository`
interface with an in-memory impl for tests and a SQL impl for prod; you run the
*same* contract suite against both. buffr only runs it against `PgVectorStore`
(the in-memory store's suite lives in aptkit), but the framing is identical: the
test asserts conformance to a shared interface, which is what licenses the
drop-in swap in `session.ts:41`. The parity-over-integrity call is the
interesting buffr-specific twist — most schemas would *add* an FK; buffr removed
one to keep the contract honest.

## Interview defense

**Q: Your chunks table has no FK to documents and your test plants orphan chunks.
Isn't that a broken schema?** It's a deliberate trade — parity over integrity.
The `VectorStore` interface upserts chunks with no concept of a documents row, so
a hard FK would reject valid input and break drop-in compatibility with aptkit's
in-memory store. The test plants orphans precisely to prove the constraint isn't
there. We keep referential sanity by convention (the indexer writes the doc row
first, `runtime.ts:11`), not by the database.

```
  the load-bearing part people forget:
  a contract test asserts the PROMISE (nearest-first), never the SCORE.
  assert order, not floats — robust to the exact cosine value
```

**Anchor:** "We dropped the FK to keep the contract drop-in — the test plants
orphan chunks on purpose, because the interface we mirror has no documents."

## See also

- `audit.md` lens 2 — why mock-free integration is the right level for the
  SQL-as-logic store.
- `02-fake-embedder-injection.md` — the embedder side of the same interface game.
- `04-idempotent-migration-test.md` — the schema (including the dropped FK) the
  parity test depends on.
- `study-software-design` — the deep-module / drop-in-substitution design behind
  the `VectorStore` seam.
