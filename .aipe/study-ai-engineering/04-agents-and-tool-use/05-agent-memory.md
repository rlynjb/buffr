# Agent Memory — In-Context vs Retrieved
### *The messages array you lose, and the episodic store you keep*
**Type label:** agent state (working + long-term memory)

## Zoom out

Memory in an agent is just *what state survives, and for how long*. Locate the two kinds in the stack.

```
The two memory layers in buffr
┌──────────────────────────────────────────────────────────┐
│  ★ SHORT-TERM   messages[] inside ONE answer() call         │  ← this file
│                 working memory, gone when answer() returns  │
├──────────────────────────────────────────────────────────┤
│  ★ LONG-TERM    @aptkit/memory over the SAME vector store   │  ← this file
│                 episodic, retrieved via search, persists    │
├──────────────────────────────────────────────────────────┤
│  Storage        PgVectorStore — documents AND memory rows   │  durable
└──────────────────────────────────────────────────────────┘
```

Two memories (★), two lifetimes. Short-term lives for one question and dies. Long-term lives in pgvector forever and resurfaces *through the same search tool the documents use*. That second fact is the clever bit and the whole reason this file exists.

Conversational version. You already know these two shapes. Short-term memory is component state — `useState` inside a render; it exists while the component is mounted and resets when it unmounts. Long-term memory is the database the component reads from — it outlives every mount. buffr's agent has both, with one twist that has no frontend analog: its long-term memory isn't queried by key or filter, it's queried by *similarity* — past conversations resurface when they're *relevant* to the new question, retrieved by the exact same vector search that retrieves documents. Long-term memory is RAG, pointed at the conversation history instead of the corpus.

## Structure pass

The axis: **retained across questions, or not.** Short-term is per-question; long-term is forever. And the honest gap sits right on this axis.

```
The retention axis (with buffr's honest gap marked)
   PER-QUESTION                                     PERSISTENT
   (dies at answer() return)                        (lives in pgvector)
   ├─────────────────────────────────────────────────────────────┤
   messages[]              ░░GAP░░              episodic memory rows
   working memory      no in-prompt history     retrieved by similarity
                       carried across turns
                              ▲
                      buffr does NOT carry
                      conversation history in-prompt
```

The seam: short-term memory is the `messages` array *inside* `runAgentLoop`; long-term memory is rows *outside* it, in the store. The gap between them — marked ░░GAP░░ — is that buffr does **not** carry conversation history into the next question's prompt. Each `answer()` starts with a fresh `messages = [{user}]`. The only way a past exchange influences a new answer is if it's *retrieved* as a memory row. There is no sequential, in-prompt "you said X earlier" — only relevance-based recall.

```
The two paths a past exchange can (and can't) travel
  past exchange
     ├─ ✗ in-prompt history?  → NO. messages resets every answer()
     └─ ✓ retrieved memory?   → YES, if relevant. embedded, stored, recalled by search
```

## How it works

### Move 1 — the mental model

Short-term memory is an array that grows during one loop and is discarded. Long-term memory is the same array's *content*, embedded and written to a store that the next question's search can find.

```
The lifecycle of one exchange's memory
  answer()  ┌─ messages = [user] ──── grows with turns ──── discarded ─┐  SHORT-TERM
            └────────────────────────────────────────────────────────┘
                              │ after answer returns
                              ▼
  session.ask  ┌─ remember({question, answer}) ─ embed ─ upsert ─┐      LONG-TERM
               └──────────────────────► PgVectorStore (kind=memory)┘
                              │ next question
                              ▼
  search_knowledge_base finds it (if relevant)  ── RAG over history ──►
```

### Move 2 — step by step

#### Short-term: the messages array, scoped to one answer (`runAgentLoop`)

Bridge from what you know: `useState` that resets on unmount. The `messages` array is mounted when `answer()` is called and unmounted when it returns. Nothing persists it.

```
Short-term: working memory that dies at the function boundary
  answer(question)
     │
  runAgentLoop:  messages = [{ role: user, content: question }]
     │  turn 0: push assistant, push tool_result
     │  turn 1: push assistant ...
     │  (the array IS the conversation, within this call)
     ▼
  return finalText   ← messages goes out of scope, GONE
```

