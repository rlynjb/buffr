# M3 Research

## Purpose

M3 resolves bounded research questions for eligible workflow modules. It gathers read-only evidence and returns a structured finding to the requester.

## When It Runs

M3 runs only as a conditional side route from the deterministic workflow engine. It is not a linear lifecycle stage and does not choose the next workflow state.

## Input Contract

M3 receives a `ResearchRequest`, configured `ResearchLimits`, accumulated tool evidence, and trace context. Requests and outputs use shared types from `src/contracts/`.

## Output Contract

M3 returns `ResearchOutput` validated by `ResearchOutputSchema` in `src/contracts/modules.ts`. Canonical status values are `resolved`, `partly_resolved`, and `unresolved`; `blocked` is intentionally not valid.

## Dependencies

- M0 policy from `src/agents/core/`.
- Role prompt from `src/agents/research/prompt.md`.
- Shared runner in `src/agents/runner.ts`.
- Shared contracts in `src/contracts/`.
- Engine-owned limits and return-to-requester routing in `src/workflow/`.

## Permitted Tools

Only read-only tools named by `ResearchToolNameSchema` are permitted: Etsy listing details, Etsy transactions, normalized evidence, and hosted web search. Web evidence must include citations with URLs.

## Success, Stop, Pause, And Failure Conditions

- Success: returns a validated research finding with evidence, confidence, and limitations.
- Stop: returns `next_action: stop`, either by model decision or forced by call, time, token, or cost limits.
- Pause: M3 does not pause the workflow; the engine owns waits and resumes.
- Failure: invalid tools, malformed output, invalid citations, or runner failure produce application errors.

## Related Documents

- `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md`
- `docs/superpowers/plans/2026-08-12-etsy-workflow-engine.md`
- `src/contracts/modules.ts`
