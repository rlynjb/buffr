# 01 — Adapter behind a contract

**Industry name(s):** Adapter pattern / Ports-and-Adapters (Hexagonal) /
"deep module implementing an interface." **Type:** Industry standard.

---

## Zoom out, then zoom in

aptkit ships a `VectorStore` *contract* — an interface with `dimension`,
`upsert`, and `search`. Its default implementation keeps vectors in memory.
buffr's entire reason to exist is to keep them in **Postgres + pgvector**
instead — persistent, single-device — without the rest of aptkit noticing.
`PgVectorStore` is that swap.

```
  Zoom out — where the adapter lives

  ┌─ aptkit (the contract owner, never edited here) ───────────┐
  │  RagQueryAgent → RetrievalPipeline → interface VectorStore │
  │                                         { dimension,        │
  │                                           upsert, search }  │
  └──────────────────────────────┬─────────────────────────────┘
                                 │  implements
  ┌─ buffr (the adapter) ───────▼──────────────────────────────┐
  │  ★ PgVectorStore ★   pg-vector-store.ts                     │ ← here
  │  hides: txn · dim guard · encoding · distance flip · meta   │
  └──────────────────────────────┬─────────────────────────────┘
                                 │  pool.query(...)
  ┌─ Storage ───────────────────▼──────────────────────────────┐
  │  Postgres + pgvector   agents.chunks  (HNSW cosine index)   │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: an adapter is a deep module whose *interface* is dictated by
someone else (the contract) and whose *body* is free to be as deep as the
real storage demands. The skill is making the body hide everything pgvector
forces on you, so aptkit's code stays exactly the same as it was for the
in-memory store. The question this file answers: **what does
`PgVectorStore` hide, and where's the one place it leaks?**

---

## Structure pass

**Layers.** The contract sits above the adapter; the driver sits below.

```
  three layers, one axis traced: "who knows it's pgvector?"

  ┌─ contract (aptkit) ─────────┐  knows: nothing. just VectorStore.
  │  upsert(chunks) / search()  │
  └──────────────┬──────────────┘
        seam ◄── the abstraction flips here ──►
  ┌─ adapter (PgVectorStore) ───▼┐  knows: EVERYTHING pgvector-specific
  │  SQL · ::vector · <=> · txn  │
  └──────────────┬──────────────┘
  ┌─ driver (pg.Pool) ──────────▼┐  knows: connections, wire protocol
  └──────────────────────────────┘
```

**Axis traced — "who knows it's pgvector?"** Above the adapter: nobody.
aptkit calls `store.search(vec, k)` identically whether the store is in
memory or in Postgres. Below: the driver knows TCP and SQL text but nothing
about vectors. **Only the adapter layer knows it's pgvector.** That's the
whole value — the knowledge is contained in one file.

**Seam.** The `implements VectorStore` line (`pg-vector-store.ts:19`) is the
load-bearing seam. The axis "who knows it's pgvector?" flips across it: above
is storage-agnostic, below is storage-specific. A seam where an axis flips is
exactly what makes a boundary worth a contract — substitute the in-memory
store back in and aptkit doesn't change a line.

---

## How it works

### Move 1 — the mental model

You know how a React component takes `props` and you can swap *which*
component renders behind the same prop shape, and the parent doesn't care?
An adapter is that, for storage. aptkit defines the prop shape
(`VectorStore`); buffr supplies a different component behind it. The
underlying strategy: **hold the interface fixed, make the body deep.**

```
  the adapter kernel — narrow interface, deep body

   in:  upsert(chunks)              in:  search(vec, k)
        │                                │
        ▼                                ▼
   ┌─────────────────────────────────────────────┐
   │  [guard dim] [encode vec] [open txn]         │  ← the hidden body:
   │  [build meta] [SQL upsert] [commit/rollback] │    none of this is
   │  [flip distance→score] [rebuild meta]        │    in the interface
   └─────────────────────────────────────────────┘
        │                                │
        ▼                                ▼
   out: void                       out: Hit[] (id, score, meta)