Real code, the array's birth, `aptkit packages/runtime/src/run-agent-loop.ts:94`:

```ts
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];   // ← fresh every call
```

And buffr's explicit acknowledgment that this does *not* persist across turns, `buffr src/session.ts:24`:

```ts
// - Still missing: sequential in-prompt turn history (RagQueryAgent.answer() treats each
//   question independently). That's an aptkit-side change; retrieval-based recall above
//   gives relevance-based memory without it.
```

The consequence, stated plainly: if you ask buffr "what did I read about Postgres?" and then "tell me more about the second one," the second question has *no idea what "the second one" refers to* unless the first exchange happens to be retrieved as a memory row. There is no conversational pronoun resolution from in-prompt history. That's the gap, in the code's own words.

#### Long-term write: remember the exchange (`createConversationMemory.remember`)

Bridge: a write-through to the database after the render completes. The component finished; now you persist what happened. Here, "persist" means *embed and upsert*, because the store is a vector store, not a row store.

```
Long-term write: format → embed → upsert, tagged as memory
  remember({ conversationId, question, answer })
     │ format → "Past exchange — user asked: ... assistant answered: ..."
     │ embedder.embed([text]) → 768-dim vector
     ▼
  store.upsert({ id: "memory:<conv>:<n>",
                 vector,
                 meta: { kind: 'memory', conversationId, text } })   ← tagged kind=memory
```

Real code, `aptkit packages/memory/src/conversation-memory.ts:74`:

```ts
async remember(turn: MemoryTurn): Promise<void> {
  const text = format(turn);                          // "Past exchange — user asked: ... answered: ..."
  const [vector] = await embedder.embed([text]);      // same embedder as documents → same space
  if (!vector) return;
  const n = counters.get(turn.conversationId) ?? 0;
  counters.set(turn.conversationId, n + 1);
  await store.upsert([{
    id: `${kind}:${turn.conversationId}:${n}`,         // "memory:<conv>:<n>" — distinct, ordered
    vector,
    meta: { kind, conversationId: turn.conversationId, text },   // ← kind='memory' is the discriminator
  }]);
}
```

The consequence of `kind: 'memory'` living in the *same store as documents*: memory chunks and document chunks share one pgvector index. A search can return either. The `kind` tag is the only thing distinguishing them — which is what makes both recall (below) and the search-tool surfacing possible.

#### Long-term read: recall by similarity (`recall`)

Bridge: a query that ranks by closeness, then filters. You've over-fetched and filtered before — `LIMIT 80` then `.filter()` in app code because the index can't express the predicate. That's exactly this, because the `VectorStore` contract has no metadata filter.

```
Long-term read: over-fetch, filter to memory, slice
  recall(query, k)
     │ embed query
     │ fetchK = max(k*4, 20)              ← over-fetch: docs may rank above memory
     │ store.search(vector, fetchK)
     │ filter meta.kind === 'memory'      ← keep only memory rows
     │ slice(k)
     ▼
  [ { id, score, text, conversationId } ]
```

Real code, `aptkit packages/memory/src/conversation-memory.ts:89`:

```ts
async recall(query: string, k: number = DEFAULT_RECALL_K): Promise<MemoryHit[]> {
  const [vector] = await embedder.embed([query]);
  if (!vector) return [];
  const fetchK = Math.max(k * 4, 20);                 // ← over-fetch, because search can't filter by kind
  const hits = await store.search(vector, fetchK);
  return hits
    .filter((h) => h.meta?.kind === kind)             // ← post-filter to memory rows only
    .slice(0, k)
    .map((h) => ({ id: h.id, score: h.score, text: ..., conversationId: ... }));
}
```

The consequence: `recall` exists and works — but note where buffr *doesn't* call it. buffr relies on the *search tool* surfacing memory chunks (because they share the store), not on an explicit `recall()` call wired into the agent. The `kind='memory'` rows are simply in the corpus the `search_knowledge_base` tool searches. So memory resurfaces through the normal RAG path, not a dedicated recall path. `recall()` is the isolated read; buffr leans on the shared-store side effect.

