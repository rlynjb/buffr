# Coordination Failure Modes

*Industry names: **coordination failures** / **multi-agent failure modes** / **orchestration failure taxonomy**. Type label: Industry standard. In this codebase: **Not yet applicable** (single-agent) — but buffr already prevents the single-agent version of one of them.*

## Zoom out, then zoom in

This is the bill for going multi-agent: five failures that *do not exist* in single-agent systems,
each created by coordination itself. Here is the SHAPE — the failure map — first.

```
  THE FAILURE MAP — five coordination-only failures and their mitigations (★ = each pairs)

  ┌─ FAILURE ──────────────┬─ MITIGATION ───────────────────────┐
  │ ★ infinite handoff      │ global handoff counter             │
  │ ★ tool-call cascade     │ per-agent + global tool caps       │
  │ ★ context bloat         │ message passing (scoped context)   │
  │ ★ synthesis failure     │ schema-validate BEFORE merging     │
  │ ★ cost blowup           │ per-run budget + cheap workers     │
  └─────────────────────────┴────────────────────────────────────┘
   NONE of these exist with one agent · ALL are bought with coordination
```

The shape is the mental model: **a five-row table, failure paired with its mitigation.** These are
the concrete contents of the "2–5x overhead" the gate (`01`) warns about. The honest sentence:
buffr is single-agent, so it has *none* of these — but it already implements the single-agent
analogue of the tool-call cascade fix, which is the bridge this file lands on.

## Structure pass

One axis: **cost** — each failure is a different way coordination multiplies your bill.

```
  Axis = COST · the SEAM is single-agent (one budget bounds everything) vs multi (N budgets)

  single-agent      ONE budget exit bounds turns, tools, tokens, cost — all of it
  ──────────── ★ SEAM: N agents = N budgets, no single one bounds the WHOLE run ★ ──────────
  multi-agent       each failure is a budget that NO single agent's cap can bound
```

This seam is why these failures are multi-agent-only. In buffr, one budget exit
(`run-agent-loop.ts:101-109`) bounds *everything* — it can't infinite-handoff (no peer), can't
cascade across agents (one agent), can't bloat across N contexts (one context). The moment you have
N agents, no single agent's cap bounds the *whole run* — handoffs cross agents, tool calls sum
across agents, contexts multiply. Every mitigation below is about restoring a *global* bound that
single-agent got for free from its one budget exit. That seam is the file.

## How it works

### Move 1 — mental model

Five failures, each a global bound you have to *add back* because coordination removed it. Bridge
from frontend: it's the jump from one fetch (one timeout bounds it) to a fan-out of fetches where
you suddenly need `Promise.race` timeouts, an abort controller across all of them, and a budget on
total requests — the coordination created failures the single fetch never had.

```
  THE SHAPE — each failure removes a bound; each mitigation adds it back globally

   single agent: ONE budget exit bounds {turns, tools, context, cost}
        │ go multi-agent → the single bound no longer covers the whole run
        ▼
   FAILURE                 →  ADD BACK (global bound)
   infinite handoff        →  global handoff counter
   tool-call cascade       →  per-agent + global tool caps
   context bloat           →  scoped message passing
   synthesis failure       →  validate before merge
   cost blowup             →  per-run budget + cheap workers
```

### Infinite handoff — and its mitigation

Two agents hand control back and forth forever (swarm, `06`). No single budget stops it because
each handoff lands on a fresh-budget agent.

```
  Infinite handoff → global handoff counter

   A ⇄ B ⇄ A ⇄ B ...                  FIX: handoffs++ on every transfer;
   each hop = a model call                 at limit → force synthesis & stop
   no per-agent cap stops it               (a GLOBAL counter, not per-agent)
```

### Tool-call cascade — and the one buffr already prevents

Agents trigger each other's tool calls until the total explodes. The single-agent version is one
agent searching forever — and **buffr already prevents that**.

