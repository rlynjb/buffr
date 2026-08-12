# Etsy Agent Post-Extraction Audit Roadmap

This roadmap begins **after the Master V6 prompt has been extracted into prompt modules**.

Its purpose is to verify that the modular split is clean, complete, and ready for later system-design work such as schemas, module contracts, orchestration, code, tools, and evaluations.

---

## Current Position

```text
Master V6
   ↓
Prompt-module extraction
   ↓
[✓] Core Agent Prompt
[✓] Product Context / Observation
[✓] Metrics & Qualification
[✓] Domain Research
[✓] Classification & Diagnosis
[✓] Hypothesis & Experiment Design
[✓] Test Definition
[✓] Evaluation & Learning
   ↓
POST-EXTRACTION AUDIT
   ↓
Next architecture phase
```

---

# Phase 1 — Cross-Module Audit

This is the immediate next step.

Review all prompt modules together:

1. Core Agent Prompt
2. Product Context / Observation
3. Metrics & Qualification
4. Domain Research
5. Classification & Diagnosis
6. Hypothesis & Experiment Design
7. Test Definition
8. Evaluation & Learning

The audit checks three primary areas.

## 1. Duplication Audit

Ask:

> Are the same instructions unnecessarily repeated across multiple modules?

Common concepts to inspect include:

- evidence handling
- assumptions versus facts
- uncertainty
- deterministic versus probabilistic reasoning
- invented thresholds
- baseline rules
- research behavior
- confidence
- contextual factors
- causal claims
- module boundaries

For each repeated rule, determine whether it should:

- remain local because the module genuinely needs it,
- move to the Core Prompt,
- remain in architecture documentation only,
- move later to code, schemas, or validation,
- or be removed as unnecessary duplication.

The goal is not simply shorter prompts.

The goal is:

> **One clear owner for every important responsibility whenever possible.**

---

## 2. Boundary-Leakage Audit

Ask:

> Is any module performing work that another module is supposed to own?

Examples:

- Product Context diagnosing performance
- Metrics & Qualification proposing causes
- Diagnosis designing experiments
- Experiment Design defining statistical qualification rules
- Test Definition evaluating actual results
- Evaluation reopening the original diagnosis without justification

For each issue, either:

- move the instruction to the correct module,
- compress the boundary instruction,
- or explicitly document intentional shared responsibility.

---

## 3. Missing-Responsibility Audit

Ask:

> Did anything important disappear while Master V6 was being split?

Check whether every important behavior from the master specification still has an owner.

Examples include:

- product understanding
- evidence organization
- metric qualification
- baseline selection
- research-before-guessing behavior
- performance-path classification
- competing explanations
- confidence
- controlled experimentation
- expected signals
- qualification requirements
- WIN / LOSS / INCONCLUSIVE
- hypothesis evaluation
- learning capture
- next-action selection

Do not assume that an instruction survived simply because a similar concept exists somewhere else.

---

# Phase 2 — Master-to-Module Coverage Audit

After the cross-module audit, compare the modular prompt system directly against **Master Specification V6**.

For each meaningful Master V6 instruction, assign one destination:

```text
CORE PROMPT
PRODUCT CONTEXT / OBSERVATION
METRICS & QUALIFICATION
DOMAIN RESEARCH
CLASSIFICATION & DIAGNOSIS
HYPOTHESIS & EXPERIMENT DESIGN
TEST DEFINITION
EVALUATION & LEARNING
CODE LATER
SCHEMA / VALIDATION LATER
TOOL POLICY LATER
MEMORY LATER
EVAL LATER
ARCHITECTURE DOCUMENTATION
REMOVED AS DUPLICATION
```

This creates traceability between the original source of truth and the modular architecture.

The coverage audit should verify:

- no critical behavior was accidentally deleted,
- every responsibility has an owner,
- duplicated ownership is intentional when it exists,
- architecture documentation is not accidentally treated as runtime prompt content,
- deterministic work is identified for later code migration,
- structured outputs are identified for later schema design.

---

# Phase 3 — Prompt Compression and Refinement

Once ownership is verified, refine each runtime prompt.

For every module ask:

### Does the model actually need this instruction at runtime?

If not, move it to the appropriate system layer.

Potential destinations include:

- architecture documentation,
- schemas,
- validation,
- deterministic code,
- tool policy,
- workflow orchestration,
- memory,
- evaluations.

Also review:

- repeated global guardrails,
- long negative instruction lists,
- redundant examples,
- architecture commentary inside runtime prompts,
- unnecessary formulas that will eventually be deterministic code.

The objective is:

> **Keep enough instruction to produce reliable reasoning without rebuilding the giant master prompt across multiple files.**

---

# Phase 4 — Finalize the Modular Prompt Architecture

At the end of prompt refinement, each module should have:

