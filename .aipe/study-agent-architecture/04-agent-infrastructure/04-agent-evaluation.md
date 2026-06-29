# Agent evaluation — the trajectory is the unit, not the output

**Industry name(s):** agent evaluation · trajectory eval · tool-call
accuracy · retrieval eval (precision@k). **Type label:** Industry
standard.

**In this codebase: partially — retrieval is evaluated; the trajectory
is captured but not yet scored.** buffr has a precision@k eval CLI over
a labeled query set (`src/cli/eval-cmd.ts`, `eval/queries.json`) and a
full-signal trajectory captured into `agents.messages`
(`src/supabase-trace-sink.ts`). So it evaluates the *retrieval quality*
and *records* the trajectory — but doesn't yet score the trajectory
(tool-call accuracy, recovery rate).

## Zoom out, then zoom in

```
  Zoom out — what expands when you eval an agent vs one call

  LLM eval (one call):       Agent eval (a trajectory):
  ┌──────────────┐           ┌──────────────────────────┐
  │ input        │           │ was the right tool called?│
  │ → output     │           │ in the right order?       │ ← we are here
  │ → score      │           │ did it recover from errors│
  └──────────────┘           │ how many steps / $ / ms?  │
                             │ was the final output good?│
                             └──────────────────────────┘
```

Zoom in: evaluating an agent is harder than evaluating one LLM call,
because the unit is the *trajectory* — the whole path of tool calls and
observations — not just the final answer. buffr evaluates the retrieval
step well; the trajectory it captures fully but scores partially.

## Structure pass

**Layers.** Two eval surfaces: the retrieval step (precision@k, scored)
and the full trajectory (captured, not scored).

**Axis — "what's measured?"** Retrieval relevance (buffr: yes,
precision@k). Tool-call accuracy, trajectory efficiency, recovery rate
(buffr: captured but not scored). Final-answer quality (buffr: no
automated judge wired in, though the bundle has one).

**Seam.** The boundary between the captured trajectory
(`agents.messages`) and an evaluator that reads it. buffr has the data;
the evaluator that turns it into trajectory metrics is the gap.

## How it works

#### Move 1 — the mental model

You don't test a multi-step checkout by only asserting the final "order
placed" — you assert each step fired in order, retries worked, totals
were right. Agent eval is that: assert the *path*, not just the
endpoint.

```
  Pattern — the two eval surfaces in buffr

  RETRIEVAL EVAL (scored):          TRAJECTORY EVAL (captured, not scored):
    labeled queries → search          every step → agents.messages
    → precision@k                     (tool args, results, durationMs,
    eval/queries.json                  tokens, warnings, errors)
    src/cli/eval-cmd.ts               src/supabase-trace-sink.ts
```

#### Move 2 — the walkthrough

**Retrieval is evaluated with precision@k.** buffr ships a labeled eval
set (`eval/queries.json`) and a CLI that scores how many of the top-k
retrieved chunks are relevant (`src/cli/eval-cmd.ts`, using aptkit's
`@aptkit/evals` precision-at-k). That's the right eval for the
load-bearing step: buffr's answers are only as good as its retrieval, so
measuring retrieval directly catches the most common failure cause
before it reaches the model.

**The trajectory is captured in full — six event types.** The
`SupabaseTraceSink` persists every `CapabilityEvent`: step,
tool_call_start (with args — the *cause*), tool_call_end (result, error,
durationMs), model_usage (tokens), warning, error
(`src/supabase-trace-sink.ts:53-84`). The doc comment is explicit that
this turns `agents.messages` into "a complete, replayable trajectory."
So the *data* for trajectory eval exists: you could read a conversation
and ask "did it call the search tool? how many times? did it recover
from a tool error? how many tokens?"

