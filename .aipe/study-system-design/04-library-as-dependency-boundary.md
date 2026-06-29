# 04 — Library as Dependency Boundary

**Industry name(s):** the provider abstraction / library-as-dependency boundary · dependency inversion across a package edge · the extract-up / inject-down round-trip. **Type:** Industry standard.

This file leans on ports & adapters from `01` — don't re-read the role-vocabulary here; the
port/adapter/client/seam definitions are owned by `study-software-design` → PATTERN VOCABULARY and
introduced in `01`. This file is about the *bigger* boundary: not one port, but the whole
**aptkit package edge**, and the most interesting thing that crosses it — the memory round-trip.

## Zoom out — where this concept lives

`01` showed one port. Step back and the whole system is split by a single line: **aptkit-core** on
one side (the engine — agent loop, retrieval, memory, evals), **buffr** on the other (the body —
the adapters, the schema, the CLI). buffr consumes aptkit and *never edits it*. That edit-direction
rule is the boundary, and it's a hard constraint, not a preference (`context.md`: "aptkit is
consumed, never edited here").

```
  Zoom out — the aptkit boundary splits the whole system

  ┌─ buffr (the body — this repo owns) ───────────────────────────┐
  │  chat.tsx · session.ts · PgVectorStore · SupabaseTraceSink ·  │
  │  the agents schema · the index/eval CLIs                      │
  └───────────────────────────────┬──────────────────────────────┘
        ★ THE BOUNDARY ★  buffr imports aptkit; aptkit never imports buffr
        depends on contracts ─────►│  npm dependency: @rlynjb/aptkit-core@0.4.1
  ┌─ aptkit-core (the engine — consumed, never edited) ───────────┐
  │  run-agent-loop · createRetrievalPipeline · @aptkit/memory ·  │
  │  GemmaModelProvider · evals · the VectorStore/TraceSink ports │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **a library boundary with inverted dependencies**. aptkit owns the reusable,
deployment-agnostic logic; buffr owns everything that touches *this* deployment (Postgres, the CLI,
the schema). The question it answers: *how do you build a real app on a toolkit without forking the
toolkit?* Answer — the toolkit exposes contracts; the app implements them; the dependency arrow only
ever points from app to toolkit.

## Structure pass — layers, axis, seam

**Layers:** buffr code → contracts (ports) → aptkit logic → aptkit's own adapters (Ollama, etc.).

**Axis — trace *who depends on whom* across the boundary, and watch the memory case break the
simple story:**

```
  axis = "which way does the dependency arrow point across the package edge?"

  normal case:   buffr ──depends on──► aptkit            (one direction, clean)

  memory case:   the engine was EXTRACTED UP, buffr→aptkit, then the
                 store is INJECTED DOWN, aptkit→buffr's PgVectorStore
                 → the LOGIC moved up; the DATA stays down. round-trip.
