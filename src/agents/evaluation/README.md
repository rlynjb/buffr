# M7 Evaluation

## Purpose

M7 evaluates the completed manual experiment, captures learning, and chooses one next action.

## When It Runs

M7 runs after post-experiment M2 metrics are available and the deterministic engine advances to `m7_learning`.

## Input Contract

M7 receives sanitized `WorkflowRunState` containing the M5 hypothesis, frozen M6 test plan, and M2 result metrics.

## Output Contract

M7 returns `EvaluationOutput` validated by `EvaluationOutputSchema` in `src/contracts/modules.ts`.

## Dependencies

- M0 policy from `src/agents/core/`.
- Role prompt from `src/agents/evaluation/prompt.md`.
- Shared runner in `src/agents/runner.ts`.
- Shared contracts in `src/contracts/`.

## Permitted Tools

None directly in Task 8. If follow-up research is needed, M7 expresses that through structured output and the engine routes M3.

## Success, Stop, Pause, And Failure Conditions

- Success: classifies the outcome, evaluates the hypothesis, records evidence and learning, and chooses one next action.
- Stop: M7 completes the cycle through the engine; it does not start a new cycle.
- Pause: M7 may choose `wait`, but the engine owns the resulting lifecycle state.
- Failure: malformed output or runner failure becomes an application error.

## Related Documents

- `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md`
- `docs/superpowers/plans/2026-08-12-etsy-workflow-engine.md`
- `src/contracts/modules.ts`
