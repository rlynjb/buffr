# Buffr Review and Study TODO

Use this checklist before adding another subsystem or expanding the current
architecture. The goal is to be able to explain Buffr's behavior, boundaries,
and failure modes from its contracts and artifacts—not only from its source
code.

## Trace one complete workflow

- [ ] Trace the canonical M3 smoke run from curated context to its final
  `waiting_for_data` state:
  [`2026-09-04-m3-live-smoke-3`](artifacts/merchgrid/metrics/workflow-runs/2026-09-04-m3-live-smoke-3/).
- [ ] Follow this sequence: normalized evidence → M1/M2/M4/M5/M6 → M3 request
  → hosted search → citations → M3 return → research cap → wait state.
- [ ] Compare `run.json`, `events.jsonl`, `evidence/initial.json`, and
  `experiment-plan.json`. Explain what each file contributes and which file is
  authoritative.
- [ ] Confirm how M3 citation URLs become `metadata.researchRefs` in the
  experiment plan without copying raw web pages or provider payloads.

## Review through the DDIA and FODE lenses

For every persisted file or data product, answer:

- [ ] What is the source of record?
- [ ] What is derived data, and can it be rebuilt from its inputs?
- [ ] What happens when a source is unavailable, malformed, delayed, or only
  partly complete?
- [ ] Is retrying the operation idempotent?
- [ ] What ordering, consistency, or concurrency assumptions does it make?
- [ ] How are freshness, completed-UTC windows, and experiment delays
  represented?
- [ ] What lineage connects source data, normalized evidence, a recommendation,
  and the later learning record?
- [ ] Which data is intentionally excluded for privacy, security, or product
  scope?

## Review the rolling marketplace cycle

- [ ] Run through the one-command lifecycle mentally: what does
  `marketplace:next-review` close, and what separate run does it create?
- [ ] Explain why `profile + productRef` is the history identity, why
  `productRef` must be owner-defined and stable, and why legacy runs without it
  are not inferred into the rolling history.
- [ ] Identify the prerequisite weekly evidence: which two adjacent seven-day
  periods must already exist in local snapshots, and what happens when the
  weekly artifact or the prior M6 primary metric is unavailable?
- [ ] Explain why the applied/not-applied question has no default, why an
  applied answer needs a UTC date, and which mutations are forbidden before
  that answer and result window have been validated.
- [ ] Trace one fresh weekly artifact in both roles: prior
  `evidenceSnapshots.result` and next `evidenceSnapshots.initial`. Confirm both
  retain the same `artifactRef` without merging the two `run.json` records.
- [ ] Follow an applied prior run through M2 Results and M7. Which exact fields
  enter the next run through `previousRunRef` and `priorLearning`, and which
  historical events, prompts, and provider data stay excluded?
- [ ] Follow a not-applied prior run. Confirm it stops without fabricated M2
  Results or M7 learning before the next experiment run begins.
- [ ] Retry the same `profile + productRef + through` cycle. Confirm the
  deterministic run id prevents duplicate owner prompts, events, artifact
  projections, model calls, and run directories.
- [ ] State the external-action boundary precisely: Buffr records the owner's
  answer and proposes the next plan; the owner alone edits the marketplace.

## Review through the agentic-AI lens

At each M1-M7 boundary, answer:

- [ ] Which behavior is deterministic, and which behavior is model
  interpretation?
- [ ] What exact input contract does the module receive?
- [ ] What structured output schema must it satisfy?
- [ ] Which tools, if any, can it access, and who grants that access?
- [ ] How does Buffr verify that external evidence is grounded in tool output?
- [ ] What prevents unbounded tool calls, repeated research, excessive cost, or
  indefinite loops?
- [ ] What happens when output is malformed, evidence is insufficient, or a
  provider fails?
- [ ] Which decisions remain behind the human approval gate?

## Understand the smoke-test history

- [ ] Treat
  [`2026-09-04-m3-live-smoke-3`](artifacts/merchgrid/metrics/workflow-runs/2026-09-04-m3-live-smoke-3/)
  as the canonical bounded live smoke. It persisted one M3 result and stopped
  safely at M6 with `waiting_for_data`.
- [ ] Review
  [`2026-09-04-m3-live-smoke`](artifacts/merchgrid/metrics/workflow-runs/2026-09-04-m3-live-smoke/)
  as an interrupted debugging artifact. It stopped in `m3_research` after a
  repeated request exposed the missing workflow-level cap.
- [ ] Review
  [`2026-09-04-m3-live-smoke-2`](artifacts/merchgrid/metrics/workflow-runs/2026-09-04-m3-live-smoke-2/)
  as the next debugging artifact. It returned four M3 results before the smoke
  process was stopped while the outer-cap behavior was being corrected.
- [ ] Decide later whether these notes should become a permanent
  `README.md` beside the smoke artifacts. Do not treat the two interrupted runs
  as passing acceptance evidence.

## Review completion test

- [ ] Explain one successful workflow path without opening implementation
  internals.
- [ ] Explain one failure path and identify the boundary that contains it.
- [ ] Explain how an interrupted run can be inspected or resumed from durable
  state.
- [ ] Identify the source of truth, derived projections, feedback delay, and
  human decision point in one M3-assisted experiment.
- [ ] Record concrete architecture questions discovered during the review
  before proposing another implementation change.
