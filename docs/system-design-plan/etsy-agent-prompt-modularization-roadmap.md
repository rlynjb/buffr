# Etsy Agent Prompt-Modularization Roadmap

This roadmap tracks the planned extraction of the Etsy Product Optimization Analyst **Master Specification V6** into smaller prompt modules.

The modules below are **prompt modules, not separate agents**.

---

## Overall Architecture

```text
                    MASTER SPECIFICATION V6
                       Source of Truth
                              │
                              ↓
                    0. CORE AGENT PROMPT
                              │
                              ↓
              1. PRODUCT CONTEXT / OBSERVATION
                              │
                              ↓
                2. METRICS & QUALIFICATION
                              │
                     ┌────────┴────────┐
                     │                 │
                     ↓                 │
               3. DOMAIN RESEARCH     │
                     │                 │
                     └────────┬────────┘
                              ↓
             4. CLASSIFICATION & DIAGNOSIS
                              │
                              ↓
           5. HYPOTHESIS & EXPERIMENT DESIGN
                              │
                              ↓
                   6. TEST DEFINITION
                              │
                              ↓
              7. EVALUATION & LEARNING
```

---

## Module Roadmap

| # | Prompt module | Single responsibility | Master V6 source | Status |
|---|---|---|---|---|
| **0** | **Core Agent Prompt** | Define identity, overall objective, universal reasoning rules, uncertainty principles, and shared guardrails | Persona, Objective, Execution Policy, global Guardrails | 🟢 Boundary defined / first draft extracted |
| **1** | **Product Context & Observation** | Understand the product and organize available evidence without diagnosing it | Steps 1–2 | 🟡 Next |
| **2** | **Metrics & Qualification** | Determine what validated metrics mean relative to appropriate baselines | Steps 3–4 | ⬜ Pending |
| **3** | **Domain Research** | Resolve missing or uncertain Etsy, marketplace, analytics, or statistical knowledge | Step 5 | ⬜ Pending |
| **4** | **Classification & Diagnosis** | Determine the primary funnel path and strongest supported bottleneck | Steps 6–8 | ⬜ Pending |
| **5** | **Hypothesis & Experiment Design** | Turn the diagnosis into one testable hypothesis and controlled change | Steps 9–10 | ⬜ Pending |
| **6** | **Test Definition** | Define what will be measured and what evidence will determine the experiment result | Step 11 | ⬜ Pending |
| **7** | **Evaluation & Learning** | Evaluate results, capture reusable learning, and choose the next action | Steps 12–14 | ⬜ Pending |

---

## Few-Shot Example Migration

The centralized examples in the master prompt will not become a separate giant prompt module.

They will be redistributed according to what they teach:

```text
Current centralized examples
          │
          ├── diagnosis example
          │       → Module 4
          │
          ├── experiment example
          │       → Module 5
          │
          └── WIN / LOSS / INCONCLUSIVE
                  → Module 7
```

Only keep examples where they genuinely improve model behavior.

---

## Required Output Format Migration

The master prompt's large required-output section should not simply be copied into every module.

Each module will eventually define only the output it owns.

Example:

```text
Module 1
Product Context / Observation
        ↓
product summary
observed evidence
missing information


Module 4
Classification & Diagnosis
        ↓
selected path
primary bottleneck
evidence
competing explanation
confidence
decision


Module 7
Evaluation & Learning
        ↓
outcome
hypothesis status
learning
next action
```

Later, these outputs can become formal **schemas and module contracts**.

---

## Classification Used During Extraction

As the master prompt is decomposed, each meaningful instruction should be labeled as one of:

```text
KEEP IN PROMPT
MOVE TO ANOTHER PROMPT
MOVE TO CODE LATER
MOVE TO SCHEMA LATER
MOVE TO TOOL POLICY LATER
MOVE TO EVALS LATER
KEEP AS ARCHITECTURE DOCUMENTATION
REMOVE AS DUPLICATION
```

The goal is not to split one huge prompt into several smaller huge prompts.

The goal is to **decompose responsibility** and place each responsibility in the most reliable layer.

---

## Extraction Process for Every Module

Repeat the following process for each prompt module.

### 1. Define the Single Responsibility

Ask:

> What is this module uniquely responsible for?

### 2. Define the Boundary

Specify:

- what belongs in this module,
- what explicitly belongs elsewhere,
- what the module should not do.

### 3. Extract Relevant V6 Instructions

Bring over only the parts of the master prompt needed to support that responsibility.

### 4. Consolidate

Remove:

- duplicated global rules,
- instructions already inherited from Core,
- unnecessary repetition,
- material better suited for code, tools, schemas, or evals.

### 5. Produce and Review the Module Prompt

Generate the module prompt and review it before moving to the next module.

---

## Current Progress

```text
[✓] Master V6 frozen as reference

[✓] Module 0 — Core boundary defined
[✓] Module 0 — Core first draft extracted
[ ] Module 0 — Final review

[ ] Module 1 — Product Context / Observation
[ ] Module 2 — Metrics & Qualification
[ ] Module 3 — Domain Research
[ ] Module 4 — Classification & Diagnosis
[ ] Module 5 — Hypothesis & Experiment
[ ] Module 6 — Test Definition
[ ] Module 7 — Evaluation & Learning

[ ] Cross-module duplication audit
[ ] Master-to-module coverage audit
[ ] Final modular prompt architecture
```

---

## Final Coverage Audit

After all modules are extracted, compare every meaningful responsibility in Master V6 against the modular system.

The purpose is to confirm:

- no critical instruction disappeared,
- no responsibility is owned by multiple modules unnecessarily,
- no important rule was moved to the wrong layer,
- no module depends on undocumented behavior,
- examples remain attached to the behavior they teach,
- deterministic work is moved toward code where appropriate,
- structured outputs are ready to become schemas,
- evals can test each module independently and end-to-end.

The master specification remains the **architectural source of truth** throughout this process.
