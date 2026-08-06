# 08 — Human-in-the-Loop Pipeline Checkpoint

**Subtitle:** Industry names: **human-in-the-loop checkpoint** / **interrupt-and-resume pipeline** (LangGraph calls its version `interrupt()`). Type label: Industry standard (pausing a pipeline for a human input is a recognized pattern) + Project-specific (buffr's specific `collect()`/`evaluate()` split and the safe-digest boundary). IMPLEMENTED in buffr (`MarketResearchEngine`).

## Zoom out, then zoom in

```
  Zoom out — where the checkpoint sits

  ┌─ UI layer (src/cli/chat.tsx) ────────────────────────────────────┐
  │  /research <topic>  →  createResearchFlow(session, topic, cbs)   │
  └───────────────────────────┬────────────────────────────────────-─┘
                              │  controller.start() / controller.submit(input)
  ┌─ Flow layer (src/cli/research-flow.ts) ───────────────────────────┐
  │  step machine: 'prediction' → 'promote' → 'stake' → ...          │
  └───────────────────────────┬────────────────────────────────────-─┘
                              │  session.researchCollect() / researchEvaluate()
  ┌─ Engine layer (packages/engines/market-research/src/engine.ts) ──┐
  │  collect()  ────► ★ THE CHECKPOINT ★  ────►  evaluate()          │ ← we are here
  └───────────────────────────┬────────────────────────────────────-─┘
                              │  Collector / Analyzer / Scorer / Teacher
  ┌─ Capability layer (packages/capabilities/src/) ───────────────────┐
  │  same four capabilities InvestingEngine uses (see 07)            │
  └────────────────────────────────────────────────────────────────-─┘
```

You already know this shape from `07-typed-engine-with-capability-pipeline.md` — a fixed-order
capability pipeline where code, not a model, decides what runs next. `MarketResearchEngine` reuses
the *exact same* `Collector`/`Analyzer`/`Scorer`/`Teacher` capabilities `InvestingEngine` uses. The
only thing that changed is the joint: instead of one `run()` that goes straight through, this
pipeline is cut into two separately callable halves — `collect()` and `evaluate()` — with a human
required to supply input in between. This file is that one new joint, not a new pipeline.

## Structure pass

**New files this pattern spans**, on top of what 07 already named:

- `packages/engines/market-research/src/engine.ts` — `collect()` (:56-117) and `evaluate()`
  (:125-237), where 07's `run()` used to be one method
- `packages/engines/market-research/src/types.ts` — `CollectedResearch` (:55-62), the state that
  survives the pause; `ResearchPrediction` (:66-70), what the human supplies
- `src/session.ts` — `researchCollect()` (:713-726) and `researchEvaluate()` (:727-744), the
  session-level split that mirrors the engine's
- `src/cli/research-flow.ts` — the state machine that actually holds the pause open across two
  separate user turns in the TUI

Axis: **control — who decides what runs next, traced across the same layers 07 already walked.**

```
  Axis = control · trace it across the pipeline, find where it flips

  chat.tsx dispatch     → CODE decides (does the input start with "/research "?)
  collect()             → CODE decides (Collector runs, no LLM, no branching)
  ───────────── ★ SEAM: control passes to a person ★ ─────────────
  the pause             → HUMAN decides (submits a prediction, or doesn't yet)
  ───────────── ★ SEAM: control returns to code ★ ─────────────
  evaluate()            → CODE decides (Analyzer → Scorer → Teacher, fixed order)
```

Contrast with `InvestingEngine.run()`: that pipeline has **no** seam where control leaves code at
all — it's `Collector → Analyzer → Scorer → Teacher` end to end, one `await` chain, one caller, one
return. `MarketResearchEngine` has exactly one seam, and it's a person. That's the entire structural
difference between 07 and this file — same kernel, one joint added in the middle.

## How it works

### Move 1 — the mental model

You've built this shape before, just with a different kind of pause: a multi-step checkout form
that calls an API to fetch a shipping quote in step 1, holds that quote in component state while the
user picks a delivery date, then submits everything together in step 3. The API call doesn't run
twice, and the state from step 1 doesn't get lost — it just sits in memory until the user finishes
step 2. Here, `collect()` is the shipping-quote fetch, the human's prediction is the delivery-date
pick, and `evaluate()` is the final submit that needs both.

```
  THE SHAPE — one pipeline, cut into two resumable halves at the human joint

  ┌─ Phase 1: collect() ────────────────────────┐
  │  Collector.execute() → Evidence[] + digest   │   code decides, zero LLM calls
  └──────────────────────┬───────────────────────┘
                         │  safe digest: counts + titles ONLY —
                         │  no findings, no scores, no synthesis
                         ▼
                  ┌─────────────┐
                  │    HUMAN     │  ← predicts expectedScore, expectedDimension,
                  │  prediction  │    confidence — BEFORE seeing buffr's own read
                  └──────┬───────┘
                         │  ResearchPrediction folded into the next call
                         ▼
  ┌─ Phase 2: evaluate() ───────────────────────┐
  │  Analyzer → Scorer → Teacher → comparison()  │   code decides, 2 LLM calls
  └───────────────────────────────────────────────┘
```

### Move 2 — the load-bearing skeleton

**Isolate the kernel.** `predict-then-reveal` needs exactly four parts: a *safe digest* (what the
human sees before predicting), a *pause* (where the process waits for their answer), a *carried
state* (what survives the pause without being re-fetched), and a *code-computed comparison* (what
turns the human's guess and the model's answer into a gap, without asking a model to grade it).
Drop any one and the checkpoint stops meaning anything.

**Name each part by what breaks when it's missing:**

- **The safe digest** (`types.ts:55-62`, `EvidenceDigest`) — `CollectedResearch` carries only
  `totalCount`, `source`, and `titles` per source, explicitly *not* findings, scores, or synthesized
  text. Drop this boundary and reveal it all findings/scores up front instead, and the human's
  "prediction" stops being a prediction — it becomes a guess made after reading the answer, which
  makes every downstream comparison in `09-predict-then-reveal-calibration-loop.md` meaningless.
  This is the single most load-bearing line in the whole pattern.

- **The pause itself** — `research-flow.ts`'s `submit()` (:92-108) doesn't call `evaluate()` until
  a `ResearchPrediction` parses successfully from user input. Drop the pause (call `evaluate()`
  immediately after `collect()`, the way `InvestingEngine.run()` does) and you're back to 07's
  plain pipeline — correct, but with no human judgment captured to compare against.

- **The carried state** — `collect()` returns `CollectedResearch` (`engine.ts:102-117`), which
  `research-flow.ts` holds in a closure variable (`collected`, `:75`) across the entire pause. Drop
  this and the flow would have to re-run `Collector.execute()` after the human answers — doubling
  the concurrent-connector fetch (`Promise.all` over sources, `engine.ts:76-98`) and burning API
  quota twice for a fetch that already succeeded.

- **The code-computed comparison** — `evaluate()` builds `PredictionComparison` in TypeScript
  (`engine.ts:202-208`), not by asking the model: `scoreGap: scorerResult.data.totalScore -
  prediction.expectedScore`, `dimensionMatched: strongestFinding?.dimensionId ===
  prediction.expectedDimension`. Drop this and you'd have to prompt a model with "here's what the
  user guessed, here's what you scored, tell me the gap" — reintroducing the self-grading bias
  `study-ai-engineering`'s LLM-as-judge file already names as a known failure mode. Simple
  arithmetic doesn't need a model.

**Optional hardening, not skeleton:** the empty-evidence short-circuit before ever asking for a
prediction (`research-flow.ts:85-88` — `digest.totalCount === 0` returns immediately, no
`PREDICTION_PROMPT` shown) is a good guard, but it's not what makes this pattern *this* pattern —
it just avoids wasting the human's input on a query that already failed.

### The code, side by side

```ts
// packages/engines/market-research/src/engine.ts:56-58, 117 — Phase 1: collect().
async collect(input: MarketResearchCollectInput, context: AgentContext):
    Promise<AgentResult<CollectedResearch>> {
  // ...runs Collector.execute() per source, concurrently, builds a title-only digest...
  return { data: { topic, conversationId, evidence, failed, digest, warnings }, ... };
}
```

```ts
// src/cli/research-flow.ts:82-90 — start(): show ONLY the digest, then prompt for a prediction.
async start(): Promise<ResearchFlowResult> {
  const { collected: c } = await session.researchCollect(topic, { onStatus, onProgress });
  collected = c;                                          // ← carried across the pause
  if (collected.digest.totalCount === 0) { ... }           // short-circuit, no prediction asked
  return { messages: [formatDigest(topic, collected), PREDICTION_PROMPT], step };
  // formatDigest() prints titles only (:25-35) — the safe-digest boundary, enforced client-side too
}
```

```ts
// src/cli/research-flow.ts:95-107 — submit(): the pause resolves here, evaluate() runs after.
if (step === 'prediction') {
  const parsed = parsePrediction(input);                   // human's typed answer, parsed
  if (!parsed) return { messages: ['Could not parse that...'], step };
  prediction = parsed;
  const { output: o } = await session.researchEvaluate(collected, prediction, callbacks);
  // ^ THIS is the resume — evaluate() only runs once a valid prediction exists
  output = o;
  step = 'promote';
  return { messages: [formatReveal(output), PROMOTE_PROMPT], step };
}
```

```ts
// packages/engines/market-research/src/engine.ts:202-208 — the comparison, computed in code.
const comparison: PredictionComparison = {
  prediction,
  actualScore: scorerResult.data.totalScore,
  actualDimension: strongestFinding?.dimensionId ?? 'unknown',
  scoreGap: scorerResult.data.totalScore - prediction.expectedScore,   // ← arithmetic, not a model
  dimensionMatched: strongestFinding !== null
    && strongestFinding.dimensionId === prediction.expectedDimension,
};
```

Notice `evaluate()`'s signature (`engine.ts:125-130`) takes `prediction: ResearchPrediction` as a
required argument, not an optional one — the type system itself enforces that `evaluate()` cannot
run without a human's prediction already in hand. That's the checkpoint expressed as a function
signature, not just a runtime check.

```
  Layers-and-hops — where the pause actually lives across process boundaries

  ┌─ TUI (chat.tsx) ──────┐  hop 1: /research <topic>   ┌─ Flow (research-flow.ts) ─┐
  │  setActiveFlow({...}) │ ──────────────────────────► │  createResearchFlow()     │
  │  holds `controller`   │ ◄────────────────────────── │  .start() → digest shown  │
  │  across TWO turns     │  hop 4: reveal + promote     └──────────┬─────────────-─┘
  └────────────────────────┘  prompt                                │ hop 2: researchCollect()
           ▲                                                        ▼
           │ hop 3: user types prediction                 ┌─ Engine (engine.ts) ──────┐
           └──────────────── next chat.tsx submit ──────► │  .collect() → digest       │
                                                            │  .evaluate(pred) → output │
                                                            └────────────────────────-──┘
```

The pause is held in the TUI's own React state (`activeFlow`, `chat.tsx`), not inside the engine or
the flow object. Neither `MarketResearchEngine` nor `research-flow.ts`'s `controller` is "waiting"
in any technical sense between `start()` and `submit()` — both calls return and the process is free
to do other work. The state that makes the pause *feel* continuous is just a JS closure variable
(`collected`) held by the TUI across two separate user keystrokes.

### Move 3 — the principle

`04-agent-infrastructure/05-guardrails-and-control.md` frames human-in-the-loop as a gate that
exists to **approve an irreversible side effect** before it commits. This is a different reason to
pause — there's no side effect here to approve; `collect()` only reads. The pause exists to
**capture a judgment the system needs as an input**, before that judgment can be contaminated by
seeing the system's own answer. Call it a **judgment-capture checkpoint**, not an approval gate. The
general rule this exemplifies: whenever a pipeline both produces an evaluation *and* wants to
measure how well a human's own intuition tracks that evaluation, the pipeline has to physically stop
and collect the human's answer before it computes its own — there's no way to fake that ordering
after the fact.

## Primary diagram

```
  The full checkpoint, recapped — MarketResearchEngine (engine.ts:56-237)

  ┌─ UI ──────────────────────────────────────────────────────────────────┐
  │  chat.tsx: /research <topic> → createResearchFlow() → activeFlow held │
  └───────────────────────────────┬─────────────────────────────────────-┘
                                  │
  ┌─ Phase 1 (code) ──────────────▼─────────────────────────────────────-┐
  │  collect(): Collector over sources, concurrent (Promise.all)          │
  │  → CollectedResearch { evidence, digest: {totalCount, sources[]} }    │
  │  digest.totalCount === 0? → STOP, no prediction asked (research-      │
  │  flow.ts:85-88)                                                       │
  └───────────────────────────────┬─────────────────────────────────────-┘
                                  │ safe digest shown (titles only)
  ┌─ THE CHECKPOINT (human) ──────▼─────────────────────────────────────-┐
  │  PREDICTION_PROMPT → parsePrediction(input) → ResearchPrediction      │
  │  { expectedScore, expectedDimension, confidence }                     │
  └───────────────────────────────┬─────────────────────────────────────-┘
                                  │ evaluate(collected, prediction, ...)
  ┌─ Phase 2 (code) ──────────────▼─────────────────────────────────────-┐
  │  Analyzer → Scorer → Teacher (same capabilities as 07)                │
  │  → comparison { scoreGap, dimensionMatched } computed in TS,          │
  │    never asked of the model (engine.ts:202-208)                       │
  └────────────────────────────────────────────────────────────────────-─┘
```

## Elaborate

The heavier version of this pattern is a checkpointed graph orchestration engine
(`03-multi-agent-orchestration/07-graph-orchestration.md`) — LangGraph's `interrupt()`/`resume`
persists the whole run's state to durable storage so a pause can survive a process restart, branch
conditionally after resume, or have multiple pause points in one run. buffr doesn't reach for that
machinery, and that's the right call here: there's exactly one pause point, one shape of resume, and
the state that needs to survive the pause (`CollectedResearch`) is small enough to sit in a TUI
closure. Splitting one `Promise`-returning method into two plain methods and letting the *caller*
hold the pause is cheaper than standing up a graph engine — right up until you need more than one
pause point, conditional branching after resume, or the pause to survive a crash. buffr's pause is
in-memory TUI state: if the process dies between `collect()` and the human's answer, the pause is
lost and `/research <topic>` has to be re-run from scratch. A durable-checkpoint graph would
persist across that. Name that as the honest cost of the lighter-weight choice, not a gap nobody
noticed.

## Interview defense

**Q: "Your pipeline needs human input partway through — how did you handle that without building a
full workflow engine?"**

Model answer: "I split the one `run()` method 07's `InvestingEngine` uses into two —
`collect()` and `evaluate()` — with the human's prediction as a required argument to `evaluate()`
(`engine.ts:125-130`), so the type system enforces the ordering. `collect()` returns
`CollectedResearch`, which the caller (`research-flow.ts`) holds across the pause instead of
re-fetching. Because there's exactly one pause point and no need to survive a process restart, I
didn't need a checkpointed state machine — two methods and a closure variable were enough. If I
needed multiple pause points or crash-durability I'd reach for the graph-orchestration pattern
instead."

**Q: "Why show only titles before asking for the prediction — why not the full analysis?"**

Model answer: "Because a prediction made after seeing the answer isn't a prediction. `collect()`
returns a digest with `totalCount` and `titles` only (`types.ts:55-62`) — no findings, no scores,
no synthesized text. That boundary is what makes the comparison in `09` meaningful: the human's
`expectedScore` has to be a genuine guess, not a paraphrase of what they just read."

```
  The defense in one picture

  approval gate (guardrails.md)  → pauses to APPROVE a side effect
  this checkpoint (08)           → pauses to CAPTURE a judgment, before it's contaminated
```

Anchor: *`collect()`/`evaluate()` split (`engine.ts:56-237`) — the human's prediction is a required
argument to `evaluate()`, not optional, so the type system enforces predict-before-reveal; the safe
digest (`types.ts:55-62`) is what keeps the prediction honest.*

## See also

- `07-typed-engine-with-capability-pipeline.md` — the unbroken version of this same kernel
  (`InvestingEngine.run()`); this file is that kernel with one joint added.
- `09-predict-then-reveal-calibration-loop.md` — what this checkpoint's output feeds into across
  time, not just within one call.
- `04-agent-infrastructure/05-guardrails-and-control.md` — the *other* reason to pause
  (approving a side effect), contrasted with this file's reason (capturing a judgment).
- `03-multi-agent-orchestration/07-graph-orchestration.md` — the heavier machinery you'd reach for
  with multiple pause points or crash-durability requirements.
- `agent-patterns-in-this-codebase.md` — this pattern in the whole-repo table.
