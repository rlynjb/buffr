# Supervisor–Worker

*Industry names: **supervisor–worker** / **orchestrator–worker** / **manager–agent** / **hierarchical agents**. Type label: Industry standard (the most common multi-agent topology). In this codebase: **Not yet implemented.** (buffr is single-agent; the deferred two-brain laptop+phone split would be this.)*

## Zoom out, then zoom in

This is the topology you reach for first when the escalation gate opens — a manager agent that
delegates to specialist workers. Here is its SHAPE before anything else.

```
  THE TOPOLOGY — one supervisor over N workers (★ = the supervisor)

                    ┌─────────────────────┐
                    │  ★ SUPERVISOR        │
                    │  decides who does    │
                    │  what, then merges   │
                    └───┬──────┬──────┬────┘
            delegates   │      │      │   delegates
                        ▼      ▼      ▼
                 ┌────────┐┌────────┐┌────────┐
                 │ WORKER ││ WORKER ││ WORKER │
                 │   A    ││   B    ││   C    │
                 │(search)││(legal) ││(math)  │
                 └────────┘└────────┘└────────┘
                  each = its own runAgentLoop (Section A skeleton)
```

The topology is the mental model: **a tree, one level deep, with the supervisor at the root.**
The honest sentence: buffr has no supervisor and no workers — it is a single node. This file
teaches the shape because it's the most likely refactor (the deferred laptop-supervisor +
phone-worker split in `agent-layer-plan.md`).

## Structure pass

One axis: **control** — does the supervisor *keep* control, or *hand it away*?

```
  Axis = CONTROL · the SEAM is whether control returns to the supervisor

  tools-style    supervisor calls worker like a TOOL → result returns → supervisor stays boss
  ──────────── ★ SEAM: control either RETURNS or TRANSFERS ★ ──────────
  handoff-style  supervisor TRANSFERS control to worker → worker now drives the conversation
```

This is the single most important distinction in the topology. In **tools-style**, a worker is
just a callable — the supervisor invokes it, gets a value back, and remains the one talking to
the user; the worker never "takes over." In **handoff-style**, the supervisor *hands the
conversation off* — the worker now owns the turn, and control only comes back if the worker
explicitly returns it. Tools-style is easier to reason about and bound (the supervisor is
always the single point of termination). Handoff-style is more flexible but introduces the
infinite-handoff failure (see `09`). The seam is "does control come back automatically?"

## How it works

### Move 1 — mental model

A manager that doesn't do the work, it *routes* the work. Bridge from frontend: it's a parent
component that owns the state and delegates rendering to child components — except here the
"children" are whole agent loops, and the parent decides *which* child to invoke based on the
model's judgment, not a static `props` map.

```
  THE SHAPE — supervisor as a router + merger, workers as leaves

   user ─▶ ┌─ SUPERVISOR ─────────────────────────┐
           │ 1. read request                      │
           │ 2. pick worker(s)  ──┐               │
           │ 4. merge results  ◀──┼──┐            │
           └──────────────────────┼──┼────────────┘
                    delegates ▼    │  ▲ results
                 ┌──────────┐ ┌────▼──────┐
                 │ WORKER A  │ │ WORKER B  │  (each its own loop)
                 └──────────┘ └───────────┘
```

### Tools-style — the worker is a callable, control returns

The supervisor exposes each worker as a *tool* in its own tool schema. Calling a worker looks
exactly like calling `search_knowledge_base` — intent out, result back, supervisor stays in
charge. This is buffr's existing tool-call mechanism, scaled to "the tool is another agent."

```
  Tools-style — worker invoked like a tool, result RETURNS to supervisor

   SUPERVISOR ──"call worker_legal(question)"──▶ WORKER_LEGAL (own loop)
        ▲                                              │
        └──────────── result value ────────────────────┘
   supervisor stays the ONLY actor talking to the user · single termination point
```

```
pseudocode — tools-style (the supervisor's loop is just buffr's loop + agent-tools)
supervisorTools = [ search_kb, worker_legal, worker_math ]   # workers ARE tools
runAgentLoop(supervisor, tools=supervisorTools)              # SAME kernel as buffr
  # when the model emits {"tool":"worker_legal", ...}, the harness runs
  # that worker's OWN runAgentLoop and feeds the result back as an observation
```

Annotation: this is the *minimal* refactor from buffr. The supervisor *is* buffr's loop
(`run-agent-loop.ts:76-202`) with extra tools whose implementations happen to be other loops.
Termination stays simple — there's still one boss with one budget exit. This is why
tools-style is the recommended starting topology.

### Handoff-style — control transfers, the worker now drives

The supervisor doesn't get a value back — it *hands the conversation to* the worker. The
worker now talks to the user directly until it hands back (or to another worker). This is more
powerful (the worker can run a long sub-dialogue) but you've lost the single termination point.

```
  Handoff-style — control TRANSFERS; worker now owns the turn

   user ─▶ SUPERVISOR ──hand off──▶ WORKER_LEGAL ──talks to user directly──▶
                                         │
                                    hand back? ──▶ SUPERVISOR  (only if worker chooses)
   NEW RISK: worker → worker → worker → ... infinite handoff (see 09)
```

Annotation: the load-bearing difference is "no automatic return." In tools-style the
supervisor's loop resumes the instant the worker returns a value. In handoff-style nothing
forces a return — which is exactly the infinite-handoff failure `09` covers, and why
handoff-style *requires* a handoff counter the tools-style doesn't.

