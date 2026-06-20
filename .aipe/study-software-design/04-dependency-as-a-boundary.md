# Dependency as a boundary — aptkit imported, never edited

**Subtitle:** Dependency Inversion / consume-a-library-as-a-contract —
*Industry standard*. aptkit is a hard boundary: buffr imports `@rlynjb/aptkit-core`
and implements its interfaces, but never edits a line of it.

---

## Zoom out, then zoom in

There are two repos in this story. aptkit owns the *what* of an agent — the
pipeline, the agent loop, the tool registry, the contracts. buffr owns the *where*
— persistence to Postgres, the CLI, the wiring. The line between them is a hard
constraint: aptkit is a published npm dependency, consumed and never modified. That
line is the most important architectural decision in the codebase, and it's the one
that makes every other pattern in this guide possible.

```
  Zoom out — the two-repo boundary

  ┌─ @rlynjb/aptkit-core (npm, ^0.4.0 — NEVER EDITED here) ───────┐
  │  contracts:  VectorStore  CapabilityTraceSink  RetrievalPipeline│
  │  behavior:   RagQueryAgent  createSearchKnowledgeBaseTool       │
  │              OllamaEmbeddingProvider  GemmaModelProvider         │
  │              scorePrecisionAtK  ContextWindowGuardedProvider     │
  └───────────────────────────┬───────────────────────────────────┘
              import boundary  ▼  (the hard line — ★ THIS CONCEPT ★)
  ┌─ buffr (this repo) ───────────────────────────────────────────┐
  │  implements:  PgVectorStore  SupabaseTraceSink                 │
  │  wires:       cli/* builds aptkit objects + buffr adapters     │
  │  adds:        Postgres persistence aptkit knows nothing about  │
  └────────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is *dependency inversion across a package boundary*. buffr
depends on aptkit's *abstractions* (the contracts) and supplies the *details* (the
Postgres implementations). Because the dependency is a published package, the
boundary is enforced by reality, not discipline — you literally cannot edit aptkit
from buffr. That hard wall is what keeps buffr's design honest.

---

## Structure pass — layers · axis · seams

Two layers, and they're in *separate repositories* — which is the strongest kind of
layer boundary. The axis that matters is **dependency direction** — which way the
import arrow points, and what that forbids.

```
  Axis traced = "which way does the dependency arrow point?"

  ┌─ aptkit ───────┐   import boundary   ┌─ buffr ──────────┐
  │  knows NOTHING │ ◄═══════╪══════════ │  imports aptkit  │
  │  about buffr   │   (one-way only)    │  implements its  │
  │  or Postgres   │                     │  contracts       │
  └────────────────┘                     └──────────────────┘
       ▲                                          ▲
       └── arrow points ONE way: buffr → aptkit ──┘
           aptkit can't depend back. That's the inversion.
