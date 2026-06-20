# Contract-Parity Vector Store

**Industry names:** Liskov substitution test · drop-in replacement / contract
test · "honor the interface the in-memory store set." **Type:** Industry
standard (the `VectorStore` contract is project-specific to aptkit).

---

## Zoom out, then zoom in

aptkit ships an in-memory `VectorStore` with a contract: `upsert(chunks)` and
`search(vector, k)`, where chunks are just `{ id, vector, meta }`. buffr's
`PgVectorStore` implements that same contract over pgvector so it drops into the
exact same pipeline. The test proves the swap is invisible to the pipeline —
and one piece of the *schema* (a missing foreign key) exists purely to keep that
swap honest.

```
  Zoom out — PgVectorStore as a drop-in

  ┌─ Pipeline (aptkit) ─────────────────────────────────────┐
  │  createRetrievalPipeline({ embedder, store })           │
  │                                   │                      │
  │            store satisfies VectorStore { upsert, search }│
  └───────────────────────────────────┼─────────────────────┘
                  swap is invisible    │
        ┌──────────────────────────────┴──────────────────────┐
        ▼                                                      ▼
  ┌─ aptkit in-memory ──┐                       ┌─ buffr PgVectorStore ─┐
  │  Map<id, chunk>      │                       │  agents.chunks table  │ ← we are here
  │  cosine in JS        │                       │  embedding <=> $::vec  │
  └──────────────────────┘                       └────────────────────────┘
```

Zoom in: the pattern is a **contract test that pins drop-in parity.** Whatever
the in-memory store promises the pipeline, `PgVectorStore` must promise too —
same method shapes, same "upsert a chunk that references nothing and it still
works" tolerance. The test plants two chunks and asserts the right one ranks
first; the *schema* drops the FK so the parity holds.

---

## Structure pass

Two implementations of one contract, one axis: **state — where do chunks live,
and what do they require to exist?**

```
  Axis: "what must exist before a chunk can be stored?" — across the swap

  ┌─ in-memory store ───────────┐
  │  chunk needs: nothing        │   → upsert any {id, vector, meta}
  │  no document concept         │
  └──────────────┬───────────────┘
       seam: VectorStore.upsert  ← the contract; parity required here
  ┌──────────────▼───────────────┐
  │  PgVectorStore                │   → MUST also need nothing:
  │  agents.chunks, document_id   │     document_id is a plain text column,
  │  is a SOFT link (no FK)       │     NO foreign key  ← the parity fix
  └───────────────────────────────┘
```

The seam is `VectorStore.upsert`. The in-memory store accepts a chunk that
references no document, because it has no notion of documents. For parity,
`PgVectorStore.upsert` must accept the same chunk — so `agents.chunks.document_id`
**cannot** be a foreign key, or the swap would break exactly where the
in-memory store would have succeeded. **The missing FK is the contract made
physical.**

---

## How it works

### Move 1 — the mental model

You know how an interface in TypeScript lets you pass either implementation to
the same function, and the function doesn't care which? The contract test checks
the part the type system *can't*: that the runtime behavior matches too —
ranking, tolerance, return shape.

```
  Contract parity — same calls, same observable behavior

         VectorStore contract
         ┌──────────────────┐
         │ upsert(chunks)   │
         │ search(vec, k)   │
         └────────┬─────────┘
        type-checked │  but behavior is NOT
                     │  type-checked — the test checks it
        ┌────────────┴────────────┐
        ▼                         ▼
  in-memory: ranks by      PgVectorStore: ranks by
  cosine, k results        cosine, k results
        └──── must match ─────────┘
```

### Move 2 — the walkthrough

**The plant-and-rank assertion proves ordering parity.** The test upserts two
chunks — `planted#0` with one-hot vector `vec(5)`, `other#0` with `vec(200)` —
then searches with `vec(5)` and asserts `planted#0` is `hits[0]`. The in-memory
store would rank the same way (cosine sim 1.0 vs 0.0). So the test isn't really
"does pgvector work" — it's "does pgvector rank the way the pipeline expects,
the way the in-memory store would." Same query, same top hit, same score
ordering.

```
  Plant-and-rank — one-hot vectors make the order certain

  upsert:  planted#0 = vec(5)   [0,0,0,0,0,1,0,...]
           other#0   = vec(200) [...,1 at 200,...]
  search:  vec(5)
               │  cosine(vec5, vec5)   = 1.0  ► planted#0  (rank 0)
               │  cosine(vec5, vec200) = 0.0  ► other#0    (rank 1)
               ▼
  assert hits[0].id === 'planted#0'  AND  hits[0].score >= hits[1].score
```

