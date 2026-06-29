# 04 — Agents and Tool Use

**Anchor:** LLM application engineering. buffr's `RagQueryAgent` is a bounded single-agent loop with one tool.

The whole reason buffr has an "agent" and not just a "chain" is that it lets the *model* decide whether and how to retrieve. That decision is the value and the risk.

```
  buffr's agent loop in one picture

  question
    │
    ▼
  ┌──────────── runAgentLoop (aptkit) ─────────────┐
  │  for turn in 0..maxTurns(6):                    │
  │    forceFinal = lastTurn || toolCalls>=4        │
  │    response = model.complete(system, tools?)    │
  │    if no tool-call → finalText, break           │
  │    else run search_knowledge_base, feed result  │
  │  (forced synthesis turn: no tools, "answer now")│
  └──────────────────────┬──────────────────────────┘
                         ▼
                      answer
```

## Reading order

1. `01-agents-vs-chains.md` — the loop vs the pipeline; buffr's maxTurns/maxToolCalls/forced-synthesis. **The structural file.**
2. `02-tool-calling.md` — the tool-call contract and the Gemma emulation seam. **The reliability file.**
3. `03-react-pattern.md` — Thought→Action→Observation, and how aptkit's loop is a ReAct variant.
4. `05-agent-memory.md` — short-term (none, today) vs long-term (retrieval-based episodic). **buffr-specific.**
5. `06-error-recovery.md` — the budget hard-stop, best-effort memory, what's missing.
6. `04-tool-routing.md` — heuristic vs LLM routing (buffr is single-tool, so this is mostly study).

## Exercised vs not

**Exercised:** the bounded loop, tool-calling (emulated), ReAct-shaped reasoning, long-term episodic memory, the iteration hard-stop.

**Not yet exercised:** tool routing (one tool, nothing to route), short-term in-prompt turn history, structured error-recovery beyond the budget cap and the best-effort memory swallow. Each file says so.

## See also

- `../03-retrieval-and-rag/11-rag.md` — what the one tool actually does.
- `.aipe/study-agent-architecture/` — the deeper reasoning-pattern and orchestration treatment.
