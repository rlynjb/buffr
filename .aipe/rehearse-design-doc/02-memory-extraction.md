# RFC 02 — The @aptkit/memory extraction

**One-line summary.** Conversation memory was built inline in buffr, then
**extracted up** into the published aptkit library as `@aptkit/memory` — the
engine (embed an exchange, tag it, recall by similarity) lives in the library
over the `EmbeddingProvider`/`VectorStore` contracts; the store is still
injected by buffr. Memory logic became reusable; the database stayed the app's.

**Status:** Shipped. `@aptkit/memory` is published; buffr consumes it via the
`@rlynjb/aptkit-core` bundle.
**Cited to:** `packages/memory/src/conversation-memory.ts` (aptkit repo),
`src/session.ts`, `.aipe/project/context.md`.
**Reads after:** RFC 01 — this RFC leans on the same contracts that one
introduced.

---

## 1. Context / problem

buffr needed episodic memory: after each turn, remember the exchange so a future
turn (even in a later session) can surface the relevant ones. The mechanism is
RAG over conversation history — embed the exchange, store the vector, recall by
similarity. buffr already had everything that needs: an embedder, a vector
store, the cosine search.

So the first version was built **inline in buffr**. That works. But it raises a
boundary question the moment you look at the code: *none of that logic is about
buffr.* "Embed an exchange, tag it `kind=memory`, over-fetch and filter on
recall" is generic agent-memory logic. It names no database, no app, nothing
specific to a single-device laptop brain. It only speaks two contracts —
`EmbeddingProvider` and `VectorStore` — both of which already live in aptkit.

The forcing constraint: aptkit is the **deployment-agnostic toolkit**; buffr is
**the body** (`agent-layer-plan.md` repo-split). aptkit already holds the
provider contracts, the agent loop, the retrieval pipeline. Generic memory logic
sitting in the app's repo violates that split — it's library code wearing an
app's clothes. The decision: does it move up, and if so, where exactly is the
cut?

```
  Where the decision sits — the repo boundary it moves across

  ┌─ aptkit (the toolkit, reusable, deployment-agnostic) ───────┐
  │  EmbeddingProvider · VectorStore · RagQueryAgent            │
  │  ★ @aptkit/memory (NEW — the engine moves HERE) ★           │ ← we are here
  │     createConversationMemory(embedder, store)               │
  └───────────────────────────┬──────────────────────────────────┘
                              │  published; consumed as a dependency
  ┌─ buffr (the body, single-device, app-specific) ──▼───────────┐
  │  injects the PgVectorStore + OllamaEmbeddingProvider         │
  │  memory.remember({ conversationId, question, answer })       │
  └──────────────────────────────────────────────────────────────┘
```

The arrow points *down*: the library doesn't depend on the app; the app depends
on the library and injects the concrete store. That's dependency inversion
across a repo boundary — and getting the cut right is the whole RFC.

---

## 2. Goals & non-goals

**Goals.**
- The reusable engine lives in the library (`@aptkit/memory`), buildable and
  testable on its own with an in-memory store.
- buffr keeps owning the store — it injects `PgVectorStore`; the engine never
  names a database (`conversation-memory.ts:48-60`).
- Memory works whether it shares the document store or uses a dedicated one —
  the caller decides, the engine doesn't care
  (`conversation-memory.ts:19-26`).
- A clean public API: `remember(turn)` / `recall(query, k)`, plus an optional
  `search_memory` tool for the dedicated-store case.

**Non-goals — stated to keep the cut honest.**
- **No memory *management* in the engine.** Summarization, fact extraction,
  consolidation, decay are explicitly out of scope — this is the storage +
  retrieval half only (`packages/memory/README.md`). Pulling those in would
  bloat the library with policy that belongs in the app.
- **No database in the library.** `@aptkit/memory` depends on
  `@aptkit/retrieval` and `@aptkit/tools` — never on `pg`
  (`packages/memory/package.json`). The moment it imports `pg` the extraction
  failed.
