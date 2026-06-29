# Sequential Pipeline

*Industry names: **sequential pipeline** / **agent chain** / **pipeline orchestration** / **prompt chaining (agent-level)**. Type label: Industry standard. In this codebase: **Not yet implemented** as an agent pipeline. (buffr's *session* outer flow is pipeline-shaped, but those stages are functions, not agents.)*

## Zoom out, then zoom in

This is the simplest multi-agent topology: agents in a line, each feeding the next. Here is the
SHAPE first.

```
  THE TOPOLOGY — a straight line, output→input (★ = the whole chain)

  ┌──────────┐    ┌──────────┐    ┌──────────┐
  │ ★ AGENT 1 │──▶│ ★ AGENT 2 │──▶│ ★ AGENT 3 │──▶ answer
  │ extract   │   │ transform │   │ summarize │
  └──────────┘    └──────────┘    └──────────┘
   each output is the next's input · fixed order · no routing, no branches
   each box = its own runAgentLoop (Section A skeleton)
```

The topology is the mental model: **a straight line, no branches.** Unlike supervisor–worker,
nobody routes — the order is fixed at design time. The honest sentence: buffr runs no agent
pipeline. It *does* have a pipeline-shaped outer flow in `session.ts`, but those stages are
plain functions, which is a different thing — that distinction is the lesson of this file.

## Structure pass

One axis: **state** — what flows down the line, and what happens when a stage fails?

```
  Axis = STATE · what passes between stages, and the SEAM where failure stops the line

  stage 1 → output A ─▶ stage 2 sees ONLY output A (not the original input, unless passed)
  stage 2 → output B ─▶ stage 3 sees output B
  ──────────── ★ SEAM: a stage fails → the WHOLE line halts ★ ──────────
  stage N fails        → no answer; there is no fallback branch (it's a line, not a tree)
```

The defining property of a pipeline is *narrowing state*: each stage typically sees only the
previous stage's output, not the full history (unless you explicitly thread the original input
through). That's the strength — each agent has a clean, small context — and the weakness — a
stage can't recover information an earlier stage dropped. And because it's a *line*, a single
stage failure halts everything; there's no sibling to fall back to. That seam is why pipelines
want a validation step between stages (see `09`'s synthesis failure).

## How it works

### Move 1 — mental model

A `.then()` chain where each link is a whole agent. Bridge from frontend: it's exactly
`fetchUser().then(enrich).then(format)` — a promise chain of single-purpose functions — except
each `.then()` is a model loop, not a pure function, so each link can be slow, expensive, and
*wrong* in a way a pure function can't.

```
  THE SHAPE — a .then() chain of agents

   input
     │ .then(agent1)   ── agent1's loop runs, returns output A
     ▼
   output A
     │ .then(agent2)   ── agent2's loop runs on A, returns output B
     ▼
   output B
     │ .then(agent3)
     ▼
   answer
```

### Each link is a full agent loop, not a function

The thing that makes this *multi-agent* (not just function composition) is that each stage is
its own `runAgentLoop` with its own prompt, tools, and budget. Stage 2 can search, reason, and
fail independently of stage 1.

```
  Each link = a Section-A loop, chained

  ┌─ AGENT 1 (own loop) ─┐ out  ┌─ AGENT 2 (own loop) ─┐ out  ┌─ AGENT 3 ─┐
  │ runAgentLoop(...)     │─────▶│ runAgentLoop(out1)    │─────▶│ ...        │
  │ prompt+tools+budget A │      │ prompt+tools+budget B │      │            │
  └───────────────────────┘      └───────────────────────┘      └────────────┘
```

```
pseudocode — agent pipeline (each .then is a loop, not a pure fn)
out1 = await runAgentLoop(agent1, input)      # full loop: model + tools + budget
out2 = await runAgentLoop(agent2, out1)       # sees out1, not the raw input
out3 = await runAgentLoop(agent3, out2)
return out3
```

Annotation: the cost adds linearly — three agents is roughly 3x the model calls and 3x the
latency of one, in *series* (no parallelism, unlike fan-out in `04`). That's the price of the
clean, narrow context each stage gets.

### What buffr has instead — a FUNCTION pipeline, not an agent pipeline

buffr's `session.ts` `ask()` is pipeline-shaped: persist → answer → remember. But only the
middle stage is an agent; the bookends are plain async functions.

```ts
// session.ts:60-71 — ask() is pipeline-shaped, but only the middle stage is an agent
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);  // STAGE 1: a function
  const answer = await agent.answer(question);                   // STAGE 2: the ONE agent
  await trace.flush();
  try { await memory.remember({ conversationId, question, answer }); }  // STAGE 3: a function
  catch { /* best-effort */ }
  return answer;
}
```

```
  buffr's session flow vs. an agent pipeline

  persist ──▶ answer ──▶ remember        (buffr today: session.ts:60-71)
  (fn)        (AGENT)    (fn)
   └─ only ONE box is an agent ─┘ → this is FUNCTION composition, not multi-agent

  vs.

  extract ──▶ analyze ──▶ summarize      (an agent pipeline: NOT YET)
  (AGENT)     (AGENT)     (AGENT)
   └─ every box is its own loop ─┘
```

Annotation: this distinction matters in an interview. buffr's outer flow *looks* like a
pipeline, and you should name it as pipeline-shaped — but it's a function chain with one agent
in the middle, not a multi-agent pipeline. Calling it "multi-agent" would be wrong. The
multi-agent version (every stage a loop) is not yet built, because buffr's single answer-stage
hasn't hit a ceiling that would justify splitting it into staged specialists.

### Move 3 — the principle

**A pipeline trades flexibility for clarity: fixed order, narrow per-stage context, linear
cost — and one stage's failure halts the line.** Reach for it when a task has *genuinely
sequential* sub-steps where each stage's output is a clean input to the next (extract → then
analyze the extraction → then summarize the analysis). Don't reach for it when stages need to
see each other's *mid-results* — that's not a line, that's shared state (`08`). And put a
validation step between stages, or a bad stage-1 output silently poisons the whole line.

