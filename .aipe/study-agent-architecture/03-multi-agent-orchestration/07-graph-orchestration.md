# Graph Orchestration

*Industry names: **graph orchestration** / **stateful graph** / **agent state machine** / **LangGraph-style orchestration**. Type label: Industry standard. In this codebase: **Not yet implemented.** (buffr's loop freewheels within caps; there is no explicit graph.)*

## Zoom out, then zoom in

This is the topology that makes all the others *inspectable*: control flow written as an explicit
state machine — named nodes, named edges, checkpointed state. Here is the SHAPE first.

```
  THE TOPOLOGY — an explicit graph of nodes + edges over checkpointed state (★ = a node)

        ┌──────────┐  edge   ┌──────────┐  edge   ┌──────────┐
   ──▶  │ ★ NODE    │────────▶│ ★ NODE    │────────▶│ ★ NODE    │──▶ done
        │ retrieve  │         │ decide    │         │ answer    │
        └──────────┘         └────┬─────┘         └──────────┘
                                  │ conditional edge
                                  ▼
                            ┌──────────┐
                            │ HUMAN    │  ← pause / resume (checkpoint here)
                            │ approve  │
                            └──────────┘
   STATE is checkpointed at every node → inspectable, resumable, pausable
```

The topology is the mental model: **a labeled directed graph you can point at — nodes are steps,
edges are transitions, and the state between them is saved.** This is what turns a freewheeling
loop into something you can inspect, replay, and *pause for a human*. The honest sentence: buffr
has no explicit graph — its loop transitions are implicit in the model's per-turn choice. This
file teaches the graph as the topology that makes orchestration legible.

## Structure pass

One axis: **state** — is control flow *implicit in the model* or *explicit in a structure you
own*?

```
  Axis = STATE · the SEAM is whether transitions are MODEL-decided or GRAPH-decided

  freewheeling loop (buffr)   the MODEL decides each transition; nothing is checkpointed
  ──────────── ★ SEAM: transitions become EXPLICIT, state CHECKPOINTED ★ ──────────
  graph orchestration         YOU define nodes/edges; state saved at each → inspectable,
                              resumable, human-pausable
```

This is the deepest seam in the sub-section. In buffr the "graph" is invisible — the model
decides at each turn whether to search again or answer, and there's no saved state between turns
you can inspect or resume from (just the in-memory `messages` array). Graph orchestration makes
the control flow a *first-class object you own*: you can draw it, log which node ran, checkpoint
the state, replay from a node, and — the killer feature — *pause at a node for human approval and
resume later*. That seam (implicit-model-control → explicit-owned-control) is what every serious
multi-agent system eventually crosses.

## How it works

### Move 1 — mental model

Control flow as an explicit state machine. Bridge from frontend: it's a multi-step form's UI
state machine — `step1 → step2 → review → submit`, with each transition a named edge and the
form's data the checkpointed state — except the nodes can be agents and an edge can be a model's
decision. You already think in this shape every time you build a wizard.

```
  THE SHAPE — nodes + edges + checkpointed state (a wizard, but nodes can be agents)

   ┌─ NODE retrieve ─┐ ─edge─▶ ┌─ NODE decide ─┐ ─conditional edge─┐
   │ run search       │        │ enough info?   │                   │
   └──────────────────┘        └───────┬────────┘          no ──────┘ (back to retrieve)
            ▲                          │ yes
            │ resume                   ▼
   ┌─ checkpoint ─┐           ┌─ NODE answer ─┐ ──▶ done
   │ STATE saved   │          └────────────────┘
   └───────────────┘
```

### Nodes — each is a step (often an agent)

A node does one unit of work and updates the shared state. A node can be a function, a single
model call, or a whole `runAgentLoop`. The graph doesn't care what's inside a node — it cares
about the *edges out of it*.

```
  Nodes — units of work over a shared state object

   state = { question, retrieved: [...], draft: "...", approved: false }
   ┌─ retrieve ─┐  reads state.question, writes state.retrieved
   ┌─ answer    ─┐  reads state.retrieved, writes state.draft
   ┌─ approve   ─┐  reads state.draft, writes state.approved (maybe after a human)
```

### Edges — transitions, including CONDITIONAL ones

Edges decide what runs next. A *static* edge always goes A→B. A *conditional* edge branches on
the state (or a model's decision) — this is where the graph encodes routing, loops, and retries
*explicitly* instead of burying them in a model's freewheeling choice.

```
  Edges — static vs conditional (the control flow you OWN)

  static:       retrieve ──────▶ answer            (always)
  conditional:  decide ──┬── enough? yes ──▶ answer
                         └── enough? no  ──▶ retrieve   (an explicit, bounded loop)
   the loop is now VISIBLE and bounded by the graph, not hidden in the model
```

Annotation: contrast with buffr — buffr *also* loops "retrieve again or answer," but that
decision is invisible, made by the model each turn, bounded only by the budget exit. A graph
makes that same loop an explicit conditional edge you can see, log, and bound structurally.

### Checkpointed state — the feature that unlocks human-in-the-loop

The state object is saved at every node. That's what makes the graph *pausable*: hit a
human-approval node, persist the state, stop, and resume from that exact checkpoint when the
human responds — minutes or days later.

```
  Checkpointing — why graphs enable human-in-the-loop pauses

   ... ─▶ NODE answer ─▶ [CHECKPOINT state] ─▶ NODE human_approve
                                                     │ PAUSE (state on disk)
                                              ... hours later ...
                                                     ▼ human clicks approve
                              [RESUME from checkpoint] ─▶ NODE finalize ─▶ done
```

Annotation: this is the capability buffr structurally cannot have today. buffr's state is the
in-memory `messages` array (`run-agent-loop.ts:94,124,189`) — it lives only for the duration of
one `answer()` call and vanishes after. There's no checkpoint to pause at and resume from. A
human-in-the-loop approval pause *requires* this graph topology (or something like it).

### What buffr does instead — an implicit loop, no graph

buffr's control flow is the bounded ReAct loop: the model freewheels (search or answer) each
turn, bounded by `maxTurns`/`maxToolCalls`, with no node/edge structure and no checkpoint.

```
  buffr (today)                    vs    graph orchestration (NOT YET)

  for turn in 0..6:                      explicit nodes + conditional edges
    model decides search|answer          state checkpointed at each node
    (implicit, in-memory messages)       pausable / resumable / inspectable
  run-agent-loop.ts:98-190               DESIGN-ONLY
```

Annotation: buffr's loop *freewheels within caps* — correct and shippable for a single-shot RAG
answer, but not inspectable or pausable. The graph isn't built because buffr has no need to pause
for a human or replay from a node; a personal-knowledge query runs to completion in one shot.
Not yet.

### Move 3 — the principle

**Graph orchestration trades implicit model-driven control for explicit owned control — and that's
what makes orchestration inspectable, resumable, and human-pausable.** Reach for it when you need
to *see* the control flow (debugging multi-agent runs), *replay* from a failure point, or *pause*
for a human approval. It's also the substrate that makes every other topology in this sub-section
legible — a supervisor, a pipeline, a fan-out are all easier to reason about as a graph. Don't
reach for it for a single-shot loop that runs to completion uninterrupted — that's buffr, and the
graph would be ceremony.

## Primary diagram

Full recap: nodes, edges, checkpoints, the human pause, the verdict.

```
  Graph orchestration — explicit, checkpointed, pausable control flow

   ┌─ retrieve ─┐─▶┌─ decide ─┐─ enough? no ─┐
   └────────────┘  └────┬─────┘              └─▶ (back to retrieve, bounded edge)
        ▲ resume        │ yes
        │          ┌─ answer ─┐─▶[CHECKPOINT]─▶┌─ human_approve ─┐─▶ done
   [STATE saved]   └──────────┘                └────────┬─────────┘
   at every node                                        │ PAUSE / RESUME
  ───────────────────────────────────────────────────────────────
  makes the OTHER topologies inspectable · enables human-in-the-loop
  buffr: NOT YET · implicit loop, in-memory state (run-agent-loop.ts:98-190)
  refactor template: SECTION F · stateful-graph template
```

Verdict in one line: **the topology that makes orchestration legible and pausable — explicit
nodes/edges over checkpointed state — and buffr's single-shot loop freewheels within caps with no
need for it yet.**

## Elaborate

Graph orchestration is LangGraph's entire thesis (nodes, edges, conditional edges, a checkpointer)
and the shape underneath Temporal-style durable workflows applied to agents. The two capabilities
it uniquely unlocks are *durability* (checkpoint, crash, resume) and *human-in-the-loop* (pause at
a node, persist, resume on human input) — neither of which a freewheeling in-memory loop can do.
It's also the standard answer to "how do I debug a multi-agent system": as a graph, you can log
which node ran, inspect the state at each, and replay from any node. That's why mature multi-agent
stacks converge on a graph runtime even when individual nodes are simple — the graph is the
observability and durability layer, not just the control flow.

To adopt a graph for buffr, see SECTION F's stateful-graph template — it shows lifting the implicit
ReAct loop into explicit retrieve/decide/answer nodes with a checkpointer, which is also the
prerequisite for any human-approval pause.

## Interview defense

**Q: "How would you add a human-approval step to buffr?"**

Model answer: "I can't cleanly, today — and the reason is architectural. buffr's control flow is an
implicit bounded loop with in-memory state (`run-agent-loop.ts:94,124,189` — the `messages` array
lives only for one `answer()` call). A human-approval *pause* needs the run to stop, persist its
state, and resume hours later from that exact point — and you can't resume from state that only
exists in memory. The fix is graph orchestration: lift the loop into explicit nodes (retrieve,
decide, answer, human_approve) with conditional edges and a *checkpointer* that saves state at each
node. Then the approval node pauses, the state goes to disk, and a human response resumes from the
checkpoint. That same graph also makes the run inspectable and replayable. buffr doesn't have it
because a single-shot RAG answer runs to completion uninterrupted — there's nothing to pause for
yet."

```
  The defense in one picture

  buffr: implicit loop + IN-MEMORY state → cannot pause/resume
  graph: explicit nodes/edges + CHECKPOINTED state → pause at human_approve, resume later
```

Anchor: *Graph orchestration makes control flow explicit and checkpointed — the only thing that
makes a run inspectable, resumable, and human-pausable; buffr's in-memory loop can't pause because
its state doesn't survive the call.*

## See also

- `02-supervisor-worker.md`, `03-sequential-pipeline.md`, `04-parallel-fan-out.md` — topologies a
  graph makes inspectable.
- `08-shared-state-and-message-passing.md` — the state object the graph checkpoints.
- `09-coordination-failure-modes.md` — graph edges make loops/retries explicit and bounded.
- `../04-agent-infrastructure/` — control envelope and memory tiers the checkpoint would persist.
- `../06-orchestration-system-design-templates/` (SECTION F) — the stateful-graph refactor.