**The return shape is rebuilt to match the in-memory contract.** pgvector hands
back flat columns (`document_id`, `chunk_index`, `content`). The in-memory store
hands the pipeline a `meta` object with `docId`, `chunkIndex`, `text`. So
`PgVectorStore.search` *reassembles* that meta shape from the columns
(`pg-vector-store.ts:80-84`) — and the test asserts
`hits[0].meta.text === 'the planted passage'` to pin it. Without the rebuild,
the `search_knowledge_base` tool's citations (which read `meta.text`) would
break on the swap. The test guards the shape the consumer depends on.

**The missing FK is the load-bearing parity decision.** Here's the part worth
slowing down on. The in-memory store lets you `upsert` a chunk whose `docId`
points at no document — it has no documents at all. If `agents.chunks.document_id`
were a real foreign key to `agents.documents(id)`, then `PgVectorStore.upsert`
of a chunk with no matching documents row would throw a constraint violation —
and the swap would *fail where the in-memory store succeeds.* So the schema
deliberately makes `document_id` a plain `text` column with no FK, and even
drops the constraint if an older DB had one.

```
  Why a real FK would break the contract

  pipeline upserts chunk { docId: 'planted', ... }
  but NO documents row 'planted' exists yet (in-memory has no documents)
            │
   FK present │                       FK absent (chosen)
            ▼                              ▼
  insert into chunks ──► FK             insert into chunks ──► OK
  violation: document_id                document_id stored as
  'planted' not in documents            plain text, soft link
            │                              │
   PgVectorStore THROWS                  PgVectorStore matches
   where in-memory SUCCEEDS              in-memory behavior  ✓
```

This is why `pg-vector-store.test.ts` upserts chunks with **no seeded documents
rows** (`pg-vector-store.test.ts:32-35`) and **passes** — the FK concern is
real, and the schema resolved it in favor of parity. The test would only fail
here if someone re-added the FK. (`runtime.test.ts` *does* seed a documents row
first, because `indexDocumentRow` writes both — but that's a different code
path with stronger guarantees, not a contradiction.)

**The skeleton — what breaks without each part:**

- **The plant-and-rank assertion.** Drop it and ranking parity is unverified —
  the store could return results in the wrong order and nothing notices.
- **The meta-shape assertion** (`meta.text`). Drop it and citation breakage on
  the swap goes uncaught.
- **The absent FK in the schema.** Add it back and `upsert` of an orphan chunk
  throws — parity broken at the storage layer. **Load-bearing for the contract.**
