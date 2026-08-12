# Evaluation & Learning Module

<!-- Source: Master V6 Steps 12–14 -->

## Responsibility

Evaluate a completed experiment using its predefined measurement plan and upstream qualified metric results.

Determine:

1. whether the evidence is sufficient for evaluation,
2. whether the experiment is a WIN, LOSS, or INCONCLUSIVE,
3. whether the hypothesis is supported,
4. what can reasonably be learned,
5. the single highest-value next action.

---

## Preconditions

Use:

- the hypothesis and experiment design from Hypothesis & Experiment Design,
- the frozen measurement plan from Test Definition,
- calculated experiment metrics, baseline comparison, comparison validity, and metric qualification from Metrics & Qualification,
- observed contextual conditions from the completed test.

Do not recalculate metrics, select a new baseline, or re-qualify the comparison in this module.

Do not change the evaluation plan after seeing the result merely to produce a preferred outcome.

---

## Reasoning Mode

**HYBRID**

Consume deterministic and qualified upstream evidence.

Use LLM judgment to:

- compare the qualified result with the expected signal,
- interpret material contextual factors,
- weigh supporting and conflicting evidence,
- evaluate the hypothesis,
- extract appropriately scoped learning,
- choose the next action.

---

## 1. Verify Evaluation Readiness

Check whether the predefined qualification requirements were satisfied using the upstream metric and comparison outputs.

Consider:

- qualification status,
- required sample or volume conditions,
- required test duration,
- comparison-validity status,
- unresolved measurement rules,
- monitored contextual conditions.

If the predefined evidence requirements are not satisfied, do not force a WIN or LOSS.

---

## 2. Compare the Result With the Expected Signal

Use the qualified primary metric as the main evidence.

Use secondary metrics as supporting, conflicting, or contextual evidence.

Determine whether the result:

- matches the supporting signal,
- contradicts the expected signal,
- produces mixed evidence,
- or cannot be interpreted reliably.

The primary metric should carry greater weight unless the Test Definition module explicitly established otherwise.

---

## 3. Classify the Experiment Outcome

Choose exactly one:

- **WIN**
- **LOSS**
- **INCONCLUSIVE**

### WIN

Use when:

- predefined qualification requirements are satisfied,
- the primary metric is qualified as improved according to the applicable rules,
- the observed evidence is consistent with the expected signal.

### LOSS

Use when:

- predefined qualification requirements are satisfied,
- the primary metric is qualified as declined according to the applicable rules,
- the result weakens or contradicts the expected signal.

### INCONCLUSIVE

Use when:

- qualification requirements are not satisfied,
- the upstream metric result is inconclusive,
- evidence is materially conflicting,
- contextual conditions weaken interpretability,
- an unresolved rule prevents defensible classification.

Do not convert a raw numerical movement into a WIN or LOSS without the upstream qualification.

---

## 4. Evaluate the Hypothesis

Choose exactly one:

- **SUPPORTED**
- **PARTIALLY SUPPORTED**
- **NOT SUPPORTED**
- **INCONCLUSIVE**

### SUPPORTED

The qualified evidence is meaningfully consistent with the predicted signal.

### PARTIALLY SUPPORTED

Some evidence supports the hypothesis, but important evidence is mixed, incomplete, or weaker than expected.

### NOT SUPPORTED

Adequate evidence does not support the predicted relationship.

### INCONCLUSIVE

The available evidence cannot reliably determine whether the hypothesis is supported.

Do not treat hypothesis support as proof of causation.

---

## 5. Interpret Contextual Factors

Use the contextual factors defined by Test Definition and the conditions observed during the experiment.

Identify which monitored conditions materially affect interpretation.

If an unexpected contextual factor materially affected the test, note it explicitly.

Do not use speculative context to dismiss otherwise valid evidence.

---

## 6. Capture the Learning

Record:

### Context

What performance situation existed before the experiment?

### Change

What primary variable changed?

### Result

What did the qualified evidence show relative to the frozen baseline?

### Interpretation

What does the evidence reasonably suggest?

### Confidence

Choose:

- **LOW**
- **MODERATE**
- **HIGH**

### Knowledge Source

Choose:

- **PRODUCT DATA**
- **EXPERIMENT**
- **EXTERNAL RESEARCH**
- **COMBINATION**

Scope the learning to the evidence.

Do not turn one listing experiment into a universal Etsy rule.

---

## 7. Recommend the Next Action

Choose exactly one:

- **KEEP**
- **REVERT**
- **ITERATE**
- **NEW TEST**
- **RESEARCH**
- **WAIT**

### KEEP

Retain the tested change when the evidence supports doing so.

### REVERT

Return to the previous version when the tested change produces sufficiently supported deterioration.

### ITERATE

Refine the same intervention when the experiment provides useful but incomplete learning.

### NEW TEST

Move to a different hypothesis or variable when the current learning is sufficiently complete.

### RESEARCH

Use when a domain or methodological knowledge gap must be resolved before the next decision.

When selected, formulate the specific research question for the Domain Research module.

### WAIT

Collect additional evidence before taking another action.

Choose the single action with the highest expected value based on the current evidence.

---

## Output

### Experiment Evidence

Use the upstream Metrics & Qualification results for:

- baseline,
- test performance,
- calculated change,
- comparison validity,
- qualification status.

### Outcome

- WIN
- LOSS
- INCONCLUSIVE

### Hypothesis Evaluation

- SUPPORTED
- PARTIALLY SUPPORTED
- NOT SUPPORTED
- INCONCLUSIVE

### Evidence

Key qualified evidence supporting the evaluation.

### Contextual Factors

Material monitored or unexpected conditions affecting interpretation.

### Learning

- context,
- change,
- result,
- interpretation,
- confidence,
- knowledge source.

### Next Action

- KEEP
- REVERT
- ITERATE
- NEW TEST
- RESEARCH
- WAIT

### Research Question

Include only when the next action is **RESEARCH**.

### Next-Action Rationale

Why this is the highest-value next step.

---

## Boundary

Stop after evaluating the experiment, capturing the learning, and selecting one next action.

Do not start the next optimization cycle within this module.
