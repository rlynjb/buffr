# Agent Architecture — buffr

> One-page orientation. Read this first, then `audit.md`, then the pattern files.

## The verdict in one line

buffr is a **single-agent, bounded ReAct loop** with exactly one read-only
tool (`search_knowledge_base`) over stock Gemma 2:9b. It is not multi-agent,
not a chain, and not a planner. The whole agent lives in
`@rlynjb/aptkit-core`'s `runAgentLoop`; buffr supplies the model, the tool, a
standing profile, a trajectory sink, and a conversation-memory engine, then runs
it from a long-lived chat session (`npm run chat`) that holds ONE conversation
across every turn and calls `agent.answer(question)` per question.

## The whole system in one frame

The agent loop is the inner box. buffr owns everything around it — the wiring,
the persistence, the corpus. aptkit owns the loop itself.

```
  buffr agent architecture — one shape, end to end

  ┌─ CLI layer (buffr) ──────────────────────────────────────────┐
  │  src/cli/chat.tsx (Ink UI)  →  src/session.ts (ChatSession)   │
  │   long-lived session: ONE conversation held across turns;     │
  │   wires model, tool, profile, trace, memory once              │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ agent.answer(question)  (per turn)
  ┌─ Agent layer (aptkit) ────────▼──────────────────────────────┐
  │  RagQueryAgent  →  runAgentLoop                              │
  │    ┌──────────────────────────────────────────────┐          │
  │    │  reason (Gemma) → act (1 tool) → observe → … │ ≤6 turns │
  │    │  forced final-synthesis turn at the budget    │ ≤4 calls │
  │    └──────────────────────────────────────────────┘          │
  └───────┬───────────────────────┬──────────────┬───────────────┘
          │ search_knowledge_base  │ trace.emit   │ remember(Q+A) after answer
  ┌─ Retrieval (aptkit+buffr) ─▼──┐ ┌─▼ Traject. ─┐ ┌─▼ Memory (aptkit) ──────┐
  │ pipeline → PgVectorStore      │ │ SupabaseT...│ │ createConversationMemory │
  │ → pgvector HNSW (768-dim)     │ │ → .messages │ │ → embed → store.upsert   │
  │ ▲ search surfaces memory rows │ │  (6 events) │ │   (kind=memory, SHARED    │
  │ │ (kind=memory) by similarity │ └─────────────┘ │   PgVectorStore)          │
  └─┼─────────────────────────────┘        │        └──────────┬────────────────┘
    └──────── recall (implicit, cross-session) ◄───────────────┘
          │                                       │
  ┌─ Provider / Storage ─────────────────────────▼───────────────┐
  │  Ollama: gemma2:9b + nomic-embed-text  ·  Postgres reindb     │
  └──────────────────────────────────────────────────────────────┘
```

## Which of the three shapes

The spec frames every codebase as one of three shapes. buffr is unambiguously
the middle one:

| Shape          | buffr?  | Why                                                      |
| -------------- | ------- | -------------------------------------------------------- |
| Workflow/chain | no      | The model chooses whether and what to search; not fixed. |
| **Single-agent** | **yes** | One ReAct loop, one tool, one actor, model picks the path.|
| Multi-agent    | no      | No second agent, no supervisor, no handoff. Design-only. |

Coverage is weighted toward single-agent reasoning patterns and agentic
retrieval. Multi-agent orchestration is taught as "what you'd reach for" and
honestly marked **not yet exercised**.

## What's load-bearing here

Four mechanics carry this architecture. In order of how surprising they are:

1. **The forced synthesis turn.** At the last turn (or when the tool budget is
   spent) `runAgentLoop` strips the tool schemas and appends a "you have NO
   more tool calls" instruction. This is what guarantees the loop produces an
   answer instead of looping on `search` forever. Most important mechanic in
   the codebase — see `01-bounded-react-loop.md`.
2. **The single-tool allowlist.** `ragQueryToolPolicy.allowedTools` is exactly
   `['search_knowledge_base']`. The blast radius of this agent is one
   read-only retrieval call. See `02-single-tool-capability-scope.md`.
3. **Tool calling is emulated, not native.** Gemma 2 has no tool API. The
   Gemma provider renders tool schemas into the system prompt and parses a
   JSON blob back out. See `05-emulated-tool-calling.md`.
4. **Memory recalls by riding the documents' store.** After each turn buffr
   embeds the exchange (`createConversationMemory`) into the SAME
   `PgVectorStore` as documents, tagged `kind=memory`, so a later
   `search_knowledge_base` call surfaces it by similarity — cross-session recall
   with no new infrastructure and no `recall()` call. Relevance recall yes,
   in-prompt conversational history no. See `04-trajectory-as-memory.md`.

## Reading order

```
  00-overview.md   (you are here)
       │
  audit.md         Pass 1 — every lens, file:line or "not yet exercised"
       │
  01 → 06          Pass 2 — the patterns this repo actually exercises
```

The pattern files are self-contained; read them in any order, but `01` (the
bounded ReAct loop) is the spine the rest hang off.

---

Updated: 2026-06-24 — Entry point is now the long-lived `npm run chat` session
(`src/session.ts` + `src/cli/chat.tsx`) holding ONE conversation across turns
(`ask-cmd.ts` deleted, refs purged). System diagram + load-bearing list now
include relevance-based memory recall via `createConversationMemory` over the
shared `PgVectorStore`; trace sink shown as full-signal (6 events). aptkit-core 0.4.1.
