# Plan-and-Execute

*Industry names: **plan-and-execute** / **planner-executor** / **plan-then-act**. Type label: Industry standard. In this codebase: **Not yet implemented.** (buffr is plain ReAct — no autonomous re-planning, because the single-agent loop hasn't hit its quality ceiling.)*

## Zoom out, then zoom in

This is the first rung above buffr's ReAct floor. Here is where it *would* sit — as a layer
that wraps the existing kernel, not a replacement for it.

```
  Where plan-and-execute would slot in (dashed = NOT YET)

  ┌─ Session (chain) ──────────────────────────────────────────┐
  └──────────────────────────┬─────────────────────────────────┘
  ┌╌ ★ PLANNER (this file — NOT YET) ╌╌▼╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
  ╎  model writes a step list ONCE, up front                  ╎
  ╎     [1 search X] [2 search Y] [3 synthesize]              ╎
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┬╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
  ┌─ EXECUTOR = the ReAct kernel buffr already has ─▼──────────┐
  │  runAgentLoop runs each step — run-agent-loop.ts:98-190    │
  └────────────────────────────────────────────────────────────┘
```

The honest sentence first: **buffr does not do this.** Its model decides one step at a time
inside the ReAct loop; it never writes a multi-step plan up front, and it never re-plans.
This file teaches the pattern so you can name it and point at the refactor.

## Structure pass

One axis: **control** — *when* is the sequence of steps decided?

```
  Axis = CONTROL · when the step sequence is fixed

  ReAct (buffr today)       decided step-by-step, at runtime, each turn
  ──────────── ★ SEAM: the decision moves EARLIER ★ ────────────
  plan-and-execute          decided ALL AT ONCE, before any tool runs
```

In ReAct the model never commits to a plan — it picks the next move with full knowledge of
the last observation. Plan-and-execute moves that decision *earlier*: the model commits to
the whole step list before it has seen any results. That's the seam — the same axis
(control) flips from "decide as you go" to "decide up front." The trade is less drift
(the plan keeps the model on task) for less adaptivity (the plan is blind to what the first
search actually returns, unless you add re-planning).

## How it works

### Move 1 — mental model

Two roles: a **planner** that writes the recipe once, and an **executor** that cooks each
step. Bridge from frontend: it's `Promise.all` over a list you *computed first* — except the
list itself comes from a model call, and the executor for each item is buffr's existing
ReAct loop.

```
  THE SHAPE — plan once, then execute each step

  ┌─ PLAN (one model call) ─────────────────────────┐
  │ "To answer, I will: 1) search auth docs         │
  │  2) search rate-limit docs  3) synthesize"      │
  └───────────────┬─────────────────────────────────┘
                  ▼
  ┌─ EXECUTE (loop over the plan) ──────────────────┐
  │ for step in plan:                               │
  │   runAgentLoop(step)  ← buffr's kernel, reused   │
  │ ...then synthesize across all step results       │
  └─────────────────────────────────────────────────┘
       (optional re-plan if a step's result surprises)
```

### Pseudocode first — the language-agnostic logic

```
plan      = model.plan(question)          # ONE call: returns ["search A", "search B", "synth"]
results   = []
for step in plan:
    results.append( reactLoop(step) )      # each step is a small bounded ReAct run
answer    = model.synthesize(question, results)
# re-planning (the "autonomous" variant): if a result invalidates the plan,
# call model.plan() again with the new evidence. buffr does NEITHER step.
```

Annotation: the load-bearing difference from buffr is line 1 — a dedicated planning call
that produces a *list* before any execution. buffr has no equivalent; its model is handed
the question and immediately enters the per-turn loop.

### What buffr does instead — and why that's fine for now

buffr collapses planning into execution: the model's "plan" is implicit and one-step-deep,
re-decided every turn.

```ts
// rag-query-agent.ts:66-80 — no planner. The loop IS the executor, deciding step-by-step.
const { finalText } = await runAgentLoop({
  model, tools, toolSchemas,
  maxTurns: 6,
  maxToolCalls: 4,
  // there is NO `plan` field, NO planner model call, NO step list.
  synthesisInstruction: buildSynthesisInstruction(
    'Now answer the question directly and concisely, citing the sources you retrieved.',
  ),
});
```

```
  buffr (today)            vs    plan-and-execute (the refactor)

  question                       question
     │                              │
     ▼                              ▼  ← extra model call appears HERE
  [ReAct loop decides              [PLANNER writes step list]
   each step live]                    │
     │                              ▼
  answer                          [executor runs each step via the SAME loop]
                                     │
                                  [synthesize]
```

Annotation: buffr has a single moving part; plan-and-execute adds a planner box *on top of*
the same kernel. The executor is buffr's current loop, unchanged — which is exactly why this
is a clean refactor, not a rewrite. You would adopt it when you measure **task drift**: the
model wandering off a multi-part question because it forgot part of it mid-loop. buffr's
questions are single-intent enough that this hasn't shown up.

### Move 3 — the principle

**Plan-and-execute trades adaptivity for focus by deciding the step sequence earlier.** It
pays off when a task has several distinct sub-goals the model tends to forget or conflate.
The refactor is additive: keep the ReAct kernel as the executor, prepend a planner call.
Don't reach for it until drift is logged — an up-front plan that the first observation
invalidates is *worse* than ReAct unless you also pay for re-planning.

## Primary diagram

Full recap: the pattern, the refactor seam, the honest verdict.

```
  Plan-and-execute — the rung buffr hasn't climbed

  ┌╌ NOT YET in buffr ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
  ╎ PLANNER: model writes [step1, step2, ...] once, up front ╎
  ╎   trigger to adopt: measured TASK DRIFT on multi-part Qs  ╎
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┬╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
  ┌─ EXECUTOR (REUSE buffr's kernel, unchanged) ──▼───────────┐
  │ for step in plan: runAgentLoop(step)   run-agent-loop:98-190│
  └────────────────────────────────────────────────────────────┘
  Refactor template: SECTION F → agentic-coding template
```

Verdict in one line: **a clean additive refactor (planner on top of the existing executor),
but unjustified until task drift is measured — so: not yet.**

## Elaborate

Plan-and-execute was popularized by BabyAGI / "Plan-and-Solve" prompting (2023) and
formalized in LangChain's PlanAndExecute agents. The autonomous-re-planning variant (re-plan
after each step) is what people mean by "agentic planning." The known failure mode is the
opposite of ReAct's: a confidently-wrong up-front plan that the executor follows off a cliff
because no observation can change it — which is why production systems either keep plans
short or add re-planning, paying more tokens. For buffr's single-intent personal-knowledge
queries, the ReAct floor's per-turn adaptivity is the better default.

