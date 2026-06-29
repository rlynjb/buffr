# Adapter behind a contract — PgVectorStore as aptkit's VectorStore port

**Industry names:** ports & adapters · hexagonal architecture · the
adapter pattern · dependency-inversion seam. **Type:** Industry standard.

The deepest module in buffr, and the cleanest example of the design move
the whole repo is built on: depend on a *contract*, implement it with an
*adapter*, and hide everything else inside.

The role-vocabulary, named once so the rest of the file can use it:

- **the port** — aptkit's `VectorStore` interface (the contract, the
  swap point; holds the shape, no behaviour).
- **the adapter** — `PgVectorStore` (`pg-vector-store.ts`); implements
  the port over Postgres + pgvector.
- **the client** — `session.ts`'s `createChatSession`; depends on the
  port, never on Postgres.
- **the seam** — the `VectorStore` boundary itself: swap the adapter on
  one side and the client doesn't change.
- **the factory** — here, plain construction at `session.ts:41`
  (`new PgVectorStore({...})`); the one place that names the concrete
  adapter.

> Architecture-altitude treatment of this same shape (as a *service*
> boundary + scaling) lives in `study-system-design/03-provider-
> abstraction.md`. This file is the **module/interface** altitude: why
> the adapter is a *deep* module and what it hides.

---

## Zoom out, then zoom in

The port sits between aptkit's retrieval pipeline (which knows nothing
about Postgres) and your database (which knows nothing about aptkit).
Here's where it lives in the stack:

```
  Zoom out — where the adapter sits

  ┌─ UI layer (Ink) ────────────────────────────────────┐
  │  cli/chat.tsx   →   session.ask(q)                   │
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ aptkit (the library, never edited) ─────────────────┐
  │  RetrievalPipeline / search_knowledge_base tool      │
  │            depends on ↓ the PORT                      │
  │  ┌─ VectorStore (the port / contract) ────────────┐  │ ← THE SEAM
  │  │   upsert(chunks)   ·   search(vector, k)        │  │
  │  └───────────────────────▲─────────────────────────┘  │
  └──────────────────────────│───────────────────────────┘
                             │ implements
  ┌─ buffr (the adapter) ────│───────────────────────────┐
  │  ★ PgVectorStore ★  pg-vector-store.ts               │ ← we are here
  │   hides: txn · dim guard · vector encoding ·         │
  │          cosine→similarity flip · meta round-trip    │
  └───────────────────────────┬──────────────────────────┘
                              │ SQL
  ┌─ Storage ─────────────────▼──────────────────────────┐
  │  Postgres + pgvector  (agents.chunks, HNSW cosine)   │
  └───────────────────────────────────────────────────────┘
```

Zoom in: the port is two methods. The adapter is 86 lines that make
those two methods true over a real database. The client calls the two
methods and learns none of the 86 lines. That gap — two-method surface,
five-decision body — is what makes this a *deep* module, and the deepest
in the repo.

---

## The structure pass

**Layers:** aptkit's pipeline (upper) · the `VectorStore` port (the
seam) · `PgVectorStore` the adapter (lower) · pgvector (storage).

**The axis: who knows about Postgres?** Trace that one question down:

```
  axis traced = "who knows this is Postgres + pgvector?"

  ┌─ aptkit pipeline ─┐   seam     ┌─ PgVectorStore ─┐
  │  knows NOTHING    │ ═══╪═════► │  knows EVERYTHING│
  │  (just the port)  │ (it flips) │  (SQL, pgvector) │
  └───────────────────┘           └──────────────────┘
         ▲                                  ▲
         └──── same axis, two answers ───────┘
              → the VectorStore boundary is load-bearing:
                Postgres-knowledge is contained below it
```

The axis flips hard at the port. Above it, zero database knowledge —
aptkit would run identically against its own in-memory store. Below it,
total database knowledge. **That flip is what makes the seam worth
studying:** it's the line that lets you swap pgvector for Pinecone, or
the in-memory store for tests, without aptkit noticing.

