# When NOT to go multi-agent — the most important multi-agent decision

**Industry name(s):** the multi-agent escalation gate · "single-agent
first" · the coordination-tax decision. **Type label:** Industry
standard.

**In this codebase: buffr is correctly single-agent.** It has one
`RagQueryAgent`, no topology, and that's the right call — its task
(retrieve and answer from a personal knowledge base) is not
decomposable into independent specialties. The two-brain laptop+phone
vision in `agent-layer-plan.md` is design-only, and this file is the
gate it would have to pass.

## Zoom out, then zoom in

This file comes first in the multi-agent section by design. The single
most important multi-agent decision is whether to be multi-agent at
all.

```
  Zoom out — the gate in front of all of SECTION C

  ┌─ Single-agent (buffr today) ─────────────────────────────┐
  │  one RagQueryAgent, one tool, bounded loop               │
  └───────────────────────────┬──────────────────────────────┘
                              │  ★ ESCALATION GATE ★          ← we are here
                              ▼  (cross only on a measured,
                                 decomposable failure)
  ┌─ Multi-agent (SECTION C) ────────────────────────────────┐
  │  supervisor-worker · pipeline · fan-out · debate · swarm  │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: multi-agent adds roughly 2-5x coordination overhead and a much
larger debugging surface — now you debug the conversation *between*
agents, not one agent's loop. The quality gain is often modest unless
the problem genuinely splits into specialties. This gate is what earns
the senior answer: "I considered multi-agent and chose not to, because
the failure wasn't decomposable."

## Structure pass

**Layers.** The gate is a decision layer between single-agent and any
topology. It has no code in buffr — it's the reasoning that *kept*
buffr single-agent.

**Axis — "is the failure decomposable into independent specialties?"**
That's the whole gate. If a single-agent failure can be split into
specialist sub-tasks that run independently, multi-agent may help. If
it can't, multi-agent just adds tax.

**Seam.** The seam is the moment you commit to a second agent. Before
it, you debug one loop; after it, you debug coordination. Crossing it
is expensive and hard to walk back — which is why the gate is strict.

## How it works

#### Move 1 — the mental model

You don't split one component into a manager-plus-children unless the
children own genuinely separate responsibilities — otherwise you've
added prop-drilling and coordination for nothing. The multi-agent gate
is that instinct: only split the agent when the work splits.

```
  Pattern — the escalation gate

  ┌───────────────────────────────────────────────┐
  │ 1. Build a single-agent (ReAct) baseline      │
  │ 2. Measure: success rate, tool-call accuracy, │
  │    latency, cost                              │
  │ 3. Identify the SPECIFIC failure single-agent │
  │    cannot fix                                  │
  │ 4. Is that failure genuinely decomposable     │
  │    into independent specialties?              │
  │       │                                        │
  │       ├─ no  → stay single-agent, fix the      │
  │       │        prompt / tools / retrieval      │
  │       └─ yes → escalate to the SPECIFIC        │
  │                topology that addresses it      │
  └───────────────────────────────────────────────┘
```

#### Move 2 — the walkthrough (buffr passes the gate by staying single)

**Step 1-2: buffr has the baseline and measures it.** The single-agent
ReAct baseline is `RagQueryAgent` (`rag-query-agent.js:22`), and buffr
*measures* retrieval quality — there's a precision@k eval CLI
(`src/cli/eval-cmd.ts`, `eval/queries.json`). That's the disciplined
order: baseline first, measurement wired, before any escalation.

**Step 3: what failure would single-agent not fix?** For buffr's task,
there isn't one yet. Retrieve-and-answer is a single specialty. A weak
answer is fixed by better retrieval (a grader, routing) or a better
prompt — not by a second agent. Adding a "researcher agent" and a
"writer agent" wouldn't make a personal-knowledge answer better; it'd
add a handoff and a synthesis step to a task that's already one step.

**Step 4: is it decomposable? No.** The decomposability test is the
gate's core. buffr's question "what did my notes say about X" doesn't
split into independent specialties — there's no sub-task A and sub-task
B that run in parallel and merge. So buffr stays single-agent. That's
not a limitation; it's the correct read of the gate.

**Where buffr's future *would* cross.** The two-brain design in
`agent-layer-plan.md` — a laptop brain and a phone brain, each with its
own store and capabilities — *is* decomposable: the phone owns
on-device/low-latency, the laptop owns the heavy store. That genuinely
splits into specialties with different state. *That* would pass the
gate, as supervisor-worker or graph orchestration. It's design-only
today.

```
  Comparison — buffr's task vs a decomposable task

  buffr's task (NOT decomposable):    two-brain (decomposable):
    "what did my notes say about X"     phone brain: on-device, low-latency
    = retrieve + answer                 laptop brain: heavy pgvector store
    = ONE specialty                     = TWO specialties, different state
    → stay single-agent                 → supervisor / graph would pass gate
```

#### Move 3 — the principle

Build single-agent, measure it, and escalate only when you've named a
specific failure that's genuinely decomposable into independent
specialties. The coordination tax (2-5x overhead, a debugging surface
that now includes inter-agent conversation) is real and paid up front.
buffr is the disciplined case: baseline built, eval wired, and the
honest verdict that its task is one specialty — so it stays single, and
the multi-agent vision waits for a task that actually splits.

## Primary diagram

```
  The gate, with buffr's path marked

  single-agent baseline (RagQueryAgent) ──► measure (precision@k eval)
                                              │
                                              ▼
                            "decomposable into independent specialties?"
                                ┌─────────────┴─────────────┐
                                ▼ NO (buffr's task)         ▼ YES (two-brain)
                          stay single-agent           supervisor / graph
                          fix retrieval/prompt         (design-only today)
```

## Elaborate

The "single-agent first" rule is production scar tissue: teams that
shipped multi-agent paid the coordination tax and often found a
well-tuned single agent matched the quality. The gate exists to make
that lesson cheap to inherit. Everything else in SECTION C —
supervisor-worker, pipeline, fan-out, debate, swarm, graph — is on the
*other* side of this gate. Read this file as the thing that decides
whether you turn the page. buffr's eval discipline
(`04-agent-infrastructure/04-agent-evaluation.md`) is what makes step 2
real rather than a slogan.

## Interview defense

**Q: Why is buffr single-agent?**
Because its task isn't decomposable. Retrieve-and-answer from a personal
knowledge base is one specialty — a weak answer is fixed with better
retrieval or a better prompt, not a second agent. Going multi-agent
would add 2-5x coordination overhead and a bigger debug surface for no
quality gain. I keep it single-agent and use the precision@k eval to
catch retrieval regressions.

```
  decomposable into independent specialties? NO → stay single-agent
```

**Anchor:** "Single-agent first; escalate only on a measured,
decomposable failure — buffr's task is one specialty, so it stays
single."

**Q: When would buffr go multi-agent?**
The two-brain laptop+phone design in `agent-layer-plan.md` would
qualify — phone owns on-device/low-latency, laptop owns the heavy
store, different state and capabilities. That's genuinely decomposable,
so it'd pass the gate as supervisor-worker or graph orchestration. It's
design-only today; I wouldn't build it until that split is real.

## See also

- `02-supervisor-worker.md` — the first topology past the gate
- `09-coordination-failure-modes.md` — the concrete shape of the 2-5x
  tax
- `01-reasoning-patterns/03-react.md` — the single-agent baseline the
  gate compares against
- `04-agent-infrastructure/04-agent-evaluation.md` — how buffr measures
  step 2