#### The wiring: best-effort write in `session.ask` (`createChatSession`)

Bridge: a fire-and-forget analytics call after the response is sent. It must never block or break the thing the user actually cares about.

```
Best-effort write: the answer is already the user's; memory is a bonus
  ask(question)
     │ persist user turn
     │ answer = await agent.answer(question)   ← the answer the user gets
     │ flush trace
     │ try { memory.remember(...) } catch { swallow }   ← failure CANNOT lose the answer
     ▼
  return answer
```

Real code, `buffr src/session.ts:60`:

```ts
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);
  const answer = await agent.answer(question);
  await trace.flush();
  // Best-effort: a memory-write failure must not lose the answer the user has.
  try {
    await memory.remember({ conversationId, question, answer });
  } catch {
    // swallow: memory is best-effort, the turn already succeeded
  }
  return answer;
}
```

The consequence, stated honestly: a failed memory write costs you *future recall of this exchange*, nothing more. The user still got their answer. That's the right priority — memory is an enhancement, not a guarantee — but it does mean memory can silently have holes. If embedding fails on a particular exchange, that exchange just never becomes recallable, and nothing tells you.

### Move 2.5 — current vs future

```
In-prompt conversation history (current ✗ / future ✓)
  ✗ current:  answer() resets messages every call. "the second one" → unresolved.
              past exchanges influence answers ONLY via similarity retrieval.
  ✓ future:   carry a sliding window of recent turns INTO the next answer()'s
              messages. now pronouns and follow-ups resolve directly.
              (the session.ts comment calls this an aptkit-side change.)
```

The missing piece is sequential, in-prompt history — the thing that makes "tell me more about that" work. It's deliberately absent: buffr bets that *relevance-based* recall covers most of the value without the context-window cost of dragging every prior turn into every prompt. That's a defensible bet, but it's a bet, and it's why buffr can feel forgetful on tight follow-ups.

### Move 3 — the principle

