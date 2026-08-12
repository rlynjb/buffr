# Etsy Agent Module Revision Pass — Summary

This revision pass applies the Module Revision Checklist from the Cross-Module Audit Matrix Roadmap V4.

## Revised Modules

### M0 — Core Agent Prompt
**Revised.**

Changes:
- compressed shared reasoning and evidence rules,
- added a short scope boundary,
- retained global policy without performing operational analysis,
- clarified research-before-guessing as a global routing principle.

### M1 — Product Context / Observation
**No revision required in this pass.**

Reason:
- already owns product understanding, evidence organization, provenance classification, and initial missing-information reporting,
- already avoids metric calculation and diagnosis,
- boundary is clean.

### M2 — Metrics & Qualification
**Revised.**

Changes:
- made M2 the explicit owner of all deterministic metric calculation, including completed experiment results,
- reinforced baseline-selection ownership,
- reinforced comparison-period validity ownership,
- reinforced metric-qualification ownership,
- added a limited Domain Research trigger for unresolved qualification rules,
- clarified that a frozen experiment baseline should not be changed after results are observed.

### M3 — Domain Research
**No revision required in this pass.**

Reason:
- already has a single clear responsibility,
- already owns research execution and source evaluation,
- already stops before diagnosis or product recommendations.

### M4 — Classification & Diagnosis
**Revised.**

Changes:
- explicitly consumes M1 provenance and M2 calculated/qualified outputs,
- removed unnecessary re-ownership of upstream evidence classification,
- prevents metric recalculation, baseline reselection, and requalification,
- keeps diagnosis-specific evidence gaps and research triggering local to M4.

### M5 — Hypothesis & Experiment Design
**Revised.**

Changes:
- added a limited research-trigger path,
- keeps research execution in M3,
- makes the conceptual expected signal clearly owned by M5,
- leaves measurement operationalization to M6.

### M6 — Test Definition
**Revised.**

Changes:
- removed baseline-selection ownership,
- now consumes M2's established baseline and comparison-validity decision,
- keeps qualification-requirement application and test-context planning in M6,
- adds a research trigger for unresolved measurement rules,
- prevents recalculation or experiment evaluation.

### M7 — Evaluation & Learning
**Revised.**

Changes:
- removed deterministic metric calculation,
- removed baseline selection and comparison requalification,
- now consumes M2's calculated and qualified experiment evidence,
- consumes M6's frozen measurement plan and context-to-monitor,
- retains outcome classification, hypothesis evaluation, learning, and next-action selection,
- can formulate a research question but does not execute research.

---

## Resulting Ownership Pattern

```text
M0 — global behavior and guardrails
M1 — product context and evidence provenance
M2 — metric calculation, baseline, comparability, qualification
M3 — research execution
M4 — classification and diagnosis
M5 — hypothesis and controlled intervention
M6 — test measurement plan and context to monitor
M7 — outcome evaluation, learning, next action
```

## Next Step

After reviewing and freezing these revised prompts:

1. finalize the dependency map,
2. finalize workflow execution,
3. run the Master-to-Module Coverage Audit,
4. then move into module contracts and schemas.
