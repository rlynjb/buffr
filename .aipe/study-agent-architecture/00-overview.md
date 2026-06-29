# Agent architecture — the whole surface of buffr-laptop

Before any single concept, here's the entire agent surface of this
repo in one frame. buffr-laptop is a **single-agent** system: one
autonomous ReAct loop, over one read-only tool, against a local
Gemma2:9b. Everything below sits inside that one loop.

```
  buffr-laptop — the agent surface, top to bottom

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  Ink TUI (src/cli/chat.tsx) — one in-process conversation │
  │  onSubmit → session.ask(q)                                │
  └───────────────────────────┬──────────────────────────────┘
                              │  q: string
  ┌─ Session layer ───────────▼──────────────────────────────┐
  │  createChatSession (src/session.ts)                       │
  │   persistMessage(user) → agent.answer(q) → trace.flush()  │
  │                        → memory.remember(q, a)            │
  └───────────────────────────┬──────────────────────────────┘
                              │  question
  ┌─ Agent layer (aptkit) ────▼──────────────────────────────┐
  │  RagQueryAgent.answer  →  runAgentLoop                    │
  │   ★ BOUNDED ReAct LOOP ★  maxTurns:6 / maxToolCalls:4     │ ← we are here
  │   forced synthesis on the last turn (tools = undefined)   │
  │   ONE tool allowed: search_knowledge_base                 │
  └───────────────────────────┬──────────────────────────────┘
                              │  tool intent (emulated JSON)
  ┌─ Tool + retrieval layer ──▼──────────────────────────────┐
  │  InMemoryToolRegistry → search_knowledge_base handler     │
  │   → retrieval pipeline → PgVectorStore.search             │
  └───────────────────────────┬──────────────────────────────┘
                              │  SQL (vector cosine)
  ┌─ Storage + provider layer ▼──────────────────────────────┐
  │  Postgres pgvector (chunks: docs + kind=memory)           │
  │  Ollama: gemma2:9b (gen) · nomic-embed-text (768-dim)     │
  └──────────────────────────────────────────────────────────┘
```

## The dominant shape: single-agent

This codebase exercises exactly one of the three agent shapes:

- **Workflow / chain** — no. The model chooses whether and what to
  search; the steps are not written by the engineer.
- **Single-agent** — **yes, this is it.** One `RagQueryAgent`
  (`node_modules/@rlynjb/aptkit-core/.../agent-rag-query/dist/src/rag-query-agent.js`)
  runs one bounded ReAct loop (`runAgentLoop`,
  `.../runtime/dist/src/run-agent-loop.js`) with one read-only tool.
- **Multi-agent** — no. There is one actor. No supervisor, no
  workers, no handoff, no topology. The two-brain laptop+phone vision
  in `agent-layer-plan.md` is design-only.

So SECTION A (reasoning patterns) and SECTION B (agentic retrieval)
carry the weight here — they describe what this repo actually runs.
SECTION C (multi-agent orchestration) is taught as study material and
honestly marked "Not yet implemented" where it does not apply; the
SECTION F templates name the refactor that would adopt each topology.

## What this repo actually runs (the one-line tour)

1. The Ink TUI holds one conversation in-process and calls
   `session.ask(q)` per turn (`src/cli/chat.tsx:15`).
2. The session persists the user turn, runs the agent, flushes the
   trajectory, and remembers the exchange (`src/session.ts:60-70`).
3. The agent runs a **bounded ReAct loop**: up to 6 turns, up to 4
   tool calls, and a **forced synthesis** on the final turn — the
   loop strips tools and tells the model "you have NO more tool calls"
   (`runAgentLoop`, `run-agent-loop.js:25-35`).
4. The only tool is `search_knowledge_base` (read-only) — the
   smallest possible blast radius (`ragQueryToolPolicy`,
   `rag-query-agent.js:8-11`).
5. Tool-calling is **emulated**: Gemma has no native tools, so aptkit
   renders the tool schema into the system prompt and parses a JSON
   tool call back out (`gemma-provider.js:82-125`).
6. Every turn is captured as a full-signal trajectory into
   `agents.messages` (`src/supabase-trace-sink.ts:49-94`), and the
   exchange is embedded into the same vector store as episodic memory
   recalled by relevance on future turns (`src/session.ts:53,67`).

## The honest memory distinction (read this twice)

buffr-laptop has **retrieval-based episodic memory** but **not**
conversational-context threading:

- **Relevance recall — yes.** After each turn, the exchange is
  embedded and stored tagged `kind=memory`; future turns surface
  relevant past exchanges through the same `search_knowledge_base`
  tool, across sessions (`createConversationMemory`,
  `conversation-memory.js`).
- **In-prompt turn history — no.** `RagQueryAgent.answer()` builds its
  message array fresh each call (`messages: [{ role: 'user', content:
  userPrompt }]`, `run-agent-loop.js:22`). It does NOT thread the
  prior turns into the prompt. Each question is answered
  independently. The session comment names this gap honestly
  (`src/session.ts:25-27`).

So buffr "remembers" by retrieving, not by carrying the conversation
forward in the window. That distinction runs through the whole guide.

## Reading order

A → B → D first (they describe the running system), then C and E
(study material for what's deferred), then F (the interview
templates). Start with:

1. `01-reasoning-patterns/02-agent-loop-skeleton.md` — the kernel
   every other file refers back to.
2. `01-reasoning-patterns/03-react.md` — what the running loop is.
3. `02-agentic-retrieval/01-agentic-rag.md` — retrieval as the loop's
   one tool.
4. `04-agent-infrastructure/02-agent-memory-tiers.md` — the memory
   model and its honest gap.
5. `agent-patterns-in-this-codebase.md` — the patterns table.

## See also

- `agent-patterns-in-this-codebase.md` — the patterns this repo uses
- `.aipe/study-system-design/00-overview.md` — the system map
- `.aipe/study-prompt-engineering/` — the prompt-level mechanics
- `.aipe/study-security/04-least-privilege-tool-scope.md` — the
  single-tool blast radius from the security angle
