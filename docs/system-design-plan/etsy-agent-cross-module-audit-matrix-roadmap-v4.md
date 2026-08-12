# Etsy Agent Cross-Module Audit Matrix Roadmap — V4

This is the updated working roadmap for the Etsy Product Optimization Analyst prompt architecture.

V4 preserves the ownership, dependency, and workflow decisions from V3 and adds the **Module Revision Phase** plus a reusable **Module Revision Checklist**.

The architecture should continue to separate three views:

> **Responsibility ownership, dependency mapping, and workflow execution are different things and should be documented separately.**

- The **ownership matrix** answers: Who owns this responsibility?
- The **dependency map** answers: What information does this module require?
- The **workflow execution diagram** answers: When and under what conditions does this module run?

---

## Legend

- **● Owner** — this module should make the decision or perform the responsibility.
- **○ Consumer** — this module uses an upstream result but should not redefine it.
- **△ Shared principle** — legitimately applies across modules, usually inherited from Core.
- **—** — responsibility does not belong here.
- **Limited Trigger** — this module may detect that research is required, but does not perform the research.
- **? Review** — possible overlap that still needs inspection.

### Module Abbreviations

- **M0** — Core Agent
- **M1** — Product Context / Observation
- **M2** — Metrics & Qualification
- **M3** — Domain Research
- **M4** — Classification & Diagnosis
- **M5** — Hypothesis & Experiment Design
- **M6** — Test Definition
- **M7** — Evaluation & Learning

---

# Phase 1 — Cross-Module Ownership Audit

The ownership audit determines:

1. which module owns each responsibility,
2. where responsibilities are intentionally shared,
3. where accidental duplication exists,
4. where one module leaks into another module's job,
5. what responsibilities should later move to code, schemas, tools, memory, workflow logic, or evals.

---

# Cross-Module Responsibility Matrix

| Responsibility / Concept | M0 Core | M1 Context | M2 Metrics | M3 Research | M4 Diagnosis | M5 Experiment | M6 Test | M7 Evaluation |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Agent persona / overall mission | **●** | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Global evidence-first reasoning | **●** | △ | △ | △ | △ | △ | △ | △ |
| Deterministic vs probabilistic policy | **●** | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Fact-vs-interpretation policy | **● Policy Owner** | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Initial evidence classification / provenance | △ | **● Operational Owner** | ○ | ○ | ○ | ○ | ○ | ○ |
| Product understanding | — | **●** | ○ | ○ | ○ | ○ | ○ | ○ |
| Listing presentation extraction | — | **●** | — | — | ○ | ○ | — | ○ |
| Raw performance evidence organization | — | **●** | ○ | ○ | ○ | — | — | ○ |
| Missing-data identification | △ | **● initial** | ? | ? | ? | — | ? | ? |
| Metric calculation | △ policy | — | **●** | — | ○ | — | ○ | **○** |
| Baseline selection | △ policy | — | **●** | — | ○ | ○ | **○** | **○** |
| Comparison-period validity | — | — | **●** | — | ○ | — | **○** | **○** |
| Metric qualification | — | — | **●** | — | ○ | — | ○ | **○** |
| Sample-size / threshold rules | △ no invention | — | **● identify need** | **● research when asked** | ○ | — | **● apply** | **○ apply** |
| Research trigger | △ policy | — | **Limited Trigger** | — | **● diagnostic trigger** | **Limited Trigger** | **● measurement trigger** | **● possible next-action trigger** |
| Research execution | — | — | — | **●** | ○ | ○ | ○ | ○ |
| Source quality / research credibility | △ | — | — | **●** | ○ | — | ○ | ○ |
| What went well | — | — | ○ | — | **●** | ○ | — | ○ |
| Funnel-path classification | — | — | — | — | **●** | ○ | — | ○ |
| Primary bottleneck | △ one-bottleneck principle | — | — | — | **●** | ○ | — | ○ |
| Competing explanation | — | — | — | — | **●** | ○ | — | ○ |
| Diagnostic confidence | △ | — | △ evidence quality | △ research confidence | **●** | ○ | — | ○ |
| Proceed / Research / Collect More Data decision | — | — | — | — | **●** | ○ | — | — |
| Hypothesis generation | △ evidence-based principle | — | — | — | — | **●** | ○ | ○ |
| Experimental variable selection | △ one-variable principle | — | — | — | — | **●** | ○ | ○ |
| Product revision design | — | — | — | — | — | **●** | ○ | ○ |
| Variables held constant | △ | — | — | — | — | **●** | ○ | ○ |
| Expected performance signal | — | — | — | — | — | **● initial** | **● operationalize** | ○ |
| Primary test metric | — | — | ○ | — | — | ○ | **●** | ○ |
| Secondary test metrics | — | — | ○ | — | — | ○ | **●** | ○ |
| Qualification requirements for experiment | △ | — | ○ | ○ | — | — | **●** | **○ apply** |
| Test duration requirements | — | — | △ unresolved rules | ○ research | — | — | **●** | **○** |
| Context to monitor during test | △ | — | ○ | ○ | ○ | — | **●** | **○** |
| Calculate experiment-result metrics | △ policy | — | **●** | — | — | — | — | **○** |
| WIN / LOSS / INCONCLUSIVE | △ uncertainty principle | — | — | — | — | — | — | **●** |
| Hypothesis supported / not supported | — | — | — | — | — | — | — | **●** |
| Experiment contextual interpretation | △ | — | — | ○ | — | — | ○ | **●** |
| Capture reusable learning | — | ○ historical input | — | — | ○ historical use | ○ | — | **●** |
| Learning confidence | △ | — | — | △ | — | — | — | **●** |
| KEEP / REVERT / ITERATE / NEW TEST / RESEARCH / WAIT | △ one-action principle | — | — | — | — | — | — | **●** |
| Select next highest-value action | **△ principle** | — | — | — | — | — | — | **●** |
| Start next optimization cycle | — | — | — | — | — | — | — | **— intentionally** |

