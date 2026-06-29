# Swarm / Handoff

*Industry names: **swarm** / **peer handoff** / **decentralized agents** / **agent-to-agent handoff**. Type label: Industry standard (popularized by OpenAI's Swarm / Agents SDK). In this codebase: **Not yet implemented.** (buffr is single-agent; there is no second agent to hand off to.)*

## Zoom out, then zoom in

This is supervisor–worker with the supervisor *removed*: peers hand control to each other
directly, no central boss. Here is the SHAPE first.

```
  THE TOPOLOGY — peers hand off to peers, NO central node (★ = active agent)

   user ─▶ ┌─ ★ AGENT A ─┐ "this is billing" ┌─ AGENT B ─┐
           │ (triage)     │──── handoff ─────▶│ (billing) │
           └──────────────┘                   └─────┬─────┘
                  ▲                                  │ "needs refund approval"
                  │ handoff back                     ▼
                  │                            ┌─ AGENT C ─┐
                  └──────── handoff ───────────│ (refunds) │
                                               └───────────┘
   ★ = whoever currently holds control · NO supervisor anywhere
```

The topology is the mental model: **a ring/graph of peers passing a baton, with no node above
them.** Exactly one agent holds control at a time; it decides which peer gets the baton next.
The honest sentence: buffr has one agent and nobody to hand off to. This file teaches the shape
and introduces its signature failure — the infinite handoff (detailed in `09`).

## Structure pass

One axis: **control** — where does the "who's next" decision live?

```
  Axis = CONTROL · the SEAM is removing the central decider

  supervisor–worker   a CENTRAL supervisor decides who runs next, then merges
  ──────────── ★ SEAM: delete the supervisor; peers decide ★ ──────────
  swarm/handoff       EACH agent decides who gets control next — no central node
```

Swarm is what you get when you take handoff-style supervisor–worker (`02`) and delete the
supervisor. The decision "who handles this next" no longer lives in one place — it's
distributed across every agent. That's the strength (flexible, each specialist routes to the
next specialist with local knowledge) and the danger (no single point of termination, no
central merge — control can ricochet between peers forever). The seam is the *absence* of a
central decider, and that absence is the whole risk profile.

## How it works

### Move 1 — mental model

Agents passing a baton, each deciding who runs next. Bridge from frontend: it's like
client-side routing where any page can `navigate()` to any other page — there's no central
router component deciding; each view triggers the next transition itself. Powerful, but you can
build a redirect loop with no one to stop it.

```
  THE SHAPE — the baton passes, control is held by exactly one peer

   [AGENT A holds control] ── decides ──▶ handoff to B
   [AGENT B holds control] ── decides ──▶ handoff to C
   [AGENT C holds control] ── decides ──▶ answer  OR  handoff to A (← loop risk)
            no node sits ABOVE A, B, C
```

### Handoff — control TRANSFERS, no value returns

Unlike a tools-style worker call (which returns a value), a handoff *transfers control* and does
not automatically come back. The receiving agent now owns the conversation. This is the same
transfer as handoff-style supervisor–worker, but with no supervisor to return to.

```
  Handoff — transfer, not call; nothing returns automatically

  tools-style call:  A ──call──▶ B ──value──▶ A   (A resumes; control RETURNS)
  swarm handoff:     A ──hand──▶ B               (B now drives; control does NOT return)
                                  │
                                  └──hand──▶ C ──hand──▶ ... (no automatic stop)
```

Annotation: "control does not return automatically" is the load-bearing fact. In tools-style
there's always one agent (the supervisor) whose budget exit guarantees termination. In a swarm,
*no single agent's budget bounds the whole run* — A spending its budget just hands to B, which
has a fresh budget. This is why a swarm needs a **global** handoff counter, not just per-agent
caps (see `09`).

### The infinite-handoff failure — introduced here, mitigated in 09

Because control ricochets with no central stop, two agents can hand off to each other forever —
A thinks it's B's job, B thinks it's A's job. Each handoff is a model call, so this is a runaway
cost, not just a hang.

```
  Infinite handoff — the swarm's signature failure

   A ──"that's billing's job"──▶ B ──"that's triage's job"──▶ A ──▶ B ──▶ ...
        └──────────────────── forever, burning a model call each hop ────────┘

   MITIGATION (see 09): a GLOBAL handoff counter that caps total transfers,
                        independent of any single agent's budget.
```

Annotation: this failure *does not exist* in single-agent systems — buffr cannot infinite-handoff
because there's no one to hand off to. It's introduced by the topology. The fix is a global
handoff counter and a forced-synthesis fallback when it trips — the multi-agent analogue of
buffr's existing budget exit.

### What buffr does instead — one agent, no handoff