**The seam (`VectorStore`) is the contract.** Everything the two sides
agree on lives in those two method signatures — and, as the audit found
(lens 3), one thing they agree on *that isn't in the signatures*: the
`meta` key shape. That implicit part is the seam's weak spot; we'll get
to it.

---

## How it works

### Move 1 — the mental model

You already know this shape from frontend: a `<VectorStore>` is a wall
socket. aptkit's pipeline is the lamp — it has the right plug (calls
`upsert`/`search`) and works with whatever's wired behind the socket.
buffr wires Postgres behind it. The in-memory store wires a `Map`. Same
two slots; the lamp never knows the difference.

In one sentence: **the client depends on the port; an adapter implements
the port; the two sides never touch — only the contract between them.**

```
  The ports & adapters shape

         depends on              implements
   client ─────────► PORT ◄───────────── adapter
  (session)      (VectorStore)        (PgVectorStore)
                      │
        the contract: upsert(chunks) · search(vector,k)
                      │
     swap the adapter, the client doesn't change ── that's the seam
```

### Move 2 — the walkthrough, one decision the adapter hides at a time

The port promises two methods. The depth is in what the adapter hides
*behind* each. Five hidden decisions, one at a time.

**1. The dimension guard — the adapter owns validation, the client
never checks.** The port says `upsert(chunks)`; it says nothing about
dimensions. The adapter makes "768-everywhere, mismatch must throw"
(context.md's hard constraint) its own job:

```ts
// pg-vector-store.ts:32-39
private assertDim(v: number[]): void {
  if (v.length !== this.dimension) {                          // the guard
    throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
  }
}
async upsert(chunks: Chunk[]): Promise<void> {
  for (const c of chunks) this.assertDim(c.vector);           // ← every chunk, before any DB write
```

The client passes vectors; if one is the wrong size the adapter throws
*before* touching the database. This is pull-complexity-downward (audit
lens 5) made concrete — the caller doesn't validate, the module does.

**2. The transaction — atomic upsert, hidden entirely.** The port has no
notion of a transaction. The adapter wraps the whole batch in one:

```ts
// pg-vector-store.ts:40-65 (condensed)
const client = await this.pool.connect();
try {
  await client.query('begin');                    // ← all chunks commit together
  for (const c of chunks) { /* insert ... on conflict do update */ }
  await client.query('commit');
} catch (err) {
  await client.query('rollback');                 // ← masked low: caller sees a throw, not a rollback
  throw err;
} finally {
  client.release();                               // ← pool connection always returned
}
```

A partial batch never lands. The caller — `session.ts` indexing a doc —
gets "all or nothing" without writing a line of transaction code. The
`finally` releasing the connection is the load-bearing part people
forget: drop it and the pool leaks connections until it deadlocks.

**3. JS→pgvector encoding — a type-system impedance mismatch, hidden.**
Postgres's `vector` type wants a text literal `[0.1,0.2,...]`, not a
JS array. The adapter owns the translation:

```ts
// pg-vector-store.ts:14-17, used at :55 and :70
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;                       // number[] → pgvector text literal
}
// ... toVectorLiteral(c.vector) ... $6::vector    // ← cast back to vector in SQL
```

The client hands a `number[]`; pgvector gets its literal. Neither side
knows the other's representation. That's information hiding doing its job.

**4. The cosine flip — the most error-prone line, hidden behind one
comment.** pgvector's `<=>` returns cosine *distance* (0 = identical).
aptkit's tool wants a *similarity score* (1 = identical). The adapter
flips it:

```ts
// pg-vector-store.ts:69-77
// <=> is cosine DISTANCE; cosine similarity score = 1 - distance.
1 - (embedding <=> $1::vector) as score          // ← distance → similarity
...
order by embedding <=> $1::vector                // ← still ORDER BY distance (ascending = closest)
limit $3
```

Note the subtlety the comment protects: the `SELECT` flips to similarity
(so higher = better for the caller), but the `ORDER BY` stays on raw
distance ascending (so closest-first). Get that backwards and search
returns the *worst* matches with the *highest* scores. The client sees
only correct, descending-relevance hits. **This is the single line where
hiding earns the most** — strip the adapter out and every caller would
have to remember the flip.

**5. The meta round-trip — the hidden part of the contract.** This is
where the seam leaks (audit lens 3). `upsert` reads three magic keys
*out* of meta; `search` puts three keys *back*:

```ts
// pg-vector-store.ts:44-46  (upsert reads them)
const docId = typeof c.meta.docId === 'string' ? c.meta.docId : null;
const chunkIndex = typeof c.meta.chunkIndex === 'number' ? c.meta.chunkIndex : 0;
const content = typeof c.meta.text === 'string' ? c.meta.text : '';

// pg-vector-store.ts:80-84  (search rebuilds them)
return rows.map((r) => ({
  id: r.id, score: Number(r.score),
  meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
}));                                  // ← rebuild the in-memory meta shape so citations work
```

```
  Layers-and-hops — the meta contract crossing the seam

  ┌─ aptkit tool ──┐  meta.text (the citation)   ┌─ PgVectorStore ─┐
  │ search_kb      │ ◄────────────────────────── │ search()         │
  │ cites meta.text│                             │ packs text=content│
  └────────────────┘                             └────────┬─────────┘
         ▲                                                │ row.content
         │ meta.{docId,chunkIndex,text}                   ▼
         │  (REQUIRED keys, named NOWHERE in a type)  agents.chunks
         └──── if a key is missing, citation breaks silently
```

The contract is real but invisible — no `ChunkMeta` type, no comment
naming all three keys as required. The adapter *defaults* missing keys
(`text` → `''`, `chunkIndex` → `0`) rather than failing, so a missing key
becomes a silent empty citation. **The fix (audit lens 3, ranked #2):**

```ts
// add to pg-vector-store.ts:4
type ChunkMeta = { docId: string; chunkIndex: number; text: string };
// and at :79, a comment: "REQUIRED keys docId/chunkIndex/text — the
// search_knowledge_base tool reads meta.text for citations; a missing
// key here is a silent broken citation, not an error."
```

### Move 3 — the principle

A module is *deep* when its interface is far smaller than its behaviour —
when callers get a lot of capability for a little learning. `PgVectorStore`
exposes two methods and a dimension; behind them it absorbs a transaction,
a guard, an encoding, a sign flip, and a meta round-trip. The client
(`session.ts`) writes two method calls and inherits all five decisions
correctly. That's the whole game: **push behaviour down, keep the
interface narrow, and the complexity stops at the seam.** The one place
this adapter leaks — the un-typed meta contract — is exactly where the
interface *under*-specifies the agreement, which is the same disease in
reverse: a contract you can't see is a contract you can break.

---

## Primary diagram

```
  PgVectorStore — the adapter, full recap

  ┌─ aptkit (client side, no DB knowledge) ──────────────────────┐
  │  RetrievalPipeline ─── upsert / search ───► VectorStore PORT  │
  └────────────────────────────────────┬─────────────────────────┘
                            implements  │  THE SEAM (axis flips here)
  ┌─ PgVectorStore (adapter, all DB knowledge) ──▼───────────────┐
  │                                                              │
  │  upsert(chunks)                 search(vector, k)            │
  │  ├─ assertDim each  (:32)        ├─ assertDim       (:67)    │
  │  ├─ begin txn       (:42)        ├─ 1 - (<=> )  flip (:69)   │
  │  ├─ read meta keys  (:44)        ├─ order by <=>   (:74)     │
  │  ├─ toVectorLiteral (:55)        └─ rebuild meta   (:80) ◄── leak:
  │  ├─ on conflict upsert(:50)                            untyped │
  │  └─ commit / rollback(:58)                             contract │
  └──────────────────────────────────────┬───────────────────────┘
                                     SQL  ▼
  ┌─ Storage ────────────────────────────────────────────────────┐
  │  agents.chunks  ·  embedding vector(768)  ·  HNSW cosine idx   │
  └───────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Ports & adapters comes from Alistair Cockburn's hexagonal architecture
(2005) and Robert Martin's Dependency Inversion Principle: high-level
policy (aptkit's pipeline) shouldn't depend on low-level detail
(Postgres); both depend on an abstraction (the port). The *deep module*
framing is Ousterhout's — the same boundary seen through complexity
rather than dependency direction.

The two framings agree on the move but reward different things. DIP cares
that the dependency arrow points at the port. APOSD cares that the adapter
*hides enough* to be worth the seam. A port with a shallow adapter behind
it (a class that just forwards each method to one SQL call, no
transaction, no guard, no flip) satisfies DIP and fails APOSD —
classitis. `PgVectorStore` passes both: the arrow points right *and* the
body hides five decisions.

Adjacent in this repo: the same inversion appears at `03-dependency-as-a-
boundary.md` (the memory engine), and the client-side facade that holds
this adapter is `05-deep-session-facade.md`.

---

## Interview defense

**Q: Is `PgVectorStore` a deep module or just an adapter?**
Both, and the distinction matters. It's an adapter because it implements
aptkit's `VectorStore` port over Postgres — that's the dependency-
inversion role. It's *deep* because the body hides five decisions the
two-method interface never exposes: a transaction, a dimension guard,
vector-literal encoding, a cosine-distance-to-similarity flip, and a meta
round-trip. An adapter can be shallow — one that forwards each method to
one query, hiding nothing — and that'd be classitis. The depth is what
earns the seam.

```
  shallow adapter (classitis)      deep adapter (this repo)
  ┌──────────────┐                 ┌──────────────┐
  │ upsert →     │ one SQL,        │ upsert →      │ txn + guard +
  │   one query  │ hides nothing   │  5 decisions  │ encode + meta
  └──────────────┘                 └──────────────┘
   interface ≈ body                 interface ≪ body
```
*Anchor:* "two methods on the surface, five decisions in the body —
that ratio is the depth."

**Q: What's wrong with it?** The meta contract is implicit. `upsert` and
`search` both depend on three magic keys — `docId`, `chunkIndex`, `text`
— that appear on no type and in no comment as required. A caller who
omits `text` gets a silent empty citation, because the adapter defaults
the missing key to `''` instead of throwing. The fix is a `ChunkMeta`
type and a comment naming the contract — make the seam's full agreement
visible, not just the two method signatures.
*Anchor:* "the interface under-specifies the contract — same disease as a
shallow module, in reverse."

**Q: How would you swap pgvector for Pinecone?** Write a second adapter
implementing the same `VectorStore` port and change one line —
`session.ts:41`, the only place that names the concrete adapter. aptkit
never changes; the client never changes. That single-construction-site
property is why the factory role matters: keep concrete-adapter naming in
one place so the swap is one edit.
*Anchor:* "one line changes — the construction site — because that's the
only code that knows the adapter's real name."

---

## See also

- `02-pure-core-impure-shell.md` — `loadConfig`, the other testable seam.
- `03-dependency-as-a-boundary.md` — the same inversion, memory engine.
- `05-deep-session-facade.md` — the client that holds this adapter.
- `audit.md` lenses 2, 3, 5 — depth, the meta leak, dimension pull-down.
- `study-system-design/03-provider-abstraction.md` — the architecture
  altitude of this same boundary (don't re-teach it; this is the module
  altitude).
- `study-testing/` — why the port makes the in-memory store swappable
  for tests.