```

- **The seam: the import line.** `import type { VectorStore } from
  '@rlynjb/aptkit-core'` (`src/pg-vector-store.ts:2`). aptkit defines the type;
  buffr consumes it. The dependency arrow points buffr → aptkit and *cannot* point
  back — aptkit has no idea Postgres exists. That one-directional arrow is the
  inversion.
- **Why the boundary is load-bearing:** it's what forces buffr's modules to be
  deep. buffr can't widen the `VectorStore` interface to leak a Postgres detail
  upward, because it doesn't own that interface. The boundary is an *upper bound on
  leakage* — see `01-adapter-behind-a-contract.md`, which is one concrete plug into
  this boundary.
- **The two kinds of things crossing the seam:** *contracts* buffr implements
  (`VectorStore`, `CapabilityTraceSink`) and *behavior* buffr instantiates
  (`RagQueryAgent`, `OllamaEmbeddingProvider`, the eval scorers). The first buffr
  fills in; the second buffr just uses.

---

## How it works

### Move 1 — the mental model

You know how you `npm install react` and write components against its API but never
fork React to add a feature? Same relationship, except buffr also *implements*
some of aptkit's interfaces (like writing a custom hook that satisfies a typed
contract). aptkit is the framework; buffr is the app. The strategy: **depend on a
package's published surface and treat it as immutable** — adapt to it, never patch
it.

```
  The boundary — two roles buffr plays against one dependency

   aptkit exports ─┬─► CONTRACTS ──► buffr IMPLEMENTS them
                   │   (VectorStore,    (PgVectorStore,
                   │    TraceSink)        SupabaseTraceSink)
                   │
                   └─► BEHAVIOR ───► buffr INSTANTIATES it
                       (RagQueryAgent,   (cli/* news them up
                        Providers)        and wires together)
```

### Move 2 — the step-by-step walkthrough

**Implementing a contract — buffr fills aptkit's hole.** When buffr writes `class
PgVectorStore implements VectorStore`, it's promising aptkit "I am a thing you can
store and search vectors in." aptkit's `createRetrievalPipeline` accepts it without
knowing it's Postgres. The boundary condition: if buffr's method signatures drift
from the contract, TypeScript fails the build at the import site — the compiler
enforces the boundary buffr can't edit.

```
  Contract implementation — buffr satisfies aptkit's interface

   aptkit:  interface VectorStore { upsert(); search(); dimension }
                          ▲  must match exactly
   buffr:   class PgVectorStore implements VectorStore { ... }
                          │
                          └─ drift the signature → compile error at the
                             pipeline call site. The type IS the boundary.
```

**Instantiating behavior — buffr uses aptkit as-is.** The CLIs `new`
aptkit's classes and compose them: `new OllamaEmbeddingProvider(...)`,
`createRetrievalPipeline({ embedder, store })`, `new RagQueryAgent({ model, tools,
profile, trace })`. buffr supplies the *constructor arguments* — and crucially,
some of those arguments are buffr's own contract implementations. The composition
point is where buffr's adapters meet aptkit's behavior.

```
  Composition — buffr's adapters plug into aptkit's behavior

   buffr's PgVectorStore ──┐
                           ├─► createRetrievalPipeline (aptkit) ──► pipeline
   aptkit's Ollama embedder┘
   buffr's SupabaseTraceSink ──► new RagQueryAgent({ trace }) (aptkit) ──► agent
```

**The constraint that proves the boundary: 768 lives on both sides, owned by
aptkit's embedder.** The CLI passes `embedder.dimension` into `PgVectorStore`
(`src/cli/index-cmd.ts:19`) rather than hardcoding 768 in buffr. The dimension is
aptkit's embedder's fact; buffr reads it across the boundary and conforms its store
to it. That's the boundary working correctly — buffr adapts to aptkit's truth
instead of asserting its own.

### Move 3 — the principle

A package boundary is the strongest module boundary you can have, because it's
enforced by the build system and the registry, not by a code reviewer's vigilance.
**When you consume a library as a contract and refuse to fork it, you trade the
freedom to patch for the guarantee that your side stays adapter-shaped.** Every
deep module in buffr is deep *because* it couldn't reach across this line to leak.
The constraint isn't a limitation — it's the thing generating the design quality.

---

## Primary diagram

The full boundary in one frame.

```
  Dependency-as-a-boundary — the whole two-repo relationship

  ┌─ @rlynjb/aptkit-core (npm ^0.4.0 — immutable) ───────────────┐
  │  CONTRACTS              BEHAVIOR                              │
  │  VectorStore ───┐       RagQueryAgent     OllamaEmbedder     │
  │  CapabilityTrace│       RetrievalPipeline ContextGuarded     │
  │  Sink ──────────┤       ToolRegistry      score{Precision,   │
  │                 │       GemmaProvider      Recall}AtK        │
  └─────────────────┼────────────────┬───────────────────────────┘
       implements    │     instantiates│   (one-way import arrow ▲)
  ┌─────────────────▼────────────────▼───────────────────────────┐
  │ buffr:  PgVectorStore   SupabaseTraceSink                     │
  │         cli/index · ask · eval  (compose + wire + persist)    │
  │         + Postgres aptkit never sees                          │
  └────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Every source file that touches aptkit reaches for this boundary.
The *implements* side: `src/pg-vector-store.ts:2,19` (`VectorStore`) and
`src/supabase-trace-sink.ts:2,23` (`CapabilityTraceSink`). The *instantiates* side:
all three CLIs — `src/cli/index-cmd.ts:4,18-20`, `src/cli/ask-cmd.ts:2-6,23-33`,
`src/cli/eval-cmd.ts:3-4,14-16`. `runtime.ts` sits on the boundary too, taking an
aptkit `RetrievalPipeline` as a parameter (`src/runtime.ts:2,8`) and calling
`pipeline.index` without owning it.

**Code side by side.**

```
  src/pg-vector-store.ts  (lines 1-2, 19) — the implements side

  import pg from 'pg';
  import type { VectorStore } from '@rlynjb/aptkit-core';  ← import the CONTRACT
  ...
  export class PgVectorStore implements VectorStore {       ← promise to satisfy it
       │
       └─ buffr owns the body, aptkit owns the shape. buffr cannot widen
          this interface to leak a Postgres detail upward — it doesn't
          own VectorStore. The boundary caps leakage. (the whole point)
```

```
  src/cli/ask-cmd.ts  (lines 23-33) — the instantiates side

  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });  ← aptkit
  const tools = new InMemoryToolRegistry([tool.definition], {...});      ← aptkit
  const model = new ContextWindowGuardedProvider(                        ← aptkit
    new GemmaModelProvider({ host: cfg.ollamaHost }), { maxTokens: 8192 });
  ...
  const agent = new RagQueryAgent({                          ← aptkit BEHAVIOR
    model, tools, profile,
    trace,                                                   ← buffr's adapter,
  });                                                           plugged in here
       │
       └─ buffr supplies the args (some are buffr's own contract impls);
          aptkit supplies the orchestration. The wiring point is the seam.
```

```
  src/runtime.ts  (lines 5-17) — on the boundary

  export async function indexDocumentRow(
    pool: pg.Pool, appId: string,
    pipeline: RetrievalPipeline,     ← takes aptkit's type as a param, owns none of it
    doc: {...},
  ): Promise<void> {
    await pool.query(`insert into agents.documents ...`);  ← buffr's own addition
    await pipeline.index({ id: doc.id, text: doc.text });  ← hand off to aptkit
  }
       │
       └─ buffr adds the documents-row write (aptkit has no document concept),
          then forwards to aptkit. The boundary lets buffr add behavior
          aptkit doesn't know about without touching aptkit. (Lens 4)
```

---

## Elaborate

This is the Dependency Inversion Principle scaled up from class-level to
package-level: high-level policy (aptkit's agent contracts) and low-level detail
(buffr's Postgres) both depend on abstractions (the contracts), and the detail
points at the policy, never the reverse. The reason it's load-bearing for *this*
repo specifically is the project constraint: "aptkit is consumed, never edited
here." That turns a design preference into a hard wall. The neighboring patterns —
`01-adapter-behind-a-contract.md` and `03-sync-interface-async-work.md` — are both
concrete implementations *of* contracts that cross this boundary; this file is the
boundary itself. Read this one first to see the wall, then those two to see what
gets plugged into it.

---

## Interview defense

**Q: Why is "never edit aptkit" a design strength rather than a limitation?**
Because it makes the boundary unforgeable. If buffr could patch aptkit, the
temptation would be to widen `VectorStore` to leak a Postgres detail upward "just
this once" — and the deep module collapses. The immutable dependency removes that
escape hatch, so every buffr module *has* to stay adapter-shaped. The constraint
generates the design quality; it doesn't cost it.

```
  editable dep (worse)             immutable dep (chosen)
  ───────────────────              ──────────────────────
  patch aptkit to leak detail      can't patch → must adapt
  boundary erodes over time        boundary enforced by npm + tsc
  modules drift shallow            modules stay deep
```

**Q: What flows *across* the boundary, in which direction?** One way only: buffr →
aptkit. buffr imports aptkit's types and classes; aptkit imports nothing from
buffr and has no knowledge of Postgres. The proof is `embedder.dimension`
(`src/cli/index-cmd.ts:19`) — buffr reads aptkit's fact and conforms to it, never
the reverse.

**Q: Where would this boundary break down as the repo grows?** If buffr needed a
capability aptkit's contracts don't expose — say, transactional coordination
*between* a vector write and a trace write. Today they're separate contracts with
separate writes. The honest answer: you'd either request the seam from aptkit
(widen the published contract) or accept the lack of cross-contract atomicity. You
would *not* fork aptkit. Naming where the wall constrains you is the senior move.

---

## Validate

1. **Reconstruct:** name the two roles buffr plays against aptkit and one example
   of each. (Implements: `PgVectorStore`/`VectorStore`. Instantiates:
   `new RagQueryAgent`.)
2. **Explain:** why does the CLI pass `embedder.dimension` to the store instead of
   hardcoding 768? (`src/cli/index-cmd.ts:19`; the dimension is aptkit's fact, buffr
   conforms.)
3. **Apply:** you need a new retrieval scorer aptkit doesn't ship. Do you fork
   aptkit, or where does the code go? (Not a fork; buffr-side module or request the
   export.)
4. **Defend:** a teammate wants to "just tweak aptkit's `VectorStore` to return
   Postgres ids." Refute it with the boundary rule. (Constraint: aptkit consumed,
   never edited; the leak would collapse `PgVectorStore`'s depth.)

---

## See also

- `audit.md` — Lens 1 (the `meta` contract crossing this boundary), Lens 4 (layers).
- `01-adapter-behind-a-contract.md` — one concrete plug into this boundary.
- `03-sync-interface-async-work.md` — a second contract crossing the same line.
- `02-pure-core-impure-shell.md` — the wiring layer that does the composition.
- `study-system-design` → the two-repo architecture at the service altitude.
