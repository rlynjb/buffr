# Collect-then-evaluate split — a pipeline broken in two for a human checkpoint

**Industry names:** human-in-the-loop (HITL) checkpoint · staged pipeline ·
wizard-style multi-step flow · a saga's "pause point." **Type:** Industry
standard (HITL is the standard AI-engineering term; the rest of the shape
is this repo's own composition of it).

`InvestingEngine.run()` is one `async` method: call it, await it, get a
score back. `MarketResearchEngine` doesn't have a `run()` — it has
`collect()` and `evaluate()`, two separately-awaitable methods with a gap
between them where a human types a prediction. Same five capabilities
(`Collector → Analyzer → Scorer → Teacher`), same domain-pack machinery,
genuinely different shape — because `/research` has a product requirement
`/investing` doesn't: capture the user's guess *before* they see the
model's answer, so the gap between the two is measurable.

Role-vocabulary, named once:

- **phase 1 (`collect`)** — `MarketResearchEngine.collect()`
  (`engine.ts:56-117`); fans out to sources, returns evidence + a digest.
  No scoring, no LLM synthesis.
- **the checkpoint** — the CLI turn between phases, where
  `research-flow.ts` shows the digest, prompts for a prediction, and waits
  for the user to type one. Not a method call — a wait for external input.
- **the contract carried across the checkpoint** — `CollectedResearch`
  (`types.ts:55-62`), the value phase 1 returns and phase 2 consumes
  unchanged.
- **phase 2 (`evaluate`)** — `MarketResearchEngine.evaluate()`
  (`engine.ts:125-237`); takes the phase-1 output *plus* the prediction the
  checkpoint collected, runs Analyzer → Scorer → Teacher, and computes the
  comparison.

---

## Zoom out, then zoom in

The split sits inside the same engine layer as `InvestingEngine`, but with
a UI-layer state machine wedged into the middle of what would otherwise be
one pipeline call.

```
  Zoom out — the checkpoint wedged into the engine layer

  ┌─ UI layer: cli/chat.tsx + research-flow.ts ──────────────────────┐
  │  createResearchFlow(session, topic)                               │
  │    start()  → session.researchCollect(topic)                      │
  │    (show digest, PROMPT for a prediction — waits on user input)   │ ← THE
  │    submit() → session.researchEvaluate(collected, prediction)     │   CHECKPOINT
  └───────────────────────────┬───────────────────────────────────────┘
                              │ two separate calls, not one
  ┌─ Engine layer: MarketResearchEngine ──────────────────────────────┐
  │  ★ collect(topic) ★         GAP          ★ evaluate(collected,   │ ← here
  │   Collector → digest                      prediction) ★           │
  │                                            Analyzer→Scorer→Teacher │
  └─────────────────────────────────────────────────────────────────┘
                              vs.
  ┌─ Contrast: InvestingEngine (no checkpoint, no split) ─────────────┐
  │  run(ticker) → Collector→Analyzer→Scorer→Teacher→Journal, ONE call│
  └─────────────────────────────────────────────────────────────────┘
```

Zoom in: `run()` is what you write when the pipeline can go start to
finish without anyone in the loop. `collect()`/`evaluate()` is what you
write when the *product* requires a human decision to land in the middle,
and that decision has to be captured before the model's answer would bias
it — the whole point of `/research`'s predict-then-reveal ritual
(context.md).

---

## The structure pass

**Layers:** the CLI state machine (`research-flow.ts`) · the engine
(`MarketResearchEngine`) · the capabilities (`Collector`/`Analyzer`/
`Scorer`/`Teacher`).

**The axis: who decides what happens next?** Trace it across all three
bands — this is the axis that explains *why* the method got cut in two:

```
  axis traced = "who decides what runs next?"

  ┌─ inside collect() ─┐  seam  ┌─ the checkpoint ─┐  seam ┌─ inside evaluate()─┐
  │ ENGINE decides:    │ ══╪══► │ HUMAN decides:    │ ══╪══►│ ENGINE decides:    │
  │ fan out to N       │       │ what score/dim/    │       │ Analyzer→Scorer→   │
  │ sources in parallel│       │ confidence to guess│       │ Teacher, fixed order│
  └─────────────────────┘       └───────────────────┘       └─────────────────────┘
       code-controlled              NOT a function call         code-controlled again
                        the control axis flips TWICE —
                        that double flip is why this is two methods, not one
```

Compare this to `02-pure-core-impure-shell.md`'s double flip (impure →
pure → impure, traced on the *side-effect* axis). This is the same
rhetorical shape — a property flips, un-flips, and the un-flip is the
tell that you're looking at three bands, not one — but traced on
*control* instead of *purity*. A single `async function evaluate(topic)`
has no way to suspend itself mid-body, hand control to a human typing in
a terminal, and resume later with their answer as a new argument — not
without invasive machinery (generators, continuations). Two ordinary
`async` methods called from two different places in the CLI is the
straightforward way to get the same effect: the "suspension" is just
"the CLI hasn't called `evaluate` yet."

