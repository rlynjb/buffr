# 02 — Library as Dependency Boundary

**Industry name(s):** Library-vs-application split / dependency inversion across a repo
boundary. The "extract-up, consume-down" round-trip.
**Type:** Project-specific (a deliberate two-repo architecture).

## Zoom out, then zoom in

Two repos, one boundary. aptkit is the deployment-agnostic toolkit; buffr is the
running body. The rule that shapes everything: **buffr imports aptkit, buffr never edits
aptkit** (`.aipe/project/context.md:65`). Reusable logic that started in buffr gets
*extracted up* into aptkit, then *consumed back down* as a dependency.

```
  Zoom out — the two-repo boundary

  ┌─ aptkit repo (library — deployment-agnostic) ───────────────────────┐
  │  ModelProvider · VectorStore · CapabilityTraceSink · EmbeddingProvider│
  │  run-agent-loop · retrieval pipeline · evals · @aptkit/memory          │
  │  published as @rlynjb/aptkit-core@0.4.1                                │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ ★ THE BOUNDARY ★  npm dependency
                                  │ buffr imports; never edits
  ┌─ buffr repo (the body — has a URL, secrets, a database) ────────────▼┐
  │  PgVectorStore · SupabaseTraceSink · the agents schema · the chat CLI │ ← we are here
  └───────────────────────────────────────────────────────────────────────┘
```

Zoom in. The pattern is **dependency inversion across a repo boundary**: the abstractions
(contracts) live in the library; the volatile, deployment-specific implementations live
in the app; the app depends on the library, never the reverse. The question it answers:
*what goes in the reusable toolkit, what stays in the one running service, and how do
you move code across that line without forking?*

## Structure pass

**Layers:** library contracts (aptkit) → library logic (aptkit) → app implementations
(buffr) → app deployment (buffr: schema, secrets, CLI).

**Axis — which direction does the dependency arrow point?** Always toward aptkit. buffr
→ aptkit, never aptkit → buffr. That's the inversion: the high-level policy (agent loop,
pipeline) lives in the library and depends only on contracts; the low-level detail
(Postgres) lives in the app and conforms to those contracts. The arrow never flips —
which is exactly why aptkit can be published and reused by `blooming_insights` and
`contrl` without dragging buffr's Postgres along.

**Seam:** the package boundary `@rlynjb/aptkit-core` (`package.json:14`). A vertical seam
between two repos. The contract test: *control and ownership flip across it.* aptkit owns
the loop's control flow; buffr owns when and where data persists. Both cross the seam —
buffr injects implementations down, aptkit's memory engine was lifted up.

## How it works

### Move 1 — the mental model

You've felt this boundary every time you used a library: `react-dom` doesn't know about
your app, your app imports it and passes it components. What's unusual here is the
*round-trip* — code that was born in your app, grew up enough to be reusable, and moved
*into* the library, after which your app re-imports it like any third-party module.

```
  the extract-up / consume-down round-trip

   buffr (was here)         aptkit (now lives here)        buffr (re-consumes)
   ────────────────         ──────────────────────         ───────────────────
   createConversation  ──►  @aptkit/memory               ──►  import { create-
   Memory (local impl)      (general, store-injected)          ConversationMemory }
                            published in 0.4.1                  from aptkit-core
```

### Move 2 — the walkthrough

**The contracts buffr fills.** aptkit defines four contracts; buffr implements two of
them and instantiates the rest. In `src/session.ts:1-11` you can read the whole boundary
in the import list — everything from `@rlynjb/aptkit-core` is the library; everything
from `./*` is buffr.

```ts
// src/session.ts:2-11 — the boundary, visible in the imports
import {
  OllamaEmbeddingProvider, createRetrievalPipeline, createSearchKnowledgeBaseTool,
  InMemoryToolRegistry, GemmaModelProvider, ContextWindowGuardedProvider, RagQueryAgent,
  createConversationMemory,                       // ← all aptkit (library)
} from '@rlynjb/aptkit-core';
import { PgVectorStore } from './pg-vector-store.js';      // ← buffr fills VectorStore
import { SupabaseTraceSink } from './supabase-trace-sink.js'; // ← buffr fills CapabilityTraceSink
```

**Injection down — buffr hands implementations into aptkit.** The wiring at
`src/session.ts:41-57` is the whole dependency-injection story: buffr builds a
`PgVectorStore`, passes it into aptkit's `createRetrievalPipeline`, and the pipeline
never learns it's Postgres.

```ts
// src/session.ts:41-53 — buffr injects its adapters into aptkit's factories
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });   // store injected DOWN
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
// ...
const memory = createConversationMemory({ embedder, store });    // SAME store injected DOWN
```

**Extraction up — the memory round-trip, the signature move.** `createConversationMemory`
was extracted *out of buffr, up into aptkit*, and is now re-consumed
(`.aipe/project/context.md:24`). Why this matters architecturally: the engine in aptkit
(`packages/memory/src/conversation-memory.ts`) **never names a database** — it speaks
only the `VectorStore` contract and takes the store as a parameter
(aptkit `conversation-memory.ts:18-31`). So buffr can inject its `PgVectorStore` and get
durable memory, while a test injects an in-memory store and gets the identical logic.
The extraction only worked *because* the engine depends on the contract, not on buffr.

```
  Layers-and-hops — the memory engine, store-injected

  ┌─ buffr session ─┐  hop 1: createConversationMemory({embedder, store})
  │  session.ts:53  │ ──────────────────────────────────────────────────►┐
  └─────────────────┘                                                      │
                                                              ┌─ aptkit @aptkit/memory ─┐
                                                              │ remember(): embed→upsert │
                                                              │ recall(): search→filter  │
                                                              │ ★ never names a DB ★      │
                                                              └────────────┬─────────────┘
                          hop 2: store.upsert / store.search               │
  ┌─ buffr PgVectorStore ◄──────────────────────────────────────────────┘
  │  the same adapter from file 01 — Postgres pgvector
  └──────────────────────────────────────────────────────────────────────
```

