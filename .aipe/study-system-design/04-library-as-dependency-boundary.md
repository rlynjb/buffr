# Library as Dependency Boundary

**Industry names:** dependency inversion · library/application split ·
repo-split (toolkit vs body) · stable dependency direction · Project-specific
(the aptkit↔buffr contract)

## Zoom out, then zoom in

There are two repos. aptkit is the **toolkit** — provider-agnostic,
deployment-agnostic, reusable across apps. buffr is the **body** — one
deployment, one device, one Postgres. The architecture *is* the dependency
direction: buffr imports aptkit and never the reverse, and aptkit is never
edited from inside buffr. That one rule is what keeps aptkit reusable and
keeps buffr's concerns (pg, Ollama, the CLI) out of the toolkit.

```
  Zoom out — the boundary that defines the whole repo

  ┌─ buffr (the body — this repo) ───────────────────────────────┐
  │  CLIs · chat session · PgVectorStore · SupabaseTraceSink      │
  │  agents schema                                                │
  │           │  imports (one direction only)                     │
  │           ▼          ▲ injects PgVectorStore into the engine   │
  │  ┌─ @rlynjb/aptkit-core (the toolkit — npm dep, 0.4.1) ─────┐ │
  │  │  RagQueryAgent · RetrievalPipeline · VectorStore (port)  │ │
  │  │  GemmaModelProvider · OllamaEmbeddingProvider · evals    │ │
  │  │  createConversationMemory (engine, bundles @aptkit/memory)│ │
  │  └──────────────────────────────────────────────────────────┘ │
  │           ▲  NEVER imports buffr · NEVER edited here          │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is the **stable-dependency / dependency-inversion**
boundary — the application depends on the library, the library depends on
nothing app-specific, and both meet at interfaces the library owns. Strip
this discipline and aptkit absorbs Supabase migrations and Ollama deploy
config, turning "the toolkit" into "the Gemma+Supabase app" and killing reuse
across blooming_insights, contrl, etc. The boundary is the product decision.

What sharpens the read since the last pass: the boundary just survived a
*round-trip*. buffr had grown its own conversation-memory logic; rather than
keep it app-side, the reusable *engine* (embed an exchange, tag it, recall it)
was extracted UP into aptkit and now ships in the published bundle as
`createConversationMemory` (imported, like everything else, from
`@rlynjb/aptkit-core`, not `@aptkit/memory` directly). buffr re-consumes that
engine and injects its `PgVectorStore` *down* into it (`session.ts:53`). So the
arrow stayed one-directional, but the seam now carries traffic both ways: a
reusable engine moved up, a deployment-specific store plugs down. That's a
worked example of the boundary doing its actual job — promoting the general,
keeping the specific local — not just a one-time consumption.

## Structure pass

**Layers** — buffr application code → aptkit library code. Two repos, one
import edge.

**Axis: which way does the dependency arrow point?** Hold it constant.

```
  One question: "who depends on whom?"

  ┌──────────────────────────────────────────────┐
  │ buffr CLIs → import aptkit                     │ → buffr depends UP
  └───────────────────────┬──────────────────────┘
      ┌───────────────────▼──────────────────────┐
      │ buffr adapters → implement aptkit's ports │ → buffr depends UP
      └───────────────────┬──────────────────────┘
          ┌───────────────▼──────────────────────┐
          │ aptkit → knows nothing about buffr    │ → arrow NEVER reverses
          └───────────────────────────────────────┘

  the arrow points one way at every altitude — that invariance IS the boundary
```

**Seam.** The npm package boundary is the *vertical seam* between two repos.
The contracts that cross it are aptkit's interfaces — `VectorStore`,
`CapabilityTraceSink`, `ModelProvider`, `EmbeddingProvider`. buffr fills them;
aptkit consumes the filled versions through dependency inversion. The trust
property that flips across the seam: **buffr can change freely; aptkit changes
are off-limits here** (must-not-change rule). The newest traffic across this
seam is `createConversationMemory`: a reusable engine that crossed UP (buffr →
aptkit, as a published feature in 0.4.1) and is now consumed back DOWN with
buffr's `PgVectorStore` injected into it — both directions, same one-way
dependency arrow.

## How it works

### Move 1 — the mental model

You know how you `import { useState } from 'react'` and never reach into
React's internals to make a feature work? If you need behavior React doesn't
give you, you compose *on top* — you don't fork React. aptkit is the same:
import what it offers, implement its interfaces for what's app-specific, never
edit it.

```
  the boundary — compose on top, never fork

  buffr  ─── imports ───►  aptkit (RagQueryAgent, pipeline, ports)
    │
    └── implements ports ──►  PgVectorStore, SupabaseTraceSink
                              (buffr's bodies for aptkit's interfaces)

  what buffr needs that aptkit lacks  → built in buffr, behind aptkit's port
  what aptkit lacks that's reusable   → would be a PR to aptkit, NOT an edit here