---

# Confirmed Architectural Decisions

## 1. Deterministic Metric Calculation Lives in M2

M2 is the prompt-level owner of deterministic metric calculation.

This includes:

- core metric calculations,
- experiment-result metric calculations,
- absolute changes,
- percentage changes,
- validated metric transformations.

M7 consumes calculated and qualified results rather than independently recalculating them.

Long-term direction:

```text
Raw data
   ↓
Deterministic calculation layer
   ↓
Validated metrics
   ↓
M2 qualification
   ↓
M7 interpretation
```

---

## 2. Baseline Selection Lives in M2

M2 selects and validates the baseline.

M6 references the established baseline while defining the test.

M7 consumes the same baseline during evaluation.

```text
M2
Select + validate baseline
        ↓
M6
Reference baseline for test definition
        ↓
M7
Use frozen baseline for evaluation
```

---

## 3. Comparison-Period Validity Lives in M2

M2 owns the decision about whether a comparison period is appropriate and sufficiently comparable.

M6 and M7 consume that judgment.

---

## 4. Metric Qualification Lives in M2

M2 owns metric qualification:

- IMPROVED
- DECLINED
- STABLE
- INCONCLUSIVE
- NOT AVAILABLE

M7 consumes qualified metrics rather than re-qualifying the same evidence.

---

## 5. Research Trigger and Research Execution Are Different

A **research trigger** means a module detects that it cannot reliably continue without additional domain knowledge.

Research **execution** means performing the research, evaluating sources, and returning a structured finding.

Only M3 owns research execution.

M2 and M5 may act as limited trigger points.

M4, M6, and M7 may also trigger research when their local responsibility encounters a genuine knowledge gap.

```text
Calling module
        ↓
specific research need
        ↓
M3 — Domain Research
        ↓
structured finding
        ↓
return to calling module
```

---

## 6. Context to Monitor During a Test Lives in M6

M6 owns defining which contextual factors should be monitored during an experiment.

M7 consumes that predefined context and evaluates what actually happened.

Planning belongs in M6.

Evaluation belongs in M7.

---

# Important Architecture Note — Ownership Is Not Dependency

Do **not** infer dependency simply from the ownership matrix.

For example:

- M2 owns metric qualification.
- M4 consumes qualified metrics.
- M3 owns domain research.

This does **not** mean the workflow must be:

```text
M2 → M3 → M4
```

M3 is conditional.

A more accurate relationship is:

```text
M1 → M2 → M4
          ↘
           M3 when a knowledge gap requires research
          ↗
```

Dependency is about required information, not simple sequence.

---

# Separate Artifact 1 — Dependency Map

The dependency map should be created separately from the ownership matrix.

Its job is to answer:

> **What inputs must a module receive in order to perform its responsibility?**

For every module, classify dependencies as:

- **MANDATORY**
- **CONDITIONAL**
- **OPTIONAL / ENRICHING**
- **NOT A DEPENDENCY**

## Initial Dependency Sketch