**The seam that matters:** `CollectedResearch`, the value carried across
the checkpoint. Everything phase 2 knows about phase 1's work — the
evidence, the digest, the warnings — travels through that one typed
object. No implicit state, no shared mutable field on the engine instance
holds it between calls; the CLI (`research-flow.ts:75`, `let collected:
CollectedResearch | null = null`) is the thing that remembers it exists
between the two awaits, not the engine.

---

## How it works

### Move 1 — the mental model

You've built this shape on the frontend as a multi-step form (a "wizard"):
step 1 submits and gets back data to show the user; step 2 doesn't re-fetch
step 1's data, it takes what step 1 already fetched plus whatever the user
typed on the intermediate screen. The form component holds the step-1
result in state between renders; nothing about the *server* needs to
"pause." `research-flow.ts` is exactly that, server-adjacent: it's the
component holding `collected` in a closure between two calls to two
different session methods.

In one sentence: **when a human decision has to land between two stages of
a pipeline, split the pipeline at that point into two methods and let the
caller hold the seam value across the gap — don't try to make one function
suspend.**

```
  Collect-then-evaluate — the kernel

  collect(topic)      → CollectedResearch          (fast, no LLM synthesis)
       │
       ▼
  [ CLI shows digest, waits for user to type a prediction ]   ← the checkpoint
       │
       ▼
  evaluate(collected, prediction) → MarketResearchOutput      (LLM synthesis + compare)
```

### Move 2 — the walkthrough

**1. `collect()` — evidence only, no interpretation, by design.** The
doc comment on `collect` is explicit about what it deliberately withholds:

```ts
// engine.ts:50-55
/**
 * Gathers evidence and returns a safe digest (count, source, titles only —
 * no findings, scores, or synthesized text). Runs each source through the
 * (unchanged) Collector separately so the digest can be grouped by source
 * while keeping full cross-source parallelism.
 */
async collect(input: MarketResearchCollectInput, context: AgentContext): Promise<AgentResult<CollectedResearch>> {
```

"Safe digest" is the load-bearing phrase: titles and counts, never a
score or an LLM-generated summary. That's not an accident of what's
convenient to compute first — it's the whole reason the split exists. If
`collect()` leaked even a rough score, showing it before the prediction
prompt would anchor the user's guess to the model's answer, and the
predict-then-reveal comparison (the product feature) would be
measuring nothing.

**2. The checkpoint — a state machine holding the seam value, not a
suspended function.** `research-flow.ts` is a small state machine
(`step: 'prediction' | 'promote' | 'stake' | ...`) built around exactly
one piece of held state that matters here:

```ts
// research-flow.ts:73-90 (condensed)
export function createResearchFlow(session: ChatSession, topic: string, callbacks): ResearchFlow {
  let collected: CollectedResearch | null = null;   // ← the seam value, held in closure
  let prediction: ResearchPrediction | null = null;

  return {
    async start(): Promise<ResearchFlowResult> {
      const { collected: c } = await session.researchCollect(topic, callbacks);
      collected = c;                                  // ← phase 1 done, value captured
      if (collected.digest.totalCount === 0) { /* bail, nothing to evaluate */ }
      return { messages: [formatDigest(topic, collected), PREDICTION_PROMPT], step: 'prediction' };
    },
```

The `await` inside `start()` genuinely suspends — but it suspends on I/O
(the connectors), not on the human. The human-facing wait is structurally
different: `start()` *returns*, the CLI renders the prompt, and control
comes back into this closure only when the user submits text and
`submit()` gets called. `collected` living in the closure between those
two calls is what makes it look, from the outside, like one continuous
flow — it's really two independent async calls bridged by ordinary
JavaScript closure state, the same trick a React component uses to hold
step-1 data across a re-render.

