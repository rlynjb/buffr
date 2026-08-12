# Evaluation & Learning Module

<!-- Source: Master V6 Steps 12–14 -->

## Responsibility

Evaluate the completed experiment against its predefined measurement plan.

Determine:

1. what changed,
2. whether the available evidence is sufficient,
3. whether the experiment resulted in a WIN, LOSS, or INCONCLUSIVE outcome,
4. whether the hypothesis was supported,
5. what can reasonably be learned,
6. the single highest-value next action.

---

## Preconditions

Use this module when the following are available:

- experiment hypothesis,
- primary experimental variable,
- implemented revision,
- variables intended to remain constant,
- primary metric,
- secondary metrics,
- baseline,
- qualification requirements,
- expected signal,
- new experiment results.

Use the measurement plan defined before the experiment.

Do not change evaluation criteria after seeing the result merely to produce a preferred outcome.

---

## Reasoning Mode

**HYBRID**

Use deterministic methods for:

- calculating current metrics,
- calculating changes from baseline,
- applying established qualification requirements,
- applying validated thresholds,
- checking required evidence.

Use LLM judgment for:

- interpreting contextual factors,
- weighing supporting and conflicting evidence,
- evaluating the hypothesis,
- extracting appropriately scoped learning,
- choosing the next action.

Perform deterministic evaluation before probabilistic interpretation.

---

## 1. Calculate the Experiment Results

Using the new experiment data, establish:

- current primary metric,
- current secondary metrics,
- absolute changes from baseline,
- percentage changes where applicable.

Use exact calculation when required inputs exist.

Preserve the distinction between calculated results and interpretation.

---

## 2. Check Qualification Requirements

Determine whether the experiment satisfies the measurement requirements defined before the test.

Consider:

- minimum required evidence,
- test duration,
- traffic volume,
- order volume,
- comparability with baseline,
- relevant contextual conditions,
- unresolved qualification rules.

If the required evidence is not sufficient, do not force a WIN or LOSS.

---

## 3. Compare the Result With the Expected Signal

Determine whether the observed result:

- matches the expected supporting signal,
- contradicts the expected signal,
- produces mixed evidence,
- or cannot be interpreted reliably.

Consider both:

### Primary Metric

The metric most directly connected to the hypothesis.

### Secondary Metrics

Supporting, conflicting, or contextual evidence.

The primary metric should carry greater weight unless the test definition establishes otherwise.

---

## 4. Classify the Experiment Outcome

Choose exactly one:

- **WIN**
- **LOSS**
- **INCONCLUSIVE**

### WIN

Use when:

- qualification requirements are satisfied,
- the primary metric improves relative to the baseline according to the applicable rules,
- the observed evidence is consistent with the expected signal.

### LOSS

Use when:

- qualification requirements are satisfied,
- the primary metric deteriorates relative to the baseline according to the applicable rules,
- the result weakens or contradicts the expected signal.

### INCONCLUSIVE

Use when:

- qualification requirements are not satisfied,
- evidence is insufficient,
- metrics conflict,
- contextual changes weaken interpretability,
- an unresolved rule prevents reliable classification.

A numerical increase alone does not automatically equal a WIN.

A numerical decrease alone does not automatically equal a LOSS.

---

## 5. Evaluate the Hypothesis

Choose exactly one:

- **SUPPORTED**
- **PARTIALLY SUPPORTED**
- **NOT SUPPORTED**
- **INCONCLUSIVE**

### SUPPORTED

The observed evidence is meaningfully consistent with the predicted signal.

### PARTIALLY SUPPORTED

Some evidence supports the hypothesis, but important evidence is mixed, incomplete, or weaker than expected.

### NOT SUPPORTED

The experiment produces adequate evidence that does not support the predicted relationship.

### INCONCLUSIVE

The available evidence cannot reliably determine whether the hypothesis is supported.

Do not treat support for a hypothesis as proof of causation.

---

## 6. Consider Contextual Factors

Before interpreting the experiment, consider relevant changes such as:

- seasonality,
- marketplace demand,
- competition,
- traffic-source changes,
- advertising changes,
- promotions,
- pricing changes,
- simultaneous listing changes,
- external events.

Identify only contextual factors that could materially affect interpretation.

Do not use speculative external explanations to dismiss otherwise valid evidence.

---

## 7. Capture the Learning

Convert the completed experiment into concise reusable learning.

Record:

### Context

What performance situation existed before the experiment?

### Change

What primary variable changed?

### Result

What happened relative to baseline?

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

Do not turn the result of one listing experiment into a universal Etsy rule.

Prefer:

> Clearer preview images may improve conversion for this listing under similar conditions.

Avoid:

> Clearer preview images always increase Etsy conversion.

---

## 8. Recommend the Next Action

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

Modify or refine the same general intervention when the experiment provides useful but incomplete learning.

### NEW TEST

Begin a different hypothesis or experimental variable when the current learning is sufficiently complete.

### RESEARCH

Resolve an important domain or methodological uncertainty before continuing.

### WAIT

Collect additional evidence before taking another action.

Choose the single action with the highest expected value based on the current evidence.

---

## Output

### Experiment Result

- baseline
- test performance
- calculated change
- qualification status

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

Key evidence supporting the evaluation.

### Contextual Factors

Relevant conditions affecting interpretation.

### Learning

- context
- change
- result
- interpretation
- confidence
- knowledge source

### Next Action

- KEEP
- REVERT
- ITERATE
- NEW TEST
- RESEARCH
- WAIT

### Next-Action Rationale

Why this is the highest-value next step.

---

## Boundary

Stop after evaluating the experiment, capturing the learning, and selecting one next action.

Do not start the next optimization cycle within this module.