```text
M0 — Core
Shared behavior / policy context
        ↓
        all runtime modules

M1 — Product Context / Observation
        ↓
M2 — Metrics & Qualification
        ↓
M4 — Classification & Diagnosis
        ↓
M5 — Hypothesis & Experiment Design
        ↓
M6 — Test Definition
        ↓
M7 — Evaluation & Learning
```

### Conditional Domain Research

```text
M2 ── research needed? ──→ M3 ──→ return to M2
M4 ── research needed? ──→ M3 ──→ return to M4
M5 ── research needed? ──→ M3 ──→ return to M5
M6 ── research needed? ──→ M3 ──→ return to M6
M7 ── research needed? ──→ M3 ──→ return to M7
```

---

# Separate Artifact 2 — Workflow Execution Diagram

The workflow execution diagram answers:

> **When does each module run, branch, stop, wait, or call another module?**

Initial execution model:

```text
START
  ↓
M1 — Product Context / Observation
  ↓
M2 — Metrics & Qualification
  ↓
Enough evidence to continue?
  ├── NO → collect missing data / resolve qualification need / stop
  └── YES
        ↓
M4 — Classification & Diagnosis
        ↓
Decision?
  ├── RESEARCH DOMAIN KNOWLEDGE
  │       ↓
  │      M3 — Domain Research
  │       ↓
  │      return to M4
  │
  ├── COLLECT MORE DATA
  │       ↓
  │      STOP / WAIT
  │
  └── PROCEED TO HYPOTHESIS
          ↓
        M5 — Hypothesis & Experiment Design
          ↓
        M6 — Test Definition
          ↓
        EXPERIMENT RUNS
          ↓
        WAIT FOR RESULTS
          ↓
        M2 / deterministic calculation layer
          ↓
        qualified experiment metrics
          ↓
        M7 — Evaluation & Learning
          ↓
        NEXT ACTION
          ↓
        STOP CURRENT CYCLE
```

---

# Phase 2 — Module Revision

After the cross-module ownership decisions are stable, revise the runtime prompts so they match the architecture.

Do **not** redesign responsibilities while editing a module.

Use the ownership matrix as the source of truth for prompt revision.

The goal is to make every prompt:

- focused,
- non-duplicative,
- dependency-aware,
- consistent with upstream ownership,
- explicit enough for reliable behavior,
- but not overloaded with architecture documentation.

---

# Module Revision Checklist

Use this same checklist for **every module**.

## A. Responsibility Check

Ask:

> Does this module perform only the responsibilities it owns?

For each instruction:

- keep it if the module owns the behavior,
- remove or move it if another module owns it,
- retain a short consumer instruction when the module only uses an upstream result.

---

## B. Consumer Check

Ask:

> Is this module consuming upstream outputs instead of recreating them?

Examples:

- M6 should consume M2's baseline.
- M7 should consume M2's calculated and qualified metrics.
- M5 should consume M4's diagnosis.
- M4 should consume M1 product context and M2 qualified evidence.

A consumer should not routinely recompute, redefine, or relitigate upstream decisions.

---

## C. Global-Principle Check

Ask:

> Is this instruction already owned by M0 Core?

If yes, downstream modules should usually contain only the minimum local application necessary.

Example:

Core owns:

> Distinguish evidence from interpretation.

M4 may only need:

> Ground the diagnosis in qualified evidence.

Avoid reproducing the entire Core policy in every module.

---

## D. Deterministic-vs-Probabilistic Check

Ask:

> Is this responsibility exact enough that it belongs in deterministic logic?

Candidates include:

- formulas,
- arithmetic,
- baseline transformations,
- enum validation,
- required-field checks,
- hard thresholds once defined.

For now, keep what the prompt needs to remain functional, but mark deterministic responsibilities for later migration to code or validation.

---

## E. Research Check

Ask:

> Does this module need to perform research, or only trigger it?

Only M3 should execute research.

Other modules may:

1. detect a knowledge gap,
2. formulate a specific research need,
3. receive the M3 finding,
4. continue their original responsibility.

---

## F. Boundary Check

Ask:

> Does the module stop at the correct point?

Prefer a short runtime boundary such as:

> Stop after defining how the experiment will be measured. Do not evaluate the experiment.

Avoid long architectural “does not own” lists inside runtime prompts.

Detailed ownership belongs in architecture documentation.

---

## G. Output Check

Ask:

> Does the module output only what downstream consumers actually need?

Remove:

- duplicated upstream data unless needed for traceability,
- fields another module should calculate,
- outputs that imply responsibilities outside the module boundary.

Keep enough context for a reliable handoff.

---

## H. Missing-Data Check

Ask:

> Is the module identifying only the type of missing information relevant to its own stage?

Examples:

```text
M1:
What raw product or performance evidence is missing?

M2:
What data or rule is missing to calculate or qualify performance?

M4:
What evidence is missing to support a diagnosis?

M6:
What evidence will the experiment need?

M7:
Were those predefined requirements satisfied?
```

Do not turn “missing data” into one generic responsibility owned everywhere.

---

## I. Duplication Check

Ask:

> Does this instruction already exist upstream or in another module?

Classify it as one of:

```text
KEEP IN MODULE
MOVE TO CORE
MOVE TO ANOTHER MODULE
MOVE TO CODE LATER
MOVE TO SCHEMA / VALIDATION LATER
MOVE TO TOOL POLICY LATER
MOVE TO WORKFLOW / ORCHESTRATION LATER
MOVE TO MEMORY LATER
MOVE TO EVALS LATER
KEEP AS ARCHITECTURE DOCUMENTATION
REMOVE AS DUPLICATION
```

---

## J. Prompt Compression Check

After ownership is correct, ask:

> Can this instruction be expressed more simply without losing behavioral reliability?

Prefer concise runtime prompts over repeating architecture commentary.

The goal is not minimalism for its own sake.

The goal is:

> **The smallest prompt that reliably performs the module's responsibility.**

---

# Module Revision Order

Revise one module at a time.

```text
[ ] M0 — Core Agent Prompt
[ ] M1 — Product Context / Observation
[ ] M2 — Metrics & Qualification
[ ] M3 — Domain Research
[ ] M4 — Classification & Diagnosis
[ ] M5 — Hypothesis & Experiment Design
[ ] M6 — Test Definition
[ ] M7 — Evaluation & Learning
```

For each module:

```text
1. Compare current prompt against ownership matrix.
2. Apply Module Revision Checklist.
3. Identify changes.
4. Produce revised prompt.
5. Review revised prompt.
6. Freeze that module version.
7. Move to the next module.
```

---

# Recommended First Revision — M0 Core

M0 should be reviewed first because every downstream module inherits its shared behavioral rules.

Focus the M0 revision on:

- agent identity,
- overall objective,
- evidence-first reasoning,
- deterministic vs probabilistic policy,
- global fact-vs-interpretation policy,
- uncertainty principles,
- one-bottleneck / one-action principles,
- global research-before-guessing behavior,
- global guardrails.

Check M0 for instructions that actually belong to operational modules.

Examples of responsibilities that should **not** be performed by M0:

- product understanding,
- metric calculation,
- baseline selection,
- research execution,
- funnel classification,
- diagnosis,
- experiment design,
- test definition,
- experiment evaluation.

M0 can define principles governing those activities without performing them.

---

# After Module Revision

Once all eight prompts are revised and frozen:

```text
Revised modular prompts
        ↓
Dependency Map
        ↓
Workflow Execution Diagram
        ↓
Master-to-Module Coverage Audit
        ↓
Module Contracts
        ↓
Schemas / Validation
        ↓
Deterministic Code
        ↓
Tools / Memory
        ↓
Evals
```

The exact order may be adjusted as architecture becomes clearer, but prompt ownership should remain stable.

---

# Phase 2 Goal

At the end of the Module Revision Phase:

- each module should perform only its owned responsibility,
- consumers should rely on upstream outputs,
- global principles should live primarily in Core,
- research execution should live in M3,
- deterministic metric responsibilities should be centralized in M2 and later migrated to code,
- runtime boundaries should be short and clear,
- prompt duplication should be substantially reduced.

Only after the modules reflect the agreed architecture should dependency and workflow artifacts be finalized.

---

# Working Checklist

## Ownership Audit

```text
[x] Initial cross-module ownership review
[x] Deterministic metric ownership → M2
[x] Baseline selection → M2
[x] Comparison-period validity → M2
[x] Metric qualification → M2
[x] Research trigger vs execution distinction
[x] Test-context planning → M6
```

## Module Revision

```text
[ ] Revise M0
[ ] Revise M1
[ ] Revise M2
[ ] Revise M3
[ ] Revise M4
[ ] Revise M5
[ ] Revise M6
[ ] Revise M7
```

## Architecture Follow-Up

```text
[ ] Finalize dependency map
[ ] Mark mandatory / conditional / optional dependencies
[ ] Finalize workflow execution diagram
[ ] Identify branch conditions
[ ] Identify stop / wait conditions
[ ] Identify M3 return paths
[ ] Run final duplication check
[ ] Run final boundary-leakage check
[ ] Run missing-responsibility check
[ ] Run Master-to-Module Coverage Audit
```