```

### Move 2 — the step-by-step walkthrough

#### What crosses the boundary — only imports and interface implementations

buffr touches aptkit in exactly two ways: it *imports* concrete classes
(`RagQueryAgent`, providers, pipeline factory, eval scorers) and it
*implements* aptkit's interfaces (`VectorStore`, `CapabilityTraceSink`).
Nothing else crosses.

```
  layers-and-hops — what travels across the npm seam

  ┌─ buffr ──────────────────┐ hop 1: import { RagQueryAgent, createConversationMemory, ... }
  │ session.ts, index-cmd, ...│ ───────────────────────────────────►┐
  └──────────────────────────┘                                      │
                                                                    │
  ┌─ buffr adapters ─────────┐ hop 2: class PgVectorStore           │
  │ PgVectorStore             │        implements VectorStore ──────┤
  │ SupabaseTraceSink         │        implements CapabilityTraceSink│
  └──────────────────────────┘                                      ▼
  ┌─ @rlynjb/aptkit-core ──────────────────────────────────────────┐
  │ exports the classes (hop 1) + owns the interfaces (hop 2)        │
  │ — depends on nothing in buffr                                    │
  └──────────────────────────────────────────────────────────────────┘
```

What breaks if buffr edited aptkit instead of implementing its ports: the edit
lives in `node_modules`, evaporates on `npm install`, and — the real cost —
aptkit stops being reusable because buffr's pg/Ollama assumptions leak into
the shared toolkit.

#### Where app-specific concerns live — entirely in buffr

Every concern that is *this deployment's* belongs in buffr: the Postgres
schema (`sql/`), the pg pool (`db.ts`), the Ollama host config (`config.ts`),
the CLI entrypoints. aptkit holds none of it.

```
  the split — concern by concern

  REUSABLE (aptkit)              DEPLOYMENT-SPECIFIC (buffr)
  ─────────────────              ───────────────────────────
  agent loop                     agents schema + migrations
  VectorStore interface          PgVectorStore (pg body)
  CapabilityTraceSink interface  SupabaseTraceSink (pg body)
  Gemma/Ollama providers*        pool, DATABASE_URL, OLLAMA_HOST config
  eval scorers                   index/eval CLIs + chat session, the corpus
  conversation-memory engine     the store the engine writes to (PgVectorStore)
  (createConversationMemory)
```

(*The Ollama *provider* is reusable and lives in aptkit; the Ollama *host
config* — which box, which port — is buffr's.)

What breaks if you push buffr's concerns into aptkit: the next app that wants
aptkit inherits buffr's Supabase migrations and Ollama deploy assumptions —
dead weight it can't use.

#### The escape hatch — fixes that must touch the library go to the library

The design hit two real cases where the *fix belonged in aptkit*: Gemma's
`top_k:1` starvation and a hallucinated filter key. The discipline held — both
fixes landed in `@aptkit/retrieval`, not as edits inside buffr's
`node_modules` (`laptop-supabase-graduation-design.md:209-212`). buffr only
*wired* the fix (`minTopK:4` at `session.ts:43`).

```
  decision rule — where does a fix go?

  is the fix reusable across apps?
     ├─ yes → it's an aptkit change (PR upstream) ──┐
     └─ no  → it's buffr code                       │
                                                     ▼
  buffr only ever WIRES upstream fixes (minTopK:4), never patches the dep
```

#### The round-trip — a feature promoted UP, re-consumed DOWN

The same decision rule, run on a whole *feature* instead of a one-line fix.
buffr needed retrievable conversation memory: after each turn, embed the
exchange and tag it so future turns can recall it. The reusable part of that —
the embed/tag/recall *engine* — isn't buffr-specific, so it went UP into aptkit
(published as `createConversationMemory` in `@rlynjb/aptkit-core@0.4.1`, which
bundles `@aptkit/memory`). The buffr-specific part — *where* those memory
chunks are stored — stays down: buffr injects its `PgVectorStore`. The arrow
never reversed; the seam just carried a feature both ways.

```
  the round-trip — engine up, store down (one arrow, two payloads)

  buffr memory logic ──promote──► aptkit createConversationMemory (0.4.1)
                                          │  import back down
  buffr: createConversationMemory({ embedder, store: PgVectorStore }) ◄──┘
       │
       └─ engine is aptkit's (reusable); store is buffr's (this deployment).
          Memory chunks share the SAME store as documents — so they surface
          through the existing search_knowledge_base tool, no new port needed.
