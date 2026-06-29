# Plan-and-execute — separate the strategy from the grunt work

**Industry name(s):** plan-and-execute · plan-and-solve · planner/executor
split. **Type label:** Industry standard.

**In this codebase: Not yet implemented.** buffr runs single-tool
ReAct — it re-decides whether to search on every turn rather than
building a plan up front. It hasn't hit the ceiling where a plan would
pay off, because its tasks are single-step retrievals, not structured
multi-step ones. The `06-...templates/03-agentic-coding-system.md`
template names the refactor.

## Zoom out, then zoom in

Plan-and-execute is the first escalation target past ReAct. Where it
sits in the family:

```
  Zoom out — plan-and-execute vs ReAct

  ┌─ Reasoning patterns (SECTION A) ─────────────────────────┐
  │   ReAct: think → act → think → act  (decide every turn)  │
  │      │ escalate when the task is STRUCTURED               │
  │      ▼                                                    │
  │   ★ plan-and-execute ★  plan once, then run the steps     │ ← we are here
  └──────────────────────────────────────────────────────────┘
```

Zoom in: ReAct re-decides the whole approach on every loop. For a task
whose steps you *can* know up front, that's wasteful — you pay an
expensive model to re-strategize each turn. Plan-and-execute splits
the two: one expensive planning call builds the step list, then cheap
calls run each step with no re-planning.

## Structure pass

**Layers.** Two distinct phases — plan (outer, expensive) and execute
(inner, cheap) — where ReAct has one undifferentiated loop.

**Axis — "cost per step."** In ReAct every step pays the full reasoning
cost. In plan-and-execute the reasoning cost is paid once (the plan);
execution steps are cheap. That cost asymmetry is the whole reason the
pattern exists.

**Seam.** The plan→execute handoff. The plan is a frozen artifact the
executor consumes; the seam is where strategy stops and grunt work
starts. The failure mode lives exactly here: if a step fails and the
plan has no branch for it, the executor is stuck.

## How it works

#### Move 1 — the mental model

You build a multi-step form by deciding the steps first (the schema),
then filling each field — you don't re-derive the form's structure on
every keystroke. Plan-and-execute is that: decide the steps once, then
execute them.

```
  Pattern — the plan/execute split

  ┌─ Plan phase ─────────────────────────────────┐
  │  expensive model builds the full plan up front│
  └───────────────────┬───────────────────────────┘
                      │  plan: [step1, step2, step3]
                      ▼
  ┌─ Execute phase ──────────────────────────────┐
  │  cheap/fast model runs each step              │
  │  (no re-planning per step)                    │
  └───────────────────────────────────────────────┘
```

#### Move 2 — the walkthrough (what it would take in buffr)

buffr has no planner. Its loop re-decides search-or-answer every turn
(`run-agent-loop.js:25-57`). To make this pattern apply, you'd add a
planning call before the loop that decomposes the question into
sub-queries, then run the existing `search_knowledge_base` tool once
per sub-query without re-planning.

**Why it would beat buffr's ReAct on structured questions.** A
question like "compare what my notes say about X across the last three
months" is genuinely multi-step: retrieve X for month 1, month 2,
month 3, then synthesize. ReAct re-decides "should I search again?"
each turn and can stall or wander. A plan — `[search X@m1, search
X@m2, search X@m3, synthesize]` — runs deterministically.

**The tradeoff you'd take on.** Plans are brittle when assumptions
break mid-execution: a step fails and the plan has no branch. The
mitigation is a re-plan trigger when execution diverges — which
re-introduces some of ReAct's adaptivity. That's why you only reach
for plan-and-execute when the task is structured *enough* that a fixed
plan usually holds.

```
  Comparison — ReAct vs plan-and-execute on a 3-part question

  ReAct (buffr today):                 Plan-and-execute (would-be):
    turn 1: decide → search m1           plan: [m1, m2, m3, synth]
    turn 2: decide → search m2           exec: search m1 (cheap)
    turn 3: decide → search m3           exec: search m2 (cheap)
    turn 4: forced synth                 exec: search m3 (cheap)
    (re-decides 4x, capped)              exec: synth
                                         (decides ONCE)
```

#### Move 3 — the principle

Decouple strategy from grunt work when the strategy is stable. ReAct
for dynamic/exploratory tasks where the path can't be predicted;
plan-and-execute for structured tasks where it can. buffr's tasks are
single-step retrievals, so the split would add machinery without
buying anything — which is exactly why it stays ReAct.

## Primary diagram

```
  Plan-and-execute (would-be shape in buffr)

  question
     │
     ▼
  ┌─ PLAN (expensive) ─┐  plan = [q1, q2, q3, synth]
  │  decompose         │
  └─────────┬──────────┘
            ▼
  ┌─ EXECUTE (cheap, no re-plan) ───────────────────┐
  │  search_knowledge_base(q1)                       │
  │  search_knowledge_base(q2)                       │
  │  search_knowledge_base(q3)  → re-plan if diverges │
  │  synthesize → answer                             │
  └──────────────────────────────────────────────────┘
```

## Elaborate

Plan-and-execute (the "Plan-and-Solve" line of work) emerged from the
observation that ReAct's per-step reasoning is redundant for tasks
with knowable structure. It's the planner inside agentic coding
systems (plan the edits, then execute per file) — see
`06-...templates/03-agentic-coding-system.md`. The next escalation,
when even the *plan* needs quality-checking, is layering reflexion on
top (`05-reflexion-self-critique.md`).

## Interview defense

**Q: Why doesn't buffr use plan-and-execute?**
Because its tasks aren't structured enough to plan. A buffr question is
usually a single retrieval; ReAct's "decide whether to search" is the
right granularity. Plan-and-execute pays off when a task is genuinely
multi-step with a stable structure — then you plan once instead of
re-deciding the approach every turn.

```
  ReAct: decide every turn   |   plan-and-execute: decide once
```

**Anchor:** "Plan-and-execute trades adaptivity for cost — worth it
only when the plan usually holds."

## See also

- `03-react.md` — the baseline this escalates from
- `05-reflexion-self-critique.md` — layered on top for quality
- `06-orchestration-system-design-templates/03-agentic-coding-system.md`
  — where plan-and-execute is the standard architecture
