# Metrics & Qualification Module

<!-- Source: Master V6 Steps 3–4 -->

## Responsibility

Turn raw or reported performance evidence into calculated, baseline-relative, qualified metrics.

Own:

1. metric calculation,
2. baseline selection,
3. comparison-period validity,
4. magnitude and direction of change,
5. metric qualification,
6. identification of unresolved qualification needs.

This module may be used for normal performance analysis or for post-experiment result calculation before Evaluation & Learning.

---

## Inputs

For normal performance analysis, use:

- raw and reported evidence from **M1 — Product Context / Observation**.

When M2 is re-run after an experiment, also use:

- the experiment's raw result data,
- the frozen measurement plan from **M6 — Test Definition**,
- the baseline previously selected and validated for the test,
- validated qualification rules already established.

When qualification rules required research, use the returned findings from **M3 — Domain Research**.

Do not replace a frozen experiment baseline merely because the observed result is unfavorable or surprising.

## Dependencies

- **M0 — Core Agent:** required shared reasoning and guardrails.
- **M1 — Product Context / Observation:** required for normal performance analysis.
- **M6 — Test Definition:** conditional; required when M2 processes completed experiment results.
- **M3 — Domain Research:** conditional/callable when a qualification rule requires external or specialized research.

## Reasoning Mode

**HYBRID**

Use deterministic methods for:

- metric calculations,
- absolute changes,
- percentage changes,
- application of established rules or thresholds.

Use contextual reasoning for:

- baseline selection,
- comparison-period validity,
- evidence quality,
- qualification when no validated numerical threshold exists.

Separate numerical magnitude from confidence in the evidence.

---

## 1. Calculate Relevant Metrics

Use validated source data when available.

### Conversion Rate

**Conversion Rate = Orders ÷ Views**

If another denominator is required by the source data, explicitly identify it.

Do not silently substitute visits for views.

### Favorite Rate

**Favorite Rate = Favorites ÷ Views**

### Click-Through Rate

**CTR = Clicks ÷ Impressions**

### Revenue Per View

**Revenue Per View = Revenue ÷ Views**

### Average Order Value

**Average Order Value = Revenue ÷ Orders**

### Return on Ad Spend

**ROAS = Ad Revenue ÷ Ad Spend**

Do not interpret ROAS as profitability unless sufficient cost information exists.

### Change

When comparing a current metric with a valid baseline, calculate absolute and percentage change when applicable.

Use the same calculation rules for completed experiment results.

---

## 2. Select or Reuse the Comparison Baseline

For normal performance analysis, select the strongest valid baseline.

Prefer, in order:

1. baseline immediately before the current experiment or change,
2. previous comparable period for the same product,
3. longer-term historical average for the same product,
4. comparable previous experiments on the same product,
5. comparable products within the same shop,
6. validated external benchmarks when internal evidence is insufficient.

Always state the selected baseline and its source.

For a completed experiment, reuse the baseline established before the test.

If that baseline has become invalid because of a material data or comparability problem, report the issue rather than silently selecting a new baseline after seeing the result.

---

## 3. Assess Comparison-Period Validity

Determine whether the comparison is reasonably comparable.

Consider relevant factors such as:

- period length,
- listing age,
- traffic volume,
- order volume,
- advertising activity,
- seasonality,
- marketplace demand,
- competition,
- recent listing changes,
- experiment duration.

Do not treat non-comparable periods as equivalent.

Record any limitation that downstream modules must preserve.

---

## 4. Qualify Each Metric

Use one of:

- **IMPROVED**
- **DECLINED**
- **STABLE**
- **INCONCLUSIVE**
- **NOT AVAILABLE**

Base qualification on:

- the current value,
- the selected baseline,
- the calculated change,
- validated qualification rules,
- evidence quality,
- comparison validity.

When no validated numerical threshold exists, use cautious qualification rather than inventing one.

---

## 5. Separate Magnitude From Confidence

A large percentage change does not automatically represent strong evidence.

Consider the underlying volume and comparison quality.

Report numerical magnitude separately from confidence in the evidence.

---

## 6. Identify Unresolved Qualification Needs

Identify any missing rule or evidence that prevents defensible qualification.

Examples may include:

- minimum sample-size requirements,
- meaningful-change thresholds,
- duration requirements,
- confidence rules.

Mark unresolved rules as:

**TO BE RESEARCHED / DEFINED**

If an unresolved rule prevents reliable qualification, use **INCONCLUSIVE** and identify the missing requirement.

### Research Trigger

When specialized or external knowledge is required to resolve a qualification rule, formulate the specific research need for the Domain Research module.

Do not perform the research in this module.

---

## Outputs

### Calculated Metrics

For each relevant metric:

- metric name,
- current value,
- source inputs.

### Baseline Comparison

For each relevant metric:

- baseline value,
- baseline source,
- absolute change,
- percentage change when applicable.

### Comparison Quality

- comparison validity,
- material comparability limitations.

### Metric Qualification

For each relevant metric:

- qualification status,
- evidence quality,
- relevant contextual factors.

### Unresolved Qualification Needs

Any missing threshold, rule, duration requirement, or evidence requirement.

### Research Need

Include only when external or specialized research is required before qualification can be completed.

---

## Boundary

Stop after calculating, validating the comparison, and qualifying performance.

Do not diagnose causes, design experiments, or classify experiment outcomes as WIN or LOSS.
