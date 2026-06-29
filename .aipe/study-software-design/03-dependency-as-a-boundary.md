# Dependency as a boundary — depending on aptkit's contracts, extracting memory up

**Industry names:** dependency inversion (DIP) · dependency injection (DI)
· the library boundary · "extract up." **Type:** Industry standard.

buffr's most important architectural decision isn't a file — it's a *rule*:
aptkit is consumed, never edited (context.md, hard constraint). Everything
in buffr lives below a boundary it doesn't own. This file is about that
boundary: which way the dependency arrow points, how behaviour gets
*injected* across it, and the one case where buffr pushed code *up* across
it (the memory engine).

Role-vocabulary, named once:

- **the contract** — aptkit's exported interfaces: `VectorStore`,
  `RetrievalPipeline`, `CapabilityTraceSink`, the memory engine's
  `{ embedder, store }` shape. The abstractions both sides depend on.
- **the dependency** — `@rlynjb/aptkit-core@0.4.1`, the published bundle
  buffr imports and never edits.
- **dependency injection (DI)** — passing buffr's concrete things *into*
  aptkit's constructors (the store into the pipeline, the trace into the
  agent).
- **dependency inversion (DIP)** — *why* DI works here: buffr depends on
  aptkit's contracts, not aptkit on buffr's classes; the arrow points at
  the abstraction.
- **extract up** — moving `createConversationMemory` *out of* buffr and
  *into* aptkit, then re-consuming it across the boundary.

---

## Zoom out, then zoom in

The boundary is the package edge. aptkit is above it (policy: the agent
loop, the pipeline, the memory engine); buffr is below it (detail: the
Postgres store, the trace sink). The arrow points *up*.

```
  Zoom out — the library boundary, arrow pointing up

  ┌─ aptkit @0.4.1 (above the line — NEVER edited here) ─────────┐
  │  RagQueryAgent · RetrievalPipeline · createConversationMemory │
  │  exports the CONTRACTS:                                       │
  │    VectorStore · CapabilityTraceSink · {embedder, store}      │
  └───────────────────────────▲──────────────────────────────────┘
        depends on the contract│ (DIP: arrow points UP at aptkit)
  ┌─ buffr (below the line — the detail) ──│──────────────────────┐
  │  ★ injects its concrete things UP ★                          │ ← here
  │    PgVectorStore ──► pipeline      (DI: store passed in)      │
  │    SupabaseTraceSink ──► agent     (DI: trace passed in)      │
  │    PgVectorStore ──► memory engine (DI: store passed in)      │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the inversion is that buffr — the lower-level, detail-heavy code
— depends on aptkit's abstractions, while aptkit depends on *nothing* of
buffr's. buffr's concrete classes flow *up* into aptkit's constructors as
arguments (that's DI), but the *type* dependency points down-to-up (that's
DIP). The package edge is the one boundary buffr can't refactor across, so
it's the one worth understanding first.

---

## The structure pass

**Layers:** aptkit (policy) · the contract (the package's exported types)
· buffr's adapters (detail).

**The axis: which direction does the dependency point?** This is the
defining axis for this pattern — trace it across the package edge:

```
  axis traced = "who depends on whom?"

  ┌─ aptkit ──────┐   package edge   ┌─ buffr ───────┐
  │ depends on    │ ═══════╪═══════► │ depends on    │
  │ NOTHING of    │  arrow points    │ aptkit's      │
  │ buffr's       │  UP (inverted)   │ contracts     │
  └───────────────┘                  └───────────────┘
       ▲                                    │
       └──── buffr's classes flow up as ARGUMENTS (DI) ──┘
            but the TYPE dependency points up (DIP)
```

The subtle part: **data flows up** (buffr's `PgVectorStore` instance
becomes an argument to aptkit's pipeline) while **the type dependency also
points up** (buffr's file `import`s aptkit's `VectorStore`, never the
reverse). DI is the runtime mechanism; DIP is the compile-time direction.
The seam is the package boundary, and it's load-bearing precisely because
buffr can't edit the other side — every interaction has to go through the
contract.

---

## How it works

### Move 1 — the mental model

You know this from React: a component takes a render-prop or a callback as
a prop. The parent doesn't reach *into* the child; it *injects* behaviour
the child calls. `<List renderRow={fn}>` — `List` depends on the *shape*
of `renderRow`, not on your specific function. buffr does the same to
aptkit: it injects a `VectorStore`, and aptkit's pipeline calls it without
knowing it's Postgres.

In one sentence: **buffr depends on aptkit's contracts and injects its own
implementations up into them — so the high-level library never depends on
the low-level detail.**

```
  Dependency inversion + injection

   buffr (low-level)            aptkit (high-level)
   ┌──────────────┐             ┌──────────────────┐
   │ PgVectorStore│──injected──►│ createRetrieval  │
   │ (concrete)   │   (DI)      │ Pipeline({store})│
   └──────────────┘             └──────────────────┘
          │                              │
          └── type-depends on ───────────┘
              aptkit's VectorStore (DIP, arrow up)
