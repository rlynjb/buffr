# M2 Metrics

## Purpose

M2 calculates listing performance metrics and records any qualification needs. Deterministic arithmetic stays in TypeScript.

## When It Runs

M2 runs after M1 for the initial listing snapshot. A later task extends the same module for post-experiment results.

## Input Contract

M2 receives `WorkflowRunState` plus `NormalizedListingEvidence` from `src/contracts/evidence.ts`. The wrapper does not read Etsy credentials or raw endpoint details.

## Output Contract

M2 returns `MetricsOutput` validated by `MetricsOutputSchema` in `src/contracts/modules.ts`.

## Dependencies

- `src/agents/metrics/agent.ts` for deterministic metric calculations.
- `src/agents/metrics/prompt.md` for future metric qualification guidance.
- Shared contracts in `src/contracts/`.

## Permitted Tools

None in Task 6. M2 uses supplied normalized evidence only.

## Success, Stop, Pause, And Failure Conditions

- Success: returns calculated metrics, comparison quality, and unresolved qualification needs.
- Stop: M2 does not stop the workflow.
- Pause: missing metrics are represented as structured output; the deterministic engine decides whether to wait.
- Failure: invalid evidence or malformed output fails validation through shared contracts.

## Related Documents

- `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md`
- `docs/superpowers/plans/2026-08-12-etsy-workflow-engine.md`
- `src/contracts/modules.ts`
