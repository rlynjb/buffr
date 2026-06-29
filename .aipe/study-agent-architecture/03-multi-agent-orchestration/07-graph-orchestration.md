# Graph orchestration — control flow as an explicit state machine

**Industry name(s):** graph orchestration · agent state machine ·
node-edge orchestration (LangGraph-style) · checkpointed agent graph.
**Type label:** Industry standard.

**In this codebase: Not yet implemented.** buffr's control flow is an
imperative loop (`runAgentLoop`), not a declared graph. There are no
nodes, edges, or checkpoints. If buffr's two-brain design needed
human-in-the-loop pauses or inspectable branching, this is the topology
that would provide them.

## Zoom out, then zoom in — lead with the shape

```
  Graph orchestration topology (lead with it)

  ┌──────┐    ┌──────┐    ┌──────┐
  │ node │───►│ node │───►│ node │
  │  A   │    │  B   │    │  C   │
  └──────┘    └──┬───┘    └──────┘
                 │ conditional edge
                 ▼
              ┌──────┐
              │ node │  (loop back / branch)
              │  D   │
              └──────┘
   nodes = agent turns; edges = transitions; state = checkpointed
```

Zoom in: this is the topology that makes the others inspectable.
Supervisor-worker, pipeline, and debate can all be expressed as a graph
with explicit state, conditional edges, and checkpointing — so you can
pause for human review and resume. It's a state machine where the state
is the shared agent context and the transitions are agent turns.

## Structure pass

**Layers.** A declared graph (nodes + edges) over a checkpointed state.
buffr has neither — it has an imperative `for` loop.

**Axis — "is the control flow declared or imperative?"** buffr's is
imperative: a hand-written loop with `if`s (`run-agent-loop.js:25-105`).
A graph is *declared*: you define nodes and edges as data, and a runner
walks them. The declaration is what makes it inspectable and pausable.

**Seam.** Each edge is a seam with an explicit condition. Where buffr's
loop hides its transitions inside `if (toolUses.length === 0)`, a graph
makes every transition a named, inspectable edge.

## How it works

#### Move 1 — the mental model

You've built a multi-step form as explicit UI states with transitions —
`idle → filling → validating → submitting → done`, with conditional
edges (validation fails → back to filling). Graph orchestration is that
state machine, where the state is the agent's shared context and each
transition is an agent turn.

```
  Pattern — agent control as a state machine

  [retrieve] ──chunks──► [synthesize] ──draft──► [check]
       ▲                                            │
       └──────────── conditional edge: ─────────────┘
                     "ungrounded → re-retrieve"
   state checkpointed between nodes → pause / resume / inspect
```

#### Move 2 — the walkthrough (loop vs graph in buffr)

**buffr's loop is the imperative version of a graph.** Open
`run-agent-loop.js:25-105`. The transitions are real but *implicit*:
"no tool_use → done" is an edge buried in an `if`; "budget spent →
forced synthesis" is another. A graph would lift those into declared
nodes (`retrieve`, `synthesize`) and edges (`enough? → synthesize`,
`not enough → retrieve`) you could draw, inspect, and pause at.

**What buffr would gain: human-in-the-loop and inspectability.** The
single biggest thing a graph buys is checkpointed state — you can pause
the run at a node, surface it to a human ("approve this answer before it
sends"), and resume. buffr has no such gate today; its loop runs to
completion. For the two-brain design — where a phone action might want
confirmation — graph orchestration is what would make a human pause
possible. (The guardrails file,
`04-agent-infrastructure/05-guardrails-and-control.md`, treats the
human gate as a control point; graph orchestration is the *mechanism*
that makes it resumable.)

**The cost: up-front structure.** A graph means you *define* the graph
instead of letting the model freewheel inside a loop. That's more code
and less flexibility per turn — worth it when you need
inspectability/pausing, overkill when a bounded loop suffices. buffr's
task suffices with a loop, so it uses one.

```
  Comparison — buffr's imperative loop vs a declared graph

  buffr today (imperative):        graph (would-be):
    for turn: if no tool → done      nodes: retrieve, synth, check
              if budget → synth      edges: declared + conditional
    (transitions hidden in ifs)      checkpointed state → pause/resume
    runs to completion, no pause     human-in-the-loop possible
```

#### Move 3 — the principle

A graph makes implicit control flow explicit, inspectable, and
pausable — at the cost of up-front structure. Every other topology in
this section is a special case of a graph. buffr's bounded loop is the
imperative form of a one-path graph; it stays a loop because it doesn't
need checkpointing or human pauses. The day it needs a human-in-the-loop
gate (likely in the two-brain phone-action design) is the day the loop
should become a graph.

## Primary diagram

```
  Graph orchestration (would-be in buffr, vs today's loop)

  TODAY: runAgentLoop — imperative for-loop, transitions in ifs

  GRAPH:
    [retrieve] ─enough?─► [synthesize] ─grounded?─► [answer]
        ▲                                  │
        └────── not grounded ──────────────┘
    state checkpointed → can pause at [answer] for human approval
```

## Elaborate

Graph orchestration (popularized by LangGraph) is the answer to "my
agent system got complex enough that I can't reason about its control
flow." By making the flow a declared graph with checkpointed state, it
becomes debuggable, resumable, and human-gateable. It's the unifying
abstraction: supervisor-worker, pipeline, and debate are all graphs.
For buffr, the trigger to adopt it isn't complexity (its loop is simple)
— it's the need for a human-in-the-loop pause, which its current
run-to-completion loop can't provide.

## Interview defense

**Q: buffr uses a loop, not a graph — when would you switch?**
When I need checkpointed state — specifically a human-in-the-loop pause.
buffr's loop runs to completion with transitions hidden in `if`s; a
graph lifts those into declared, inspectable edges and lets you pause at
a node and resume. The trigger isn't complexity (the loop is simple),
it's the two-brain design's likely need to confirm a phone action before
it runs.

```
  imperative loop (buffr)  →  declared graph (pausable, inspectable)
```

**Anchor:** "A graph makes implicit transitions explicit and the run
pausable — buffr would switch for human-in-the-loop, not for
complexity."

## See also

- `02-supervisor-worker.md` · `03-sequential-pipeline.md` ·
  `05-debate-verifier-critic.md` — all expressible as graphs
- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the imperative
  loop a graph would replace
- `04-agent-infrastructure/05-guardrails-and-control.md` — the human
  gate a graph makes resumable