```

### Move 2 — the step-by-step walkthrough

Five decisions are hidden in the body. Each one is a thing aptkit's code
*doesn't* have to know. Walk them one at a time.

**Part 1 — the dimension guard (what breaks: silent corruption).**

**File:** `src/pg-vector-store.ts` · **Function:** `assertDim` ·
**Lines:** 32-36, called at 39 and 68.

```ts
private assertDim(v: number[]): void {
  if (v.length !== this.dimension) {
    throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
  }
}
```

Called before every `upsert` (`:39`) and every `search` (`:68`). The
context.md constraint is "768 everywhere; a mismatch must throw, never
silently truncate." Strip this guard and a 512-dim vector reaches
`embedding vector(768)` and Postgres either errors cryptically or, worse, a
mismatched index degrades retrieval quietly. The guard turns a silent data
bug into a loud exception at the boundary. **Load-bearing.**

**Part 2 — JS `number[]` → pgvector literal (what breaks: the write fails).**

**File:** `src/pg-vector-store.ts` · **Function:** `toVectorLiteral` ·
**Lines:** 14-17, used at 55 and 77.

```ts
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;          // [0.1,0.2,0.3,...]
}
```

pgvector's text input format is `[0.1,0.2,...]`. node-postgres has no native
vector type, so the adapter serializes to that string in JS, then casts
`$1::vector` *inside the SQL* (`:55,77`). This split — serialize in JS, cast
in SQL — is the one non-obvious spot (audit §7). Drop the serialization and
you pass a raw JS array, which node-postgres turns into a Postgres *array*
literal `{0.1,0.2}`, not a `vector`, and the cast fails. **Load-bearing, and
the place to add a comment.**

**Part 3 — the transaction (what breaks: half-written batches).**

**File:** `src/pg-vector-store.ts` · **Function:** `upsert` · **Lines:**
40-64.

```ts
const client = await this.pool.connect();
try {
  await client.query('begin');
  for (const c of chunks) {
    // ... insert ... on conflict (id) do update set ...
  }
  await client.query('commit');
} catch (err) {
  await client.query('rollback');     // ← all-or-nothing
  throw err;
} finally {
  client.release();                   // ← pool leak guard
}
```

A batch of N chunks commits together or not at all. Remove the txn and a
crash mid-batch leaves the store half-indexed — a state aptkit's in-memory
store can never be in, so aptkit's code assumes it can't happen. The adapter
*upholds the in-memory store's implicit guarantee* (writes are atomic per
call) on a backend that doesn't give it for free. That's the deepest thing an
adapter does: preserve invariants the contract never stated but callers rely
on. **Load-bearing — this is what "deep" means here.**

**Part 4 — cosine distance → similarity score (what breaks: ranking
inverts).**

**File:** `src/pg-vector-store.ts` · **Function:** `search` · **Line:** 69.

```sql
1 - (embedding <=> $1::vector) as score
order by embedding <=> $1::vector
limit $3
```

pgvector's `<=>` is cosine **distance** (0 = identical, 2 = opposite).
aptkit's pipeline expects a **similarity score** (1 = identical). The adapter
flips it: `score = 1 - distance`. But note the ordering clause still uses raw
`<=>` ascending — nearest first — because ordering by distance and ordering by
`1-distance` descending are the same set, and ordering by the raw operator
lets the HNSW index do its job. Get the flip wrong (return raw distance as
"score") and every consumer ranks results backwards. **Load-bearing, and the
comment at `:69` is the right call.**

**Part 5 — the `meta` round-trip (what breaks: citations go blank). THE
LEAK.**

**File:** `src/pg-vector-store.ts` · **Lines:** 44-46 (write), 83 (read).

```ts
// write side (upsert):
const docId      = typeof c.meta.docId === 'string'    ? c.meta.docId    : null;
const chunkIndex = typeof c.meta.chunkIndex === 'number'? c.meta.chunkIndex: 0;
const content    = typeof c.meta.text === 'string'      ? c.meta.text     : '';