- **One-hot vectors.** Use arbitrary floats and ranking becomes probabilistic;
  the assertion could flip. (Shared with `01`/`02`'s determinism story.)

### Move 3 — the principle

A drop-in replacement must honor the *behavioral* contract, not just the type
signature — and sometimes that constraint reaches all the way down into your
schema. The in-memory store's "a chunk needs no document to exist" is part of
its contract; pgvector honors it by dropping the FK. Liskov substitution isn't
satisfied by implementing the interface — it's satisfied when the substitute
*behaves* identically everywhere the caller can observe, including the cases the
caller never thought to mention.

---

## Primary diagram

The full picture — one contract, two stores, the FK decision that keeps them
interchangeable.

```
  Contract-parity vector store — the swap and the schema that enables it

  ┌─ Pipeline expects VectorStore ─────────────────────────────┐
  │  upsert({id, vector, meta})   ·   search(vector, k) → hits  │
  └───────────────┬───────────────────────────┬────────────────┘
       in-memory  │                            │  PgVectorStore (tested)
  ┌───────────────▼────────┐      ┌────────────▼─────────────────────┐
  │ Map<id, chunk>          │      │ insert into agents.chunks         │
  │ chunk needs no document │      │   document_id text  ← NO FK       │
  │ cosine in JS            │      │ order by embedding <=> $::vector  │
  │                         │      │ score = 1 - distance              │
  └─────────────────────────┘      │ rebuild meta {docId,chunkIndex,   │
                                   │   text} from columns              │
                                   └───────────────────────────────────┘
       both: same top hit, same order, same meta shape
       test: plant vec(5) + vec(200) → assert planted#0 first
              upsert with NO documents row → still works (FK absent)
```

---

## Implementation in codebase

**Use cases.** `PgVectorStore` is the production store in every CLI
(`ask-cmd.ts:21`, `index-cmd.ts:19`, `eval-cmd.ts:15`). The contract test exists
to prove that swapping it in for aptkit's in-memory store changes nothing the
pipeline can observe.

The plant-and-rank test, annotated:

```
  test/pg-vector-store.test.ts  (lines 30-40)

  await store.upsert([
    { id: 'planted#0', vector: vec(5),                    ← one-hot at index 5
      meta: { docId: 'planted', chunkIndex: 0, text: 'the planted passage' } },
    { id: 'other#0', vector: vec(200), meta: { ... } },   ← orthogonal vector
  ]);                                                      ← NOTE: no documents
                                                            rows seeded — relies
                                                            on the absent FK
  const hits = await store.search(vec(5), 2);
  assert.equal(hits[0]?.id, 'planted#0');                 ← ranking parity
  assert.equal(hits[0]?.meta.text, 'the planted passage');← meta-shape parity
  assert.ok(hits[0]!.score >= hits[1]!.score);            ← score ordering parity
```

The schema decision that makes the orphan upsert legal:

```
  sql/001_agents_schema.sql  (lines 14-27)

  create table if not exists agents.chunks (
    id text primary key,
    -- Soft link to documents.id (no FK): the VectorStore contract upserts
    -- chunks with no notion of a documents row, so a hard FK would break
    -- drop-in parity.
    document_id text,                                     ← plain column, NOT a FK
    ...
  );
  alter table agents.chunks drop constraint if exists chunks_document_id_fkey;
                                                          ← removes the FK on any
                                                            DB migrated before this
```

The comment at `001_agents_schema.sql:15-17` is the design rationale stated in
the schema itself: the FK was dropped *for* contract parity. Worth noting:
`context.md` line 30 still describes `chunks.document_id` as an "FK → documents"
— that's stale documentation; the live schema has no such FK. The test is
correct; the doc drifted.

The meta-rebuild the test pins:

```
  src/pg-vector-store.ts  (lines 80-84)

  return rows.map((r) => ({
    id: r.id,
    score: Number(r.score),
    meta: { ...(r.meta ?? {}), docId: r.document_id,      ← columns → in-memory
            chunkIndex: r.chunk_index, text: r.content }, ← meta shape rebuilt
  }));
```

---

## Elaborate

This is the Liskov Substitution Principle as a *test*, not a lecture. The
interesting twist is that satisfying it forced a schema change — the FK that a
data-modeling instinct would add ("chunks reference documents, so constrain it")
is the very thing that breaks the substitution. The repo chose parity over
referential integrity at the storage layer, accepting the cost: an orphan chunk
(document_id pointing at nothing) is *possible* in the database, and nothing
stops it. That's a real tradeoff, made deliberately — the comment proves it was
a decision, not an oversight. → for the data-modeling angle on that tradeoff,
see `.aipe/study-software-design/` and a data-modeling guide if one exists.

The contract test is also the cheapest insurance against a future "optimization"
re-adding the FK. Anyone who adds `references agents.documents(id)` back will
turn `pg-vector-store.test.ts` red on the orphan upsert — the test encodes the
reason the FK is gone, which a schema comment alone can't enforce.

---

## Interview defense

**Q: Why is there no foreign key from chunks to documents? That looks like a bug.**

It's deliberate, and it's a contract decision. `PgVectorStore` is a drop-in for
aptkit's in-memory `VectorStore`, whose contract lets you upsert a chunk that
references no document — it has no documents at all. A real FK would make my
Postgres store *throw* exactly where the in-memory store *succeeds*, breaking
substitution. So `document_id` is a soft link. The test upserts orphan chunks
and passes precisely because the FK is absent.

```
  FK present                    FK absent (chosen)
  ──────────                    ──────────────────
  referential integrity ✓       drop-in parity ✓
  orphan upsert THROWS          orphan upsert OK
  breaks the VectorStore        honors the VectorStore
  contract                      contract
```

**Anchor:** "The missing FK is the contract made physical — parity over
integrity, on purpose."

**Q: How do you know the Postgres store ranks the same as the in-memory one?**

The plant-and-rank test: one-hot vectors at indices 5 and 200, query at 5,
assert the index-5 chunk ranks first with the higher score. Cosine is exact
here, so the order is certain — and it's the order the in-memory store would
produce.

**Anchor:** "Plant orthogonal vectors, assert the top hit — ranking parity, not
just type parity."

---

## Validate

1. **Reconstruct:** Explain why upserting a chunk with `docId: 'planted'` and no
   `documents` row succeeds in this repo. (No FK on `chunks.document_id`.)
2. **Explain:** What would `pg-vector-store.test.ts:32-35` do if someone added
   `references agents.documents(id)` to the schema? (Throw a constraint
   violation; test goes red — by design.)
3. **Apply:** A new `WeaviateVectorStore` is added. What's the minimum test to
   prove it's a valid drop-in? (Plant-and-rank + meta-shape + orphan-upsert
   tolerance.)
4. **Defend:** Justify parity over referential integrity to a DBA who wants the
   FK. (The FK breaks the interface contract; integrity is enforced one layer
   up by `indexDocumentRow` writing the documents row first.)

---

## See also

- `audit.md` — lens 5 (the dimension-mismatch error path, also in this file's
  store).
- `02-fake-embedder-injection.md` — the pipeline that writes to this store.
- `04-idempotent-migration-test.md` — the schema (including the FK drop) this
  test depends on.
- `.aipe/study-software-design/` — the parity-over-integrity tradeoff as a
  design decision; data-modeling consequences of the soft link.