- **No assumption about store sharing.** The engine must not assume memory is
  isolated *or* mixed — buffr happens to share the document store, but the
  library can't bake that in.

---

## 3. The decision

Cut the boundary at the contracts. The **engine** (the logic) moves up into
`@aptkit/memory`; the **store** (the concrete adapter) stays injected by buffr.
The library depends only on `EmbeddingProvider` and `VectorStore`, so it speaks
contracts and names no database.

```
  The chosen design — engine in library, store injected by app

  buffr/src/session.ts
     │  createConversationMemory({ embedder, store })   ← injects the PgVectorStore
     ▼
  ┌─ @aptkit/memory (the engine, library) ──────────────────────┐
  │  remember(turn):                                            │
  │    text   = format(turn)                                    │
  │    vector = embedder.embed([text])                          │
  │    store.upsert([{ id:"memory:<conv>:<n>", vector,          │
  │                    meta:{ kind:"memory", text } }])          │
  │                                                             │
  │  recall(query, k):                                          │
  │    vector = embedder.embed([query])                         │
  │    hits   = store.search(vector, k*4)   ← OVER-FETCH        │
  │    return hits.filter(h => h.meta.kind === "memory")        │
  │                       .slice(0, k)       ← then FILTER      │
  └────────────────────────────┬────────────────────────────────┘
                               │  store is whatever the app passed
  ┌─ buffr PgVectorStore (the adapter) ▼─────────────────────────┐
  │  same agents.chunks table the documents use                 │
  └──────────────────────────────────────────────────────────────┘
```

Three load-bearing details:

**The store is a constructor parameter, never a hard-coded import.** The engine
takes `{ embedder, store }` and uses them — it could be a `PgVectorStore` for
durable memory or an `InMemoryVectorStore` for tests, and the logic is identical
(`conversation-memory.ts:62-63`). That's the injection seam. It's also why the
library can be tested with no database at all.

**Recall over-fetches then filters, because the contract has no metadata
filter.** When memory shares the document store, a search can return documents
ranked above memory rows. The `VectorStore.search` contract is just
`(vector, k) → hits` — no `where kind = 'memory'`. So recall fetches
`max(k*4, 20)`, filters to `meta.kind === 'memory'`, then slices to `k`
(`conversation-memory.ts:96-103`). The over-fetch is the price of keeping the
contract narrow — adding a filter param to `VectorStore` would complicate every
adapter for one consumer's benefit.

**buffr injects the shared document store.** In `src/session.ts:53`, buffr
passes the *same* `PgVectorStore` the documents use. So memory rides
`agents.chunks` tagged `kind=memory`, and surfaces through the existing
`search_knowledge_base` tool — no separate retrieval path
(`src/session.ts:48-53`). This is where RFC 01's dropped FK pays off: memory
chunks have no `documents` row, which the soft link allows.

---

## 4. Alternatives considered

Three real options. The cut could have landed in three different places.

**A — Keep it inline in buffr.** The version that already worked. It loses on the
repo-split: generic memory logic in the app's repo means the *next* app (the
phone brain, blooming) re-implements it or copy-pastes from buffr. The logic
names no database and no app — leaving it in buffr is leaving reusable code
stranded in one consumer. The cost of extracting is real (a published package,
versioning, a public API to maintain), but it's paid once; re-implementing is
paid per app.

**B — Move the whole thing, store included, into the library.** Put a
`PgVectorStore` inside `@aptkit/memory` so memory is turnkey. It loses hard: it
would make `@aptkit/memory` depend on `pg` and on Postgres, turning the
deployment-agnostic toolkit into "the Postgres memory library." That's the exact
failure the repo-split exists to prevent — the library would stop being reusable
across stores. The whole reason memory *can* extract cleanly is that it speaks
contracts; baking in a store throws that away.

