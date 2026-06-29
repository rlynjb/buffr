# ReAct — Placement, Not Re-teaching

*Industry names: **ReAct** (Reason + Act). Type label: Industry standard. IMPLEMENTED in buffr — buffr is plain ReAct.*

## Zoom out, then zoom in

ReAct is not a separate layer in buffr — it is the *name* for what the kernel's step does.
Here is where it sits relative to the escalation patterns it's the floor of.

```
  Reasoning patterns — ReAct is the FLOOR, the rest stack on it

  ┌─ Escalation ladder (rungs above ReAct) ────────────────────┐
  │   tree-of-thoughts   06  ── NOT YET                        │
  │   reflexion          05  ── NOT YET                        │
  │   plan-and-execute   04  ── NOT YET                        │
  ├─ ★ ReAct (this file) ★ — the floor ────── IMPLEMENTED ─────┤
  │   reason → act → observe, looped, bounded                 │
  │   run-agent-loop.ts:98-190 · maxTurns:6 · maxToolCalls:4  │
  └────────────────────────────────────────────────────────────┘
```

buffr runs plain ReAct and stops there — deliberately. This file does **not** re-teach
Thought-Action-Observation; that mechanic lives in `study-ai-engineering`. This file is
about **placement**: where ReAct sits, why buffr defaults to it, and the discipline of
escalating off it only on a *measured* failure, not a hunch.

## Structure pass

One axis: **cost** — what does each rung above ReAct buy, and what does it cost?

```
  Axis = COST · trace it up the ladder, find the seam where cost stops paying

  ReAct              1x tokens     reason+act, one path        ← buffr is here
  plan-and-execute   ~1.2x         explicit plan, less drift
  ───────── ★ SEAM: cost outruns benefit for buffr's workload ★ ─────────
  reflexion          2-5x          self-critique retry
  tree-of-thoughts   5-15x         branch + evaluate + prune
```

The seam is below reflexion. ReAct and plan-and-execute are roughly single-pass; everything
above re-runs the model multiple times for one answer. buffr's workload — grounded Q&A over
a personal knowledge base — has not produced the failure that would justify paying 2-5x.
That's the whole escalation thesis: **measure a specific failure first, then climb one
rung.**

## How it works

### Move 1 — mental model

ReAct interleaves *reasoning* and *acting* in one loop: the model thinks a little, takes one
action (a tool call), observes the result, thinks again. Bridge from frontend: it's a
state machine where each transition is "model emits next move," and the moves alternate
between "think out loud" and "call the tool." buffr's version is that, bounded.

```
  THE SHAPE — ReAct as buffr runs it (one path, no branching)

   ┌──────────────────────────────────────────────┐
   │                                              │
   ▼                                              │
  REASON ──▶ ACT ──▶ OBSERVE ──────────────────────┘
  (model    (call    (tool result
   thinks)   search)  re-enters as user msg)
   │
   │ model reasons it's done (no act)
   ▼
  ANSWER  ═ exit ═
```

### buffr DEFAULTS to ReAct — and that's the right default

The default is not laziness; it's the documented industry default (prefer the simplest loop
that works). buffr's agent declares ReAct by what it passes the kernel: a system prompt that
says "search first, then ground your answer," one tool, and bounds. No planner, no critic,
no tree.

```ts
// rag-query-agent.ts:20-27 — the ReAct system prompt: reason→act is instructed, not branched
const DEFAULT_SYSTEM_TEMPLATE = [
  'You are a personal knowledge assistant.',
  '',
  `Always call the ${SEARCH_KNOWLEDGE_BASE_TOOL_NAME} tool first to retrieve relevant`,
  'passages before answering. Ground every answer in the retrieved chunks and cite',
  'their sources. ...',
].join('\n');
```

Annotation: "call the tool first, then ground your answer" is literally Act-then-Reason
spelled into the prompt. There is no plan step, no critique step. One straight ReAct path.

### buffr's MEASURED controls — the bounds are the escalation discipline

Plain ReAct can still loop too long. buffr's two numbers are the measured controls that keep
the default safe without escalating to a fancier pattern.

```ts
// rag-query-agent.ts:75-76 — the measured bounds on plain ReAct
maxTurns: 6,        // at most 6 reason/act passes
maxToolCalls: 4,    // at most 4 searches — then forced synthesis (see file 02)
```

