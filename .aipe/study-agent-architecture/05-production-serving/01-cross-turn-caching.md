# Cross-turn caching — caching across a loop, not just one call

**Industry name(s):** cross-turn caching · prompt-prefix caching ·
intra-run memoization · semantic cache. **Type label:** Industry
standard.

**In this codebase: Not yet implemented — and partly N/A for a local
model.** buffr does no caching across turns or runs. Two of the three
layers below are less relevant to a local Ollama (no provider-side prefix
cache to lean on), but the prompt *is* prefix-stable (profile + template
fixed), which is the precondition the cloud version needs.

## Zoom out, then zoom in

```
  Zoom out — single-call cache vs the agent versions

  Single-call cache (one request):     Cross-turn cache (a loop):
    request → hash → hit? return : call   within a run: same sub-step → hit
                                          across runs: similar sub-step → hit
                                          provider-side: stable prefix cached
```

Zoom in: single-call caching keys on one request. An agent runs many
turns per task, and many tasks repeat sub-steps — so there are three
cache scopes a loop opens that a single call doesn't. buffr opens none of
them yet, which is fine for a single-user local tool but is the first
thing to add under load.

## Structure pass

**Layers.** Three cache scopes: provider-prefix, intra-run, cross-run
semantic — cheapest to most useful.

**Axis — "what's re-derived, and at what scope?"** A stable system
prompt re-sent every turn (prefix). A sub-result re-derived within one
task (intra-run). A similar sub-result across tasks (cross-run). buffr
re-derives all three.

**Seam.** The `model.complete` / `tools.callTool` boundaries — the
points where a cache would intercept. buffr's prompt assembly puts the
stable part first (profile + template), which is exactly the seam a
prefix cache keys on.

## How it works

#### Move 1 — the mental model

You keep the stable part of a request stable so an HTTP cache or
`fetch` keep-alive can reuse it. Cross-turn caching is that instinct at
three scopes inside an agent: reuse the stable prompt prefix, reuse a
sub-result within a task, reuse a similar sub-result across tasks.

```
  Pattern — three cache scopes inside an agent

  ┌─ Agent run (task A) ─────────────────────────┐
  │  turn 1: retrieve "X"  ──┐                    │
  │  turn 2: reason          │ intra-run hit      │
  │  turn 3: retrieve "X" ◄──┘ (same sub-step)    │
  └───────────────────────────────────────────────┘
  ┌─ Agent run (task B, later) ──────────────────┐
  │  turn 1: retrieve "X" ◄── cross-run semantic  │
  │          (similar to A's)  hit                │
  └───────────────────────────────────────────────┘
  + provider-prefix: stable system prompt cached every turn
```

#### Move 2 — the walkthrough (what buffr has and lacks)

**Prefix scope: buffr's prompt is prefix-stable, but Ollama doesn't
bill it.** The system prompt assembles the profile and base template
first (`rag-query-agent.js:28-32`) — stable across every turn of a run.
On a cloud provider with prompt-prefix caching, putting the stable part
first is exactly what lets the provider cache the prefix and charge less
per turn. buffr runs Gemma locally via Ollama, so there's no provider
bill to cut — the prefix-stability is correct prompt hygiene but buys no
cost win here. It *would* matter if buffr moved to a cloud model.

**Intra-run scope: buffr re-derives within a run.** Within one task,
buffr's loop can call `search_knowledge_base` more than once
(`maxToolCalls: 4`). If the model emits the same query twice, buffr
re-runs the full embed-and-search both times — there's no memoization on
`(tool name + args)`. A small intra-run cache (a `Map` keyed on the tool
call) would skip the duplicate. The cost saved is one embedding call plus
one vector search per duplicate — modest at single-user scale, real under
load.

**Cross-run scope: no semantic cache.** A later question semantically
close to an earlier one re-runs retrieval from scratch. A cross-run
semantic cache would embed the sub-query and return a cached result if
close enough. buffr doesn't do this — and here the sharper-for-agents
tradeoff bites: a stale cross-run hit poisons the *whole trajectory*,
not one response. The agent reasons forward on a stale sub-result and
every downstream turn inherits the error. So the gate is freshness:
don't cache retrieval whose underlying data can change mid-task (buffr's
notes change as you write), and never cache a side-effecting tool call
(buffr's tool is read-only, so that half is free).

```
  Comparison — buffr today vs the cache scopes

  ┌──────────────────┬──────────────┬──────────────────────────┐
  │ scope            │ buffr status │ note                     │
  ├──────────────────┼──────────────┼──────────────────────────┤
  │ provider-prefix  │ N/A (local)  │ prompt IS prefix-stable  │
  │ intra-run memoize│ none ✗       │ re-runs duplicate searches│
  │ cross-run semantic│ none ✗      │ freshness risk if added  │
  └──────────────────┴──────────────┴──────────────────────────┘
```

#### Move 3 — the principle

A loop opens cache scopes a single call doesn't have: a stable prefix
re-sent every turn, a sub-result re-derived within a task, a similar one
across tasks. The agent-specific hazard is that a stale cache hit
poisons the whole trajectory, not one response — so gate every cache on
freshness and never cache a side-effecting call. buffr's prompt hygiene
(stable prefix first) is the precondition for the cloud version; its
single-user local setup means the caches aren't worth their complexity
yet.

## Primary diagram

```
  Cross-turn caching (would-be in buffr; buffr's state marked)

  PREFIX:   profile+template first → cacheable prefix  (N/A: local Ollama)
  INTRA-RUN: Map[(tool,args)] within a run             (✗ not built)
  CROSS-RUN: embed sub-query → semantic cache          (✗ + freshness risk)
            gate: don't cache changeable data; never cache side effects
```

## Elaborate

Cross-turn caching is the agent-scale version of single-call caching
(which would be in a future `study-ai-engineering` production-serving
file). The reason it's a separate concern: the unit of execution is a
multi-turn loop, so the same sub-step recurs within and across runs, and
a cache error compounds across the trajectory instead of staying local.
For buffr, the highest-value first cache is intra-run memoization on the
search tool — cheap to add, no freshness risk if scoped to one run.

## Interview defense

**Q: How would you cache buffr under load?**
Three scopes. Intra-run memoization first — a `Map` keyed on `(tool,
args)` so a duplicate search within one run skips re-embedding. Then, if
buffr moved to a cloud model, lean on prompt-prefix caching — buffr's
prompt is already prefix-stable (profile + template first), which is the
precondition. Cross-run semantic cache last and most carefully, gated on
freshness, because a stale hit poisons the whole trajectory, not one
answer. The read-only tool means I never have to worry about caching a
side effect.

```
  intra-run memoize → prefix cache → cross-run semantic (freshness-gated)
```

**Anchor:** "A stale cache hit poisons the whole trajectory, not one
response — gate every agent cache on freshness."

## See also

- `02-fan-out-backpressure.md` · `03-per-tool-circuit-breaking.md` — the
  other agent-scale serving concerns
- `04-agent-infrastructure/02-agent-memory-tiers.md` — the
  retrieval-memory store a cache would sit in front of
- `02-agentic-retrieval/01-agentic-rag.md` — the retrieval loop that
  repeats sub-steps