- one clear responsibility,
- a short scope boundary,
- the minimum shared context it needs,
- explicit reasoning mode where useful,
- focused task instructions,
- a defined output concept,
- no unnecessary ownership overlap.

The master specification remains the architectural source of truth.

The modular prompts become the focused reasoning components.

---

# Phase 5 — Define Module Contracts

After the prompt architecture is stable, begin the non-prompt system design.

For each module define:

### Inputs

What information must the module receive?

### Outputs

What information must it return?

### Preconditions

What must already be true before the module runs?

### Guarantees

What can downstream components safely assume about its output?

### Failure / Insufficient-Data Conditions

What happens when the module cannot complete its responsibility reliably?

This becomes the basis for schemas and dependency tracking.

---

# Phase 6 — Design Schemas and Validation

Convert module inputs and outputs into explicit machine-readable contracts.

Examples may include:

```text
DiagnosisResult
- selectedPath
- primaryBottleneck
- evidence
- competingExplanation
- confidence
- decision
```

Schema validation should detect:

- missing required fields,
- invalid enum values,
- malformed data,
- incompatible module outputs,
- broken module interfaces.

Think:

> **Schema validation asks: Is the data structurally valid?**

---

# Phase 7 — Build the Dependency Map

Document which module outputs are consumed by which downstream modules.

Example:

```text
Product Context / Observation
          ↓
Metrics & Qualification
          ↓
Classification & Diagnosis
          ↓
Hypothesis & Experiment Design
          ↓
Test Definition
          ↓
Evaluation & Learning
```

Domain Research may be called conditionally from modules that encounter an important unresolved knowledge gap.

The dependency map helps answer:

> If I change this module's output, what else must I review?

---

# Phase 8 — Design Workflow / Orchestration

Define the actual execution logic.

Examples:

```text
Observe
  ↓
Qualify Metrics
  ↓
Enough evidence?
  ├── No → collect more data / research
  └── Yes
        ↓
      Diagnose
        ↓
Decision?
  ├── Research → Domain Research
  ├── Collect More Data → stop / wait
  └── Proceed
        ↓
      Hypothesis
        ↓
      Experiment
        ↓
      Test Definition
        ↓
      Wait for results
        ↓
      Evaluation
```

Workflow orchestration should eventually control branching, retries, stopping conditions, and module execution order rather than relying on one giant prompt.

---

# Phase 9 — Move Deterministic Responsibilities to Code

Review every module for operations that should not depend on LLM judgment.

Likely candidates include:

- conversion-rate calculations,
- CTR calculations,
- ROAS calculations,
- percentage changes,
- hard thresholds,
- enum validation,
- required-field checks,
- deterministic transformations.

Desired architecture:

```text
Raw Data
   ↓
Deterministic Code
   ↓
Validated Evidence
   ↓
LLM Interpretation
```

---

# Phase 10 — Connect Tools and Memory

## Tools

Provide external or dynamic information such as:

- Etsy data,
- marketplace research,
- current Etsy documentation,
- keyword and competition information,
- statistical references.

## Memory

Store validated historical evidence such as:

- previous experiments,
- product history,
- confirmed learnings,
- historical baselines.

Tools provide information.

Memory preserves accumulated learning.

---

# Phase 11 — Build Evaluations

Create tests for both individual modules and the end-to-end workflow.

Examples:

### Module Eval

```text
Input:
High impressions
Declining CTR
Healthy conversion after click

Expected Path:
CLICK-THROUGH
```

### Boundary Eval

Verify that Product Context does not recommend experiments.

### Uncertainty Eval

Verify that weak evidence produces INSUFFICIENT DATA or INCONCLUSIVE rather than a forced conclusion.

### Regression Eval

After changing a prompt, schema, tool, or module contract, rerun known cases and compare behavior.

Think:

> **Evals ask: Is the system behaving correctly?**

---

# Recommended Order From Here

```text
[✓] Extract prompt modules

[ ] 1. Cross-module duplication audit
[ ] 2. Boundary-leakage audit
[ ] 3. Missing-responsibility audit
[ ] 4. Master-to-module coverage audit
[ ] 5. Prompt compression / refinement
[ ] 6. Finalize modular prompt architecture

THEN:

[ ] 7. Module contracts
[ ] 8. Schemas and validation
[ ] 9. Dependency map
[ ] 10. Workflow / orchestration
[ ] 11. Deterministic code
[ ] 12. Tools
[ ] 13. Memory
[ ] 14. Evaluations
[ ] 15. End-to-end regression testing
```

---

# Key Principle

The current task is **not** to start coding immediately.

First make sure the reasoning architecture survived the split.

The sequence is:

**Extract → Audit → Refine → Define Contracts → Enforce Structure → Orchestrate → Implement → Evaluate**

This prevents the implementation from hardening accidental prompt-design mistakes into the production system.
