# Coordination failure modes — the failures that don't exist in single-agent

**Industry name(s):** coordination failures · multi-agent failure modes
· the coordination tax. **Type label:** Industry standard.

**In this codebase: Not yet applicable — and that's the point.** buffr
is single-agent, so none of these failures *can* happen yet. This file
makes the "2-5x overhead" claim from `01-when-not-to-go-multi-agent.md`
concrete: these are the specific ways the tax shows up, and the specific
controls that bound it. buffr's existing single-agent controls
(`maxToolCalls`, the forced synthesis) are the seeds of the multi-agent
versions.

## Zoom out, then zoom in

```
  Zoom out — failures that appear only above one agent

  ┌─ Single-agent (buffr) ──────────┐  ┌─ Multi-agent ──────────────┐
  │  loop runaway → maxToolCalls    │  │  + infinite handoff         │
  │  cost blowup → token budget     │  │  + tool-call cascade        │ ← we are here
  │  (buffr has these guards)       │  │  + context bloat            │
  │                                 │  │  + synthesis failure        │
  └─────────────────────────────────┘  └────────────────────────────┘
```

Zoom in: crossing the multi-agent gate adds a class of failures that
single-agent systems simply don't have, because they're failures of
*coordination*, not of one loop. Each has a specific mitigation, and
most mitigations are the single-agent guards scaled up.

## Structure pass

**Layers.** These failures live at the coordination layer — between
agents — not inside any one agent's loop.

**Axis — "what bounds the runaway?"** Every coordination failure is some
form of unbounded work (handoffs, tool calls, context, cost). The
mitigation is always a bound: a counter, a cap, a budget, a schema. The
axis is "where's the cap."

**Seam.** The seams are the inter-agent boundaries — handoff edges,
worker spawns, the synthesis merge. Each failure lives at one of those
seams, which is precisely why single-agent systems don't have them.

## How it works

#### Move 1 — the mental model

You know how an unbounded recursion or an unbounded queue takes a system
down? Every coordination failure is a version of that — unbounded
handoffs, unbounded tool calls, unbounded context — and every fix is the
same instinct as `maxToolCalls`: put a bound on it.

```
  Pattern — the failure / mitigation table

  ┌──────────────────────┬──────────────────────────┐
  │ Failure              │ Mitigation               │
  ├──────────────────────┼──────────────────────────┤
  │ Infinite handoff     │ Handoff counter; force   │
  │ (A→B→A→B…)            │ stop or escalate to human│
  ├──────────────────────┼──────────────────────────┤
  │ Tool-call cascade    │ Per-agent AND global      │
  │ (one agent triggers  │ iteration caps; budget    │
  │ a storm of calls)    │ ceiling that halts the run│
  ├──────────────────────┼──────────────────────────┤
  │ Context bloat as      │ Message passing / context │
  │ agents accumulate     │ routing instead of one     │
  │ shared state         │ shared blackboard          │
  ├──────────────────────┼──────────────────────────┤
  │ Synthesis failure    │ Validate worker outputs    │
  │ (supervisor merges    │ against a schema before    │
  │ contradictory results│ synthesis; surface         │
  │ )                    │ conflicts, don't average   │
  ├──────────────────────┼──────────────────────────┤
  │ Cost blowup          │ Per-run token budget;      │
  │ (2-5x overhead       │ cheap models for workers,  │
  │ compounds silently)  │ expensive only for supervisor│
  └──────────────────────┴──────────────────────────┘
```

#### Move 2 — the walkthrough (buffr's single-agent guards as seeds)

**Tool-call cascade → buffr already caps the single-agent version.**
buffr bounds its one agent's tool calls at 4 (`maxToolCalls`,
`rag-query-agent.js:48`) and forces synthesis when the budget trips
(`run-agent-loop.js:27-34`). In a multi-agent system you'd need *both*
per-agent caps (each worker bounded) *and* a global cap (the whole run
bounded), because a supervisor spawning workers that each spawn tool
calls multiplies fast. buffr has the per-agent cap; the global cap is
the multi-agent addition.

**Cost blowup → buffr's context guard is the single-agent seed.** buffr
wraps its model in a `ContextWindowGuardedProvider` that throws if
estimated input exceeds the budget (`context-window-guard.js:27-38`).
That's a per-call cost guard. The multi-agent version is a *per-run*
token budget across all agents, plus the "cheap workers, expensive
supervisor only" rule — run cheap models on the workers and reserve the
strong model for the one synthesis turn.

**Context bloat → buffr's shared blackboard would need routing.** buffr's
`chunks` table is a shared blackboard
(`08-shared-state-and-message-passing.md`). With one agent that's fine;
with many, every agent seeing everything is context bloat and
lost-in-the-middle scaling with agent count. The fix is routing
role-specific context — context engineering applied to multi-agent
(`04-agent-infrastructure/01-context-engineering.md`).

**Synthesis failure → buffr has no merge yet.** With one agent there's
nothing to merge. A supervisor merging contradictory worker results
should validate each against a schema and surface conflicts rather than
average them. buffr's trajectory schema discipline
(`src/supabase-trace-sink.ts`) is the instinct; a merge validator would
be the multi-agent application.

```
  Comparison — buffr's guards vs the multi-agent versions

  buffr single-agent (has):        multi-agent (would add):
    maxToolCalls: 4                  + global run cap
    forced synthesis turn            + per-worker caps
    ContextWindowGuardedProvider     + per-run token budget
    one-conversation trace           + schema-validated merge
```

#### Move 3 — the principle

Every coordination failure is unbounded work at an inter-agent seam, and
every mitigation is a bound — a counter, a cap, a budget, a schema.
That's why buffr's single-agent guards (`maxToolCalls`, forced
synthesis, the context guard) are the seeds of the multi-agent controls:
same instinct, scaled to the new seams. The "2-5x overhead" is exactly
these failures compounding; bounding each one is what keeps the tax
finite.

## Primary diagram

```
  Coordination failures and their bounds (buffr's seeds marked)

  infinite handoff   → handoff counter        (buffr: n/a — no peers)
  tool-call cascade  → per-agent + global cap  (buffr has per-agent: 4)
  context bloat      → context routing         (buffr: shared blackboard)
  synthesis failure  → schema-validate merge   (buffr: n/a — no merge)
  cost blowup        → per-run budget          (buffr: per-call guard)
```

## Interview defense

**Q: What new failures would buffr face going multi-agent?**
A whole class that single-agent doesn't have: infinite handoff, tool-call
cascade, context bloat across agents, synthesis of contradictory
results, and silent cost blowup. Each is unbounded work at an inter-agent
seam, and each fix is a bound. buffr already has the single-agent seeds —
`maxToolCalls: 4`, the forced synthesis turn, the context-window guard —
so the multi-agent work is scaling those to global caps, per-run
budgets, and schema-validated merges.

```
  every coordination failure = unbounded work → every fix = a bound
```

**Anchor:** "The 2-5x tax is these failures compounding — buffr's
single-agent caps are the seeds of the multi-agent bounds."

## See also

- `01-when-not-to-go-multi-agent.md` — where the 2-5x claim is made
- `08-shared-state-and-message-passing.md` — the context-bloat source
- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the budget exit
  these scale from
- `05-production-serving/03-per-tool-circuit-breaking.md` — the
  tool-cascade control
- `04-agent-infrastructure/05-guardrails-and-control.md` — the control
  envelope
