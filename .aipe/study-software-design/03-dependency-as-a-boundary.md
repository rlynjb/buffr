# 03 — Dependency as a boundary

**Industry name(s):** Dependency inversion · "the library is the seam" ·
extract-up / consume-down. **Type:** Industry standard.

---

## Zoom out, then zoom in

buffr imports `@rlynjb/aptkit-core@^0.4.1` and **never edits it**
(context.md, must-not-change). That's not a constraint that gets in the way —
it's a design decision that *creates* the cleanest boundary in the system.
Everything buffr does — the pgvector store, the trace sink, the session — is
written against aptkit's published contracts, on buffr's side of the line. And
one piece went the other direction: conversation memory was extracted *up* out
of buffr into aptkit, then re-consumed.

```
  Zoom out — the dependency boundary, both directions

  ┌─ aptkit (@rlynjb/aptkit-core, never edited) ───────────────┐
  │  contracts: VectorStore · CapabilityTraceSink ·            │
  │             RagQueryAgent · RetrievalPipeline ·            │
  │             createConversationMemory  ◄── extracted UP      │
  └───────────┬───────────────────────────────▲────────────────┘
   import (consume down)                        │ (was buffr's,
              ▼                                  │  moved up, re-consumed)
  ┌─ buffr (this repo) ────────────────────────┴───────────────┐
  │  PgVectorStore · SupabaseTraceSink · createChatSession      │ ← here
  │  inject buffr's PgVectorStore into aptkit's memory engine   │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: a dependency boundary is a seam where you *can't* reach across — you
can only call the published surface. That impossibility is a feature: it forces
every interaction through named contracts, which is exactly what makes both
sides independently reasoned-about. The question: **how does buffr use the
"can't edit aptkit" rule as a design tool, and what does the extract-up of
memory buy?**

---

## Structure pass

**Layers.** aptkit above, buffr below, with the import arrow pointing up and
the *injection* arrow pointing back down.

```
  one axis traced: "who owns this code?"

  ┌─ aptkit ────────────────────┐  owns: the contracts + the agent loop
  │  VectorStore, memory engine │  + the memory mechanism
  └──────────────┬──────────────┘
        seam ◄── ownership flips here ──►
  ┌─ buffr ──────▼──────────────┐  owns: the Postgres implementations
  │  PgVectorStore, trace sink  │  + the wiring that injects them up
  └──────────────────────────────┘
```

**Axis — "who owns this code?"** Above: aptkit owns the contracts and the
reasoning loop. Below: buffr owns the Postgres-specific implementations.
**Ownership flips at the package boundary** — and because it's an npm
dependency, the flip is *enforced*, not just convention. You literally cannot
edit aptkit from here.

**Seam.** The import statements (`session.ts:2-6`) are the seam. Every name
buffr pulls from `@rlynjb/aptkit-core` is a contract aptkit promises to keep
across `0.4.x`. The injection — buffr's `PgVectorStore` passed *into*
`createConversationMemory({ embedder, store })` (`session.ts:53`) — is the
seam used in reverse: aptkit's mechanism, buffr's storage.

---

## How it works

### Move 1 — the mental model

You've imported a UI library and themed it by passing your own props — you
don't fork the library to change a color, you inject your config through its
API. Dependency-as-a-boundary is that, structurally enforced: aptkit owns the
*mechanism* (the agent loop, the memory engine), buffr injects the *parts*
(the model provider, the vector store). The strategy: **depend on contracts,
inject implementations; never reach across the package line.**

```
  the boundary — inject down, never edit up

   aptkit contract        buffr implementation
   ────────────────       ─────────────────────
   VectorStore        ◄── PgVectorStore        (injected at session.ts:41)
   model provider     ◄── Gemma + guard        (injected at :46)
   trace sink         ◄── SupabaseTraceSink    (injected at :57)
   memory engine ─────────────────────────────► uses buffr's store (:53)
        (aptkit's mechanism, buffr's storage)
