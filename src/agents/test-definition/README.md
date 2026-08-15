# M6 Test Plan

## Purpose

M6 defines the measurement plan for a manual real-world experiment.

## When It Runs

M6 runs after M5 produces a hypothesis and proposed manual intervention.

## Input Contract

M6 receives sanitized `WorkflowRunState` with M1 context, M2 metrics, M4 diagnosis, and M5 hypothesis.

## Output Contract

M6 returns `TestPlanOutput` validated by `TestPlanOutputSchema` in `src/contracts/modules.ts`.

## Dependencies

- M0 policy from `src/agents/core/`.
- Role prompt from `src/agents/test-definition/prompt.md`.
- Shared runner in `src/agents/runner.ts`.
- Shared contracts in `src/contracts/`.

## Permitted Tools

None directly in Task 6. Measurement-rule research is requested through structured output and handled later by M3.

## Success, Stop, Pause, And Failure Conditions

- Success: returns primary metric, baseline, expected signals, monitoring context, and unresolved measurement rules.
- Stop: M6 does not stop the workflow directly.
- Pause: an accepted plan moves the workflow to `experiment_wait` for manual execution.
- Failure: malformed output or runner failure becomes an application error.

## Related Documents

- `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md`
- `docs/superpowers/plans/2026-08-12-etsy-workflow-engine.md`
- `src/contracts/modules.ts`
