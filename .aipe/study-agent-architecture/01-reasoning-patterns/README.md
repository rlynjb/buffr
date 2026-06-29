# SECTION A — Reasoning patterns

Anchor: single-agent (primary) · workflow (secondary).

How one model thinks through a task — the substrate every orchestration
topology sits on. This is the richest section for buffr, because buffr's
running system is exactly a single-agent reasoning loop.

## Reading order

1. `01-chains-vs-agents.md` — the autonomy boundary (buffr is a chain
   wrapping an agent). **Exercised.**
2. `02-agent-loop-skeleton.md` — the kernel every pattern instantiates;
   read this before the rest. **Exercised** (`runAgentLoop`).
3. `03-react.md` — the pattern buffr actually runs. **Exercised.**
4. `04-plan-and-execute.md` — first escalation target. *Not yet
   implemented.*
5. `05-reflexion-self-critique.md` — quality escalation. *Not yet
   implemented (bundle has the pieces).*
6. `06-tree-of-thoughts.md` — recognized, deliberately not used.
7. `07-routing.md` — the bridge to SECTION C. *Partial (in-loop, one
   tool).*

Files 1-3 describe buffr's running system; 4-7 are the escalation ladder
and the bridge, taught as study material with honest "Not yet
implemented" notes.
