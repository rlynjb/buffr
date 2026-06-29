# Agent architecture study guide — buffr-laptop

A topic-focused companion to `/aipe:study` covering everything *above
one agent*: reasoning patterns beyond ReAct, retrieval as a control
loop, and multi-agent orchestration topologies. Per-repo, for
buffr-laptop.

**Codebase shape: single-agent.** One `RagQueryAgent` running a bounded
ReAct loop (`maxTurns:6` / `maxToolCalls:4`, forced synthesis) over one
read-only tool (`search_knowledge_base`) against a local Gemma2:9b.
SECTION A (reasoning) and SECTION B (agentic retrieval) describe what
buffr runs; SECTION C (multi-agent) is study material, honestly marked
"Not yet implemented" where it doesn't apply.

## Start here

- `00-overview.md` — the whole agent surface in one map + the shape
- `agent-patterns-in-this-codebase.md` — the patterns this repo uses

## Recommended cross-sub-section order: A → B → D → C → E → F

A and B describe the running system; D is the cross-cutting
infrastructure it exercises; C and E are study material for what's
deferred; F is the interview framing.

## Sub-sections

```
  01-reasoning-patterns/        SECTION A — how one model thinks
  02-agentic-retrieval/         SECTION B — retrieval as a control loop
  03-multi-agent-orchestration/ SECTION C — everything above one agent
  04-agent-infrastructure/      SECTION D — context, memory, tools, eval, control
  05-production-serving/        SECTION E — serving a loop / topology
  06-orchestration-system-design-templates/  SECTION F — buffr as interview templates
```

## The five-minute path

1. `01-reasoning-patterns/02-agent-loop-skeleton.md` — the kernel
   everything refers back to.
2. `01-reasoning-patterns/03-react.md` — the pattern buffr runs.
3. `02-agentic-retrieval/01-agentic-rag.md` — the loop's one tool.
4. `04-agent-infrastructure/02-agent-memory-tiers.md` — the memory model
   and its honest gap (relevance recall yes, threading no).
5. `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — why
   buffr is correctly single-agent.

## Cross-links to sibling guides

- `.aipe/study-system-design/` — request flow, vector store, trajectory
  capture, retrieval-as-memory
- `.aipe/study-prompt-engineering/` — the three-owner prompt assembly
- `.aipe/study-security/` — least-privilege tool scope, indirect prompt
  injection surface
- `study-ai-engineering/` — *not yet generated in this repo*; this guide
  cross-references its canonical paths (ReAct/RAG/tool-calling/memory
  mechanics) where they would live.
