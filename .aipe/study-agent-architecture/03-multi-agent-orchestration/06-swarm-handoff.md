# Swarm / handoff — peer-to-peer control transfer, no central boss

**Industry name(s):** swarm · handoff · peer agents · decentralized
agents. **Type label:** Industry standard.

**In this codebase: Not yet implemented — and an unlikely fit.** buffr
has one agent and no peers to hand off to. Even the two-brain design in
`agent-layer-plan.md` is better served by supervisor-worker (a clear
laptop boss) than by leaderless handoff — so this is study material
buffr would most likely *not* adopt.

## Zoom out, then zoom in — lead with the shape

```
  Swarm / handoff topology (lead with it)

      ┌────────┐  "you take it"  ┌────────┐
      │agent A │ ──────────────► │agent B │
      └────────┘                 └───┬────┘
           ▲                         │ "back to you"
           └─────────────────────────┘
   no central boss — peers transfer control directly
```

Zoom in: in swarm/handoff, the model itself decides when to hand
control to a peer specialist. More flexible than supervisor-worker (no
central bottleneck), harder to debug (no single point that knows the
whole state). Its signature failure — infinite handoff (A → B → A → B)
— is covered in the coordination-failure-modes file.

## Structure pass

**Layers.** Peers at one level, no supervisor above. State travels with
control, not through a central store.

**Axis — "who knows the whole state?"** In supervisor-worker, the
supervisor does. In swarm, *nobody* does — each peer sees only what was
handed to it. That's the flexibility and the debugging cost in one.

**Seam.** The handoff itself: A transferring control to B, with whatever
context A chooses to pass. A bug there (A hands off without the context
B needs) is the swarm's characteristic failure, alongside the infinite-
handoff loop.

## How it works

#### Move 1 — the mental model

Think of an event bus where any handler can re-emit to any other handler
with no orchestrator deciding the order. Swarm is that for agents: a
peer decides "this isn't mine, B should handle it" and transfers
control, carrying the conversation with it.

```
  Pattern — peer handoff

  user → agent A (handles, then decides not-mine)
            │ handoff(context) → agent B
            ▼
         agent B (handles or hands off again)
            │ no central coordinator tracks the whole path
            ▼
         eventual answer  (cap handoffs or it can cycle)
```

#### Move 2 — the walkthrough (why buffr would skip it)

**Swarm needs peers; buffr has one actor.** There is no second agent in
buffr to hand off to. The two-brain design *could* be peer-to-peer
(laptop hands to phone, phone hands back), but it has a natural boss —
the laptop owns the heavy store and the conversation — so
supervisor-worker (`02-supervisor-worker.md`) fits better. Swarm's
benefit (no central bottleneck) isn't a problem buffr has.

**The traceability cost is the deal-breaker for buffr.** buffr captures
a full-signal trajectory into one conversation (`src/supabase-trace-sink.ts`).
Swarm scatters state across peers with no single point that knows the
whole run — directly at odds with buffr's "one conversation, one
replayable trajectory" design (`src/session.ts:55`). A topology that
makes the run *harder* to trace is the wrong fit for a system built
around tracing.

**The failure swarm introduces.** Infinite handoff: A hands to B, B
hands back to A, forever. The mitigation is a handoff counter that force-
stops or escalates — the same budget-exit instinct as the agent loop's
`maxToolCalls`, applied to handoffs. See
`09-coordination-failure-modes.md`.

```
  Comparison — supervisor-worker vs swarm for two-brain buffr

  supervisor-worker (fits):        swarm (doesn't fit):
    laptop boss routes to phone      laptop ⇄ phone peer handoff
    one point knows whole state      no point knows whole state
    traceable in one conversation    state scattered, hard to replay
```

#### Move 3 — the principle

Swarm trades central control for flexibility — no bottleneck, but no
single point that knows the whole state. It fits leaderless problems
where any peer might own the next step. buffr is the opposite: it has a
natural boss and is built around a single replayable trajectory, so
even its multi-agent future would pick supervisor-worker over swarm.
Knowing *why you wouldn't* use swarm is the lesson here.

## Primary diagram

```
  Swarm / handoff (recognized, not a fit for buffr)

  agent A ──handoff(ctx)──► agent B ──handoff(ctx)──► agent C
     ▲                                                  │
     └──────────────── could cycle ─────────────────────┘
   mitigate: handoff counter → force-stop / escalate
   buffr's trajectory design wants ONE knower → supervisor-worker instead
```

## Elaborate

Swarm/handoff got popular via lightweight agent frameworks that made
"transfer to another agent" a first-class primitive. It shines for
support-routing problems where the right specialist isn't known up front
and any agent can route to any other. Its decentralization is precisely
what a trajectory-first, single-store system like buffr doesn't want —
which is why this file's main value is the *non*-adoption reasoning.

## Interview defense

**Q: Would swarm/handoff fit buffr's multi-agent future?**
No — I'd pick supervisor-worker. buffr has a natural boss (the laptop
owns the heavy store and the conversation) and is built around one
replayable trajectory. Swarm scatters state across peers with no single
knower, which fights buffr's trace-everything design. Swarm fits
leaderless routing problems; buffr isn't one.

```
  swarm = no central knower   |   buffr wants one knower → supervisor
```

**Anchor:** "Swarm trades central control for flexibility — buffr's
trajectory-first design wants the central knower, so it'd skip swarm."

## See also

- `02-supervisor-worker.md` — the topology buffr would actually pick
- `09-coordination-failure-modes.md` — the infinite-handoff failure
- `07-graph-orchestration.md` — explicit control where swarm is
  implicit
