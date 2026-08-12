# Hypothesis & Experiment Design Module

<!-- Source: Master V6 Steps 9–10 -->

## Responsibility

Convert an accepted diagnosis into:

1. one evidence-supported hypothesis,
2. one controlled intervention,
3. one expected performance signal.

Design the experiment to maximize learning while limiting unnecessary variable changes.

---

## Preconditions

Use this module only when the Classification & Diagnosis decision is:

**PROCEED TO HYPOTHESIS**

Use the diagnosed bottleneck, supporting evidence, competing explanation, and confidence as upstream inputs.

Do not reopen the diagnosis unless the supplied inputs are internally inconsistent.

---

## Reasoning Mode

**PROBABILISTIC / HYBRID**

Use LLM judgment to:

- translate the bottleneck into a plausible causal hypothesis,
- identify the most informative variable to change,
- design a focused intervention,
- explain why the experiment is worth testing.

Treat the hypothesis as a testable explanation, not an established fact.

---

## 1. Check for a Blocking Knowledge Gap

Before designing the experiment, determine whether a specialized or external knowledge gap prevents a defensible hypothesis or intervention.

If research is required:

1. state the specific research question,
2. explain why it blocks experiment design,
3. route the question to the Domain Research module,
4. stop until the finding is returned.

Do not perform domain research in this module.

---

## 2. Create the Hypothesis

Use the structure:

**Because [qualified evidence], I hypothesize that [specific issue] contributes to [performance problem]. If we change [variable], then [primary performance signal] should improve.**

Connect:

**Evidence → Suspected Cause → Intervention → Expected Outcome**

The suspected cause must be consistent with the accepted diagnosis.

---

## 3. Select One Primary Experimental Variable

Choose the single major variable most directly connected to the hypothesis.

Possible variables may include:

- thumbnail,
- preview images,
- title,
- keywords,
- tags,
- description,
- pricing,
- bundle,
- positioning,
- value proposition,
- target audience,
- advertising targeting.

Prefer the change with the strongest expected learning value relative to the diagnosed bottleneck.

Keep other major variables stable when reasonably possible.

---

## 4. Define the Revision

Describe exactly what should change.

The revision should be:

- specific,
- actionable,
- directly connected to the hypothesis,
- narrow enough to evaluate later.

---

## 5. Define What Remains Constant

Identify the important variables that should remain unchanged during the experiment.

Holding major variables constant helps preserve interpretability.

---

## 6. Explain the Experimental Rationale

Explain:

### Why This Variable

Why is this variable the most direct test of the hypothesis?

### Why Now

Why is this experiment higher priority than plausible alternatives?

### Learning Value

What useful information will the experiment provide whether the result is positive, negative, or inconclusive?

---

## 7. Define the Expected Signal

State the performance behavior expected if the hypothesis is supported.

Examples:

- CTR should improve,
- favorite rate should improve,
- conversion should improve,
- revenue per view should improve,
- ROAS should improve.

Keep this conceptual.

The Test Definition module will operationalize the signal into a measurement plan.

---

## Output

### Hypothesis

A testable statement connecting evidence, suspected cause, intervention, and expected outcome.

### Primary Experimental Variable

The single major variable being tested.

### Recommended Revision

The specific change to make.

### Keep Constant

Important variables that should remain unchanged.

### Rationale

- why this variable,
- why it is prioritized,
- expected learning value.

### Expected Signal

The performance behavior expected to change if the hypothesis is supported.

### Research Need

Include only if a blocking knowledge gap prevents experiment design.

### Experiment Notes

Important assumptions, uncertainty, or implementation context for Test Definition.

---

## Boundary

Stop after defining the hypothesis and controlled experiment.

Do not define test duration, qualification thresholds, or the experiment outcome.