```
  Tool-call cascade → per-agent + GLOBAL tool caps

  multi-agent:  A calls B calls C calls tool ... total tool calls balloon
                FIX: per-agent cap AND a global cap across all agents

  buffr (single-agent version ALREADY HANDLED):
    maxToolCalls:4 (rag-query-agent.ts:75-76) + forced synthesis
    (run-agent-loop.ts:101-109) → tools STRIPPED at the cap, model MUST answer
```

```ts
// run-agent-loop.ts:101-109 — buffr's single-agent cascade prevention (already shipped)
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;  // 4 calls?
const forceFinal = turn === maxTurns - 1 || budgetSpent;
const response = await model.complete({
  tools: forceFinal ? undefined : toolSchemas,   // ← tools REMOVED → no more calls possible
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  ...
});
```

Annotation: this is the bridge. buffr already has the *single-agent* version of cascade prevention —
a tool cap plus forced synthesis that physically removes the tools. The multi-agent version just
adds a *global* cap across all agents on top of each agent's local cap. buffr's iteration cap and
forced synthesis (`run-agent-loop.ts:101-109`) are exactly the kind of bound that, replicated
globally, tames a multi-agent cascade.

### Context bloat — and its mitigation

A shared blackboard (`08`) grows with the whole run; every agent re-reads it; prompts balloon.

```
  Context bloat → message passing (scoped context)

   shared blob = {A's, B's, C's, ... everything}   FIX: send each agent ONLY its slice
   every agent re-reads ALL of it → cost ↑, signal lost     → contexts stay small + on-topic
```

Annotation: buffr's single-agent analogue is bounded — its `messages` array grows but is capped by
`maxTurns:6` and 16k tool-result truncation (`run-agent-loop.ts:52-57`). Multi-agent removes that
single bound, so you scope per-agent instead.

### Synthesis failure — and its mitigation

The merge (fan-out `04`, pipeline `03`) gets malformed or conflicting branch outputs and produces
garbage or crashes.

```
  Synthesis failure → schema-validate BEFORE merging

   [branch A: valid] ┐
   [branch B: garbage]┼─▶ MERGE  ✗ → bad answer / crash
   [branch C: valid] ┘
   FIX: validate each branch against a schema BEFORE the merge sees it; drop/retry the bad one
```

Annotation: buffr's single-agent analogue is the `FALLBACK_ANSWER` backstop — if `finalText` is
empty, it returns a safe string (`rag-query-agent.ts:31,82`). The multi-agent version validates each
branch *before* combining, so one bad branch can't poison the merge.

### Cost blowup — and making the "2–5x" concrete

Every agent is a model call; coordinators add calls; the bill multiplies.

```
  Cost blowup → per-run budget + cheap workers · the 2–5x made concrete

   1 agent          = 1× model calls       (buffr today)
   supervisor + 3   = ~4× (super + 3 workers)
   + a merge call    = ~5×
   + 2 revise loops  = even more
   FIX: a per-RUN token/dollar budget across ALL agents + use CHEAP models for workers,
        reserve the expensive model for the supervisor/merge
```

Annotation: this is the "2–5x overhead" from the gate (`01`) in numbers — a supervisor over three
workers plus a merge is roughly 5x buffr's single call. The mitigation is a *per-run* budget (not
per-agent) plus cheap worker models, expensive model only where judgment matters.

### Move 3 — the principle

**Every coordination failure is a bound that single-agent got for free and multi-agent must add back
globally.** The discipline: for each topology you adopt, name which of these five it introduces and
wire the matching global bound *before* you ship it — global handoff counter, global tool cap,
scoped contexts, pre-merge validation, per-run budget. buffr proves the single-agent baseline: one
budget exit already gives it cascade prevention and a fallback backstop for free. Multi-agent's
whole tax is re-buying those guarantees at the *system* level.

## Primary diagram

Full recap: the five failures, their global mitigations, buffr's free guarantees.

