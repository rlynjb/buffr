# Agent memory tiers — and buffr's honest middle tier

**Industry name(s):** agent memory tiers · working/episodic/long-term
memory · retrieval-based memory. **Type label:** Industry standard.

**In this codebase: yes — buffr has episodic memory via `@aptkit/memory`,
recalled by relevance through the same search tool.** This is the most
nuanced file in the guide, because buffr's memory has a precise honest
boundary: **relevance recall across sessions — yes; in-prompt
conversational threading — no.** Hold that distinction; it's the whole
file.

## Zoom out, then zoom in

```
  Zoom out — the three memory tiers, buffr's marked

  ┌─ Working (in-context) ─────────────────────────┐
  │  The current task's window. Gone when run ends. │
  │  buffr: the messages array — BUT only this turn │ ← NO history threaded
  └─────────────────────────────────────────────────┘
  ┌─ Episodic (recent sessions) ───────────────────┐
  │  Past exchanges, retrieved by relevance.        │ ← we are here
  │  buffr: @aptkit/memory, kind=memory in chunks   │   (THIS is buffr's tier)
  └─────────────────────────────────────────────────┘
  ┌─ Long-term (persistent knowledge) ─────────────┐
  │  Durable facts in a vector DB. Unbounded.       │
  │  buffr: the indexed documents corpus            │
  └─────────────────────────────────────────────────┘
```

Zoom in: working memory is the window (and buffr's is amnesiac across
turns — no history). Episodic memory is past exchanges retrieved by
relevance — buffr *does* this, via `@aptkit/memory`. Long-term is the
durable document corpus. The interesting tier is the middle one, and
its honest limit.

## Structure pass

**Layers.** Three tiers, but buffr collapses two of them into one store:
documents (long-term) and memory (episodic) both live in `chunks`,
distinguished by `meta.kind`.

**Axis — "how does a past exchange reach the next answer?"** Two
possible paths: threaded into the prompt (conversational context) or
retrieved by relevance (episodic recall). buffr uses *only* the second.
Tracing this axis is what separates "remembers by retrieving" from
"remembers by carrying forward."

**Seam.** The `memory.remember` / `memory.recall` boundary. `remember`
embeds the exchange and stores it (`src/session.ts:67`); `recall`
happens implicitly through the *same* `search_knowledge_base` tool. The
seam is that memory and documents share a retrieval path.

## How it works

#### Move 1 — the mental model

You know local-first storage: a canonical local store plus
context you pull in by relevance. buffr's memory is that instinct
applied to conversation — past exchanges are stored, and the relevant
ones are *pulled back* when a new question resembles them. It does *not*
keep the whole conversation in hand; it retrieves the relevant bits.

```
  Pattern — buffr's retrieval-based episodic memory

  turn ends → embed(question + answer) → store tagged kind=memory
                                              │ (in chunks table)
  next turn → search_knowledge_base(new question)
                  │ over-fetches, filters kind=memory
                  ▼
            relevant PAST exchanges resurface as retrieved context
            (across sessions — NOT threaded as conversation history)
```

#### Move 2 — the walkthrough

**`remember` embeds each exchange after the turn.** At the end of every
`ask`, buffr writes the exchange to memory (`src/session.ts:64-69`),
best-effort so a memory failure never loses the answer:

```ts
try {
  await memory.remember({ conversationId, question, answer });
} catch {
  // swallow: memory is best-effort, the turn already succeeded
}
```

