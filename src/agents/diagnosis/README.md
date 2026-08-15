# M4 Diagnosis

## Purpose

M4 interprets M1 context and M2 metrics to identify one primary bottleneck and the next diagnosis decision.

## When It Runs

M4 runs after initial M2 metrics when the engine's evidence gate allows diagnosis.

## Input Contract

M4 receives sanitized `WorkflowRunState` containing prior M1 and M2 outputs. It consumes normalized evidence summaries only.

## Output Contract

M4 returns `DiagnosisOutput` validated by `DiagnosisOutputSchema` in `src/contracts/modules.ts`.

## Dependencies

- M0 policy from `src/agents/core/`.
- Role prompt from `src/agents/diagnosis/prompt.md`.
- Shared runner in `src/agents/runner.ts`.
- Shared contracts in `src/contracts/`.

## Permitted Tools

None directly in Task 6. Domain research must be requested through structured output for a future M3 detour.

## Success, Stop, Pause, And Failure Conditions

- Success: identifies one bottleneck, confidence, notes, and a diagnosis decision.
- Stop: M4 does not stop the workflow directly.
- Pause: `collect_more_data` lets the engine wait for missing data.
- Failure: malformed output or runner failure becomes an application error.

## Related Documents

- `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md`
- `docs/superpowers/plans/2026-08-12-etsy-workflow-engine.md`
- `src/contracts/modules.ts`
