# Per-tool circuit breaking — a dead tool shouldn't burn the budget

**Industry name(s):** per-tool circuit breaker · tool health gating ·
feed-the-breaker-state-to-the-agent. **Type label:** Industry standard.

**In this codebase: Not yet implemented.** buffr has no circuit breaker
on its one tool. If `search_knowledge_base` started failing (pgvector
down, Ollama embedder unreachable), buffr's loop would retry it on every
turn until the budget runs out. The `maxToolCalls: 4` cap *bounds* that
damage, but doesn't *route around* it.

## Zoom out, then zoom in

```
  Zoom out — the breaker scoped to a tool, inside the loop

  ┌─ Agent loop ─────────────────────────────────────────────┐
  │  Agent calls tool X                                       │
  │       ▼                                                   │
  │  ┌─ Circuit breaker (per tool) ─────────────────┐         │ ← we are here
  │  │  closed: pass · N fails → OPEN: fail fast      │        │
  │  │  after T: half-open, try one                   │        │
  │  └────────────────────┬───────────────────────────┘        │
  │       ▼ open?                                              │
  │  agent OBSERVES "tool X unavailable" and routes around it  │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: single-call retry handles one flaky request. An agent loop can
call the *same flaky tool every turn* — retrying a dead tool inside a
loop multiplies the failure by the iteration count and burns the whole
budget on a tool that isn't coming back. A per-tool breaker fails fast
*and* feeds that state back to the agent so it can route around the dead
tool.

## Structure pass

**Layers.** The breaker sits between the loop's execute step and the tool
handler — a gate on `callTool`.

**Axis — "what happens when a tool keeps failing?"** Without a breaker:
retry every turn until the budget dies. With a breaker: fail fast after N
failures, and tell the agent. The difference is budget-ending vs
routed-around.

**Seam.** The `tools.callTool` boundary (`run-agent-loop.js:76`). That's
where a breaker would intercept — and crucially, where the open-circuit
state would be turned into an *observation* the agent reasons over.

## How it works

#### Move 1 — the mental model

You've wrapped a flaky dependency in a breaker so your service stops
hammering it after N failures and fails fast. The agent twist: the
breaker doesn't just fail fast — it *tells the agent* the tool is down,
so the agent's reasoning can route around it instead of looping on it.

```
  Pattern — per-tool breaker that feeds back to the agent

  agent calls tool X
       │
       ▼ breaker(X)
   closed → run    |   open → return "tool X unavailable"
       │                          │
       │                          ▼
       │              agent observes it, routes around
       │              (different tool / degrade / "I can't reach my notes")
       ▼
   N failures → OPEN
```

#### Move 2 — the walkthrough (buffr's gap and its existing bound)

**buffr would retry a dead tool every turn — up to the cap.** Look at
the loop: on each turn the model may emit a `search_knowledge_base` call,
and `runAgentLoop` runs it, catching errors into the result
(`run-agent-loop.js:75-86`):

```js
try {
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  ...
} catch (error) {
  isError = true;
  resultContent = truncate(JSON.stringify({ error: message }));
}
```

The error is fed back as a `tool_result` with `isError: true`. So buffr
*does* surface the failure to the model — but there's no breaker, so the
model can just try search again next turn, and again, up to
`maxToolCalls: 4`. The cap is buffr's only protection: it bounds the
damage at 4 failed calls, then forces synthesis. That's a budget bound,
not a route-around.

**Why the cap isn't enough at scale.** Four failed embed-and-search
attempts is four round-trips to a dead pgvector/Ollama before the loop
gives up — wasted latency and tokens producing nothing, the worst kind
of cost blowup. A breaker would fail the 2nd call instantly (circuit
open) and feed "search unavailable" to the model, so it answers from
what it has — or says "I can't reach your notes right now" — instead of
burning the budget retrying.

**The buffr-specific subtlety: one tool means routing around is
"degrade."** With multiple tools, "route around" means pick a different
tool. buffr has *one* tool — so routing around a dead
`search_knowledge_base` means degrading gracefully: answer from the
profile/prompt alone, or tell the user retrieval is down. The breaker's
value here is turning a 4-call budget burn into an instant, honest
degradation.

```
  Comparison — buffr today vs with a per-tool breaker

  buffr today:                      with breaker (would-be):
    search fails → retry next turn    search fails → breaker opens
    → fails again → ... up to 4        → 2nd call fails INSTANTLY
    → forced synth (4 wasted calls)    → agent degrades / honest "down"
```

#### Move 3 — the principle

A breaker scoped to a tool, *feeding its state back to the agent*, turns
the tool-call cascade from a budget-ending event into a routed-around
inconvenience. The shift from single-call breakers: it doesn't just
protect your service from a dead dependency, it gives the agent's
reasoning the information to stop looping on the dead path. buffr's
`maxToolCalls` cap *bounds* a dead-tool cascade; a breaker would *short-
circuit* it — instant degradation instead of four wasted round-trips.

## Primary diagram

```
  Per-tool circuit breaking (would-be in buffr)

  agent → search_knowledge_base
       │ breaker(search)
       ▼
   closed → run pipeline      |   open → "search unavailable" (instant)
       │ N fails                          │
       ▼ OPEN                             ▼
   (no more real calls)        agent: ONE tool, so DEGRADE
   half-open after cooldown    → answer from profile / "I can't reach notes"

  buffr today: no breaker → maxToolCalls:4 bounds it (4 wasted calls)
```

## Interview defense

**Q: What happens if buffr's search tool goes down mid-run?**
Today, buffr retries it every turn up to `maxToolCalls: 4`, then forces
synthesis — so a dead pgvector or embedder costs four wasted
embed-and-search round-trips before the loop gives up. The error *is*
surfaced to the model (`isError: true`), but nothing stops it retrying.
A per-tool circuit breaker would fail the 2nd call instantly and feed
"search unavailable" to the agent, so it degrades immediately —
answering from the profile or honestly saying retrieval is down.

```
  no breaker → 4 wasted retries | breaker → instant degrade + honest answer
```

**Anchor:** "A breaker turns a tool-call cascade from a budget-ending
event into a routed-around inconvenience — and with one tool, routing
around means degrading honestly."

## See also

- `03-multi-agent-orchestration/09-coordination-failure-modes.md` — the
  tool-call-cascade failure this controls
- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the budget cap that
  bounds (but doesn't short-circuit) the cascade
- `01-cross-turn-caching.md` · `02-fan-out-backpressure.md` — the sibling
  serving concerns
