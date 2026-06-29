# Agent Architecture — buffr-laptop

One page to orient before you open anything else. This guide studies `buffr-laptop`
through the agent-architecture lens: reasoning patterns, agentic retrieval, multi-agent
orchestration, the cross-cutting infrastructure, and production serving for a loop.

## The verdict first

buffr is a **single-agent bounded ReAct loop** over a local Gemma2:9b. One actor, one
read-only tool, a hard turn budget, and a forced final answer. It is not a chain (the
model decides whether and what to search), and it is not multi-agent (there is exactly one
loop). That single sentence is the spine of everything below.

```
  Where buffr sits on the three-shapes map

  ┌──────────────────┬───────────────────────────────────────┐
  │ Workflow / chain │ engineer writes the steps; LLM fills   │
  │                  │ slots, never chooses next       — NO   │
  ├──────────────────┼───────────────────────────────────────┤
  │ Single-agent     │ one ReAct loop with one tool; the      │
  │   ★ buffr ★       │ model decides search-or-answer  — YES  │
  ├──────────────────┼───────────────────────────────────────┤
  │ Multi-agent      │ many agents in a topology       — NO   │
  │                  │ (deferred / design-only)               │
  └──────────────────┴───────────────────────────────────────┘
```

## The whole system in one frame

The full request path, from a keystroke in the terminal to a grounded answer and a
remembered exchange.

```
  buffr-laptop — one turn, end to end

  ┌─ UI layer (Ink / React-in-terminal) ──────────────────────────┐
  │  src/cli/chat.tsx — TextInput → onSubmit(q)                    │
  └───────────────────────────┬───────────────────────────────────┘
                              │  session.ask(q)
  ┌─ Session layer ───────────▼───────────────────────────────────┐
  │  src/session.ts — warm pool, one conversation, agent built once│
  │   1. persist user turn   2. agent.answer(q)   3. remember()    │
  └───────────────────────────┬───────────────────────────────────┘
                              │  RagQueryAgent.answer
  ┌─ Agent layer (@aptkit, consumed not edited) ──────────────────┐
  │  RagQueryAgent → runAgentLoop                                  │
  │   maxTurns:6 · maxToolCalls:4 · forced synthesis on last turn  │
  │        │ model picks: search_knowledge_base OR final answer    │
  │        ▼                                                       │
  │  GemmaModelProvider (tool calls EMULATED as JSON)             │
  └──────────┬─────────────────────────────────┬──────────────────┘
             │ search_knowledge_base            │ trace events
  ┌─ Storage layer ──────────▼──────┐  ┌────────▼──────────────────┐
  │  PgVectorStore (pgvector, 768d) │  │ SupabaseTraceSink          │
  │   chunks: docs + memory rows    │  │  agents.messages           │
  │   recalled by cosine similarity │  │  (full-signal trajectory)  │
  └─────────────────────────────────┘  └───────────────────────────┘
```

## The three findings that matter most

1. **Forced synthesis is the load-bearing mechanic.** On the last turn (or once the
   tool-call budget is spent), `runAgentLoop` strips the tools and appends a "you have NO
   more tool calls" instruction (`run-agent-loop.ts:101-109`,
   `:72-74`). That guarantees the loop always exits with a real answer instead of cycling
   tool calls forever. The budget exit, not the success exit, is what makes this a shipped
   agent.

2. **Capability scope is exactly one read-only tool — the smallest possible blast
   radius.** `ragQueryToolPolicy` allows only `search_knowledge_base`
   (`rag-query-agent.ts:15-18`), and `filterToolsForPolicy` hands the model nothing else
   (`tool-policy.ts:11-23`). The agent can read the knowledge base and nothing more — no
   writes, no side effects, nothing to inject into.

3. **Memory is retrieval-recall, not conversational threading — and the code is honest
   about the gap.** Each exchange is embedded into the same vector store and resurfaces by
   relevance across sessions (`conversation-memory.ts:60-108`,
   `session.ts:53,66`). But `RagQueryAgent.answer` treats every question independently —
   there is no in-prompt turn history. Relevance-recall: yes. Conversational-context-
   threading: no.

## Not yet exercised

Honest gaps — patterns this guide teaches as study material that buffr does not run:

- **Multi-agent orchestration** (supervisor-worker, pipeline, fan-out, debate, swarm,
  graph). One loop, no topology. Deferred / design-only (the two-brain laptop+phone split).
- **Plan-and-execute, reflexion/self-critique, tree-of-thoughts.** buffr is plain ReAct;
  single-agent has not hit a quality ceiling that would justify escalating.
- **In-prompt conversational threading.** Relevance-recall stands in for it today.
- **MCP.** Tools are wired directly via `InMemoryToolRegistry`; no protocol layer.
- **Trajectory evaluation.** The trajectory is *captured* (full-signal in `agents.messages`)
  but not yet *scored* — only precision@k over retrieval is evaluated.

## Reading order

`00-overview` (here) → `01-reasoning-patterns` → `02-agentic-retrieval` →
`03-multi-agent-orchestration` → `04-agent-infrastructure` → `05-production-serving` →
`06-orchestration-system-design-templates` → `agent-patterns-in-this-codebase.md`.

See `README.md` for the indexed file list and cross-links into the sibling guides
(`study-ai-engineering`, `study-prompt-engineering`, `study-security`, `study-system-design`).
