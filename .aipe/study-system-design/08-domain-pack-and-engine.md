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

The capabilities (`@buffr/capabilities`) are shared across all domains — they are domain-agnostic. The domain knowledge lives entirely in the pack.

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

## Contrast with the general-purpose ReAct loop

| | General-purpose agent (ask) | Domain engine (analyze) |
|---|---|---|
| Control flow | model decides next step | code decides next step |
| Steps | variable per question | fixed: Collect→Analyze→Score→Teach |
| Domain knowledge | routing rules in system prompt | dimensions, scorecard, prompts in domain pack |
| LLM calls | model-driven (0 to maxToolCalls) | exactly 2 (Analyzer, Teacher) |
| Deterministic output | no | Scorer output is deterministic |
| Eval approach | precision@k on retrieval | fixture-based Scorer accuracy |
| Adds a new domain | add tool to the agent | new domain pack + new engine |

The two patterns are not in conflict — they serve different question types. "What does my KB say about X?" → agent loop. "Analyze ticker X across 5 dimensions and score it" → engine pipeline.

---

## How to add a second domain

1. Add `packages/domain-packs/<domain>/src/` with dimensions, scorecard, prompts, eval fixtures.
2. Add `packages/engines/<domain>/src/engine.ts` implementing `Engine<XInput, XOutput>`. Reuse the five capabilities.
3. Wire in `session.ts`: construct the engine in `createChatSession()`, expose a new method on the session facade.
4. Add a slash command in `chat.tsx`.
5. Write eval fixtures before writing the engine — Scorer is deterministic, so expected scores can be calculated by hand.

The capabilities are **not** duplicated. The engine re-wires the same five classes with new domain data. That's the reuse this architecture buys.

---

## Interview defense

**"What is a domain pack?"**

A bundle of domain-specific constants that parameterize the generic capability pipeline. It answers: what dimensions should the Analyzer cover, how should those dimensions be weighted, what system instructions should be injected, and what does a correct Scorer output look like for known inputs.

**"Why store prompts in the domain pack rather than in the capability?"**

Because the capability is domain-agnostic — it should be reusable across investing, health, learning, or any other domain. The domain's prompt tuning is domain knowledge, not capability logic. If the Analyzer capability hardcoded "apply rigorous fundamental analysis," it would be an investing-specific capability, not a general one. The separation keeps capabilities reusable and domain knowledge co-located with the domain data it describes.

---

## See also

- `packages/domain-packs/investing/src/` — the source of record.
- `packages/engines/investing/src/engine.ts` — the first Engine implementation.
- `07-capability-pipeline.md` — the capability layer in depth.
- `study-agent-architecture/07-typed-engine-with-capability-pipeline.md` — the engine pattern in the agent architecture context.
- `test/commands.test.ts` — fixture-based eval of the Scorer.