## Primary diagram

Full recap: the topology, the function-vs-agent distinction, the verdict.

```
  Sequential pipeline — the line, and buffr's function-shaped echo of it

  AGENT PIPELINE (not yet):   extract ─▶ analyze ─▶ summarize   each a loop
                                (AGENT)   (AGENT)    (AGENT)
                              · fixed order · narrow context · linear cost
                              · one stage fails → whole line halts (seam)

  buffr's session (today):    persist ─▶ answer  ─▶ remember     session.ts:60-71
                                (fn)     (AGENT)    (fn)
                              · pipeline-SHAPED, but only the middle is an agent

  refactor template: SECTION F · agentic-coding template
```

Verdict in one line: **the simplest topology; buffr's session flow is pipeline-shaped but those
are functions, not agents — the multi-agent pipeline is not yet built and isn't yet
justified.**

## Elaborate

Sequential pipelines are LangChain's original `SequentialChain` and the agent-level version of
"prompt chaining" (Anthropic's "Building Effective Agents" lists it as the first composable
pattern). The production lesson is the validation gate: because each stage narrows context, an
early stage that drops or distorts information dooms the rest of the line with no recovery — so
mature pipelines insert a schema-validation or critic step between agents (which is also where
pipelines start borrowing from `05`'s critic pattern). The other lesson is latency: pipeline
stages run in *series*, so a three-agent pipeline is three sequential round-trips — if the
stages are actually independent, you want `04`'s fan-out instead, not a pipeline.

To adopt an agent pipeline for buffr, see SECTION F's agentic-coding template — it shows
splitting one agent's work into ordered stages, each a `runAgentLoop`, with a validation step
between them.

## Interview defense

**Q: "Is buffr's flow a multi-agent pipeline?"**

Model answer: "No — and the distinction is the point. buffr's `session.ts` `ask()` is
*pipeline-shaped* — persist, then answer, then remember (`session.ts:60-71`) — but only the
middle stage is an agent; the bookends are plain async functions. That's function composition,
not multi-agent orchestration. A true agent pipeline makes *every* stage its own
`runAgentLoop` — extract, then analyze, then summarize — chained `.then()`-style, with narrow
per-stage context and a validation gate between stages so an early bad output doesn't poison
the line. buffr's single answer-stage hasn't hit a ceiling, so there's nothing to split into
staged specialists. Not yet."

```
  The defense in one picture

  function chain (buffr):  persist ─▶ [AGENT] ─▶ remember   one agent, two functions
  agent pipeline (not yet): [AGENT] ─▶ [AGENT] ─▶ [AGENT]    every stage a loop + gate
```

Anchor: *A pipeline is a `.then()` chain where every link is a full agent loop — buffr's
session flow is pipeline-shaped but function-based, with only one agent in the middle.*

## See also

- `02-supervisor-worker.md` — add routing and you get a supervisor; a pipeline is the
  no-routing case.
- `04-parallel-fan-out.md` — when the stages are *independent*, run them in parallel instead of
  in a line.
- `05-debate-verifier-critic.md` — the critic that belongs *between* pipeline stages.
- `08-shared-state-and-message-passing.md` — when stages need each other's mid-results, you've
  outgrown a pipeline.
- `../01-reasoning-patterns/01-chains-vs-agents.md` — the chain-vs-agent boundary this file
  leans on (`session.ts` is the chain half).
- `../06-orchestration-system-design-templates/` (SECTION F) — the agent-pipeline refactor.
