# Design Doc — Extracting Conversation Memory Up Into aptkit

> **Summary:** Conversation memory was built inline in buffr, then extracted
> **up** into the published `@rlynjb/aptkit-core` bundle as
> `createConversationMemory` — a store-agnostic engine over the
> `EmbeddingProvider` / `VectorStore` contracts. The *engine* (embed, tag,
> recall) lives in aptkit; the *store* is injected by buffr. buffr keeps zero
> memory logic; it keeps only the Postgres-backed store it already owns.

**Status:** Shipped — `createConversationMemory` consumed from the published
bundle (`.aipe/project/context.md`, Stack).
**Grounds:** `src/session.ts:53,64-68`, `.aipe/project/context.md`.

---

## 2. Context / problem

buffr needed episodic memory: after each turn, the question+answer exchange
should be recallable in future turns — across sessions — so the agent surfaces
relevant past exchanges, not just indexed documents.

The first cut built this **inline in buffr**: embed the exchange, write it to
the store tagged as memory, and let the existing `search_knowledge_base` tool
surface it. It worked. The problem wasn't correctness — it was *location*. The
memory engine had no buffr-specific logic in it. Embed an exchange, tag it,
recall by similarity: that's a pattern any aptkit consumer needs, expressed
entirely over contracts aptkit already defines (`EmbeddingProvider`,
`VectorStore`). It was sitting in the wrong repo.

The forcing question: **does this code belong to the body or the toolkit?**

> **Coach:** This is the doc most engineers never write because they never see
> the decision. Inline code that works is invisible — nobody asks you to
> justify where a working function lives. Naming the boundary *before* anyone
> forces you to is the staff signal. Lead with: "the code worked; the question
> was whether it was buffr's code or aptkit's."

---

## 3. Goals & non-goals

**Goals**
- A reusable conversation-memory engine any aptkit consumer can use.
- Engine depends only on aptkit's existing contracts — no Postgres, no
  buffr-specific anything in the library.
- buffr keeps owning its store and injects it; buffr holds **no** memory logic.
- Memory rides the *same* store as documents, so it surfaces through the
  existing `search_knowledge_base` tool with no new retrieval path.

**Non-goals**
- The store does not move up. aptkit ships the engine; it does **not** ship a
  Postgres store (that would make the toolkit "the Supabase app" —
  `agent-layer-plan.md`, "Why not all-in-AptKit").
- No sequential in-prompt turn history. `RagQueryAgent.answer()` still treats
  each question independently; this is relevance-based recall, not a chat
  transcript (`src/session.ts:25-27`). That gap is named, not hidden.

---

## 4. The decision

Split along the contract. The engine — embed, tag `kind=memory`, recall by
similarity — moves into aptkit as `createConversationMemory`, parameterized
over `EmbeddingProvider` and `VectorStore`. buffr injects its `PgVectorStore`
and the Ollama embedder it already constructed.

```
  Engine in aptkit, store injected by buffr — split on the contract

  ┌─ Provider / library layer (@rlynjb/aptkit-core, published) ───┐
  │  createConversationMemory({ embedder, store })                │
  │     remember()  →  embed exchange → tag kind=memory → upsert   │
  │     recall      →  same store, similarity search              │
  │        △ depends ONLY on the contracts below                  │
  │        │  EmbeddingProvider        VectorStore                │
  └────────┼──────────────────────────────△─────────────────────┘
           │ injected at construction      │ injected at construction
  ┌─ Body layer (buffr, src/session.ts) ───┼──────────────────────┐
  │  OllamaEmbeddingProvider ──────────────┘                      │
  │  PgVectorStore (buffr-owned) ──────────────────────────────────┤
  │     same store as documents → memory surfaces via the         │
  │     existing search_knowledge_base tool                       │
  └───────────────────────────────────────────────────────────────┘
```

The dependency arrow points **down**: the library engine depends on contracts,
not on buffr. buffr depends on the library. That direction is the entire
decision — it's what makes the engine reusable and buffr's store swappable.

In code, the whole seam is one line of construction: `createConversationMemory({
embedder, store })` (`src/session.ts:53`), reusing the *same* `store` and
`embedder` already built for retrieval (`src/session.ts:40-41`). Because
memory shares the document store, recall needs no new tool — it comes back
through `search_knowledge_base` like any other chunk.

> **Coach:** The phrase that lands the boundary in one breath:
> **"engine in aptkit, store injected by buffr."** Say it exactly that way.
> It compresses the whole RFC: what moved up (engine), what stayed down
> (store), and the mechanism (injection over a contract). A reviewer who hears
> that knows you understood the difference between a *toolkit* and an *app*.

---

## 5. Alternatives considered