Inside, `createConversationMemory` formats the exchange ("Past exchange
— user asked: … assistant answered: …"), embeds it, and upserts it
tagged `kind=memory` with a per-conversation counter id
(`conversation-memory.js:29-43`).

**Recall rides the *same* search tool — no second tool.** This is the
deliberate design. Memory shares the `chunks` store with documents
(`src/session.ts:50-53`), so a future question's `search_knowledge_base`
call surfaces relevant past exchanges *alongside* relevant documents.
The memory engine's `recall` over-fetches then filters by kind
(`conversation-memory.js:48-53`) because the `VectorStore` contract has
no metadata filter. aptkit even ships a dedicated `search_memory` tool
(`memory-tool.js`) — and buffr *doesn't* use it, on purpose, because a
shared store means the existing search already surfaces memory (the
memory-tool's own doc comment says exactly this,
`memory-tool.js:7-9`). One tool, smallest surface.

**The honest limit, stated precisely.** buffr recalls past exchanges by
*relevance*, across sessions — that's real episodic memory. What it does
*not* do is thread the sequential conversation into the prompt.
`RagQueryAgent.answer()` treats each question independently
(`run-agent-loop.js:22`; `src/session.ts:25-27`). So if you ask "what
about the second one?" referring to your previous turn, buffr won't have
that turn in its window — unless the embedding of the prior exchange
happens to be relevant enough to retrieve. Relevance recall: yes.
Conversational-context threading: no. Both halves are true and the
distinction is the point.

```
  Comparison — the two memory paths, buffr's choice marked

  relevance recall (buffr HAS):     in-prompt threading (buffr LACKS):
    embed exchange → store            keep prior turns in messages array
    new Q retrieves relevant past     "what about the 2nd one?" resolves
    works across sessions             requires sequential history
    ✓ via search_knowledge_base       ✗ messages = [just this question]
```

#### Move 2.5 — current vs future state

**Phase A (now):** retrieval-based episodic memory + amnesiac working
memory. Past exchanges are recalled by relevance; the current
conversation is not carried forward in-prompt.

**Phase B (would-be):** thread recent turns into the messages array.
The session comment marks this as an *aptkit-side* change
(`src/session.ts:26-27`) — `RagQueryAgent.answer` would need to accept
prior turns. What *doesn't* have to change: the retrieval memory keeps
working regardless; threading is additive, not a replacement.

#### Move 3 — the principle

Long-term memory only works if the right thing is retrieved at the right
time — which is RAG inside the agent. buffr leans entirely on that:
memory is retrieval, sharing the document store and the document search
tool. The cost is the missing conversational thread; the benefit is a
single read-only tool and memory that works across sessions, not just
within one. Naming exactly which kind of memory you have — relevance
recall, not context threading — is the senior move.

## Primary diagram

```
  buffr's memory model (the honest distinction)

  WORKING:   messages = [ just this question ]   ✗ no prior turns
  EPISODIC:  ┌─ remember(q,a) → embed → chunks[kind=memory] ─┐
             │                                               │
             └─ next Q → search_knowledge_base → recalls ────┘
                relevant past exchanges (cross-session)
  LONG-TERM: indexed documents in chunks[kind≠memory]

  recall by relevance ✓   |   conversational threading ✗
```

## Elaborate

The three-tier memory model (working/episodic/long-term) maps an agent's
knowledge onto the local-canonical-plus-retrieved-context instinct from
local-first apps. The two-layer short/long split would be covered in a
future `study-ai-engineering` agent-memory file; this file extends it to
the three-tier model *and* the cross-session retrieval problem buffr
actually solves. The reason the retrieval path is load-bearing: a stale
or wrongly-relevant memory chunk can poison an answer — which is why the
self-corrective-RAG grader (`02-agentic-retrieval/02-self-corrective-rag.md`)
matters more in a shared doc/memory store.

## Interview defense

**Q: Does buffr remember past conversations?**
Yes, but by *retrieval*, not by threading. After each turn it embeds the
exchange into the same vector store tagged `kind=memory`
(`src/session.ts:67`), and future questions surface relevant past
exchanges through the same `search_knowledge_base` tool, across
sessions. What it does *not* do is keep the sequential conversation in
the prompt — `RagQueryAgent.answer` treats each question independently.
So "what about the second one?" only works if that prior exchange is
relevant enough to retrieve.

```
  relevance recall (cross-session) ✓   |   in-prompt history ✗
```

**Anchor:** "buffr remembers by retrieving, not by carrying the
conversation forward — relevance recall yes, context threading no."

**Q: Why does memory share the document store and tool?**
To keep the agent's surface to exactly one read-only tool. A shared
store means the existing `search_knowledge_base` already surfaces memory
— aptkit's dedicated `search_memory` tool is deliberately unused
(`memory-tool.js:7-9`). The cost is over-fetch-then-filter-by-kind since
the store has no metadata filter.

## See also

- `01-context-engineering.md` — why the working tier is amnesiac
- `02-agentic-retrieval/02-self-corrective-rag.md` — guarding against
  stale memory poisoning an answer
- `02-agentic-retrieval/03-retrieval-routing.md` — the one-store,
  two-kinds design
- `.aipe/study-system-design/06-retrieval-as-memory.md` — the same
  pattern from the system-design angle