```

What breaks if buffr had kept the engine local instead of promoting it: every
other app wanting conversation memory re-implements embed/tag/recall, and the
logic drifts per app. What breaks if aptkit had absorbed the *store* too:
every consumer inherits Postgres. Promoting the engine and injecting the store
is the boundary working exactly as designed.

### Move 3 — the principle

The most stable thing in a system should be the most depended-on, and it
should depend on nothing volatile. aptkit is stable and abstract; buffr is
volatile and concrete; the arrow points from volatile to stable and never
reverses. Keep that arrow one-directional and you can swap the entire body
(laptop → phone → edge) without the toolkit noticing.

## Primary diagram

The full boundary, both hop types, the must-not-change rule marked.

```
  aptkit ↔ buffr — the dependency boundary

  ┌─ buffr (volatile, concrete, this deployment) ───────────────────┐
  │  CLIs + chat session ──import──► aptkit classes                  │
  │  PgVectorStore ──implements──► VectorStore                       │
  │  SupabaseTraceSink ──implements──► CapabilityTraceSink           │
  │  PgVectorStore ──injected into──► createConversationMemory       │
  │  schema · pool · config · corpus  (all buffr-only)               │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ npm seam · arrow points UP only
                              │ aptkit NEVER edited here
                              │ (memory engine promoted UP, re-consumed DOWN)
  ┌─ @rlynjb/aptkit-core 0.4.1 (stable, abstract, reusable) ────────┐
  │  RagQueryAgent · RetrievalPipeline · evals · providers          │
  │  createConversationMemory (bundles @aptkit/memory)              │
  │  owns: VectorStore, CapabilityTraceSink, ModelProvider ports     │
  │  depends on: nothing in buffr                                    │
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every buffr file that does real work crosses this boundary: the
CLIs import the agent and pipeline; the adapters implement the ports. The
boundary is also a *constraint* — it's in the must-not-change list, so it
governs every change to the repo.

**Pure imports, no edits** — `src/session.ts:2-6`

```
  import {
    OllamaEmbeddingProvider, createRetrievalPipeline, createSearchKnowledgeBaseTool,
    InMemoryToolRegistry, GemmaModelProvider, ContextWindowGuardedProvider, RagQueryAgent,
    createConversationMemory,                                            ← 5: the memory engine
  } from '@rlynjb/aptkit-core';                                          ← 6: ONE package
        │
        └─ everything reusable is imported from the package — the agent, the
           providers, the guard, the tool factory, AND createConversationMemory.
           Note: imported from '@rlynjb/aptkit-core', NOT '@aptkit/memory'
           directly — 0.4.1 bundles memory into the published core. buffr
           composes, never forks.
```

**Implementing a port (the other hop)** — `src/pg-vector-store.ts:1-2, 19`

```
  import type { VectorStore } from '@rlynjb/aptkit-core';   ← 2: import the port
  export class PgVectorStore implements VectorStore {        ← 19: fill it
        │
        └─ buffr's app-specific body (Postgres) plugs into aptkit's reusable
           interface. Same pattern for SupabaseTraceSink implements
           CapabilityTraceSink (supabase-trace-sink.ts:49). And the SAME store
           instance is injected into aptkit's memory engine (session.ts:53).
```

**The wiring composes imports + implementations** — `src/session.ts:53, 57`

```
  const memory = createConversationMemory({ embedder, store });  ← 53: engine + injected store
  const agent  = new RagQueryAgent({ model, tools, profile, trace }); ← 57
        │
        └─ TWO seam crossings in two lines. RagQueryAgent (aptkit) receives
           `trace` (SupabaseTraceSink, buffr's port body). createConversationMemory
           (aptkit's engine) receives `store` (PgVectorStore, buffr's port body).
           Same shape both times: aptkit's reusable code consuming buffr's
           deployment-specific implementation.
```

**The rule, stated** — `context.md` must-not-change + design doc line 6: "it
depends on aptkit as a library, which stays untouched." This isn't just style
— it's why the package is a versioned dependency (`@rlynjb/aptkit-core@^0.4.1`
in `package.json`, bumped from 0.4.0 to pick up the bundled memory engine) and
not vendored source. The version bump is the *mechanism* of the round-trip: a
feature promoted up arrives back down as a published version, wired in, never
edited in `node_modules`.

## Elaborate

