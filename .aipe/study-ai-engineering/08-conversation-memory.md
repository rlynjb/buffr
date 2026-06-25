# Conversation memory — RAG over chat history

> Updated: 2026-06-24 — new file. Documents the first-class memory capability added via `@aptkit/memory` (`createConversationMemory`), wired in `src/session.ts`.

**Industry name(s):** Long-term retrieval-based **episodic memory** / RAG over conversation history / semantic conversation memory · Industry-standard pattern (agent memory), wired here via `@aptkit/memory`.

## Zoom out, then zoom in

A one-shot RAG agent forgets everything the moment it answers. Ask it "what editor do I use?" today and "set up that editor's config" tomorrow, and tomorrow's call has no idea what "that editor" means — each question is an island. buffr's `chat` surface fixes the *cross-turn, cross-session* half of that: after every exchange it embeds the question+answer into the vector store, so a future turn can pull the relevant past exchange back by similarity. That's not "save the chat log" — the chat log is already saved for observability. This is making past exchanges **retrievable as knowledge**, through the exact same search tool that retrieves documents.

```
  Zoom out — where memory enters the chat loop

  ┌─ Surface layer (Ink REPL) ───────────────────────────────────┐
  │  chat.tsx → session.ask(question)                            │
  └───────────────────────────┬──────────────────────────────────┘
                              │  question
  ┌─ Session layer (src/session.ts) ──────────────────────────────┐
  │  persist user turn → agent.answer() → flush trace             │
  │  → ★ memory.remember({conversationId, question, answer}) ★    │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │  embed exchange, tag kind=memory
  ┌─ Library layer (@aptkit/memory, bundled in aptkit-core 0.4.1) ┐
  │  createConversationMemory({ embedder, store })                │
  │  remember() = embed → upsert     recall() = embed → search    │
  └───────────────────────────┬──────────────────────────────────┘
                              │  vector + meta
  ┌─ Storage layer (Postgres, agents.chunks) ─────────────────────┐
  │  documents AND memory rows share one vector(768) HNSW index   │
  │  memory rows: id `memory:<convId>:<n>`, meta.kind='memory'    │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: this is the **long-term** half of agent memory — the layer that survives past the end of a single `answer()` call. It answers one question: *given the current query, which of all the past exchanges are worth pulling back into context?* The mechanism is RAG, applied to conversation history instead of documents. The engine lives in aptkit's published `@aptkit/memory` package — extracted *up* out of buffr into the toolkit so any consumer gets it — and buffr's only job is to hand it a store.

## Structure pass

Three layers, one axis: **what does each layer know about the database?**

```
  Axis traced = "who knows it's Postgres?"

  ┌─ session: src/session.ts ──────────┐  knows everything — owns the pool,
  │  builds PgVectorStore + embedder    │  the appId, the conversationId
  └──────────────────┬──────────────────┘
                     │  seam ① — store injected as a VectorStore
  ┌─ engine: @aptkit/memory ───────────┐  knows NOTHING about Postgres —
  │  createConversationMemory(...)      │  speaks only EmbeddingProvider +
  │  embed → upsert / search → filter   │  VectorStore contracts
  └──────────────────┬──────────────────┘
                     │  seam ② — store.upsert / store.search
  ┌─ store: PgVectorStore ─────────────┐  knows it's Postgres again —
  │  insert into agents.chunks ... HNSW │  translates the contract to SQL
  └─────────────────────────────────────┘
