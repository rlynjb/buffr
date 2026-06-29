# Agent Memory Tiers

*Industry names: **agent memory** / **the memory hierarchy** / **working vs episodic vs
long-term**. Type label: Industry standard (the three tiers are universal; buffr's
shared-store episodic memory is Project-specific). IMPLEMENTED in buffr (partially).*

## Zoom out, then zoom in

An agent has three kinds of memory, distinguished by *how long they last* and *how they're
recalled*. buffr ships two of the three, and the one it ships across sessions has a sharp,
load-bearing limitation this file exists to make honest.

```
  buffr's stack — memory spans construction, the loop, and storage

  ┌─ Session — src/session.ts ─────────────────────────────────────┐
  │  createConversationMemory(:53) · memory.remember(...)(:66)     │
  └──────────────────────────┬─────────────────────────────────────┘
  ┌─ ★ AGENT MEMORY — what it REMEMBERS ★ ────────────▼────────────┐
  │  working   = the messages array  (in-context, gone @ return)   │
  │  episodic  = past exchanges, recalled by relevance  ★ buffr ★  │
  │  long-term = the indexed document corpus                       │
  └──────────────────────────┬─────────────────────────────────────┘
  ┌─ Storage — pgvector (ONE chunks table) ───────────▼────────────┐
  │  documents AND memory rows share it, tagged meta.kind          │
  └─────────────────────────────────────────────────────────────────┘
```

The surprising part: buffr's episodic memory rides the **same** pgvector table as the documents,
tagged `meta.kind='memory'`, so a past exchange resurfaces through the **same**
`search_knowledge_base` tool that finds documents. The cost of that elegance is the honest
distinction below — and it's the single most important thing in this file.

## Structure pass

Three tiers, one axis: **lifespan** — how long does this memory survive?

```
  Axis = LIFESPAN · trace it across the three tiers, find the seam

  working    lives for ONE answer() call         the messages array, gone on return
  ───────────────── ★ SEAM: memory crosses the session boundary ★ ─────────────────
  episodic   lives ACROSS sessions               remembered to pgvector, recalled by relevance
  long-term  lives forever                       the indexed document corpus
```

The seam is the session boundary. Above it, working memory dies when `answer()` returns — it's
the loop's scratchpad. Below it, episodic and long-term memory persist in pgvector and are
recalled by similarity, not by being in the prompt. buffr's seam line is `session.ts:66`
(`memory.remember(...)` writes the just-finished exchange to durable storage) versus the working
memory that lived only inside that `answer()` call.

## How it works

### Move 1 — mental model

Working memory is a variable; episodic and long-term memory are a database table. Bridge from
frontend: working memory is `useState` inside a component — it exists while the component is
mounted and resets on unmount. Episodic and long-term memory are rows in a DB table you query by
relevance. buffr's twist: both live in the *same* table, told apart by a `kind` column.

```
  THE SHAPE — three tiers by lifespan and recall mechanism

  ┌─ WORKING (variable) ───────────────────────────────────────┐
  │  messages array · in-context · recalled by BEING there     │
  │  lifespan: one answer() call                               │
  └────────────────────────────────────────────────────────────┘
  ┌─ EPISODIC + LONG-TERM (one DB table, kind column) ─────────┐
  │  chunks table in pgvector · recalled by RELEVANCE (cosine) │
  │   meta.kind='memory'   → episodic (past exchanges)         │
  │   meta.kind=<document> → long-term (indexed corpus)        │
  │  lifespan: across sessions / forever                       │
  └────────────────────────────────────────────────────────────┘
```

### Working memory: the messages array, gone when answer() returns

Bridge from known: this is `useState` for the conversation — append-only, and unmounted when the
call ends. The loop seeds it with the question and grows it per turn (covered fully in
`../01-reasoning-patterns/02-agent-loop-skeleton.md`). The point here: it has no lifespan beyond
the call.

```ts
// run-agent-loop.ts:94 — working memory is born, lives, and dies inside answer().
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];
// ...grows via messages.push(...) at :124 and :189 across up to 6 turns...
// when answer() returns, this array is garbage-collected. Nothing persists it.
```

Annotation: working memory is the *only* place the model's own reasoning within a turn lives. The
moment `answer()` returns, it's gone. That's why buffr needs episodic memory at all — without it,
every question starts from a blank scratchpad.

### Episodic memory: remember the exchange to pgvector

This is buffr's cross-session memory. After each turn, the session embeds the formatted
question+answer and upserts it into the *same* store the documents live in, tagged so it's
distinguishable. Bridge from known: this is an `INSERT` into your DB table, where one column
(`kind`) marks the row's type.

