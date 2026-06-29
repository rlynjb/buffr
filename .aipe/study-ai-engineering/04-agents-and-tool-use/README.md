# 04 — Agents and Tool Use

The section where buffr stops being a search box and starts being an agent: a model that decides, in a loop, when to reach for a tool and when to stop and answer.

This is the *agentic* layer of the codebase. Below it sits retrieval (`03-retrieval-and-rag/`) — embeddings, pgvector, the ANN search that the one tool wraps. Above it sits evaluation (`05-evals-and-observability/`) — how you prove the loop actually answers. This section is the middle: the control structure that turns "search returns chunks" into "agent answers a question."

One honest framing up front, because it shapes every file here. buffr runs on `gemma2:9b`, a local model with **no native tool-calling**. Every tool call in this codebase is *emulated*: schemas rendered into the system prompt as JSON, the model asked to reply with a JSON object, that object hand-parsed back out. There is **no argument-schema validation** on the parsed call. That single fact is the reliability ceiling of the whole agent, and `02-tool-calling.md` names it bluntly. If you read one file, read that one.

## Phase 4 anchor

These concept files map to the Phase 4 build track (C4.1–C4.12). Exercises in each file cite `[B4.x]` build tasks.

```
The agentic stack in buffr
┌──────────────────────────────────────────────────────────────┐
│  05  evals + observability   prove the loop answers            │  ← above
├──────────────────────────────────────────────────────────────┤
│  04  AGENTS + TOOL USE       the loop, tool calls, ReAct, ★    │  ← you are here
│      memory, routing, recovery                                 │
├──────────────────────────────────────────────────────────────┤
│  03  retrieval + RAG         embeddings, pgvector, the tool    │  ← below
└──────────────────────────────────────────────────────────────┘
```

Each file teaches the standard pattern first, then anchors it to real code in buffr / aptkit at `file:line`. Diagrams lead.

## Reading order

Read in build order — each file assumes the one before it.

1. **`01-agents-vs-chains.md`** — chain (fixed steps) vs agent (LLM-decided loop). The verdict: buffr is the **hybrid** — fixed pipeline outside, bounded ReAct loop inside. Anchors the agent loop (`runAgentLoop`) and the bounded agent (`RagQueryAgent`). Start here; it introduces the kernel every other file leans on.
2. **`02-tool-calling.md`** — the emulated JSON path (`GemmaModelProvider`). The richest file: schemas-into-prompt outbound, hand-parse inbound, the one retry nudge, and **the no-argument-validation reliability ceiling**. Read this even if you read nothing else.
3. **`03-react-pattern.md`** — the ReAct pattern (gather-then-synthesize). buffr's version: a tool turn that gathers, then a *forced* final turn that synthesizes. Anchors `forceFinal` and `buildSynthesisInstruction`.
4. **`04-tool-routing.md`** — heuristic vs LLM routing. buffr has exactly one tool, so routing-by-name is trivial; the *real* routing decision is gather-vs-synthesize. Honest: trivial today, exercise makes it real.
5. **`05-agent-memory.md`** — short-term (in-context, one `answer()` call) vs long-term (retrieved episodic via `@aptkit/memory`). Anchors `createConversationMemory`. The honest gap: no cross-turn in-prompt history.
6. **`06-error-recovery.md`** — failure modes and the recovery table. Anchors the try/catch→observation path and the hard stops (`maxTurns`, `maxToolCalls`, forced synthesis). Honest gaps: no loop detection, no per-tool timeout, one-shot retry.

## Cross-links

- **`../03-retrieval-and-rag/`** — what the one tool actually does. The agent loop is the *caller*; retrieval is the *callee*.
- **`../05-evals-and-observability/`** — the trace sink that captures every `tool_call_start` / `tool_call_end` the loop emits, and the eval set that proves the loop answers.
- **`study-agent-architecture`** (`/aipe:study-agent-architecture`) — reasoning patterns and agentic retrieval at the architecture level; this section is the code-level cut.
- **`study-runtime-systems`** (`/aipe:study-runtime-systems`) — the execution model under the loop: bounded work, cancellation via `AbortSignal`, the turn budget as a scheduler.

## Where the agent code lives (quick map)

```
aptkit packages/runtime/src/run-agent-loop.ts       runAgentLoop — THE kernel
aptkit packages/agents/rag-query/src/
        rag-query-agent.ts                          RagQueryAgent — buffr's bounded agent + policy
aptkit packages/providers/gemma/src/
        gemma-provider.ts                           GemmaModelProvider — the emulated tool path
aptkit packages/runtime/src/json-output.ts          parseAgentJson — the inbound parser
aptkit packages/memory/src/conversation-memory.ts   createConversationMemory — episodic memory
aptkit packages/tools/src/tool-policy.ts            filterToolsForPolicy — least privilege
aptkit packages/retrieval/src/
        search-knowledge-base-tool.ts               the ONE tool the agent may call
buffr   src/session.ts                              createChatSession — wires it all, best-effort memory
```
