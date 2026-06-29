# Supervisor-worker — one boss decomposes, delegates, synthesizes

**Industry name(s):** supervisor-worker · orchestrator-worker ·
manager-agent · hierarchical agents. **Type label:** Industry standard.

**In this codebase: Not yet implemented.** buffr has one agent, no
supervisor. This is the topology the two-brain design in
`agent-layer-plan.md` would most likely take — a laptop supervisor
delegating to a phone worker — but that's design-only.

## Zoom out, then zoom in — lead with the shape

The topology IS the mental model, so here it is first:

```
  Supervisor-worker topology (the shape, lead with it)

  ┌───────────────────────────────────────────────┐
  │              Supervisor agent                  │
  │   (decomposes task, delegates, synthesizes)    │
  └───────┬───────────────┬───────────────┬────────┘
          ▼               ▼               ▼
      ┌────────┐      ┌────────┐      ┌────────┐
      │worker 1│      │worker 2│      │worker 3│
      │(spec.) │      │(spec.) │      │(spec.) │
      └────┬───┘      └────┬───┘      └────┬───┘
           └───────────────┼───────────────┘
                           ▼
                  supervisor synthesizes
                  worker results → answer
```

This is a manager component delegating to child components, each owning
one responsibility, with the parent merging the results. It's the most
common and most useful multi-agent topology — and the one buffr would
reach for first if it crossed the gate.

## Structure pass

**Layers.** Two: the supervisor (decompose + route + synthesize) and
the workers (each one specialty). buffr collapses both into one agent
today.

**Axis — "who decides what runs next?"** The supervisor. Workers don't
choose their own work; the supervisor assigns it and merges what comes
back. That centralization is the topology's defining property.

**Seam.** The supervisor→worker boundary, and the key decision there:
does the supervisor call workers *as tools* (it stays in control) or
*hand off* to them (control transfers)? Tools-style keeps the topology
debuggable; handoff-style is more flexible but harder to trace.

## How it works

#### Move 1 — the mental model

The supervisor's core job is two SECTION A patterns stacked: routing
(pick which worker handles a sub-task) plus synthesis (merge the
workers' results). If you understand `07-routing.md`, you understand
half of supervisor-worker.

```
  Pattern — supervisor as router + synthesizer

  task → supervisor: decompose into sub-tasks
            │ route each sub-task to a specialist worker
            ▼
       [worker A] [worker B] [worker C]   ← each a ReAct loop
            │         │         │
            └─────────┴─────────┘
                      ▼
       supervisor: synthesize results → answer
```

#### Move 2 — the walkthrough (what it would take in buffr)

**The workers would be buffr's existing agent, specialized.** Each
worker is itself the agent-loop skeleton from
`01-reasoning-patterns/02-agent-loop-skeleton.md` — a `RagQueryAgent`
with a scoped tool set and a focused prompt. buffr already has the
worker shape; what it lacks is a supervisor above it.

**The tools-vs-handoff decision, concretely.** If buffr went
supervisor-worker for the two-brain design, the laptop supervisor
could call the phone worker *as a tool* (`ask_phone_brain(query)` —
supervisor stays in control, easy to trace in the existing
`SupabaseTraceSink`) or *hand off* control entirely to the phone. For a
system that already captures a full-signal trajectory
(`src/supabase-trace-sink.ts`), tools-style is the obvious pick — it
keeps the whole run in one traceable loop.

**The cost the supervisor adds.** Every sub-task is a worker turn, and
the synthesis is another supervisor turn — so a 3-worker decomposition
is at least 4 model calls where single-agent buffr made 1-2. On local
Gemma that's wall-clock the user feels. The mitigation (named in the
failure-modes file): cheap models for workers, the expensive model only
for the supervisor.

```
  Comparison — buffr single-agent vs supervisor-worker

  buffr today:                     supervisor-worker (would-be):
    1 agent, 1 tool                  supervisor: decompose + synthesize
    1-2 model calls/question         3 workers: 1 call each
                                     = 4+ calls/question (2-5x tax)
```

#### Move 3 — the principle

Supervisor-worker is routing-plus-synthesis with a central boss. It
earns its overhead when a task genuinely splits into independent
specialties the supervisor can merge — and not before. Prefer
tools-style delegation when you want the run traceable, which for a
trajectory-capturing system like buffr is almost always.

## Primary diagram

```
  Supervisor-worker (would-be in buffr, two-brain framing)

  question → ┌─ laptop supervisor ─────────────┐
             │  decompose + route + synthesize  │
             └──┬──────────────────────┬─────────┘
                ▼ as a tool             ▼ as a tool
          ┌─ phone worker ─┐     ┌─ laptop worker ─┐
          │ on-device,     │     │ heavy pgvector  │
          │ low-latency    │     │ store           │
          └────────┬───────┘     └────────┬────────┘
                   └──────────┬───────────┘
                              ▼
                   supervisor synthesizes → answer
```

## Elaborate

Supervisor-worker is the workhorse of production multi-agent systems
because it keeps a single point of control (the supervisor) that you
can reason about, trace, and budget. Pipeline (`03-sequential-pipeline.md`)
is supervisor-worker with the workers in series; fan-out
(`04-parallel-fan-out.md`) is supervisor-worker with the workers in
parallel. Graph orchestration (`07-graph-orchestration.md`) is the
generalization that makes all three inspectable. So this file is the
hub of SECTION C.

## Interview defense

**Q: If buffr went multi-agent, what topology and why?**
Supervisor-worker, almost certainly — the two-brain design splits into
a laptop brain (heavy store) and a phone brain (on-device, low-latency),
which is exactly the supervisor-plus-specialist-workers shape. I'd use
tools-style delegation (supervisor calls workers as tools) so the whole
run stays in one traceable loop, since buffr already captures a
full-signal trajectory.

```
  supervisor = router + synthesizer; workers = specialists
```

**Anchor:** "Supervisor-worker is routing plus synthesis — tools-style
delegation keeps it traceable."

## See also

- `01-when-not-to-go-multi-agent.md` — the gate this sits behind
- `03-sequential-pipeline.md` · `04-parallel-fan-out.md` — workers in
  series / parallel
- `01-reasoning-patterns/07-routing.md` — the supervisor's routing half
- `08-shared-state-and-message-passing.md` — how supervisor and workers
  communicate
