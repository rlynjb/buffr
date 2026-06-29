# D — Agent Infrastructure

*Sub-section index — Industry standard + Project-specific.*

The cross-cutting disciplines: the parts that separate a demo from a shipped system. Sections
A–C are about how the agent *thinks* (reasoning, retrieval, orchestration). This section is
about everything *around* the thinking that has to be true for it to run in production —
what the model sees, what it remembers, what it can touch, what gets recorded, and what stops
it. None of these are the agent. All of them decide whether the agent ships.

## Where this section sits

These five concerns wrap the loop on every side. They are not a layer *below* the agent or
*above* it — they are the envelope it runs inside.

```
  buffr's stack — Section D is the envelope around the loop

  ┌─ CONTEXT ENGINEERING (file 01) ─ what the model SEES ───────────┐
  │  profile + instructions + messages array + tool outputs        │
  │ ┌─ AGENT MEMORY (file 02) ─ what it REMEMBERS ────────────────┐ │
  │ │  working (in-context) · episodic (recall) · long-term docs  │ │
  │ │ ┌─ ★ THE AGENT LOOP (Sections A–C) ★ ─────────────────────┐ │ │
  │ │ │  step → execute → accumulate → terminate                │ │ │
  │ │ │ ┌─ TOOL CALLING + MCP (file 03) ─ what it can TOUCH ──┐  │ │ │
  │ │ │ │  emulated JSON tool calls · InMemoryToolRegistry    │  │ │ │
  │ │ │ └─────────────────────────────────────────────────────┘  │ │ │
  │ │ └─────────────────────────────────────────────────────────┘ │ │
  │ └─────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────┘
   ┌─ EVALUATION (file 04) ─ what gets RECORDED ────────────────────┐
   │  the trajectory: 6 event types persisted for replay            │
   └────────────────────────────────────────────────────────────────┘
   ┌─ GUARDRAILS + CONTROL (file 05) ─ what STOPS it ───────────────┐
   │  maxTurns:6 · maxToolCalls:4 · forced synthesis · 1 read tool  │
   └────────────────────────────────────────────────────────────────┘
```

Files 01, 02, 03, 05 are IMPLEMENTED in buffr. File 04 is half-implemented: the trajectory is
captured but not yet evaluated. Each file names exactly where buffr stops.

## Reading order

```
  01-context-engineering.md     ← what the model SEES per call          [IMPLEMENTED]
        │                          profile-as-standing-context + the guard
        ▼
  02-agent-memory-tiers.md      ← what it REMEMBERS across calls        [PARTIAL]
        │                          working / episodic / long-term; honest distinction
        ▼
  03-tool-calling-and-mcp.md    ← what it can TOUCH                     [tool calling: YES]
        │                          the emulated JSON path; MCP is the gap [MCP: NOT YET]
        ▼
  04-agent-evaluation.md        ← what gets RECORDED                    [capture: YES]
        │                          the trajectory is the unit, not the answer [eval: NOT YET]
        ▼
  05-guardrails-and-control.md  ← what STOPS it                         [IMPLEMENTED]
                                   the control envelope; smallest blast radius
```

Read 01 first — it carries the reframe that the rest of the section rests on: **most agent
failures are context failures, not model failures.** Read 05 last; it is where the bounds
from Section A get named as a security property, not just a termination property.

## The one-line anchor for this section

buffr is a **single-agent** system, so each discipline here has a single-agent shape *and* a
multi-agent shape — and the file names both. Context engineering for one agent is a system
prompt; for a fleet it is shared-context routing. Memory for one agent is one vector store;
for a fleet it is a contended resource. Tool calling for one agent is an in-process registry;
for a fleet it is MCP. Evaluation for one agent is one trajectory; for a fleet it is
inter-agent handoff scoring. Guardrails for one agent are a budget; for a fleet they are a
supervisor. buffr ships the single-agent shape of every one of these. The multi-agent shape is
named so you can defend why buffr does not need it yet.

## File map

- `01-context-engineering.md` — *Implemented.* profile-as-standing-context (the me.md profile
  injected into every system prompt), the messages array + tool outputs, and the
  `ContextWindowGuardedProvider` `maxTokens:8192` guard. The reframe: agent failures are
  context failures.
- `02-agent-memory-tiers.md` — *Implemented (partially).* The three tiers; buffr's working tier
  (the messages array) and episodic tier (`createConversationMemory`, retrieval-recall across
  sessions). The load-bearing honest distinction: relevance-recall YES, in-prompt
  conversational threading NO.
- `03-tool-calling-and-mcp.md` — *Tool calling implemented (emulated JSON path); MCP not yet.*
  Tool calling as the substrate under ReAct and agentic RAG. MCP as the standardization buffr
  does not have, and the tradeoff buffr accepts by wiring tools in-process.
- `04-agent-evaluation.md` — *Trajectory captured, not yet evaluated.* The unit is the
  trajectory, not the final output. buffr persists all 6 event types for replay but only scores
  precision@k over retrieval. Capture yes, eval no.
- `05-guardrails-and-control.md` — *Implemented.* The control envelope: iteration cap, tool
  budget, forced synthesis, and capability scoping to one read-only tool — the smallest blast
  radius. No human gate, because nothing the agent does has a side effect.

## Cross-links to sibling guides

This section covers the *agent-architecture angle* of each discipline. The mechanics live in
the sibling guides — do not re-teach them here:

- **`study-ai-engineering`** — context-window / lost-in-the-middle, the two-layer agent-memory
  split, tool-calling mechanics, LLM-as-judge bias, the eval harness mechanics.
- **`study-security`** — prompt-injection per-call defense and blast-radius analysis (file 05's
  capability-scoping note is the agent-architecture half of that story).
- **`study-agent-architecture/01-reasoning-patterns/`** — the loop these disciplines wrap;
  `02-agent-loop-skeleton.md` is where the bounds in file 05 first appear as termination.
