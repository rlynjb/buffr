# Etsy Prompt Modules — Contract Revision Manifest

This revision adds the lean module contract fields agreed for dependency mapping:

- **Inputs**
- **Outputs**
- **Dependencies**

No separate Purpose, Preconditions, Postconditions, API schema, or implementation-language contract was added.

## Latest Module Versions

| Module | Latest file |
|---|---|
| M0 — Core Agent | `etsy-core-agent-prompt-v3.md` |
| M1 — Product Context / Observation | `product-context-observation-module-v2.md` |
| M2 — Metrics & Qualification | `metrics-qualification-module-v3.md` |
| M3 — Domain Research | `domain-research-module-v2.md` |
| M4 — Classification & Diagnosis | `classification-diagnosis-module-v3.md` |
| M5 — Hypothesis & Experiment Design | `hypothesis-experiment-design-module-v3.md` |
| M6 — Test Definition | `test-definition-module-v3.md` |
| M7 — Evaluation & Learning | `evaluation-learning-module-v3.md` |

## Next Step

Use these contracts to build the dependency map.

The dependency map should distinguish:

- required dependencies,
- conditional / callable dependencies,
- lifecycle-specific dependencies such as M2 consuming M6 only when M2 is re-run after an experiment.
