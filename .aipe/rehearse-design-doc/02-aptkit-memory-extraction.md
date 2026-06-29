# DOC 02 — The @aptkit/memory Extraction

**Decision (one line):** Conversation memory was built **inline in buffr**, then
**extracted up** into the published aptkit library — `createConversationMemory`
over the `EmbeddingProvider` / `VectorStore` contracts — so the *engine* (embed,
tag, recall) lives in aptkit and is store-agnostic, while buffr only *injects*
its `PgVectorStore`. A decision about which side of the library boundary a piece
of logic belongs on.

*Source: `agent-layer-plan.md` (the repo-split thesis); `context.md` ("The
conversation-memory engine was extracted *up* from buffr into aptkit");
engine at `aptkit/packages/memory/src/conversation-memory.ts`; consumed in
`src/session.ts:53`.*

---

## 2. Context / problem

buffr needed the agent to remember past conversations across sessions — not just
the indexed corpus, but "what did the user and I talk about last time." The first
working version was built *inline in buffr*: embed each exchange, store it, recall
the relevant ones next turn.

Then the question that makes this an RFC: **does this logic belong in buffr, or in
aptkit?** buffr is the body — one specific deployment (laptop, Supabase, Gemma).
aptkit is the deployment-agnostic toolkit that other apps (`blooming`, `contrl`)
also consume. If conversation memory is a *buffr feature*, it stays inline and
every other app reinvents it. If it's a *toolkit capability*, it moves up — and
the only thing buffr-specific about it has to be cleanly separable.

Look at the inline implementation and the answer is clear: the memory logic names
no database. It embeds text, upserts a tagged row, and recalls by similarity. The
*only* buffr-specific part is *which* `VectorStore` the rows land in. That
separability is the whole case for extraction.

---

## 3. Goals & non-goals

**Goals**

- The memory **engine** lives in aptkit and is reusable by any app that has an
  `EmbeddingProvider` + a `VectorStore`.
- The engine **never names a database.** It speaks only the two contracts.
- buffr's contribution shrinks to **injection** — pass `PgVectorStore` for
  durable memory; pass `InMemoryVectorStore` in tests; the logic is identical.
- Extraction is **non-breaking** for buffr — the consuming call site stays a
  one-liner.

**Non-goals**

- **Not in-prompt sequential turn history.** `RagQueryAgent.answer()` still
  treats each question independently. This is *retrieval-based* memory
  (relevance, not recency) — and that gap is an aptkit-side change, named in
  `src/session.ts:25-27`, not papered over here.
- **Not buffr owning the engine.** The whole point is that buffr stops owning it.
- **Not a metadata-filtered store.** The `VectorStore` contract has no metadata
  filter, so the engine over-fetches and filters in app code — a deliberate
  consequence of keeping the contract minimal (see Tradeoffs).

---

## 4. The decision

Draw the boundary so the **engine is in aptkit** and the **store is injected by
buffr**. The two contracts are the seam; everything reusable sits above it,
everything deployment-specific sits below.

```
  The extraction — engine up, store down, contracts as the seam

  ┌─ aptkit (published library — @aptkit/memory) ──────────────────┐
  │  createConversationMemory({ embedder, store })                 │
  │    remember(turn)  → embed → upsert tagged kind='memory'       │
  │    recall(query,k) → embed → search → filter kind → top-k      │
  │  packages/memory/src/conversation-memory.ts                    │
  │  KNOWS: the two contracts.   NAMES: no database, ever.         │
  └───────────────┬───────────────────────────┬────────────────────┘
                  │ EmbeddingProvider          │ VectorStore
                  │ (embed: text → vector)     │ (upsert / search / dimension)
  ┌─ buffr (the body — injects the store) ─────▼────────────────────┐
  │  const memory = createConversationMemory({ embedder, store });  │
  │  src/session.ts:53   — buffr passes its OllamaEmbeddingProvider │
  │                        and its PgVectorStore. That's all it adds.│
  └─────────────────────────────────────────────────────────────────┘
```

**The load-bearing property: the engine is injected, not coupled.** Read the
extracted code and it proves itself — `createConversationMemory` takes
`{ embedder, store }` and the doc comment is explicit: *"The store is injected:
the engine never names a database. Pass a `PgVectorStore` for durable memory, an
`InMemoryVectorStore` for tests — the logic is identical"*
(`conversation-memory.ts:48-59`). That sentence is the dependency-boundary
decision, written into the engine itself.

**What buffr keeps:** exactly one line of wiring. `src/session.ts:53` constructs
the memory with buffr's embedder and store, and `ask()` calls
`memory.remember({ conversationId, question, answer })` after each turn
(`src/session.ts:65`). buffr owns the *deployment* (which store, which embedder,
when to remember). aptkit owns the *engine* (how to remember).

**The self-similarity worth naming:** this is the *same* boundary move as DOC 01.
There, `VectorStore` let the persistent store drop into the agent. Here, the same
two contracts let the memory engine move up into the library. The contract that
made persistence swappable is the contract that made memory extractable. One
seam, two payoffs.

---

## 5. Alternatives considered

**Alternative A — keep memory inline in buffr.**
Less moving — no library release, no published surface. *Why it lost:* every
other app that consumes aptkit (`blooming`, `contrl`) would reinvent
conversation memory, and each reinvention drifts. The logic is genuinely
deployment-agnostic — it names no database — so keeping it in the body is
mislocating it. You'd be hiding a reusable capability inside one consumer.

**Alternative B — put memory in buffr, expose it back to aptkit via a plugin
hook.**
A middle path — buffr owns it but other apps can borrow it. *Why it lost:* it
inverts the dependency. aptkit is the *dependency*; buffr is the *dependent*.
Having the library reach back into a consumer for core logic is a circular
boundary — the toolkit would now depend on the body. The clean direction is
engine-up.

**Alternative C — extract the engine but let it take a database connection
directly.**
Simpler call site, maybe. *Why it lost:* it would re-couple the engine to
Postgres, defeating the extraction. The engine would name a database, tests
couldn't use an in-memory store, and `blooming` (if it used a different store)
couldn't consume it. Injecting the `VectorStore` contract is what keeps the
engine deployment-agnostic — that's the non-negotiable that makes extraction
worth doing.

---

## 6. Tradeoffs accepted

- **We chose engine-in-aptkit, accepting a published surface to maintain.**
  `createConversationMemory` is now a library API with a contract other apps
  depend on. Changing its signature is a breaking change for consumers. We took
  that cost because the logic is reusable and the alternative is N drifting
  copies.
- **We chose the minimal `VectorStore` contract (no metadata filter), accepting
  over-fetch-then-filter in the engine.** Because the store can't filter by
  `kind`, `recall` fetches `max(k*4, 20)` hits and filters to memory rows in app
  code (`conversation-memory.ts:89-95`). That's wasted fetch on a shared store —
  the deliberate price of *not* widening the contract every store must implement.
- **We chose retrieval-based memory, accepting no sequential turn history.**
  Memory surfaces by *relevance*, not *recency*. The agent can recall a relevant
  exchange from three sessions ago but doesn't carry the last three turns
  in-prompt. That's an aptkit-side gap, named honestly in `session.ts:25-27`,
  not hidden.

---

## 7. Risks & mitigations

```
  Risk → mitigation

  embedder/store dimension   → the engine throws at construction if
   drift after extraction       embedder.dimension != store.dimension
                                (conversation-memory.ts:62-65). Mismatch
                                fails loud at wire-up, not at recall.

  a memory-write failure      → remember() is wrapped best-effort in buffr's
   loses the user's answer       ask(): the turn already succeeded, so a
                                 memory failure is swallowed, not propagated
                                 (session.ts:66-69). The answer the user has
                                 is never lost to a memory bug.

  memory rows pollute corpus  → rows are tagged meta.kind='memory' with id
   search                        namespace 'memory:<conv>:<n>'; recall filters
                                 to that kind. They coexist with documents in
                                 the same store without contaminating doc
                                 retrieval.

  breaking the published API  → the engine's surface is two methods over two
                                 contracts. Keeping it that narrow is the
                                 mitigation — small surface, small blast radius.
```

---

## 8. Rollout / migration

- **The extraction itself** moved the engine from buffr into aptkit's
  `packages/memory`; buffr re-consumes it via the `@rlynjb/aptkit-core` bundle
  (`context.md`, Stack). buffr's call site stayed a one-liner — the migration
  for buffr was deleting the inline copy and importing the published one.
- **For buffr:** memory rows ride the *same* `chunks` table tagged
  `kind='memory'` — so no new table, no new migration. They surface through the
  existing `search_knowledge_base` tool.
- **For other apps:** `blooming`/`contrl` now *can* consume conversation memory
  by injecting their own `VectorStore` — but nothing forces them to. The
  extraction is additive to the library, breaking to nobody.
- **The dependency rule that gates this:** buffr imports `@rlynjb/aptkit-core`;
  it never edits aptkit (`context.md`, "Must-not-change constraints"). The
  extraction respects the arrow — logic flowed *up* into the dependency, and
  buffr consumes it back down.

---

## 9. Open questions

- **Sequential turn history.** Retrieval-based recall gives relevance, not
  recency. In-prompt turn history is an aptkit-side change to
  `RagQueryAgent.answer()` — still open whether it lives in the agent or as a
  second memory mode.
- **Memory eviction / TTL.** Memory rows accumulate in `chunks` unbounded, same
  retention question as the trajectory tables. Undecided.
- **Per-conversation id counters live in process memory** (`counters` Map,
  `conversation-memory.ts:71`). Across a process restart the counter resets to
  0 — fine because `conversationId` is unique per conversation, so ids never
  collide. Worth a second look if conversation ids ever get reused.

---

## Coach notes — where a reviewer pushes, and the framing that holds

- **"Why extract it at all — premature abstraction?"** The test for premature is
  "is there a second consumer, and is the logic actually generic?" Both yes:
  other apps consume aptkit, and the engine names no database. "I extracted it
  *because* it named no database — that's the signal it belonged in the library,
  not the body." Extraction driven by an observed property, not a guess, is the
  opposite of premature.
- **"Over-fetch-then-filter is wasteful."** Own it: "it is — it's the price of
  keeping the `VectorStore` contract minimal so every store stays cheap to
  implement. Widening the contract to push the filter down is the alternative,
  and I didn't think one feature justified taxing every store." Tradeoff named,
  decision held.
- **The sentence that gets the yes:** *"The engine names no database; buffr only
  injects the store. That's how I knew it belonged up in aptkit, not down in the
  body."* Lead with the property that drove the boundary.

---

## See also

- DOC 01 — the `PgVectorStore` and `VectorStore` contract this engine is
  injected with.
- DOC 03 — the dropped FK that lets `kind='memory'` rows live in `chunks` with
  no `documents` row.
- `.aipe/study-system-design/02-library-as-dependency-boundary.md`,
  `06-retrieval-as-memory.md`;
  `.aipe/study-software-design/03-dependency-as-a-boundary.md`.
