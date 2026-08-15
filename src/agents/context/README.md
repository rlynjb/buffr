# M1 Context

## Purpose

M1 organizes the product context, available evidence, missing information, and neutral notes before metrics or diagnosis run.

## When It Runs

M1 is the first workflow module after a run starts at `m1_context`. The deterministic workflow engine advances to M2 only after M1 returns valid structured output.

## Input Contract

M1 receives sanitized `WorkflowRunState` context from `src/contracts/workflow.ts`. Raw credentials, token fields, and endpoint details must not appear in module input.

## Output Contract

M1 returns `ContextOutput` validated by `ContextOutputSchema` in `src/contracts/modules.ts`.

## Dependencies

- `src/agents/core/policy.md` for shared M0 policy.
- `src/agents/context/prompt.md` for role-specific instructions.
- `src/agents/runner.ts` for structured output execution.
- Shared contracts in `src/contracts/`.

## Permitted Tools

None directly. M1 may only organize supplied normalized evidence and user-provided context.

## Success, Stop, Pause, And Failure Conditions

- Success: returns product context, available evidence, missing information, and notes without diagnosis or recommendations.
- Stop: M1 does not decide workflow stop states.
- Pause: M1 may identify missing information, but the engine owns pause decisions.
- Failure: malformed output or runner failure becomes an application error through the shared runner path.

## Related Documents

- `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md`
- `docs/superpowers/plans/2026-08-12-etsy-workflow-engine.md`
- `src/contracts/modules.ts`
