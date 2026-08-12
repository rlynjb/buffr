# Hypothesis & Experiment Design Module

<!-- Source: Master V6 Steps 9–10 -->

## Responsibility

Convert the accepted primary bottleneck into:

1. one evidence-supported hypothesis,
2. one controlled intervention,
3. one expected performance signal.

Design the experiment to maximize learning while limiting unnecessary variable changes.

---

## Preconditions

Use this module only when the diagnostic decision is:

**PROCEED TO HYPOTHESIS**

Use the diagnosis, evidence, competing explanation, and confidence from the Classification & Diagnosis module as the basis for the experiment.

Do not reopen the entire diagnosis unless the supplied evidence is internally inconsistent.

---

## Reasoning Mode

**PROBABILISTIC / HYBRID**

Use LLM judgment to:

- translate the bottleneck into a plausible causal hypothesis,
- identify the most informative variable to change,
- design a focused intervention,
- explain why the experiment is worth testing.

Use deterministic constraints to:

- limit the experiment to one primary variable,
- preserve important control variables,
- maintain the required hypothesis structure.

Treat the hypothesis as a testable explanation, not an established fact.

---

## 1. Create the Hypothesis

Convert the diagnosis into a testable statement.

Use the structure:

**Because [observed evidence], I hypothesize that [specific issue] contributes to [performance problem]. If we change [variable], then [primary performance signal] should improve.**

The hypothesis should connect:

**Evidence → Suspected Cause → Intervention → Expected Outcome**

The suspected cause must be consistent with the diagnosed bottleneck.

Avoid vague hypotheses such as:

> The listing could be better.

Prefer specific hypotheses such as:

> Because buyers are viewing and favoriting the listing but purchasing at a lower rate than the valid baseline, I hypothesize that unclear product previews are reducing purchase confidence. If the previews more clearly show what is included, conversion should improve.

---

## 2. Select One Primary Experimental Variable

Choose the single major variable most directly connected to the hypothesis.

Possible variables may include:

- thumbnail
- preview images
- title
- keywords
- tags
- description
- pricing
- bundle
- positioning
- value proposition
- target audience
- advertising targeting

Prefer the change that provides the strongest expected learning value relative to the diagnosed bottleneck.

Do not change several major variables simultaneously unless the intervention cannot reasonably be isolated.

---

## 3. Define the Revision

Describe exactly what should change.

The revision should be:

- specific,
- actionable,
- directly connected to the hypothesis,
- narrow enough to evaluate later.

Avoid recommendations such as:

> Improve the listing.

Prefer:

> Replace the second and third preview images with visuals that clearly show the included files and primary customer benefits.

---

## 4. Define What Remains Constant

Identify important variables that should remain unchanged during the experiment.

Examples may include:

- price
- title
- tags
- thumbnail
- description
- advertising strategy
- bundle structure

Holding major variables constant helps preserve interpretability of the experiment.

---

## 5. Explain the Experimental Rationale

Explain:

### Why This Variable

Why is this variable the most direct test of the hypothesis?

### Why Now

Why is this experiment higher priority than plausible alternatives?

### Learning Value

What useful information will the experiment provide whether the result is positive, negative, or inconclusive?

Prefer experiments that improve both performance potential and learning value.

---

## 6. Define the Expected Signal

Identify the performance signal that should move if the hypothesis is correct.

Examples:

- CTR should improve,
- favorite rate should improve,
- conversion should improve,
- revenue per view should improve,
- ROAS should improve.

Do not define test duration, minimum sample size, or final WIN / LOSS rules in this module.

Those belong to Test Definition.

---

## Output

### Hypothesis

A testable statement connecting:

- evidence,
- suspected cause,
- intervention,
- expected outcome.

### Primary Experimental Variable

The single major variable being tested.

### Recommended Revision

The specific change to make.

### Keep Constant

Important variables that should remain unchanged.

### Rationale

- why this variable,
- why this experiment is prioritized,
- expected learning value.

### Expected Signal

The performance metric or behavior expected to change if the hypothesis is supported.

### Experiment Notes

Important assumptions, uncertainty, or implementation context that the Test Definition module should receive.

---

## Boundary

Stop after defining the hypothesis and controlled experiment.

Do not determine test duration, qualification thresholds, or experiment outcome.
