# Sequential pipeline — each agent's output feeds the next

**Industry name(s):** sequential pipeline · agent chain · stage
pipeline. **Type label:** Industry standard.

**In this codebase: Not yet implemented at the agent layer.** buffr has
no chain of agents. It *does* have a fixed chain at the session layer
(persist → answer → remember, `src/session.ts:60-70`) — but those are
function calls, not agents. An agent pipeline would be each stage an
autonomous loop.

## Zoom out, then zoom in — lead with the shape

```
  Sequential pipeline topology (lead with it)

  ┌─────────┐  draft   ┌─────────┐ reviewed ┌─────────┐
  │ Agent A │ ───────► │ Agent B │ ───────► │ Agent C │
  │ (write) │          │ (edit)  │          │ (format)│
  └─────────┘          └─────────┘          └─────────┘
   latency = sum of all stages (no parallelism)
```

Zoom in: this is a `.then()` chain where each step is an agent instead
of a function. Output of one feeds the next. Same benefit as a
single-purpose function chain — isolated failures, you know which stage
broke — and same cost: latency is the sum of every stage.

## Structure pass

**Layers.** N stages in series. Each stage is the agent-loop skeleton.

**Axis — "where does latency come from?"** The sum of the stages — a
pipeline is inherently serial, so total latency is additive. That's the
defining cost.

**Seam.** Each stage boundary is a seam where the contract is the
output schema one agent passes to the next. A bug there (stage B
misreads stage A's output) is the pipeline's characteristic failure.

## How it works

#### Move 1 — the mental model

You've built `parse().then(validate).then(save)` — each function
transforms the data and hands it on. An agent pipeline is that, where
each `.then` is a full ReAct loop with its own specialty.

```
  Pattern — agents in series

  input → [Agent A] → A's output → [Agent B] → B's output → [Agent C] → result
           each stage is its own loop; runs strictly in order
```

#### Move 2 — the walkthrough (what it would take in buffr)

**buffr's session chain is the function version, not the agent
version.** Look at `src/session.ts:60-70`: persist, answer, remember.
That's a real pipeline shape — but the stages are functions, and only
the middle one (`agent.answer`) is an agent. An *agent* pipeline would
make each stage autonomous: e.g. a retrieval agent → a synthesis agent
→ a citation-checking agent, each a `RagQueryAgent`-style loop, each
consuming the prior stage's output.

**Why you'd pick it: isolated, debuggable stages.** A pipeline lets you
run a cheaper model on early stages (retrieval doesn't need the strong
model) and reserve the expensive one for synthesis — and when output is
wrong, you know which stage produced it. buffr's trajectory capture
(`src/supabase-trace-sink.ts`) already gives per-step visibility; a
pipeline would extend that to per-stage.

**The cost: additive latency.** Three agent stages in series is three
sequential model calls' worth of wall-clock. On local Gemma that's
slow. A pipeline is only worth it when the stages are genuinely
sequential (each needs the prior's output) — if they're independent,
it should be a fan-out instead (`04-parallel-fan-out.md`).

```
  Comparison — function chain (buffr) vs agent pipeline

  buffr session (functions):       agent pipeline (would-be):
    persist → answer → remember      retrieve-agent → synth-agent → cite-agent
    (1 agent in the middle)          (3 agents, latency = sum)
```

#### Move 3 — the principle

A pipeline buys isolated, individually-debuggable stages and the
ability to run cheap models early, at the cost of additive latency.
Reach for it only when the stages are genuinely sequential. buffr's
sequential work is function-shaped, not agent-shaped — which is why its
chain is a chain, not a pipeline of agents.

## Primary diagram

```
  Sequential pipeline (would-be agent version in buffr)

  question → [retrieve-agent] → chunks
                                  → [synth-agent] → draft
                                                     → [cite-agent] → answer
  total latency = retrieve + synth + cite  (strictly serial)
```

## Elaborate

The sequential pipeline is supervisor-worker with the workers laid out
in series and no central supervisor merging — the handoff *is* the
data flow. When stages can run independently, the parallel fan-out
(`04-parallel-fan-out.md`) trades the serial latency for a merge step.
When you want explicit, checkpointed control over the stages, graph
orchestration (`07-graph-orchestration.md`) expresses the same pipeline
as a state machine you can pause and resume.

## Interview defense

**Q: Does buffr use an agent pipeline?**
No — it has a *function* pipeline at the session layer (persist →
answer → remember), but only the middle stage is an agent. An agent
pipeline would make each stage an autonomous loop. I'd reach for it only
if buffr's work were genuinely sequential across specialties; today it's
one retrieval-and-answer step, so a pipeline would just add additive
latency.

```
  function chain (buffr) ≠ agent pipeline (each stage a loop)
```

**Anchor:** "A pipeline is a `.then()` chain of agents — worth it only
when the stages are genuinely sequential."

## See also

- `02-supervisor-worker.md` — pipeline is its serial form
- `04-parallel-fan-out.md` — the parallel alternative for independent
  stages
- `.aipe/study-system-design/04-long-lived-chat-session.md` — buffr's
  function-level session chain
