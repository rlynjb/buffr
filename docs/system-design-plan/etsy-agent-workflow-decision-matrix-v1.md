# Etsy Agent Workflow Decision Matrix — V1

This matrix complements the workflow execution spec.

It answers:

> **At each runtime decision point, which module owns the decision and where does control go next?**

---

# 1. Decision Matrix

| Gate | Owner | Decision / Condition | Next Route |
|---|---|---|---|
| Initial evidence available | M1 | Enough source evidence exists to organize product context | M2 |
| Missing source evidence | M1 | Important source fields are absent | Continue with missing fields recorded; M2 decides analytical sufficiency |
| Metric inputs sufficient | M2 | Metrics and baseline comparison can be calculated/qualified | M4 |
| Metric evidence insufficient | M2 | Required data is missing or comparison cannot be qualified | STOP / REQUEST MORE DATA |
| Qualification knowledge gap | M2 | External/specialized rule is required | M3 → return to M2 |
| Diagnosis ready | M4 | Primary bottleneck is sufficiently supported | M5 |
| Diagnosis needs research | M4 | Domain knowledge blocks diagnosis | M3 → return to M4 |
| Diagnosis lacks evidence | M4 | Additional product evidence is required | STOP / COLLECT MORE DATA |
| Experiment design ready | M5 | Defensible hypothesis and intervention can be formed | M6 |
| Experiment design knowledge gap | M5 | Research is required before intervention design | M3 → return to M5 |
| Test definition ready | M6 | Measurement plan is defensible and complete | RUN EXPERIMENT |
| Test-rule knowledge gap | M6 | Required measurement rule is undefined | M3 → return to M6 |
| Experiment complete | External event / orchestration | New result data is available | M2 post-experiment |
| Experiment metrics qualified | M2 | Post-test evidence can be qualified | M7 |
| Experiment metrics insufficient | M2 | Result cannot be qualified | M7 receives INCONCLUSIVE evidence or workflow waits for more data |
| Evaluation knowledge gap | M7 | Domain/method uncertainty blocks defensible evaluation | M3 → return to M7 |
| Experiment outcome | M7 | WIN | choose next action |
| Experiment outcome | M7 | LOSS | choose next action |
| Experiment outcome | M7 | INCONCLUSIVE | choose next action |
| Next action | M7 | KEEP | END CURRENT CYCLE |
| Next action | M7 | REVERT | END CURRENT CYCLE |
| Next action | M7 | ITERATE | END CURRENT CYCLE; orchestration starts a new cycle |
| Next action | M7 | NEW TEST | END CURRENT CYCLE; orchestration starts a new cycle |
| Next action | M7 | RESEARCH | M3; then orchestration resumes next-cycle decision |
| Next action | M7 | WAIT | STOP until more evidence is available |

---

# 2. Module Control Summary

| Module | Can Continue Main Flow | Can Trigger M3 | Can Stop / Wait | Owns Final Cycle Decision |
|---|---:|---:|---:|---:|
| M0 — Core | No direct runtime control | No | No | No |
| M1 — Context | Yes | No | No direct analytical stop | No |
| M2 — Metrics | Yes | Yes | Yes | No |
| M3 — Research | Returns to caller | N/A | Can return unresolved | No |
| M4 — Diagnosis | Yes | Yes | Yes | No |
| M5 — Experiment | Yes | Yes | Yes if blocked | No |
| M6 — Test | Yes | Yes | Yes if blocked | No |
| M7 — Evaluation | Ends current cycle | Yes | Yes via WAIT | **Yes** |

---

# 3. Runtime States

Keep the state model small.

```text
ANALYZING
RESEARCHING
WAITING_FOR_DATA
READY_FOR_EXPERIMENT
EXPERIMENT_RUNNING
READY_FOR_EVALUATION
CYCLE_COMPLETE
```

Suggested ownership:

| Runtime State | Typical Module / Event |
|---|---|
| ANALYZING | M1, M2, M4, M5, or M6 |
| RESEARCHING | M3 |
| WAITING_FOR_DATA | orchestration / user / external data source |
| READY_FOR_EXPERIMENT | after M6 |
| EXPERIMENT_RUNNING | external real-world period |
| READY_FOR_EVALUATION | after experiment data arrives |
| CYCLE_COMPLETE | after M7 |

This is conceptual only; the coding agent can represent states differently.

---

# 4. Research Return Matrix

| Calling Module | Research Trigger | Return Destination |
|---|---|---|
| M2 | missing qualification rule / benchmark / methodology | M2 |
| M4 | domain uncertainty blocks diagnosis | M4 |
| M5 | knowledge gap blocks hypothesis/intervention | M5 |
| M6 | measurement rule is undefined | M6 |
| M7 | domain or methodological uncertainty blocks evaluation | M7 |

Core rule:

> **M3 returns control to its caller. It does not decide the next main workflow step.**

---

# 5. Stop / Wait Conditions

| Condition | Owner That Detects It | Runtime Result |
|---|---|---|
| Missing raw product/performance data | M1 records; M2 judges sufficiency | WAIT / REQUEST DATA if analysis cannot continue |
| Invalid or unusable comparison | M2 | STOP / WAIT or INCONCLUSIVE |
| Diagnosis cannot be supported | M4 | COLLECT MORE DATA |
| Research cannot resolve blocking uncertainty | calling module after M3 returns | STOP / WAIT |
| Test plan cannot be made defensible | M6 | STOP until rule/data is resolved |
| Experiment not yet complete | orchestration | WAIT |
| Experiment evidence insufficient | M2 / M7 | INCONCLUSIVE or WAIT |
| Next action = WAIT | M7 | END CURRENT CYCLE and wait for evidence |

---

# 6. Terminal Outputs Per Flow

## Initial Analysis

One of:

```text
PROCEED TO HYPOTHESIS
RESEARCH DOMAIN KNOWLEDGE
COLLECT MORE DATA
```

## Experiment Setup

One of:

```text
EXPERIMENT READY
RESEARCH REQUIRED
BLOCKED BY MISSING MEASUREMENT REQUIREMENT
```

## Evaluation

One outcome:

```text
WIN
LOSS
INCONCLUSIVE
```

Plus one next action:

```text
KEEP
REVERT
ITERATE
NEW TEST
RESEARCH
WAIT
```

---

# 7. Implementation Handoff Notes

The coding agent can now derive:

- orchestration functions,
- state transitions,
- API contracts,
- schemas,
- typed enums,
- validation,
- tool-routing logic,
- persistence requirements.

The architecture decisions are already separated:

```text
PROMPTS
  = module reasoning

DEPENDENCIES
  = required information relationships

WORKFLOW
  = execution and routing

CODE / API CONTRACTS
  = implementation
```

---

# Key Principle

> **The module that detects a condition should own the decision.  
> Orchestration should own the routing that follows from that decision.**
