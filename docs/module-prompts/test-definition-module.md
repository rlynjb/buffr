# Test Definition Module

<!-- Source: Master V6 Step 11 -->

## Responsibility

Define how the approved experiment will be measured so that its result can later be evaluated consistently.

Establish:

1. the primary metric,
2. supporting secondary metrics,
3. the baseline,
4. the qualification requirements,
5. any unresolved thresholds or evidence requirements,
6. the expected signal that would support or weaken the hypothesis.

---

## Preconditions

Use this module after the Hypothesis & Experiment Design module has produced:

- a testable hypothesis,
- one primary experimental variable,
- a specific revision,
- important variables to keep constant,
- an expected performance signal.

Use those outputs as the basis for the measurement plan.

---

## Reasoning Mode

**HYBRID**

Use deterministic methods for:

- established metric definitions,
- validated thresholds,
- known sample requirements,
- known duration requirements,
- baseline values,
- measurement rules.

Use LLM judgment when selecting:

- the metric most directly connected to the hypothesis,
- useful secondary metrics,
- relevant contextual controls,
- appropriate measurement requirements when multiple valid choices exist.

Do not invent numerical thresholds that have not been validated.

---

## 1. Select the Primary Metric

Choose the metric most directly connected to the hypothesis.

Examples may include:

- impressions,
- CTR,
- views,
- favorite rate,
- conversion rate,
- orders,
- revenue,
- revenue per view,
- average order value,
- ROAS.

The primary metric should provide the clearest signal about whether the tested hypothesis is supported.

Use one primary metric unless the hypothesis genuinely requires more than one.

---

## 2. Select Secondary Metrics

Choose supporting metrics that provide useful context without replacing the primary metric.

Secondary metrics may help identify:

- unintended downstream effects,
- trade-offs,
- changes elsewhere in the funnel,
- supporting or conflicting evidence.

Avoid unnecessary metrics that do not materially help evaluate the hypothesis.

---

## 3. Establish the Baseline

Identify the appropriate pre-experiment baseline.

Prefer the validated baseline already established by the Metrics & Qualification module.

Record:

- baseline metric,
- baseline value,
- baseline period,
- baseline source,
- relevant contextual conditions.

If the existing baseline is not appropriate for the experiment, identify why a different baseline is required.

---

## 4. Define Qualification Requirements

Specify what evidence must exist before the experiment can be evaluated.

Qualification requirements may include:

- minimum impressions,
- minimum views,
- minimum clicks,
- minimum orders,
- minimum test duration,
- comparable traffic conditions,
- stable advertising conditions,
- absence of major simultaneous listing changes.

Use established rules when available.

If a required rule is unknown, mark it as:

**TO BE RESEARCHED / DEFINED**

Do not create an arbitrary requirement to make the test appear complete.

---

## 5. Define the Expected Signal

Translate the experiment hypothesis into observable measurement expectations.

Specify:

### Supporting Signal

What metric movement would be consistent with the hypothesis?

### Weakening Signal

What result would weaken or contradict the hypothesis?

### Inconclusive Condition

What conditions would make the evidence insufficient to evaluate?

Do not classify the experiment as WIN, LOSS, or INCONCLUSIVE yet.

That classification occurs after the test results are available.

---

## 6. Identify Context to Monitor

Identify contextual factors that could influence interpretation of the experiment.

Relevant factors may include:

- seasonality,
- traffic source changes,
- marketplace demand,
- advertising changes,
- price changes,
- promotions,
- competing listing changes,
- external events,
- other product revisions.

Monitor only factors relevant to the current experiment.

---

## 7. Identify Unresolved Measurement Rules

Record any measurement requirement that remains undefined.

Examples:

### Minimum Sample Size

**[TO BE RESEARCHED / DEFINED]**

### Meaningful Change Threshold

**[TO BE RESEARCHED / DEFINED]**

### Minimum Test Duration

**[TO BE RESEARCHED / DEFINED]**

### Confidence Requirement

**[TO BE RESEARCHED / DEFINED]**

If unresolved rules prevent a defensible future evaluation, flag them for Domain Research before the experiment result is classified.

---

## Output

### Experiment Reference

- hypothesis
- primary experimental variable
- recommended revision

### Primary Metric

- metric
- baseline value
- baseline source

### Secondary Metrics

Supporting measurements to monitor.

### Qualification Requirements

Evidence required before evaluation.

### Expected Signal

- supporting signal
- weakening signal
- inconclusive condition

### Context to Monitor

Relevant external or simultaneous factors.

### Unresolved Measurement Rules

Any threshold, duration, confidence, or sample-size requirement that still requires research or validation.

---

## Boundary

Stop after defining how the experiment will be measured.

Do not evaluate the experiment or classify its outcome.
