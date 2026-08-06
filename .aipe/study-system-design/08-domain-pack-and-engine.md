# 08 — Domain Pack + Engine Composition

**Subtitle:** A `DomainPack` (dimensions + scorecard + prompts + eval fixtures) + an `Engine` implementation + chat commands = a complete analytical vertical.

---

## Zoom out

The monorepo now has three new structural concepts that work together:

```
  analytical vertical — three layers for a new domain

  ┌─ chat command layer ──────────────────────────────────────────┐
  │  src/cli/chat.tsx: /investing <TICKER>                         │
  │  src/session.ts: analyze(ticker, entityType)                   │
  └───────────────────────┬───────────────────────────────────────┘
                          │
  ┌─ engine layer ────────▼───────────────────────────────────────┐
  │  packages/engines/investing/src/engine.ts                      │
  │  InvestingEngine implements Engine<InvestingInput, InvestingOutput>│
  │    wires: Collector → Analyzer → Scorer → Teacher → Journal    │
  └───────────────────────┬───────────────────────────────────────┘
                          │ consumes
  ┌─ domain-pack layer ───▼───────────────────────────────────────┐
  │  packages/domain-packs/investing/src/                          │
  │    dimensions.ts   — COMPANY_DIMENSIONS (5), ETF_DIMENSIONS (5)│
  │    scorecards.ts   — COMPANY_SCORECARD, ETF_SCORECARD          │
  │    prompts.ts      — INVESTING_PROMPTS                         │
  │    entities.ts     — INVESTING_ENTITIES (stub)                 │
  │    eval/           — company-fixtures.json, etf-fixtures.json  │
  └───────────────────────────────────────────────────────────────┘
```

The capabilities (`@buffr/capabilities`) are shared across all domains — they are domain-agnostic. The domain knowledge lives entirely in the pack. This is the investing vertical as the worked example; `packages/engines/market-research/` repeats the same three-layer shape for a second domain but diverges at the engine layer — see "Two engine shapes" below.

---

## What a DomainPack provides

### Dimensions (`AnalysisDimension[]`)

Each dimension has: `id` (string key), `label` (display name), `description` (tells the Analyzer what to look for), `weight` (number, how much it counts toward the score). The Analyzer receives the dimensions array as `dimensions` in its input and is expected to emit one `AnalysisFinding` per dimension.

For investing:
- `COMPANY_DIMENSIONS` (5): covers fundamental analysis axes for equity companies.
- `ETF_DIMENSIONS` (5): covers structural axes for ETFs (expense ratio, diversification, etc.).

The dimension descriptions are the main lever for steering Analyzer behavior — they are the domain knowledge that shapes what the LLM notices and reports.

### Scorecard (`ScorecardDefinition`)

A mapping of `dimensionId → ScoreMetric[]`. Each `ScoreMetric` has a `weight` and a `label`. The Scorer applies these weights to the `confidenceScore` values that the Analyzer emitted for each dimension to produce `totalScore` and `confidence`.

The scorecard is the domain's claim about *which dimensions matter more*. A dimension can be in the dimension list but weighted low in the scorecard to indicate "check this but don't let it dominate the score."

### Prompts (`Record<string, string>`)

Domain-specific system instructions injected into capabilities. Currently `INVESTING_PROMPTS['analyzer-context']` is passed as `instructions[]` to `Analyzer.execute()` — it tells the model to apply rigorous fundamental analysis, flag red flags, cite evidence IDs, and say "insufficient evidence" rather than extrapolating.

This is the **first prompt-as-data pattern** in the monorepo: prompt text stored with the domain knowledge, not hardcoded in the capability implementation. The capability is domain-agnostic; the domain data includes the prompt tuning. → see `study-prompt-engineering/audit.md`.

### Eval fixtures (`eval/*.json`)

JSON files with structure:
```json
[{
  "description": "fixture name for error messages",
  "findings": [...AnalysisFinding[]...],
  "evidenceCount": 3,
  "expectedTotalScore": 72.5
}]
```

These fixtures are the golden set for Scorer accuracy. They serve two roles:
1. **Test assertion**: `test/commands.test.ts` loads them and runs `Scorer.execute` against each, asserting `|actual - expected| ≤ 0.01`.
2. **TUI eval**: `session.evalInvesting()` runs the same check and renders a human-readable table.

Because the Scorer is deterministic math, these fixtures never expire — they are not prompt-sensitive. If the scorecard weights change, the fixtures fail, which is the intended signal.

---

## Two engine shapes: single-call vs two-phase

`InvestingEngine` and `MarketResearchEngine` are both `Engine` implementations wired from the same five capabilities, but they expose different call contracts — this is the second engine in the monorepo, and it did not just clone the first one's shape.