**A — Keep memory inline in buffr.**
Zero extraction work. Lost because the code has no buffr-specific content — it
embeds over `EmbeddingProvider` and writes over `VectorStore`, both aptkit
contracts. Leaving it inline means every future aptkit consumer reinvents it,
and buffr carries library code masquerading as app code. The cost of *not*
extracting is duplication you'll pay later, silently.

**B — Push the whole thing up, store included.**
Move memory *and* a Postgres store into aptkit. Lost because it inverts the
repo split. aptkit is provider- and deployment-agnostic on purpose
(`providers/` has anthropic/openai/local side by side —
`agent-layer-plan.md`). Bolting a Supabase store into it turns the toolkit
into "the Gemma+Supabase app" and kills reuse across the other apps
(`blooming_insights`, `contrl`). The store is exactly the part that *should*
stay in the body.

**C — A separate `@buffr/memory` package.**
A third home, between the two repos. Lost because it's a package with one
consumer and no aptkit dependency it doesn't already have — overhead with no
boundary benefit. If the engine is store-agnostic (it is), it belongs next to
the contracts it's written against, which is aptkit.

> **Coach:** Alternative B is the trap a reviewer sets: "if you're extracting
> memory, extract the store too — keep it together." Don't take the bait. The
> answer: "the store is the one part with a deployment opinion — Postgres,
> pgvector, `reindb`. Everything *deployment-agnostic* goes up; everything
> *deployment-specific* stays down. Memory is agnostic; the store isn't.
> That's the cut line." Naming the cut line as "agnostic up, specific down" is
> the reusable principle, not just this one call.

---

## 6. Tradeoffs accepted

- **We chose to extract, accepting a published-API surface in aptkit.** Cost:
  `createConversationMemory`'s signature is now a contract aptkit owns;
  changing it is a versioned, breaking change, not a local edit. Owned: that's
  the price of reuse, and the signature is small (`{ embedder, store }` in,
  `remember`/`recall` out).
- **We chose relevance-based recall, accepting no sequential turn history.**
  Cost: the agent doesn't see "what we just said" in order — it sees what's
  *similar* (`src/session.ts:25-27`). Owned: in-prompt turn history is an
  aptkit-side change to `RagQueryAgent.answer()`; relevance recall gives
  cross-session memory *without* waiting for it. Named gap, deliberate phase
  boundary.

---

## 7. Risks & mitigations

- **Risk: a memory-write failure loses the answer the user already has.**
  *Mitigation:* `remember()` is wrapped best-effort — the turn returns the
  answer first, then memory is attempted in a `try/catch` that swallows
  failures (`src/session.ts:64-68`). Memory is enrichment, never on the
  critical path of answering.
- **Risk: memory chunks and document chunks collide in the same store.**
  *Mitigation:* memory rows are tagged `meta.kind='memory'` with namespaced ids
  (`"memory:<conv>:<n>"`) (`.aipe/project/context.md`, Data model), so they're
  distinguishable from corpus chunks even though they share the table.
- **Risk: the shared store assumes memory rows need no documents row.** Covered
  by the dropped FK — see `03-dropped-chunks-documents-fk.md`. This decision
  *depends* on that one: without the dropped FK, a memory chunk with no
  documents row would violate the constraint.

---

## 8. Rollout / migration

- aptkit ships `createConversationMemory` in the published bundle
  (`@rlynjb/aptkit-core` ^0.4.1); buffr consumes it. Because aptkit is
  consumed-never-edited, the extraction is a version bump on buffr's side, not
  a code move buffr performs at runtime.
- For callers inside buffr: the inline memory code is deleted and replaced by
  the one-line injection at `src/session.ts:53`. No data migration — memory
  rows already lived in `agents.chunks`; the engine writing them just moved
  repos.

---

## 9. Open questions

- **Memory retention.** Unbounded growth of `kind=memory` chunks is a real
  cost (`agent-layer-plan.md`, Open questions: "Conversation retention" —
  TTL / keep-N-recent / archive). Undecided.
- **Memory vs. document ranking.** Memory and corpus chunks compete in the
  same similarity search. Whether a recalled exchange should ever outrank a
  source document — and how to weight that — is open.
- **In-prompt turn history.** The named gap: when `RagQueryAgent.answer()`
  gains sequential history, does retrieval-based memory stay, layer on top, or
  fold in? An aptkit-side decision.

---

## See also

- `01-pgvector-graduation.md` — the store this engine is injected with.
- `03-dropped-chunks-documents-fk.md` — the schema decision this one depends
  on (memory rows with no documents row).
- `.aipe/study-software-design/` — the deep-module / dependency-direction lens
  on this boundary.
- `.aipe/rehearse-interview-defense/` — defending "engine up, store down" out
  loud.