```
  Coordination failure modes — the bill for multi-agent

  FAILURE              MITIGATION (global bound)        buffr's single-agent status
  infinite handoff  →  global handoff counter           N/A (no peer)
  tool-call cascade →  per-agent + global tool caps      ALREADY: maxToolCalls:4 + forced
                                                          synthesis (run-agent-loop:101-109)
  context bloat     →  scoped message passing            bounded: maxTurns:6 + 16k truncate
  synthesis failure →  validate before merge             backstop: FALLBACK_ANSWER (rag:31,82)
  cost blowup       →  per-run budget + cheap workers     1× (single call) — the 2–5x is what
                                                          you'd ADD going multi-agent
  ───────────────────────────────────────────────────────────────
  one budget exit bounds buffr's WHOLE run · multi-agent re-buys this at system level
```

Verdict in one line: **these five failures are the concrete 2–5x tax of coordination; buffr's single
budget exit already gives it cascade prevention and a fallback for free — multi-agent must re-add
every bound globally.**

## Elaborate

This taxonomy is the hard-won content of every multi-agent post-mortem: Anthropic's multi-agent
research write-up, LangGraph's recursion-limit/checkpoint guidance, and the OpenAI Agents SDK's
handoff limits all exist *because* of these exact failures. The unifying insight is the structure-
pass seam — single-agent has one budget that bounds everything, and coordination shatters that into N
budgets none of which bounds the whole run, so every mitigation is "restore a global bound." That's
why the senior framing is never "multi-agent is better" but "multi-agent costs me these five bounds I
have to re-engineer — is the decomposable failure worth it?" (back to the gate, `01`).

buffr is a clean demonstration of the baseline these failures are measured against: its single budget
exit (`run-agent-loop.ts:101-109`) plus forced synthesis plus the `FALLBACK_ANSWER` backstop give it,
for free, the single-agent versions of cascade prevention and synthesis-failure protection. To adopt
the multi-agent versions, see SECTION F's templates — each names the global bound the topology needs.

## Interview defense

**Q: "What breaks in a multi-agent system that doesn't break in a single agent?"**

Model answer: "Five things, all from coordination. Infinite handoff — peers ping-pong forever; fix is
a *global* handoff counter. Tool-call cascade — agents trigger each other's tools until the count
explodes; fix is per-agent plus a global tool cap. Context bloat — a shared blackboard grows and every
agent re-reads it; fix is scoped message passing. Synthesis failure — a merge gets garbage branches;
fix is schema-validating before the merge. Cost blowup — every agent is a model call, so a supervisor
plus three workers plus a merge is roughly 5x one agent; fix is a per-run budget and cheap worker
models. The unifying point: single-agent has *one* budget exit that bounds everything, and
coordination shatters that into N budgets none of which bounds the whole run — so every fix restores a
*global* bound. buffr proves it — it already has the single-agent cascade fix: `maxToolCalls:4` plus
forced synthesis that strips the tools (`run-agent-loop.ts:101-109`), and a `FALLBACK_ANSWER`
backstop. Multi-agent's whole tax is re-buying those at the system level."

```
  The defense in one picture

  single agent: ONE budget exit bounds {handoffs, tools, context, synthesis, cost}
  multi-agent: shatters into N budgets → re-add each bound GLOBALLY
  buffr already has: maxToolCalls:4 + forced synthesis (cascade) + FALLBACK (synthesis)
```

Anchor: *Five coordination failures — infinite handoff, tool cascade, context bloat, synthesis
failure, cost blowup — each is a global bound single-agent got free; buffr already implements the
single-agent cascade fix via `maxToolCalls:4` + forced synthesis.*

## See also

- `01-when-not-to-go-multi-agent.md` — these failures ARE the 2–5x overhead the gate weighs.
- `06-swarm-handoff.md` — infinite handoff in full; `04-parallel-fan-out.md` — synthesis failure.
- `08-shared-state-and-message-passing.md` — context bloat and the message-passing fix.
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — buffr's budget exit (the single-agent bound
  these all reproduce globally).
- `../06-orchestration-system-design-templates/` (SECTION F) — each template names its global bound.