**C — Extract the engine but ship its own `search_memory` tool as the only
recall path.** Force memory into a dedicated store with an explicit tool. It
loses for buffr specifically: buffr shares the document store, so memory already
surfaces via `search_knowledge_base` — a second tool is redundant. But it's not
wrong in general, so the library ships `createMemoryTool` as an *option* for the
dedicated-store case (`packages/memory/src/memory-tool.ts`), and buffr just
doesn't use it. The decision wasn't "tool or no tool" — it was "don't *force* a
tool."

```
  Why each cut lost — the deciding axis is "what does the library depend on?"

  option                  library depends on...        reusable?
  ─────────────────────   ──────────────────────────   ─────────
  A  inline in buffr      n/a — not in the library     NO (stranded)
  B  store in library     pg + Postgres                NO (store-locked)
  C  forced memory tool   contracts (ok) but rigid     yes, but inflexible
  ★  engine over          EmbeddingProvider +          YES — store-agnostic
     contracts, store        VectorStore only
     injected
```

The deciding axis is **what the library is allowed to depend on**. Only the
chosen cut keeps the dependency at the contracts — store-agnostic, database-free.

---

## 5. Tradeoffs accepted

**We accept a published-API maintenance burden.** Extracting up means
`@aptkit/memory` now has a public surface (`remember`, `recall`,
`createMemoryTool`, the `MemoryTurn`/`MemoryHit` types) that consumers depend on.
Changing it is a breaking change with a version bump, not a local edit. We accept
that because the alternative — re-implementing memory in every app — is worse,
and because the surface is small and stable (`conversation-memory.ts:28-40`).

**We accept the over-fetch cost on recall.** Sharing the document store means
recall fetches `4×` and filters in application code rather than in the query
(`conversation-memory.ts:98`). For a single-device corpus that's a few extra
rows scanned — free. At scale it's a cost the dedicated-store option (C) would
avoid. We accept it to keep the `VectorStore` contract narrow; a metadata filter
on the contract would burden every adapter, not just this one.

**We accept that the engine holds per-conversation counters in memory.** Ids are
`memory:<conversationId>:<n>` where `n` is an in-process counter
(`conversation-memory.ts:64-89`). A process restart resets the counter — fine,
because `conversationId` is unique per conversation, so ids never collide across
conversations even across restarts. The tradeoff: within a single long-lived
process the counter is the dedup key; if two engine instances wrote the same
conversation concurrently they could collide. buffr has one engine per session,
so this doesn't bite — but it's a real constraint, named not hidden.

---

## 6. Risks & mitigations

```
  Risk register — what breaks, what guards it

  risk                          blast radius        mitigation
  ───────────────────────────   ─────────────────   ─────────────────────────
  dimension mismatch            recall returns       constructor throws if
   (embedder ≠ store dim)        nonsense / errors    embedder.dim != store.dim
                                                     (conversation-memory.ts:64)
  memory pollutes document      a memory row ranks   kind=memory tag + recall
   search                        above a real doc     filters; document search
                                 in an answer         tool sees both by design
                                                     (the shared-store choice)
  best-effort write loss        an exchange isn't    remember() is wrapped in
   (memory write throws)         remembered           try/catch in buffr — the
                                                     turn already succeeded
                                                     (src/session.ts:64-69)
  public API drift              consumers break on   small, stable surface;
                                 a library change     semver discipline
```

The one worth flagging is **best-effort write loss**. buffr calls
`memory.remember(...)` inside a try/catch and swallows failures
(`src/session.ts:64-69`) — a memory-write failure must not lose the answer the
user already has. The mitigation *is* the design: memory is best-effort by
construction. The cost is a silently-unremembered exchange, which is the right
call — losing a memory write is recoverable (re-ask), losing the answer isn't.

---

## 7. Rollout / migration

**The extraction is invisible to buffr's call site.** buffr already called
`createConversationMemory({ embedder, store })`; after extraction it imports the
same factory from the published bundle instead of a local file
(`src/session.ts:5-6, 53`). The wiring didn't change — only where the symbol
resolves from. That's the cleanest possible extraction: the consumer's code is
identical before and after.

