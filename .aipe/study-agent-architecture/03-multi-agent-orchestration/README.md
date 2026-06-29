# Multi-Agent Orchestration — above one agent

*Anchor: **multi-agent** (the primary term). Type label: mostly study material — buffr is single-agent, so almost every file here is a design target, not a shipped pattern.*

## State this up front

**buffr is a single-agent bounded ReAct loop. It is not multi-agent and does not run any
topology in this sub-section.** That is the honest, correct verdict — not a gap. A clean
single-agent loop that hasn't hit its quality ceiling has *no business* paying multi-agent
overhead. So read this whole sub-section as two things at once: (1) the topology catalogue
every AI engineer must be able to draw and place, and (2) a set of *design targets* buffr
could grow into if and when a single specific failure forces it.

The one file here that is partly *decided* rather than deferred is `01` — the "when NOT to
go multi-agent" gate. That file is the senior move: "I considered multi-agent and chose not
to, here's the measured reason." Everything after it is the catalogue you'd reach into *only*
after that gate opens.

## Reading order — the gate comes first by design

```
  03-multi-agent-orchestration/ — read the GATE before the catalogue

  01-when-not-to-go-multi-agent.md   ← READ FIRST. The escalation gate.
        │                              "Is the failure decomposable into
        │                               independent specialties?" If no → stop.
        ▼
  ┌─ THE TOPOLOGY CATALOGUE (all not-yet for buffr) ───────────────┐
  │                                                                │
  │  02-supervisor-worker.md     ← most common; start here         │
  │  03-sequential-pipeline.md   ← a .then() chain of agents        │
  │  04-parallel-fan-out.md      ← Promise.all of agents + merge    │
  │  05-debate-verifier-critic.md← producer/critic                  │
  │  06-swarm-handoff.md         ← peer-to-peer, no boss            │
  │  07-graph-orchestration.md   ← the state machine that makes     │
  │                                 ALL the above inspectable        │
  │  08-shared-state-and-message-passing.md ← how agents share data │
  │  09-coordination-failure-modes.md ← the failures NONE of the    │
  │                                 above have in single-agent form  │
  └────────────────────────────────────────────────────────────────┘
```

Read `01` first, always. If you only read one file in this sub-section, read that one — the
ability to *decline* multi-agent with a measured reason is worth more in an interview than
the ability to draw all six topologies.

## File map

- `01-when-not-to-go-multi-agent.md` — the escalation gate; buffr's verdict (stay single).
  Partly implemented-as-a-decision.
- `02-supervisor-worker.md` — manager component delegating to children; tools-style vs
  handoff-style. The natural refactor for buffr's deferred two-brain split.
- `03-sequential-pipeline.md` — a `.then()` chain of single-purpose agents. buffr's *session*
  outer flow is pipeline-shaped, but those are functions, not agents.
- `04-parallel-fan-out.md` — `Promise.all()` over independent agents, then a merge.
- `05-debate-verifier-critic.md` — producer/critic and debate; shared-blind-spot risk.
- `06-swarm-handoff.md` — peer-to-peer control transfer with no central boss.
- `07-graph-orchestration.md` — control flow as an explicit, checkpointed state machine; the
  topology that makes the others inspectable and enables human-in-the-loop pauses.
- `08-shared-state-and-message-passing.md` — blackboard vs message passing; context bloat.
- `09-coordination-failure-modes.md` — the failures that don't exist in single-agent systems,
  each with its mitigation; makes the "2–5x overhead" concrete.

## The one bridge to carry through every file

Multi-agent is just **N copies of Section A's agent-loop skeleton, composed.** Each worker is
its own `runAgentLoop` (`run-agent-loop.ts:76-202`). The topologies differ only in *how the
N loops are wired*: truly independent loops (fan-out), or a dependency DAG with an
orchestrator and a merge (everything else). buffr runs exactly one of those loops, once. The
deferred two-brain laptop+phone split (`agent-layer-plan.md`, design-only) is the first place
buffr would become N>1.

## Cross-links

- **Section A (`01-reasoning-patterns/`)** — the single-loop skeleton each agent here is a
  copy of; the escalation discipline ("don't escalate on spec") that `01` here extends.
- **Section F (`06-orchestration-system-design-templates/`)** — the system-design templates
  every "not yet" file points to for the actual refactor shape.
- **`study-ai-engineering`** — LLM-as-judge bias (cross-ref from `05-debate-verifier-critic`).