```

The axis flips twice, and the middle answer is the lesson. **Seam ①** is where buffr injects a concrete `PgVectorStore` into the engine as an abstract `VectorStore` — the engine never learns it's talking to Postgres. **Seam ②** is where that abstraction becomes SQL again. The load-bearing point: the memory *engine* is store-agnostic, so the identical `remember`/`recall` logic runs over an `InMemoryVectorStore` in tests and pgvector in production. That store-agnostic split is *why* aptkit could extract the engine upward and buffr could keep ownership of the store — the contract is the seam that lets the capability move out of the app and into the toolkit without buffr changing its persistence.

## How it works

Mental model: you already know RAG — embed a query, find the nearest document vectors, stuff them into the prompt. Episodic memory is *that exact pipeline pointed at your own past exchanges instead of documents.* The only twist is that exchanges and documents live in the same drawer, so you tag the exchanges and filter on read.

```
  Episodic memory — RAG, but the corpus is your chat history

   turn N (write):                     turn N+5 (read):
   "I use Neovim" ─┐                    "configure my editor"
                   │ embed                        │ embed
                   ▼                              ▼
            ┌────────────┐                 ┌────────────┐
            │  vector    │                 │  vector    │
            └─────┬──────┘                 └─────┬──────┘
                  │ upsert (tag kind=memory)     │ search top-k
                  ▼                              ▼
         ┌──────────────────── shared vector store ───────────────┐
         │  [doc][doc][memory:c1:0 "I use Neovim"][doc][memory...] │
         └──────────────────────────┬─────────────────────────────┘
                                    │ filter kind=memory, keep k
                                    ▼
                         "Past exchange — user asked: ... Neovim"
                         surfaces alongside doc hits in the tool result
```

### Step 1 — remember: embed the exchange after the turn completes

You know how RAG indexing embeds a document chunk and upserts it? `remember` does the same thing with one exchange. After `agent.answer()` returns and the trace is flushed, the session calls `memory.remember({ conversationId, question, answer })`. The engine formats the pair into one text blob (`Past exchange — user asked: "..." assistant answered: "..."`), embeds it with the *same* `nomic-embed-text` embedder the documents use, and upserts a single row. Boundary condition: it writes *after* the answer is already in the user's hands, and the call is best-effort wrapped — if the embed or upsert throws, it's swallowed. The rule that makes that safe: memory is additive context, never the answer itself, so losing one write degrades future recall slightly but never loses the turn.

```
  remember() — one exchange becomes one memory row

  format({question, answer})  → "Past exchange — user asked: ..."
       │ embed([text])
       ▼
  [0.11, -0.5, ... ] (768-dim, same space as documents)
       │ upsert one chunk:
       ▼
  { id: "memory:<conversationId>:<n>",   ← n from a per-conversation counter
    vector,
    meta: { kind: 'memory', conversationId, text } }   ← tag + payload
```

### Step 2 — the id and the tag: keeping memory distinct in a shared drawer

The single most important design choice is that memory rows live in the *same* store as documents (`agents.chunks`), not a separate table. That's deliberate — it means the existing `search_knowledge_base` tool surfaces memories for free, with zero new wiring. But a shared drawer needs labels. Two of them: the **id** is namespaced `memory:<conversationId>:<n>` (a per-process counter gives each exchange in a conversation a distinct `n`), so memory ids never collide with document chunk ids (`<docId>#<index>`). The **meta.kind = 'memory'** tag is what lets read-time tell a memory row from a document row. Drop the tag and recall can't separate the two; drop the namespaced id and the second exchange in a conversation overwrites the first.

```
  One store, two kinds of row — the tag is the separator

  agents.chunks
  ┌──────────────────────────┬───────────────┬──────────────────┐
  │ id                       │ meta.kind     │ what it is        │
  ├──────────────────────────┼───────────────┼──────────────────┤
  │ notes.md#0               │ (none/doc)    │ document chunk    │
  │ notes.md#1               │ (none/doc)    │ document chunk    │
  │ memory:conv-abc:0        │ 'memory'      │ past exchange     │
  │ memory:conv-abc:1        │ 'memory'      │ past exchange     │
  └──────────────────────────┴───────────────┴──────────────────┘
            ▲                        ▲
            id namespace          read-time filter key
```

### Step 3 — recall: search, then filter (because the contract can't filter)

