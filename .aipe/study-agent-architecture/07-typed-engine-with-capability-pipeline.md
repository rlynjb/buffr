# 07 — Typed Engine / Linear Capability Pipeline

**Subtitle:** Industry standard (`Engine<TInput,TOutput>` typed contract) + Project-specific (capability composition as a five-step fixed pipeline).

---

## Zoom out — where InvestingEngine fits

buffr now has two parallel computation shapes under the same TUI, both entered through `src/session.ts`:

```
  src/cli/chat.tsx — handleSubmit()
    │
    ├─ /investing <TICKER>  ──►  session.analyze()
    │                                └─► InvestingEngine.run()   ◄── YOU ARE HERE
    │                                    Collector→Analyzer→Scorer→Teacher→Journal
    │
    ├─ /eval                ──►  session.evalInvesting()
    │                                └─► Scorer against fixtures  (no engine needed)
    │
    └─ anything else        ──►  session.ask()
                                     └─► RagQueryAgent.answer()
                                         ReAct loop (model chooses next step)
```

InvestingEngine sits **alongside** the ReAct loop, not inside it. It is accessed via `session.analyze()` which is a sibling of `session.ask()`. The TUI never knows which shape ran — both return a `Promise<string>`.

**A second engine now reuses this same kernel.** `packages/engines/market-research/src/engine.ts`
(`MarketResearchEngine`) is wired the same way — `/research <topic>` → `session.researchCollect()`
/ `session.researchEvaluate()` → the capability pipeline — and it builds on the *exact same*
`Collector`/`Analyzer`/`Scorer`/`Teacher` capabilities this file describes. The one structural
difference: `MarketResearchEngine` doesn't have a single `run()` — it's split into `collect()` and
`evaluate()`, with a human required to supply a prediction in between. That's the same kernel below
with one new joint; the joint itself is covered as its own pattern in
`08-human-in-the-loop-pipeline-checkpoint.md` rather than repeated here.

---

## Structure pass

**New packages this pattern spans:**

- `packages/contracts/src/` — `Engine<TInput,TOutput>` interface, `AgentContext`, `AgentResult<T>`, `AnalysisDimension`, `ScorecardDefinition`, `Evidence`
- `packages/capabilities/src/` — five capability classes: `Collector`, `Analyzer`, `Scorer`, `Teacher`, `Journal`
- `packages/domain-packs/investing/src/` — `COMPANY_DIMENSIONS`, `ETF_DIMENSIONS`, `COMPANY_SCORECARD`, `ETF_SCORECARD`, `INVESTING_PROMPTS`
- `packages/engines/investing/src/engine.ts` — `InvestingEngine implements Engine<InvestingInput, InvestingOutput>`
- `src/session.ts` — wires `InvestingEngine` in `createChatSession()`; exposes `analyze()` on the session facade

---

## How it works

### The Engine interface (the contract)

```typescript
interface Engine<TInput, TOutput> {
  id: string;
  version: string;
  run(input: TInput, context: AgentContext): Promise<AgentResult<TOutput>>;
}
```

`AgentContext` carries `userId`, `workspaceId`, `traceId`, `domain`, `now`, `permissions`. Every capability and every engine receives it so traces and permissions thread through without being passed in every internal call.

### InvestingEngine.run() — the five-step pipeline

`packages/engines/investing/src/engine.ts:35-161` implements the pipeline:

```
  1. Collector.execute({ sources })
       ─ runs each InvestingSource connector concurrently (Promise.allSettled)
       ─ returns { evidence: Evidence[], failed: FailedSource[] }
       ─ SHORT-CIRCUIT: if evidence.length === 0, return confidence:0 immediately
         (no LLM calls, no downstream steps)

  2. Analyzer.execute({ subjectDescription, evidence, dimensions, instructions })
       ─ LLM tool-calling loop: model calls submit_analysis to emit AnalysisFinding[]
       ─ one finding per dimension (positives, negatives, unknowns, confidenceScore)
       ─ domain instructions from INVESTING_PROMPTS['analyzer-context'] are injected here

  3. Scorer.execute({ findings, scorecard, evidenceCount })
       ─ pure math: applies scorecard weights to finding.confidenceScore per dimension
       ─ produces totalScore (0–100), confidence (0–1), metrics[]
       ─ deterministic: same inputs → same output, always

  4. Teacher.execute({ subjectDescription, findings, totalScore, confidence, warnings, audience })
       ─ LLM single-shot: calls submit_explanation to produce { explanation, keyLessons, actionableNext }
       ─ framed for 'individual investor' audience
       ─ no financial advice or price targets in the prompt framing

  5a. Memory (optional): if input.conversationId is provided, write the analysis
      summary to ConversationMemory so it surfaces via future search_knowledge_base calls

  5b. Journal (optional): if input.decision is provided, write a JournalEntry (in-memory)
      with UUID, subject, risks, assumptions, evidenceIds
```

LLM calls live in steps 2 and 4 only. Steps 1, 3, 5a/5b are deterministic or I/O-only. This isolation is the structural property that makes steps 3 and 5 unit-testable without mocking a model.

---

## Primary diagram