```

### Move 2 — the step-by-step walkthrough

**Part 1 — depending on contracts, not concretions (what breaks: the
no-edit rule).**

**File:** `src/pg-vector-store.ts:2` and `src/supabase-trace-sink.ts:2`.

```ts
import type { VectorStore } from '@rlynjb/aptkit-core';
import type { CapabilityTraceSink, CapabilityEvent } from '@rlynjb/aptkit-core';
```

These are `import type` — buffr depends on the *shapes*, then implements them
(`class PgVectorStore implements VectorStore`,
`class SupabaseTraceSink implements CapabilityTraceSink`). buffr never imports
aptkit's *concrete* in-memory store to subclass or patch it. If it did, a
breaking change inside aptkit's implementation would ripple into buffr. By
depending only on the published interface, buffr is insulated from aptkit's
internals — the dependency inversion principle, enforced by the package
boundary. **This is what makes "never edit aptkit" cheap instead of painful.**

**Part 2 — injecting implementations into aptkit's mechanisms (what breaks:
the whole composition).**

**File:** `src/session.ts` · **Lines:** 40-57.

```ts
const embedder = new OllamaEmbeddingProvider({ model: '...', host: cfg.ollamaHost });
const store    = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });   // ← buffr's store, aptkit's pipeline
const tool     = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
const model    = new ContextWindowGuardedProvider(new GemmaModelProvider({ host }), { maxTokens: 8192 });
const memory   = createConversationMemory({ embedder, store });  // ← buffr's store, aptkit's memory
const agent    = new RagQueryAgent({ model, tools, profile, trace });
```

Read the injection direction: every aptkit factory
(`createRetrievalPipeline`, `createSearchKnowledgeBaseTool`,
`createConversationMemory`, `RagQueryAgent`) takes buffr's concrete parts as
arguments. aptkit supplies the *verbs*; buffr supplies the *nouns*. The agent
loop is aptkit's; the store it searches is buffr's. Strip the injection and
aptkit has no Postgres — it falls back to in-memory and loses persistence.
**Load-bearing: this is the line where the two repos actually compose.**

**Part 3 — the extract-up: memory moved the *other* way (what breaks:
duplication).**

**File:** `src/session.ts` · **Lines:** 18-28 (the comment) and 53.

context.md records that `createConversationMemory` "was extracted *up* from
buffr into aptkit and is re-consumed via this bundle." This is the boundary
used as a *refactoring tool*: a mechanism that started life in buffr proved
general (embed an exchange, tag it `kind=memory`, recall it via the existing
search tool), so it moved up into aptkit where any consumer can use it, and
buffr re-consumes it injecting its own store.

```
  extract-up — the same code, moved across the boundary

  before:  [ buffr: memory engine + PgVectorStore ]
                          │  proved general
                          ▼  move the engine up
  after:   [ aptkit: memory engine ]  ◄── inject ── [ buffr: PgVectorStore ]
           the mechanism is shared; the storage stays buffr's
```

What it buys (the load-bearing test): if you stripped the extract-up, buffr
would carry a memory engine that *every other aptkit consumer would have to
re-implement*. Moving it up means the engine is written once and buffr's
contribution shrinks to the one thing that's actually buffr-specific — the
PgVectorStore it injects. The comment at `session.ts:24` says it plainly:
"The memory engine is aptkit's; buffr only injects its PgVectorStore."

**Part 4 — the honest boundary: what buffr *can't* fix from here.**

**File:** `src/session.ts:25-27`.

```
 * - Still missing: sequential in-prompt turn history (RagQueryAgent.answer()
 *   treats each question independently). That's an aptkit-side change;
 *   retrieval-based recall above gives relevance-based memory without it.
