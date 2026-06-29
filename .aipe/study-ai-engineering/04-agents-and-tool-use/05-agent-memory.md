# Agent memory — retrieval-based episodic recall

*Industry standard (long-term memory); project-specific implementation via `@aptkit/memory`.*

## Zoom out, then zoom in

buffr's memory is one of its sharpest design moves: it doesn't bolt on a memory store. It reuses the *same* pgvector store the documents live in, tagging memory rows so they resurface through the *same* retrieval tool. Memory is RAG over conversation history.

```
  Zoom out — where memory lives

  ┌─ Session ───────────────────────────────────────────────────┐
  │  after each turn: ★ memory.remember({conv, q, a}) ★          │ ← we are here (write)
  └───────────────────────────┬─────────────────────────────────┘
                              │  embed exchange (768-dim)
  ┌─ Storage (shared!) ───────▼─────────────────────────────────┐
  │  agents.chunks                                               │
  │   ├ documents' chunks  (meta.kind absent)                   │
  │   └ memory chunks      (meta.kind = 'memory')   ← same table │
  └───────────────────────────┬─────────────────────────────────┘
                              │  next turn: search_knowledge_base recalls BOTH
  ┌─ Agent loop ──────────────▼─────────────────────────────────┐
  │  relevant past exchanges surface like any other chunk        │ ← recall
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: there are two flavors of agent memory — short-term (the conversation so far, held in the context window) and long-term (past sessions, retrieved by relevance). buffr has **no short-term memory** (each question is answered independently) and **retrieval-based long-term episodic memory** (every exchange embedded and recalled across sessions). The interesting one is the long-term path, because it's literally the RAG pipeline pointed at itself.

## Structure pass

**Layers:** session (writes memory) → memory engine (embed + tag + upsert) → shared store (holds docs + memory) → recall (via the search tool).

**Axis — "state: who owns it and where does it live?"**

```
  trace "where does memory state live?"

  ┌─ short-term ────────────┐   buffr: NOWHERE (no in-prompt turn history)
  │  the conversation so far │   answer() treats each question independently
  └─────────────────────────┘
  ┌─ long-term ─────────────┐   buffr: the SAME chunks table, tagged kind=memory
  │  past exchanges          │   unbounded, persistent, cross-session
  └─────────────────────────┘
```

**The seam:** documents and memory share one table. What separates them is a single `meta.kind='memory'` tag and an id namespace (`memory:<conv>:<n>`). The dropped FK on `chunks.document_id` is what *permits* this — a memory chunk has no parent document row, which a foreign key would forbid.

## How it works

### Move 1 — the mental model

You know how `localStorage` persists state across page reloads, but you have to *query* it by key to get anything back? buffr's long-term memory is that, except the "key" is semantic similarity. Each exchange is written to the store; next session, a related question retrieves it — not by id, by meaning.

```
  the memory loop — RAG pointed at itself

  turn N:  Q + A  ─► embed ─► upsert (kind=memory) ─► store
                                                        │
  turn N+1: Q' ─► search_knowledge_base ─► store ───────┘
                       │
                       ▼  returns docs AND relevant past exchanges
                  grounded answer (now aware of history by relevance)
