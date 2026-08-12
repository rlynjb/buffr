# Test Definition Module

<!-- Source: Master V6 Step 11 -->

## Responsibility

Define how the approved experiment will be measured so that its result can later be evaluated consistently.

Establish:

1. the primary metric,
2. supporting secondary metrics,
3. the established baseline reference,
4. qualification requirements for this test,
5. unresolved measurement requirements,
6. the operational expected signal,
7. context to monitor during the test.

---

## Preconditions

Use:

- the hypothesis, experimental variable, revision, control variables, and conceptual expected signal from Hypothesis & Experiment Design,
- the baseline and comparison validity established by Metrics & Qualification,
- validated qualification rules from Metrics & Qualification or Domain Research when available.

Treat the baseline and comparison-validity decision from Metrics & Qualification as upstream inputs.

---

## Reasoning Mode

**HYBRID**

Use validated upstream values and rules for:

- baseline values,
- comparison validity,
- established thresholds,
- known sample requirements,
- known duration requirements.

Use LLM judgment to select:

- the metric most directly connected to the hypothesis,
- useful secondary metrics,
- relevant contextual controls,
- the most appropriate measurement requirements when multiple validated choices exist.

Do not invent numerical requirements.

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

Use one primary metric unless the hypothesis genuinely requires more than one.

---

## 2. Select Secondary Metrics

Choose only supporting metrics that materially improve interpretation of the experiment.

Secondary metrics may reveal:

- unintended downstream effects,
- trade-offs,
- movement elsewhere in the funnel,
- supporting or conflicting signals.

---

## 3. Reference the Established Baseline

Use the baseline already selected and validated by Metrics & Qualification.

Record:

- baseline metric,
- baseline value,
- baseline period,
- baseline source,
- comparison-validity status,
- material comparison limitations.

Do not select or substitute a new baseline in this module.

If no valid baseline is supplied, identify the missing prerequisite and stop test definition until it is resolved.

---

## 4. Define Qualification Requirements

Specify what evidence must exist before this experiment can be evaluated.

Requirements may include:

- minimum impressions,
- minimum views,
- minimum clicks,
- minimum orders,
- minimum test duration,
- required traffic comparability,
- stable advertising conditions,
- absence of major simultaneous listing changes.

Apply validated rules when available.

If a required rule is unknown, mark it:

**TO BE RESEARCHED / DEFINED**

---

## 5. Operationalize the Expected Signal

Translate the conceptual signal from Hypothesis & Experiment Design into observable evaluation expectations.

Specify:

### Supporting Signal

What qualified movement would be consistent with the hypothesis?

### Weakening Signal

What qualified result would weaken or contradict it?

### Inconclusive Condition

What evidence condition would prevent a defensible evaluation?

Do not classify the actual experiment outcome in this module.

---

## 6. Identify Context to Monitor

Define the material contextual factors that should be monitored during the experiment.

Relevant factors may include:

- seasonality,
- traffic-source changes,
- marketplace demand,
- advertising changes,
- price changes,
- promotions,
- competing listing changes,
- external events,
- other product revisions.

Include only context relevant to the current test.

---

## 7. Resolve or Flag Measurement Gaps

If a required measurement rule remains undefined, formulate the specific research need for the Domain Research module.

Possible gaps include:

- minimum sample size,
- meaningful-change threshold,
- minimum test duration,
- confidence requirement.

Do not perform the research here.

If the unresolved rule prevents a defensible test plan, stop until the research finding or rule is available.

---

## Output

### Experiment Reference

- hypothesis,
- primary experimental variable,
- recommended revision.

### Primary Metric

The primary measurement signal.

### Secondary Metrics

Supporting measurements to monitor.

### Baseline Reference

- baseline metric,
- baseline value,
- baseline period,
- baseline source,
- comparison-validity status,
- material limitations.

### Qualification Requirements

Evidence required before evaluation.

### Expected Signal

- supporting signal,
- weakening signal,
- inconclusive condition.

### Context to Monitor

Material contextual factors defined before the experiment.

### Unresolved Measurement Rules

Any still-missing measurement requirement.

### Research Need

Include only when Domain Research is required before the test plan can be completed.

---

## Boundary

Stop after defining how the experiment will be measured.

Do not select a new baseline, recalculate performance, or evaluate the experiment outcome.