```
  two Engine call contracts, same capability layer underneath

  InvestingEngine (packages/engines/investing/src/engine.ts)
    run(input, ctx) ──► Collector → Analyzer → Scorer → Teacher → Journal ──► InvestingOutput
    ONE call. Caller gets a finished analysis or nothing.

  MarketResearchEngine (packages/engines/market-research/src/engine.ts)
    collect(input, ctx)  ──► Collector only                    ──► CollectedResearch
                              (evidence + a safe digest, NO LLM call)
                    │
                    │  caller inspects the digest, prompts the human for a
                    │  ResearchPrediction, THEN calls the second phase
                    ▼
    evaluate(collected, prediction, opts, ctx) ──► Analyzer → Scorer → Teacher
                                                ──► MarketResearchOutput
                                                    { summary, detail, comparison }
```

**Why the split exists (`packages/engines/market-research/src/engine.ts:50-55` doc comment):** `/research`'s whole point is a predict-then-reveal loop (→ `09-predict-then-reveal-loop.md`) — the user has to commit to a prediction *before* seeing buffr's score, or the comparison is worthless (nobody predicts honestly after seeing the answer). That means the engine call has to pause in the middle: gather evidence, hand it to the caller, wait for a human input that isn't part of the domain data at all, then resume. A single `run()` can't do that — there's nowhere in a one-shot call to suspend for a REPL-style human turn. Splitting into two methods with an explicit intermediate type (`CollectedResearch`) makes the pause a first-class return value instead of a callback threaded through the pipeline.

**What `collect()` deliberately does NOT do (`engine.ts:50-55`):** run Analyzer, run Scorer, run Teacher, or synthesize any interpretation. It returns `evidence: Evidence[]` and an `EvidenceDigest` — `{ totalCount, sources: [{ source, count, titles }] }` (`types.ts:39-48`) — titles only, explicitly named "safe" in the doc comment because titles carry no analysis to bias the user's prediction. Each source runs through the *unchanged* `Collector` capability separately (one `execute()` call per source, `Promise.all`'d, `engine.ts:76-98`) rather than one `Collector.execute()` call with all sources — that costs a little redundant fan-out setup but buys per-source `ProgressEvent`s (`connector-start`/`connector-done`/`connector-failed`) the caller can stream to a UI, and a digest grouped by source without the Collector capability itself needing to know about grouping.

**What `evaluate()` assumes (`types.ts:51-53` doc comment):** `collected.evidence.length > 0` — it is the caller's job to check `digest.totalCount` before prompting for a prediction and invoking `evaluate()` at all. `research-flow.ts:85-88` is that caller: if `collected.digest.totalCount === 0` the flow short-circuits to "No evidence found" and never calls `evaluate()`, matching the "no LLM calls on empty evidence" invariant `07-capability-pipeline.md` already documents for the single-call engine — the invariant survived the split, it just moved to a different caller.

**The comparison is computed in code, never asked of the model.** `evaluate()` takes the caller-supplied `ResearchPrediction` as a plain argument and, after Scorer runs, builds `PredictionComparison` itself (`engine.ts:199-208`): `scoreGap = actualScore - prediction.expectedScore`, `dimensionMatched = strongestFinding?.dimensionId === prediction.expectedDimension`. If the Analyzer returns zero findings, `strongestFinding` is `null` and the comparison degrades to `actualDimension: 'unknown'`, `dimensionMatched: false` (`engine.ts:199-208`, hardened in `41ecce8` — see `audit.md` lens 8 for that bug as a case study) rather than crashing on an empty-array `.reduce()`. The model is never asked "was the user right" — that would let the LLM rationalize a match that isn't there.

**What this buys, concretely:** the UI layer (`src/cli/research-flow.ts`) can show raw evidence, capture a prediction, *then* run the expensive LLM stages — without the engine needing to know anything about REPLs, prompts, or terminal I/O. The engine's public surface is still two typed async methods; the human-in-the-loop pause lives entirely in the caller. This is the direct payoff of keeping `run()`/`collect()`/`evaluate()` as narrow typed methods rather than one giant function with an injected `askUser()` callback — the pause is *in the type system* (you cannot call `evaluate()` without a `CollectedResearch` and a `ResearchPrediction` in hand), not buried in control flow.

**When to reach for which shape when adding a third domain:** if the new domain's engine call can go straight from evidence to a finished result without a mandatory human checkpoint in between, `run()` is simpler and is what `InvestingEngine` proves works. Split into `collect()`/`evaluate()` only when there's a real reason to pause between them — a prediction to capture, a confirmation to get, a filter the user needs to apply to raw evidence before spending an LLM call on it. Splitting without that reason just adds a second method to keep in sync for no payoff.

---

## Contrast with the general-purpose ReAct loop