```

**The seam:** the npm package edge (`@rlynjb/aptkit-core`). Every import in `session.ts:2-6` crosses
it; nothing in aptkit reaches back. The interesting seam behavior is the **memory round-trip** —
where a piece of buffr's *logic* was promoted into aptkit, then re-consumed, while buffr's *store*
gets injected back down into it. The axis (dependency direction) does a U-turn there, and that
U-turn is the whole subject of this file.

## How it works

### Move 1 — the mental model

You know how you extract a custom hook out of a component once two components need it — the *logic*
moves up into a shared module, but the component still passes in its own state. The memory engine is
that move at package scale: the conversation-memory logic was extracted *up* out of buffr into
aptkit (so any app can reuse it), but buffr still injects its own `PgVectorStore` *down* into it. The
engine is shared; the storage stays buffr's.

```
  The extract-up / inject-down round-trip

  ① EXTRACT UP                      ② INJECT DOWN (consume)
  ──────────────                    ──────────────────────
  buffr had memory logic            aptkit's createConversationMemory
        │ promote it                      │ buffr calls it
        ▼                                 ▼
  aptkit/@aptkit/memory  ◄──────── createConversationMemory({ embedder, store })
  (the engine: embed,                            │ store = buffr's PgVectorStore
   tag kind=memory, recall)                      ▼
                                    memory writes ride buffr's OWN chunks table

  logic went UP (reusable); data stays DOWN (buffr's store). the arrow U-turns.
```

### Move 2 — the walkthrough

**The boundary in one import block.** Everything buffr pulls from aptkit comes through one package;
nothing leaks the other way (`session.ts:2-6`):

```ts
// src/session.ts:2
import {
  OllamaEmbeddingProvider, createRetrievalPipeline, createSearchKnowledgeBaseTool,
  InMemoryToolRegistry, GemmaModelProvider, ContextWindowGuardedProvider, RagQueryAgent,
  createConversationMemory,
} from '@rlynjb/aptkit-core';                    // ← the only door; buffr never edits behind it
```

Eight imports, one boundary. Each is either a *factory* (builds an aptkit thing) or a *contract*
(buffr implements it). buffr's own modules — `PgVectorStore`, `SupabaseTraceSink` — are the
implementations that get handed *back* to those factories. The dependency graph is acyclic across
the edge: buffr → aptkit, never aptkit → buffr.

**Dependency injection at the boundary — buffr's adapters flow into aptkit's factories.** Watch
`session.ts:39-57`: every aptkit factory is *given* a buffr-owned piece:

```ts
// src/session.ts:39
const pool  = createPool(cfg.databaseUrl);                       // buffr owns the pool
const store = new PgVectorStore({ pool, appId, dimension });     // buffr's adapter (port 01)
const pipeline = createRetrievalPipeline({ embedder, store });   // aptkit factory ← buffr's store
const tool  = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
const memory = createConversationMemory({ embedder, store });    // aptkit engine ← buffr's store
const trace = new SupabaseTraceSink({ pool, conversationId });   // buffr's adapter (port 03)
const agent = new RagQueryAgent({ model, tools, profile, trace });  // aptkit agent ← buffr's trace
```

This is dependency injection across a package edge. aptkit's `RagQueryAgent`, `createRetrievalPipeline`,
and `createConversationMemory` are all *generic* — they take whatever satisfies their contract.
buffr injects the Postgres-flavored implementations. aptkit never names Postgres; buffr never edits
aptkit. The wiring function is the only place the two sides meet.

**The memory round-trip — the load-bearing move.** `createConversationMemory` is the piece that was
extracted *up* and re-consumed. The source comment in `session.ts:49-53` names it exactly:

```ts
// src/session.ts:50  (comment)
// Retrievable episodic memory over buffr's own store. The engine (embed, tag,
// recall) is aptkit's; buffr injects the PgVectorStore. Sharing the document
// store means memory surfaces via the existing search_knowledge_base tool — and
// memory chunks live with no documents row, which the dropped FK allows.
const memory = createConversationMemory({ embedder, store });   // aptkit engine, buffr store
```

Two architectural consequences fall out of this one line:

1. **The engine moved up, the data stayed down.** The *logic* of "embed an exchange, tag it
   `kind=memory`, recall relevant ones later" lives in aptkit's `@aptkit/memory` now (extracted up
   from buffr — `context.md`: "extracted *up* from buffr into aptkit and re-consumed"). But the
   memory chunks land in buffr's *own* `agents.chunks` table, because buffr injected its own `store`.
   Reusable logic, local data.

2. **Memory rides the same retrieval path — for free.** Because memory writes into the *same* store
   the corpus uses, past exchanges resurface through the *same* `search_knowledge_base` tool — no
   second memory subsystem, no separate recall path (`session.ts:51-52`). A memory is just a chunk
   tagged `kind=memory` (`context.md`, id `"memory:<conv>:<n>"`). And this only works because the FK
   was dropped (`01`, `sql/001:26-27`): a memory chunk has no `documents` row, which a hard FK would
   forbid. The `01` soft-link decision *and* this round-trip are the same decision seen from two
   angles.

**Where it's consumed in the turn — best-effort, downstream.** `session.ts:64-69`:

```ts
// src/session.ts:64
try {
  await memory.remember({ conversationId, question, answer });   // embed + upsert as a memory chunk
} catch {
  // swallow: memory is best-effort, the turn already succeeded
}
```

The placement is deliberate (audit lens 6): `remember` runs *after* the answer is returned and the
trajectory is flushed, wrapped in a swallow. A boundary call that's downstream and optional gets
degraded, not propagated — a failure in the injected engine can't lose the answer the user already
has.

### Move 2 variant — the load-bearing skeleton

```
  Library-boundary kernel:
    1. one-directional dependency    — buffr→aptkit, never the reverse
    2. contracts at the edge         — aptkit exposes ports, buffr implements them
    3. DI in one wiring function     — buffr's adapters injected into aptkit factories
    4. extract-up / inject-down      — logic promoted to aptkit; buffr's store injected back
```

- Drop **#1** (let aptkit import buffr) → a cycle; the "consumed, never edited" rule collapses and
  the toolkit becomes "the buffr app."
- Drop **#2** → buffr would have to fork aptkit to change storage; the whole repo-split premise dies
  (`aptkit-packages-design.md:47-51`).
- Drop **#4's inject-down** → memory would need its own store, its own recall path, its own table —
  the free reuse of `search_knowledge_base` vanishes.

### Move 3 — the principle

**Put the reusable logic in the library and inject the deployment-specific pieces in from the app —
then the same engine serves every app and the app never forks the engine.** The memory round-trip is
the sharpest version: a capability can be promoted *up* into shared code and still run against *your*
storage, because the boundary is a contract, not a class. Logic flows up to be shared; data stays
down where it lives. The repo-split plan states the bet plainly — putting Supabase + Ollama config
inside aptkit "would turn the toolkit into 'the Gemma+Supabase app' and kill its reuse"
(`agent-layer-plan.md:48-49`).

## Primary diagram

```
  Library as Dependency Boundary — full picture

  ┌─ buffr (body) ────────────────────────────────────────────────┐
  │  session.ts — the one wiring function                          │
  │   builds: pool, PgVectorStore, SupabaseTraceSink               │
  │   injects them into aptkit factories ──────────────┐          │
  └───────────────────────────────────┬────────────────┼──────────┘
            depends on (one way) ──────┤                │ injects (DI)
  ┌─ aptkit-core (engine) ─────────────▼────────────────▼──────────┐
  │  createRetrievalPipeline(store)   RagQueryAgent(trace)         │
  │  createConversationMemory(store) ◄── EXTRACTED UP from buffr   │
  │  GemmaModelProvider · evals · run-agent-loop                   │
  └───────────────────────────────────┬───────────────────────────┘
       memory writes ride buffr's store│  (inject-down)
  ┌─ Storage (buffr's) ────────────────▼───────────────────────────┐
  │  agents.chunks — corpus AND memory (meta.kind=memory),          │
  │  one store, surfaced by ONE search_knowledge_base tool          │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the library-vs-application split that every mature toolkit enforces (think React vs your app,
or Express vs your routes): the framework owns the generic mechanism, you own the specifics, and the
dependency only points one way. buffr's twist is the *bidirectional history* of the memory engine —
it started in buffr, got promoted into aptkit, and came back as a dependency. That extract-up move is
how toolkits actually grow: an app proves a pattern, the pattern gets generalized into the library,
every other app inherits it. The plan's repo-split rationale (`agent-layer-plan.md:40-53`) is the
deliberate version of this — decide what's library (deployment-agnostic) vs body (this deployment)
*by kind of thing*, not by feature.

You've lived the other side of this: AdvntrCue "welded in OpenAI" (`me.md`, `aptkit-packages-
design.md:175`), and that weld is exactly what this boundary prevents — vendor and storage are
injected, never baked in.

Read next: `01-vector-store-adapter.md` (one port up close), `03-trajectory-capture.md` (the trace
port, also injected), `02-retrieval-pipeline.md` (the shared store memory rides on). The package /
module-edge mechanics → `study-software-design`.

## Interview defense

**Q: aptkit is a dependency. What stops it from becoming a fork?**
The dependency only points one way — buffr imports aptkit, aptkit never imports buffr — and buffr
extends aptkit only by *implementing its contracts* (`PgVectorStore`, `SupabaseTraceSink`), never by
editing it. Changing the database is a new adapter injected at one wiring site (`session.ts:39-57`),
not a patch to the library.

```
  buffr ──imports──► aptkit          (allowed, one way)
  aptkit ──imports──► buffr          (forbidden — would be a cycle, would force a fork)
```

**Q: Explain the memory round-trip.**
The conversation-memory *logic* was extracted up out of buffr into aptkit's `@aptkit/memory`, so any
app can reuse it. buffr re-consumes it via `createConversationMemory({ embedder, store })` and injects
its *own* `PgVectorStore` — so the engine is aptkit's but the data lands in buffr's `agents.chunks`.
Logic up, data down. The payoff: memory chunks share the corpus store, so they resurface through the
existing `search_knowledge_base` tool — no separate memory subsystem (`session.ts:49-53`).

```
  logic:  buffr ──extract up──► aptkit @aptkit/memory   (reusable)
  data:   aptkit ──inject down──► buffr's PgVectorStore  (memory rides agents.chunks)
```

**Q: Why is memory a chunk in the same table instead of its own?**
So recall is free. A memory tagged `meta.kind=memory` is just another vector in `agents.chunks`, so
the same cosine search and the same `search_knowledge_base` tool surface it alongside corpus chunks —
relevance-based episodic recall with zero new machinery. It works only because the `chunks→documents`
FK was dropped, letting a chunk exist with no document row (`session.ts:51-52`, `sql/001:26-27`).

## See also

- `01-vector-store-adapter.md` — the `VectorStore` port and the dropped-FK decision this reuses.
- `03-trajectory-capture.md` — the `CapabilityTraceSink` port, injected the same way.
- `02-retrieval-pipeline.md` — the shared store and `search_knowledge_base` tool memory rides on.
- `audit.md` lens 1 (the aptkit boundary), lens 3 (memory owned by the store, not the prompt).
- `study-software-design` → dependency inversion across a package edge.