`recall(query, k)` embeds the query and calls `store.search`. Here's the part everyone trips on: the `VectorStore` contract has *no metadata filter* — `search` returns the k nearest of *everything*, documents and memories mixed. So recall **over-fetches** (`max(k*4, 20)` candidates) and then filters in application code to `meta.kind === 'memory'`, keeping the top `k`. Over-fetch is the load-bearing part: if you fetched exactly `k` and documents dominated the top results, you could filter down to *zero* memories even when relevant ones exist just below the cut. Over-fetching by 4× buys headroom so the memory rows survive the filter.

```
  recall() — over-fetch, then filter (the contract has no filter)

  query "configure my editor"
       │ embed → search(vector, fetchK = max(k*4, 20))
       ▼
  [doc] [memory:c1:0] [doc] [doc] [memory:c1:3] [doc] ...   ← mixed, ranked
       │ keep only meta.kind === 'memory'
       ▼
  [memory:c1:0] [memory:c1:3] ...
       │ slice(0, k)
       ▼
  top-k past exchanges, ranked by similarity to the query
```

### Move 2.5 — current state vs future state

buffr wires `remember` on every turn (`src/session.ts:66`). What it does *not* yet do is call `recall` explicitly and stitch the result into the next prompt — instead memory surfaces *implicitly*, because it shares the store with documents and the agent's own `search_knowledge_base` calls return memory rows alongside doc rows.

```
  Phase A (now): implicit recall via the shared search tool
    remember() writes memory into agents.chunks
    agent calls search_knowledge_base → gets docs + memory rows mixed
    → memory surfaces, but only when the agent chooses to search

  Phase B (not built): explicit recall + in-prompt turn history
    session calls memory.recall() and injects top exchanges directly
    + sequential turn history threaded into the prompt
    → an aptkit-side change to RagQueryAgent.answer(), which today
      treats each question independently (src/session.ts:25)
```

What *doesn't* have to change to get explicit recall: the storage, the engine, the embedder, the store — all of that is already in place. `@aptkit/memory` even ships a `createMemoryTool(memory)` that exposes `recall` as a dedicated tool. The missing piece is purely wiring, not capability.

### Move 3 — the principle

Long-term agent memory is just RAG with the corpus pointed at your own history — and the cleanest version of it speaks only the embedder/store contract, so it's store-agnostic and lives in the toolkit, not the app. The principle generalizes: when a capability depends only on an abstract contract (here, `VectorStore`), it can be extracted *up* out of the application into a shared library, and the application keeps ownership of the concrete thing (the Postgres store) by injecting it across the seam.

## Primary diagram

The full memory path, write and read, across both seams.

```
  buffr conversation memory — full recap

  ┌─ src/session.ts ──────────────────────────────────────────────┐
  │  const memory = createConversationMemory({ embedder, store }) │
  │  ...after each turn:                                          │
  │  await memory.remember({ conversationId, question, answer })  │
  └───────────────────────────┬───────────────────────────────────┘
                              │ seam ① — store injected as VectorStore
  ┌─ @aptkit/memory engine ───▼───────────────────────────────────┐
  │  remember: format → embed([text]) → store.upsert([{           │
  │     id:"memory:<convId>:<n>", vector, meta:{kind,convId,text}}])│
  │  recall:   embed(query) → store.search(v, max(k*4,20))        │
  │            → filter meta.kind==='memory' → slice(0,k)          │
  └───────────────────────────┬───────────────────────────────────┘
                              │ seam ② — VectorStore → SQL
  ┌─ PgVectorStore → agents.chunks ───────────────────────────────┐
  │  documents + memory share vector(768) HNSW cosine index;      │
  │  no documents FK (sql:27) so memory rows need no parent doc   │
  └───────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Runs on every `chat` turn (`src/cli/chat.tsx` → `src/session.ts`). The motivating scenario is cross-session continuity: you tell buffr something in one session, and a relevant question weeks later can pull that exchange back — without you re-stating it, and without buffr threading a giant transcript into every prompt. It's the difference between a stateless Q&A box and an agent that accumulates context about *you* over time. It is *not* the trajectory capture (`SupabaseTraceSink`) — that's observability; this is recallable knowledge.

**Code side by side.**

```
  src/session.ts  (lines 49–53) — wiring the engine

  // Retrievable episodic memory over buffr's own store. The engine (embed, tag,
  // recall) is aptkit's; buffr injects the PgVectorStore. Sharing the document
  // store means memory surfaces via the existing search_knowledge_base tool — and
  // memory chunks live with no documents row, which the dropped FK allows.
  const memory = createConversationMemory({ embedder, store });
       │
       └─ same `embedder` and `store` the documents use → memory lands in the
          identical 768-dim space, recallable through the same search tool
