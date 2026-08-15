# M5 Hypothesis

## Purpose

M5 turns the diagnosis into one testable hypothesis and one manual listing intervention.

## When It Runs

M5 runs after M4 decides `proceed_to_hypothesis`.

## Input Contract

M5 receives sanitized `WorkflowRunState` with M1 context, M2 metrics, and M4 diagnosis.

## Output Contract

M5 returns `HypothesisOutput` validated by `HypothesisOutputSchema` in `src/contracts/modules.ts`.

## Dependencies

- M0 policy from `src/agents/core/`.
- Role prompt from `src/agents/hypothesis/prompt.md`.
- Shared runner in `src/agents/runner.ts`.
- Shared contracts in `src/contracts/`.

## Permitted Tools

None directly in Task 6. Research needs are expressed through structured output for the engine-owned M3 route.

## Success, Stop, Pause, And Failure Conditions

- Success: returns one hypothesis, one revision, constants, and expected signal.
- Stop: M5 does not stop the workflow directly.
- Pause: unresolved research needs are routed by the deterministic engine.
- Failure: malformed output or runner failure becomes an application error.

## Related Documents

- `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md`
- `docs/superpowers/plans/2026-08-12-etsy-workflow-engine.md`
- `src/contracts/modules.ts`