```ts
// src/session.ts:53,66 — wire the memory engine, then write after each turn.
const memory = createConversationMemory({ embedder, store });  // :53 — same embedder, same store
...
async ask(question) {
  const answer = await agent.answer(question);
  await trace.flush();
  try {
    await memory.remember({ conversationId, question, answer });  // :66 — write the exchange
  } catch { /* best-effort: a memory-write fail must not lose the user's answer */ }  // :67-69
  return answer;
}
```

```ts
// @aptkit/memory — conversation-memory.ts:74-87 — remember() = embed + tagged upsert.
async remember(turn) {
  const text = format(turn);                       // "Past exchange — user asked... assistant..."
  const [vector] = await embedder.embed([text]);
  const n = counters.get(turn.conversationId) ?? 0;
  await store.upsert([{
    id: `${kind}:${turn.conversationId}:${n}`,      // :80-84 — id namespace "memory:<conv>:<n>"
    vector,
    meta: { kind, conversationId: turn.conversationId, text },  // ← meta.kind='memory' is the tag
  }]);
}
```

```
  remember — the exchange becomes a tagged row in the shared store

  {question, answer} ─▶ format ─▶ embed ─▶ upsert
                                              │
   id = "memory:<conv>:<n>"                   ▼
   meta.kind = "memory"          ┌──────────────────────────┐
                                 │  ONE pgvector chunks table│
   (documents: meta.kind=doc)   │  documents + memory rows   │
                                 └──────────────────────────┘
```

Annotation two things. First, `remember` is wrapped in try/catch (`session.ts:67-69`) — memory is
best-effort, because a write failure must never cost the user the answer they already got. Second,
the id namespace `memory:<conv>:<n>` (`conversation-memory.ts:80-84`) keeps memory ids from
colliding with document ids in the shared table.

### Episodic recall: over-fetch, then filter by kind

Recall happens through the *same* `search_knowledge_base` tool the model already calls for
documents — because memory lives in the same table. But the VectorStore contract has no metadata
filter, so `recall` over-fetches and filters in application code. Bridge from known: it's a
`SELECT ... LIMIT 20` followed by a `.filter()` in JS, because the query layer can't filter on
`kind` directly.

```ts
// @aptkit/memory — conversation-memory.ts:89-106 — recall() = search, then keep only memory rows.
async recall(query, k = 5) {
  const [vector] = await embedder.embed([query]);
  const fetchK = Math.max(k * 4, 20);              // :94 — OVER-FETCH (docs may rank above memory)
  const hits = await store.search(vector, fetchK);
  return hits
    .filter((h) => h.meta?.kind === kind)          // :97 — keep ONLY meta.kind='memory'
    .slice(0, k)                                    // then trim to k
    .map((h) => ({ id: h.id, score: h.score, text: h.meta.text, conversationId: ... }));
}
```

```
  recall — relevance search, then filter to memory rows

  query ─▶ embed ─▶ store.search(fetchK = max(k*4, 20))
                            │ returns docs AND memory, ranked by cosine
                            ▼
                     filter meta.kind == 'memory'  ─▶ slice(k)  ─▶ MemoryHit[]
                     (over-fetch covers docs that outrank memory)
```

Annotation: the over-fetch is the price of the shared store. Because search can't filter by
`kind`, memory could be buried under documents; pulling 4× as many and filtering down recovers
it. A dedicated memory store would skip this, but then memory wouldn't surface through the same
tool — buffr chose the shared store on purpose.

### Move 3 — the principle (the honest distinction)

This is the load-bearing point of the file. buffr has **relevance-recall across sessions: YES.**
A past exchange resurfaces when a new question is similar to it, via the same retrieval tool. But
buffr has **in-prompt conversational-context threading: NO.** `RagQueryAgent.answer()` treats
every question independently — there is no sequential turn history threaded into the prompt.

```
  THE DISTINCTION — two things people conflate, only one of which buffr has

  ┌─ relevance-recall (YES) ───────────────────────────────────────┐
  │  "what did I say about X?" → similar past exchange resurfaces   │
  │  mechanism: embed + cosine search over memory rows             │
  │  works ACROSS sessions                                         │
  └────────────────────────────────────────────────────────────────┘
  ┌─ conversational-threading (NO) ────────────────────────────────┐
  │  "what about the second one?" → no idea, no turn history        │
  │  answer() treats each question independently (session.ts:25-27) │
  │  follow-ups that depend on the LAST turn do NOT work            │
  └────────────────────────────────────────────────────────────────┘
```