buffr is a single actor with a single budget exit. There is no handoff mechanism and no second
agent.

```
  buffr (today)              vs    swarm (NOT YET)

  one agent                        A ⇄ B ⇄ C   (peers hand off, no boss)
  one budget exit bounds it          needs a GLOBAL handoff counter
  run-agent-loop.ts:101-109        DESIGN-ONLY
```

Annotation: a swarm is the *least* likely refactor for buffr — it's the topology with the
weakest termination guarantees, suited to many distinct specialist domains routing among
themselves (customer-support triage → billing → refunds). buffr's single RAG job has no
specialist peers to swarm. Not yet, and probably not first.

### Move 3 — the principle

**A swarm removes the central decider, gaining flexibility but losing the single termination
point — so it demands a global handoff counter.** Reach for it when you have many distinct
specialist domains where each specialist genuinely knows best who to route to next, and a
central supervisor would be a bottleneck. Don't reach for it before you've internalized that no
single budget bounds the run — the global handoff cap is mandatory, not optional. For most
systems, handoff-style supervisor–worker (`02`) gives the flexibility with a central stop;
prefer it unless the central node is a real bottleneck.

## Primary diagram

Full recap: the bossless ring, the handoff transfer, the infinite-handoff risk, the verdict.

```
  Swarm/handoff — peers, no boss, global cap required

   ┌─ AGENT A ─┐ ⇄ ┌─ AGENT B ─┐ ⇄ ┌─ AGENT C ─┐
   │ triage     │   │ billing    │   │ refunds    │
   └────────────┘   └────────────┘   └────────────┘
        control held by exactly ONE at a time · NO supervisor

  HANDOFF = transfer, control does NOT return automatically
  RISK    = infinite handoff (A⇄B forever) — burns a model call per hop
  FIX     = GLOBAL handoff counter (single budget no longer bounds the run)
  ───────────────────────────────────────────────────────────────
  buffr: NOT YET · one agent, one budget exit · least-likely refactor
  refactor template: SECTION F · supervisor template (prefer central stop first)
```

Verdict in one line: **the bossless topology — maximum flexibility, weakest termination, needs a
global handoff counter — and buffr's least-likely refactor, since it has no specialist peers and
one job.**

## Elaborate

Swarm was popularized by OpenAI's "Swarm" experiment and lives on in the Agents SDK's
`handoff()`. The defining design tension is decentralization vs. control: removing the
supervisor makes routing flexible and locally-smart, but it deletes the single termination
point, so the framework-level fix is always a global cap on transfers (the SDK enforces handoff
limits for this reason). The customer-support triage example is the canonical fit — a triage
agent that hands to billing, billing that hands to refunds — because those are genuinely
distinct domains where each agent knows its successor better than a central router would. Most
other systems are better served by a central supervisor with handoffs, which keeps the single
stop.

To adopt any handoff topology for buffr, see SECTION F's supervisor template — and note it
recommends a central stop (supervisor) before a fully decentralized swarm.

## Interview defense

**Q: "What's the risk of a swarm / handoff topology, and how do you bound it?"**

Model answer: "A swarm deletes the central supervisor — peers hand control to each other
directly, exactly one holds the baton at a time. The risk is that a handoff *transfers* control
and never automatically returns, so no single agent's budget bounds the whole run — A can hand to
B, B back to A, forever, burning a model call per hop. That infinite-handoff failure doesn't
exist in single-agent systems like buffr, which has one budget exit (`run-agent-loop.ts:101-109`)
and nobody to hand off to. The fix is a *global* handoff counter independent of any per-agent cap,
plus a forced-synthesis fallback when it trips — the multi-agent analogue of buffr's budget exit.
Honestly, for most systems I'd prefer handoff-style supervisor–worker, which keeps a central
termination point; a swarm only earns its keep with many distinct specialist domains."

```
  The defense in one picture

  swarm: A ⇄ B ⇄ C, no boss → flexible BUT no single budget bounds the run
  fix: GLOBAL handoff counter + forced-synthesis fallback
  buffr: one agent, one budget exit → cannot infinite-handoff (no peer)
```

Anchor: *A swarm has no central stop, so it needs a global handoff counter — the infinite-handoff
failure is purely a multi-agent disease buffr's single budget exit can't catch because there's no
peer to hand to.*

## See also

- `02-supervisor-worker.md` — swarm is this with the supervisor deleted; handoff-style is the
  bridge.
- `09-coordination-failure-modes.md` — the global handoff counter and the infinite-handoff
  failure in full.
- `08-shared-state-and-message-passing.md` — what the baton carries between peers.
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the budget exit a swarm must reproduce
  globally.
- `../06-orchestration-system-design-templates/` (SECTION F) — the supervisor template (prefer a
  central stop).