**Where the line is drawn — what stays in buffr.** The graduation spec's table is the
rule (`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md:25-33`):
aptkit = deployment-agnostic toolkit (contracts + logic, reusable across apps); buffr =
the body (a running service with a URL, secrets, an Ollama box, a database). Migrations,
the `pg.Pool`, the `.env` `DATABASE_URL`, the Ink CLI — none of that is aptkit's job,
because welding Postgres + Ollama deploy config into aptkit would kill its reuse across
`blooming_insights` and `contrl` (`agent-layer-plan.md:49`).

**Why two repos and not one workspace.** Considered, and the round-trip is the reason it
works either way — but the published-package boundary forces the discipline. If buffr
could reach into aptkit's internals, the temptation to special-case Postgres in the
pipeline would be irresistible, and the contract would rot. The hard boundary is what
keeps aptkit honest.

### Move 2.5 — current vs future state

The boundary is built to absorb the deferred body with no library change.

```
  Phase A (now)                          Phase B (deferred body)
  ─────────────                          ───────────────────────
  buffr injects PgVectorStore   ──►      buffr injects an Edge-Fn-backed store
  one writer, app_id='laptop'            phone injects its own store
  aptkit contracts UNCHANGED             aptkit contracts UNCHANGED
```

The takeaway is what *doesn't* change: every deferred step (pgvector → Edge Functions,
laptop → laptop+phone, single store → synced stores) reuses the same `VectorStore` and
`CapabilityTraceSink` contracts. The graduation spec states it plainly — graduating to
any deferred phase "reuses this schema and the `VectorStore` contract — no rework"
(`...graduation-design.md:188`).

### Move 3 — the principle

Put the abstractions where they're reused and the volatile details where they run. The
dependency arrow points at the stable thing. When a piece of your app turns out to be
general — like the memory engine — the move isn't to copy it, it's to extract it up
*behind the same contract it already used*, so the consume-down path is unchanged. The
contract is what makes both directions of the round-trip safe.

## Primary diagram

The full boundary, both directions of the round-trip, every layer labelled.

```
  aptkit / buffr — the dependency boundary, both directions

  ┌─ aptkit (library, dependency arrow points HERE) ────────────────────┐
  │  contracts:  VectorStore · CapabilityTraceSink · ModelProvider        │
  │  logic:      run-agent-loop · retrieval pipeline · @aptkit/memory      │
  │                ▲ extract-up                    │ consume-down          │
  └────────────────┼───────────────────────────────┼─────────────────────┘
                   │ (createConversationMemory      │ (import + inject)
                   │  was lifted from buffr)        ▼
  ┌─ buffr (the body — Postgres, secrets, CLI) ─────────────────────────┐
  │  implements:  PgVectorStore · SupabaseTraceSink                       │
  │  owns:        agents schema · pg Pool · .env · Ink chat CLI           │
  │  injects implementations DOWN into aptkit's factories (session.ts)    │
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is dependency inversion (the D in SOLID) applied at repo scale, plus the
"library-first" discipline from `agent-layer-plan.md:35` — "build the glue and the
judgment layer; don't reinvent the agent loop or vector search." The round-trip is the
unusual part: most apps only consume libraries; here a chunk of the app graduated into
the library. That's the same instinct behind your DSA repo translating Python → TS — the
*concept* (episodic memory) is the signal, the *location* (buffr vs aptkit) is
incidental, and moving it across the boundary cost nothing because it always spoke the
contract.

What to read next: `01-vector-store-adapter.md` (the contract buffr fills),
`06-retrieval-as-memory.md` (what the extracted engine does), `07-deferred-body.md`
(what the boundary will absorb next).

## Interview defense

**Q: Why is aptkit a separate dependency instead of code in buffr?**
Reuse. aptkit is the deployment-agnostic toolkit several apps consume
(`blooming_insights`, `contrl`); buffr is one running body with a database and secrets.
Welding Postgres + Ollama config into aptkit would kill its reuse. The split keeps the
dependency arrow pointing at the stable, reusable thing.

```
  blooming ─┐
  contrl   ─┼──► import @rlynjb/aptkit-core ──► one toolkit, many bodies
  buffr    ─┘     (Postgres stays in buffr only)
```
Anchor: the repo-split table at `...graduation-design.md:25-33`; the constraint at
`.aipe/project/context.md:65`.

**Q: What's the cleverest part of this boundary?**
The memory round-trip. `createConversationMemory` was extracted *up* from buffr into
aptkit and re-consumed — and it only worked because the engine never names a database,
it takes a `VectorStore` as a parameter. buffr injects `PgVectorStore` down for durable
memory; a test injects in-memory for the same logic.
Anchor: extraction noted at `.aipe/project/context.md:24`; injection at
`src/session.ts:53`; the store-agnostic engine at aptkit `conversation-memory.ts:18-31`.

**Q: What stops this boundary from rotting?**
The hard published-package line. buffr *cannot* edit aptkit, so it can't special-case
Postgres inside the pipeline — it must conform to the contract or extract a new one up.
The friction is the feature.
Anchor: `package.json:14` (npm dependency), `.aipe/project/context.md:65`.

## See also

- `01-vector-store-adapter.md` — the contract buffr fills
- `06-retrieval-as-memory.md` — the extracted memory engine in action
- `07-deferred-body.md` — what this boundary absorbs next, with no library change
- `study-software-design` — dependency inversion, deep modules, information hiding
