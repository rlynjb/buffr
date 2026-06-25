# Vector Store Adapter

**Industry names:** Adapter pattern · Ports-and-Adapters (hexagonal) ·
"implement the interface" · Project-specific (this is buffr's load-bearing seam)

## Zoom out, then zoom in

Here's the whole thing. aptkit defines a `VectorStore` *contract* — an
interface with `upsert` and `search`. The agent, the retrieval pipeline, the
citation tool all talk to that interface and nothing below it. buffr's job is
to write one class that satisfies the contract over Postgres. Swap the class,
and the entire agent runs against a different store with zero changes above
the seam.

```
  Zoom out — where the adapter lives

  ┌─ Toolkit layer (@rlynjb/aptkit-core) ─────────────────────┐
  │  RagQueryAgent → RetrievalPipeline → VectorStore (interface)│
  │                                          ▲                 │
  └──────────────────────────────────────────┼────────────────┘
                                              │  implements
  ┌─ Adapter layer (buffr) ──────────────────┼────────────────┐
  │              ★ PgVectorStore ★  ← we are here              │
  │       upsert(chunks)        search(vector, k)             │
  └──────────────────────────────────────────┬────────────────┘
                                              │  pg (node-postgres)
  ┌─ Storage layer (Postgres + pgvector) ─────▼────────────────┐
  │  agents.chunks  (embedding vector(768), HNSW cosine)       │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **an adapter behind a port**. aptkit owns the port
(`VectorStore`); `PgVectorStore` is the adapter. The reason this earns its own
file: strip it out and buffr loses the ability to graduate the in-memory toy
to a persistent brain *without touching the agent*. That substitutability is
the whole "v1b" thesis.

## Structure pass

**Layers** — three, top to bottom: agent/pipeline (toolkit) → `VectorStore`
port → `PgVectorStore` adapter → pg/SQL → Postgres.

**Axis: who owns the data shape?** Trace it down the stack.

```
  One question down the layers: "who owns the chunk's shape?"

  ┌─────────────────────────────────────────────┐
  │ toolkit: tool wants meta.{docId,chunkIndex,  │  → TOOLKIT owns
  │          text} for citations                 │     the read shape
  └───────────────────────┬─────────────────────┘
      ┌───────────────────▼─────────────────────┐
      │ adapter: PgVectorStore translates both   │  → ADAPTER owns
      │          ways (meta ⇄ columns)           │     the translation
      └───────────────────┬─────────────────────┘
          ┌───────────────▼─────────────────────┐
          │ storage: columns id, document_id,    │  → DB owns
          │          chunk_index, content        │     the canonical row
          └─────────────────────────────────────┘

  the answer flips at the adapter — that's the seam
```

**Seam.** The `VectorStore` interface is a *horizontal seam*: above it,
aptkit reasons in `{id, vector, meta}`; below it, Postgres reasons in typed
columns. The axis (who owns the shape) flips exactly here, which is why this
boundary is load-bearing and not cosmetic. The adapter's real work is
**bidirectional translation across that flip** — and the trap is the read
path, where the DB's columns must be reassembled into the exact `meta` shape
the citation tool expects.

## How it works

### Move 1 — the mental model

You know how a React component takes `props` and doesn't care whether they
came from `useState`, a fetch, or a parent — it just reads the shape it was
promised? An adapter is the same idea pointed at storage: the agent reads the
`VectorStore` shape and doesn't care that pg is underneath.

```
  The adapter kernel — one port, swappable bodies

         ┌──────────── VectorStore (port) ────────────┐
         │  upsert(chunks)            search(vec, k)   │
         └───────┬─────────────────────────┬───────────┘
                 │                          │
        ┌────────▼────────┐       ┌─────────▼─────────┐
        │ InMemoryVectorStore│    │   PgVectorStore   │  ← buffr
        │ (aptkit, the toy)  │    │   (Postgres)      │
        └───────────────────┘     └───────────────────┘
              same calls, two bodies — agent unchanged
```

### Move 2 — the step-by-step walkthrough

#### The contract is two methods plus one constant

`VectorStore` promises exactly three things: a `dimension` number, an
`upsert(chunks)`, and a `search(vector, k)`. Miss any one and the pipeline
won't accept the object. The adapter's whole surface is those three.

```
  pseudocode — the contract the adapter must satisfy

  interface VectorStore:
    dimension: number                       // how wide a vector must be
    upsert(chunks: {id, vector, meta}[])     // write/overwrite
    search(vector, k) -> {id, score, meta}[] // nearest k
```

What breaks if `dimension` is wrong: the pipeline embeds with one width and
the store stores another, and every search silently mismatches. So the
adapter guards it.

#### Write path — meta fields become columns

`upsert` pulls the typed columns *out of* `meta` (aptkit packs `docId`,
`chunkIndex`, `text` into `meta`), then writes a real row.

```
  write path — meta → columns, in one transaction

  chunk.meta = { docId:'work', chunkIndex:0, text:'...' }
        │  extract
        ▼
  row = { id, document_id:'work', chunk_index:0,
          content:'...', embedding:[768 floats], app_id }
        │  INSERT ... ON CONFLICT (id) DO UPDATE   ← idempotent
        ▼
  agents.chunks   (wrapped in begin/commit — all-or-nothing)
```

The `on conflict do update` is what makes re-indexing safe: same
deterministic id → overwrite, never duplicate. The boundary condition: a
vector embedded into a JS array has to become pgvector's text literal
`[0.1,0.2,...]` — that's a tiny serialize step, and forgetting the `::vector`
cast makes Postgres treat it as a string.

#### Read path — columns become meta again (the load-bearing half)

This is the part people get wrong. `search` runs the cosine query, then
**reassembles** each row back into the `meta` shape the citation tool reads —
because the tool was written against the in-memory store and expects
`meta.text`, `meta.docId`, `meta.chunkIndex`. If the adapter returned raw
columns, citations would break even though retrieval "worked."

```
  read path — the meta reconstruction that keeps citations working

  SQL row:  { id, content, chunk_index, document_id, score }
        │  remap
        ▼
  hit = { id, score,
          meta: { docId: document_id,        ← tool reads this
                  chunkIndex: chunk_index,
                  text: content } }           ← tool quotes this
        │
        ▼
  search_knowledge_base tool cites the right passage — unchanged across stores
```

#### The dimension guard — fail loud, never truncate

Before any write or search, `assertDim` checks `vector.length === dimension`.
A mismatch throws. Drop this and a wrong-width vector either errors deep in
Postgres with a cryptic message or — worse with some stores — gets silently
truncated, corrupting retrieval forever.

```
  the guard — one check, two call sites

  upsert(chunks):  for each chunk → assertDim(chunk.vector)  → throw if ≠ 768
  search(vector):  assertDim(vector)                          → throw if ≠ 768

  load-bearing: this is the 768 one-way door enforced in code,
                not just in the schema's vector(768) type
```

### Move 3 — the principle

An adapter's value is measured by what you can swap without touching anything
above it. The contract is the asset; the implementation is replaceable. buffr
proves it: the *same* round-trip test that passed against aptkit's in-memory
store passes against pg — embed, upsert, search, planted chunk on top. The
seam held.

## Primary diagram

The full adapter, both directions, with the seam marked.

```
  PgVectorStore — the full picture

  ┌─ Toolkit ──────────────────────────────────────────────────┐
  │  RetrievalPipeline ── upsert(chunks) ──┐   ┌── search(v,k) ──│
  │  citation tool ◄── {id,score,meta} ────┼───┘                 │
  └────────────────────────────────────────┼───────────────────-┘
                          VectorStore port  │  (the seam — shape flips here)
  ┌─ Adapter (PgVectorStore) ───────────────▼──────────────────┐
  │  WRITE: meta → columns, assertDim, [begin..commit]          │
  │  READ:  cosine SQL → columns → rebuild meta{docId,idx,text} │
  └────────────────────────────────────────┬───────────────────┘
                                  pg + ::vector cast
  ┌─ Storage ───────────────────────────────▼──────────────────┐
  │  agents.chunks: id, document_id, chunk_index, content,      │
  │                 embedding vector(768), app_id  · HNSW cosine│
  └─────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached for every time the agent stores or retrieves
knowledge: `index` writes corpus through `upsert`; the `chat` session and
`eval` read through `search` (via the pipeline). It is the single point where
aptkit's storage contract meets Postgres. As of 0.4.1 the SAME store instance
has a *second* consumer: aptkit's memory engine
(`createConversationMemory({ embedder, store })`, `session.ts:53`) writes
episodic memory chunks through the same `upsert`/`search`, so conversation
memory surfaces via the existing `search_knowledge_base` tool — the adapter
serves two callers through one contract.

**The class and contract** — `src/pg-vector-store.ts:19-30`

```
  export class PgVectorStore implements VectorStore {     ← line 19, the seam
    readonly dimension: number;                           ← contract requires it
    ...
    this.appId = opts.appId ?? 'laptop';                  ← line 27, tenancy key
    this.embeddingModel = opts.embeddingModel ?? 'nomic-embed-text:v1.5';
    this.dimension = opts.dimension ?? 768;               ← line 29, the 768 door
  }
        │
        └─ `implements VectorStore` is the whole architecture: drop it and the
           pipeline won't accept this object. The class IS the seam.
```

**The guard** — `src/pg-vector-store.ts:32-36`

```
  private assertDim(v: number[]): void {
    if (v.length !== this.dimension)                      ← every write & read
      throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
  }
        │
        └─ without this, a 1536-dim vector lands in a 768 column and either
           errors cryptically or corrupts retrieval. Loud-fail by design.
```

**Write path** — `src/pg-vector-store.ts:38-65`

```
  for (const c of chunks) this.assertDim(c.vector);       ← 39: guard all first
  await client.query('begin');                            ← 42: one transaction
  const docId = typeof c.meta.docId === 'string' ? c.meta.docId : null;  ← 44
  ...
  insert into agents.chunks (...) values ($1..$6::vector,$7,$8)          ← 48-49
  on conflict (id) do update set ...                      ← 50: idempotent reindex
  await client.query('commit');                           ← 58: all-or-nothing
        │
        └─ catch → rollback (59-61): a half-embedded document never persists.
           The `::vector` cast (line 49) is what turns the [..] literal into pgvector.
```

**Read path — the meta reconstruction** — `src/pg-vector-store.ts:67-85`

```
  1 - (embedding <=> $1::vector) as score                 ← 72: cosine SIMILARITY
  where app_id = $2                                        ← 73: tenant scope
  order by embedding <=> $1::vector limit $3              ← 74-75: HNSW nearest-k
  ...
  return rows.map((r) => ({
    id: r.id, score: Number(r.score),
    meta: { ...(r.meta ?? {}), docId: r.document_id,       ← 83: rebuild the
            chunkIndex: r.chunk_index, text: r.content }   ←     in-memory shape
  }));
        │
        └─ line 83 is the load-bearing line: it remaps DB columns back to the
           meta keys the citation tool reads. Without it, retrieval works but
           citations come back empty — the silent failure.
```

The `<=>` operator is cosine *distance*; the store returns `1 - distance` as
a similarity *score* (line 72) so callers get "higher is better." How pgvector
executes `<=>` and the HNSW navigation underneath → `study-database-systems`.

## Elaborate

The Adapter pattern comes from Gang-of-Four; Ports-and-Adapters (Alistair
Cockburn's hexagonal architecture) is the systems-level version: define the
domain's *ports* (interfaces it needs) and push every concrete technology to
the edge as *adapters*. aptkit is the hexagon's core (provider-agnostic),
buffr's `PgVectorStore` is one adapter on the edge. The reader has built this
shape before without naming it: in AdvntrCue, Drizzle + pgvector sat behind
the retrieval logic; here the seam is explicit and named by aptkit's
interface. The deeper lesson is the *test parity* — the design's "contract
parity" test (`laptop-supabase-graduation-design.md:178`) runs the identical
assertions against in-memory and pg, which is the proof the adapter is faithful.

## Interview defense

**Q: Why implement aptkit's `VectorStore` instead of just querying pg
directly from the agent?**

Because the contract is what lets you swap the body without touching the
agent. The pipeline, the agent loop, the citation tool all depend on the
*interface*, not on Postgres. I proved it with the same round-trip test
passing against both stores.

```
  agent ── depends on ──► VectorStore (port)
                              ▲
              ┌───────────────┴───────────────┐
         InMemory (toy)                  PgVectorStore (pg)
              swap freely — agent never changes
```

Anchor: `src/pg-vector-store.ts:19` — `implements VectorStore`.

**Q: What's the one line everyone forgets in an adapter like this?**

The read-path reconstruction (`pg-vector-store.ts:83`). It's easy to make
`search` return the DB columns and call it done — retrieval ranks correctly,
the test "passes" on ordering. But the citation tool reads `meta.text` /
`meta.docId`, so if you don't rebuild that shape, citations come back empty
and you've shipped a silent failure. The load-bearing part of an adapter is
the *translation back to the caller's expected shape*, not the query.

```
  raw columns ──X──► tool reads meta.text → undefined → empty citation
  rebuilt meta ──✓──► tool reads meta.text → the passage → correct citation
```

Anchor: `src/pg-vector-store.ts:80-84`.

## Validate

1. **Reconstruct.** From memory, name the three members `VectorStore`
   requires and where each is satisfied in `src/pg-vector-store.ts`.
2. **Explain.** Why does `search` remap columns into `meta`
   (`pg-vector-store.ts:83`) instead of returning rows raw? What breaks if it
   doesn't?
3. **Apply.** You swap `nomic-embed-text` (768) for OpenAI (1536). Which
   line throws first, and is that the behavior you want? (`assertDim`,
   `pg-vector-store.ts:32`.)
4. **Defend.** Argue for keeping the agent dependent on the `VectorStore`
   interface rather than on `pg` directly, using the parity test as evidence
   (`test/pg-vector-store.test.ts:30-40`).

## See also

- `02-retrieval-pipeline.md` — what calls `upsert` and `search`.
- `04-library-as-dependency-boundary.md` — why aptkit owns the port; the
  memory engine is the store's new second consumer.
- `study-data-modeling` — the `agents.chunks` column shape and dropped FK.
- `study-database-systems` — `<=>` cosine execution and HNSW internals.

---

Updated: 2026-06-24 — noted the store's second consumer: aptkit's
`createConversationMemory` (0.4.1) writes episodic memory chunks through the
same `PgVectorStore` (`session.ts:53`); `ask`/`eval` read path now reads
`chat`/`eval`. Adapter contract itself unchanged.