| | General-purpose agent (ask) | Domain engine (analyze / research) |
|---|---|---|
| Control flow | model decides next step | code decides next step |
| Steps | variable per question | fixed: Collect→Analyze→Score→Teach |
| Call shape | one `answer()` call, loops internally | `InvestingEngine.run()`: one call. `MarketResearchEngine`: `collect()` then `evaluate()`, split for a human checkpoint in between (see above) |
| Domain knowledge | routing rules in system prompt | dimensions, scorecard, prompts in domain pack |
| LLM calls | model-driven (0 to maxToolCalls) | exactly 2 (Analyzer, Teacher), regardless of call shape |
| Deterministic output | no | Scorer output is deterministic |
| Eval approach | precision@k on retrieval | fixture-based Scorer accuracy |
| Adds a new domain | add tool to the agent | new domain pack + new engine, single- or two-phase depending on whether a human checkpoint is needed |

The two patterns are not in conflict — they serve different question types. "What does my KB say about X?" → agent loop. "Analyze ticker X across 5 dimensions and score it" → engine pipeline.

---

## How to add a domain (proven twice now: investing, market-research)

1. Add `packages/domain-packs/<domain>/src/` with dimensions, scorecard, prompts, eval fixtures.
2. Add `packages/engines/<domain>/src/engine.ts` implementing `Engine<XInput, XOutput>` (single `run()`) — or, if the flow needs a human checkpoint mid-pipeline (a prediction, a confirmation, a filter on raw evidence), split into two phase methods the way `MarketResearchEngine.collect()`/`evaluate()` does. Reuse the five capabilities either way.
3. Wire in `session.ts`: construct the engine in `createChatSession()`, expose new method(s) on the session facade (one for `run()`-shaped engines, two for split ones).
4. Add a slash command in `chat.tsx`, plus a dedicated flow file under `src/cli/` if the command is a multi-turn loop rather than a single request/response (see `09-predict-then-reveal-loop.md` for how `research-flow.ts` structures that).
5. Write eval fixtures before writing the engine — Scorer is deterministic, so expected scores can be calculated by hand.

The capabilities are **not** duplicated across either domain. Both engines re-wire the same five classes with new domain data. That's the reuse this architecture buys — the second domain proved it by reusing 100% of `packages/capabilities/` with zero changes to Collector, Scorer, or Journal (Analyzer and Teacher gained new optional fields — `instructions`, `principle`, `reflectionQuestion` — but those are additive, not domain-specific branches).

---

## Interview defense

**"What is a domain pack?"**

A bundle of domain-specific constants that parameterize the generic capability pipeline. It answers: what dimensions should the Analyzer cover, how should those dimensions be weighted, what system instructions should be injected, and what does a correct Scorer output look like for known inputs.

**"Why store prompts in the domain pack rather than in the capability?"**

Because the capability is domain-agnostic — it should be reusable across investing, health, learning, or any other domain. The domain's prompt tuning is domain knowledge, not capability logic. If the Analyzer capability hardcoded "apply rigorous fundamental analysis," it would be an investing-specific capability, not a general one. The separation keeps capabilities reusable and domain knowledge co-located with the domain data it describes.

**"Why does `MarketResearchEngine` have two methods instead of one `run()` like `InvestingEngine`?"**

Because `/research` needs to pause mid-pipeline for a human input that has nothing to do with the domain data — the user's prediction. `collect()` returns evidence and a safe digest with zero LLM calls; the caller shows that to the user, captures a `ResearchPrediction`, and only then calls `evaluate()`, which runs Analyzer→Scorer→Teacher and computes the prediction-vs-actual comparison in code. `InvestingEngine.run()` doesn't need this because `/investing` has no human checkpoint — evidence goes straight to analysis. The split is a direct consequence of the predict-then-reveal UX (`09-predict-then-reveal-loop.md`), not a general upgrade every engine should get — splitting `InvestingEngine.run()` the same way would add a method with no caller that needs to pause.

**"What would you name this split, if someone asked you to generalize it?"** A two-phase engine, or command/query split at the engine boundary — `collect()` behaves like a query (side-effect-free evidence gathering), `evaluate()` behaves like a command that consumes prior state plus new input (the prediction) to produce a result. It's not literal CQRS (there's no separate read/write model), but the shape rhymes: separate the phase that has no dependency on user judgment from the phase that does.

---

## See also

- `packages/domain-packs/investing/src/`, `packages/domain-packs/market-research/src/` — the source of record for each domain pack.
- `packages/engines/investing/src/engine.ts` — the single-call `Engine` shape.
- `packages/engines/market-research/src/engine.ts` — the two-phase `collect()`/`evaluate()` shape.
- `07-capability-pipeline.md` — the capability layer in depth, including the Teacher's `principle`/`reflectionQuestion` addition.
- `09-predict-then-reveal-loop.md` — the full system-level flow this engine split exists to serve: predict → reveal → promote → track → review.
- `study-agent-architecture/07-typed-engine-with-capability-pipeline.md` — the engine pattern in the agent architecture context.
- `test/commands.test.ts` — fixture-based eval of the investing Scorer; `packages/domain-packs/market-research/test/scorecard.test.ts` — the market-research equivalent.
