# A — Reasoning Patterns

*Sub-section index — Industry standard + Project-specific.*

How the ONE model in buffr thinks. This is Section A of the agent-architecture guide:
the reasoning loop that runs inside a single turn, the patterns layered on top of it, and
the patterns buffr deliberately does **not** run yet.

## Where this section sits

This whole sub-section lives inside the agent layer of buffr's stack — one box on the
overview map, expanded.

```
  buffr's stack — Section A is one layer, exploded

  ┌─ UI (Ink) ────────────────────────────────────────────────┐
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Session (chain-like orchestration) ─▼─────────────────────┐
  │  persist → answer → remember         (file 01 lives here)  │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Agent layer ─ ★ SECTION A ★ ─────────▼────────────────────┐
  │  RagQueryAgent → runAgentLoop                              │
  │   ┌─────────────────────────────────────────────────────┐ │
  │   │ THE REASONING LOOP   (files 02, 03 — IMPLEMENTED)   │ │
  │   │  step → execute → accumulate → terminate            │ │
  │   ├─────────────────────────────────────────────────────┤ │
  │   │ ESCALATIONS ON TOP   (files 04-06 — NOT YET)        │ │
  │   │  plan-execute · reflexion · tree-of-thoughts        │ │
  │   ├─────────────────────────────────────────────────────┤ │
  │   │ ROUTING            (file 07 — degenerate, 1 tool)   │ │
  │   └─────────────────────────────────────────────────────┘ │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Storage (pgvector + trace) ─────────▼─────────────────────┐
  └────────────────────────────────────────────────────────────┘
```

buffr runs exactly one of these patterns: a bounded ReAct loop. Everything else in this
section is here so you can name what you'd reach for next — and, more importantly, defend
why you haven't reached for it yet.

## Reading order

Read 01 → 02 → 03 first; those three teach the pattern buffr actually runs. The rest are
study material for patterns buffr does not implement.

```
  01-chains-vs-agents.md       ← the boundary: pipeline outside, loop inside
        │
        ▼
  02-agent-loop-skeleton.md    ← THE kernel: step+execute+accumulate+terminate   [IMPLEMENTED]
        │
        ▼
  03-react.md                  ← placement: buffr is plain ReAct, measured        [IMPLEMENTED]
        │
        ▼
  04-plan-and-execute.md       ← escalation rung 1                                [NOT YET]
  05-reflexion-self-critique.md ← escalation rung 2                               [NOT YET]
  06-tree-of-thoughts.md       ← escalation rung 3 (rarely worth it)             [NOT YET]
        │
        ▼
  07-routing.md                ← bridge from A (pick a tool) to C (pick an agent) [MINIMAL]
```

## The one-line anchor for this section

buffr's reasoning shape is **single-agent** (primary anchor) and only **chain-like at the
outermost orchestration layer** (secondary anchor). The model chooses search-or-answer
inside a bounded loop; the engineer chose the persist→answer→remember sequence around it.

## File map

- `01-chains-vs-agents.md` — the boundary. buffr is a hybrid: chain outside, agent loop
  inside. The verdict, with the seam named.
- `02-agent-loop-skeleton.md` — the load-bearing file. The four-part kernel, each part
  named by what breaks if you remove it, with the two-exit termination as the central
  insight.
- `03-react.md` — ReAct placement (not a re-teach of Thought-Action-Observation). buffr
  defaults to ReAct with measured controls (maxTurns:6, maxToolCalls:4).
- `04-plan-and-execute.md` — *Not yet implemented.* Teaches the pattern + the refactor
  path.
- `05-reflexion-self-critique.md` — *Not yet implemented.* The critic loop and its cost.
- `06-tree-of-thoughts.md` — *Not yet implemented*, and rarely worth it — covered so you
  can say why buffr correctly skips it.
- `07-routing.md` — buffr's degenerate single-tool route; the bridge to multi-agent.

## Cross-links to sibling guides

- **`study-ai-engineering`** — `agents-vs-chains` (the mechanics this section's file 01
  references), ReAct Thought-Action-Observation mechanics.
- **`study-prompt-engineering`** — the self-critique prompt mechanics (file 05), the
  emulated-JSON tool-call prompt (file 02).
