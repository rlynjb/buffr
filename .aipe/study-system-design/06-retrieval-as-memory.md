# 06 — Retrieval as Memory

**Industry name(s):** Retrieval-based episodic memory / RAG-as-memory / vector recall over
conversation history. ("MemoRAG"-style.)
**Type:** Industry standard (episodic memory pattern), project-specific wiring (shared store).

## Zoom out, then zoom in

Here's the whole system, with the memory loop lit. After each turn, the exchange
(question + answer) is embedded and stored — *in the same `chunks` table the documents
use* — tagged `kind=memory`. Future turns surface relevant past exchanges through the
*same* `search_knowledge_base` tool the agent already uses for documents. Memory isn't a
separate subsystem; it's retrieval pointed at the conversation's own history.

```
  Zoom out — where memory rides the store

  ┌─ Session layer ─────────────────────────────────────────────────────┐
  │  per turn: memory.remember({ conversationId, question, answer })      │ ← we are here
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ embed → store.upsert (kind=memory)
  ┌─ Adapter layer ───────────────▼──────────────────────────────────────┐
  │  PgVectorStore — the SAME store documents use                        │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │
  ┌─ Storage layer ───────────────▼──────────────────────────────────────┐
  │  agents.chunks   ── documents (kind absent)  +  memory (kind=memory)  │
  │  one HNSW index serves both                                          │
  └───────────────────────────────────────────────────────────────────────┘
            ▲ next turn: search_knowledge_base recalls BOTH, ranked by similarity
```

Zoom in. The pattern is **retrieval-based episodic memory**: instead of stuffing the
whole conversation history into the prompt (which blows the context window), you embed
each exchange and *retrieve* the relevant ones on demand. The question it answers: *how
does the agent remember past exchanges across turns and sessions without an ever-growing
prompt — using infrastructure it already has?*

## Structure pass

**Layers:** session (calls `remember`) → memory engine (aptkit, embed+tag+recall) →
store (`PgVectorStore`, shared) → storage (`chunks`, two kinds in one table).

**Axis — what distinguishes a memory row from a document row?** Trace it through the
store. At the *storage* layer: nothing structural — both are rows in `chunks` with an
embedding. At the *metadata* layer: a `meta.kind='memory'` tag and an id namespace
`memory:<conv>:<n>` (`.aipe/project/context.md:43`). At the *recall* layer: the engine
over-fetches then filters by `kind` (aptkit `conversation-memory.ts:94-98`). The
distinction is a tag, not a table — that's the whole "shared store" choice.

**Seam:** the `VectorStore` contract again (file 01). The memory engine speaks *only*
that contract and "never names a database" (aptkit `conversation-memory.ts:55-58`). So
the same `PgVectorStore` instance serves documents *and* memory — one seam, two roles.

## How it works

### Move 1 — the mental model

You've built infinite scroll: you don't render all 10,000 items, you fetch the slice
near the viewport. Episodic memory is that for conversation history — you don't prompt
*all* past turns, you retrieve the few *relevant* ones for the current question. The
strategy: **embed every exchange, recall by similarity, so memory cost is bounded by
relevance, not by history length.**

```
  the memory loop — write each turn, recall by relevance

   turn N:  (q, a) ──embed──► upsert chunk  [kind=memory, id=memory:conv:N]
                                   │
   turn N+1: question ──embed──► search ──► over-fetch ──► filter kind=memory
                                   │                          │
                                   └── documents + memory ────┘ ──► relevant past
```

### Move 2 — the load-bearing skeleton

The kernel is *embed-tag-recall over a shared store.* Walk it as a skeleton.

**1. Isolate the kernel.** From aptkit's engine (`conversation-memory.ts:74-106`),
re-consumed by buffr:

```
  remember(turn):  text = format(q, a)  →  vector = embed(text)
                   →  upsert({ id: "memory:<conv>:<n>", vector, meta:{ kind:'memory', text } })

  recall(query):   vector = embed(query)  →  hits = search(vector, max(k*4, 20))
                   →  filter hits where meta.kind === 'memory'  →  top k
```

**2. Name each part by what breaks without it.**
- Drop the `kind` tag → recall can't tell a memory from a document; the conversation
  history pollutes document retrieval and vice versa.
- Drop the **over-fetch** (`max(k*4, 20)`) → because the `VectorStore` contract has *no
  metadata filter*, a plain `search(vec, k)` might return `k` documents and zero memory
  rows, then the `kind` filter yields nothing. Over-fetching then filtering is the only
  way to recall memory from a shared store (aptkit `conversation-memory.ts:91-95`). This
  is the part people forget — and it's the cost named in audit lens 8.5.
- Drop the per-conversation `counters` → repeated turns collide on the same id and
  overwrite each other (aptkit `conversation-memory.ts:69-71`).

**3. Skeleton vs hardening.** The skeleton is embed-tag-recall. The *shared store* is a
deployment choice (buffr injects the document store), not part of the kernel — the engine
"does not care which" store it gets (aptkit `conversation-memory.ts:20-26`). Sharing is
what makes recall surface through the existing tool; isolating into a dedicated store
would also work, with a separate search path.

**buffr's wiring — best-effort, after the answer.** buffr calls `remember` as step 4 of
the turn, *wrapped in try/catch* (`src/session.ts:64-69`):

```ts
// src/session.ts:64-69 — memory is a bonus, never the product
try {
  await memory.remember({ conversationId, question, answer });
} catch {
  // swallow: memory is best-effort, the turn already succeeded
}
```

What breaks without the swallow: a transient embed/upsert failure would throw *after* the
user already has their answer, turning a successful turn into an error. The try/catch
draws the durability boundary explicitly — the answer is durable, the memory is
best-effort (audit lens 5).