**No data migration.** Memory rows were already `agents.chunks` tagged
`kind=memory` with id `memory:<conv>:<n>`. The engine moving repos doesn't touch
the row format — the same ids, the same tag, the same table
(`.aipe/project/context.md:43-46`). Existing memory rows are read by the
extracted engine unchanged.

**The library ships testable in isolation.** `@aptkit/memory` builds and tests
against an `InMemoryVectorStore` with no database (`packages/memory/package.json`
test script). That's the proof the cut is clean: if the engine needed Postgres
to test, it wasn't really store-agnostic.

```
  Rollout — what changed for whom

  ┌─ aptkit library ────────────┐  changes: NEW package @aptkit/memory
  │  engine moves up            │  depends only on retrieval + tools contracts
  └─────────────────────────────┘

  ┌─ buffr call site ───────────┐  changes: import path only
  │  same createConversationMem │  was: local file → now: published bundle
  └─────────────────────────────┘  (src/session.ts:5)

  ┌─ memory rows in agents.chunks ┐ changes: NOTHING
  │  same id, same kind=memory    │ extracted engine reads them unchanged
  └───────────────────────────────┘
```

---

## 8. Open questions

**Memory management is unbuilt — and intentionally so.** Summarization, fact
extraction, consolidation, decay are out of scope and layered on top later
(`packages/memory/README.md`). The open question is *where* that layer lives: in
the library (another `@aptkit/*` package, store-agnostic again) or in the app
(buffr-specific policy). The extraction's clean contract boundary means either
can be built without touching the engine — but the decision isn't made.

**Cross-session counter durability.** The per-conversation counter is in-process
(`conversation-memory.ts:64-89`). It's correct today because one engine per
session and unique conversation ids. Open: if the body grows two brains writing
the same memory plane (the two-brain RFC, deferred in RFC 01 §8), the in-memory
counter is no longer a safe dedup key — id generation would need to be
derived from the store, not a process-local count. Named here because it's the
seam where the two-brain sync problem first touches *this* code.

**Sequential in-prompt turn history.** Still missing — `RagQueryAgent.answer()`
treats each question independently (`src/session.ts:24-27`). Retrieval-based
recall gives relevance-based memory without it, but true conversational
continuity (the last N turns in the prompt) is an aptkit-side change, not a buffr
one. Open question: does it live in the agent loop or as another memory mode.

---

## Coach notes — where a reviewer pushes

- **"Why extract it at all? It worked inline."** Lead with the repo-split, not
  the code smell: "aptkit is the reusable toolkit, buffr is one body — generic
  memory logic in the app means the next app re-implements it." The reuse
  argument lands; the aesthetics argument doesn't.
- **"Why not put the store in the library so it's turnkey?"** This is the
  strongest pushback — have alternative B loaded: "the moment `@aptkit/memory`
  imports `pg`, it stops being store-agnostic and becomes the Postgres memory
  library. The whole reason it *can* extract cleanly is that it speaks
  contracts." Naming the failure mode of the easy option is what wins it.
- **"The over-fetch on recall is wasteful."** Concede it's a cost, then name the
  buy: "I traded a 4× over-fetch for a narrow `VectorStore` contract — a metadata
  filter on the contract would burden every adapter for one consumer." The
  tradeoff is between two real things; say which you optimized for.
- **The sentence that gets the yes:** "The engine speaks two contracts and names
  no database, so it tests with an in-memory store and runs with Postgres —
  identical logic." That's the proof the cut is clean: store-agnostic isn't a
  claim, it's demonstrated by the test setup.

---

→ Prior: `01-pgvector-graduation.md` introduced the `VectorStore` /
`EmbeddingProvider` contracts this RFC depends on, and the dropped FK that lets
memory rows live with no `documents` row.
→ Comprehension-side walks:
`.aipe/study-system-design/04-library-as-dependency-boundary.md`,
`.aipe/study-software-design/03-dependency-as-a-boundary.md`.