```

```
  src/session.ts  (lines 62–69) — remember, after the answer is safe

  const answer = await agent.answer(question);
  await trace.flush();                              ← observability first
  try {
    await memory.remember({ conversationId, question, answer });
  } catch {
    // swallow: memory is best-effort, the turn already succeeded
  }
       │
       └─ remember runs AFTER the answer exists and is wrapped in try/catch:
          a memory-write failure must never cost the user the answer they have
```

```
  @aptkit/memory conversation-memory.js (recall) — over-fetch then filter

  const fetchK = Math.max(k * 4, 20);              ← over-fetch headroom
  const hits = await store.search(vector, fetchK);
  return hits
    .filter((h) => h.meta?.kind === kind)          ← keep memory rows only
    .slice(0, k)                                    ← top-k
       │
       └─ the VectorStore contract has no metadata filter, so the only way to
          recall memory-only from a shared store is fetch-wide-then-filter.
          fetch exactly k and documents could crowd out every memory row
```

```
  sql/001_agents_schema.sql  (line 27) — the dropped FK that lets memory share the store

  alter table agents.chunks drop constraint if exists chunks_document_id_fkey;
       │
       └─ memory rows have no documents parent. A hard FK would reject every
          memory upsert; dropping it is what makes the shared store possible
```

## Elaborate

Retrieval-based episodic memory is the production shape of "agent memory" as the field actually ships it — the long-term layer in the classic two-layer split (short-term in-context window vs long-term retrieved store). The insight that makes it tractable is that long-term memory is *not* a new subsystem: it's RAG with the corpus swapped from documents to exchanges. That's why `@aptkit/memory` is so small — it reuses the `EmbeddingProvider`/`VectorStore` contracts wholesale and adds only the tag-and-filter discipline on top.

What's deliberately *out* of scope, in the package and therefore here: memory *management* — summarization, fact extraction, consolidation, decay. This is the storage+retrieval half only. A mature memory system eventually needs to compress old exchanges (you can't embed an unbounded history forever), extract durable facts ("user prefers Neovim") from transient chatter, and forget stale ones. None of that exists yet; the package README names it explicitly as the layer above.

This connects directly to three other files: `02-rag-query-path.md` (recall *is* the query path, pointed at memory rows), `07-profile-as-context.md` (the *other* form of durable context — but profile is hand-authored and always-injected, where memory is earned per-exchange and recalled by relevance), and `audit.md`'s Agent memory lens (the honest grade). What to read next: `02-rag-query-path.md`, since recall reuses its exact mechanics.

## Project exercises

> No `aieng-curriculum.md` present; exercises name the buildable target directly. Curriculum lineage: Phase 4 agent memory (C4.5).

### Wire explicit recall into the prompt

- **What to build:** Before `agent.answer()`, call `memory.recall(question, 3)` and inject the top past exchanges into the system prompt (or register `createMemoryTool(memory)` as a second tool), instead of relying on implicit shared-store surfacing.
- **Why it earns its place:** Moves memory from Phase A (implicit, only when the agent searches) to Phase B (deterministic recall every turn) — "I made past exchanges first-class context, not a lucky search hit" is a real memory-design story.
- **Files to touch:** `src/session.ts` (recall + inject before `answer`), optionally register the memory tool in the `InMemoryToolRegistry`.
- **Done when:** a two-turn test proves turn 2 recalls a fact only stated in turn 1, with the agent's search tool stubbed out.
- **Estimated effort:** 1–4hr.

### Isolate memory in a dedicated store

- **What to build:** Pass `createConversationMemory` a *separate* `PgVectorStore` (or a `kind`-scoped table) so memory and documents don't share the corpus, eliminating the over-fetch-and-filter and the injection-surface widening.
- **Why it earns its place:** Demonstrates you understand the shared-store tradeoff — implicit surfacing for free vs. clean isolation — and can choose deliberately. The engine doesn't change; only the injected store does.
- **Files to touch:** `src/session.ts` (second store), `sql/001_agents_schema.sql` (a memory table or kind-partitioned index).
- **Done when:** a document search returns zero memory rows, and `recall` still returns the right exchanges from the dedicated store.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: Your agent "remembers" past conversations — what's actually happening?**

```
  remember: embed(question+answer) → upsert tagged kind=memory
  recall:   embed(query) → search → filter kind=memory → top-k
  = RAG, with the corpus = chat history instead of documents