**Why the dropped FK was required.** Memory chunks have **no documents row** — they're
exchanges, not source files. A hard `chunks.document_id → documents.id` FK would reject
them. This is one of the two reasons the FK was dropped
(`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md:204`); the
other is general `VectorStore` parity (file 01). Memory-riding-chunks is *why* the schema
had to bend.

```
  Layers-and-hops — recall surfacing through the document tool

  ┌─ next turn: agent ─┐ hop 1: search_knowledge_base(query)
  │  (Gemma decides)   │ ─────────────────────────────────────────┐
  └────────────────────┘                                           │
                                                    ┌─ retrieval pipeline ─┐
                            hop 2: store.search(vec, k)             │
                                                    └──────────┬───────────┘
  ┌─ agents.chunks ◄──────────────────────────────────────────┘
  │  documents (kind absent)  +  memory (kind=memory)
  │  hop 3: ranked rows, BOTH kinds, by cosine similarity ──► back to agent
  └────────────────────────────────────────────────────────────────────────
```

Note: buffr surfaces recall *through the document tool* by sharing the store
(`src/session.ts:50-53` comment) — the agent's existing `search_knowledge_base` returns
documents *and* relevant past exchanges, ranked together. The engine's own `recall`
(memory-only, filtered) is available, but the shared-store design means the document tool
already does double duty.

### Move 3 — the principle

Memory at conversation scale is a retrieval problem, not a storage problem. Don't grow
the prompt with history — embed each exchange and pull back the relevant few on demand,
so cost scales with *relevance*, not with how long you've been talking. And when the
memory store *is* the document store, you get cross-session recall for free through the
tool you already built — at the price of over-fetch-then-filter, because the contract
can't filter by metadata. Name that price; it's the cost of the elegance.

## Primary diagram

The full memory loop, write and recall, shared store, every layer.

```
  retrieval-as-memory — the full loop

  ┌─ Session (per turn) ────────────────────────────────────────────────┐
  │  WRITE:  remember(q,a) [best-effort, try/catch]                       │
  │  RECALL: next turn's search_knowledge_base(query)                     │
  └──────────┬───────────────────────────────────────┬───────────────────┘
   embed→upsert (kind=memory)                  embed→search (over-fetch)
  ┌──────────▼───────────────────────────────────────▼───────────────────┐
  │  aptkit @aptkit/memory engine  ·  PgVectorStore (SAME as documents)   │
  │  tag kind=memory · id memory:<conv>:<n>     filter kind on recall      │
  └──────────┬───────────────────────────────────────────────────────────┘
  ┌──────────▼───────────────────────────────────────────────────────────┐
  │  agents.chunks  —  documents  +  memory rows  —  one HNSW cosine index │
  │  (no FK on document_id: memory chunks have no documents row)           │
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is episodic memory in the agent-memory taxonomy — recall of specific past events,
as opposed to the semantic/profile memory of file 05. The "MemoRAG" framing
(`.aipe/project/context.md` data-model note) and the Hermes "gets smarter over time"
thesis (`...aptkit-packages-design.md:33`) both land here: every conversation becomes
recallable substrate. The shared-store choice is the elegant-but-costed move — it reuses
the document retrieval path entirely, at the price of in-process over-fetch filtering
that grows with corpus size (audit lens 8.5). It pairs with file 05: profile is static
persona, memory is dynamic episodic recall; together they're "knows you." The embedding /
ANN / cosine mechanics belong to `study-ai-engineering` and `study-dsa-foundations`; this
file owns the architectural decision to make memory ride the document store.

What to read next: `01-vector-store-adapter.md` (the shared store + the dropped FK),
`05-profile-injection-as-context.md` (the static half of memory), `audit.md` lens 8.5
(the over-fetch cost).

## Interview defense

**Q: Why store conversation memory in the same table as documents instead of a dedicated
memory table?**
To surface recall through the existing `search_knowledge_base` tool with zero new search
path. A memory row is just a chunk tagged `kind=memory`; the agent's document search
returns relevant past exchanges alongside documents, ranked together. The cost: recall
must over-fetch and filter by `kind` in-process, because the `VectorStore` contract has
no metadata filter.

```
  shared store ─► one tool recalls docs + memory   (reuse)
       cost   ─► over-fetch max(k*4,20) then filter kind  (no metadata filter in contract)
```
Anchor: shared-store wiring at `src/session.ts:50-53`; over-fetch at aptkit
`conversation-memory.ts:91-95`.

**Q: What's the load-bearing part people forget in retrieval-as-memory over a shared
store?**
The over-fetch. A plain `search(vec, k)` on a shared store can return `k` documents and
zero memory rows; the `kind` filter then yields nothing. You must over-fetch *then*
filter. Forgetting it gives you a memory system that silently recalls nothing.
Anchor: `fetchK = Math.max(k * 4, 20)` at aptkit `conversation-memory.ts:94`.

**Q: Why is `remember` best-effort?**
Because the answer is the product and memory is a bonus. `remember` runs *after* the
answer is already returned; a transient embed/upsert failure must not turn a successful
turn into an error, so it's swallowed. Asymmetric durability, on purpose.
Anchor: try/catch at `src/session.ts:64-69`.

## See also

- `01-vector-store-adapter.md` — the shared store and the FK that had to go
- `05-profile-injection-as-context.md` — static persona vs dynamic episodic memory
- `04-long-lived-chat-session.md` — `remember` as step 4 of the per-turn path
- `study-ai-engineering` — embeddings, ANN, the retrieval pipeline mechanics
