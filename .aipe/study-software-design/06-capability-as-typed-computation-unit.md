# 06 — Capability as a Typed Computation Unit

**Subtitle:** Single-responsibility async function with a typed contract, no shared mutable state, composable by explicit wiring — not by inheritance or registry.

---

## Zoom out — where this pattern appears

```
  packages/capabilities/src/
    collector/    Collector.execute(CollectorInput, ctx) → AgentResult<CollectorOutput>
    analyzer/     Analyzer.execute(AnalyzerInput, ctx)   → AgentResult<AnalyzerOutput>
    scorer/       Scorer.execute(ScorerInput, ctx)       → AgentResult<ScorerOutput>
    teacher/      Teacher.execute(TeacherInput, ctx)     → AgentResult<TeacherOutput>
    journal/      Journal.execute(JournalInput, ctx)     → AgentResult<JournalOutput>
```

These five classes are the computation units. They are composed into a pipeline by `InvestingEngine.run()` (`packages/engines/investing/src/engine.ts`), which wires them in sequence. The engine is the composer; the capabilities are the units.

---

## How it works

### The typed contract

Every capability follows the same shape:

```typescript
class SomeCapability {
  execute(input: TInput, ctx: AgentContext): Promise<AgentResult<TOutput>>;
}
```

`AgentContext` carries cross-cutting concerns: `userId`, `workspaceId`, `traceId`, `domain`, `now`, `permissions`. It is passed in, not imported from a global. `AgentResult<T>` wraps `data: T` alongside `confidence`, `evidence`, `warnings`, `assumptions`, `traceId`.

The typed input/output is load-bearing. The engine chains the output of one capability to the input of the next through explicit TypeScript types — if a stage's output changes shape, the next stage's input fails to compile. That compile-time check replaces a class of runtime errors that untyped "chain" approaches suffer.

### No shared mutable state

Each capability instance holds only injected dependencies (e.g., `Analyzer` takes a `ModelProvider` in its constructor). Nothing is written between capabilities through a shared context object or side-channel. The data flows as return values, through the engine's local variables.

This is what makes each capability independently testable: you can `new Scorer()` and call `scorer.execute(knownInput, ctx)` with no reference to what Analyzer produced in any prior run. There is no hidden state to set up.

### Composable by explicit wiring

The five capabilities have no knowledge of each other. `Analyzer` does not call `Scorer`. The composition lives entirely in the engine:

```typescript
const collectorResult = await this.collector.execute(collectorInput, context);
const analyzerResult = await this.analyzer.execute({ evidence: collectorResult.data.evidence, ... }, context);
const scorerResult   = await this.scorer.execute({ findings: analyzerResult.data.findings, ... }, context);
// etc.
```

The pipe is visible in code. To change the order, you change the engine. To add a stage, you add a capability and wire it. Nothing inside a capability knows what wraps it.

---

## The APOSD reading of this pattern

Through Ousterhout's lenses:

**Deep modules.** Each capability presents a narrow interface (`execute`) that hides significant implementation: the Collector hides `Promise.allSettled` fan-in; the Analyzer hides a ReAct tool-calling sub-loop; the Scorer hides weighted scoring math. The caller (the engine) calls `execute` and receives a typed result — it sees nothing of what happened inside.

**Information hiding.** No capability leaks its internal state to another. The Analyzer does not expose "how many model turns it took." The Scorer does not expose its intermediate per-metric weights to the Teacher. The engine only sees the typed output.

**Pull complexity downward.** The engine caller doesn't validate evidence or compute weights — each capability owns those decisions. The Collector decides what constitutes a "failed" optional source. The Scorer decides how to derive confidence from evidenceCount.

---

## Contrast with what this pattern is NOT

**Not a class hierarchy.** There is no `BaseCapability` with default behavior. Each capability is self-contained — if they shared a base class, a change to the base would touch all of them. The common shape (the `execute` signature) is a convention, not an inheritance contract.

**Not a plugin registry.** Capabilities are not registered in a central map and looked up by name. They are constructed by the engine in its constructor and held as private fields. Registration would add indirection without adding any capability.

**Not a message-passing system.** Capabilities don't emit events that other capabilities subscribe to. The data flows synchronously through the engine's `await` chain.

---

## Interview defense

**"Why five separate classes instead of one class with five methods?"**

Separate classes make the boundary explicit. Each capability can be constructed with different configuration (e.g., Analyzer and Teacher share a model provider, but Collector and Scorer take no model). The constructor signature documents the dependencies — a capability that takes a `ModelProvider` is obviously an LLM call; one that doesn't is obviously not. With five methods on one class, every constructor dependency would need to cover all five cases, mixing LLM-dependent and pure-math concerns into one object.

Separate classes also mean the test imports can be surgical: a test for Scorer imports only Scorer, not Analyzer, not Teacher.

**"The five capabilities follow the same interface shape — why not formalize that as a TypeScript interface?"**

They could. The common shape `execute(input, ctx): Promise<AgentResult<T>>` would compile equally well as a generic interface `Capability<TInput, TOutput>`. Not having the interface explicitly doesn't prevent composability — the engine wires them by concrete type. The interface is most valuable when you need to swap an implementation at runtime or write a generic combinator; neither of those exists here yet. When `CachedCapability` (wrapping an existing capability with memoization) becomes real, the interface will earn its place.

---

## See also

- `packages/capabilities/src/` — the five capability implementations.
- `packages/engines/investing/src/engine.ts` — how they're wired.
- `study-system-design/07-capability-pipeline.md` — the pipeline-level view.
- `05-deep-session-facade.md` — the session facade that exposes the engine's results.