```
  Why these numbers ARE the escalation answer

  symptom you might see          buffr's plain-ReAct response
  ─────────────────────────      ────────────────────────────────
  "loops re-searching forever" → maxToolCalls:4 + budget exit    (no new pattern)
  "never finishes"             → maxTurns:6 + forced synthesis   (no new pattern)
  "drifts off the question"    → NOT SEEN yet → don't add plan-execute on spec
  "confidently wrong"          → NOT SEEN yet → don't add reflexion on spec
```

Annotation: the two failures a tuned bound *does* fix (runaway, never-finishing), buffr
fixes with numbers, not new patterns. The two failures the *next* rungs fix (drift,
confident-wrong) buffr hasn't measured — so it correctly hasn't escalated. This is the
verdict-first take: **don't add plan-and-execute or reflexion until you have a logged
failure those patterns specifically address.**

### Move 3 — the principle

**ReAct is the floor; escalation is a response to a measured failure, never a default
ambition.** Each rung up the ladder multiplies token cost and latency. The senior move is to
ship plain ReAct, instrument the trajectory, and climb exactly one rung when — and only
when — a specific, logged failure mode demands it. buffr is at the floor on purpose, with
the trajectory captured (Section D) so that *if* a failure shows up, the escalation is
evidence-driven.

## Primary diagram

Full recap: buffr's ReAct, its bounds, and the un-taken rungs above it.

```
  buffr — plain bounded ReAct, escalation rungs unspent

  ┌─ NOT TAKEN (no measured failure justifies the cost) ───────┐
  │  ToT  (5-15x)   ·  reflexion (2-5x)  ·  plan-execute (~1.2x)│
  └──────────────────────────┬─────────────────────────────────┘
                             │ would escalate IF logged failure
  ┌─ ★ RUNNING: plain ReAct ★ ─────────────────────────────────┐
  │  prompt: "search first, then ground"   rag-query:20-27     │
  │  loop:   reason → act → observe        run-agent-loop:98-190│
  │  bounds: maxTurns:6 · maxToolCalls:4   rag-query:75-76      │
  │  exit:   no-tool (success) OR budget (forced synthesis)     │
  └────────────────────────────────────────────────────────────┘
```

The one-liner: buffr is **plain ReAct with two measured bounds**, and the ladder above it is
intentionally unclimbed.

## Elaborate

ReAct (Yao et al., 2022, "ReAct: Synergizing Reasoning and Acting in Language Models")
showed that interleaving chain-of-thought with tool calls beats either alone — the model
grounds its reasoning in observations instead of hallucinating. It became the default agent
loop precisely because it's the *minimal* thing that gives a model tools. Everything in this
sub-section's files 04-06 is a strictly more expensive elaboration of it.

The thing interviewers probe is whether you reach for ReAct reflexively or know when to
leave it. The strong answer is buffr's: ReAct by default, bounds tuned to the observed loop
behavior, and the trajectory logged so the *next* pattern (if any) is chosen from evidence.
The detailed Thought-Action-Observation mechanics — how the model is prompted to emit a
thought before an action, how observations are formatted — live in `study-ai-engineering`;
this file deliberately doesn't duplicate them.

Read next: `04-plan-and-execute.md` — the first rung up, and the honest "not yet" for buffr.

## Interview defense

**Q: "Why just ReAct? Why not a planner or a self-critique loop?"**

Model answer: "Because nothing measured justifies the cost yet. buffr runs plain bounded
ReAct (`run-agent-loop.ts:98-190`) with `maxTurns:6` and `maxToolCalls:4`
(`rag-query-agent.ts:75-76`). The two failures tuned bounds fix — runaway loops and
never-finishing — I fix with those numbers plus the forced-synthesis budget exit. The
failures the next rungs fix — task drift (plan-execute) and confident-wrong answers
(reflexion, 2-5x tokens) — I haven't logged on this workload. I capture the full trajectory,
so when one shows up I'll climb exactly one rung, on evidence. Escalating on spec is how you
ship a slow, expensive agent that's no more correct."

```
  The defense in one picture

  measured failure?  ── no ──▶ stay on ReAct (cheapest loop that works)
        │ yes
        ▼
  climb ONE rung that targets THAT failure
```

Anchor: *ReAct is the floor; you climb only when a logged failure pays for the cost.*

## See also

- `02-agent-loop-skeleton.md` — the kernel ReAct names (reason=step, act=execute, observe=accumulate).
- `04-plan-and-execute.md` / `05-reflexion-self-critique.md` / `06-tree-of-thoughts.md` —
  the rungs above ReAct, all *Not yet implemented* in buffr.
- `study-ai-engineering` → ReAct Thought-Action-Observation *mechanics* (deliberately not re-taught here).
- `../00-overview.md` — "Not yet exercised" lists these escalations as design-only.