```

"It's retrieval-based episodic memory — RAG over conversation history. After each turn I embed the exchange and store it tagged `kind=memory` in the same vector store as my documents. On a later turn, a query embeds and searches; the matching past exchanges come back by similarity. The engine speaks only the embedder/store contract, so it's store-agnostic — it lives in the `@aptkit/memory` package and I inject my Postgres store." Anchor: long-term memory is RAG pointed at your own history.

**Q: Memory and documents share one store — what's the catch, and how do you handle it?**

```
  shared store → search returns docs + memory mixed
  contract has NO metadata filter
  → recall over-fetches max(k*4, 20), THEN filters kind=memory, THEN slices k
```

"The `VectorStore` contract can't filter by metadata, so a shared-store recall has to over-fetch and filter in app code. The load-bearing detail people miss: you must over-fetch — if you fetched exactly `k`, documents could occupy every top slot and the filter would return zero memories even when relevant ones exist just below the cut. Over-fetching 4× is the headroom that keeps memory rows alive through the filter." Anchor: no filter in the contract means fetch-wide-then-filter, and the over-fetch is what makes it correct.

## Validate

- **Reconstruct:** Draw the `remember` → `recall` round-trip from memory: format, embed, upsert with tag, then embed-query, over-fetch, filter, slice. (`src/session.ts:53,66`; `@aptkit/memory` `createConversationMemory`)
- **Explain:** Why is `memory.remember` wrapped in try/catch and run *after* `trace.flush()`? (`src/session.ts:63-69`)
- **Apply:** A user states a fact in turn 1 of a session and asks about it in turn 8. Walk the path that surfaces turn 1's exchange. Then name the case where it *wouldn't* surface today. (implicit shared-store recall; Phase A vs B above)
- **Defend:** Memory shares `agents.chunks` with documents instead of a dedicated table. Defend that choice and name what it costs at read time. (the shared-store tradeoff; `sql/001_agents_schema.sql:27` dropped FK; over-fetch in `recall`)

## See also

- `02-rag-query-path.md` — recall reuses this exact query mechanics, pointed at memory rows.
- `07-profile-as-context.md` — the other durable-context form: hand-authored + always-injected vs earned + recalled-by-relevance.
- `03-agent-loop-with-tool-calling.md` — the loop whose `search_knowledge_base` tool surfaces memory implicitly today.
- `audit.md` — the Agent memory lens grade.
- `.aipe/study-system-design/03-trajectory-capture.md` — the *observability* trajectory, a different concern from recallable memory.