```

### Move 2 — the walkthrough

**1. Injection — buffr's concrete things passed up into aptkit.** Every
aptkit constructor that needs a capability gets buffr's implementation as
an argument. Three injections, all in `session.ts`:

```ts
// session.ts:41-42  — the store injected into the pipeline
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });   // ← DI: buffr's store, up into aptkit

// session.ts:57  — the trace sink injected into the agent
const agent = new RagQueryAgent({ model, tools, profile, trace });  // ← DI: buffr's trace, up

// session.ts:53  — the store injected into the memory engine
const memory = createConversationMemory({ embedder, store });    // ← DI: same store, up
```

Notice aptkit's constructors take *contracts*: `createRetrievalPipeline`
wants something shaped like `VectorStore`; it gets buffr's `PgVectorStore`.
buffr satisfies the contract structurally and hands the instance up. aptkit
never imports `PgVectorStore` — it can't, it doesn't know buffr exists.

**2. Inversion — the arrow points up, enforced by the package edge.** The
`import` in `pg-vector-store.ts:2` is the proof:

```ts
// pg-vector-store.ts:1-2
import pg from 'pg';
import type { VectorStore } from '@rlynjb/aptkit-core';   // ← buffr depends on aptkit's contract
export class PgVectorStore implements VectorStore { ... }  // ← satisfies it, doesn't extend it
```

buffr `implements` aptkit's interface. The dependency points from buffr up
to aptkit. There is no reverse import — aptkit's published bundle has no
line that says `import { PgVectorStore }`. That asymmetry is DIP made
physical by the package boundary: you literally cannot make aptkit depend
on buffr without editing aptkit, which the hard constraint forbids.

**3. Extract up — the memory engine that moved across the boundary.** This
is the most interesting move. `createConversationMemory` *used to live in
buffr* and was extracted *up* into aptkit (context.md), then re-consumed:

```
  Extract up — the memory engine's journey across the boundary

  BEFORE                          AFTER
  ┌─ aptkit ──────┐               ┌─ aptkit ──────────────────┐
  │  (no memory)  │               │  createConversationMemory │ ← moved UP
  └───────────────┘               └────────────▲──────────────┘
  ┌─ buffr ───────┐               ┌─ buffr ─────│──────────────┐
  │ conversation  │   extract     │  imports it │              │
  │ memory engine │ ════════════► │  injects PgVectorStore ───►│
  └───────────────┘    UP         └────────────────────────────┘
```

```ts
// session.ts:5, 53  — re-consumed across the boundary
import { ..., createConversationMemory } from '@rlynjb/aptkit-core';
// ...
const memory = createConversationMemory({ embedder, store });  // engine is aptkit's; store is buffr's
```

Why extract up? Because the memory *engine* (embed an exchange, tag it
`kind=memory`, recall it) is general — every aptkit consumer wants it — but
the *store* it runs against is buffr-specific. So the reusable engine moves
up to the library; the specific store stays down and gets injected. The
comment at `session.ts:50-52` names exactly this: "The engine (embed, tag,
recall) is aptkit's; buffr injects the PgVectorStore."

This is the inverse of leakage: instead of buffr re-implementing memory and
drifting from aptkit, the shared logic lives in one place above the line,
and buffr supplies only the part that's genuinely its own.

**4. The payoff — memory rides the same store, no second system.** Because
the memory engine takes buffr's `store`, memory chunks land in the *same*
`agents.chunks` table (tagged `kind=memory`), and resurface through the
*same* `search_knowledge_base` tool. The dropped FK (audit lens 3, "not a
leak") is what allows it: memory chunks have no `documents` row. One store,
two kinds of content, zero duplicated retrieval code.

### Move 3 — the principle

The direction of a dependency is a design decision, not an accident. Point
it the wrong way — make the library depend on your app — and you can't
reuse the library, can't test it in isolation, can't upgrade it without
breaking yourself. Point it the right way — your detail depends on the
library's abstraction — and you get injection (swap implementations),
isolation (test each side alone), and *extract-up* (move shared logic to
the library, keep specifics local). buffr's hard rule — "aptkit is
consumed, never edited" — isn't a limitation; it's the constraint that
forces every interaction through a contract, which is exactly what makes
the boundary clean. **Depend on abstractions; inject implementations;
extract the reusable part up.**

---

## Primary diagram

```
  The library boundary — DIP + DI + extract-up, full recap

  ┌─ aptkit @0.4.1 (policy, above the line) ─────────────────────┐
  │  RagQueryAgent({model, tools, profile, trace})               │
  │  createRetrievalPipeline({embedder, store})                  │
  │  createConversationMemory({embedder, store})  ← extracted UP  │
  │  CONTRACTS: VectorStore · CapabilityTraceSink                 │
  └──▲────────────▲───────────────▲──────────────────────────────┘
     │ DI         │ DI            │ DI         (data flows UP as args)
     │ trace      │ store         │ store                            │ DIP
  ┌──┴────────────┴───────────────┴──────────────────────────────┐ (types
  │  SupabaseTraceSink   PgVectorStore   (same store)             │  point
  │  ─ buffr (detail, below the line) ─ session.ts wires it all ─ │  UP)
  └───────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Dependency inversion is the "D" in SOLID (Robert Martin): high-level