The session comment names this directly (`session.ts:25-27`): "*Still missing: sequential
in-prompt turn history (RagQueryAgent.answer() treats each question independently). Retrieval-
based recall above gives relevance-based memory without it.*" So buffr can answer "what did I tell
you about my deploy setup last week?" (relevance recall), but it cannot answer "and what about the
second option you just mentioned?" (threading). Know which question your memory design actually
answers.

## Primary diagram

Full recap: three tiers, the shared store, the two recall mechanisms, the one gap.

```
  buffr's memory — three tiers, one store (conversation-memory.ts:60-108, session.ts:53,66)

  WORKING (in-context, per call)
  ┌────────────────────────────────────────────────────────────────┐
  │ messages array (run-agent-loop.ts:94) · recalled by BEING there │
  │ lifespan: one answer() call, then garbage-collected            │
  └────────────────────────────────────────────────────────────────┘
  EPISODIC + LONG-TERM (durable, recalled by relevance)
  ┌────────────────────────────────────────────────────────────────┐
  │ ONE pgvector chunks table, told apart by meta.kind             │
  │   remember (:74-87) ─▶ embed + upsert id="memory:<conv>:<n>"   │
  │   recall   (:89-106) ─▶ search, over-fetch 4×, filter kind     │
  │   surfaces via the SAME search_knowledge_base tool             │
  └────────────────────────────────────────────────────────────────┘
  THE GAP
  ┌────────────────────────────────────────────────────────────────┐
  │ relevance-recall: YES · conversational-threading: NO            │
  │ answer() treats each question independently (session.ts:25-27)  │
  └────────────────────────────────────────────────────────────────┘
```

Two tiers shipped, one store shared, two recall paths, one honest gap. That's the whole memory
story.

## Elaborate

Sharing the documents table for memory (`conversation-memory.ts:20-31` makes the store injectable
precisely so buffr *can* pass the same `PgVectorStore`) is the clever, slightly dangerous choice.
Upside: memory needs no new tool, no new table, no router — it surfaces through
`search_knowledge_base` for free. Downside: memory competes with documents for the top-k slots, so
a flood of remembered exchanges could crowd out real document hits. The over-fetch
(`fetchK = max(k*4, 20)`) is a partial mitigation, not a fix. A production system at scale would
likely split the stores and add a router (the multi-source routing in Section B's file 03) — but
for a personal assistant with a modest history, one store is the right call.

The multi-agent shape of memory is *shared memory as a contended resource*: when five agents read
and write one memory store, you get write conflicts, stale reads, and the question of which
agent's memory is authoritative. buffr is single-agent, so its memory is a single writer to a
single store — no contention, no authority question. That's why the shared-store design is safe
here and would need rethinking in a fleet.

Cross-ref `study-ai-engineering` for the two-layer agent-memory split mechanics (the
canonical/retrieved layering) — this file covers only the agent-architecture tiering and buffr's
honest threading gap.

## Interview defense

**Q: "Does your agent remember the conversation?"**

Model answer: "It remembers across sessions by relevance, but it does not thread the conversation
turn-to-turn — and those are different things. After each turn, `memory.remember`
(`session.ts:66`) embeds the exchange and upserts it into the same pgvector table as the
documents, tagged `meta.kind='memory'` (`conversation-memory.ts:74-87`). A later question that's
*similar* resurfaces it through the same `search_knowledge_base` tool — relevance-recall across
sessions, yes. But `RagQueryAgent.answer()` treats every question independently
(`session.ts:25-27`): there's no sequential turn history in the prompt, so a follow-up like 'what
about the second one?' fails. Relevance-recall yes, conversational-threading no. I'd add threading
by feeding the last N turns into the messages array — that's an aptkit-side change, and I scoped
it out deliberately because relevance-recall covers the personal-assistant use case."

```
  The defense in one picture

  "what did I say about X last week?"  → relevance-recall  → WORKS (cosine over memory rows)
  "what about the second one?"          → needs threading   → FAILS (each Q is independent)
```

Anchor: *Working (messages array, per call), episodic (remember/recall over the shared pgvector
table, relevance-recall across sessions YES), long-term (the docs); conversational-threading NO —
answer() treats each question independently.*

## See also

- `01-context-engineering.md` — the profile is *unconditional* recall; memory is *relevance*
  recall. Two ways context enters the window.
- `03-tool-calling-and-mcp.md` — memory recall rides the same `search_knowledge_base` tool.
- `../02-agentic-retrieval/03-retrieval-routing.md` — the router buffr would add to separate
  memory rows from document rows in the shared store.
- `study-ai-engineering` → the two-layer agent-memory split mechanics.
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — working memory is the loop's messages
  array.
