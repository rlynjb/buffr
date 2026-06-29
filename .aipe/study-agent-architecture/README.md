# Agent Architecture Guide — buffr-laptop

Index and reading order. This guide studies one repo — `buffr-laptop` — through the
agent-architecture lens. Start with `00-overview.md`, then walk the sub-sections A → F,
then close with the per-codebase pattern summary.

## What buffr is, in one line

A **single-agent bounded ReAct loop** over local Gemma2:9b — one read-only search tool, a
hard turn/tool-call budget, a forced final synthesis, and retrieval-based episodic memory.
Not a chain. Not multi-agent.

## Reading order

```
  00-overview.md                      ← read first: verdict + whole-system frame
        │
        ▼
  01-reasoning-patterns/              ← how the ONE model thinks (A)
  02-agentic-retrieval/               ← retrieval as the loop's tool (B)
  03-multi-agent-orchestration/       ← above one agent — mostly not-yet (C)
  04-agent-infrastructure/            ← context, memory, tools, eval, control (D)
  05-production-serving/              ← serving a loop, not one call (E)
  06-orchestration-system-design-templates/  ← interview reframings (F)
        │
        ▼
  agent-patterns-in-this-codebase.md  ← read last: what buffr actually runs
```

Within a sub-section most files are self-contained; the recommended cross-section order is
A → B → C → D → E → F.

## File map

- `00-overview.md` — verdict, whole-system diagram, top findings, not-yet-exercised.
- `01-reasoning-patterns/` — chains-vs-agents boundary, the agent-loop skeleton, ReAct
  placement, and the not-yet escalation ladder (plan-execute, reflexion, ToT, routing).
- `02-agentic-retrieval/` — agentic RAG (this is the loop buffr runs), self-corrective RAG,
  retrieval routing.
- `03-multi-agent-orchestration/` — the "when NOT to" gate plus the topology catalogue,
  almost all marked not-yet-implemented for buffr.
- `04-agent-infrastructure/` — context engineering (profile-as-standing-context), the
  three memory tiers, tool calling + MCP, agent evaluation, guardrails + control envelope.
- `05-production-serving/` — cross-turn caching, fan-out backpressure, per-tool circuit
  breaking — what changes once the unit is a loop.
- `06-orchestration-system-design-templates/` — the three generic interview templates, each
  with an honest "applies to buffr" verdict and the refactor that would adopt it.
- `agent-patterns-in-this-codebase.md` — the table of patterns buffr actually exercises.

## Cross-links to sibling guides

This guide cross-references rather than duplicates. Where a mechanic lives in another guide,
the concept file's `See also` block points there:

- **`study-ai-engineering`** — ReAct Thought-Action-Observation mechanics, tool-calling
  mechanics, RAG/embeddings/vector-DB mechanics, agent-memory two-layer split, LLM-as-judge
  bias, single-call caching/cost/retry. This guide covers the agent-architecture angle on
  top (placement, control loop, topology, trajectory).
- **`study-prompt-engineering`** — the self-critique prompt mechanics, the system-prompt
  shape, the emulated-JSON tool-call prompt.
- **`study-security`** — capability scoping as least-privilege, prompt-injection blast
  radius, the read-only-tool trust boundary.
- **`study-system-design`** — the request flow, the local-canonical-plus-cloud-mirror
  storage story, state ownership across the warm session.