modules shouldn't depend on low-level modules; both depend on abstractions.
Dependency injection is the delivery mechanism — pass the dependency in
rather than constructing it inside. The two are constantly confused: DIP is
the *direction* of the arrow (depend on the interface); DI is the
*mechanism* (hand the instance in as a parameter). buffr shows both: the
arrow points up at `VectorStore` (DIP), and the instance is passed into the
pipeline constructor (DI).

"Extract up" is less formally named but it's the everyday version of the
Stable Dependencies Principle: code that many things depend on should live
where it's most reusable and most stable — for buffr, that's aptkit. The
memory engine moving up is a small, real instance of a refactor that most
teams do too late: noticing that a chunk of your app code is actually
*library* code and hoisting it across the boundary before it forks.

This is the same port/adapter inversion as `01-adapter-behind-a-contract.md`
seen from the dependency-direction angle rather than the depth angle.

---

## Interview defense

**Q: What's the difference between DI and DIP here?** DIP is the
*direction*: buffr depends on aptkit's `VectorStore` contract, not the
reverse — `pg-vector-store.ts:2` imports the interface; no aptkit file
imports `PgVectorStore`. DI is the *mechanism*: `session.ts:42` passes the
concrete store into aptkit's pipeline constructor as an argument. DIP is
why the design is reusable; DI is how the wiring happens. You can have DI
without DIP (passing a concrete type you depend on directly) — buffr has
both.
*Anchor:* "DIP is the arrow's direction; DI is passing the instance in.
The import statement proves DIP; the constructor argument proves DI."

```
  DIP (direction)              DI (mechanism)
  buffr ──imports──► aptkit    new Pipeline({ store })
  (type dependency up)         (instance passed in)
```

**Q: Why was the memory engine extracted up into aptkit instead of kept in
buffr?** Because the engine is general and the store is specific. Embedding
an exchange, tagging it `kind=memory`, and recalling it is logic every
aptkit consumer wants — keeping it in buffr would mean every other consumer
reimplements it and they drift. The store it runs against is buffr's alone.
So the reusable engine goes up to the library; buffr injects only its
`PgVectorStore`. The result: one retrieval path serves both knowledge and
memory, because memory rides the same store through the same tool.
*Anchor:* "the engine is reusable, the store is specific — hoist the
reusable part up, inject the specific part in."

**Q: What does the 'never edit aptkit' constraint buy you?** It forces
every buffr↔aptkit interaction through a published contract. You can't
reach into aptkit's internals, so you depend only on its interfaces — which
means you can upgrade aptkit (0.4.1 → next) and only the contract has to
hold. It's DIP enforced by a rule instead of by discipline.
*Anchor:* "the constraint turns DIP from a guideline into a hard wall —
you physically can't point the arrow the wrong way."

---

## See also

- `01-adapter-behind-a-contract.md` — the same inversion, depth angle.
- `04-sync-interface-async-work.md` — `CapabilityTraceSink`, another
  aptkit contract buffr implements.
- `05-deep-session-facade.md` — where all the injection wiring happens.
- `audit.md` lens 3 — the dropped FK that lets memory ride the store.
- `study-system-design/03-provider-abstraction.md` — the architecture
  altitude of this boundary.