**3. `evaluate()` — takes the prediction as a real argument, not a
side-channel.** The prediction the checkpoint collected isn't stashed on
the engine or read back out of some shared object — it's passed straight
into the method that needs it:

```ts
// research-flow.ts:95-107 (the prediction step, submit())
if (step === 'prediction') {
  const parsed = parsePrediction(input);              // ← pure parse, CLI-layer concern
  if (!parsed) return { messages: ['Could not parse that. ...'], step };
  prediction = parsed;
  const { output: o } = await session.researchEvaluate(collected, prediction, callbacks);  // ← BOTH values in
  output = o;
  step = 'promote';
  return { messages: [formatReveal(output), PROMOTE_PROMPT], step };
}
```

```
  Layers-and-hops — the checkpoint, full round trip

  ┌─ research-flow.ts ─┐ researchCollect(topic)   ┌─ MarketResearchEngine ─┐
  │  start()            │ ───────────────────────► │ collect(): fan out,    │
  │                      │ ◄─── CollectedResearch ──│  digest only           │
  │  hold `collected`    │                          └────────────────────────┘
  │  render digest +      │
  │  prompt for prediction│  (waits on a person, not a promise)
  │  parse user input      │
  │  hold `prediction`      │ researchEvaluate(collected, prediction) ┌─ Engine ─┐
  │  submit()                │ ───────────────────────────────────► │ evaluate()│
  │                            │ ◄──── MarketResearchOutput ──────── └───────────┘
  └────────────────────────────┘
```

**4. The invariant that has to travel WITH the seam value, in words, not
types — and the bug that happened when it didn't.** `evaluate()`'s doc
comment states an assumption about what `collect()` guarantees:

```ts
// engine.ts:119-124
/**
 * Runs Analyzer -> Scorer -> Teacher and computes the prediction
 * comparison in code (never asks the model to invent the gap). Assumes
 * collected.evidence.length > 0 — the caller must check
 * collected.digest.totalCount before calling this.
 */
async evaluate(collected: CollectedResearch, prediction: ResearchPrediction, ...)
```

`research-flow.ts:85-88` does check `digest.totalCount === 0` before
ever reaching the prediction prompt — so that half of the contract is
honored correctly. But the invariant as *written* conflates two different
guarantees: "evidence exists" and "the Analyzer will find something in
it." Non-empty evidence does not imply non-empty findings — an LLM
Analyzer can look at real evidence and return zero findings. `evaluate()`
used to compute `strongestFinding` with a bare non-null assertion
(`analyzerResult.data.findings[0]!`), which crashed exactly when evidence
was non-empty but findings came back empty — a case the doc comment's
stated invariant didn't rule out, because it named the wrong guarantee.
Fixed in `41ecce8` by handling the empty-findings case explicitly
(`engine.ts:196-201`) — see `audit.md` lens 6 for the full incident, and
the general lesson: **a contract carried across a checkpoint has to name
the guarantee the second phase actually needs, not one that sounds
similar.**

### Move 3 — the principle

Split a pipeline into two methods exactly where a human decision has to
land between two automated stages — not before, not after, and don't try
to make one function span the gap by suspending it. The seam value
(`CollectedResearch`) is the whole interface between the phases: it has
to carry everything phase 2 needs and nothing phase 1 shouldn't reveal
yet (no score, no synthesis — the "safe digest" rule). And whatever
invariant phase 2 assumes about what phase 1 guarantees needs to be
checked at the actual boundary condition that matters, not a
nearby-sounding one — "evidence exists" and "findings exist" are two
different facts, and only a comment (not the type system) was carrying
the difference here, which is exactly how it slipped.

---

## Primary diagram

```
  collect() / evaluate() — the checkpoint split, full recap

  ┌─ CLI: research-flow.ts (the checkpoint) ─────────────────────────┐
  │  start()  → researchCollect(topic)                                 │
  │  hold `collected` in closure                                       │
  │  render digest, PROMPT for prediction  ← waits on a HUMAN, not I/O │
  │  parse input → hold `prediction`                                    │
  │  submit() → researchEvaluate(collected, prediction)                 │
  └───────────────────────────┬─────────────────────────────────────────┘
                    two calls  │  no suspended function spans the gap
  ┌─ Engine: MarketResearchEngine ▼──────────────────────────────────────┐
  │  collect(topic)                    evaluate(collected, prediction)   │
  │   Collector → evidence + digest     Analyzer → Scorer → Teacher      │
  │   NO scoring, NO synthesis           → PredictionComparison in code  │
  │   (anti-anchoring, by design)        (never asks the model to guess  │
  │                                        the gap itself)                │
  └────────────────────────────────────────────────────────────────────┘
                    vs. InvestingEngine.run() — ONE call, no checkpoint,
                    because /investing has no predict-then-reveal ritual
```