Agent memory is two separate problems with two separate answers: *working memory* (what's in the current prompt) is a context-window problem; *long-term memory* (what to recall later) is a retrieval problem. buffr solves the second with the same machinery as the first — embed, store, search — which is why "agent memory" here is really "RAG, pointed inward." The load-bearing insight: when your long-term memory is a vector store, recall is similarity, not lookup, and relevance replaces recency.

## Primary diagram

Both memories across two questions, showing what survives.

```
Agent memory across two questions
  Q1: "what did I read about Postgres?"
     │ runAgentLoop: messages=[Q1] ── grows ── DISCARDED  (short-term, gone)
     │ answer A1
     ▼ session.ask: remember(Q1,A1) → embed → pgvector [kind=memory]  (long-term, kept)
     ───────────────────────────────────────────────────────────────
  Q2: "what about indexing strategies?"
     │ runAgentLoop: messages=[Q2]  ← FRESH, no Q1 in prompt (the gap)
     │ search_knowledge_base("indexing")
     │   → returns document chunks  AND  the Q1 memory row IF relevant
     │ answer A2 (may reflect Q1 via the recalled memory chunk)
     ▼ remember(Q2,A2) → pgvector
```

## Elaborate

Sharing one store for documents and memory is the design decision that makes everything else fall out for free. Because memory rows carry the same 768-dim vectors in the same pgvector index, the existing `search_knowledge_base` tool retrieves them with zero new plumbing — no second tool, no second index, no recall wiring in the agent. The `kind='memory'` tag is the entire cost. The downside is also real: a memory row can outrank a document row for a given query, so a chatty past exchange could crowd out a more authoritative document chunk. buffr accepts that — `minTopK: 4` gives some headroom — but it's the tradeoff you take when memory and documents compete in one ranking.

On ids: `memory:<conv>:<n>` uses a per-conversation counter so repeated exchanges get distinct, ordered ids and never collide. It assumes `conversationId` is unique per conversation, which `startConversation` guarantees. Small detail, but it's why re-asking the same question in one session doesn't overwrite the earlier memory row.

## Project exercises

### Carry a sliding window of recent turns into the next answer

- **Exercise ID:** [B4.9], Phase 4 (the primary exercise for this concept — Case B: in-prompt history does not exist; this builds it).
- **What to build:** Keep the last N (question, answer) pairs in the session and prepend them to the `userPrompt`/messages that `RagQueryAgent.answer` passes to `runAgentLoop`, so follow-ups like "tell me more about the second one" resolve against actual prior turns.
- **Why it earns its place:** This closes the single most user-visible memory gap — buffr's inability to resolve pronouns and follow-ups across questions. It forces you to confront the context-window cost the current design avoids, and to decide a window size that balances coherence against token budget.
- **Files to touch:** `buffr src/session.ts` (hold recent turns, pass them in), `aptkit packages/agents/rag-query/src/rag-query-agent.ts` (accept prior turns and prepend to messages), mindful of `ContextWindowGuardedProvider`'s 8192 cap.
- **Done when:** A two-question session where Q2 references Q1 ("the second one") produces a coherent answer, and the window is bounded so long sessions don't blow the context budget. Covered by a scripted two-turn test.
- **Estimated effort:** 4–6 hours.

### Wire explicit recall and let memory hits be cited distinctly

- **Exercise ID:** [B4.10], Phase 4.
- **What to build:** Call `memory.recall(question, k)` explicitly at the start of `answer()`, inject the recalled exchanges into the prompt with a "from your past conversations" heading, and tag them so the final citations distinguish a recalled exchange from a document.
- **Why it earns its place:** Today memory surfaces only as an indistinguishable side effect of the shared-store search — you can't tell whether an answer leaned on a document or a past chat. Explicit recall plus distinct citation makes memory's contribution visible and gradeable, and exercises the `recall()` path buffr currently bypasses.
- **Files to touch:** `aptkit packages/agents/rag-query/src/rag-query-agent.ts` (call recall, inject), `buffr src/session.ts` (pass the memory instance to the agent), citation formatting.
- **Done when:** An answer that draws on a past exchange cites it as memory, distinct from document citations, verified in the trace and an eval case.
- **Estimated effort:** 4–5 hours.

## Interview defense

**Q: "How does your agent remember things?"**

Two layers. Short-term is the `messages` array inside one `answer()` call — working memory that grows across turns and is discarded when the call returns. Long-term is episodic: after each exchange, `session.ask` embeds the (question, answer) pair and upserts it into the *same* pgvector store as the documents, tagged `kind='memory'`. So past exchanges resurface through the normal `search_knowledge_base` tool — long-term memory is RAG pointed at the conversation history.

```
  short-term: messages[] (per answer)  |  long-term: embed → pgvector → search finds it
```

*Anchor: long-term memory is a vector store, so recall is similarity, not lookup.*

**Q: "Can it handle a follow-up like 'tell me more about the second one'?"** — the part people forget.

Not reliably — and this is the honest gap. buffr does **not** carry in-prompt conversation history across questions; each `answer()` starts with a fresh `messages = [{user}]`. The session comment says so explicitly. A past exchange only influences a new answer if it's *retrieved* as a memory row by similarity — there's no sequential "you said X earlier" in the prompt. So a follow-up resolves only if the prior turn happens to be relevant enough to surface, not because it's recent. The forgotten load-bearing fact: relevance-based recall is not the same as conversational continuity.

```
  Q2 messages = [Q2]  ← Q1 NOT here; only retrievable if similar
```

*Anchor: each answer() is independent — continuity comes from retrieval, not from carried history.*

## See also

- **`01-agents-vs-chains.md`** — the `messages` array as the loop's working memory.
- **`03-react-pattern.md`** — how observations accumulate in `messages` within one answer.
- **`../03-retrieval-and-rag/`** — the embedding + pgvector machinery memory reuses; the 768-dim space both share.
- **`06-error-recovery.md`** — the best-effort try/catch pattern, applied here to memory writes.