```

### Move 2 — the step-by-step walkthrough

**Step 1 — memory is constructed over buffr's own store.** The same `PgVectorStore` and embedder the documents use are injected into aptkit's memory engine. buffr provides the store; aptkit provides the embed/tag/recall logic.

```ts
// src/session.ts:53
const memory = createConversationMemory({ embedder, store });
```

**Step 2 — after each successful turn, the exchange is remembered (best-effort).** The session writes memory *after* the answer is already in hand, wrapped in a swallow so a memory failure never costs the user their answer.

```ts
// src/session.ts:64-70
await trace.flush();
try {
  await memory.remember({ conversationId, question, answer });
} catch {
  // swallow: memory is best-effort, the turn already succeeded
}
return answer;
```

That `try/catch` is a real design decision, not laziness: memory is an enhancement, the answer is the product. Ordering matters — `remember` runs after `return`-ready state, so a DB hiccup degrades future recall, never the current response.

**Step 3 — `remember` formats, embeds, and upserts with a memory tag.** Inside aptkit, the exchange becomes text, gets one 768-dim vector, and is upserted with a deterministic id and `kind: 'memory'`.

```ts
// aptkit packages/memory/src/conversation-memory.ts:74-87 (remember)
async remember(turn) {
  const text = format(turn);                       // "Q: ...\nA: ..." style
  const [vector] = await embedder.embed([text]);
  if (!vector) return;
  const n = counters.get(turn.conversationId) ?? 0;
  counters.set(turn.conversationId, n + 1);
  await store.upsert([{
    id: `${kind}:${turn.conversationId}:${n}`,      // e.g. "memory:abc-123:0"
    vector,
    meta: { kind, conversationId: turn.conversationId, text },  // kind='memory'
  }]);
}
```

This lands in buffr's `PgVectorStore.upsert` (`src/pg-vector-store.ts:38-65`), the same path documents take — which is why the id is `memory:<conv>:<n>` and the row has `document_id = null` (no `docId` in meta). The dropped FK lets that null stand.

**Step 4 — recall happens through the search tool, not a separate call.** Because memory rows live in the same table, the agent's ordinary `search_knowledge_base` call surfaces them alongside document chunks. There's no explicit "recall" step in buffr's loop — recall is a side effect of retrieval over a shared store.

```
  Layers-and-hops — recall is just retrieval

  ┌─ Loop ───────┐ hop1: search_knowledge_base(q')  ┌─ Pipeline ──┐
  │ next session │ ────────────────────────────────►│ embed+search│
  └──────▲───────┘ hop3: chunks (docs + memory) ◄── └──────┬──────┘
         │                                          hop2 │ ANN over
         │ grounds answer with history                   ▼  shared table
         │                                        ┌─ agents.chunks ───┐
         └─────────────────────────────────────── │ docs + kind=memory │
                                                  └────────────────────┘
```

(aptkit's memory engine *also* exposes a dedicated `recall(query, k)` that over-fetches and filters by `meta.kind`, for setups using a separate store — `conversation-memory.ts:89-106`. buffr doesn't call it; it relies on the shared-store retrieval path instead.)

### Move 3 — the principle

The cleanest long-term memory isn't a new subsystem — it's your existing retrieval pipeline pointed at conversation history. buffr proves the point: one table, one tag, one tool. The cost is that memory and documents compete in the same ranking (a strongly-relevant past exchange can outrank a document, or vice versa), which is exactly why aptkit's standalone `recall` filters by kind — a knob buffr could reach for if the mixing ever hurts.

## Primary diagram

```
  buffr agent memory — write path + recall path, one frame

  WRITE (every turn)                        RECALL (next turn / next session)
  ──────────────────                        ────────────────────────────────
  Q + A ─► format ─► embed(768) ─► upsert    Q' ─► search_knowledge_base
            (kind=memory,                          │ embed + ANN
             id=memory:<conv>:<n>,                 ▼
             document_id=null)                 agents.chunks (docs + memory)
                  │                                │
                  ▼                                ▼
            agents.chunks ◄══════════════════ same table, same index
                                               relevant past exchange surfaces
                                               as just another chunk
```

## Elaborate

Two-layer memory (short-term in-context + long-term retrieved) is the standard agent-memory model. buffr deliberately ships only the long-term layer because the short-term layer is an aptkit-side change: `RagQueryAgent.answer()` currently treats each question independently with no prior-turn history threaded into the prompt (noted at `src/session.ts:25-27`). The retrieval-based recall gives *relevance*-based memory without sequential history — you get "the model remembers what's relevant" but not "the model remembers what we just said two turns ago." For a single-conversation TUI that's a real limitation; for cross-session recall it's exactly right. The term for buffr's flavor is **episodic memory**: discrete past episodes (exchanges) recalled by similarity.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Add short-term in-prompt turn history

- **Exercise ID:** MEM-1 (Case B — short-term memory not yet exercised).
- **What to build:** thread the last N turns of this conversation into the agent's prompt so follow-up questions ("and the second one?") resolve without relying on retrieval.
- **Why it earns its place:** demonstrates you understand the short-term/long-term split and can fix the "each question independent" limitation.
- **Files to touch:** `src/session.ts` (accumulate turns), and the prompt assembly — note this may require an aptkit-side `RagQueryAgent` option, so the buffr-side move is to pass recent turns as context the agent can use.
- **Done when:** a follow-up referencing the previous answer resolves correctly without a retrieval hit.
- **Estimated effort:** 1–2 days.

### Separate memory ranking from document ranking

- **Exercise ID:** MEM-2 (Case A — hardening the shared store).
- **What to build:** switch recall to aptkit's `kind`-filtered `recall()` path (or a metadata-scoped query) so memory and documents don't compete in one ranking when it matters.
- **Why it earns its place:** shows you can reason about retrieval contention in a shared vector store.
- **Files to touch:** `src/session.ts:53` (memory wiring), possibly a second filtered query in `src/pg-vector-store.ts`.
- **Done when:** an eval shows memory recall and document retrieval can be tuned independently.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: How does buffr remember across sessions?**
Answer: retrieval-based episodic memory. After each turn it embeds the Q+A exchange and upserts it into the *same* pgvector store as the documents, tagged `meta.kind='memory'` with id `memory:<conv>:<n>`. Next session, the ordinary `search_knowledge_base` tool surfaces relevant past exchanges alongside documents — memory is RAG over conversation history. The dropped FK on `chunks.document_id` is what lets a memory row exist with no parent document.

**Q: What's the catch with sharing one table for docs and memory?**
Answer: they compete in the same ranking. **The part people forget is that recall is a side effect of retrieval here** — there's no separate recall call in buffr's loop, so you can't tune memory vs document weighting without adding a kind-filtered query (which aptkit's standalone `recall` already does). Also: memory is best-effort (write is in a try/catch after the answer), so a memory failure never costs the user their response.

```
  the sketch:  one chunks table · meta.kind splits docs from memory · one tool recalls both
```

## See also

- `../03-retrieval-and-rag/11-rag.md` — the retrieval pipeline memory reuses.
- `01-agents-vs-chains.md` — where in the loop memory is written.
- `.aipe/study-database-systems/` — the dropped FK and why it's deliberate.