---

## Elaborate

Human-in-the-loop checkpoints are the standard shape whenever an
automated pipeline needs a person's judgment mid-flight — approval
gates in CI/CD, "confirm before send" in email clients, the classic
multi-step web form. What's specific to buffr is *why* the checkpoint
exists here and nowhere else in the two engines: `/investing`'s
`analyze()` has no equivalent human decision baked into the product —
you ask, it answers, you read it. `/research` was built specifically to
train calibration (context.md: the decision journal tracks a
predict-then-reveal loop through to a resolved outcome), so the human's
guess has to be captured before the model's synthesis exists to bias it.
The engine shape follows the product requirement, not the other way
around — `InvestingEngine` staying a single `run()` isn't an
inconsistency to fix, it's the correct shape for a feature with no
checkpoint to protect.

This is a sibling of `06-capability-as-typed-computation-unit.md`: the
same five capability classes, wired by two different engines into two
different topologies (one linear call, one split-with-a-gap) — the
capabilities don't know or care which topology they're wired into,
because neither engine leaks its topology *into* a capability.

---

## Interview defense

**Q: Why not just make `evaluate` accept an `onPrediction` callback and
keep it one method, `async run()`?** Because the callback would have to
be awaited from *inside* `run()`, and an `await` on "wait for a human to
type something in a terminal, with the CLI free to render other things
in the meantime" isn't a promise you resolve — it's control handed back
to a UI event loop. `run()` would have to block the whole engine on
terminal I/O it has no business knowing about. Splitting into two
ordinary methods keeps the engine free of any UI awareness — the CLI
owns waiting for the human, the engine owns the two batches of work on
either side of that wait.
*Anchor:* "you can't `await` a human from inside a pure engine method
without giving the engine a dependency on the UI's event loop — so you
end the method instead, and pick it back up as a second call."

```
  one method, blocked on UI I/O        two methods, UI owns the wait
  ┌────────────────────────┐          ┌───────────┐   ┌───────────┐
  │ run(): ...              │          │ collect() │   │ evaluate()│
  │   await humanInput() ← │          └─────┬─────┘   └─────▲─────┘
  │   engine now depends    │                │  CLI renders, waits  │
  │   on the terminal        │                └──────────────────────┘
  └────────────────────────┘
```

**Q: What guarantees `CollectedResearch` isn't stale by the time
`evaluate()` runs — e.g. does the user's prediction always match the
evidence they saw?** Yes, structurally: `collected` is held in a
`research-flow.ts` closure that's never reassigned between `start()` and
the `evaluate()` call in `submit()`'s `'prediction'` branch
(`research-flow.ts:75-104`). There's no re-fetch, no cache invalidation
window — the exact object `collect()` returned is the exact object
`evaluate()` receives. The risk that *does* exist is the invariant gap
covered in Move 2 (evidence non-empty ≠ findings non-empty) — not
staleness, but an incompletely-named contract.
*Anchor:* "the seam value is held by reference in one closure, never
re-derived — staleness isn't the risk here, an incomplete invariant is."

**Q: Could `InvestingEngine` be split the same way?** Only if
`/investing` grew a feature that needs a human decision mid-pipeline.
Today it doesn't — `analyze()` is a single request/response, so a split
would add two methods, a held seam value, and a CLI-side state machine
for no capability gained. The split is a cost you pay for a checkpoint;
don't pay it speculatively.
*Anchor:* "the split isn't a style choice — it's the price of a
checkpoint, so you only pay it where a checkpoint is real."

---

## See also

- `06-capability-as-typed-computation-unit.md` — the same five
  capabilities, wired into `InvestingEngine`'s single-call topology
  instead of this split one.
- `02-pure-core-impure-shell.md` — the same "axis flips twice" structure,
  traced on purity instead of control.
- `05-deep-session-facade.md` — `researchCollect`/`researchEvaluate` are
  two of the facade's now-fifteen exposed methods; this file is the deep
  walk of why that pair, specifically, had to be two methods.
- `audit.md` lens 6 — the empty-findings crash this split's invariant gap
  caused, and the fix.