This is the Stable Dependencies Principle and Dependency Inversion (Robert
Martin) made concrete by a repo split. The deeper rationale is in the parent
plan's "Where the code lives": aptkit stays library-first and
provider-agnostic precisely because its `providers/` directory holds
anthropic/openai/local side by side — push one deployment's Supabase config in
and that symmetry dies (`agent-layer-plan.md`). The reader has lived the
other side of this: aipe (the meta-tooling project) is itself a
markdown-as-source library consumed by slash commands — same "build the
reusable core, consume it from the edge" instinct. The memory round-trip is
the clearest proof the boundary pays off: a feature that grew in the body got
*promoted* to the toolkit (published in 0.4.1) and re-consumed with the
deployment-specific store injected back in — the textbook lifecycle of "extract
the reusable core upward, keep the specific downward." The honest tension:
heavy co-evolution through early phases tempts a monorepo (`agent-layer-plan.md`
names this as the open consumption-seam question), but the published-package
boundary is what forced the engine/store split to be clean enough to publish —
discipline a monorepo would have let slide.

## Interview defense

**Q: Why is `PgVectorStore` in buffr and not in aptkit, when aptkit already
has the `VectorStore` interface?**

Because Postgres is *this deployment's* choice, not a reusable one. aptkit
owns the abstract port; buffr owns the concrete body. If pg lived in aptkit,
every other app consuming aptkit would inherit a Supabase dependency it may
not want. The port is reusable; the implementation is deployment-specific.

```
  aptkit: VectorStore (port, reusable)
              ▲
       buffr: PgVectorStore (body, this deployment only)
```

Anchor: `src/pg-vector-store.ts:19`.

**Q: You found a bug in aptkit's retrieval tool. Where does the fix go?**

Upstream, into aptkit — never as an edit inside buffr's `node_modules`. That's
exactly what happened with the `top_k:1` and hallucinated-filter bugs: both
fixed in `@aptkit/retrieval`, and buffr only *wired* the result with
`minTopK:4`. A node_modules edit evaporates on install and leaks deployment
assumptions into the shared toolkit.

```
  reusable fix → aptkit PR ──► buffr bumps version + wires it (minTopK:4)
  app-specific fix → buffr code
```

Anchor: `src/session.ts:43`;
`laptop-supabase-graduation-design.md:209-212`.

**Q: buffr grew its own conversation-memory logic. Why move the engine into
aptkit instead of keeping it local — and how does the store stay buffr's?**

Because the engine (embed an exchange, tag it, recall it) is reusable across
any app, but *where* memories are stored is deployment-specific. So the engine
was promoted up and published (`createConversationMemory` in 0.4.1), and buffr
re-consumes it injecting its `PgVectorStore`. The dependency arrow never
reversed — aptkit still depends on nothing in buffr — it's the same
port-injection shape as `VectorStore`, applied to a whole feature. Engine up,
store down.

```
  buffr engine ──promote──► aptkit createConversationMemory (published 0.4.1)
  aptkit engine ◄──import + inject PgVectorStore── buffr (session.ts:53)
```

Anchor: `src/session.ts:53`; `package.json` (`@rlynjb/aptkit-core@^0.4.1`).

## Validate

1. **Reconstruct.** Draw the two repos and the one-directional import arrow,
   then label the two kinds of thing that cross the seam.
2. **Explain.** Why does the Ollama *provider* live in aptkit but the Ollama
   *host config* live in buffr (`config.ts:14`)?
3. **Apply.** You want filter-by-`app_id` retrieval that aptkit doesn't
   support. Where does the change go, and how do you decide?
4. **Defend.** Argue for the published-package boundary over a monorepo, given
   the parent plan flags the choice as open (`agent-layer-plan.md`).

## See also

- `01-vector-store-adapter.md` — one of the two ports buffr fills (and the
  store injected into the memory engine).
- `03-trajectory-capture.md` — the other port (`CapabilityTraceSink`).
- `05-cli-as-entrypoints.md` — where buffr's imports get composed (the chat
  session wires the memory engine).
- `07-deferred-body.md` — swapping the body without touching the toolkit.
- `study-software-design` — deep-module / info-hiding read of the seam.

---

Updated: 2026-06-24 — STRENGTHENED to a bidirectional round-trip: the
conversation-memory engine was promoted UP into aptkit (published as
`createConversationMemory` in 0.4.1, bundling `@aptkit/memory`) and re-consumed
DOWN with `PgVectorStore` injected; arrow stays one-directional. Bumped
`@rlynjb/aptkit-core` 0.4.0→0.4.1; re-anchored imports/wiring from `ask-cmd.ts`
to `session.ts`; noted imports come from `@rlynjb/aptkit-core`, not
`@aptkit/memory` directly.