To actually adopt it, see SECTION F's agentic-coding template for the refactor shape — it
keeps `runAgentLoop` as the per-step executor and adds the planner as a new capability.

Read next: `05-reflexion-self-critique.md` — the next rung, which adds a *critic* instead of
a *planner*.

## Interview defense

**Q: "Would plan-and-execute help buffr?"**

Model answer: "Not yet, and I can say why precisely. Plan-and-execute moves the step
decision *earlier* — the model commits to a step list up front instead of deciding per turn
like buffr's ReAct loop (`run-agent-loop.ts:98-190`). It pays off against *task drift* on
multi-part questions. buffr's questions are single-intent, and I haven't logged drift, so the
up-front plan would just add a model call and risk a stale plan. When I do adopt it, it's
additive: keep the current loop as the executor, prepend a planner. I don't escalate on
spec."

```
  The defense in one picture

  ReAct: decide per turn (adaptive)   ──drift logged?──▶  plan up front (focused)
  buffr is here, no drift logged                          not taken
```

Anchor: *Plan-and-execute decides the steps earlier; adopt it only when task drift is
measured — buffr hasn't, so it stays plain ReAct.*

## See also

- `03-react.md` — the floor this rung sits above; the escalation discipline.
- `02-agent-loop-skeleton.md` — the kernel that becomes the *executor* under this pattern.
- `05-reflexion-self-critique.md` — the sibling rung that adds a critic, not a planner.
- `../06-orchestration-system-design-templates/` (SECTION F) — the agentic-coding template
  that shows the refactor.
