# 07 — Capability Pipeline

**Subtitle:** Typed Linear Pipeline — five independently-testable stages, LLM calls isolated to exactly two.

---

## Zoom out

The capability pipeline is the implementation layer inside `InvestingEngine`. It is not the same thing as the agent loop — it is an alternative to it. Where the agent loop lets the LLM decide what to do next, the capability pipeline encodes the decision in code.

```
  @buffr/capabilities  —  five capability classes, one per stage

  ┌──────────────┬──────────────────────────────────────────────────┐
  │ Collector    │ fan-in: run N connectors concurrently,           │
  │              │ return Evidence[]                                │
  ├──────────────┼──────────────────────────────────────────────────┤
  │ Analyzer     │ LLM tool-calling loop → AnalysisFinding[]        │
  │              │ (model calls submit_analysis to emit findings)   │
  ├──────────────┼──────────────────────────────────────────────────┤
  │ Scorer       │ pure math: scorecard weights × confidenceScore   │
  │              │ → totalScore, confidence, metrics[]              │
  ├──────────────┼──────────────────────────────────────────────────┤
  │ Teacher      │ LLM single-shot → explanation, keyLessons,       │
  │              │ actionableNext                                   │
  ├──────────────┼──────────────────────────────────────────────────┤
  │ Journal      │ pure persistence: write JournalEntry (in-memory) │
  │              │ with UUID, subject, decision, risks, evidenceIds │
  └──────────────┴──────────────────────────────────────────────────┘
```

---

## Structure pass

Each capability class lives in `packages/capabilities/src/<name>/`. Each has a single public method:

```typescript
execute(input: TInput, ctx: AgentContext): Promise<AgentResult<TOutput>>
```

No shared mutable state between capabilities. No inheritance hierarchy. Composability comes from explicit wiring in the engine, not from a plugin registry or base class.

---

## How it works — stage by stage

### Collector (`packages/capabilities/src/collector/`)

Takes `{ sources: Array<{ connector, params, optional }> }`. Runs all connectors via `Promise.allSettled` — failures in `optional` sources are collected as `FailedSource[]` rather than thrown. Returns `{ evidence: Evidence[], failed: FailedSource[] }`.

The short-circuit rule lives immediately after Collector returns in the engine: if `evidence.length === 0`, the engine returns `{ confidence: 0 }` without calling Analyzer or Teacher. This is the "no LLM calls on empty evidence" invariant — it prevents the model from hallucinating analysis when there is nothing to analyze.

### Analyzer (`packages/capabilities/src/analyzer/`)

The one complex capability. Runs a tool-calling loop where the model calls a single tool, `submit_analysis(findings[])`, to emit `AnalysisFinding[]`. Each finding covers one `AnalysisDimension`: `positives`, `negatives`, `unknowns`, `confidenceScore (0–1)`. The `instructions` parameter (injected from `INVESTING_PROMPTS['analyzer-context']`) is domain-specific context prepended to the model's task.

Because the model calls exactly one tool (`submit_analysis`) to terminate the loop, the Analyzer is a bounded ReAct sub-loop — it terminates when the model emits the submission, or on a turn limit.

### Scorer (`packages/capabilities/src/scorer/`)

No LLM. Takes `{ findings, scorecard, evidenceCount }`. A `ScorecardDefinition` maps each dimension ID to `ScoreMetric[]` (weight, label). The scorer applies weights to `finding.confidenceScore` to produce:
- `totalScore` (0–100): weighted sum of `confidenceScore × weight × 100`
- `confidence` (0–1): derived from `evidenceCount` and per-finding confidence
- `metrics[]`: one metric per dimension with raw values

Deterministic. Same inputs → same output. This is why the fixture-based accuracy test (`test/commands.test.ts:28-79`) works without mocking — there is nothing to mock.

### Teacher (`packages/capabilities/src/teacher/`)

LLM single-shot. The model calls `submit_explanation({ explanation, keyLessons, actionableNext })` once and the capability returns that struct. The `audience` parameter drives the framing (currently always `'individual investor'`). No loop, no tool calls beyond the single submit.

### Journal (`packages/capabilities/src/journal/`)

No LLM, no DB. Writes a `JournalEntry` with a UUID to an in-memory store, returns the entry. Designed for a future persistence adapter — the in-memory shape is the contract; a durable backend (Postgres row, file, etc.) is a future swap.

---

## The structural property worth internalizing

**LLM calls are isolated to exactly two stages: Analyzer and Teacher.** This means:

- The other three stages (Collector, Scorer, Journal) can be unit-tested against real inputs without mocking a model.
- The Scorer output is deterministic and can be eval'd against golden fixtures (`packages/domain-packs/investing/eval/`).
- A regression in Analyzer or Teacher output does not corrupt Scorer output — stages compose through typed structs, not shared state.
- Tracing a wrong score back to its cause is structured: wrong `totalScore` → inspect `metrics[]` from Scorer → inspect `findings[].confidenceScore` from Analyzer → inspect evidence from Collector.

---

## Interview defense

**"How is the capability pipeline different from a chain?"**

A chain (in LangChain / LangGraph terminology) is typically a sequence of LLM calls. The capability pipeline is a sequence of *typed computation units*, most of which are not LLM calls. The Scorer is pure math; the Collector is concurrent I/O; the Journal is a write. Only Analyzer and Teacher involve a model. Calling this a "pipeline" rather than a "chain" is deliberate — it signals that the computation is heterogeneous, not a series of model calls.

**"Why not just make everything one big LLM call?"**

Because the Scorer's output needs to be trustworthy for the fixture-based eval to work. If scoring is done by the LLM, the output varies per run and cannot be asserted in a test. Making Scorer a pure function means the scorecard math can be independently verified — which is the exact thing `test/commands.test.ts` does. That determinism is worth the complexity of having multiple stages.

---

## See also

- `packages/capabilities/src/` — the source of record for each capability.
- `08-domain-pack-and-engine.md` — how capabilities are composed into an engine with domain data.
- `study-agent-architecture/07-typed-engine-with-capability-pipeline.md` — the engine-level view.
- `test/commands.test.ts` — Scorer accuracy fixtures.