```
  InvestingEngine.run(input, context)

  ┌─ input ──────────────────────────────────────────────────────────┐
  │  ticker: string, entityType: 'company'|'etf'                      │
  │  sources: InvestingSource[]  (web connectors + paramsFor fn)      │
  │  conversationId?: string     (write to memory if present)         │
  │  decision?: string           (write to journal if present)        │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │
                                  ▼
  ┌─ Step 1: Collector ──────────────────────────────────────────────┐
  │  sources.map(s => connector.fetch(s.paramsFor(ticker)))           │
  │  Promise.allSettled → Evidence[] + FailedSource[]                │
  │  evidence.length === 0? ──► return { confidence: 0 }  (STOP)     │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │ Evidence[]
                                  ▼
  ┌─ Step 2: Analyzer (LLM) ─────────────────────────────────────────┐
  │  tool-calling loop → submit_analysis(findings[])                  │
  │  COMPANY_DIMENSIONS or ETF_DIMENSIONS (5 each)                    │
  │  INVESTING_PROMPTS['analyzer-context'] as instructions            │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │ AnalysisFinding[]
                                  ▼
  ┌─ Step 3: Scorer (pure math) ─────────────────────────────────────┐
  │  findings × scorecard weights → totalScore, confidence, metrics[] │
  │  COMPANY_SCORECARD or ETF_SCORECARD                               │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │ totalScore, confidence
                                  ▼
  ┌─ Step 4: Teacher (LLM) ──────────────────────────────────────────┐
  │  submit_explanation → { explanation, keyLessons, actionableNext } │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │
                                  ├─► Memory.remember (if conversationId)
                                  ├─► Journal.execute (if decision)
                                  ▼
                           AgentResult<InvestingOutput>
```

---

## The key tension

**The Engine pattern makes the control flow visible in code instead of deferring it to the model. The ReAct loop gives the model control.**

When you have a known, bounded analysis job (five dimensions, a scorecard, a fixed audience), the pipeline is right. The steps don't depend on what the model *finds* — you know them ahead of time. Code is the right place to specify them.

When you have an open-ended user question (what should I eat tonight? what's in the news about X?), the loop is right. The steps do depend on what the model finds in the KB or on the web, and making the model decide is cheaper than enumerating every possible path in code.

The dispatch in `chat.tsx` is the one place this distinction is made: `/investing` → engine; anything else → loop.

---

## Interview defense

**"Walk me through how you'd add a new analysis domain."**

1. **Domain pack** — add `packages/domain-packs/<domain>/src/` with:
   - `DIMENSIONS: AnalysisDimension[]` (id, label, description, weight for each axis)
   - `SCORECARD: ScorecardDefinition` (maps dimension IDs to `ScoreMetric[]`)
   - `PROMPTS: Record<string, string>` (analyzer and teacher context)
   - Eval fixtures in `eval/` (JSON with inputs + expectedTotalScore)

2. **Engine** — add `packages/engines/<domain>/src/engine.ts` implementing `Engine<XInput, XOutput>`. Wire the five capabilities (`Collector`, `Analyzer`, `Scorer`, `Teacher`, `Journal`). The capabilities are reused; only the domain data changes.

3. **Session** — add `session.analyze<domain>()` to the session facade, construct the engine in `createChatSession()`.

4. **Chat command** — add a `/analyze:<domain> <TICKER>` handler in `chat.tsx` that dispatches to the new session method.

5. **Eval fixtures first** — write the JSON fixtures before writing the engine. The Scorer is pure math so fixtures can be calculated by hand. This is the eval-driven sequence: fixture → Scorer test → implementation.

The capabilities layer is **entirely reused**. The domain knowledge (what dimensions matter, how to weight them, what to tell the Analyzer) is in the pack. That's the separation of concerns this architecture buys.

This isn't hypothetical anymore — `packages/domain-packs/market-research/` and
`packages/engines/market-research/src/engine.ts` are exactly this recipe followed a second time.
The one deviation: `MarketResearchEngine` doesn't implement a single `run()` — it exposes `collect()`
and `evaluate()` separately, because this domain needed a human's prediction folded in partway
through. That deviation is covered on its own in `08-human-in-the-loop-pipeline-checkpoint.md`; the
five-step recipe above is otherwise unchanged.

**"Why not just add investing as a new tool in the ReAct loop?"**

Because the steps are known and ordered: you always collect before you analyze, you always score before you explain. Giving the model control over that ordering adds variance without adding value. The engine makes it auditable — if the Scorer returns a low score, you can inspect the findings from step 2 and the metrics from step 3 directly. A ReAct loop that tries to do this would have to be prompted to follow the steps, which is prompt-fragile and unauditable.

---

## See also

- `agent-patterns-in-this-codebase.md` — the two shapes contrasted.
- `packages/engines/investing/src/engine.ts` — the full unbroken pipeline implementation.
- `packages/engines/market-research/src/engine.ts` — the same kernel, split at a human checkpoint.
- `08-human-in-the-loop-pipeline-checkpoint.md` — that split, as its own pattern.
- `09-predict-then-reveal-calibration-loop.md` — what the split's output feeds into over time.
- `packages/capabilities/src/` — each capability as an independently-testable unit.
- `packages/domain-packs/investing/src/`, `packages/domain-packs/market-research/src/` —
  dimensions, scorecards, prompts per domain.
- `test/commands.test.ts` — Scorer accuracy tests via fixture-based eval.
- `study-software-design/06-capability-as-typed-computation-unit.md` — the capability-level design.
