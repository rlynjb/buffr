# SECTION E — Production serving for agents

Anchor: single-agent + multi-agent (both). Cross-references the
single-call mechanics (caching, backpressure, retry/breaker) to a future
`study-ai-engineering` production-serving section. This section covers
what those become once the unit is a loop or a topology.

**Mostly "Not yet implemented" for buffr's single-user local setup —
but each file anchors to a buffr primitive that's the seed of the
agent-scale version.**

## Reading order

1. `01-cross-turn-caching.md` — buffr's prompt is prefix-stable (the
   precondition); no intra-run/cross-run cache yet. *Not yet built; some
   layers N/A for local Ollama.*
2. `02-fan-out-backpressure.md` — buffr's trace-sink `Promise.all` is the
   *unbounded* fan-out shape that needs a cap. *Not yet applicable
   (serial), but the seed exists.*
3. `03-per-tool-circuit-breaking.md` — buffr's `maxToolCalls:4` *bounds*
   a dead-tool cascade but doesn't *short-circuit* it. *Not yet built.*

The thread: buffr's existing caps and `Promise.all` are the single-agent
seeds; these files name the agent-scale controls they'd grow into under
load.