### What buffr does instead — and the deferred two-brain refactor

buffr is a single node: no supervisor, no workers. The natural place it grows a supervisor is
the deferred laptop+phone split.

```
  buffr today          vs    the deferred two-brain supervisor (agent-layer-plan.md)

  ┌────────────┐             ┌─ LAPTOP "brain" = SUPERVISOR ─┐
  │ one agent   │            │  heavy reasoning, the boss     │
  │ one loop    │            └────────────┬───────────────────┘
  └────────────┘                  delegates │ (tools-style first)
   single node                              ▼
                                  ┌─ PHONE = WORKER ──────────┐
                                  │  light, on-device tasks    │
                                  └────────────────────────────┘
   run-agent-loop.ts:76-202       DESIGN-ONLY · deferred to Phase 5+
```

Annotation: the parent doc names a laptop "brain" plus a phone — a textbook supervisor (laptop)
over a worker (phone). It's design-only: buffr's single loop hasn't hit a ceiling, and the
failure isn't decomposable into laptop-vs-phone specialties yet. When it is, start tools-style
(laptop keeps control, calls the phone like a tool) before ever touching handoff-style.

### Move 3 — the principle

**A supervisor routes and merges; it doesn't do the work — and tools-style keeps it the single
point of termination, which is why you start there.** Reach for supervisor–worker when one
agent must coordinate *genuinely different specialties* (legal vs. medical vs. math) that each
deserve their own prompt, tools, and budget. Don't reach for it to split one skill into "a
researcher and a writer" — that's not specialization, that's a chatty pipeline (see `03`).
Start tools-style; only go handoff when a worker needs to own a long sub-dialogue, and then
pay for a handoff counter.

## Primary diagram

Full recap: the topology, the two control styles, the buffr verdict.

```
  Supervisor–worker — the topology and its control seam

  ┌─ SUPERVISOR (router + merger) ─────────────────────────────┐
  │  tools-style: workers are TOOLS, result RETURNS  ← start here│
  │  handoff-style: control TRANSFERS, worker drives  (needs 09 │
  │                 handoff counter)                            │
  └───┬──────────────┬──────────────┬──────────────────────────┘
      ▼              ▼              ▼
  ┌────────┐    ┌────────┐    ┌────────┐
  │WORKER A│    │WORKER B│    │WORKER C│   each = its own runAgentLoop
  └────────┘    └────────┘    └────────┘
  ───────────────────────────────────────────────────────────────
  buffr: NOT YET · single node · deferred = laptop(super)+phone(worker)
  refactor template: SECTION F · agent-layer-plan.md (design-only)
```

Verdict in one line: **the most common and most defensible topology — buffr's likeliest
refactor (start tools-style) — but not yet, because the failure isn't decomposable into
specialties.**

## Elaborate

Supervisor–worker is the backbone of LangGraph's "supervisor" pattern, the OpenAI Agents SDK's
handoffs, and CrewAI's hierarchical process. The tools-style-vs-handoff-style split maps
directly: LangGraph's `Command`/tool-return is tools-style; the Agents SDK's `handoff()` is
handoff-style. The production lesson is the one in the structure pass — tools-style keeps a
single termination point, so teams that want predictable cost and easy debugging default to it
and only adopt handoffs where a worker genuinely needs to own a multi-turn sub-conversation.

The cost is real: each worker call is another full agent loop, so a supervisor over three
workers can be 4x the model calls of a single agent (supervisor + three workers). That's the
2–5x overhead `09` makes concrete — supervisor–worker is often where it shows up first.

To adopt it for buffr, see SECTION F's system-design template — it shows turning
`RagQueryAgent` into a tools-style supervisor that calls specialist sub-loops.

## Interview defense

**Q: "How would you structure a multi-agent version of buffr?"**

Model answer: "Supervisor–worker, tools-style, and only if the gate opens. I'd keep buffr's
existing loop (`run-agent-loop.ts:76-202`) as the supervisor and expose each specialist as a
*tool* — so a worker call looks exactly like the current `search_knowledge_base` call: intent
out, result back, supervisor stays the single point of termination and keeps the budget exit.
I'd avoid handoff-style at first because it transfers control with no automatic return, which
needs a handoff counter to not loop forever. The deferred shape in the project's plan is
literally this — a laptop 'brain' supervisor over a phone worker. But it's design-only: a RAG
query is one job, not separable specialties, so there's nothing to delegate yet."

```
  The defense in one picture

  tools-style: worker = tool, result RETURNS  → single termination  ← start here
  handoff-style: control TRANSFERS, worker drives → needs handoff counter
  buffr: single node today · laptop+phone = the deferred supervisor
```

Anchor: *A supervisor routes and merges; start tools-style (workers as tools, single
termination point), go handoff only for long sub-dialogues — buffr's deferred laptop+phone
split is exactly this, not yet built.*

## See also

- `01-when-not-to-go-multi-agent.md` — the gate this topology sits behind.
- `03-sequential-pipeline.md` — the simpler shape when there's no routing, just a fixed order.
- `06-swarm-handoff.md` — handoff-style taken to the extreme: no central supervisor at all.
- `09-coordination-failure-modes.md` — the handoff counter and per-agent/global caps a
  supervisor needs.
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop each worker (and the
  supervisor) is a copy of.
- `../06-orchestration-system-design-templates/` (SECTION F) — the supervisor refactor.