// read side (search), rebuilding the shape aptkit handed in:
meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content }
```

Here's the leak the audit (§3, Leak 2) flagged. Three string keys —
`docId`, `chunkIndex`, `text` — are a contract between buffr, aptkit's
pipeline (which *sets* them on index), and the `search_knowledge_base` tool
(which reads `meta.text` to build citations, per the comment at `:79`). The
adapter destructures them out of `meta` into real columns on write, and
reconstructs *exactly those keys* on read so the round-trip is invisible.

What breaks if it's wrong: rename `text` → `content` on one side only and
`search` returns hits with empty `text`, so the agent cites sources with no
quotable content — and **nothing throws**. The `typeof` guards mean a missing
key silently becomes `''` or `0`, not an error. This is the deepest module's
most fragile coupling, and it has no type and no interface comment.

**The fix (audit §3):** name the contract.

```ts
type ChunkMeta = { docId: string; chunkIndex: number; text: string };
//  + a one-line comment: "aptkit's pipeline fills these; search_knowledge_base
//    reads meta.text for citations. Keys are a cross-module contract."
```

That doesn't remove the crossing — the adapter's *job* is to bridge buffr's
columns and aptkit's `meta` shape, so the knowledge must cross the seam. It
makes the crossing *visible and checked*. A leak you can't avoid, you name.

### Move 3 — the principle

An adapter is the purest form of "deep module": the interface isn't yours to
widen, so all your design budget goes into the body. The measure of a good
one is invariants it upholds that the contract never mentions — atomic
writes, dimension safety, score orientation — so the layer above can stay
exactly as simple as it was. The failure mode is the *implied* interface: the
`meta` keys that are a contract in fact but not in type. Make implied
interfaces explicit, or they leak silently.

---

## Primary diagram

The whole adapter in one frame — interface narrow, body deep, one leak named.

```
  PgVectorStore — adapter behind aptkit's VectorStore contract

  aptkit ── upsert(chunks) ──────────────►┐
            search(vec,k) ◄──── Hit[] ─────┤   NARROW interface (3 members)
                                           │
  ┌── PgVectorStore body (DEEP) ───────────▼──────────────────────────┐
  │  ① assertDim        guard 768, else throw          (:32-36)        │
  │  ② toVectorLiteral  number[] → "[..]"               (:14-17)        │
  │  ③ begin/commit/    atomic batch, rollback on err   (:40-64)        │
  │     rollback                                                        │
  │  ④ 1 - (<=> )       distance → similarity score     (:69)          │
  │  ⑤ meta round-trip  docId/chunkIndex/text  ◄── THE LEAK (:44-46,83)│
  └──────────────────────────────┬─────────────────────────────────────┘
                                 │  pool.query  ($N::vector cast in SQL)
  ┌─ Postgres + pgvector ───────▼──────────────────────────────────────┐
  │  agents.chunks   embedding vector(768)   HNSW vector_cosine_ops     │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The pattern comes from Hexagonal Architecture (Alistair Cockburn) and the GoF
Adapter: define a *port* (interface) the application owns, supply *adapters*
that implement it for specific tech. APOSD reframes it as depth — the port is
the narrow interface, the adapter is where you bury complexity so it stops
amplifying upward.

This is the same shape you shipped in **AdvntrCue** (pgvector behind a RAG
pipeline), but buffr makes the contract *explicit* (`implements VectorStore`)
because aptkit owns it. The context.md note about the **dropped FK** on
`chunks.document_id` is part of this discipline: aptkit's in-memory store has
no notion of a documents table, so memory chunks (`kind=memory`) and
profile-less chunks must be insertable without a parent row. Keeping the FK
would break drop-in parity with the contract. That's an adapter preserving the
contract's *permissiveness*, not just its method signatures.

Read next: `03-dependency-as-a-boundary.md` (why the contract is imported,
never forked) and `05-deep-session-facade.md` (the adapter's biggest
consumer).

---

## Interview defense

**Q: Why implement someone else's interface instead of just writing your own
Postgres store?**
Because the value is the *swap being invisible*. aptkit's `RagQueryAgent` and
`RetrievalPipeline` are written against `VectorStore`; implementing it means
the entire pgvector graduation touched zero lines of aptkit. If I'd written my
own API, every aptkit call site would need rewiring, and I'd lose the
in-memory store as a test double.

```
  swap is invisible because the seam holds the contract

  agent ─► VectorStore ─► { in-memory }   ← tests, fast
                       └─► { PgVectorStore } ← prod, persistent
           same interface, agent never knows which
```

**Q: What's the weakest part of this design?**
The `meta` magic-keys contract (`pg-vector-store.ts:44-46,83`). Three string
keys are a cross-module contract with no type — `docId`, `chunkIndex`, `text`.
Rename one and retrieval silently returns empty citations; the `typeof` guards
swallow the mismatch into `''`. The fix is a `ChunkMeta` type plus an interface
comment. It's the deepest module's most fragile coupling, and it's the one
implied interface I'd make explicit first.

**Anchor:** "A good adapter upholds invariants the contract never stated —
atomic writes, dimension safety — so the layer above stays simple."

---

## See also

- `audit.md` §2 (deep vs shallow), §3 (the meta leak), §6 (the transaction).
- `03-dependency-as-a-boundary.md` — the contract as an imported boundary.
- `05-deep-session-facade.md` — the facade that constructs this adapter.
- `.aipe/study-system-design/` *(when generated)* — the storage architecture
  at the system altitude.