**What's not yet scored.** buffr captures the trajectory but doesn't run
trajectory *metrics* on it — no automated check for tool-call accuracy
(did it call the right tool in the right order), trajectory efficiency
(steps/cost to completion), or recovery rate (did it handle a failed
tool call). The bundle even has a `rubric-judge`
(`@aptkit/evals`) that could grade final-answer quality, unused by the
chat path. The replay-ordering work — persisting the event `timestamp`
into `created_at` so replay matches emit order
(`src/supabase-trace-sink.ts:26-30, 59`) — is groundwork *for*
trajectory eval that hasn't been built on yet.

**The evaluator paradox, and buffr's controls.** Using an LLM to grade
an LLM's trajectory is real and biased. buffr sidesteps it for retrieval
by using a *labeled* set (precision@k needs no judge — relevance is
ground-truthed in `eval/queries.json`). For trajectory and answer
quality, the controls would be frozen golden trajectories, the iteration
caps buffr already has, and human spot-checks.

```
  Comparison — buffr's eval coverage

  ┌──────────────────────┬──────────────┬──────────────────────┐
  │ eval surface         │ buffr status │ where                │
  ├──────────────────────┼──────────────┼──────────────────────┤
  │ retrieval precision@k│ scored ✓     │ eval/queries.json    │
  │ trajectory captured  │ captured ✓   │ supabase-trace-sink  │
  │ tool-call accuracy   │ not scored ✗ │ (data exists)        │
  │ recovery rate        │ not scored ✗ │ (errors captured)    │
  │ answer quality (judge│ unused ✗     │ bundle has rubric-judge│
  └──────────────────────┴──────────────┴──────────────────────┘
```

#### Move 3 — the principle

The unit of agent evaluation is the trajectory, not the output. buffr
does the highest-leverage half — it scores the retrieval step that
determines answer quality, with a labeled set that needs no judge — and
captures the full trajectory as replayable data. The remaining work
(scoring tool-call accuracy, recovery, efficiency from the captured
trajectory) is built on data buffr already has. Capturing the trajectory
is the prerequisite; scoring it is the next step.

## Primary diagram

```
  buffr's agent evaluation surfaces

  SCORED:    labeled queries → search_knowledge_base → precision@k
             (eval/queries.json + src/cli/eval-cmd.ts)

  CAPTURED:  every run → agents.messages (6 event types, replay-ordered)
             ↓ (the data for trajectory eval — not yet scored)
  NOT YET:   tool-call accuracy · recovery rate · efficiency · answer judge
```

## Elaborate

Agent eval extends LLM eval (output quality) with trajectory and
tool-call metrics — the path matters, not just the destination. The
output-quality methods and LLM-as-judge bias would be covered in a
future `study-ai-engineering` evals file; this file covers what's
*additional* for agents. buffr's strong move is grounding retrieval eval
in a labeled set (no judge bias) and capturing a replayable trajectory.
The replay-ordering detail (`created_at` from the event timestamp) is
precisely the kind of groundwork that makes deterministic trajectory
replay — and thus golden-trajectory eval — possible.

## Interview defense

**Q: How is buffr's agent evaluated?**
At two surfaces. Retrieval is scored with precision@k over a labeled
query set (`eval/queries.json`) — the right place to measure, since
answer quality follows retrieval quality, and a labeled set means no
judge bias. The full trajectory is captured into `agents.messages` — all
six event types, replay-ordered — so the data for trajectory eval
exists. What's not yet scored: tool-call accuracy, recovery rate, and
answer-quality judging (the bundle's `rubric-judge` is unused by chat).

```
  retrieval: precision@k (scored) | trajectory: captured, not yet scored
```

**Anchor:** "The unit is the trajectory — buffr scores the retrieval
step and captures the full path; scoring the path is the next step."

## See also

- `02-agentic-retrieval/01-agentic-rag.md` — the retrieval being
  evaluated
- `03-multi-agent-orchestration/05-debate-verifier-critic.md` — the
  unused rubric-judge
- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the budget caps
  that bound trajectory cost
- `.aipe/study-system-design/03-trajectory-capture.md` — the capture
  mechanism from the system-design angle
- `.aipe/study-testing/` — the broader correctness/eval seam