```

This comment is the boundary doing its job as *documentation of where the
line is*. buffr wants in-prompt conversation history, but `answer()` lives in
aptkit and buffr can't edit it — so buffr names the gap, explains the
workaround it built on its own side (retrieval-based recall), and leaves the
fix labeled as aptkit's. A boundary you respect is one you can point at and
say "that's not mine to change." That honesty is the design working.

### Move 3 — the principle

A dependency you can't edit is a *better* boundary than one you can, because
the impossibility forces every interaction through named contracts. Depend on
interfaces, inject implementations, and the two sides evolve independently —
aptkit ships `0.4.2` and buffr doesn't care as long as the contracts hold.
The extract-up is the same boundary used as a refactoring axis: when a
mechanism proves general, move it across the line so it's written once, and
shrink each consumer to the part that's genuinely its own.

---

## Primary diagram

The boundary, both directions, in one frame.

```
  the aptkit/buffr boundary — consume down, inject up, never edit across

  ┌─ aptkit @0.4.1 (never edited from here) ───────────────────────┐
  │  interface VectorStore        interface CapabilityTraceSink     │
  │  createRetrievalPipeline      createConversationMemory ◄┐       │
  │  RagQueryAgent.answer()  ←── "still missing: turn history"│      │
  └────────┬──────────────────────────────────▲──────────────┼──────┘
   import  │ type-only deps          inject    │ concrete     │ extracted
   (down)  ▼                         (up)       │ parts        │ UP (was buffr's)
  ┌─ buffr ──────────────────────────────────────────────────┴──────┐
  │  PgVectorStore implements VectorStore        (the noun)           │
  │  SupabaseTraceSink implements CapabilityTraceSink                 │
  │  createChatSession: wires nouns into aptkit's verbs (session.ts)  │
  └───────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is the Dependency Inversion Principle (the D in SOLID) made concrete by
an npm boundary: high-level policy (aptkit's agent loop) and low-level detail
(buffr's Postgres store) both depend on an abstraction (`VectorStore`), and
the detail is injected. APOSD's lens: the package boundary is the deepest
possible interface — an entire library's worth of behavior behind a handful
of imported names.

The extract-up echoes your **aipe** instinct (markdown-as-source, mechanisms
factored into reusable specs): when something proves general, it moves to
where it's shared. Here the move crossed a *published package* line, which is
the strongest version — once it's in aptkit `0.4.x`, every consumer benefits
and buffr can't accidentally fork it.

Read next: `01-adapter-behind-a-contract.md` (the `VectorStore` contract in
depth) and `04-sync-interface-async-work.md` (the `CapabilityTraceSink`
contract buffr implements).

---

## Interview defense

**Q: Isn't "can't edit the dependency" a limitation? Why frame it as good
design?**
Because it converts a discipline you'd otherwise have to enforce by hand into
something the build enforces for you. If aptkit were a folder I could edit,
every quick fix would tempt me to reach across the boundary and couple the two
repos. As an npm dependency I *can't*, so every interaction goes through a
named contract — which is exactly the property that lets aptkit ship new
versions without breaking buffr.

```
  the boundary forces contracts

  editable dep:   buffr ──reaches in──► aptkit internals  (couples)
  npm dep:        buffr ──calls only──► aptkit contracts  (decouples)
```

**Q: What did extracting memory *up* into aptkit actually buy?**
It shrank buffr to the part that's buffr's: the PgVectorStore. The memory
mechanism — embed an exchange, tag `kind=memory`, recall via the existing
search tool — is general, so it lives in aptkit written once. buffr re-consumes
it and injects its store (`session.ts:53`). Without the extract-up, every
aptkit consumer would re-implement episodic memory.

**Anchor:** "Depend on contracts, inject implementations; a dependency you
can't edit is a boundary the build enforces for you."

---

## See also

- `audit.md` §4 (layering — no pass-throughs across this boundary).
- `01-adapter-behind-a-contract.md` — the `VectorStore` contract implemented.
- `04-sync-interface-async-work.md` — the `CapabilityTraceSink` contract.
- `05-deep-session-facade.md` — where all the injection happens.
